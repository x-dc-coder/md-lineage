---
mdlineage:
  schema: 1
  id: docs.authentication-model
  kind: reference
  status: active
---

# Authentication model

## Cache key

Identity and permission scope are the two halves of a cache key: the identity
names whose entry it is, and the scope names what it may reach. A cache policy
that keys its entries on both depends on this model to define them.

Carries no relations of its own: it exists so a document that depends on it can
resolve its target.
