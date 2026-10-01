---
mdlineage:
  schema: 1
  id: docs.architecture
  kind: architecture
  status: active
  created_at: 2026-09-21
  updated_at: 2026-09-24
---

# Architecture

## Overview

MDLineage separates repository-authored facts from generated indexes. Front Matter and Markdown links are source data. Embeddings, reverse references, inferred relationships, and theme summaries are derived and can be rebuilt.

~~~mermaid
flowchart TD
  A[Markdown files] --> B[Parser: body, headings, Front Matter, links]
  A --> C2[Hygiene checks: line endings, layout policy]
  B --> C[Deterministic index: IDs, link edges, validation]
  B --> D[Candidate discovery: lexical search, embeddings, entities]
  D --> E[LLM analysis: relation and theme proposals with evidence]
  E --> F[Reviewable metadata patch]
  F --> G[Confirmed Front Matter]
  C --> H[Derived graph and search index]
  G --> H
  H --> I[Agent tools: search, impact, validate]
  C2 --> I
  B --> J[Git diff / changed-file detection]
  J --> C
  J --> D
~~~

## Two indexing layers

### Repository layer

The repository contains:

- Stable document IDs.
- Document kind, status, authority, topics, and aliases where useful.
- Confirmed semantic relationships with a reason and evidence locator.
- Existing Markdown links in their original locations.

These values are reviewable in Git and remain useful if the derived index is unavailable.

### Derived layer

The local or service-side index may contain:

- Parsed headings and link targets.
- Reverse links and graph traversal results.
- Body and section hashes.
- Embeddings and lexical search structures.
- Candidate relationships, evidence spans, confidence, and model metadata.
- Theme clusters, community summaries, and validation results.

Generated data must identify its source revision or content hash so that stale results can be detected. It must be possible to rebuild it from repository content and configuration.

## Relationship sources

### Explicit Markdown links

Parse Markdown links into deterministic `links_to` edges. Resolve relative paths and heading anchors, then map target files to stable document IDs. Validate missing files and anchors. Generate reverse references in the derived index.

A link proves that the author created a navigation reference. It does not, by itself, prove a dependency, contradiction, or supersession.

### Confirmed Front Matter relationships

Typed relationships such as `depends_on`, `refines`, and `supersedes` are authoritative. They may drive impact analysis, validation, and agent workflows.

### Out-of-band Manifest relationships (Solution 4)

When documentation cannot be modified directly (e.g. symlinked external skill libraries, third-party packages, or zero-touch governance repositories), metadata and typed relationships can be declared in an external manifest file (`manifestFile: mdlineage.manifest.yaml`) or inline configuration.

The validator engine merges manifest declarations into the in-memory `DocEntry` during workspace indexing. Documents covered by the manifest receive full first-class citizen capabilities: ID resolution, cycle checking (MDL305), deprecated dependency blocking (MDL306), and impact analysis, while source Markdown files remain 100% byte-identical on disk.

### Inferred candidates

Candidate discovery should combine lexical retrieval, embeddings, shared entities, headings, links, and existing metadata. An LLM classifies candidate pairs and returns evidence. Similarity is a recall signal, not a persisted relationship type by itself.

Candidate relationships remain derived until a user or agent accepts a proposed patch. A proposal should include source and target IDs, relation type, evidence locator, evidence text, confidence, and the analysis version.

## Change processing

When files change:

1. Identify changed, added, renamed, and removed Markdown files from Git or filesystem events.
2. Reparse only affected files and compare stable IDs, section hashes, links, and Front Matter.
3. Update deterministic edges and remove edges whose source references disappeared.
4. Mark candidate relations sourced from changed content as stale and refresh only the affected analysis.
5. Recompute reverse references and the impact set from confirmed relationships.
6. Run schema, link, and graph validation.
7. Optionally propose metadata updates for review.

Theme communities and repository-wide summaries can be refreshed in batches rather than on every edit.

## Discovery and freshness pipeline (Four-stage funnel)

Auditing documentation for stale contents and broken prerequisites avoids linear, manual file-by-file reading. Instead, MDLineage executes a funnel-style discovery pipeline that narrows hundreds of documents to anomaly targets in seconds:

1. **Stage 1: Mechanical rule and clock filtering**
   Runs `mdlineage check .` to evaluate deterministic rules in milliseconds:
   - Broken prerequisites: `MDL302` (missing target ID), `MDL306` (dependency deprecated), `MDL401`/`MDL403` (missing link paths).
   - Lifecycle decay: `MDL801` (authored timestamp or Git clock exceeds `staleAfterDays`), `MDL503` (expired layout exception).
2. **Stage 2: Graph topology and blast radius traversal**
   Traverses the in-memory `WorkspaceIndex` directed acyclic graph:
   - Orphan detection: flags isolated documents with zero in-degree and zero out-degree.
   - Upstream impact: when a foundation document is deprecated or changed, queries `index.referrersOf(targetId)` to identify the exact downstream affected set.
3. **Stage 3: Fact entity and environment probing**
   Extracts hardcoded environment facts (tool versions, file paths, ports) via regex or AST and runs read-only probes (`which`, `--version`, `test -e`, `nc`) to detect external fact drift without LLM context overhead.
4. **Stage 4: Targeted semantic review**
   Performs detailed conceptual reading and editing exclusively on the small fraction of documents flagged by stages 1 to 3.

## Agent interface

The first agent integration should expose focused operations instead of requiring an agent to construct graph queries:

- `search_documents(query, filters)` — MCP: `search_documents` / `list_document_ids`
- `get_document(document_id)` — MCP: `get_document` / `resolve_relation_target`
- `suggest_metadata(document_id, changed_sections)` — MCP: `suggest_metadata`
- `analyze_impact(document_id or diff)` — MCP: `analyze_impact`
- `validate_document(path, content?)` / `validate_repository(paths)` — MCP: same names
- `apply_metadata_patch(proposal_id, write?)` — explicit accept step; by default it returns a reviewable diff and writes nothing, `write: true` atomically persists the reviewed text; MCP exposes it under this name (see `docs/remark-language-server-solution.md` §12 for the authoritative tool list, signatures, and proposal lifecycle)

Read operations should return concise results with document paths and evidence. Writing metadata should be an explicit operation that produces a reviewable diff.

## Reliability boundaries

- The parser and schema validator provide deterministic checks.
- LLM output is uncertain and must carry evidence.
- Graph traversal can explain known dependencies; it cannot prove that every relevant relationship has been recorded.
- Coverage should be evaluated with curated examples and repository-specific checks before claiming completeness.
