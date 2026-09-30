---
mdlineage:
  schema: 1
  id: docs.vision
  kind: vision
  status: active
  created_at: 2026-09-21
  updated_at: 2026-09-21
---

# Product vision

## Problem

Markdown repositories are easy for people and coding agents to inspect, but important context is spread across files. Some relationships are explicit in links. Others are implicit: one document refines a policy, describes an implementation, records an exception, or conflicts with an older claim.

Manually listing every relationship in agent instructions is brittle. A conventional semantic index can find related passages, but it may hide why the passages were linked and can become stale when source documents change.

## Product goal

MDLineage helps a repository maintain a small, reviewable map of its Markdown knowledge. It combines explicit metadata and links with semantic discovery, then helps agents use the map during changes.

The intended workflow is:

~~~text
Markdown repository
  → parse links and Front Matter
  → discover candidate semantic relationships and themes
  → review suggested metadata changes
  → store confirmed relationships with the documents
  → incrementally refresh derived indexes
  → let agents query impact and evidence on demand
~~~

## Product principles

### Keep source knowledge in the repository

Stable IDs, document status, and confirmed semantic relationships belong in Front Matter. They are versioned, reviewable, portable, and available without a separate service.

### Treat inference as a proposal

An LLM may suggest that two claims depend on, refine, contradict, or supersede one another. Suggestions should include evidence and confidence. High-impact relationships require review before becoming authoritative metadata.

### Preserve ordinary Markdown links

Existing links are valuable deterministic signals. Parse them, validate their targets and anchors, and derive reverse links automatically. Do not duplicate every body link in Front Matter.

### Use the lightest useful retrieval

Agents should be able to use paths, links, and grep for straightforward work. Semantic search and graph traversal should help when direct exploration is insufficient or when the question requires a repository-wide view.

### Make changes traceable

Every derived relationship should be traceable to its source document, relevant text, and indexing run. Every impact result should explain which edge led to the affected document.

## Scope for the first version

- Markdown repositories, including nested folders.
- YAML Front Matter parsing and validation.
- Relative Markdown link and heading-anchor resolution.
- Stable document IDs and typed relationships.
- Candidate relationship and topic suggestions with evidence.
- Incremental index refresh based on changed files.
- Agent tools for metadata suggestions, search, impact analysis, and validation.
- A local-first workflow suitable for Claude Code and other MCP-capable agents.

## Problem classes the product covers

Four recurring failure modes of Markdown repositories define the product pillars:

1. **Unknown cross-document relationships.** Dependencies, refinements, and supersessions live in prose and are invisible to tools. Pillar: relationship indexing with evidence-backed proposals and impact analysis.
2. **Broken syntax and metadata.** Front Matter that fails to parse, IDs that collide, relation targets that resolve to nothing. Pillar: one validator core behind LSP, CLI, CI, and MCP with stable diagnostic codes.
3. **Cross-platform hygiene.** Editing the same repository from WSL and Windows silently flips line endings and every file shows as modified. Pillar: line-ending detection, repair, and prevention (`docs/line-ending-management.md`).
4. **Layout drift.** Documents accumulate in directories that no longer match their role. Pillar: declarative directory conventions validated as diagnostics (`docs/dir-conventions.md`, design open).

## Not goals for the first version

- Replacing Git or the authoring workflow.
- Silently rewriting documents based on model inference.
- Requiring Neo4j, a hosted vector database, or a specific LLM provider.
- Building a general-purpose enterprise ingestion platform.
- Treating semantic similarity alone as a dependency.
