---
mdlineage:
  schema: 1
  id: docs.mixed-eol
  kind: guide
  status: draft
---

# Mixed line endings

This file mixes line-ending styles: the front matter and this heading use LF,
while the paragraphs below use CRLF.
Line endings are not visible in review, so drift spreads silently until a
phantom diff appears on another platform.
