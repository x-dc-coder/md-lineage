---
mdlineage:
  schema: 1
  id: docs.bad-relation-type
  kind: guide
  status: draft
  relations:
    - type: refined_by
      target: docs.cache-policy
      reason: Inverse forms are not part of the vocabulary.
---

# Illegal relation type

`refined_by` does not exist: direction is fixed per type and reverse views are
derived, never authored.
