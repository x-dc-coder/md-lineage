---
mdlineage:
  schema: 1
  id: docs.duplicate-id-a
  kind: guide
  status: draft
  relations:
    - type: depends_on
      target: docs.cache-policy
      reason: Same id as the sibling document.
---

# Duplicate id A

This document intentionally shares its id with `workspace/dup-id-b.md` so the
pair exercises MDL301. Duplicate-id detection needs the whole repository, so the
code is not in this fixture's `expectedCodes` and the pair is marked
`workspace: true` in the manifest.
