#!/usr/bin/env node
/**
 * `mdlineage` command line entry (docs/remark-language-server-solution.md §6.4,
 * §16 M2).
 *
 * Deliberately dependency-light: argument parsing is `node:util` parseArgs,
 * path expansion is glob, and every rule decision comes from
 * @mdlineage/validator, so the CLI, the remark channel and (later) the LSP
 * cannot drift apart.
 *
 * Commands:
 *   check     the authoritative repository validation (workspace + single doc)
 *   baseline  accepted-debt management for legacy repositories
 *   server    the dedicated MDLineage Language Server (§10.1: `--stdio`)
 *
 * Exit codes: 0 when no error-severity diagnostic is found (warnings are
 * reported but pass; `--frail` makes any diagnostic fail), 1 when any error is
 * found — including a file that could not be read or a `--config` path that
 * does not exist — and 2 on a usage error.
 */

import { parseArgs } from 'node:util';
import { cwd as processCwd } from 'node:process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import {
  checkFiles,
  renderText,
  renderJson,
  exitCodeFor,
  type CheckResult,
  type CheckOptions,
} from './check.js';
import { validateDocumentSync, loadConfig } from '@mdlineage/validator';
import { renderSarif } from './sarif.js';
import { expandMarkdownPaths, type ExpandedPath } from './paths.js';
import { gitStatus, changedMarkdownFiles, readWorktree, repositoryRoot } from './git.js';
import { updateBaseline, writeChangeSet, describeChangeSet, showBaseline, verifyBaseline, baselineRoot, BASELINE_FILE } from './baseline.js';
import { startStdio } from '@mdlineage/language-server';
import { runInit } from './init.js';
import { runFix } from './fix.js';
import { configValidate } from './config-validate.js';
import { indexRebuild } from './index-rebuild.js';
import { startStdio as startMcpStdio, buildProposals } from '@mdlineage/mcp-server';

const HELP = `mdlineage — Markdown metadata and hygiene validation

Usage:
  mdlineage check [paths...]        Validate Markdown (default: the CWD)
  mdlineage check --changed         Validate files git status reports as changed
  mdlineage baseline update         Record current violations as accepted debt
  mdlineage baseline show           List the committed baseline
  mdlineage baseline verify         CI gate: diagnostics must match the baseline
  mdlineage server --stdio          Run the language server over stdio
  mdlineage mcp --stdio             Run the MCP server over stdio
  mdlineage init                    Bootstrap config, .gitattributes and schemas/ (dry run)
  mdlineage suggest <file>          Propose metadata for a document (no writes)
  mdlineage fix [paths...]          Apply safe fixes (missing fields, duplicate
                                    relations, line endings; default: dry run)
  mdlineage config validate         Check the config file loads and passes the
                                    schema (no config found: defaults, exit 0)
  mdlineage index rebuild           Rebuild the workspace index in memory and
                                    report stats and index-level diagnostics
                                    (nothing is persisted)

Roots — each command anchors "the workspace" differently, by design:
  check/fix                        the CWD: paths are resolved against it, and
                                    fix refuses anything outside it
  baseline                         the git repository root (CWD outside a repo):
                                    the baseline is a repository-level contract
  init                             the git repository root (CWD outside a repo):
                                    it bootstraps the repository, not the folder
  config search (--config omitted) walks up from the CWD, so a run in a
                                    subdirectory still finds the root config

Options:
  --format <text|json|sarif>  Output shape (default: text)
  --config <path>             Path to mdlineage.config.yaml (default: searched for)
  --changed                   Restrict the run to changed worktree files
  --no-untracked              With --changed: skip files git does not track yet
  --exclude <pattern>         Extra ignore pattern (repeatable)
  --no-incremental            Validate each file independently (no workspace pass)
  --no-baseline               Ignore the committed baseline (report accepted debt)
  --force                     baseline update: write despite an unreadable baseline
  --report-only               baseline update: print the change set, write nothing
  --write                     init/fix: apply the planned changes (default is a
                              dry run)
  --frail                     Any diagnostic fails the run, warnings included
  --root <dir>                mcp: the workspace to index (default: the CWD)
  --help, -h                  Show this text
  --version, -v               Print the version

Exit codes:
  0  no error-severity diagnostics
  1  at least one error: a diagnostic, an unreadable file, or a bad --config
     (--frail: any diagnostic at all)
  2  usage error

Paths are resolved against the CWD unless the command's root note above says
otherwise; \`fix\` additionally refuses a path it resolves outside the CWD.`;

// Resolved relative to this file: dist/main.js sits beside ../package.json both
// in the repo and in the published tarball, so no source-tree path is needed.
const CLI_PACKAGE_VERSION = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
).version;
const VERSION = `mdlineage ${CLI_PACKAGE_VERSION}`;

type Format = 'text' | 'json' | 'sarif';

interface ParsedArgs {
  positionals: string[];
  values: {
    format?: string;
    config?: string;
    changed?: boolean;
    untracked?: boolean;
    'no-untracked'?: boolean;
    exclude?: string[];
    incremental?: boolean;
    'no-incremental'?: boolean;
    'no-baseline'?: boolean;
    frail?: boolean;
    force?: boolean;
    'report-only'?: boolean;
    write?: boolean;
    stdio?: boolean;
    root?: string;
    help?: boolean;
    version?: boolean;
  };
}

const FORMATS: readonly Format[] = ['text', 'json', 'sarif'];

/** parseArgs with the options this CLI understands. */
function readArgs(argv: string[]): ParsedArgs {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      format: { type: 'string' },
      config: { type: 'string' },
      changed: { type: 'boolean' },
      // `--no-untracked` arrives as `--untracked=false`, which parseArgs turns
      // into `{ untracked: false }` against this boolean option.
      untracked: { type: 'boolean' },
      'no-untracked': { type: 'boolean' },
      exclude: { type: 'string', multiple: true },
      // `--no-incremental` arrives as `--incremental=false` the same way.
      incremental: { type: 'boolean' },
      'no-incremental': { type: 'boolean' },
      frail: { type: 'boolean' },
      force: { type: 'boolean' },
      'no-baseline': { type: 'boolean' },
      // `mdlineage server --stdio` and `mdlineage mcp --stdio`: routed to the
      // transport switch of whichever server the command names, so it must
      // parse as a known boolean instead of an unknown option.
      stdio: { type: 'boolean' },
      // `mdlineage mcp --root <dir>` names the tree the MCP server indexes.
      root: { type: 'string' },
      'report-only': { type: 'boolean' },
      // `mdlineage init --write`: writing is always an explicit action.
      write: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  }) as unknown as ParsedArgs;
}

/** Application entry. Returns the exit code the process should use. */
export async function main(argv: string[]): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = readArgs(argv);
  } catch (error) {
    // parseArgs is strict: an unknown flag throws instead of reaching the
    // per-command usage checks, and a usage error must exit 2, not crash.
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`mdlineage: ${message}\n\n${HELP}\n`);
    return 2;
  }

  if (parsed.values.help) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  if (parsed.values.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  const command = parsed.positionals[0];
  if (command === undefined) {
    process.stderr.write(`mdlineage: no command given\n\n${HELP}\n`);
    return 2;
  }

  if (command === 'baseline') {
    return runBaseline(parsed.positionals.slice(1), parsed.values);
  }
  if (command === 'server') {
    return runServer(parsed.positionals.slice(1), parsed.values);
  }
  if (command === 'mcp') {
    return runMcp(parsed.positionals.slice(1), parsed.values);
  }
  if (command === 'suggest') {
    return runSuggest(parsed.positionals.slice(1), parsed.values);
  }
  if (command === 'init') {
    return runInit(parsed.positionals.slice(1), parsed.values);
  }
  if (command === 'fix') {
    return runFix(parsed.positionals.slice(1), parsed.values);
  }
  if (command === 'config') {
    return runConfigCommand(parsed.positionals.slice(1), parsed.values);
  }
  if (command === 'index') {
    return runIndexCommand(parsed.positionals.slice(1), parsed.values);
  }
  if (command !== 'check') {
    process.stderr.write(`mdlineage: unknown command '${command}'\n\n${HELP}\n`);
    return 2;
  }

  const format = parseFormat(parsed.values.format);
  if (format === null) {
    process.stderr.write(
      `mdlineage: --format must be one of ${FORMATS.join(', ')}, got '${parsed.values.format}'\n`,
    );
    return 2;
  }

  // An argument the options list does not recognise lands in `positionals` as
  // a path; a leading dash names an option the CLI does not have, which is a
  // usage error rather than a file to look for.
  const stray = parsed.positionals.slice(1).filter((arg) => arg.startsWith('-'));
  if (stray.length > 0) {
    process.stderr.write(`mdlineage: unknown option: ${stray.join(', ')}\n\n${HELP}\n`);
    return 2;
  }

  const cwd = processCwd();
  const paths = parsed.positionals.slice(1);
  const exclude = parsed.values.exclude ?? [];
  const config = parsed.values.config;
  const frail = parsed.values.frail === true;
  // `--incremental` is on by default; `--no-incremental` (or
  // `--incremental=false`) turns the workspace pass off.
  const incremental = parsed.values['no-incremental'] !== true && parsed.values.incremental !== false;
  // A committed baseline is part of the repository's contract; `--no-baseline`
  // is the audit view that reports the debt it accepts.
  const noBaseline = parsed.values['no-baseline'] === true;

  if (parsed.values.changed) {
    // `--untracked` defaults on; `--no-untracked` (or `--untracked=false`)
    // turns it off.
    const untracked = parsed.values['no-untracked'] !== true && parsed.values.untracked !== false;
    return runChanged({ format, cwd, paths, exclude, config, untracked, incremental, frail, noBaseline });
  }
  return runPaths({ format, cwd, paths, exclude, config, incremental, frail, noBaseline });
}

/** Validate a --format argument, returning null when it is not one this CLI has. */
function parseFormat(value: string | undefined): Format | null {
  if (value === undefined) return 'text';
  return (FORMATS as readonly string[]).includes(value) ? (value as Format) : null;
}

interface RunOptions {
  format: Format;
  cwd: string;
  paths: string[];
  exclude: string[];
  config?: string;
  incremental: boolean;
  frail: boolean;
  noBaseline: boolean;
}

interface ChangedRunOptions extends RunOptions {
  untracked: boolean;
}

/** `mdlineage check [paths...]`: expand, read, validate, report. */
function runPaths(options: RunOptions): number {
  const { files, others, missed, excluded } = expandMarkdownPaths(
    options.paths.length === 0 ? ['.'] : options.paths,
    options.cwd,
    { exclude: options.exclude },
  );

  if (missed.length > 0) {
    for (const path of missed) process.stderr.write(`mdlineage: no such file or pattern: ${path}\n`);
    return 2;
  }
  for (const path of excluded) {
    process.stderr.write(
      `mdlineage: ${path} matches the default exclude list (node_modules, dist); no files were checked\n`,
    );
  }

  const result = checkFiles(files, toCheckOptions(options), others);
  return emit(result, options);
}

function toCheckOptions(options: RunOptions): CheckOptions {
  return {
    format: options.format,
    configFile: options.config,
    // The baseline is anchored to the repository root, not the CWD, so a CI job
    // whose working directory is a subdirectory hits the same exemptions a root
    // run does (and a scoped run's report paths stay the caller's own spelling).
    baselineRoot: baselineRoot(options.cwd),
    noBaseline: options.noBaseline,
    incremental: options.incremental,
    frail: options.frail,
    cwd: options.cwd,
    exclude: options.exclude,
  };
}

/** `mdlineage check --changed`: the worktree-byte channel. */
function runChanged(options: ChangedRunOptions): number {
  const root = repositoryRoot(options.cwd);
  if (root === null) {
    process.stderr.write(`mdlineage: --changed needs a git repository (cwd: ${options.cwd})\n`);
    return 2;
  }

  const { statuses, error } = gitStatus(root);
  if (error) {
    process.stderr.write(`mdlineage: cannot determine changed files: ${error}\n`);
    return 2;
  }

  const { paths, skipped } = changedMarkdownFiles(statuses, root, { untracked: options.untracked });

  if (paths.length === 0) {
    // Nothing changed, or only deletions (a deleted file has no worktree bytes;
    // its readers are the workspace layer's concern in a full run).
    process.stdout.write(
      `mdlineage: no changed Markdown files${skipped ? ` (${skipped} deletion${skipped === 1 ? '' : 's'} skipped)` : ''}\n`,
    );
    return 0;
  }

  const files: ExpandedPath[] = paths.map((path) => ({ path, asGiven: relative(root, path) || path }));
  for (const file of files) {
    if (readWorktree(file.path) === null) {
      process.stderr.write(`mdlineage: cannot read changed file: ${file.asGiven}\n`);
    }
  }

  const result = checkFiles(files, toCheckOptions(options));
  return emit(result, options);
}

/**
 * Write the report in the requested shape and map it to an exit code.
 *
 * Config diagnostics go to stderr in every format: they are about the run, not
 * about the documents, and a JSON/SARIF consumer reading stdout should not have
 * to separate the two streams of the report.
 */
function emit(result: CheckResult, options: RunOptions): number {
  for (const diag of result.configDiagnostics) {
    process.stderr.write(`mdlineage: ${diag.code} ${diag.severity} ${diag.message}\n`);
  }
  for (const file of result.unreadable) {
    if (options.format !== 'text') {
      process.stderr.write(`mdlineage: could not read ${file.path}: ${file.message}\n`);
    }
  }
  const output =
    options.format === 'json'
      ? renderJson(result)
      : options.format === 'sarif'
        ? renderSarif(result)
        : renderText(result);
  if (output.length > 0) process.stdout.write(`${output}\n`);
  return exitCodeFor(result, { frail: options.frail });
}
/** `mdlineage config validate`: the config file check (§10.1). */
function runConfigCommand(args: string[], values: ParsedArgs['values']): number {
  const sub = args[0];
  if (values.help) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  if (sub !== 'validate') {
    process.stderr.write(`mdlineage: unknown config command '${sub ?? '(none)'}' (expected validate)\n\n${HELP}\n`);
    return 2;
  }
  const format = parseFormat(values.format);
  if (format === null || format === 'sarif') {
    process.stderr.write(`mdlineage: config validate --format must be text or json\n`);
    return 2;
  }
  const stray = args.slice(1).filter((arg) => arg.startsWith('-'));
  if (stray.length > 0) {
    process.stderr.write(`mdlineage: unknown option: ${stray.join(', ')}\n\n${HELP}\n`);
    return 2;
  }
  return configValidate({ format, configFile: values.config, cwd: processCwd() });
}

/** `mdlineage index rebuild`: fresh in-memory index plus a report (§10.1). */
function runIndexCommand(args: string[], values: ParsedArgs['values']): number {
  const sub = args[0];
  if (values.help) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  if (sub !== 'rebuild') {
    process.stderr.write(`mdlineage: unknown index command '${sub ?? '(none)'}' (expected rebuild)\n\n${HELP}\n`);
    return 2;
  }
  const format = parseFormat(values.format);
  if (format === null || format === 'sarif') {
    process.stderr.write(`mdlineage: index rebuild --format must be text or json\n`);
    return 2;
  }
  const stray = args.slice(1).filter((arg) => arg.startsWith('-'));
  if (stray.length > 0) {
    process.stderr.write(`mdlineage: unknown option: ${stray.join(', ')}\n\n${HELP}\n`);
    return 2;
  }
  return indexRebuild({ format, configFile: values.config, cwd: processCwd(), exclude: values.exclude ?? [] });
}

/** `mdlineage server`: the dedicated LSP (§10.1). Only stdio exists in M3-a. */
function runServer(args: string[], values: ParsedArgs['values']): number {
  if (values.help) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  if (!values.stdio) {
    const transport = args[0];
    process.stderr.write(
      `mdlineage: unknown server transport '${transport ?? "(none)"}' (expected --stdio)\n\n${HELP}\n`,
    );
    return 2;
  }
  // The server owns stdin/stdout from here on; a JSON-RPC framing byte written
  // before this point would corrupt the stream, so nothing is printed.
  const connection = startStdio({ configFile: values.config });
  connection.onShutdown(() => {
    // The lifecycle answer is "clean shutdown acknowledged"; the process exits
    // when stdio closes or `exit` arrives.
  });
  return 0;
}

/**
 * `mdlineage mcp`: the MCP server (§12), the model-facing channel.
 *
 * Only stdio exists, same as the LSP's M3-a transport surface: a stream the
 * process owns from here on is the only transport this CLI hands out.
 */
function runMcp(args: string[], values: ParsedArgs['values']): number {
  if (values.help) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  if (!values.stdio) {
    const transport = args[0];
    process.stderr.write(
      `mdlineage: unknown mcp transport '${transport ?? '(none)'}' (expected --stdio)\n\n${HELP}\n`,
    );
    return 2;
  }
  // The MCP server owns stdin/stdout from here on, exactly like the LSP: the
  // first framing byte this writes is JSON-RPC, so nothing may print first.
  startMcpStdio({
    root: values.root ?? processCwd(),
    configFile: values.config,
  }).catch((error: unknown) => {
    process.stderr.write(
      `mdlineage: the MCP server failed to start: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
  return 0;
}

/**
 * `mdlineage suggest <file>`: the deterministic half of the accept loop, on the
 * command line.
 *
 * Prints the proposals `suggest_metadata` would return over MCP, as JSON. The
 * queue is this process's own — a CLI run is one suggestion, nothing to accept
 * against — so the proposal ids here are a demonstration of the shape an MCP
 * session hands a model, and the file is never written. Accepting is
 * `apply_metadata_patch` over MCP, or an editor applying the printed edits.
 */
function runSuggest(args: string[], values: ParsedArgs['values']): number {
  if (values.help) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  const file = args[0];
  if (!file) {
    process.stderr.write(`mdlineage: suggest needs a file\n\n${HELP}\n`);
    return 2;
  }
  const root = processCwd();
  const target = resolve(root, file);
  let content: string;
  try {
    content = readFileSync(target, 'utf8');
  } catch (error) {
    process.stderr.write(
      `mdlineage: cannot read ${file}: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }

  const loaded = loadConfig(values.config, values.config ? undefined : root);
  const result = validateDocumentSync({ path: file, content, config: loaded.config });
  const candidate = buildProposals(result.diagnostics, {
    vocabulary: {
      kinds: loaded.config.vocabulary.kinds ?? [],
      statuses: loaded.config.vocabulary.statuses ?? [],
    },
    contentHash: createHash('sha256').update(content, 'utf8').digest('hex'),
    path: file,
  });

  process.stdout.write(`${JSON.stringify({ ...candidate, id: null, createdAt: null }, null, 2)}\n`);
  return 0;
}

/**
 * `mdlineage baseline <action>`: accepted-debt management.
 *
 * Every action works off the full workspace, never `--changed`: the baseline is
 * the repository's contract, and a contract written from a subset would
 * silently exempt everything the subset did not visit.
 */
function runBaseline(args: string[], values: ParsedArgs['values']): number {
  const action = args[0];
  // The baseline is a repository-level contract, so every action anchors at the
  // repository root instead of the CWD: `verify` from a subdirectory must check
  // the same graph the root sees, and `update` must write keys a root run would
  // match. Outside a git repository the CWD stands in.
  const root = baselineRoot(processCwd());
  const options = {
    configFile: values.config,
    exclude: values.exclude ?? [],
    reportOnly: values['report-only'] === true,
    force: values.force === true,
  };

  if (action === 'update') {
    const change = updateBaseline(root, options);
    if (change.error) {
      // A baseline the run could not read is reported, and the file is left
      // alone: overwriting it would discard accepted exemptions with no way back.
      process.stderr.write(`mdlineage: ${change.error}\n`);
      if (!options.force) return 1;
    }
    const lines = describeChangeSet(change);
    if (lines.length === 0) {
      process.stdout.write(`mdlineage: ${BASELINE_FILE} is already up to date\n`);
      return 0;
    }
    if (options.reportOnly) {
      process.stdout.write(`${lines.join('\n')}\n`);
      process.stdout.write(`mdlineage: would update ${change.path} (${lines.length} change${lines.length === 1 ? '' : 's'}; --report-only)\n`);
      return 0;
    }
    writeChangeSet(change, false);
    process.stdout.write(`${lines.join('\n')}\n`);
    process.stdout.write(`mdlineage: updated ${change.path}\n`);
    return 0;
  }

  if (action === 'show') {
    const { lines, error } = showBaseline(root);
    for (const line of lines) process.stdout.write(`${line}\n`);
    return error ? 1 : 0;
  }

  if (action === 'verify') {
    const { exit, lines } = verifyBaseline(root, options);
    for (const line of lines) process.stdout.write(`${line}\n`);
    return exit;
  }

  process.stderr.write(`mdlineage: unknown baseline action '${action ?? ''}'\n\n${HELP}\n`);
  return 2;
}

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
