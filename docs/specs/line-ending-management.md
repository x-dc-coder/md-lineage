---
mdlineage:
  schema: 1
  id: docs.line-ending-management
  kind: spec
  status: active
  created_at: 2026-09-21
  updated_at: 2026-10-01
---

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

`core.autocrlf` controls checkout and commit-time conversion. The table below describes the no-`.gitattributes` situation — the state this repository was in during the incident. Once a committed attribute rule covers a path, the attributes take precedence over every machine's `autocrlf` setting:

| Setting | Checkout | Commit | Typical place |
|---|---|---|---|
| `true` | LF → CRLF | CRLF → LF | Git for Windows installer default |
| `input` | unchanged | CRLF → LF | Linux recommendation |
| unset | unchanged | unchanged | WSL default (byte-exact) |

One `.git` directory and one worktree are shared by two platforms, each with its own git binary and its own configuration. Whenever the Windows side writes the worktree (autocrlf converts) and the WSL side reads status (no conversion), every line ending becomes a diff. The reverse also happens: a Windows side configured with `autocrlf=false` plus a CRLF-default editor will commit CRLF into history. Files touched alternately by both platforms flip their endings back and forth, which poisons code review, `--changed` tooling, and blame. Aligning every machine's config (for example, `input` everywhere) can suppress the symptom, but machine-level configuration cannot be relied on: it drifts, it is invisible in the repository, and a new machine reproduces the problem. Only committed attributes make the policy travel with the code.

## 3. Repository-level fix (applied)

Committed attributes override every machine's autocrlf and travel with the clone, so both platform agree:

```bash
printf '* text=auto eol=lf\n' > .gitattributes
git add .gitattributes
git add --renormalize .     # rehash tracked text files under the new rules
git checkout-index -f -a    # rewrite the worktree from the index (LF)
```

One operational note: `git checkout-index` writes files only when it decides the worktree copy needs refreshing. Its skip rule is stat-based — if a file's cached stat data (mtime, size) still matches the index, the file is treated as unchanged and skipped, and `-f` does not override that rule (`-f` only affects files that exist but differ from the index). In this incident the CRLF files did differ from the index and were rewritten; had any file been skipped because its stat happened to match, deleting that worktree file first and re-running `checkout-index -f -a` forces the rewrite. (Plain `git checkout -- <path>` skips on the same stat rule, which is why the delete-first step is the reliable remedy.) Verified after this: `git ls-files --eol` shows `i/lf w/lf` for all files and `git status` is clean.

Recommended habits for this project:

- Keep Markdown operations on one side (VS Code with the WSL Remote extension uses the WSL git and stays consistent).
- Set the Windows-side global `core.autocrlf` to `false`; attributes are the authoritative control. (In this incident `autocrlf=true` was found in the Git for Windows *system* config at `D:\Git\etc\gitconfig`.)

## 4. Productization: line-ending hygiene as an MDLineage feature

The repository-level fix protects this one repository only if every contributor and tool obeys it. As a product, MDLineage should treat line endings as part of document health, in three stages.

### 4.1 Detection (validator layer)

Add a line-ending check to the five-layer rule stack in `docs/remark-language-server-solution.md`:

- Diagnostic code `MDL601` — mixed line endings within one file.
- Diagnostic code `MDL602` — line ending differs from the repository policy (default LF, configurable).

Placement: a fast boundary scan on the raw buffer, before AST parsing, alongside the Front Matter boundary scanner. This keeps the check exact even when the Markdown under it fails to parse, and it works on unsaved editor buffers — exactly where phantom CRLF appears first. Detection basis for batch modes: `check --changed` must scan worktree bytes (or `git status --porcelain`), never `git diff` output or staged blobs — under active `text=auto eol=lf` attributes a CRLF-only worktree edit produces an empty diff, and a diff-based implementation would silently miss it (verified experimentally; see also §4.3).

### 4.2 Repair (fix layer)

- Provide a safe auto-fix that rewrites line endings to the policy target. A whole-buffer EOL rewrite does not touch comment structure or field order, so it fits the "safe fix" tier (TextEdit-returned, user-confirmed).
- Ordering when both fixes apply to one file: structural (Front Matter/AST) fixes are computed first, the EOL rewrite runs last, and EOL normalization recomputes the offsets of pending TextEdits so structural ranges stay valid.
- CLI: `mdlineage fix` (EOL normalization is part of the safe-fix set, per `docs/remark-language-server-solution.md` §10.1).

### 4.3 Prevention (guard layer)

- Ship a generated `.gitattributes` recommendation: `mdlineage init` writes `* text=auto eol=lf` (or the configured policy) when the attribute file is missing or silent on the covered paths. When a `.gitattributes` already exists, `init` shows a dry-run diff first and only appends the missing rules; it never rewrites existing lines.
- `mdlineage check` warns when the worktree disagrees with the declared policy, so phantom diffs are caught at authoring time, before review or CI.
- CI gate: verify that `.gitattributes` exists and covers the Markdown paths, and that committed blobs contain no CRLF. Note the limits of the commit-side check: with `text=auto eol=lf` in force, a worktree CRLF edit produces no `git diff` and `git add` stages LF automatically, so CRLF cannot reach a commit while the attributes stay intact. The gate is defense in depth against the attributes being removed or a file being misclassified as binary; worktree-side detection remains the primary catch (see the detection-basis note under §4.1's `--changed` discussion in `docs/remark-language-server-solution.md` §6.4).

### 4.4 Non-goals

- No silent rewriting of files outside the declared policy.
- No automatic reconfiguration of users' global git settings; MDLineage enforces the repository contract and explains how to satisfy it.

## 5. Definition of done

- The `MDL601`/`MDL602` diagnostics exist with fixtures for CRLF, LF, mixed, and CR-only files.
- The safe fix converts a mixed file to policy in one TextEdit pass without altering AST or Front Matter semantics.
- `mdlineage check --changed` catches a CRLF-only change and reports a stable, machine-readable code.
- A phantom-diff reproduction (clone with autocrlf on one platform, status on the other) is part of the test suite, mirroring the incident in Section 1.
