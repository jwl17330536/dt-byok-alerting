# dt-byok-alerting

**BYOK Key Access Monitor** — a portable [Dynatrace Workflow](https://docs.dynatrace.com/docs/analyze-explore-automate/workflows)
that detects when a **Bring-Your-Own-Key (BYOK)** encryption key becomes
inaccessible and **creates a Dynatrace custom event**. From there, *you* decide
what to do with the event (alert on it, trigger another workflow, build a
dashboard, route it to a third party…).

> There is **no native BYOK trigger** in Dynatrace. This workflow treats the
> [Account Management Notifications API](https://docs.dynatrace.com/docs/dynatrace-api/account-management-api/post-notifications)
> as the source of truth and polls it every 5 minutes.

| BYOK notification | Custom event created |
|-------------------|----------------------|
| `BYOK_REVOKED` (Dynatrace lost key access) | **`CUSTOM_ALERT`** — *"BYOK key access lost"* |
| `BYOK_ACTIVATED` (access restored) | **`CUSTOM_INFO`** — *"BYOK key access restored"* |

Each event carries `environment_uuid`, `key_name`, `severity`, `message`,
`notification_date`, an `impact` description, and a `byok_dedupe_key`.

---

## 🚀 Deploy in 2 minutes (Upload button)

1. **Download the workflow file** — [`byok-key-access-monitor.workflow.json`](byok-key-access-monitor.workflow.json)
   (open it → *Download raw file*).
2. In Dynatrace, open **Workflows** → click **Upload** → choose the JSON file.
   See [Upload a workflow](https://docs.dynatrace.com/docs/analyze-explore-automate/workflows/manage-workflows/workflows-upload).
3. On the **Import workflow** screen, confirm any required apps/connections → **Import**.
4. The workflow opens **disabled**. Fill in the 3 placeholders below, then enable it.

### Fill in after upload (task `fetch_byok_notifications`, top of the script)

| Placeholder | Set to |
|-------------|--------|
| `ACCOUNT_UUID` | your Dynatrace account UUID |
| `OAUTH_CREDENTIAL_VAULT_ID` | Credential Vault ID of the OAuth client (token #1 below) |
| `EVENTS_TOKEN_VAULT_ID` | Credential Vault ID of the events-ingest API token (token #2 below) |

> **No secrets live in the workflow file** — only the Credential Vault *IDs*.

---

## 🔑 Get your Dynatrace tokens

You need **two** Dynatrace credentials. Create each, then store it in the
[Credential Vault](https://developer.dynatrace.com/develop/guides/security/manage-secrets/)
and paste the **vault ID** into the script.

### Token #1 — Account Management **OAuth client** (read notifications)

The Notifications API lives on `api.dynatrace.com` and is authenticated with an
account-level OAuth client (not an environment token).

1. Go to **Account Management** → **Identity & access management** → **OAuth clients**.
   (Account Management is at <https://account.dynatrace.com>; pick your account if you have several.)
2. Select **Create client**. Provide a service-user email and a description.
3. Under **Permissions / scopes**, add **`account-uac-read`**
   *(Allow read access for usage and consumption resources)*.
4. Create the client and **copy the Client ID and Client secret now** (the secret
   is shown only once).
5. Copy your **Account UUID** — it's shown on the OAuth clients page (and in the
   client details). This is the `ACCOUNT_UUID` value.

Docs: [Authenticate to Account Management with OAuth clients](https://docs.dynatrace.com/docs/manage/account-management/identity-access-management/oauth).

**Store it:** Credential Vault → **Add credential** → type **User and password**
→ *Username* = Client ID, *Password* = Client secret. Copy the resulting
`CREDENTIALS_VAULT-…` ID → `OAUTH_CREDENTIAL_VAULT_ID`.

### Token #2 — Environment **API token** (ingest the custom event)

The custom event is written with `POST /api/v2/events/ingest`, which needs an
environment API token.

1. In your environment, go to **Settings → Access tokens → Generate new token**
   (Platform: **Access Tokens** app → **Generate new token**).
2. Name it (e.g. `byok-events-ingest`) and select the scope **Ingest events**
   (`events.ingest`).
3. **Generate** and copy the token (`dt0c01.…`), shown only once.

Docs: [Access tokens](https://docs.dynatrace.com/docs/manage/identity-access-management/access-tokens-and-oauth-clients/access-tokens)
· [Events POST ingest](https://docs.dynatrace.com/docs/dynatrace-api/environment-api/events-v2/post-event).

**Store it:** Credential Vault → **Add credential** → type **Token** → paste the
API token. Copy the `CREDENTIALS_VAULT-…` ID → `EVENTS_TOKEN_VAULT_ID`.

> Mark **both** vault entries as **available to AppEngine / workflows** so the
> workflow can read them.

### Token summary

| # | Credential | Scope / type | Vault entry type | Script variable |
|---|------------|--------------|------------------|-----------------|
| 1 | Account Management OAuth client | `account-uac-read` | User and password (id/secret) | `OAUTH_CREDENTIAL_VAULT_ID` |
| 2 | Environment API token | `events.ingest` | Token | `EVENTS_TOKEN_VAULT_ID` |

The workflow's run-as user also needs **read access** to these vault entries
(and `storage:events:read` if you keep the optional cross-run dedup check).

---

## 🧩 What to do with the custom event

The workflow's job ends at creating the event. Common next steps — pick any:

- **Alert on it** — In *Settings → Anomaly detection → Custom events for alerting*,
  raise a problem when a `BYOK key access lost` event appears, then use your
  existing problem notifications (Slack, email, PagerDuty, ServiceNow…).
- **Trigger another workflow** — Build a second workflow with a **Davis problem /
  event trigger** filtered to `event.name == "BYOK key access lost"` and do
  whatever you like (open a ticket, page on-call, run automation).
- **Query / visualize** — `fetch events | filter event.name == "BYOK key access lost"`
  in a Notebook or Dashboard tile.
- **Want a ready-made example?** Use the **extended** workflow below, which adds
  native *Send email* + *incident webhook* tasks that react to the same result.

---

## 📦 Two workflow files

| File | What it does |
|------|--------------|
| [`byok-key-access-monitor.workflow.json`](byok-key-access-monitor.workflow.json) | **Default.** Schedule + one JS task that **creates the custom event**. |
| [`byok-key-access-monitor.extended.workflow.json`](byok-key-access-monitor.extended.workflow.json) | Optional. Same, **plus** native *Send email* and *HTTP incident* tasks (delete the ones you don't want). |

The extended variant needs two more things after upload:
recipient address(es) on the email tasks, and an incident endpoint URL +
its own **Token** vault credential on the two `*_incident_*` HTTP tasks.

---

## How it works (native-first design)

Only the unavoidable bits (OAuth, API paging, looping + dedup, per-record event
creation) live in **one** small Run JavaScript task. The optional extended
variant keeps every customer-facing action as a **native**, UI-editable step.

```
[Schedule: every 5 min]
        │
        ▼
fetch_byok_notifications   (Run JavaScript)  → CREATES Dynatrace custom event(s)
        │                                       (default workflow stops here)
        └── (extended only) ─┬───────────────┬───────────────────┬──────────────┐
                             ▼               ▼                   ▼              ▼
                       alert_email_…   create_incident_…   recovery_email_…  resolve_incident_…
                       if hasRevoked   if hasIncident      if hasActivated   if hasActivated
```

Records are de-duplicated by `type + environmentUuid + keyName + date`. The
`CUSTOM_ALERT` is always created; in the extended variant the external incident
is additionally gated by a 5-minute persistence safety check.

---

## Repository layout

| Path | Purpose |
|------|---------|
| `byok-key-access-monitor.workflow.json` | **Upload this** (default, event-only). Built artifact. |
| `byok-key-access-monitor.extended.workflow.json` | Optional extended variant. Built artifact. |
| `src/fetch_byok_notifications.js` | Source of the Run JavaScript task. |
| `src/workflow.base.json` | Focused task wiring. |
| `src/workflow.extended.base.json` | Extended task wiring (email + incident). |
| `src/assets/*` | Email bodies + incident payload templates (extended). |
| `build.sh` | Rebuilds both workflow JSON files from `src/` (needs `jq`). |

### Editing

Edit files in `src/`, then rebuild and re-upload:

```bash
./build.sh
```

### Optional: deploy with dtctl instead of the Upload button

```bash
dtctl apply -f byok-key-access-monitor.workflow.json --dry-run   # validate
dtctl apply -f byok-key-access-monitor.workflow.json --write-id  # create
```

---

## Notes

- API filter values are `BYOK_REVOKED` / `BYOK_ACTIVATED`; the API returns record
  `type` as lower-hyphen (`byok-revoked`). The script normalizes both.
- The environment API host differs from the apps host; the script derives it from
  `getEnvironmentUrl()` (`*.apps.*` → `*.*`).
- Knobs at the top of the script: `LOOKBACK_MINUTES` (10),
  `SAFETY_MIN_PERSIST_MINUTES` (5), `ENABLE_PERSISTENCE_SAFETY`,
  `ENABLE_CROSS_RUN_DEDUP`.

## License

[MIT](LICENSE)
