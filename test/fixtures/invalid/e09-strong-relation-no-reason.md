---
mdlineage:
  schema: 1
  id: docs.strong-no-reason
  kind: guide
  status: draft
  relations:
    - type: depends_on
      target: docs.cache-policy
---

# Strong relation without reason

`depends_on` is a strong type, so a non-empty `reason` is required. The schema
layer reports the missing field (MDL102); the workspace layer would report the
semantic gap as MDL304.
