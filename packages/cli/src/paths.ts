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
 *
 * `others` carries the non-Markdown files the scan met (schemas, configs,
 * images): the caller hands their paths to the workspace index as a known-path
 * set, so a link to a real non-Markdown file is not misread as MDL401.
 *
 * `excluded` names the arguments the caller asked for explicitly that the
 * default ignore rules swallowed whole (an argument naming only `node_modules`
 * or `dist` files): `missed` cannot carry those, because the files DO exist —
 * reporting them as missing would be wrong, and validating them would be
 * surprising, so the caller explains on stderr instead.
 */
export function expandMarkdownPaths(
  args: readonly string[],
  cwd: string,
  options: ExpandOptions = {},
): { files: ExpandedPath[]; others: ExpandedPath[]; missed: string[]; excluded: string[] } {
  const ignore = [...DEFAULT_EXCLUDE, ...(options.exclude ?? [])];
  const found = new Map<string, ExpandedPath>();
  const others = new Map<string, ExpandedPath>();
  const missed: string[] = [];
  const excluded: string[] = [];

  for (const arg of args) {
    const absolute = resolve(cwd, arg);
    let stats: ReturnType<typeof statSync>;
    try {
      stats = statSync(absolute);
    } catch {
      // Not a filesystem object: treat it as a glob pattern.
      const matched = globSync([arg], { cwd, ignore, nodir: true, mark: true });
      if (matched.length === 0) {
        // A pattern that matched nothing because it named only ignored paths is
        // worth explaining: the files exist, the ignore rules are why they are
        // absent, and `missed` would say something untrue about them.
        const unfiltered = globSync([arg], { cwd, nodir: true, mark: true });
        if (unfiltered.length > 0) excluded.push(arg);
        else missed.push(arg);
        continue;
      }
      for (const hit of matched) add(found, others, resolve(cwd, hit), arg, cwd);
      continue;
    }

    if (stats.isDirectory()) {
      // A directory means "everything Markdown under it".
      const pattern = `${absolute.split(sep).join('/')}/**/*.md`;
      const matched = globSync([pattern], { cwd, ignore, nodir: true, mark: true });
      for (const hit of matched) add(found, others, resolve(cwd, hit), arg, cwd);
      // Non-Markdown files under the directory are not validated, but their
      // existence matters to the workspace index's known-path set.
      const allPattern = `${absolute.split(sep).join('/')}/**`;
      for (const hit of globSync([allPattern], { cwd, ignore, nodir: true, mark: true })) {
        add(found, others, resolve(cwd, hit), arg, cwd);
      }
      // An empty directory is not an error; it simply has nothing to check. A
      // directory whose Markdown is entirely ignored is the same situation with
      // a different explanation, so it is reported rather than passing silently.
      if (matched.length === 0) {
        const unfiltered = globSync([pattern], { cwd, nodir: true, mark: true });
        if (unfiltered.length > 0) excluded.push(arg);
      }
      continue;
    }

    // An explicitly named file bypasses the ignore list the way `--exclude`
    // patterns do not: naming a path is an override. (A file INSIDE an ignored
    // directory is still excluded, which the directory branch above reports.)
    add(found, others, absolute, arg, cwd);
  }

  const files = [...found.values()].sort((a, b) => a.path.localeCompare(b.path));
  const otherFiles = [...others.values()].sort((a, b) => a.path.localeCompare(b.path));
  return { files, others: otherFiles, missed, excluded };
}

/** Insert one file into the markdown or known-non-markdown map, keeping the first `asGiven`. */
function add(
  found: Map<string, ExpandedPath>,
  others: Map<string, ExpandedPath>,
  absolute: string,
  asGiven: string,
  cwd: string,
): void {
  const target = absolute.toLowerCase().endsWith('.md') ? found : others;
  const key = resolve(absolute);
  if (target.has(key)) return;
  target.set(key, { path: key, asGiven: relativeForReport(key, cwd, asGiven) });
}

/** Prefer the caller's spelling for reporting; fall back to the absolute path. */
function relativeForReport(absolute: string, cwd: string, asGiven: string): string {
  const root = resolve(cwd);
  if (absolute === root) return asGiven;
  if (absolute.startsWith(root + sep)) return absolute.slice(root.length + 1);
  return asGiven;
}

/**
 * Non-Markdown workspace files, cwd-relative: the known-path set MDL401
 * resolves against. "Does this target exist in the workspace?" is not scoped to
 * the validation arguments, so the whole tree is listed even when only a
 * subtree is checked. Markdown files are deliberately absent — a missing
 * document must stay MDL401 even when the run's scope excludes it.
 */
export function knownNonMarkdownPaths(cwd: string, options: ExpandOptions = {}): string[] {
  const ignore = [...DEFAULT_EXCLUDE, ...(options.exclude ?? [])];
  const hits = globSync(['**/*'], { cwd, ignore, nodir: true, mark: true });
  const out: string[] = [];
  for (const hit of hits) {
    const posix = hit.split(sep).join('/');
    if (posix.toLowerCase().endsWith('.md')) continue;
    out.push(posix);
  }
  return out.sort();
}
