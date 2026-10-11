---
mdlineage:
  schema: 1
  id: docs.evidence-source
  kind: guide
  status: draft
  relations:
    - type: related_to
      target: docs.evidence-target
      reason: Target does not have this anchor.
      evidence: "#missing-anchor"
---

# Evidence source

This fixture targets `docs.evidence-target` with an anchor missing in that target,
producing MDL402 at the workspace layer.
