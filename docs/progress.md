# Project progress tracker

Master status table for MDLineage. The product has four pillars (defined in `README.md`): P1 relationship indexing, P2 syntax & metadata validation, P3 line-ending hygiene, P4 directory conventions. Update this file whenever a milestone lands; each row links to its authoritative document section.

## Milestone matrix

| Milestone | Pillars | Status | Owner model | Deliverables | Acceptance gate | Evidence |
|---|---|---|---|---|---|---|
| Repo bootstrap: vision/architecture/Front Matter spec | P1 | ✅ Done (2026-09-21) | main session | vision, architecture, frontmatter-spec, open-source-landscape | docs complete and internally consistent | commits `611b392` |
| Line-ending incident fix: `.gitattributes` + worktree normalization | P3 | ✅ Done (2026-09-21) | main session | `.gitattributes`, `i/lf w/lf` everywhere | `git status` clean on both platforms | commits `aae04d2`, `13c311a` |
| Pillar framing: README pillars, vision scope, pillar-tagged roadmap | all | ✅ Done (2026-09-21) | main session | README "Product pillars", vision "Problem classes", roadmap v2 | pillars consistent across 3 docs | commit `6ec7c71` |
| Cross-review round 1 (2 independent reviewers) + adjudication + fixes | all | ✅ Done (2026-09-21) | Atria-Dawn-Preview, glm-5.3, main session | `docs/reviews/` (2 reports + adjudication), 25+ fixes across 9 docs | all Blockers/Majors resolved or consciously deferred | this round |
| **M0 — Validator rule contract** | P2 | 🔜 Next | TBD | `schemas/mdlineage-v1.schema.json`, `mdlineage-config.schema.json`, initial MDLxxx codes, valid/invalid fixtures | every deterministic rule in frontmatter-spec has a Schema rule or code | remark-solution §16 M0 |
| M1 — remark realtime single-doc validation | P2, P3 | ⬜ Not started | TBD | `.remarkrc.mjs`, validator parser/schema/doc modules, `remark-lint-mdlineage`, editor configs, CLI/CI scripts | unsaved-buffer YAML/Schema/anchor/EOL errors appear live; CLI matches | remark-solution §16 M1 |
| M2 — Workspace index & authoritative CLI | P1, P2, P3 | ⬜ Not started | TBD | Workspace index, duplicate-ID/target/anchor/cycle checks, JSON+SARIF output, `--changed` (worktree-byte basis) | add/delete/move/modify discovered incrementally; CI blocks integrity breaks | remark-solution §16 M2 |
| M3 — Dedicated MDLineage LSP | P2 | ⬜ Not started | TBD | `mdlineage server --stdio`, buffer overlay, completion/definition/references/rename, structured Code Actions | one LSP replaces remark host; diagnostics match CLI | remark-solution §16 M3; roadmap Phase 2 |
| M4 — MCP & organization extensions | P1, P2 | ⬜ Not started | TBD | MCP validation/search/impact tools, `apply_metadata_patch` proposal queue, presets, rule-plugin allowlist | LLM gets structured diagnostics pre-commit; explicit accept loop closes | remark-solution §16 M4 |
| Semantic metadata assistant (retrieval, proposals, patches) | P1 | ⬜ Not started | TBD | lexical+semantic candidate retrieval, evidence-backed proposals, reviewable patches, freshness hashes | proposal precision target met | roadmap Phase 1 |
| Directory conventions: design finalization → implementation | P4 | 🟡 Open design | TBD | resolve 5 open questions in `dir-conventions.md`, then declarative `layout:` block | path–kind consistency enforced; every doc matches or carries exception | dir-conventions.md |
| Repository-wide analysis (dup concepts, contradictions, orphans, themes) | P1 | ⬜ Not started | TBD | batch analysis, topic clusters, evaluation sets | recall/precision targets | roadmap Phase 3 |

## Decision log

| Date | Decision | Rationale |
|---|---|---|
| 2026-09-21 | LF-only policy via committed `.gitattributes` (`* text=auto eol=lf`) | two-platform WSL/Windows development; committed attributes beat per-machine config |
| 2026-09-21 | remark-language-server hosts realtime diagnostics in phase 1; dedicated LSP is the end state | fastest path to editor diagnostics; validator core is transport-independent |
| 2026-09-21 | Relation directions fixed per type in the vocabulary; no per-relation direction config | deterministic cycle detection (MDL305); one definition of each type |
| 2026-09-21 | `apply_metadata_patch` is the only path from proposal to Front Matter | LLM output never writes authoritative metadata directly |
| 2026-09-21 | `check --changed` uses worktree bytes / `git status --porcelain`, never `git diff` | diff is empty for EOL-only edits under active attributes (verified) |
| 2026-09-21 | VS Code channel locks plugins/config; stdio channel locks the server itself | vscode-remark bundles the server via esbuild (verified) |

## Open issues (design debt)

| # | Issue | Pillar | Blocking |
|---|---|---|---|
| 1 | Multi-process index consistency (LSP overlay vs CLI vs MCP: source of truth, cache invalidation) | P1, P2 | M2/M3 |
| 2 | Legacy-repo onboarding: baseline / bulk-exemption / gradual `metadata.required` adoption | P2 | M2 |
| 3 | Monorepo & cross-repository relation-target resolution | P1 | M2+ |
| 4 | Encoding checks under MDL6xx (BOM, non-UTF-8) — block named, codes pending | P3 | M1+ |
| 5 | Layout enforcement timing (create/move/continuous) and kind-vs-path authority | P4 | design phase |
| 6 | `MDL5xx` vs dedicated `MDL7xx` block for layout codes | P4 | design phase |

## Review cadence

Cross-reviews run per major document wave with two independent reviewers on different models, followed by an orchestrator adjudication pass. Round 1: `docs/reviews/2026-09-21-round1-*`. The next review wave is scheduled after M0 deliverables exist.
