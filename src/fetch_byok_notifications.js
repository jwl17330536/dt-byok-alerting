/**
 * BYOK Key Access Monitor — task: fetch_byok_notifications
 *
 * This is the ONLY code in the workflow. Everything a customer normally wants to
 * customize (notifications, incident creation, branching) is handled by NATIVE
 * workflow actions downstream (Send email, HTTP request, conditions). This task
 * only does the things that genuinely require code:
 *
 *   1. Read OAuth client credentials from the Credential Vault (no hardcoded secrets).
 *   2. Get a bearer token from Dynatrace SSO (scope account-uac-read).
 *   3. POST the Account Management Notifications API (last 10 minutes,
 *      types BYOK_REVOKED / BYOK_ACTIVATED). There is NO native BYOK trigger;
 *      this API is the source of truth.
 *   4. Parse + deduplicate records and apply the persistence safety gate.
 *   5. Ingest a per-record Dynatrace custom event (loop -> needs code):
 *        BYOK_REVOKED   -> CUSTOM_ALERT "BYOK key access lost"
 *        BYOK_ACTIVATED -> CUSTOM_INFO  "BYOK key access restored"
 *   6. Return clean flags + pre-rendered text that the native downstream tasks
 *      consume via {{ result('fetch_byok_notifications').<field> }}.
 *
 * Downstream native tasks read these returned fields:
 *   hasRevoked, hasActivated, hasIncident   -> condition gates
 *   incidentCount                           -> incident payload
 *   primaryRevoked / primaryActivated       -> incident / recovery payloads
 *   revokedText / activatedText             -> email body (markdown)
 */
import {
  eventsClient,
  EventIngestEventType,
  credentialVaultClient,
} from "@dynatrace-sdk/client-classic-environment-v2";
import { queryExecutionClient } from "@dynatrace-sdk/client-query";

// ---------------------------------------------------------------------------
// Configuration — NO SECRETS INLINE. Set the two values below, then deploy.
// ---------------------------------------------------------------------------

// Your Dynatrace account UUID (NOT a secret). Account Management > IAM > OAuth clients.
const ACCOUNT_UUID = "<REPLACE_WITH_ACCOUNT_UUID>";

// Credential Vault entry of type "User and password":
//   user     = OAuth client_id
//   password = OAuth client_secret      (client needs scope: account-uac-read)
const OAUTH_CREDENTIAL_VAULT_ID = "<REPLACE_WITH_CREDENTIALS_VAULT_ID>";

// Behavior knobs.
const LOOKBACK_MINUTES = 10;
const SAFETY_MIN_PERSIST_MINUTES = 5; // only flag an incident if a revoke is at least this old and not yet recovered
const ENABLE_PERSISTENCE_SAFETY = true;
const ENABLE_CROSS_RUN_DEDUP = true; // best-effort dedup across overlapping runs (Grail); degrades gracefully

// Constants.
const OAUTH_SCOPES = ["account-uac-read"];
const SSO_TOKEN_URL = "https://sso.dynatrace.com/sso/oauth2/token";
const ACCOUNT_API_BASE = "https://api.dynatrace.com";

const REVOKED_IMPACT =
  "Dynatrace cannot access the customer-managed encryption key. Per Dynatrace " +
  "documentation, no new data can be written to permanent storage, Dashboards, " +
  "Notebooks, and Workflows cannot be saved, and ingested data may only be " +
  "buffered temporarily.";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isoMinutesAgo(minutes) {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

function nowIso() {
  return new Date().toISOString();
}

// Filter values are UPPER_SNAKE (BYOK_REVOKED) but records come back lower-hyphen
// (byok-revoked). Normalize both to UPPER_SNAKE for comparison.
function normalizeType(type) {
  return String(type || "").trim().toUpperCase().replace(/-/g, "_");
}

function requireConfigured(value, label) {
  if (!value || String(value).includes("<REPLACE")) {
    throw new Error(`${label} is not configured. Set it in the task before deploying.`);
  }
  return value;
}

async function resolveOauthCredentials() {
  requireConfigured(OAUTH_CREDENTIAL_VAULT_ID, "OAUTH_CREDENTIAL_VAULT_ID");
  const entry = await credentialVaultClient.getCredentialsDetails({ id: OAUTH_CREDENTIAL_VAULT_ID });
  const clientId = entry && (entry.user || entry.username);
  const clientSecret = entry && (entry.password || entry.token);
  if (!clientId || !clientSecret) {
    throw new Error(
      `Credential Vault entry ${OAUTH_CREDENTIAL_VAULT_ID} must be a "User and password" entry ` +
        "(user = OAuth client_id, password = OAuth client_secret).",
    );
  }
  return { clientId, clientSecret };
}

async function getOauthToken({ clientId, clientSecret }) {
  const response = await fetch(SSO_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
      scope: OAUTH_SCOPES.join(" "),
      resource: `urn:dtaccount:${ACCOUNT_UUID}`,
    }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to obtain OAuth token. Status ${response.status}. Body: ${text}`);
  }
  const json = await response.json();
  if (!json.access_token) throw new Error("OAuth token response did not contain an access_token.");
  return json.access_token;
}

async function fetchNotifications(token, startDateTime, endDateTime) {
  const url = `${ACCOUNT_API_BASE}/v1/accounts/${ACCOUNT_UUID}/notifications`;
  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      startDateTime,
      endDateTime,
      types: ["BYOK_REVOKED", "BYOK_ACTIVATED"],
      pageSize: 100,
      sorts: ["-date"],
    }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Notifications API request failed. Status ${response.status}. Body: ${text}`);
  }
  return text ? JSON.parse(text) : {};
}

async function ingestEvent({ eventType, title, properties }) {
  return await eventsClient.createEvent({ body: { eventType, title, properties } });
}

// Best-effort cross-run dedup. Overlapping 10-minute windows on a 5-minute
// schedule can surface the same notification twice. Skip if we already ingested
// an event with this dedupe key. Any error degrades to in-window dedup only.
async function alreadyProcessed(dedupeKey) {
  if (!ENABLE_CROSS_RUN_DEDUP) return false;
  try {
    const query =
      `fetch events, from: now()-${LOOKBACK_MINUTES + 5}m\n` +
      `| filter byok_dedupe_key == "${dedupeKey}"\n` +
      `| limit 1`;
    let response = await queryExecutionClient.queryExecute({
      body: { query, requestTimeoutMilliseconds: 5000, fetchTimeoutSeconds: 10 },
    });
    let guard = 0;
    while (response && response.state && response.state !== "SUCCEEDED" && guard < 20) {
      if (!response.requestToken) break;
      await new Promise((r) => setTimeout(r, 500));
      response = await queryExecutionClient.queryPoll({ requestToken: response.requestToken });
      guard += 1;
    }
    const records = (response && response.result && response.result.records) || [];
    return records.length > 0;
  } catch (error) {
    console.log(`Cross-run dedup check skipped: ${error && error.message ? error.message : error}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export default async function () {
  requireConfigured(ACCOUNT_UUID, "ACCOUNT_UUID");

  const checkedWindowStart = isoMinutesAgo(LOOKBACK_MINUTES);
  const checkedWindowEnd = nowIso();

  const token = await getOauthToken(await resolveOauthCredentials());
  const apiResponse = await fetchNotifications(token, checkedWindowStart, checkedWindowEnd);
  const records = Array.isArray(apiResponse.records) ? apiResponse.records : [];

  // Index latest activation per environment+key for the persistence safety gate.
  const latestActivationByTarget = new Map();
  for (const record of records) {
    if (normalizeType(record.type) !== "BYOK_ACTIVATED") continue;
    const d = record.details || {};
    const target = `${d.environmentUuid || "unknown"}|${d.keyName || "unknown"}`;
    const ts = Date.parse(record.date || "") || 0;
    if (ts > (latestActivationByTarget.get(target) || 0)) latestActivationByTarget.set(target, ts);
  }

  const summary = {
    checkedWindowStart,
    checkedWindowEnd,
    recordsSeen: records.length,
    revokedEvents: 0,
    activatedEvents: 0,
    processed: [],
  };

  const revoked = [];
  const activated = [];
  let primaryRevoked = null; // most recent revoke that passed the safety gate (incident source)

  const seen = new Set(); // in-window dedup: type + environmentUuid + keyName + date

  for (const record of records) {
    const eventType = normalizeType(record.type);
    if (eventType !== "BYOK_REVOKED" && eventType !== "BYOK_ACTIVATED") continue;

    const severity = String(record.severity || "");
    const message = String(record.message || "");
    const date = String(record.date || "");
    const details = record.details || {};
    const environmentUuid = details.environmentUuid || "unknown";
    const keyName = details.keyName || "unknown";

    const dedupeKey = `${eventType}|${environmentUuid}|${keyName}|${date}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    if (await alreadyProcessed(dedupeKey)) {
      summary.processed.push({ eventType, environmentUuid, keyName, date, action: "skipped_already_processed" });
      continue;
    }

    const item = { environmentUuid, keyName, date, severity, message, dedupeKey };
    const baseProperties = {
      source: "Dynatrace Account Management Notifications API",
      notification_type: eventType,
      severity,
      message,
      notification_date: date,
      environment_uuid: environmentUuid,
      key_name: keyName,
      byok_dedupe_key: dedupeKey,
    };

    if (eventType === "BYOK_REVOKED") {
      summary.revokedEvents += 1;
      revoked.push(item);

      await ingestEvent({
        eventType: EventIngestEventType.CustomAlert,
        title: "BYOK key access lost",
        properties: { ...baseProperties, impact: REVOKED_IMPACT },
      });

      // Persistence safety gate (requirement #6): incident only if the revoke is
      // at least SAFETY_MIN_PERSIST_MINUTES old AND not followed by an activation.
      const revokeTs = Date.parse(date) || 0;
      const ageMinutes = revokeTs ? (Date.now() - revokeTs) / 60000 : Infinity;
      const recoveredAfter = (latestActivationByTarget.get(`${environmentUuid}|${keyName}`) || 0) > revokeTs;
      const passesGate = !ENABLE_PERSISTENCE_SAFETY || (ageMinutes >= SAFETY_MIN_PERSIST_MINUTES && !recoveredAfter);

      item.incidentEligible = passesGate;
      if (passesGate && (!primaryRevoked || revokeTs > (Date.parse(primaryRevoked.date) || 0))) {
        primaryRevoked = item;
      }
      summary.processed.push({
        eventType,
        environmentUuid,
        keyName,
        date,
        action: passesGate ? "custom_event_ingested_incident_eligible" : "custom_event_ingested_incident_suppressed",
      });
    } else {
      summary.activatedEvents += 1;
      activated.push(item);
      await ingestEvent({
        eventType: EventIngestEventType.CustomInfo,
        title: "BYOK key access restored",
        properties: baseProperties,
      });
      summary.processed.push({ eventType, environmentUuid, keyName, date, action: "custom_event_ingested_recovery" });
    }
  }

  const renderList = (items) =>
    items
      .map(
        (i) =>
          `- **${i.keyName}** (env \`${i.environmentUuid}\`) — ${i.severity || "n/a"} at ${i.date}` +
          (i.message ? `\n  - ${i.message}` : ""),
      )
      .join("\n");

  const incidentCount = revoked.filter((r) => r.incidentEligible).length;
  const primaryActivated = activated.length ? activated[0] : null;

  return {
    ...summary,
    // Flags for native condition gates:
    hasRevoked: revoked.length > 0,
    hasActivated: activated.length > 0,
    hasIncident: incidentCount > 0,
    incidentCount,
    // Representative records for native incident/recovery payloads:
    primaryRevoked: primaryRevoked || (revoked.length ? revoked[0] : null),
    primaryActivated,
    impactText: REVOKED_IMPACT,
    // Pre-rendered markdown for native Send-email bodies:
    revokedText: revoked.length ? renderList(revoked) : "None",
    activatedText: activated.length ? renderList(activated) : "None",
    // Lists if you want to template over them:
    revoked,
    activated,
  };
}
