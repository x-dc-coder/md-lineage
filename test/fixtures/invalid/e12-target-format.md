---
mdlineage:
  schema: 1
  id: docs.bad-target
  kind: guide
  status: draft
  relations:
    - type: related_to
      target: ./docs/cache-policy.md
      reason: Target must be a stable id, never a file path.
---

# Bad relation target

The target is a file path rather than a stable document id, so it fails the
id pattern (MDL103 at the schema layer; semantically this would also be an
unresolvable target at the workspace layer).
