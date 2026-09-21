---
mdlineage:
  schema: 1
  id: docs.duplicate-relation
  kind: guide
  status: draft
  relations:
    - type: related_to
      target: docs.cache-policy
      reason: First declaration.
    - type: related_to
      target: docs.cache-policy
      reason: Second declaration of the same (type, target) pair.
---

# Duplicate relation

The same `(type, target)` pair appears twice; the schema layer accepts both
entries, so this is caught by the single-document semantic layer as MDL202.
