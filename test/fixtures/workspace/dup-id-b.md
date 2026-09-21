---
mdlineage:
  schema: 1
  id: docs.duplicate-id-a
  kind: guide
  status: draft
  relations:
    - type: depends_on
      target: docs.missing-target
      reason: Target below does not exist anywhere in the repository.
---

# Duplicate id B

Claims the same id as `workspace/dup-id-a.md`, which is MDL301 at the workspace
layer. Its relation target `docs.missing-target` resolves to no document in the
repository, which is MDL302.
