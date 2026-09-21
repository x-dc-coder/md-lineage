---
mdlineage:
  schema: 1
  id: docs.cycle-b
  kind: policy
  status: active
  relations:
    - type: supersedes
      target: docs.cycle-a
      reason: Closing the forbidden cycle.
---

# Cycle B

Completes the `supersedes` cycle with `docs.cycle-a` (MDL305).
