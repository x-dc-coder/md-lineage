# Front Matter specification draft

This is an initial proposal for document metadata. The schema is intentionally small and may change before the first release.

## Example

~~~yaml
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
    - type: refined_by
      target: docs.high-risk-account-policy
      reason: High-risk accounts have a shorter cache lifetime.
      evidence: "#high-risk-accounts"
---
~~~

## Field meanings

- `schema`: metadata schema version.
- `id`: stable repository-wide document identifier. It should not change when a file is moved.
- `kind`: a repository-defined document category, such as policy, guide, architecture, or reference.
- `status`: lifecycle state such as active, draft, or deprecated.
- `authority`: optional source-of-truth designation, such as canonical or supporting.
- `topics`: concise, human-readable concepts used for filtering and discovery.
- `aliases`: alternate names, abbreviations, or terms likely to appear in searches.
- `relations`: confirmed typed relationships to other stable document IDs.
- `reason`: short explanation for a relationship.
- `evidence`: optional heading anchor or other stable locator in the source document.

## Initial relationship vocabulary

| Type | Meaning | May drive impact analysis |
|---|---|---:|
| `depends_on` | The source document relies on a rule or fact in the target | Yes |
| `implements` | The source documents the target implementation, or vice versa according to configured direction | Yes, direction must be consistent |
| `refines` | The source narrows or adds conditions to the target | Yes |
| `supersedes` | The source replaces the target as the current guidance | Yes |
| `contradicts` | The documents contain claims that appear incompatible | Review required |
| `example_of` | The target is an example of the source concept | Usually no |
| `related_to` | A broad topical relationship | No; discovery only |

The project must define edge direction once and test it in documentation and tools. For example, `A depends_on B` means a change to B may require review of A.

## Rules

1. `id` values are unique and stable within a repository.
2. Every relation target must resolve to exactly one known document ID.
3. Each relation uses an allowed type and includes a concise reason for strong relationships.
4. Store only the authored direction. Generate reverse references in the derived index.
5. Parse ordinary Markdown links as `links_to` edges; do not duplicate them in `relations` unless the author is asserting stronger semantics.
6. Do not put embeddings, body hashes, confidence scores, or generated timestamps in Front Matter.
7. Keep LLM proposals outside authoritative metadata until accepted.
8. Preserve unknown Front Matter fields when reading and updating a document.

## Proposal lifecycle

An inferred relationship should be presented with:

- Source and target document IDs.
- Suggested relationship type.
- Evidence text and locator from both sides where available.
- Confidence and a brief explanation.
- Index/model version and analyzed content hashes.

The first version should produce a patch for review. Automatic acceptance can be considered only for low-impact metadata such as topic or alias suggestions, with an opt-in policy.
