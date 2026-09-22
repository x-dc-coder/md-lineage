/**
 * `mdlineage baseline` (docs/progress.md open issue #2 — legacy-repo onboarding).
 *
 * A baseline records the violations a repository has ACCEPTED, per code and per
 * path, so a repo adopting MDLineage mid-flight can land green and tighten over
 * time instead of failing CI until every legacy document is fixed. The file is
 * committed: it is part of the repository's contract, not a local cache.
 *
 * Three actions:
 *   - `update`  run the full workspace validation and write the merged baseline
 *     (`--report-only` shows what would change without touching the file),
 *   - `show`    the current baseline's per-code statistics,
 *   - `verify`  exit 0 iff the current diagnostics exactly match the baseline:
 *     no new unexempted violation, no stale entry. This is the CI gate.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  loadConfig,
  createWorkspaceIndex,
  validateWorkspace,
  parseBaseline,
  writeBaseline,
  pruneBaseline,
  diffAgainstBaseline,
  BASELINE_FILE_NAME,
  BASELINE_VERSION,
  type Baseline,
  type WorkspaceDiagnostic,
} from '@mdlineage/validator';
import type { ExpandedPath } from './paths.js';
import { expandMarkdownPaths } from './paths.js';
import { repositoryRoot } from './git.js';

/**
 * The directory every baseline action is anchored to.
 *
 * The baseline is part of the repository's contract, so it lives at the
 * repository root and its path keys are relative to it — never to the CWD. A CI
 * job whose working directory is a subdirectory must see the same baseline (and
 * the same graph) the same job sees at the root; anchoring on the CWD would let
 * a subdirectory verify pass because "no baseline here, no violations here".
 * Outside a git repository the CWD stands in, which keeps the pre-fix behaviour
 * for plain directories.
 */
export function baselineRoot(cwd: string): string {
  return repositoryRoot(cwd) ?? cwd;
}

/** Where the baseline lives: the repository root, beside mdlineage.config.yaml. */
function baselinePath(root: string): string {
  return resolve(root, BASELINE_FILE_NAME);
}

/**
 * Read the committed baseline.
 *
 * Never throws. A missing file is the "no exemptions yet" state and returns a
 * null baseline; a corrupt or unsupported file returns its reason, and the
 * caller reports it and falls back to reporting everything — a broken exemption
 * file must never become a blanket suppression.
 */
export interface LoadedBaseline {
  /** The file the read attempted. */
  path: string;
  /** Usable baseline, or null when none exists or none is usable. */
  baseline: Baseline | null;
  /** Why `baseline` is null when it is not simply absent. */
  error: string | null;
}

export function loadBaseline(root: string): LoadedBaseline | null {
  const path = baselinePath(root);
  if (!existsSync(path)) return null;
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    return { path, baseline: null, error: `cannot read ${path}: ${messageOf(error)}` };
  }
  const parsed = parseBaseline(text);
  return { path, baseline: parsed.baseline, error: parsed.error };
}

/** Diagnostics for the whole workspace, with the index that produced them. */
function workspaceDiagnostics(
  files: readonly ExpandedPath[],
  configFile: string | undefined,
  root: string,
): { diagnostics: readonly WorkspaceDiagnostic[]; configError: string | null } {
  const { config, diagnostics: configDiagnostics } = loadConfig(configFile, configFile ? undefined : root);
  const indexFiles = new Map<string, string>();
  for (const file of files) {
    try {
      indexFiles.set(file.asGiven, readFileSync(file.path, 'utf8'));
    } catch {
      // An unreadable file yields no diagnostics of its own here; the check
      // command reports it, and the baseline only records diagnosable debt.
    }
  }
  const index = createWorkspaceIndex(indexFiles, config);
  return {
    diagnostics: validateWorkspace(index),
    configError: configDiagnostics.find((d) => d.severity === 'error')?.message ?? null,
  };
}

/** Expand the workspace for a baseline action: everything Markdown under root. */
function workspaceFiles(root: string, exclude: readonly string[]): ExpandedPath[] {
  return expandMarkdownPaths([root], root, { exclude }).files;
}

export interface BaselineOptions {
  configFile?: string;
  exclude?: readonly string[];
  /** Write nothing; print the change set instead. */
  reportOnly?: boolean;
  /**
   * Write the baseline even when the committed file is corrupt or has an
   * unsupported version. Without it a broken file is reported and left alone,
   * because overwriting it would discard the repository's accepted-debt record
   * with no way back.
   */
  force?: boolean;
}

/** What a `baseline update` would change, so `--report-only` can print it. */
export interface BaselineChangeSet {
  /** Paths newly covered by the baseline (violations present now). */
  added: Array<{ code: string; path: string }>;
  /**
   * Entries that really would disappear from the file. `update` merges rather
   * than prunes, so this is usually empty; a non-empty `removed` means the write
   * genuinely shrank the baseline.
   */
  removed: Array<{ code: string; path: string }>;
  /**
   * Accepted entries whose violation has cleared. `update` keeps them on purpose
   * (the audit trail, and a reintroduced violation must not slip back under a
   * stale exemption), so they are reported under their own marker rather than
   * as deletions — the file still holds every one of them.
   */
  stale: Array<{ code: string; path: string }>;
  /** The text the update would write. */
  text: string;
  /** The file the update would write it to. */
  path: string;
}

/**
 * `mdlineage baseline update`: validate the workspace and merge the current
 * diagnostics with the accepted set.
 *
 * Merging keeps accepted-but-currently-clean entries (the audit trail; removal
 * is `pruneBaseline`'s job, and `stale` reports what a prune would drop) while
 * recording every violation present now. The write is skipped entirely when
 * nothing would change, so a clean re-run touches no file.
 *
 * A baseline that cannot be parsed is never silently rewritten: `writeBaseline`
 * would drop every accepted entry the file carried, so the run reports it and
 * refuses unless `--force` says the loss is intended.
 */
export function updateBaseline(root: string, options: BaselineOptions = {}): BaselineChangeSet & {
  error: string | null;
} {
  const anchor = baselineRoot(root);
  const files = workspaceFiles(anchor, options.exclude ?? []);
  const { diagnostics } = workspaceDiagnostics(files, options.configFile, anchor);
  const previous = loadBaseline(anchor);
  let prior: Baseline | null;
  let error: string | null = null;
  if (previous && (previous.error || !previous.baseline)) {
    // A corrupt or unsupported baseline: report how many accepted entries would
    // be lost and refuse the write unless the caller forced the loss. A broken
    // file is reported, not silently replaced, because `writeBaseline` cannot
    // merge with what it could not read.
    const lost = entryCount(previous.path);
    const reason = previous.error ?? 'unusable file';
    error = `cannot read the committed baseline ${previous.path}: ${reason}`;
    if (!options.force) {
      return {
        added: [],
        removed: [],
        stale: [],
        text: '',
        path: baselinePath(anchor),
        error:
          lost === null
            ? `${error} (accepted exemptions would be discarded; use --force to write anyway)`
            : lost > 0
              ? `${error} (${lost} accepted exemption${lost === 1 ? '' : 's'} would be discarded; use --force to write anyway)`
              : error,
      };
    }
    prior = null;
  } else {
    prior = previous?.baseline ?? null;
  }

  const text = writeBaseline(diagnostics, prior);
  const next = parseBaseline(text).baseline!;

  const added: Array<{ code: string; path: string }> = [];
  for (const [code, paths] of Object.entries(next.codes)) {
    for (const path of paths) {
      if (!prior || !prior.codes[code]?.includes(path)) added.push({ code, path });
    }
  }
  // What actually disappeared from the file: an entry the previous baseline
  // carried that the new text no longer has. `update` merges rather than prunes,
  // so this stays empty unless the write truly shrank the baseline.
  const removed: Array<{ code: string; path: string }> = [];
  for (const [code, paths] of Object.entries(prior?.codes ?? {})) {
    for (const path of paths) {
      if (!next.codes[code]?.includes(path)) removed.push({ code, path });
    }
  }
  // Accepted entries whose violation has cleared. Kept on purpose (the audit
  // trail), and reported under their own marker so a `-` line cannot be read as
  // a deletion the write did not perform.
  const stale: Array<{ code: string; path: string }> = [];
  if (prior) {
    const pruned = pruneBaseline(prior, diagnostics);
    for (const [code, paths] of Object.entries(prior.codes)) {
      for (const path of paths) {
        if (!pruned.codes[code]?.includes(path)) stale.push({ code, path });
      }
    }
  }

  return { added, removed, stale, text, path: baselinePath(anchor), error };
}

/**
 * How many accepted exemptions the committed baseline carries, for the write
 * refusal's warning.
 *
 * A usable file is counted exactly. A file the parser rejects may still have a
 * legible `codes` block — a truncated or hand-edited file often does — and
 * those are the entries the write would discard, so they are counted from the
 * raw shape. `null` means nothing could be counted, in which case the refusal
 * names the unreadable file instead of a number.
 */
function entryCount(path: string): number | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  const parsed = parseBaseline(text);
  if (parsed.baseline) return countEntries(parsed.baseline);

  let probe: { codes?: Record<string, unknown> };
  try {
    probe = JSON.parse(text) as { codes?: Record<string, unknown> };
  } catch {
    return null;
  }
  const codes = probe.codes;
  if (!codes || typeof codes !== 'object' || Array.isArray(codes)) return null;
  let n = 0;
  for (const value of Object.values(codes)) {
    if (Array.isArray(value)) n += value.filter((p): p is string => typeof p === 'string').length;
  }
  return n;
}

/** Count (code, path) pairs in a usable baseline. */
function countEntries(baseline: Baseline): number {
  let n = 0;
  for (const paths of Object.values(baseline.codes)) n += paths.length;
  return n;
}

/** Write a computed change set. Returns what it wrote, or null for a no-op. */
export function writeChangeSet(change: BaselineChangeSet, reportOnly: boolean): string | null {
  if (change.added.length === 0 && change.removed.length === 0 && change.stale.length === 0) return null;
  if (reportOnly) return null;
  writeFileSync(change.path, change.text);
  return change.text;
}

/**
 * One line per change, for `--report-only` and the update log.
 *
 * `~` is its own marker: a stale entry is NOT removed from the file (the update
 * keeps accepted debt so a reintroduced violation cannot slip back under the
 * exemption), so `-` is reserved for entries the write genuinely drops. The
 * `~` line says how to record the debt out, which is the only way it leaves.
 */
export function describeChangeSet(change: BaselineChangeSet): string[] {
  const lines: string[] = [];
  for (const { code, path } of change.added) lines.push(`+ ${code} ${path}`);
  for (const { code, path } of change.removed) lines.push(`- ${code} ${path}`);
  for (const { code, path } of change.stale) {
    lines.push(`~ stale ${code} ${path} (still in baseline; delete the line to record it out)`);
  }
  return lines;
}

/** `mdlineage baseline show`: per-code statistics of the committed baseline. */
export function showBaseline(root: string): { lines: string[]; error: string | null } {
  const anchor = baselineRoot(root);
  const loaded = loadBaseline(anchor);
  if (!loaded) return { lines: [`mdlineage: no ${BASELINE_FILE_NAME} at ${baselinePath(anchor)}`], error: null };
  if (loaded.error || !loaded.baseline) {
    return { lines: [`mdlineage: ${loaded.error}`], error: loaded.error };
  }
  const codes = Object.entries(loaded.baseline.codes).sort(([a], [b]) => a.localeCompare(b));
  const total = codes.reduce((sum, [, paths]) => sum + paths.length, 0);
  const lines = [
    `mdlineage: baseline ${loaded.path} (version ${loaded.baseline.version})`,
    ...(loaded.baseline.generatedAt ? [`generated at ${loaded.baseline.generatedAt}`] : []),
    ...(codes.length === 0
      ? ['no accepted violations']
      : [...codes.map(([code, paths]) => `  ${code} ${paths.length}`), `total ${total} accepted violation${total === 1 ? '' : 's'}`]),
  ];
  return { lines, error: null };
}

/**
 * `mdlineage baseline verify`: the CI gate.
 *
 * Exit 0 iff the workspace's diagnostics exactly match the committed baseline —
 * every violation is exempted AND every exemption is still earned. A new
 * violation (exit 1, reported) is a regression the baseline did not accept; a
 * stale entry (exit 1, reported) is debt that was paid and must be recorded out
 * of the baseline so the exemption cannot silently cover a reintroduced one.
 *
 * `root` is the ANCHOR, not the scope: the baseline is a repository-level
 * contract, so whenever one exists the graph is validated over the whole
 * repository root regardless of the caller's CWD. Without that, a CI job whose
 * working directory is a subdirectory would see "no baseline here, no
 * violations here" and pass against a repository that is not clean. The `files`
 * argument stays for the non-git fallback, where the CWD is the only root there
 * is.
 */
export interface VerifyResult {
  /** Process exit code. */
  exit: number;
  /** Text for stdout: the shape of the mismatch. */
  lines: string[];
}

export function verifyBaseline(root: string, options: BaselineOptions = {}): VerifyResult {
  const anchor = baselineRoot(root);
  const files = workspaceFiles(anchor, options.exclude ?? []);
  const { diagnostics, configError } = workspaceDiagnostics(files, options.configFile, anchor);
  if (configError) {
    return { exit: 1, lines: [`mdlineage: ${configError}`] };
  }
  const loaded = loadBaseline(anchor);
  if (!loaded) {
    // No baseline and no diagnostics is the clean adoption state; no baseline
    // WITH diagnostics is an unexempted repo, which the gate must not pass.
    if (diagnostics.length === 0) return { exit: 0, lines: [`mdlineage: no ${BASELINE_FILE_NAME}, no violations`] };
    return {
      exit: 1,
      lines: [
        `mdlineage: no ${BASELINE_FILE_NAME} but ${diagnostics.length} violation${diagnostics.length === 1 ? '' : 's'} present`,
        ...diagnostics.map((d) => `  ${d.path} ${d.code} ${d.message}`),
      ],
    };
  }
  if (loaded.error || !loaded.baseline) {
    return { exit: 1, lines: [`mdlineage: ${loaded.error}`] };
  }

  const baseline = loaded.baseline;
  const { reported, suppressed } = diffAgainstBaseline(diagnostics, baseline);
  const stale = staleEntries(baseline, diagnostics);

  if (reported.length === 0 && stale.length === 0) {
    const lines = [`mdlineage: baseline verified, ${suppressed.length} accepted violation${suppressed.length === 1 ? '' : 's'}`];
    return { exit: 0, lines };
  }

  const lines: string[] = [];
  for (const d of reported) lines.push(`+ ${d.path} ${d.code} ${d.message}`);
  for (const { code, path } of stale) lines.push(`- ${path} ${code} (no longer violated)`);
  lines.push(
    `mdlineage: baseline mismatch: ${reported.length} new violation${reported.length === 1 ? '' : 's'}, ` +
      `${stale.length} stale entr${stale.length === 1 ? 'y' : 'ies'}`,
  );
  return { exit: 1, lines };
}

/** Baseline entries whose diagnostics no longer exist. */
function staleEntries(baseline: Baseline, diagnostics: readonly WorkspaceDiagnostic[]): Array<{ code: string; path: string }> {
  const live = new Set(diagnostics.map((d) => `${d.code}\u0000${d.path}`));
  const out: Array<{ code: string; path: string }> = [];
  for (const [code, paths] of Object.entries(baseline.codes)) {
    for (const path of paths) {
      if (!live.has(`${code}\u0000${path}`)) out.push({ code, path });
    }
  }
  return out;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The version the CLI writes, for help text and diagnostics. */
export const BASELINE_FORMAT_VERSION = BASELINE_VERSION;
/** The file name, for help text and for the CLI's ignore rules. */
export const BASELINE_FILE = BASELINE_FILE_NAME;
