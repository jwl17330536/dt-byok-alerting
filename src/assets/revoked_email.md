**SEVERE: Dynatrace cannot access the BYOK encryption key.**

Affected key(s):

{{ result('fetch_byok_notifications').revokedText }}

**Impact:** {{ result('fetch_byok_notifications').impactText }}

Checked window: {{ result('fetch_byok_notifications').checkedWindowStart }} → {{ result('fetch_byok_notifications').checkedWindowEnd }}
Records seen: {{ result('fetch_byok_notifications').recordsSeen }} | Revoked: {{ result('fetch_byok_notifications').revokedEvents }} | Incident-eligible: {{ result('fetch_byok_notifications').incidentCount }}
