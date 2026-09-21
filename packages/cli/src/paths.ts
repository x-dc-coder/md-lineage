/**
 * Path expansion for the CLI (docs/remark-language-server-solution.md §6.4).
 *
 * `glob@10` is already a transitive dependency of the toolchain, so it is used
 * for the pattern work and kept out of the hot validation path. Plain paths and
 * directories are handled without glob magic so `mdlineage check docs` behaves
 * the way `ls`-minded users expect.
 */

import { globSync } from 'glob';
import { statSync } from 'node:fs';
import { resolve, sep } from 'node:path';

/** Patterns excluded unless the caller overrides them with a negative glob. */
const DEFAULT_EXCLUDE = ['node_modules/**', '**/dist/**'];

export interface ExpandOptions {
  /** Extra glob patterns to ignore, in `.gitignore` syntax. */
  exclude?: readonly string[];
}

export interface ExpandedPath {
  /** Absolute path of the file. */
  path: string;
  /** The path as given on the command line, for stable reporting. */
  asGiven: string;
}

/**
 * Turn command-line arguments into a de-duplicated, sorted list of Markdown
 * files. A path that does not exist and matches no glob is reported back, so
 * the caller can fail loudly instead of silently validating nothing.
 */
export function expandMarkdownPaths(
  args: readonly string[],
  cwd: string,
  options: ExpandOptions = {},
): { files: ExpandedPath[]; missed: string[] } {
  const ignore = [...DEFAULT_EXCLUDE, ...(options.exclude ?? [])];
  const found = new Map<string, ExpandedPath>();
  const missed: string[] = [];

  for (const arg of args) {
    const absolute = resolve(cwd, arg);
    let stats: ReturnType<typeof statSync>;
    try {
      stats = statSync(absolute);
    } catch {
      // Not a filesystem object: treat it as a glob pattern.
      const matched = globSync([arg], { cwd, ignore, nodir: true, mark: true });
      if (matched.length === 0) {
        missed.push(arg);
        continue;
      }
      for (const hit of matched) add(found, resolve(cwd, hit), arg, cwd);
      continue;
    }

    if (stats.isDirectory()) {
      // A directory means "everything Markdown under it".
      const pattern = `${absolute.split(sep).join('/')}/**/*.md`;
      const matched = globSync([pattern], { cwd, ignore, nodir: true, mark: true });
      for (const hit of matched) add(found, resolve(cwd, hit), arg, cwd);
      // An empty directory is not an error; it simply has nothing to check.
      continue;
    }

    add(found, absolute, arg, cwd);
  }

  const files = [...found.values()].sort((a, b) => a.path.localeCompare(b.path));
  return { files, missed };
}

/** Insert one file, keeping the first `asGiven` for stable reporting. */
function add(found: Map<string, ExpandedPath>, absolute: string, asGiven: string, cwd: string): void {
  if (!absolute.toLowerCase().endsWith('.md')) return;
  const key = resolve(absolute);
  if (found.has(key)) return;
  found.set(key, { path: key, asGiven: relativeForReport(key, cwd, asGiven) });
}

/** Prefer the caller's spelling for reporting; fall back to the absolute path. */
function relativeForReport(absolute: string, cwd: string, asGiven: string): string {
  const root = resolve(cwd);
  if (absolute === root) return asGiven;
  if (absolute.startsWith(root + sep)) return absolute.slice(root.length + 1);
  return asGiven;
}
