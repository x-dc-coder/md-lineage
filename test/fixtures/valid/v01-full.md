---
mdlineage:
  schema: 1
  id: docs.cache-policy
  kind: policy
  status: active
  authority: canonical
  topics:
    - caching
    - security
  aliases:
    - cache TTL
    - 缓存有效期
  relations:
    - type: depends_on
      target: docs.authentication-model
      reason: Cache keys include account identity and permission scope.
      evidence: "#cache-key"
---

# Cache policy

## Cache key

Every cache entry is keyed by account identity and permission scope.
