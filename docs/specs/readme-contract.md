---
mdlineage:
  schema: 1
  id: docs.specs.readme-contract
  kind: spec
  status: active
  created_at: 2026-10-02
  updated_at: 2026-10-02
---

# README contract

Status: active. This document defines what a landing page in this repository is for, what it may contain, and how its shape is enforced. The root `README.md` is the project's front door; the manuals under `docs/使用手册/` are the reference.

## Scope

| Target | Role | Contract |
| --- | --- | --- |
| `README.md` (root) | project facade | full contract (clauses 1–7) |
| any other `*/README.md` | directory landing page / index | light contract (clauses 1L, 2, 7) |
| `test/fixtures/**` | fixture contracts and test material | exempt — ordinary documents |

A directory without a `README.md` is not a defect: a landing page is added when a directory needs a map, not by default.

## Naming

Hand-written landing pages are named `README.md` — GitHub renders a directory's `README.md` inline when browsing, which is exactly what a landing page is for. `INDEX.md` is reserved for **generated** listings: the catalog capability sketched in `docs/specs/dir-conventions.md` (`intent.catalog`) would produce machine-written indexes, and a hand-written index taking that name would collide with generated output. No third name is introduced.

## Purpose

A landing page answers "what is here, and where do I go next" and nothing more. It is a navigation surface, not a manual.

## Language

Chinese for hand-written landing pages. The developer-facing documentation of this repository is Chinese (`docs/使用手册/**`), so the README follows it rather than duplicating the front door in a second language that would drift. If an English entry point is ever needed, add a short `README.en.md` (positioning, install, links) instead of translating the whole file.

## No new facts

Every statement in a landing page must already exist in `docs/使用手册/**` or `docs/specs/**`. A landing page may summarize and link; it must never be the only place a fact lives.

## Structure and budgets (root facade)

| Section | Content | Budget |
| --- | --- | --- |
| Title + one-line positioning | what it is and which problem it solves | ≤ 3 lines |
| 快速开始 | install, init, seed, check, plus one short output sample | ≤ 20 lines |
| 核心能力 | 4–6 one-line bullets | ≤ 10 lines |
| 常用命令 | one table of the commands a newcomer actually needs | ≤ 12 lines |
| 文档 | links into `docs/使用手册/**` | ≤ 10 lines |
| 开发 | clone, build, test, self-check commands | ≤ 10 lines |
| 许可证 | one line | ≤ 2 lines |

Landing pages follow no prescribed sections — they mirror the tree they index — but they are held to the light budget below.

## Machine-enforced clauses

Root facade (`README.md`):

1. total length ≤ 100 lines;
2. exactly one `#` heading, and no heading deeper than `##`;
3. ≤ 5 fenced code blocks, each ≤ 12 lines;
4. ≤ 2 tables;
5. each `##` section ≤ 15 non-blank lines, and each paragraph ≤ 3 lines;
6. a fenced code block appears within the first 15 lines (the quick start stays above the fold);
7. every link target is relative — external URLs are not allowed, badges included.

Directory landing pages:

1L. total length ≤ 120 lines;
2. exactly one `#` heading, and no heading deeper than `##`;
7. every link target is relative.

Reviewed by humans rather than the script: the "no new facts" rule, the navigation-only role of landing pages, and the reader test — a newcomer can install and run the tool from the first screen alone.

## Enforcement

`scripts/check-readme.mjs` walks the repository (skipping `.git`, `node_modules` and `dist`), applies the facade contract to the root `README.md` and the light contract to every other `README.md`, and runs as a step in the `gates` job of `.github/workflows/ci.yml`. Changing a limit or the target table means changing this document and the script in the same commit.
