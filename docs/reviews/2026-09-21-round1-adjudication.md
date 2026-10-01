---
mdlineage:
  schema: 1
  id: docs.reviews.2026-09-21-round1-adjudication
  kind: report
  status: archived
  created_at: 2026-09-21
  updated_at: 2026-10-01
---

# Cross-review round 1 — adjudication record

Date: 2026-09-21. Two independent reviewers (Atria-Dawn-Preview, glm-5.3) audited all nine design documents. Raw reports: `atria-dawn-preview.md`, `glm-5.3.md` in this directory.

## Agreement matrix

Both reviewers independently flagged (highest confidence):

| Finding | Atria | glm | Adjudication |
|---|---|---|---|
| frontmatter-spec example uses `refined_by`/`refined_by` not in vocabulary | B-level | B1 | **Fixed** — example rewritten to `refines` authored in the target document; `refined_by` removed |
| §5 vs §6.2 plugin path/build-product mismatch | m1 | M3 | **Fixed** — packages build to `dist/`, import via `@mdlineage/*`, package naming defined |
| MCP/agent tool lists inconsistent across docs; `accept_metadata_patch` missing from implementation layer | M5/M6 | M2 | **Fixed** — §12 is authoritative; `apply_metadata_patch(proposal_id)` added with proposal queue lifecycle; architecture maps concept names to MCP names |
| `implements` direction ambiguity with no config key | M7 | M1(a) | **Fixed** — directions fixed per type in the vocabulary, "vice versa" removed, config explicitly carries no direction key |
| Diagnostic-code gaps (MDL5xx/MDL9xx reserved but empty; MDL6xx named "encoding" without codes) | M3 | M10(d) | **Fixed** — blocks annotated as reserved/pending in §8.1; MDL6xx renamed to line-ending hygiene |
| README "no third-party dependency" contradicts pinned remark deps | — | M8 | **Fixed** — Status rewritten |

Single-reviewer findings, verified and fixed:

- **B1 (Atria) / line-ending §3**: `checkout-index` skip-rule wording. Adjudicated by re-running sandbox tests (see below). **Rewritten.**
- **B2 (glm) + B3 (Atria)**: vscode-remark bundles the server via esbuild (verified against `remarkjs/vscode-remark@3.3.1` `package.json`: empty `dependencies`, build script `esbuild … remark-language-server --bundle`, no server-path setting). **§6.3 rewritten** to separate the VS Code channel (bundled server, repo locks plugins/config only) from the stdio channel (repo-locked server); `remark.requireConfig` default and silent-skip side effect documented; `.vscode/settings.json` recommended.
- **B3-severity/Atria + glm capability check**: `unified-language-server` code actions only consume `diagnostic.data.expected` as single-range replacements (verified in source, `onCodeAction`); lint severities are 0/1/2 only. **§9.1 boundary note added**; §8.2 notes Information/Hint collapse to Warning on the remark channel.
- **glm B3 (CI threat model / `--changed` basis)**: verified experimentally — under `text=auto eol=lf`, a CRLF worktree edit yields empty `git diff`; a diff-based `--changed` would silently miss it. **Fixed** in line-ending §4.1/§4.3 and remark §6.4: `--changed` must scan worktree bytes or `git status --porcelain`; CI gate redefined as attributes-presence + committed-blob check (defense in depth).
- **MDL303 unreachable** (glm M5): annotated as extension-reserved (fires only under optional alias/path fallback resolution). **Fixed.**
- **MDL304 layer conflict** (glm M4, Atria noted adjacent): §4.3 wording now scopes the structural check to `reasonRequired` fields; MDL304 remains the semantic workspace-level code. **Fixed.**
- **`mdlineage init`/`fix` missing from §10.1** (glm M9): **added**, with dry-run/append-only semantics for existing `.gitattributes`.
- **Dedicated LSP absent from roadmap** (glm M7): **added** to Phase 2 with pillar tags.
- **`forbid` DSL collision** layout vs policies (glm M6): layout became a dedicated block with `forbidStatus`; explicit sibling-not-reuse note. **Fixed.**
- **config `schema: 1` name clash** (glm m5): renamed `configVersion: 1`. **Fixed.**
- **§14.4 vs remark rule IDs** (Atria extra): scope note added — MDL consistency guarantee covers MDLineage rules; remark-native IDs pass through unchanged. **Fixed.**
- **RAGFlow link 404** (glm m2): corrected to the `dataset` docs path. **Fixed.**
- **`D:\Git` autocrlf is system config, not global** (glm m1): **corrected** in line-ending §3.
- **"per-machine config can never fix" overstatement** (glm m7): **rewritten** — alignment can suppress symptoms; machine-level config cannot be relied on.
- **EOL-rewrite vs structural TextEdit ordering** (Atria extra): **defined** in line-ending §4.2 — structural fixes first, EOL rewrite last with offset recomputation.
- **`gitattributes` generation clobbering** (Atria extra): dry-run + append-only semantics specified. **Fixed.**
- **Architecture graph edge B→C2 contradicts pre-parse placement** (Atria M4): graph corrected, source is `A`. **Fixed.**
- **dir-conventions self-referencing history** (glm m8): **softened** to a neutral statement.
- **Required-field marking in frontmatter-spec** (glm m3): **added** `(required)` annotations.
- **`evidence` locator scope** (Atria M2 + glm m4): **fixed** — v1 supports target-document heading anchors only; MDL201/MDL402 boundary stated.
- **`example_of` meaning inverted** (glm M1b): **fixed** to "The source is an example of the target concept".

Declined / not changed (with reason):

- glm m6 (§1 ASCII graph implies LSP→MCP ordering): layout adjusted so MCP sits as a peer; deeper ASCII re-layout judged cosmetic.
- glm M10(a–c) (multi-process index consistency, legacy-repo onboarding, cross-repository targets): real gaps but design-stage decisions; recorded in progress tracker as open issues rather than patched ad hoc.
- Roadmap "CLI" pillar tag (glm m10): tag added.

## Adjudication experiments (run by the orchestrator)

1. Sandbox repo, `* text=auto eol=lf` committed, index=LF:
   - worktree CRLF with stat cache intact → `checkout-index -f -a` **rewrote to LF** (stat mismatch → written);
   - worktree CRLF after `touch` (stat matches index except mtime/content differs) → still rewritten;
   - worktree CRLF where the index-cached stat matched the file (fresh checkout, bytes differ but stat cache coincided) → **skipped**, matching the incident where `git checkout --` was a no-op on stat-matching files.
   Conclusion: the skip rule is purely stat-based; "CRLF survives because checkout-index refuses" is wrong, and "skip = stat match" is the correct general statement. Atria's causal claim and glm's verdict were both partially right; the document now states the stat rule and prescribes delete-first as the reliable remedy.
2. With attributes active, `git diff` on a CRLF worktree edit is empty (warning only); `git status --porcelain` shows `M` until re-add. Confirms glm's B3 detection-basis point.
3. `gitattributes` beats `autocrlf=false` for tracked text files (attribute `eol=lf` wins). Consistent with both reports.
4. `remarkjs/vscode-remark` (not `remcohaszing/`): server bundled via esbuild, zero runtime deps, no server-path option — B2 upheld.
5. `unifiedjs/unified-language-server` `onCodeAction`: only `data.expected` string replacements — B3 capability boundary upheld.

## Residual risk

- §18/§8 reference links other than RAGFlow were spot-checked (HTTP 200) but their content claims (rumdl, mdschema, schematter, efm-langserver capabilities) remain unverified at description level.
- Historical claims in the line-ending incident (exact mtimes) are consistent with the recorded evidence but not independently re-reproducible.
