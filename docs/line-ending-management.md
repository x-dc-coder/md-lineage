# Line-ending management

This document records the CRLF incident that affected this repository, the mechanism behind it, and the plan to make line-ending hygiene a product feature of MDLineage. It is both an incident report and a feature proposal.

## 1. The incident (2026-09-21)

### Symptom

Six tracked files showed as modified while every diff line was deleted and re-added with identical content:

```text
349 insertions(+), 349 deletions(-)  # content unchanged
```

`git diff --ignore-cr-at-eol` produced empty output: the only difference was a `\r` at the end of every line.

### Evidence

| Evidence | Reading |
|---|---|
| `git ls-files --eol` → `i/lf w/crlf` | Index and HEAD content are LF; the worktree is CRLF |
| All six mtimes equal the clone second (16:56:49) | CRLF was written once at checkout, never by later edits |
| `.git/config` contains `filemode = false` | Written by Git for Windows through the `\\wsl.localhost` network path; a native WSL clone records `filemode = true` |
| Windows-side `git.exe` (D:\Git) global `core.autocrlf=true`; WSL side sets no autocrlf at system, global, or repo level | Asymmetric configuration between the two platforms |

### Timeline

1. The repository was cloned from Windows via `git.exe` into a `\\wsl.localhost\...` path. With `core.autocrlf=true`, checkout rewrote every text file to CRLF. Commits made this way are still normalized to LF, so repository history stayed clean.
2. All subsequent git commands ran with the WSL-side git, which performs no conversion. It compares bytes, saw CRLF in the worktree against LF in the index, and reported every file as modified — a phantom diff.
3. Later files created on the WSL side (for example `docs/remark-language-server-solution.md`) are LF, so the worktree ended up with mixed line endings.

## 2. Mechanism: why WSL/Windows switching causes this

`core.autocrlf` controls checkout and commit-time conversion:

| Setting | Checkout | Commit | Typical place |
|---|---|---|---|
| `true` | LF → CRLF | CRLF → LF | Git for Windows installer default |
| `input` | unchanged | CRLF → LF | Linux recommendation |
| unset | unchanged | unchanged | WSL default (byte-exact) |

One `.git` directory and one worktree are shared by two platforms, each with its own git binary and its own configuration. Whenever the Windows side writes the worktree (autocrlf converts) and the WSL side reads status (no conversion), every line ending becomes a diff. The reverse also happens: a Windows side configured with `autocrlf=false` plus a CRLF-default editor will commit CRLF into history. Files touched alternately by both platforms flip their endings back and forth, which poisons code review, `--changed` tooling, and blame.

Per-machine `autocrlf` configuration can never fix this, because it is exactly the per-machine divergence that causes it.

## 3. Repository-level fix (applied)

Committed attributes override every machine's autocrlf and travel with the clone, so both platform agree:

```bash
printf '* text=auto eol=lf\n' > .gitattributes
git add .gitattributes
git add --renormalize .     # rehash tracked text files under the new rules
git checkout-index -f -a    # rewrite the worktree from the index (LF)
```

One operational note: `checkout-index -f -a` skips files whose cached stat data still matches the index. If CRLF bytes survive after renormalization, delete the affected worktree files first and then run `checkout-index -f -a` to force the rewrite. After this, `git ls-files --eol` shows `i/lf w/lf` for all files and `git status` is clean.

Recommended habits for this project:

- Keep Markdown operations on one side (VS Code with the WSL Remote extension uses the WSL git and stays consistent).
- Set the Windows-side global `core.autocrlf` to `false`; attributes are the authoritative control.

## 4. Productization: line-ending hygiene as an MDLineage feature

The repository-level fix protects this one repository only if every contributor and tool obeys it. As a product, MDLineage should treat line endings as part of document health, in three stages.

### 4.1 Detection (validator layer)

Add a line-ending check to the five-layer rule stack in `docs/remark-language-server-solution.md`:

- Diagnostic code `MDL601` — mixed line endings within one file.
- Diagnostic code `MDL602` — line ending differs from the repository policy (default LF, configurable).

Placement: a fast boundary scan on the raw buffer, before AST parsing, alongside the Front Matter boundary scanner. This keeps the check exact even when the Markdown under it fails to parse, and it works on unsaved editor buffers — exactly where phantom CRLF appears first.

### 4.2 Repair (fix layer)

- Provide a safe auto-fix that rewrites line endings to the policy target. A whole-buffer EOL rewrite does not touch comment structure or field order, so it fits the "safe fix" tier (TextEdit-returned, user-confirmed).
- CLI: `mdlineage fix --line-endings` (or a `--fix` flag on `mdlineage check`) for hooks and CI.

### 4.3 Prevention (guard layer)

- Ship a generated `.gitattributes` recommendation: `mdlineage init` writes `* text=auto eol=lf` (or the configured policy) when the attribute file is missing or silent on the covered paths.
- `mdlineage check` warns when the worktree disagrees with the declared policy, so phantom diffs are caught at authoring time, before review or CI.
- Optional CI mode fails on CRLF sneaking into commits, independent of which platform made the commit.

### 4.4 Non-goals

- No silent rewriting of files outside the declared policy.
- No automatic reconfiguration of users' global git settings; MDLineage enforces the repository contract and explains how to satisfy it.

## 5. Definition of done

- The `MDL601`/`MDL602` diagnostics exist with fixtures for CRLF, LF, mixed, and CR-only files.
- The safe fix converts a mixed file to policy in one TextEdit pass without altering AST or Front Matter semantics.
- `mdlineage check --changed` catches a CRLF-only change and reports a stable, machine-readable code.
- A phantom-diff reproduction (clone with autocrlf on one platform, status on the other) is part of the test suite, mirroring the incident in Section 1.
