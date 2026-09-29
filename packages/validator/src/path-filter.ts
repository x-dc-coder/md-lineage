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

export interface CompiledRule {
  readonly pattern: string;
  readonly negate: boolean;
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
): CompiledRule[] {
  const combined = [...configExclude, ...extraExclude];
  const rules: CompiledRule[] = [];

  for (const raw of combined) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('!')) {
      rules.push({
        pattern: trimmed.slice(1).replace(/^\.\//, ''),
        negate: true,
      });
    } else {
      rules.push({
        pattern: trimmed.replace(/^\.\//, ''),
        negate: false,
      });
    }
  }

  return rules;
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
  readonly literalIncludes: ReadonlySet<string>;
  readonly hasIncludeRules: boolean;
  readonly includePatterns: readonly string[];

  constructor(options: PathFilterOptions = {}) {
    const config = options.config;
    const configExclude = config?.files?.exclude ?? BUILTIN_EXCLUDE_GLOBS;
    this.rules = compileRules(configExclude, options.extraExclude ?? []);

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
