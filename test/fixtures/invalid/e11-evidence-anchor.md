---
mdlineage:
  schema: 1
  id: docs.bad-evidence
  kind: guide
  status: draft
  relations:
    - type: related_to
      target: docs.cache-policy
      reason: Anchor syntax is wrong.
      evidence: cache-key
---

# Bad evidence anchor

`evidence` must be a heading anchor written as `"#anchor"`; a bare value without
the leading `#` fails the schema pattern (MDL103).
