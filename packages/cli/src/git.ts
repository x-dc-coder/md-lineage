/**
 * Changed-file detection (docs/remark-language-server-solution.md §6.4,
 * docs/line-ending-management.md §4.1).
 *
 * The basis is `git status --porcelain` plus a worktree byte scan, never
 * `git diff` or staged blobs: under an active `* text=auto eol=lf` attribute a
 * CRLF-only worktree edit produces an *empty* diff while `git status` still
 * reports the file as modified, so a diff-based implementation would silently
 * miss exactly the class of error MDL602 exists to catch. Verified in the
 * round-1 review (docs/reviews/2026-09-21-round1-adjudication.md, experiment 2).
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Normalized status of one path, as `git status --porcelain` reports it. */
export interface GitStatus {
  /** "XY" status codes, e.g. `' M'`, `'??'`, `'A '`, `'D '`, `'R '`. */
  code: string;
  /** Path relative to the repository root, as git prints it. */
  path: string;
}

export interface ChangedOptions {
  /** Include untracked files (default: true, since they are new documents). */
  untracked?: boolean;
}

/** Run `git status --porcelain` in `cwd` and parse the result. Never throws. */
export function gitStatus(cwd: string): { statuses: GitStatus[]; error: string | null } {
  const result = spawnSync('git', ['status', '--porcelain', '-uall', '-z'], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  });

  if (result.error || result.status !== 0) {
    const message = result.error?.message ?? `git status failed with exit code ${result.status}`;
    return { statuses: [], error: message };
  }

  // An empty worktree is the success case, not a failure: `-z` prints nothing
  // when nothing changed.
  return { statuses: parsePorcelain(result.stdout ?? ''), error: null };
}

/**
 * Parse `git status --porcelain -z` output: records are "XY\0path\0" with an
 * extra "origPath\0" for renames and copies.
 */
export function parsePorcelain(stdout: string): GitStatus[] {
  const out: GitStatus[] = [];
  const tokens = stdout.split('\0');
  for (let i = 0; i < tokens.length - 1; i++) {
    const token = tokens[i]!;
    if (token.length < 3) continue;
    const code = token.slice(0, 2);
    const path = token.slice(3);
    if (!path) continue;
    out.push({ code, path });
    // R and C statuses carry a second field: the original path.
    if (code[0] === 'R' || code[0] === 'C') i += 1;
  }
  return out;
}

/** Filter git statuses down to Markdown files this run should validate. */
export function changedMarkdownFiles(
  statuses: readonly GitStatus[],
  root: string,
  options: ChangedOptions = {},
): { paths: string[]; skipped: number } {
  const untracked = options.untracked ?? true;
  const paths: string[] = [];
  let skipped = 0;

  for (const status of statuses) {
    if (!status.path.toLowerCase().endsWith('.md')) continue;
    // Deleted files have no worktree bytes to scan; their readers are reported
    // by the workspace layer (M2), not here.
    if (status.code[1] === 'D' || status.code[0] === 'D') {
      skipped++;
      continue;
    }
    if (!untracked && status.code === '??') {
      skipped++;
      continue;
    }
    paths.push(resolve(root, status.path));
  }

  return { paths: [...new Set(paths)].sort(), skipped };
}

/**
 * The byte scan that makes EOL-only edits visible: `git status` says a file
 * changed, and this reads what the worktree actually holds (never the index).
 */
export function readWorktree(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** Absolute repository root, or null when `cwd` is outside any repository. */
export function repositoryRoot(cwd: string): string | null {
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) return null;
  return result.stdout.trim() || null;
}
