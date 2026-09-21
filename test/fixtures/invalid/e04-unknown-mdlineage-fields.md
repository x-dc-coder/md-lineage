---
mdlineage:
  schema: 1
  id: docs.unknown-fields
  kind: guide
  status: draft
  tpoics:
    - typo
  relationz:
    - type: related_to
      target: docs.cache-policy
---

# Unknown fields

`tpoics` and `relationz` are not part of schema v1, so the mdlineage namespace
rejects them via `additionalProperties: false` (MDL104).
