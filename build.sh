#!/usr/bin/env bash
# Assemble byok-key-access-monitor.workflow.json (the upload-ready file) from the
# editable sources in src/. jq handles all JSON escaping so the JS / email /
# payload sources stay readable and editable.
set -euo pipefail
cd "$(dirname "$0")"

jq \
  --rawfile script        src/fetch_byok_notifications.js \
  --rawfile revokedEmail  src/assets/revoked_email.md \
  --rawfile recoveryEmail src/assets/recovery_email.md \
  --rawfile incidentBody  src/assets/incident_payload.json \
  --rawfile recoveryBody  src/assets/recovery_payload.json \
  '
    .tasks.fetch_byok_notifications.input.script         = $script
  | .tasks.alert_email_byok_revoked.input.content        = $revokedEmail
  | .tasks.recovery_email_byok_activated.input.content   = $recoveryEmail
  | .tasks.create_incident_byok_revoked.input.payload    = $incidentBody
  | .tasks.resolve_incident_byok_activated.input.payload = $recoveryBody
  ' \
  src/workflow.base.json > byok-key-access-monitor.workflow.json

echo "Built byok-key-access-monitor.workflow.json"
