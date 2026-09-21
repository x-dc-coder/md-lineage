---
mdlineage:
  schema: 1
  id: docs.cycle-a
  kind: policy
  status: active
  relations:
    - type: supersedes
      target: docs.cycle-b
      reason: Cycle of supersedes edges.
---

# Cycle A

`supersedes` is configured with `cycles: forbidden`, so an A → B → A loop is
MDL305. Detectable only with a workspace index.
