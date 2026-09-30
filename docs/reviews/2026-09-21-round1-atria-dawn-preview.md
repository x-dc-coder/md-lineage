---
mdlineage:
  schema: 1
  id: docs.reviews.2026-09-21-round1-atria-dawn-preview
  kind: report
  status: active
---

# MDLineage cross-review report (Atria-Dawn-Preview)

Scope: all nine documents, 2026-09-21. External facts checked via MCP retrieval and direct GitHub/npm source fetches where possible; git behavior verified in sandbox repos; web_search/web_fetch unavailable to this reviewer. Unverifiable items marked as such. Files were not modified.

## Blockers

### B1 — `docs/line-ending-management.md` §3: `checkout-index -f -a` skip explanation inaccurate
- The doc claims the skip rule fires "after renormalization" on CRLF residue, chaining two unrelated mechanisms.
- Sandbox tests: the skip rule is stat-based (cached mtime/size match index → treated unchanged); `-f` only affects files that exist but differ from the index. In the incident's actual state (`i/lf w/crlf`), `checkout-index -f -a` did rewrite files to LF; a stat-matching file was skipped.
- Fix suggested: state the stat rule; prescribe delete-first + `checkout-index -f -a`; or recommend `git rm --cached -r . && git checkout .`.

### B2 — `docs/remark-language-server-solution.md` §6.3: `vscode-remark` + `remark.requireConfig: true` misdescribed
- `remark.requireConfig` defaults to **false**; when true it means "no config file → do nothing at all", so config-less repos silently lose all diagnostics.
- Being a user/workspace VS Code setting, it conflicts with §6.1's "no personal-machine versions" premise unless committed as `.vscode/settings.json`.

### B3 — same doc §9/§10/M1/M3: QuickFix and severity capabilities overstated
- `remark-language-server` v3 depends solely on `unified-language-server` (package.json verified); its `onCodeAction` uses only `diagnostic.data.expected` → single `TextEdit.replace(range, replacement)`. Structural YAML fixes (§9.1 items) cannot be expressed; they need the CLI or the dedicated LSP (M3).
- `unified-lint-rule` severities are 0/1/2 only; §8.2's four levels collapse Information/Hint → Warning on the remark channel. Document the downgrade.

## Major

- **M1** `frontmatter-spec.md`: example uses `refined_by`, absent from the vocabulary (both this doc and the validation design's config enum) — the spec's own example fails its own `MDL103`.
- **M2** `evidence` defined as "anchor or other stable locator" but MDL201 only checks current-doc anchors; the example's `evidence` points into the *target* doc, MDL402 covers cross-file anchors — the MDL201/MDL402 boundary and evidence scope are undefined.
- **M3** Diagnostic-code bookkeeping: MDL5xx and MDL9xx reserved but empty; MDL6xx named "encoding hygiene" without encoding codes; MDL202 vs MDL303/304 dedup priority unstated. Suggest "reserved" annotations or example codes.
- **M4** architecture.md graph: `B[Parser] --> C2[Hygiene checks]` contradicts the pre-parse raw-buffer placement required by line-ending doc §4.1.
- **M5** architecture.md agent tools vs remark §12 MCP tools: signatures disagree (`suggest_metadata(document_id…)` vs `(path)`), `validate_document` missing from architecture, `accept_metadata_patch` missing from remark §12; README cannot arbitrate.
- **M6** Proposal lifecycle gap: vision/architecture require an accept action; the most detailed implementation doc (remark §12, M4 deliverables) has none.
- **M7** `implements` "or vice versa according to configured direction" — but the config schema has no direction key; MDL305 cycle detection needs deterministic direction.
- **M8** Pillar-4 (layout) is pillar-level yet has no diagnostic block decided (MDL5xx vs MDL7xx) and is outside M0's contract; mark pending explicitly.

## Minor

- **m1** remark §5 vs §6.2: `src/index.ts` vs `import './packages/remark-lint-mdlineage/index.js'` — build-product path undefined; plugin→validator dependency unstated.
- **m2** `@mdlineage/validator` scope name appears only once; other packages' publish names undefined.
- **m3** line-ending §2 autocrlf table lacks a "no-attributes" scope note (post-`.gitattributes`, the table no longer describes checkout).
- **m4** roadmap cites `aae04d2` for "document the policy", but the doc arrived in `ad143d9`.
- **m5** architecture.md mermaid: syntax valid, all node refs resolve; no dangling ids. No defect.
- **m6** vision.md workflow consistent with architecture incrementality; `~~~` vs ``` fence styles differ between docs but are internally consistent. No defect.

## Extra observations (beyond assigned dimensions)

- §4.1 says remark-native rules keep their own IDs, while §14.4 demands identical `code` across all entrances — limit §14.4 to MDLineage-owned rules.
- EOL rewrite vs Front Matter CST TextEdit interaction undefined when both apply (ordering/range recomputation).
- `mdlineage init` should define dry-run + append-only semantics for existing `.gitattributes` files.

## Verified-correct highlights

autocrlf three-mode table; per-machine-config argument (with sandbox reproduction); `.gitattributes` precedence and no-rewrite-of-existing-files behavior; `--ignore-cr-at-eol` empty diff; `remark-frontmatter` boundary-only role; `remark-cli --frail/--no-stdout` flags; Ajv `instancePath` = JSON Pointer; remark-language-server config discovery matching remark-cli. Unverified: rumdl/mdschema/schematter/efm-langserver current state; external links in §18/§8 not exhaustively checked.

## Verdict

High-quality document set; git mechanics essentially correct (with B1's causal wording the exception). Fix B1/B3 before implementation; M1/M2 must be settled before the schema contract (M0) freezes; M6 before Phase 1.
