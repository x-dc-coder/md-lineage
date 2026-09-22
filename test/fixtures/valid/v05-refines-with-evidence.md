---
mdlineage:
  schema: 1
  id: docs.high-risk-account-policy
  kind: policy
  status: active
  authority: canonical
  relations:
    - type: refines
      target: docs.cache-policy
      reason: High-risk accounts get a shorter cache lifetime than the default policy.
      evidence: "#cache-policy"
---

# High-risk account policy

## High-risk accounts

High-risk accounts use a shorter cache lifetime than the default policy.

## Cache policy

This section carries the cache lifetime the high-risk override sets, so the
evidence anchor resolves both here and in the document this one refines
(`docs.cache-policy`, whose `# Cache policy` heading anchors as `cache-policy`).
