# Directory conventions proposal

Status: draft, design pending. This document frames the fourth MDLineage capability: validating the directory layout that Markdown documents live in. The open questions at the end must be answered before implementation.

## Problem

Markdown repositories organize documents by directory, but nothing enforces that organization. The same repository ends up mixing design documents, meeting notes, policies, and generated reports; documents migrate between directories without their metadata or links being re-examined; agents and readers can no longer rely on the tree as a map. Unlike broken links or duplicate IDs, layout drift is silent: no existing tool flags it.

Typical cases MDLineage should cover:

- Design documents that belong in a versioned docs tree but sit in the repository root, which is what happened in this repository before `docs/` was adopted.
- A document that changes role (a draft guide becomes a policy) without moving to the directory its new kind requires.
- Directories whose contents have drifted from their declared purpose, such as `docs/policies/` accumulating how-to guides.

## Direction

Treat directory layout as a declarative repository policy, validated by the same engine and configuration as every other check:

~~~yaml
# mdlineage.config.yaml
layout:
  - match: docs/design/**
    require:
      kind: [architecture, reference]
      frontmatter: required
  - match: docs/policies/**
    require:
      kind: policy
      authority: canonical
    forbid:
      status: [draft]
  - match: notes/**
    require:
      frontmatter: optional
~~~

This reuses the policy layer already specified in `docs/remark-language-server-solution.md` (Section 7.3): declarations compile to stable diagnostic codes, and the config schema validates them with editor completion.

Three capabilities layer on top:

1. **Path–kind consistency.** When the repository maps directories to document kinds, the `kind` in Front Matter and the file's location must agree, or the document must be listed as an explicit exception.
2. **Layout-aware suggestions.** When discovery or validation finds a document whose role does not match its location, propose a move together with the link and metadata updates the move requires. Moves stay proposals; the tool never relocates files silently.
3. **Move impact.** Before a move is accepted, list the relations, reverse references, and anchors that reference the document, so the cost is visible first.

## Constraints

- Conventions must be per-repository configuration. MDLineage ships the enforcement mechanism and sensible defaults, never a fixed layout.
- Mixed repositories are the norm: code, documents, and generated files share the tree. Rules must scope by glob and tolerate ignored paths.
- The check must work incrementally in the editor (validate the moved or created file against the policy) and authoritatively in the CLI.
- Because MCP servers and agents resolve documents by path, layout validation directly protects agent navigation; the capability should be exposed through the same MCP tools as the other checks.

## Open questions

These decisions are deliberately deferred:

1. Should conventions be enforced on creation, on move, or continuously as diagnostics? Continuous reporting can be noisy for repositories in transition.
2. Is `kind` in Front Matter the source of truth that paths must match, or do paths define kind where Front Matter is silent?
3. How are exceptions declared and expired (explicit allowlist entries, time-boxed suppressions, or per-directory overrides)?
4. Does MDLineage ever execute the move itself (producing a WorkspaceEdit across the repository), or only emit a report that the agent applies?
5. Which diagnostic-code block covers layout (`MDL5xx` policy codes versus a new `MDL7xx` block)?
