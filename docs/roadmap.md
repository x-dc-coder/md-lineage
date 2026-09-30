---
mdlineage:
  schema: 1
  id: docs.roadmap
  kind: plan
  status: active
---

# Initial roadmap

Pillars referenced below are the four product pillars defined in `README.md`: relationship indexing (P1), syntax and metadata validation (P2), line-ending hygiene (P3), and directory conventions (P4).

## Phase 0: Contract and prototype

- Agree on Front Matter fields and relationship direction. (P1)
- Parse Markdown AST, YAML Front Matter, relative links, and anchors. (P2)
- Validate IDs, relation targets, and broken links. (P2)
- Ship the validator rule contract: `mdlineage-v1.schema.json`, config schema, initial MDLxxx diagnostic codes, and fixtures. (P2, per `docs/remark-language-server-solution.md` M0)
- Enforce repository line endings via `.gitattributes` and document the policy. (P3, done: `aae04d2` attributes, `ad143d9` analysis document `docs/line-ending-management.md`)
- Build a local derived index and reverse-reference view. (P1)
- Demonstrate impact analysis using authored relationships. (P1)

## Phase 1: Semantic metadata assistant

- Retrieve candidate documents using lexical and semantic search. (P1)
- Generate evidence-backed topic, alias, and relation proposals. (P1)
- Produce reviewable Front Matter patches. (P1)
- Record content hashes and analyzer versions for freshness. (P1)
- Add a CLI suitable for local hooks and CI. (P2; done: `mdlineage check`/`baseline verify` wired into `.github/workflows/ci.yml`, `b5057e8`)
- Realtime editor validation through `remark-language-server` plus the shared validator core: Front Matter, Schema, single-document semantics, and line-ending checks (`MDL601`/`MDL602`). (P2, P3; per `docs/remark-language-server-solution.md` M1–M2)
- Fix mode for line-ending drift, and `mdlineage init` emitting the `.gitattributes` policy. (P3; done: `mdlineage fix` `5ba2064`, `mdlineage init` `efe9642`, both dry-run by default with `--write` to apply)

## Phase 2: Agent integration

- Provide MCP tools for search, metadata suggestions, impact analysis, and validation. (P1, P2)
- Provide the dedicated `mdlineage server` LSP (completion, definition, references, rename, full four-level severities, structured Code Actions), replacing the remark host per the validation design's M3. (P2)
- Provide `apply_metadata_patch` — the explicit proposal-acceptance step closing the LLM loop. (P1; done: `53cf15b`, with the opt-in `write` flag `7daae5e`)
- Provide a Claude Code Skill describing when and how to use those tools.
- Add opt-in hooks for refreshing changed Markdown and validating the repository.
- Keep normal agent workflow usable with grep and repository-native files.
- CI gate that fails on line-ending policy violations regardless of the committing platform. (P3; done: the hygiene-gates job in `.github/workflows/ci.yml` enforces the line-ending gate, `b5057e8`)

## Phase 3: Repository-wide analysis

- Detect duplicate concepts, likely contradictions, orphan documents, and stale relationships. (P1)
- Generate topic clusters and global summaries in a batch process. (P1)
- Finalize the directory-conventions design (see the open questions in `docs/dir-conventions.md`) and implement path–kind consistency as declarative policy diagnostics. (P4)
- Add evaluation sets for relation extraction and impact recall. (P1)
- Consider optional graph database backends only if the local index becomes insufficient.

## Success measures

- Precision of accepted semantic relationship suggestions. (P1)
- Recall of known affected documents for curated changes. (P1)
- Number of broken links, unresolved relation targets, and stale index entries detected. (P2)
- Line-ending phantom diffs: zero after adoption; every CRLF-only change caught by `check --changed`. (P3)
- Layout drift: every document either matches its declared directory convention or carries an explicit exception. (P4)
- Cost and time to refresh after a small Markdown change.
- Agent task success with and without MDLineage context.
