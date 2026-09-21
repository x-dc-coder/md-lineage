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
      reason: High-risk accounts have a shorter cache lifetime.
      evidence: "#high-risk-accounts"
---

# High-risk account policy

## High-risk accounts

High-risk accounts use a shorter cache lifetime than the default policy.
