/**
 * Baseline suppression (docs/progress.md open issue #2 — legacy-repo onboarding).
 *
 * A repository adopting MDLineage mid-flight already has hundreds of documents,
 * many missing metadata, sharing ids, or pointing at targets that no longer
 * exist. Forcing an all-or-nothing cleanup blocks adoption, and turning every
 * pre-existing violation into an error makes CI permanently red — which is how
 * baseline mechanisms die in practice.
 *
 * The baseline records the violations a repository has ACCEPTED, per code and
 * per path, so that:
 *   - accepted violations stay silent and CI stays green;
 *   - a NEW violation (a path the baseline never listed for that code) is
 *     reported normally;
 *   - a FIXED violation's entry goes stale and `pruneBaseline` drops it.
 *
 * Storage is a separate `.mdlineage-baseline.json`. `schemas/` is protected and
 * `mdlineage.config.yaml`'s schema has no key for it, so a baseline cannot
 * silently change rule semantics the way a config key could: it is a record of
 * accepted debt, not a rule configuration.
 *
 * Suppression is total silence, not an information-level notice. A baseline
 * entry is per-code-and-path with no action attached, so a notice would repeat
 * "this is accepted debt" on every such file forever — noise that trains people
 * to ignore the whole report. The debt stays auditable through
 * `writeBaseline`/`pruneBaseline`, whose output diff IS the trail.
 */

/** A baseline document: accepted violations, keyed by code then path. */
export interface Baseline {
  /** Format version; bump only when the file shape changes. */
  readonly version: number;
  /** ISO timestamp of generation, informational only. */
  readonly generatedAt?: string;
  /** Diagnostic codes → paths with an accepted violation of that code. */
  readonly codes: Readonly<Record<string, readonly string[]>>;
}

/** Parsing outcome: a usable baseline, or the reason none is available. */
export interface BaselineParseResult {
  readonly baseline: Baseline | null;
  /** Human-readable reason the input was not usable (never thrown). */
  readonly error: string | null;
}

export const BASELINE_VERSION = 1;
export const BASELINE_FILE_NAME = '.mdlineage-baseline.json';

/**
 * Parse a baseline document. Never throws: a corrupt or truncated file yields
 * `error` and a null baseline, which makes the caller fall back to "report
 * everything" — the safe direction, because a broken exemption file must never
 * become a blanket suppression.
 */
export function parseBaseline(text: string): BaselineParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { baseline: null, error: `not valid JSON: ${messageOf(error)}` };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { baseline: null, error: 'the top-level value must be an object' };
  }

  const obj = parsed as Record<string, unknown>;
  if (obj['version'] !== BASELINE_VERSION) {
    return {
      baseline: null,
      error: `unsupported baseline version ${JSON.stringify(obj['version'])} (expected ${BASELINE_VERSION})`,
    };
  }

  const codes = obj['codes'];
  if (!codes || typeof codes !== 'object' || Array.isArray(codes)) {
    return { baseline: null, error: "the 'codes' key must be an object of code → paths" };
  }

  const normalized: Record<string, string[]> = {};
  for (const [code, paths] of Object.entries(codes as Record<string, unknown>)) {
    if (!Array.isArray(paths)) {
      return { baseline: null, error: `baseline entry for ${code} is not an array of paths` };
    }
    // Non-string entries are dropped rather than fatal: a hand-edited file with
    // one bad row should not disable the whole exemption set.
    const clean = paths.filter((p): p is string => typeof p === 'string' && p.length > 0);
    if (clean.length > 0) normalized[code] = dedupeSorted(clean);
  }

  const generatedAt = typeof obj['generatedAt'] === 'string' ? (obj['generatedAt'] as string) : undefined;

  return { baseline: { version: BASELINE_VERSION, codes: normalized, generatedAt }, error: null };
}

/** True when the baseline accepts a diagnostic of `code` at `path`. */
export function baselineMatches(baseline: Baseline, code: string, path: string): boolean {
  const paths = baseline.codes[code];
  return paths !== undefined && paths.includes(path);
}

/** The (code, path) pair suppression and pruning key on. */
export interface BaselineSuppressed {
  readonly code: string;
  readonly path: string;
}

/** Drop the diagnostics the baseline covers, leaving the rest in order. */
export function suppressWithBaseline<T extends BaselineSuppressed>(diagnostics: readonly T[], baseline: Baseline): T[] {
  return diagnostics.filter((d) => !baselineMatches(baseline, d.code, d.path));
}

/** Split a diagnostic set into what the baseline covers and what it does not. */
export function diffAgainstBaseline<T extends BaselineSuppressed>(
  diagnostics: readonly T[],
  baseline: Baseline,
): { reported: T[]; suppressed: T[] } {
  const reported: T[] = [];
  const suppressed: T[] = [];
  for (const d of diagnostics) {
    if (baselineMatches(baseline, d.code, d.path)) suppressed.push(d);
    else reported.push(d);
  }
  return { reported, suppressed };
}

/**
 * Serialize the baseline for a diagnostic set.
 *
 * `previous` supplies accepted paths whose violations have since disappeared,
 * and those are KEPT: dropping them the moment a diagnostic clears would
 * re-report the violation if it ever returns, and the point of a baseline is a
 * stable audit trail. `pruneBaseline` is the call that removes stale entries.
 *
 * Pure: it returns the file's text. Writing it to disk is the caller's job (the
 * M2-b CLI wraps this in `mdlineage baseline`).
 */
export function writeBaseline(
  diagnostics: readonly BaselineSuppressed[],
  previous: Baseline | null = null,
  generatedAt: string = new Date().toISOString(),
): string {
  const codes: Record<string, Set<string>> = {};

  for (const d of diagnostics) {
    pushPath(codes, d.code, d.path);
  }

  if (previous) {
    for (const [code, paths] of Object.entries(previous.codes)) {
      for (const p of paths) pushPath(codes, code, p);
    }
  }

  const out: Record<string, string[]> = {};
  for (const code of Object.keys(codes).sort()) {
    out[code] = dedupeSorted([...codes[code]!]);
  }

  return (
    JSON.stringify(
      {
        version: BASELINE_VERSION,
        generatedAt,
        codes: out,
      },
      null,
      2,
    ) + '\n'
  );
}

function pushPath(codes: Record<string, Set<string>>, code: string, path: string): void {
  let set = codes[code];
  if (!set) {
    set = new Set();
    codes[code] = set;
  }
  set.add(path);
}

/**
 * Drop baseline entries whose diagnostics no longer exist.
 *
 * The regeneration path for "fix the file, shrink the debt": called with the
 * CURRENT diagnostics, so accepted violations that are still present survive
 * while the fixed ones disappear.
 */
export function pruneBaseline(previous: Baseline, diagnostics: readonly BaselineSuppressed[]): Baseline {
  const live = new Set<string>();
  for (const d of diagnostics) live.add(`${d.code}\u0000${d.path}`);

  const codes: Record<string, string[]> = {};
  for (const [code, paths] of Object.entries(previous.codes)) {
    const kept = paths.filter((p) => live.has(`${code}\u0000${p}`));
    if (kept.length > 0) codes[code] = dedupeSorted(kept);
  }

  return { version: BASELINE_VERSION, codes, generatedAt: previous.generatedAt };
}

/** Sorted, de-duplicated copy: a baseline file must be diff-friendly. */
function dedupeSorted(paths: readonly string[]): string[] {
  return [...new Set(paths)].sort();
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
