---
mdlineage:
  schema: 1
  id: docs.missing-anchor
  kind: guide
  status: draft
  relations:
    - type: related_to
      target: docs.cache-policy
      reason: Anchor below does not exist in this document.
      evidence: "#no-such-heading"
---

# Missing heading anchor

`#no-such-heading` is well formed, so the schema layer accepts it; no heading in
this document produces that anchor, which is MDL201 at the single-document
semantic layer (remark-language-server-solution.md §4.4).
