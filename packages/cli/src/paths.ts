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
  type RuleOrigin,
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
  // The link universe prunes only the built-in black holes: a user exclude
  // means "do not validate", not "does not exist".
  const hardPrune = filter.linkHardPrunePatterns();
  const follow = options.config?.files.followSymlinks ?? true;

  const hits = globSync(['**/*'], {
    cwd,
    ignore: hardPrune,
    nodir: false,
    mark: true,
    dot: false,
    follow,
  });

  const out = new Set<string>();

  for (const hit of hits) {
    const posix = hit.split(sep).join('/');
    const isDir = posix.endsWith('/');
    const clean = isDir && posix.length > 1 ? posix.slice(0, -1) : posix;

    if (!filter.inLinkUniverse(clean)) {
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
export interface ExcludedArg {
  /** The argument as the caller spelled it. */
  readonly arg: string;
  /** Why nothing was validated: a rule source, or an include-pattern miss. */
  readonly origin: RuleOrigin | 'include';
  /** The pattern that decided it, when a rule did. */
  readonly pattern?: string;
}

/**
 * The one place an excluded argument is explained.
 *
 * Naming the wrong source is worse than naming none: a caller who sees
 * "default exclude list" for their own `files.exclude` goes looking in the
 * wrong file. `check` and `fix` share this text so the two cannot drift.
 */
export function formatExcludedMessage(
  path: string,
  origin: ExcludedArg['origin'],
  verb: 'checked' | 'fixed' = 'checked',
): string {
  const suffix = `no files were ${verb}`;
  switch (origin) {
    case 'default':
      return `mdlineage: ${path} matches the default exclude list (node_modules, dist, vendor); ${suffix}`;
    case 'config':
      return `mdlineage: ${path} matches files.exclude in config; ${suffix}`;
    case 'cli':
      return `mdlineage: ${path} matches --exclude; ${suffix}`;
    case 'include':
      return `mdlineage: ${path} matches no files.include pattern; ${suffix}`;
  }
}

export function expandMarkdownPaths(
  args: readonly string[],
  cwd: string,
  options: DiscoveryOptions = {},
): { files: ExpandedPath[]; others: ExpandedPath[]; missed: string[]; excluded: ExcludedArg[] } {
  const filter = new PathFilter({ config: options.config, extraExclude: options.exclude });
  const hardPrune = filter.hardPrunePatterns();
  // The link scan must reach real files under a user exclude; only the
  // built-in black holes are pruned.
  const linkPrune = filter.linkHardPrunePatterns();

  const found = new Map<string, ExpandedPath>();
  const others = new Map<string, ExpandedPath>();
  const missed: string[] = [];
  const excluded: ExcludedArg[] = [];

  /** Attribute a filtered path to the rule that removed it (or to include). */
  const explain = (rel: string): { origin: ExcludedArg['origin']; pattern?: string } => {
    const hit = filter.exclusionMatch(rel);
    return hit ? { origin: hit.origin, pattern: hit.pattern } : { origin: 'include' };
  };

  for (const arg of args) {
    const absolute = resolve(cwd, arg);
    if (parse(absolute).root === absolute) {
      throw new UsageError(`refusing to scan filesystem root: ${arg}`);
    }
    let stats: ReturnType<typeof statSync>;
    try {
      stats = statSync(absolute);
    } catch {
      // Windows users pass backslash patterns; glob only understands '/'.
      const pattern = /\\/.test(arg) ? arg.replace(/\\/g, '/') : arg;
      // Not a filesystem object: treat it as a glob pattern.
      const matched = globSync([pattern], { cwd, ignore: hardPrune, nodir: true, mark: true });
      if (matched.length === 0) {
        const unfiltered = globSync([pattern], { cwd, nodir: true, mark: true });
        if (unfiltered.length > 0) {
          const first = unfiltered[0];
          const firstRel =
            first === undefined ? arg : relativeForReport(resolve(cwd, first), cwd, first);
          excluded.push({ arg, ...explain(firstRel) });
        } else {
          missed.push(arg);
        }
        continue;
      }
      for (const hit of matched) {
        const full = resolve(cwd, hit);
        const rel = relativeForReport(full, cwd, hit);
        const isMd = full.toLowerCase().endsWith('.md');
        if (isMd ? !filter.inReportSet(rel) : !filter.inLinkUniverse(rel)) continue;
        // Key on the individual hit: the shared glob arg would collapse
        // every match into one map entry.
        add(found, others, full, hit, cwd);
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
      const follow = options.config?.files.followSymlinks ?? true;

      let addedAny = false;
      for (const hit of globSync([mdPattern], { cwd: globCwd, ignore, nodir: true, mark: true, follow })) {
        const full = resolve(globCwd, hit);
        const rel = posixRelative(cwd, full);
        if (!filter.inReportSet(rel)) continue;
        add(found, others, full, rel, cwd, rel);
        addedAny = true;
      }
      for (const hit of globSync([allPattern], { cwd: globCwd, ignore: linkPrune, nodir: true, mark: true, follow })) {
        const full = resolve(globCwd, hit);
        const rel = posixRelative(cwd, full);
        if (rel.toLowerCase().endsWith('.md')) continue;
        if (!filter.inLinkUniverse(rel)) continue;
        add(found, others, full, rel, cwd, rel);
      }
      if (!addedAny) {
        const unfiltered = globSync([mdPattern], { cwd: globCwd, nodir: true, mark: true, follow });
        if (unfiltered.length > 0) {
          const first = unfiltered[0];
          const firstRel = first === undefined ? relDir : posixRelative(cwd, resolve(globCwd, first));
          const dirHit = filter.exclusionMatch(relDir);
          excluded.push({ arg, ...(dirHit ? { origin: dirHit.origin, pattern: dirHit.pattern } : explain(firstRel)) });
        }
      }
      continue;
    }

    const rel = relativeForReport(absolute, cwd, arg);
    const isMd = absolute.toLowerCase().endsWith('.md');
    if (isMd ? !filter.inReportSet(rel) : !filter.inLinkUniverse(rel)) {
      if (isMd) excluded.push({ arg, ...explain(rel) });
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
  logicalKey?: string,
): void {
  const target = absolute.toLowerCase().endsWith('.md') ? found : others;
  const key = logicalKey ?? asGiven ?? resolve(absolute);
  if (target.has(key)) return;
  target.set(key, { path: resolve(absolute), asGiven: relativeForReport(resolve(absolute), cwd, asGiven) });
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
