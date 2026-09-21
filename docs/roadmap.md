# Initial roadmap

## Phase 0: Contract and prototype

- Agree on Front Matter fields and relationship direction.
- Parse Markdown AST, YAML Front Matter, relative links, and anchors.
- Validate IDs, relation targets, and broken links.
- Build a local derived index and reverse-reference view.
- Demonstrate impact analysis using authored relationships.

## Phase 1: Semantic metadata assistant

- Retrieve candidate documents using lexical and semantic search.
- Generate evidence-backed topic, alias, and relation proposals.
- Produce reviewable Front Matter patches.
- Record content hashes and analyzer versions for freshness.
- Add a CLI suitable for local hooks and CI.

## Phase 2: Agent integration

- Provide MCP tools for search, metadata suggestions, impact analysis, and validation.
- Provide a Claude Code Skill describing when and how to use those tools.
- Add opt-in hooks for refreshing changed Markdown and validating the repository.
- Keep normal agent workflow usable with grep and repository-native files.

## Phase 3: Repository-wide analysis

- Detect duplicate concepts, likely contradictions, orphan documents, and stale relationships.
- Generate topic clusters and global summaries in a batch process.
- Add evaluation sets for relation extraction and impact recall.
- Consider optional graph database backends only if the local index becomes insufficient.

## Success measures

- Precision of accepted semantic relationship suggestions.
- Recall of known affected documents for curated changes.
- Number of broken links, unresolved relation targets, and stale index entries detected.
- Cost and time to refresh after a small Markdown change.
- Agent task success with and without MDLineage context.
