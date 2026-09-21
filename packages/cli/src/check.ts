/**
 * `mdlineage check` (docs/remark-language-server-solution.md §6.4, §11).
 *
 * Runs the validator over a set of files and renders the result as text or
 * JSON. The JSON shape is the machine-readable contract the LLM loop in §11
 * consumes; the text shape follows the `path:line:col CODE SEVERITY message`
 * convention that editors and humans both read.
 */

import { readFileSync } from 'node:fs';
import { validateDocumentSync, loadConfig, type Config, type Diagnostic } from '@mdlineage/validator';
import type { ExpandedPath } from './paths.js';

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
}

export interface CheckOptions {
  format?: 'text' | 'json';
  configFile?: string;
  cwd: string;
  /** Extra exclude patterns for path expansion. */
  exclude?: readonly string[];
}

/**
 * The exit code contract.
 *
 * 1 — an error-severity diagnostic, an unreadable file, or an error-severity
 *     config diagnostic: all three mean the run found a real problem.
 * 2 — reserved for usage errors (reported by the argument parser).
 */
export function exitCodeFor(result: CheckResult): number {
  if (result.errors > 0) return 1;
  if (result.unreadable.length > 0) return 1;
  if (result.configDiagnostics.some((d) => d.severity === 'error')) return 1;
  return 0;
}

/** Load config once per run, keeping its diagnostics out of every file report. */
function loadRunConfig(configFile: string | undefined): { config: Config; diagnostics: ConfigDiagnosticReport[] } {
  const loaded = loadConfig(configFile);
  return {
    config: loaded.config,
    diagnostics: loaded.diagnostics.map((d) => ({
      code: d.code,
      severity: d.severity,
      message: d.message,
    })),
  };
}

/**
 * Validate `files` (already expanded to absolute Markdown paths). Files are
 * read from disk here because this is the batch/CI channel; the remark plugin
 * owns the unsaved-buffer channel.
 */
export function checkFiles(files: readonly ExpandedPath[], options: CheckOptions): CheckResult {
  const { config, diagnostics: configDiagnostics } = loadRunConfig(options.configFile);
  const reports: FileReport[] = [];
  const unreadable: UnreadableFile[] = [];
  let total = 0;
  let errors = 0;

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
    const result = validateDocumentSync({ path: file.asGiven, content, config });
    const diagnostics = result.diagnostics.map(toJsonDiagnostic);
    reports.push({ path: file.asGiven, diagnostics });
    total += diagnostics.length;
    errors += diagnostics.filter((d) => d.severity === 'error').length;
  }

  return {
    reports,
    total,
    errors,
    warnings: total - errors,
    unreadable,
    configDiagnostics,
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
 * Reports stay the top-level array (the existing contract); `unreadable` and
 * `configDiagnostics` sit beside them so a caller no longer has to infer a
 * permission break or a missing config file from an absent entry.
 */
export function renderJson(result: CheckResult): string {
  return JSON.stringify(
    {
      reports: result.reports,
      unreadable: result.unreadable,
      configDiagnostics: result.configDiagnostics,
    },
    null,
    2,
  );
}
