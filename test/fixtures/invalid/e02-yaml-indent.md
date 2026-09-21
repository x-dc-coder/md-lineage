---
mdlineage:
  schema: 1
  id: docs.bad-indent
  kind: guide
  status: draft
   topics:
     - one
---

# Bad indentation

`topics` is indented by three spaces, which is not a valid YAML mapping under
`mdlineage`, so the block cannot be parsed.
