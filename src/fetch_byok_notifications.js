/**
 * BYOK Key Access Monitor — task: fetch_byok_notifications
 *
 * Goal: detect BYOK key access changes and CREATE A DYNATRACE CUSTOM EVENT.
 * From there, the customer decides what to do with the event (alert on it,
 * trigger another workflow, build a dashboard/notebook, route to a 3rd party…).
 *
 * This task does the parts that genuinely require code:
 *   1. Read secrets from the Credential Vault (no hardcoded secrets):
 *        - OAuth client (User+password)  -> Account Management API
 *        - Api-Token (Token)             -> events ingest
 *   2. Get a bearer token from Dynatrace SSO (scope: account-uac-read).
 *   3. POST the Account Management Notifications API for the last 10 minutes
 *      (types BYOK_REVOKED / BYOK_ACTIVATED). There is NO native BYOK trigger;
 *      this API is the source of truth.
 *   4. Parse + de-duplicate records and apply the persistence safety gate.
 *   5. Create a Dynatrace custom event per record (loop -> needs code) via
 *      POST {env}/api/v2/events/ingest:
 *        BYOK_REVOKED   -> CUSTOM_ALERT  "BYOK key access lost"
 *        BYOK_ACTIVATED -> CUSTOM_INFO   "BYOK key access restored"
 *   6. Return a summary plus flags/text that optional downstream native tasks
 *      can consume via {{ result('fetch_byok_notifications').<field> }}.
 */
import { credentialVaultClient } from "@dynatrace-sdk/client-classic-environment-v2";
import { getEnvironmentUrl } from "@dynatrace-sdk/app-environment";
import { queryExecutionClient } from "@dynatrace-sdk/client-query";

// ---------------------------------------------------------------------------
// Configuration — NO SECRETS INLINE. Set these three values, then deploy.
// ---------------------------------------------------------------------------

// Your Dynatrace account UUID (NOT a secret). Account Management > IAM > OAuth clients.
const ACCOUNT_UUID = "<REPLACE_WITH_ACCOUNT_UUID>";

// Credential Vault entry of type "User and password":
//   user     = OAuth client_id
//   password = OAuth client_secret      (client scope: account-uac-read)
const OAUTH_CREDENTIAL_VAULT_ID = "<REPLACE_WITH_OAUTH_CREDENTIALS_VAULT_ID>";

// Credential Vault entry of type "Token":
//   token = a Dynatrace API token (Api-Token) with scope: events.ingest
const EVENTS_TOKEN_VAULT_ID = "<REPLACE_WITH_EVENTS_INGEST_TOKEN_VAULT_ID>";

// Behavior knobs.
const LOOKBACK_MINUTES = 10;
const SAFETY_MIN_PERSIST_MINUTES = 5; // mark a revoke "incident eligible" only if at least this old and not recovered
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

// The environment (classic) API lives on the non-apps host, e.g.
// https://abc123.apps.dynatrace.com -> https://abc123.dynatrace.com
function getClassicEnvBaseUrl() {
  const raw = (getEnvironmentUrl() || "").trim();
  if (!raw) throw new Error("getEnvironmentUrl() returned an empty value.");
  const env = new URL(raw);
  env.host = env.host.replace(".apps.", ".");
  env.pathname = "";
  env.search = "";
  env.hash = "";
  return env.toString().replace(/\/$/, "");
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

async function resolveEventsToken() {
  requireConfigured(EVENTS_TOKEN_VAULT_ID, "EVENTS_TOKEN_VAULT_ID");
  const entry = await credentialVaultClient.getCredentialsDetails({ id: EVENTS_TOKEN_VAULT_ID });
  if (!entry || !entry.token) {
    throw new Error(
      `Credential Vault entry ${EVENTS_TOKEN_VAULT_ID} must be a "Token" entry containing a ` +
        "Dynatrace API token with the events.ingest scope.",
    );
  }
  return entry.token;
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

// Create a Dynatrace custom event via the classic environment API.
// eventType is CUSTOM_ALERT (revoked) or CUSTOM_INFO (recovery).
async function ingestCustomEvent(baseUrl, apiToken, { eventType, title, properties }) {
  const response = await fetch(`${baseUrl}/api/v2/events/ingest`, {
    method: "POST",
    headers: { Authorization: `Api-Token ${apiToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ eventType, title, properties }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Event ingest failed. Status ${response.status}. Body: ${text}`);
  }
  return text ? JSON.parse(text) : {};
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

  const baseUrl = getClassicEnvBaseUrl();
  const apiToken = await resolveEventsToken();
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
    eventsCreated: 0,
    processed: [],
  };

  const revoked = [];
  const activated = [];
  let primaryRevoked = null; // most recent revoke that passed the safety gate

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

      // The custom event — the integration point. Customer decides downstream.
      await ingestCustomEvent(baseUrl, apiToken, {
        eventType: "CUSTOM_ALERT",
        title: "BYOK key access lost",
        properties: { ...baseProperties, impact: REVOKED_IMPACT },
      });
      summary.eventsCreated += 1;

      // Persistence safety gate (requirement: incident only if revoke persists >5m).
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
        action: "custom_alert_event_created",
        incidentEligible: passesGate,
      });
    } else {
      summary.activatedEvents += 1;
      activated.push(item);

      await ingestCustomEvent(baseUrl, apiToken, {
        eventType: "CUSTOM_INFO",
        title: "BYOK key access restored",
        properties: baseProperties,
      });
      summary.eventsCreated += 1;

      summary.processed.push({ eventType, environmentUuid, keyName, date, action: "custom_info_event_created" });
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
    // Flags for OPTIONAL downstream native tasks (see the extended variant):
    hasRevoked: revoked.length > 0,
    hasActivated: activated.length > 0,
    hasIncident: incidentCount > 0,
    incidentCount,
    primaryRevoked: primaryRevoked || (revoked.length ? revoked[0] : null),
    primaryActivated,
    impactText: REVOKED_IMPACT,
    revokedText: revoked.length ? renderList(revoked) : "None",
    activatedText: activated.length ? renderList(activated) : "None",
    revoked,
    activated,
  };
}
