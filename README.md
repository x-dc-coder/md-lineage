# MDLineage

**MDLineage** is a change-aware context index and validation toolkit for Markdown repositories. It helps coding agents discover how documents relate, understand what a document change may affect, keep document metadata useful and current, and keeps the documents themselves healthy — from syntax to directory layout.

The project combines two ideas:

- **Front Matter is the reviewable source of truth** for stable document identity and confirmed relationships.
- **RAG and graph analysis are maintenance tools** that discover candidate relationships, themes, duplicates, and possible contradictions.

The goal is not to make every agent query depend on a large graph index. Most day-to-day work should remain possible with repository-native tools such as file paths, Markdown links, and grep. Semantic indexing is used where literal search misses meaningful relationships or where a global view is needed.

## Why the name

The name combines **MD**, for Markdown, with **Lineage**, for traceable relationships, provenance, and change impact. It describes the product’s purpose without tying it to a particular graph database, embedding model, or RAG framework.

The display name is **MDLineage** and the repository name is **md-lineage**.

## Product pillars

MDLineage addresses four classes of problems that Markdown repositories hit in real use:

1. **Relationship indexing.** Cross-document relations (`depends_on`, `refines`, `supersedes`, …) are proposed with evidence by semantic analysis, confirmed into Front Matter, and used for impact analysis when documents change.
2. **Syntax and metadata validation.** One validator core serves editor diagnostics (LSP), CLI checks, CI, and MCP: Front Matter boundaries, YAML, JSON Schema, cross-file semantics such as duplicate IDs and unresolved relation targets, with stable diagnostic codes.
3. **Line-ending hygiene.** Cross-platform (WSL/Windows) editing silently flips line endings and produces phantom diffs. MDLineage detects, repairs, and prevents line-ending drift; see [Line-ending management](docs/line-ending-management.md).
4. **Directory convention constraints.** Repositories can declare which kinds of documents belong where; layout drift is reported as diagnostics and moves are proposed with their impact. Design is still open; see [Directory conventions](docs/dir-conventions.md).

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
- [Realtime validation via remark-language-server](docs/remark-language-server-solution.md)
- [Line-ending management](docs/line-ending-management.md)
- [Directory conventions (open design)](docs/dir-conventions.md)
- [Progress tracker](docs/progress.md)
- [Open-source project landscape](docs/open-source-landscape.md)
- [Initial roadmap](docs/roadmap.md)

## Status

This repository starts as a product and architecture proposal. The metadata schema and tool interface are drafts, not a stable compatibility promise. The first phase adopts the remark ecosystem (remark-language-server, remark-lint, unified, yaml, ajv) as pinned repository dependencies hosting realtime validation; the long-term shape replaces the editor host with the dedicated MDLineage language server while keeping the same validator core. No graph database, embedding provider, or LLM provider has been selected as a required dependency.

## License

MDLineage is released under the MIT License; the full text is in the `LICENSE` file at the repository root.

