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
import { resolve, sep, relative, parse } from 'node:path';
import {
  PathFilter,
  type Config,
} from '@mdlineage/validator';
import { gitCheckIgnored, repositoryRoot } from './git.js';

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export interface DiscoveryOptions {
  /** Config loaded for this run. */
  config?: Config;
  /** Extra glob patterns to ignore, in `.gitignore` syntax. */
  exclude?: readonly string[];
  /** When true, ignore `.gitignore` rules (do not filter out git-ignored files). */
  noIgnore?: boolean;
}

/** Backward compatibility alias for ExpandOptions. */
export type ExpandOptions = DiscoveryOptions;

export interface ExpandedPath {
  /** Absolute path of the file. */
  path: string;
  /** The path as given on the command line, for stable reporting. */
  asGiven: string;
}

/**
 * Known workspace paths for link resolution (MDL401/402).
 *
 * Performs a workspace-wide retrieval (`dot: false, mark: true, nodir: false`).
 * Filters out items excluded by PathFilter (unless pulled back).
 * For directories, retains BOTH no-slash and with-slash forms (e.g. `docs/architecture`
 * and `docs/architecture/`).
 * Retains all `.md` files (does NOT skip them!), so cross-file relative references
 * in single-file checks resolve correctly without MDL401 false positives.
 */
export function knownWorkspacePaths(cwd: string, options: DiscoveryOptions = {}): string[] {
  const filter = new PathFilter({ config: options.config, extraExclude: options.exclude });
  const hardPrune = filter.hardPrunePatterns();

  const hits = globSync(['**/*'], {
    cwd,
    ignore: hardPrune,
    nodir: false,
    mark: true,
    dot: false,
  });

  const out = new Set<string>();

  for (const hit of hits) {
    const posix = hit.split(sep).join('/');
    const isDir = posix.endsWith('/');
    const clean = isDir && posix.length > 1 ? posix.slice(0, -1) : posix;

    if (!filter.inUniverse(clean)) {
      continue;
    }

    if (isDir) {
      out.add(clean);
      out.add(clean + '/');
    } else {
      out.add(clean);
    }
  }

  return [...out].sort();
}

/**
 * Backward compatibility: non-Markdown workspace files.
 */
export function knownNonMarkdownPaths(cwd: string, options: DiscoveryOptions = {}): string[] {
  return knownWorkspacePaths(cwd, options).filter((p) => !p.toLowerCase().endsWith('.md'));
}

/**
 * Turn command-line arguments into a de-duplicated, sorted list of Markdown
 * files. A path that does not exist and matches no glob is reported back, so
 * the caller can fail loudly instead of silently validating nothing.
 *
 * `others` carries the non-Markdown files the scan met.
 * `excluded` names arguments whose matches were filtered out.
 */
export function expandMarkdownPaths(
  args: readonly string[],
  cwd: string,
  options: DiscoveryOptions = {},
): { files: ExpandedPath[]; others: ExpandedPath[]; missed: string[]; excluded: string[] } {
  const filter = new PathFilter({ config: options.config, extraExclude: options.exclude });
  const hardPrune = filter.hardPrunePatterns();

  const found = new Map<string, ExpandedPath>();
  const others = new Map<string, ExpandedPath>();
  const missed: string[] = [];
  const excluded: string[] = [];

  for (const arg of args) {
    const absolute = resolve(cwd, arg);
    if (parse(absolute).root === absolute) {
      throw new UsageError(`refusing to scan filesystem root: ${arg}`);
    }
    let stats: ReturnType<typeof statSync>;
    try {
      stats = statSync(absolute);
    } catch {
      // Not a filesystem object: treat it as a glob pattern.
      const matched = globSync([arg], { cwd, ignore: hardPrune, nodir: true, mark: true });
      if (matched.length === 0) {
        const unfiltered = globSync([arg], { cwd, nodir: true, mark: true });
        if (unfiltered.length > 0) excluded.push(arg);
        else missed.push(arg);
        continue;
      }
      for (const hit of matched) {
        const full = resolve(cwd, hit);
        const rel = relativeForReport(full, cwd, hit);
        if (filter.inReportSet(rel)) {
          add(found, others, full, arg, cwd);
        }
      }
      continue;
    }

    if (stats.isDirectory()) {
      const relDir = posixRelative(cwd, absolute);
      const escapes = relDir === '..' || relDir.startsWith('../');
      const globCwd = escapes ? absolute : cwd;
      const mdPattern = escapes ? '**/*.md' : `${relDir === '' ? '.' : relDir}/**/*.md`;
      const allPattern = escapes ? '**' : `${relDir === '' ? '.' : relDir}/**`;
      const ignore = escapes ? hardPrune.filter((p) => p.startsWith('**/')) : hardPrune;

      let addedAny = false;
      for (const hit of globSync([mdPattern], { cwd: globCwd, ignore, nodir: true, mark: true })) {
        const full = resolve(globCwd, hit);
        const rel = posixRelative(cwd, full);
        if (!filter.inReportSet(rel)) continue;
        add(found, others, full, rel, cwd);
        addedAny = true;
      }
      for (const hit of globSync([allPattern], { cwd: globCwd, ignore, nodir: true, mark: true })) {
        const full = resolve(globCwd, hit);
        const rel = posixRelative(cwd, full);
        if (rel.toLowerCase().endsWith('.md')) continue;
        if (!filter.inUniverse(rel)) continue;
        add(found, others, full, rel, cwd);
      }
      if (!addedAny) {
        const unfiltered = globSync([mdPattern], { cwd: globCwd, nodir: true, mark: true });
        if (unfiltered.length > 0) excluded.push(arg);
      }
      continue;
    }

    const rel = relativeForReport(absolute, cwd, arg);
    const isMd = absolute.toLowerCase().endsWith('.md');
    if (isMd ? !filter.inReportSet(rel) : !filter.inUniverse(rel)) {
      if (isMd) excluded.push(arg);
      continue;
    }
    add(found, others, absolute, arg, cwd);
  }

  // Filter git ignored files from found markdown files (report set) if git repo and !noIgnore
  if (!options.noIgnore) {
    const gitRoot = repositoryRoot(cwd);
    if (gitRoot) {
      const allFoundPaths = [...found.values()].map((f) => f.path);
      const ignoredSet = gitCheckIgnored(gitRoot, allFoundPaths);
      if (ignoredSet.size > 0) {
        for (const [key, val] of found.entries()) {
          // git check-ignore might return gitRoot-relative path or absolute path
          const relFromGitRoot = relative(gitRoot, val.path).split(sep).join('/');
          if (ignoredSet.has(val.path) || ignoredSet.has(relFromGitRoot)) {
            // But if user explicitly configured it as literal include or explicitly named it directly in args,
            // check if it was explicitly passed in args
            const explicitlyNamed = args.some((arg) => resolve(cwd, arg) === val.path);
            const reportPath = relativeForReport(val.path, cwd, val.asGiven);
            const isLit = filter.isLiteralInclude(reportPath);
            const isNegated = filter.isPulledBackByNegation(reportPath) || filter.isPulledBackByNegation(relFromGitRoot);
            if (!explicitlyNamed && !isLit && !isNegated) {
              found.delete(key);
            }
          }
        }
      }
    }
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

function posixRelative(from: string, to: string): string {
  const rel = relative(resolve(from), resolve(to));
  return rel === '' ? '.' : rel.split(sep).join('/');
}

function relativeForReport(absolute: string, cwd: string, asGiven: string): string {
  const root = resolve(cwd);
  if (absolute === root) return asGiven;
  if (absolute.startsWith(root + sep)) return absolute.slice(root.length + 1).split(sep).join('/');
  if (resolve(root, asGiven) === absolute) return asGiven.split(sep).join('/');
  return posixRelative(root, absolute);
}
