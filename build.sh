#!/usr/bin/env bash
# Assemble the upload-ready workflow JSON files from the editable sources in src/.
# jq handles all JSON escaping so the JS / email / payload sources stay readable.
#
#   byok-key-access-monitor.workflow.json           <- focused: creates a custom event (default)
#   byok-key-access-monitor.extended.workflow.json  <- optional: + native email + incident example
set -euo pipefail
cd "$(dirname "$0")"

# Focused workflow — schedule + one Run JavaScript task that creates the custom event.
jq \
  --rawfile script src/fetch_byok_notifications.js \
  '.tasks.fetch_byok_notifications.input.script = $script' \
  src/workflow.base.json > byok-key-access-monitor.workflow.json
echo "Built byok-key-access-monitor.workflow.json (focused)"

# Extended workflow — adds optional native Send-email + incident HTTP tasks that
# act on the same JS result. Delete the tasks you don't want after import.
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
  src/workflow.extended.base.json > byok-key-access-monitor.extended.workflow.json
echo "Built byok-key-access-monitor.extended.workflow.json (extended)"
