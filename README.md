# MDLineage

**MDLineage** is a change-aware context index and validation toolkit for Markdown repositories. It helps coding agents discover how documents relate, understand what a document change may affect, keep document metadata useful and current, and keeps the documents themselves healthy — from syntax to directory layout.

The project combines two ideas:

- **Front Matter is the reviewable source of truth** for stable document identity and confirmed relationships.
- **RAG and graph analysis are maintenance tools** that discover candidate relationships, themes, duplicates, and possible contradictions.

### Metadata sources

MDLineage supports three ways to provide document metadata:

1. **Out-of-band manifest (preferred)**: Declare document metadata in `mdlineage.manifest.yaml` (automatically discovered beside `mdlineage.config.yaml` or declared via `manifestFile`/inline `manifest`). Markdown files remain completely untouched and clean. Missing entries can be generated with `mdlineage manifest seed`.
2. **YAML Front Matter**: Embedded `---` blocks in each Markdown document.
3. **Disabled**: Set `metadata.required: false` to disable missing metadata checks across the repository.

The goal is not to make every agent query depend on a large graph index. Most day-to-day work should remain possible with repository-native tools such as file paths, Markdown links, and grep. Semantic indexing is used where literal search misses meaningful relationships or where a global view is needed.

## Why the name

The name combines **MD**, for Markdown, with **Lineage**, for traceable relationships, provenance, and change impact. It describes the product’s purpose without tying it to a particular graph database, embedding model, or RAG framework.

The display name is **MDLineage** and the repository name is **md-lineage`.

## Product pillars

MDLineage addresses four classes of problems that Markdown repositories hit in real use:

1. **Relationship indexing.** Cross-document relations (`depends_on`, `refines`, `supersedes`, …) are proposed with evidence by semantic analysis, confirmed into Front Matter, and used for impact analysis when documents change.
2. **Syntax and metadata validation.** One validator core serves editor diagnostics (LSP), CLI checks, CI, and MCP: Front Matter boundaries, YAML, JSON Schema, cross-file semantics such as duplicate IDs and unresolved relation targets, with stable diagnostic codes.
3. **Line-ending hygiene.** Cross-platform (WSL/Windows) editing silently flips line endings and produces phantom diffs. MDLineage detects, repairs, and prevents line-ending drift; see [Line-ending management](./docs/specs/line-ending-management.md).
4. **Directory convention constraints.** Repositories can declare which kinds of documents belong where; layout drift is reported as diagnostics and moves are proposed with their impact. Design is still open; see [Directory conventions](./docs/specs/dir-conventions.md).

## Packages

| Package | Role |
| --- | --- |
| `@mdlineage/validator` | Transport-independent validation core: parsing, JSON Schema, workspace index, baseline. |
| `@mdlineage/remark-lint-mdlineage` | remark plugin; validates the unsaved buffer, not the disk copy. |
| `@mdlineage/cli` | The `mdlineage` binary: batch checks, CI gates, `init`, `fix`. |
| `@mdlineage/language-server` | Dedicated LSP over stdio. |
| `@mdlineage/mcp-server` | MCP server over stdio: validation, schema, and metadata tools for LLM agents. |

All five are at version `0.1.0`. The metadata schema and every tool interface are drafts, not a stability promise.

## Install and build

Requirements: Node `>= 20` and npm workspaces (this repository is `type: module`).

```bash
git clone <https://github.com/x-dc-coder/md-lineage.git>
cd md-lineage
npm ci && npm run build
```

`npm run build` runs `tsc -b` and restores the executable bit on the `mdlineage` binary. Until the packages are published, invoke the built CLI directly:

```bash
node packages/cli/dist/main.js --version   # mdlineage 0.1.0
node packages/cli/dist/main.js --help      # full command reference
```

In this repository, `check` reports a clean tree:

```bash
node packages/cli/dist/main.js check .     # 45 files checked, no diagnostics
node packages/cli/dist/main.js config validate   # mdlineage: config OK (<path>)
```

Read the caveat in [Status and known limits](#status-and-known-limits) before trusting that “no diagnostics” line: it is the committed baseline doing its job.

## Quick start in your own repository

```bash
cd /path/to/your/repo
node /path/to/md-lineage/packages/cli/dist/main.js init          # dry run: prints the plan only
node /path/to/md-lineage/packages/cli/dist/main.js init --write  # writes mdlineage.config.yaml, .gitattributes, schemas/
```

`init` writes three things: a config whose defaults already satisfy the config schema, a `.gitattributes` with `* text=auto eol=lf`, and an empty `schemas/` directory for repository-specific schemas. Then validate and repair:

```bash
node /path/to/md-lineage/packages/cli/dist/main.js check .   # validate, exit 0/1 by severity
node /path/to/md-lineage/packages/cli/dist/main.js fix       # dry run: shows the diff it would write
node /path/to/md-lineage/packages/cli/dist/main.js fix --write
```

Both `init` and `fix` are dry runs by default; `--write` is the only path to the filesystem. `fix` owns safe repairs only: missing required fields, missing relation reasons, duplicate relation entries, and line-ending normalization. For metadata it cannot guess, `suggest <file>` proposes operations for review and never writes.

## CLI command reference

Exit codes: `0` no error-severity diagnostics, `1` at least one error (`--frail`: any diagnostic at all), `2` usage error.

| Command | Purpose |
| --- | --- |
| `check [paths...]` | Validate Markdown; default scope is the CWD. |
| `check --changed` | Validate only files `git status` reports as changed. |
| `baseline update` | Record current violations as accepted debt. |
| `baseline show` | List the committed baseline. |
| `baseline verify` | CI gate: diagnostics must match the baseline exactly. |
| `server --stdio` | Run the language server over stdio. |
| `mcp --stdio` | Run the MCP server over stdio. |
| `init` | Bootstrap config, manifest skeleton, `.gitattributes`, and `schemas/` (dry run). |
| `manifest seed [paths...]` | Generate missing manifest entries for documents (dry run). |
| `suggest <file>` | Propose metadata for a document (no writes). |
| `fix [paths...]` | Apply safe fixes (dry run by default). |
| `config validate` | Check the config loads and passes the schema. |
| `index rebuild` | Rebuild the in-memory workspace index and report stats. |

Commands anchor “the workspace” differently, by design: `check`/`fix` use the CWD, while `baseline` and `init` anchor to the git repository root; the config search walks up the directory tree from the CWD (it may pass the git root). `fix` additionally refuses any path it resolves outside the CWD. Output formats: `text` (default), `json`, `sarif`.

## Four integration channels

One validator core, four ways to reach it — pick the channel that matches the job; setup for all of them is in [Editor & agent setup](./docs/使用手册/编辑器配置.md).

- **CLI** — batch validation, CI gates (`baseline verify`, `--format sarif`), and repair (`fix`). Start here.
- **remark plugin + `remark-language-server`** — realtime validation while you type, including on unsaved buffers. This repository’s `.remarkrc.mjs` is a working template.
- **Dedicated LSP** (`mdlineage server --stdio`) — richer than the remark channel: completion, hover, definition, references, rename (with prepare), document and workspace symbols, and code actions.
- **MCP** (`mdlineage mcp --stdio`) — seven tools for LLM agents: `validate_document`, `validate_repository`, `get_schema`, `list_document_ids`, `resolve_relation_target`, `suggest_metadata`, and `apply_metadata_patch`. The write boundary is deliberate: `suggest_metadata` proposes, `apply_metadata_patch` returns a reviewable diff, and only an explicit `write: true` touches disk.

## Repository development commands

```bash
npm run build          # tsc -b, then restore the bin exec bit
npm test               # build, then run all package tests (519 passing today)
npm run lint:md        # remark gate; README and docs/ are both in scope
npm run check:md       # mdlineage check .
npm run check:md:changed
npm run clean          # tsc -b --clean
```

`npm run lint:md` runs `remark docs README.md --frail`, so this README is itself gated.

## Status and known limits

MDLineage is at version `0.1.0` and released under the MIT License (see the `LICENSE` file at the repository root). The schema and tool interfaces are drafts; no compatibility is promised across releases.

What is verified: the CLI, both stdio servers, and the remark plugin are covered by 519 passing tests plus stdio smoke scripts that drive the real servers byte-for-byte. The `check`/`fix`/`init`/`baseline`/`suggest` flow above was executed end to end in a scratch repository for this README.

What is not verified, stated plainly:

- **No real client integration yet.** The LSP and MCP servers have never run inside VS Code, Neovim, Emacs, or Claude Desktop — only against their stdio protocols in tests and smoke scripts. The editor setup in `docs/editor-setup.md` is configuration that should work, not something a client has confirmed.
- **CI has never run on GitHub.** `.github/workflows/ci.yml` (build, tests, LF policy, `baseline verify`, `npm run lint:md`) and `release.yml` (npm publish with Sigstore provenance) are written but unexecuted; their first real run may surface problems.
- **The clean `check` output is baseline suppression.** In this repository, `check .` reports no diagnostics because 21 known violations are committed to `.mdlineage-baseline.json`. Under `--no-baseline` the same run reports 18 errors and a number of warnings, almost all of them the intentional violations in `test/fixtures/`. That is by design — the baseline is the debt contract — but it means a passing `check` here is not evidence of a clean repository.
- **Not implemented.** Directory convention rules (pillar P4, design still open in `docs/dir-conventions.md`), semantic retrieval and relationship inference (later phases of P1), and encoding checks for BOM or non-UTF-8 files (the reserved `MDL6xx` range).

This repository starts as a product and architecture proposal. The first phase adopts the remark ecosystem (remark-language-server, remark-lint, unified, yaml, ajv) as pinned repository dependencies hosting realtime validation; the long-term shape replaces the editor host with the dedicated MDLineage language server while keeping the same validator core. No graph database, embedding provider, or LLM provider has been selected as a required dependency.

## Documentation

**Guides**

- [Usage](./docs/使用手册/命令行参考.md) — commands, exit codes, output formats, CI patterns
- [Editor & agent setup](./docs/使用手册/编辑器配置.md) — the four channels, per-client configuration
- [Configuration](./docs/使用手册/配置指南.md) — `mdlineage.config.yaml` and schema overrides
- [Diagnostics](./docs/使用手册/诊断码速查.md) — every `MDL` code, its severity, and how to fix it

**Design documents**

- [Product vision](./docs/project/vision.md)
- [Architecture](./docs/specs/architecture.md)
- [Front Matter specification draft](./docs/specs/frontmatter-spec.md)
- [Realtime validation via remark-language-server](./docs/specs/remark-language-server-solution.md)
- [Line-ending management](./docs/specs/line-ending-management.md)
- [Directory conventions (open design)](./docs/specs/dir-conventions.md)
- [Progress tracker](./docs/project/progress.md)
- [Open-source project landscape](./docs/project/open-source-landscape.md)
- [Initial roadmap](./docs/project/roadmap.md)

## License

MDLineage is released under the MIT License; the full text is in the `LICENSE` file at the repository root.
