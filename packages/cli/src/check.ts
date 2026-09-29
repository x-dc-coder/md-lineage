/**
 * `mdlineage check` (docs/remark-language-server-solution.md §6.4, §11, §16 M2).
 *
 * Two validation passes used to run separately: each file got its own
 * single-document run, and cross-file rules did not exist. M2 merges them into
 * one workspace pass: the index parses every document once, keeps the
 * single-document diagnostics it already computed, and the workspace layer adds
 * the cross-file codes on top. `--no-incremental` keeps the old independent
 * per-file mode available for comparison and for hosts that want a file's
 * report to never mention another file's name.
 *
 * JSON shape is the machine-readable contract the §11 agent loop consumes; the
 * text shape follows `path:line:col CODE SEVERITY message`, which editors and
 * humans both read; SARIF is the CI/code-scanning channel.
 */

import { readFileSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';
import {
  validateDocumentSync,
  loadConfig,
  createWorkspaceIndex,
  validateWorkspace,
  gitClocksForIndex,
  diffAgainstBaseline,
  type Config,
  type Diagnostic,
  type WorkspaceDiagnostic,
} from '@mdlineage/validator';
import type { ExpandedPath } from './paths.js';
import { knownWorkspacePaths } from './paths.js';
import { baselineRoot, loadBaseline, type LoadedBaseline } from './baseline.js';

/** A report entry per file: the JSON output unit. */
export interface FileReport {
  path: string;
  diagnostics: Array<{
    code: string;
    severity: string;
    message: string;
    line: number;
    column: number;
    endLine: number;
    endColumn: number;
    offset: number;
    layer: string;
    data?: Record<string, unknown>;
  }>;
}

/** A file the run could not open. Surfaces as a diagnostic-level problem. */
export interface UnreadableFile {
  path: string;
  message: string;
}

/** A config diagnostic in the shape the JSON output carries. */
export interface ConfigDiagnosticReport {
  code: string;
  severity: string;
  message: string;
}

/**
 * Run-level totals, optional so the JSON contract stays additive: a caller
 * written against the M1 shape still finds `reports`, `unreadable` and
 * `configDiagnostics` where it left them.
 */
export interface RunSummary {
  /** Files successfully validated (unreadable files are not counted). */
  files: number;
  /** Error-severity diagnostics. */
  errors: number;
  /** Warning-severity diagnostics. */
  warnings: number;
  /** Information and hint diagnostics, reported separately from warnings. */
  information: number;
  /** Unreadable files, which the exit-code contract counts as errors. */
  unreadable: number;
  /** Diagnostics per MDL code, sorted by code. */
  byCode: Array<{ code: string; count: number }>;
}

export interface CheckResult {
  reports: FileReport[];
  /** Total diagnostics, all severities. */
  total: number;
  /** Diagnostics whose severity is `error`. */
  errors: number;
  /** Non-error diagnostics. */
  warnings: number;
  /** Files that could not be read. Counted as errors: a run that cannot open
   *  its inputs has not validated them. */
  unreadable: UnreadableFile[];
  /** Config load diagnostics (MDL900-style), reported once for the run. */
  configDiagnostics: ConfigDiagnosticReport[];
  /** The config file the run used, for SARIF's artifact location. */
  configPath: string | null;
  /** Whether a baseline was applied and which file it came from. */
  baseline: { path: string; suppressed: number } | null;
  /** Run totals. Omitted in the legacy JSON shape, present in `--format json`. */
  summary?: RunSummary;
}

export interface CheckOptions {
  format?: 'text' | 'json' | 'sarif';
  configFile?: string;
  /** Preloaded config to avoid duplicate loading. */
  preloadedConfig?: { config: Config; diagnostics: any[]; path: string | null };
  /** Absolute directory the baseline file is searched from. */
  baselineRoot?: string;
  /** True to ignore a committed baseline and report every diagnostic. */
  noBaseline?: boolean;
  /**
   * False to skip the workspace pass and validate each file independently.
   *
   * `check` stays a per-path report either way: when a caller asks for `docs/`
   * the workspace pass cross-checks exactly those files, which is the point of
   * a directory argument in a repository-aware tool. The flag exists for the
   * comparison run and for hosts that need a file's report to be a function of
   * that file alone.
   */
  incremental?: boolean;
  /** True to make any diagnostic — including warnings — fail the run. */
  frail?: boolean;
  /** Absolute directory the config file is searched from. */
  cwd: string;
  /** Extra exclude patterns for path expansion. */
  exclude?: readonly string[];
}

/**
 * The exit code contract.
 *
 * 0 — no error-severity diagnostic, no unreadable file, no error-severity config
 *     diagnostic. Warnings pass; making them fail is `--frail`'s job.
 * 1 — any of the above, or (under `--frail`) any diagnostic at all.
 * 2 — reserved for usage errors (reported by the argument parser).
 */
export function exitCodeFor(result: CheckResult, options: { frail?: boolean } = {}): number {
  if (result.errors > 0) return 1;
  if (result.unreadable.length > 0) return 1;
  if (result.configDiagnostics.some((d) => d.severity === 'error')) return 1;
  if (options.frail && (result.total > 0 || result.unreadable.length > 0 || result.configDiagnostics.length > 0)) {
    return 1;
  }
  return 0;
}

/**
 * Validate `files` (already expanded to absolute Markdown paths). Files are
 * read from disk here because this is the batch/CI channel; the remark plugin
 * owns the unsaved-buffer channel.
 *
 * The workspace pass builds one index over every readable file, so a document's
 * report can carry cross-file codes (MDL301/302/304/305/401/402). The index
 * already ran the single-document pipeline per file, so nothing is parsed
 * twice in this mode.
 */
export async function checkFiles(
  files: readonly ExpandedPath[],
  options: CheckOptions,
  others: readonly ExpandedPath[] = [],
): Promise<CheckResult> {
  const { config, diagnostics: configDiagnostics, path: configPath } =
    options.preloadedConfig ?? loadRunConfig(options.configFile, options.cwd);
  const incremental = options.incremental ?? true;
  const reports: FileReport[] = [];
  const unreadable: UnreadableFile[] = [];

  // The index only sees readable files, so its paths must line up with the
  // reports the caller reads: `asGiven` is the reporting key.
  const indexFiles = new Map<string, string>();
  const read = new Map<string, string>();
  for (const file of files) {
    let content: string;
    try {
      content = readFileSync(file.path, 'utf8');
    } catch (error) {
      // An unreadable file is reported as MDL900 (the config/internal block):
      // it is not a document problem, but the run did not validate the file,
      // and silence would let a permission break look like a clean pass.
      unreadable.push({ path: file.asGiven, message: errorMessage(error) });
      continue;
    }
    read.set(file.asGiven, content);
    indexFiles.set(file.asGiven, content);
  }

  if (incremental) {
    // Known paths use the same reporting vocabulary as the index keys (`asGiven`):
    // the scan's non-Markdown files plus the cwd-wide list, so MDL401 judges
    // existence in the workspace rather than in the run's arguments.
    // knownWorkspacePaths also includes sibling markdown files and directories.
    const knownPaths = new Set(others.map((file) => file.asGiven));
    for (const path of knownWorkspacePaths(options.cwd, { config, exclude: options.exclude })) {
      knownPaths.add(path);
    }
    const index = createWorkspaceIndex(indexFiles, config, knownPaths);
    const gitClocks = await gitClocksForIndex(index, options.cwd);
    const baseline = loadRunBaseline(options);
    const all = validateWorkspace(index, { gitClocks });
    // The validator owns the suppression predicate; the CLI only counts what it
    // dropped, so the two cannot drift on what "covered" means. Matching runs in
    // the baseline's own (repo-relative) path vocabulary, then the diagnostics
    // are put back into this run's report spelling.
    const matched = baseline && baseline.loaded.baseline
      ? diffAgainstBaseline(all.map((d) => toBaselineKeyed(d, baseline.anchor, options.cwd)), baseline.loaded.baseline)
      : { reported: all, suppressed: [] as WorkspaceDiagnostic[] };
    const { reported, suppressed } = matched;
    const byPath = groupByPath(withReportPaths(reported, baseline, options.cwd));
    for (const path of read.keys()) {
      reports.push({ path, diagnostics: (byPath.get(path) ?? []).map(toJsonDiagnostic) });
    }
    const result = tally(
      reports,
      unreadable,
      configDiagnostics,
      configPath,
      baseline ? { path: baseline.loaded.path, suppressed: suppressed.length } : null,
    );
    if (baseline?.loaded.error) {
      // A corrupt or unsupported baseline is reported and then ignored: the safe
      // direction is to report everything, which is what no baseline does.
      result.configDiagnostics = [
        ...result.configDiagnostics,
        { code: 'MDL900', severity: 'warning', message: baseline.loaded.error },
      ];
    }
    return result;
  }

  // The non-incremental fallback: one validateDocumentSync per file, no index,
  // no cross-file codes. Kept as the comparison mode and for hosts that want a
  // file's report to depend on nothing but itself.
  for (const [path, content] of read) {
    const result = validateDocumentSync({ path, content, config });
    reports.push({ path, diagnostics: result.diagnostics.map(toJsonDiagnostic) });
  }
  return tally(reports, unreadable, configDiagnostics, configPath, null);
}

/**
 * Load the baseline for a check run, anchored to the repository root.
 *
 * Suppression keys are the paths the baseline file carries, which are relative
 * to the repository root; a run's report paths are relative to the CWD. A check
 * from a subdirectory must still hit the entries a root run does, so matching
 * happens in the baseline's vocabulary and the diagnostics are re-spelled back
 * to the run's own report paths afterwards.
 */
function loadRunBaseline(options: CheckOptions): { loaded: LoadedBaseline; anchor: string } | null {
  if (options.noBaseline) return null;
  const anchor = baselineRoot(options.baselineRoot ?? options.cwd);
  const loaded = loadBaseline(anchor);
  return loaded ? { loaded, anchor } : null;
}

/**
 * The path a diagnostic carries, as the report for THIS run should print it:
 * relative to the CWD the caller named, so `check docs/a.md` and a `check` from
 * `docs/` report the same file the way the caller expects to read it.
 *
 * `path` here is repo-relative (the vocabulary the match ran in); this puts it
 * back into the CWD's terms.
 */
function toReportPath(path: string, anchor: string, cwd: string): string {
  if (!path) return path;
  const absolute = resolve(anchor, path);
  const root = resolve(cwd);
  if (absolute === root) return path;
  if (absolute.startsWith(root + sep)) return absolute.slice(root.length + 1);
  // Above the CWD (`../legacy.md` from a subdirectory): `relative` keeps the
  // spelling the caller named, which is still how the report should read.
  return relative(root, absolute).split(sep).join('/');
}

/** The diagnostics a baseline matched against, with the report spelling restored. */
function withReportPaths(
  all: readonly WorkspaceDiagnostic[],
  baseline: { anchor: string } | null,
  cwd: string,
): WorkspaceDiagnostic[] {
  if (!baseline) return [...all];
  return all.map((diag) => ({ ...diag, path: toReportPath(diag.path, baseline.anchor, cwd) }));
}

/**
 * Re-key a workspace diagnostic onto the baseline's own path vocabulary.
 *
 * Report paths come from the run's expansion roots, which are relative to the
 * CWD, while the baseline's are relative to the repository root. Matching in
 * the CWD's vocabulary would make an exemption depend on where the command was
 * invoked from, so the path is resolved against the CWD FIRST (where the
 * expansion rooted it) and then re-spelled against the anchor.
 */
function toBaselineKeyed(diag: WorkspaceDiagnostic, anchor: string, cwd: string): WorkspaceDiagnostic {
  const key = repoRelativeOf(diag.path, anchor, cwd);
  return key === diag.path ? diag : { ...diag, path: key };
}

/**
 * The repo-relative spelling of a report path, in the POSIX shape the baseline
 * file stores.
 *
 * A report path is relative to the run's CWD (`../legacy.md` from a
 * subdirectory), so it is resolved against the CWD before being re-spelled
 * against the anchor. A path that is already absolute passes through as given,
 * and a path that resolves outside the repository keeps its own spelling,
 * which simply never matches an entry.
 */
function repoRelativeOf(path: string, anchor: string, cwd: string): string {
  if (!path) return path;
  const absolute = resolve(cwd, path);
  const root = resolve(anchor);
  if (!absolute.startsWith(root + sep) && absolute !== root) return path;
  return relative(root, absolute).split(sep).join('/');
}

/** Group workspace diagnostics by the path the index was keyed on. */
function groupByPath(all: readonly WorkspaceDiagnostic[]): Map<string, WorkspaceDiagnostic[]> {
  const out = new Map<string, WorkspaceDiagnostic[]>();
  for (const diag of all) {
    const list = out.get(diag.path);
    if (list) list.push(diag);
    else out.set(diag.path, [diag]);
  }
  return out;
}

/** Assemble the CheckResult totals from the per-file reports. */
function tally(
  reports: FileReport[],
  unreadable: UnreadableFile[],
  configDiagnostics: ConfigDiagnosticReport[],
  configPath: string | null,
  baseline: CheckResult['baseline'],
): CheckResult {
  let total = 0;
  let errors = 0;
  let warnings = 0;
  let information = 0;
  const byCode = new Map<string, number>();
  for (const report of reports) {
    for (const diag of report.diagnostics) {
      total++;
      byCode.set(diag.code, (byCode.get(diag.code) ?? 0) + 1);
      if (diag.severity === 'error') errors++;
      else if (diag.severity === 'warning') warnings++;
      else information++;
    }
  }

  return {
    reports,
    total,
    errors,
    warnings: total - errors,
    unreadable,
    configDiagnostics,
    configPath,
    baseline,
    summary: {
      files: reports.length,
      errors,
      warnings,
      information,
      unreadable: unreadable.length,
      byCode: [...byCode.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([code, count]) => ({ code, count })),
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Validator Diagnostic → the JSON output shape (LSP-flavoured, 1-based). */
function toJsonDiagnostic(diag: Diagnostic): FileReport['diagnostics'][number] {
  return {
    code: diag.code,
    severity: diag.severity,
    message: diag.message,
    line: diag.range.start.line,
    column: diag.range.start.column,
    endLine: diag.range.end.line,
    endColumn: diag.range.end.column,
    offset: diag.range.start.offset,
    layer: diag.layer,
    ...(diag.data ? { data: diag.data } : {}),
  };
}

/** Load config once per run, keeping its diagnostics out of every file report. */
function loadRunConfig(
  configFile: string | undefined,
  cwd: string,
): { config: Config; diagnostics: ConfigDiagnosticReport[]; path: string | null } {
  // An implicit lookup walks up from the CWD; a named file resolves as given.
  const loaded = loadConfig(configFile, configFile ? undefined : cwd);
  return {
    config: loaded.config,
    path: loaded.config.source,
    diagnostics: loaded.diagnostics.map((d) => ({
      code: d.code,
      severity: d.severity,
      message: d.message,
    })),
  };
}

/** Render a run as the human-readable text format. */
export function renderText(result: CheckResult): string {
  const lines: string[] = [];

  for (const diag of result.configDiagnostics) {
    lines.push(`mdlineage.config.yaml:1:1 ${diag.code} ${diag.severity} ${diag.message}`);
  }

  for (const report of result.reports) {
    for (const diag of report.diagnostics) {
      lines.push(`${report.path}:${diag.line}:${diag.column} ${diag.code} ${diag.severity} ${diag.message}`);
    }
  }

  for (const file of result.unreadable) {
    // The position segment is kept, at the file start, so the line format stays
    // parseable by anything that splits on ':'.
    lines.push(`${file.path}:1:1 MDL900 error Could not read file: ${file.message}`);
  }

  const checked = result.reports.length;
  const problems = result.total + result.unreadable.length + result.configDiagnostics.length;
  if (problems === 0) {
    lines.push(`mdlineage: ${checked} file${checked === 1 ? '' : 's'} checked, no diagnostics`);
  } else {
    lines.push(
      `mdlineage: ${checked} file${checked === 1 ? '' : 's'} checked, ` +
        `${result.total} diagnostic${result.total === 1 ? '' : 's'} ` +
        `(${result.errors} error${result.errors === 1 ? '' : 's'}, ${result.warnings} warning${result.warnings === 1 ? '' : 's'}), ` +
        `${result.unreadable.length} unreadable file${result.unreadable.length === 1 ? '' : 's'}` +
        (result.configDiagnostics.length > 0
          ? `, ${result.configDiagnostics.length} config diagnostic${result.configDiagnostics.length === 1 ? '' : 's'}`
          : ''),
    );
  }
  return lines.join('\n');
}

/**
 * Render a run as the JSON the agent loop in §11 consumes.
 *
 * `reports` stays the top-level array (the M1-b contract); `unreadable` and
 * `configDiagnostics` sit beside it so a caller no longer has to infer a
 * permission break or a missing config file from an absent entry. `summary` is
 * new and optional — an M1 consumer parses the document without it.
 */
export function renderJson(result: CheckResult): string {
  return JSON.stringify(
    {
      reports: result.reports,
      unreadable: result.unreadable,
      configDiagnostics: result.configDiagnostics,
      // The machine-readable contract for the debt a run applied: `path` names
      // the baseline file and `suppressed` how many diagnostics it covered, so
      // `--no-baseline` (null) and the default view are distinguishable without
      // inferring one from an absent key.
      baseline: result.baseline,
      summary: result.summary,
    },
    null,
    2,
  );
}
