/**
 * Path filtering and discovery rules for MDLineage.
 *
 * Implements:
 * - Built-in exclusions: node_modules, dist, vendor
 * - Rule compilation from config.files.exclude, config.files.include, CLI --exclude
 * - Negation rules prefixed with `!` (e.g., `!archive/important.md`)
 * - Pull-back / inclusion of literal paths configured in config.files.include
 * - Decision predicates: inUniverse, inReportSet, excludedByRules, hardPrunePatterns
 */

import { minimatch } from 'minimatch';
import type { Config } from './config.js';

export const BUILTIN_EXCLUDE_GLOBS = [
  '**/node_modules/**',
  '**/dist/**',
  '**/vendor/**',
] as const;

/** Where a compiled exclude rule came from, so the CLI can name the real source. */
export type RuleOrigin = 'default' | 'config' | 'cli';

export interface CompiledRule {
  readonly pattern: string;
  readonly negate: boolean;
  /** default = built-in black holes, config = files.exclude, cli = --exclude. */
  readonly origin: RuleOrigin;
}

/** The rule that decided a path is excluded, for attribution in the CLI. */
export interface ExclusionMatch {
  readonly origin: RuleOrigin;
  readonly pattern: string;
}

export interface PathFilterOptions {
  readonly config?: Config;
  readonly extraExclude?: readonly string[];
}

/** Check if a glob pattern is a literal path (contains no glob magic `*?[]{}`). */
export function isLiteralPath(pattern: string): boolean {
  return !/[*?[\]{}]/.test(pattern);
}

/** Normalize path for pattern matching (strip leading ./, convert backslashes). */
export function normalizeFilterPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * Compile rules from built-in excludes, config excludes, and extra CLI excludes.
 * Supports `!` prefix for negation.
 */
export function compileRules(
  configExclude: readonly string[] = BUILTIN_EXCLUDE_GLOBS,
  extraExclude: readonly string[] = [],
  origin: RuleOrigin = 'config',
  extraOrigin: RuleOrigin = 'cli',
): CompiledRule[] {
  const combined: Array<{ raw: string; origin: RuleOrigin }> = [
    ...configExclude.map((raw) => ({ raw, origin })),
    ...extraExclude.map((raw) => ({ raw, origin: extraOrigin })),
  ];
  const rules: CompiledRule[] = [];

  for (const { raw, origin: ruleOrigin } of combined) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('!')) {
      rules.push({
        pattern: trimmed.slice(1).replace(/^\.\//, ''),
        negate: true,
        origin: ruleOrigin,
      });
    } else {
      rules.push({
        pattern: trimmed.replace(/^\.\//, ''),
        negate: false,
        origin: ruleOrigin,
      });
    }
  }

  return rules;
}

/** Order-insensitive comparison of two pattern lists. */
function samePatterns(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const setB = new Set(b);
  return a.every((p) => setB.has(p));
}

/**
 * The rule that last decided a path, or null when the path is not excluded.
 * Negations clear the match, mirroring `excludedByRules`' last-match-wins.
 */
export function exclusionMatch(path: string, rules: readonly CompiledRule[]): ExclusionMatch | null {
  let match: ExclusionMatch | null = null;
  for (const rule of rules) {
    if (!matchesPattern(path, rule.pattern)) continue;
    match = rule.negate ? null : { origin: rule.origin, pattern: rule.pattern };
  }
  return match;
}

function matchOne(normalized: string, pattern: string): boolean {
  const trimmed = normalized.endsWith('/') && normalized.length > 1 ? normalized.slice(0, -1) : normalized;
  const withSlash = trimmed + '/';

  const opts = { dot: true };
  if (minimatch(trimmed, pattern, opts) || minimatch(withSlash, pattern, opts)) {
    return true;
  }

  // Handle patterns without glob stars matching as prefix or exact
  if (!pattern.includes('*')) {
    const cleanPat = pattern.endsWith('/') ? pattern.slice(0, -1) : pattern;
    if (trimmed === cleanPat || trimmed.startsWith(cleanPat + '/')) {
      return true;
    }
  }

  return false;
}

/** Match a single path against a glob pattern, handling directory and file variations. */
export function matchesPattern(path: string, pattern: string): boolean {
  const normalized = normalizeFilterPath(path);
  if (matchOne(normalized, pattern)) {
    return true;
  }
  const stripped = normalized.replace(/^(?:\.\.\/)+/, '');
  if (stripped !== normalized && matchOne(stripped, pattern)) {
    return true;
  }
  return false;
}

/**
 * Check if a path is excluded by compiled rules using last-match-wins.
 * Returns true if excluded, false if included/not excluded.
 */
export function excludedByRules(path: string, rules: readonly CompiledRule[]): boolean {
  let excluded = false;
  for (const rule of rules) {
    if (matchesPattern(path, rule.pattern)) {
      excluded = !rule.negate;
    }
  }
  return excluded;
}

/**
 * Check if a path is pulled back by a negation rule (!pattern) using last-match-wins.
 * Returns true if the last matching rule has negate: true, false otherwise.
 */
export function isPulledBackByNegation(path: string, rules: readonly CompiledRule[]): boolean {
  let matched = false;
  let lastIsNegate = false;
  for (const rule of rules) {
    if (matchesPattern(path, rule.pattern)) {
      matched = true;
      lastIsNegate = rule.negate;
    }
  }
  return matched && lastIsNegate;
}

/**
 * Decision maker for path filtering and workspace inclusion.
 */
export class PathFilter {
  readonly rules: readonly CompiledRule[];
  /**
   * Rules for the LINK universe (MDL401 existence checks).
   *
   * The report set answers "should this document be validated"; the link
   * universe answers "does this path exist". Conflating them made a link into
   * a `files.exclude` directory report "target does not exist" even though the
   * file was on disk. The link universe therefore keeps only the built-in
   * black holes (node_modules/dist/vendor) plus the user's `!` pull-back
   * rules, so an explicit negation can still re-admit a path inside one.
   */
  private readonly linkRules: readonly CompiledRule[];
  readonly literalIncludes: ReadonlySet<string>;
  readonly hasIncludeRules: boolean;
  readonly includePatterns: readonly string[];

  constructor(options: PathFilterOptions = {}) {
    const config = options.config;
    const configExclude = config?.files?.exclude ?? BUILTIN_EXCLUDE_GLOBS;
    const extraExclude = options.extraExclude ?? [];
    // A config that inherits (or restates) the built-in list has not declared
    // an exclude of its own, so the CLI must keep calling it the default list.
    const declaredByUser = !samePatterns(configExclude, BUILTIN_EXCLUDE_GLOBS);
    const ruleOrigin: RuleOrigin = declaredByUser ? 'config' : 'default';
    this.rules = compileRules(configExclude, extraExclude, ruleOrigin);
    // Only negations survive from the user's rules: a positive exclude says
    // "do not validate", never "does not exist".
    const userNegations = [...configExclude, ...extraExclude].filter((raw) => raw.trim().startsWith('!'));
    this.linkRules = compileRules([...BUILTIN_EXCLUDE_GLOBS, ...userNegations]);

    const literalSet = new Set<string>();
    const includePats: string[] = [];
    if (config?.files?.include) {
      for (const pat of config.files.include) {
        includePats.push(pat);
        if (isLiteralPath(pat)) {
          literalSet.add(normalizeFilterPath(pat));
        }
      }
    }
    this.literalIncludes = literalSet;
    this.includePatterns = includePats;
    this.hasIncludeRules = includePats.length > 0;
  }

  /**
   * Check if a path is pulled back by a literal include configuration.
   * This is a top-priority whitelist.
   */
  isLiteralInclude(path: string): boolean {
    const normalized = normalizeFilterPath(path);
    return this.literalIncludes.has(normalized);
  }

  /**
   * Check if a path is pulled back by a negation rule.
   */
  isPulledBackByNegation(path: string): boolean {
    return isPulledBackByNegation(path, this.rules);
  }

  /**
   * Determine whether a path belongs to the universe (known paths).
   * Literal includes are always kept. Otherwise, excludedByRules applies.
   */
  inUniverse(path: string): boolean {
    if (this.isLiteralInclude(path)) return true;
    return !excludedByRules(path, this.rules);
  }

  /** Which rule excluded this path, for the CLI's attribution message. */
  exclusionMatch(path: string): ExclusionMatch | null {
    return exclusionMatch(path, this.rules);
  }

  /**
   * Determine whether a path exists for the purpose of link resolution
   * (MDL401/402/404).
   *
   * A path excluded from VALIDATION still exists. Only the built-in black holes
   * are treated as nonexistent — they are build/vendor output, not workspace
   * content — and a literal include or `!` negation still pulls them back.
   */
  inLinkUniverse(path: string): boolean {
    if (this.isLiteralInclude(path)) return true;
    return !excludedByRules(path, this.linkRules);
  }

  /**
   * Patterns safe to prune while collecting the link universe: the built-in
   * black holes only. Pruning a user exclude here is what made the link scan
   * blind to real files under `private/`, `papers/` and friends.
   */
  linkHardPrunePatterns(): string[] {
    const out: string[] = [];
    for (const pattern of BUILTIN_EXCLUDE_GLOBS) {
      if (this.hasLinkPruneConflict(pattern)) continue;
      out.push(pattern);
    }
    return out;
  }

  private hasLinkPruneConflict(excludePattern: string): boolean {
    for (const rule of this.linkRules) {
      if (rule.negate && matchesPattern(rule.pattern, excludePattern)) return true;
    }
    for (const lit of this.literalIncludes) {
      if (matchesPattern(lit, excludePattern)) return true;
    }
    return false;
  }

  /**
   * Determine whether a Markdown path belongs to the report set (to be validated).
   * Literal includes are always validated.
   * Otherwise, if excluded by rules, false.
   * If include patterns are specified, it must match at least one include pattern.
   */
  inReportSet(path: string): boolean {
    if (this.isLiteralInclude(path)) return true;
    if (excludedByRules(path, this.rules)) return false;
    if (!this.hasIncludeRules) return true;

    const normalized = normalizeFilterPath(path);
    return this.includePatterns.some((pattern) => matchesPattern(normalized, pattern));
  }

  /**
   * Patterns that can be safely passed to glob's `ignore` parameter to hard-prune
   * directories during traversal without accidentally skipping negation rules
   * or literal includes.
   */
  hardPrunePatterns(): string[] {
    const out: string[] = [];
    for (const rule of this.rules) {
      if (rule.negate) continue;
      // If any literal include or negation rule might match inside this pattern, don't hard-prune
      const hasConflict = this.hasPruneConflict(rule.pattern);
      if (!hasConflict) {
        out.push(rule.pattern);
      }
    }
    return out;
  }

  private hasPruneConflict(excludePattern: string): boolean {
    // Check against negation rules
    for (const rule of this.rules) {
      if (rule.negate && matchesPattern(rule.pattern, excludePattern)) {
        return true;
      }
    }
    // Check against literal includes
    for (const lit of this.literalIncludes) {
      if (matchesPattern(lit, excludePattern)) {
        return true;
      }
    }
    return false;
  }
}
