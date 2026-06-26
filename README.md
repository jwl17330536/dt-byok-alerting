# dt-byok-alerting

**BYOK Key Access Monitor** — a portable [Dynatrace Workflow](https://docs.dynatrace.com/docs/analyze-explore-automate/workflows)
that detects when a **Bring-Your-Own-Key (BYOK)** encryption key becomes
inaccessible and alerts + opens/resolves an external incident.

> There is **no native BYOK trigger** in Dynatrace. This workflow treats the
> [Account Management Notifications API](https://docs.dynatrace.com/docs/dynatrace-api/account-management-api/post-notifications)
> as the source of truth and polls it every 5 minutes.

---

## 🚀 Deploy in 2 minutes (Upload button)

1. **Download the workflow file** — [`byok-key-access-monitor.workflow.json`](byok-key-access-monitor.workflow.json)
   (open it, then use the *Download raw file* button, or `Save link as…`).
2. In Dynatrace, open **Workflows** → click **Upload** → choose the JSON file.
   See [Upload a workflow](https://docs.dynatrace.com/docs/analyze-explore-automate/workflows/manage-workflows/workflows-upload).
3. On the **Import workflow** screen, Dynatrace lists the **required app**
   (*Email*) and asks for any **connections** — confirm, then select **Import**.
4. The workflow opens in the editor **disabled**. Fill in the 4 placeholders
   below, then enable it.

That's it — no CLI required.

### Fill in after upload (in the workflow editor)

| Where | Placeholder | Set to |
|-------|-------------|--------|
| Task **`fetch_byok_notifications`** (JS, top of file) | `ACCOUNT_UUID` | your Dynatrace account UUID |
| same | `OAUTH_CREDENTIAL_VAULT_ID` | Credential Vault ID of the OAuth client (see below) |
| Tasks **`alert_email_…`** / **`recovery_email_…`** | `to: ["byok-oncall@example.com"]` | real recipient(s) |
| Tasks **`create_incident_…`** / **`resolve_incident_…`** | `url` + Authentication credential | your incident endpoint + its vault credential |

> Don't manage incidents externally? Just delete the two `*_incident_*` tasks.
> The email + custom-event paths work on their own.

---

## 🔧 One-time setup (secrets in the Credential Vault)

No secrets are stored in the workflow file — they live in the
[Credential Vault](https://developer.dynatrace.com/develop/guides/security/manage-secrets/).

1. **Create an Account Management OAuth client**
   (*Account Management → Identity & access management → OAuth clients*) with scope
   **`account-uac-read`**. Note the **client ID**, **client secret**, and **account UUID**.
2. **Create vault entries** (mark them available to AppEngine / workflows):

   | Vault entry | Type | Fields |
   |-------------|------|--------|
   | OAuth client | **User and password** | user = client ID, password = client secret |
   | Incident webhook auth *(optional)* | **Token** | token = your incident system's API token |

3. Paste the OAuth vault ID into `OAUTH_CREDENTIAL_VAULT_ID`, and select the
   incident Token credential in the HTTP tasks' **Authentication** section.

### Permissions (workflow run-as user)
- `events.ingest` — ingest the custom events.
- `storage:events:read` — optional, for cross-run dedup (degrades gracefully).
- Read access to the referenced Credential Vault entries.

---

## How it works (native-first design)

Everything you customize is a **native** action editable in the Workflows UI.
Only the unavoidable bits (OAuth, API paging, looping + dedup, per-record event
ingest) live in **one** small Run JavaScript task.

```
[Schedule: every 5 min]
        │
        ▼
fetch_byok_notifications            (Run JavaScript)  ← only code
        ├───────────────┬───────────────────┬───────────────────────┐
        ▼               ▼                   ▼                       ▼
alert_email_…       create_incident_…   recovery_email_…       resolve_incident_…
(Send email)        (HTTP request)      (Send email)           (HTTP request)
 if hasRevoked       if hasIncident      if hasActivated        if hasActivated
```

| Step | Action | Native? | Gate |
|------|--------|---------|------|
| Trigger | Schedule `*/5 * * * *` | native | — |
| `fetch_byok_notifications` | Run JavaScript | code (required) | — |
| `alert_email_byok_revoked` | Send email | **native** | `hasRevoked` |
| `create_incident_byok_revoked` | HTTP request (vault auth) | **native** | `hasIncident` |
| `recovery_email_byok_activated` | Send email | **native** | `hasActivated` |
| `resolve_incident_byok_activated` | HTTP request (vault auth) | **native** | `hasActivated` |

On **`BYOK_REVOKED`**: ingest `CUSTOM_ALERT` "BYOK key access lost" → email →
severity-1 incident (after a 5-minute persistence safety gate).
On **`BYOK_ACTIVATED`**: ingest `CUSTOM_INFO` "BYOK key access restored" → recovery
email → resolve incident. Records are de-duplicated by
`type + environmentUuid + keyName + date`.

---

## Repository layout

| Path | Purpose |
|------|---------|
| `byok-key-access-monitor.workflow.json` | **Upload this** to the Workflows app. Built artifact (committed). |
| `src/fetch_byok_notifications.js` | Source of the Run JavaScript task. |
| `src/assets/*.md`, `src/assets/*.json` | Email bodies + incident payload templates. |
| `src/workflow.base.json` | Task wiring / conditions (placeholders filled by the build). |
| `build.sh` | Reassembles `byok-key-access-monitor.workflow.json` from `src/`. |

### Editing the source

Prefer editing in `src/` and rebuilding (keeps escaping correct), then re-upload:

```bash
./build.sh   # requires jq
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
- The custom event "BYOK key access lost" is always ingested for visibility; only
  the external **incident** is gated by the persistence safety check.
- The native HTTP request action injects the vault secret into the standard
  `Authorization` header (`tokenPrefix` + token); custom auth header names are not
  supported by that action.

## License

[MIT](LICENSE)
