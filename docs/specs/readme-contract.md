---
mdlineage:
  schema: 1
  id: docs.specs.readme-contract
  kind: spec
  status: active
  created_at: 2026-10-02
  updated_at: 2026-10-02
---

# Root README contract

Status: active. This document defines what the repository-root `README.md` is for, what it may contain, and how its shape is enforced. The README is the front door; the manuals under `docs/使用手册/` are the reference.

## Purpose

The README answers four questions on the first screen and nothing more: what this is, what it can do, how to get it running in about a minute, and where the documentation lives. It is a navigation surface, not a manual.

## Language

Chinese only. The developer-facing documentation of this repository is Chinese (`docs/使用手册/**`), so the README follows it rather than duplicating the front door in a second language that would drift. If an English entry point is ever needed, add a short `README.en.md` (positioning, install, links) instead of translating the whole file.

## No new facts

Every statement in the README must already exist in `docs/使用手册/**` or `docs/specs/**`. The README may summarize and link; it must never be the only place a fact lives.

## Structure and budgets

| Section | Content | Budget |
| --- | --- | --- |
| Title + one-line positioning | what it is and which problem it solves | ≤ 3 lines |
| 快速开始 | install, init, seed, check, plus one short output sample | ≤ 20 lines |
| 核心能力 | 4–6 one-line bullets | ≤ 10 lines |
| 常用命令 | one table of the commands a newcomer actually needs | ≤ 12 lines |
| 文档 | links into `docs/使用手册/**` | ≤ 10 lines |
| 开发 | clone, build, test, self-check commands | ≤ 10 lines |
| 许可证 | one line | ≤ 2 lines |

Machine-enforced clauses, checked by `scripts/check-readme.mjs` in CI:

1. total length ≤ 100 lines;
2. exactly one `#` heading, and no heading deeper than `##`;
3. ≤ 5 fenced code blocks, each ≤ 12 lines;
4. ≤ 2 tables;
5. each `##` section ≤ 15 non-blank lines, and each paragraph ≤ 3 lines;
6. a fenced code block appears within the first 15 lines (the quick start stays above the fold);
7. every link target is relative — external URLs are not allowed, badges included.

Reviewed by humans rather than the script: the "no new facts" rule, and the reader test — a newcomer can install and run the tool from the first screen alone.

## Enforcement

`scripts/check-readme.mjs` runs as a step in the `gates` job of `.github/workflows/ci.yml`. Changing a limit means changing this document and the script in the same commit.
