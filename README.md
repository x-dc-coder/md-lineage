# MDLineage

**MDLineage** is a change-aware context index for Markdown repositories. It helps coding agents discover how documents relate, understand what a document change may affect, and keep document metadata useful and current.

The project combines two ideas:

- **Front Matter is the reviewable source of truth** for stable document identity and confirmed relationships.
- **RAG and graph analysis are maintenance tools** that discover candidate relationships, themes, duplicates, and possible contradictions.

The goal is not to make every agent query depend on a large graph index. Most day-to-day work should remain possible with repository-native tools such as file paths, Markdown links, and grep. Semantic indexing is used where literal search misses meaningful relationships or where a global view is needed.

## Why the name

The name combines **MD**, for Markdown, with **Lineage**, for traceable relationships, provenance, and change impact. It describes the product’s purpose without tying it to a particular graph database, embedding model, or RAG framework.

The display name is **MDLineage** and the repository name is **md-lineage**.

## Initial design

1. Parse Markdown structure, Front Matter, and ordinary Markdown links.
2. Resolve explicit links deterministically and build reverse references as derived data.
3. Use lexical search, embeddings, and LLM analysis to propose implicit semantic relationships.
4. Present evidence-backed metadata patches for review; confirmed relationships are written to Front Matter.
5. Recompute derived indexes incrementally when source files change.
6. Expose focused tools to agents for search, metadata suggestions, impact analysis, and validation.

## Design documents

- [Product vision](docs/vision.md)
- [Architecture](docs/architecture.md)
- [Front Matter specification draft](docs/frontmatter-spec.md)
- [Open-source project landscape](docs/open-source-landscape.md)
- [Initial roadmap](docs/roadmap.md)

## Status

This repository starts as a product and architecture proposal. The metadata schema and tool interface are drafts, not a stable compatibility promise. No third-party implementation has been selected as a required dependency.
