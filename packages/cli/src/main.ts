#!/usr/bin/env node
/**
 * `mdlineage` command line entry (docs/remark-language-server-solution.md §6.4).
 *
 * Deliberately dependency-light: argument parsing is `node:util` parseArgs,
 * path expansion is glob, and every rule decision comes from
 * @mdlineage/validator, so the CLI and the remark channel cannot drift apart.
 *
 * Exit codes: 0 when no error-severity diagnostic is found (warnings are
 * reported but pass), 1 when any error is found — including a file that could
 * not be read or a `--config` path that does not exist — and 2 on a usage
 * error. Making warnings fail is left to CI scripting, per the `--frail`
 * decision in §6.4.
 */

import { parseArgs } from 'node:util';
import { cwd as processCwd } from 'node:process';
import { relative } from 'node:path';
import { checkFiles, renderText, renderJson, exitCodeFor, type CheckResult } from './check.js';
import { expandMarkdownPaths, type ExpandedPath } from './paths.js';
import { gitStatus, changedMarkdownFiles, readWorktree, repositoryRoot } from './git.js';

const HELP = `mdlineage — Markdown metadata and hygiene validation

Usage:
  mdlineage check [paths...]        Validate Markdown files (default: the CWD)
  mdlineage check --changed         Validate files git status reports as changed

Options:
  --format <text|json>   Output shape (default: text)
  --config <path>        Path to mdlineage.config.yaml (default: searched for)
  --changed              Restrict the run to changed worktree files
  --no-untracked         With --changed: skip files git does not track yet
  --exclude <pattern>    Extra ignore pattern (repeatable)
  --help, -h             Show this text
  --version, -v          Print the version

Exit codes:
  0  no error-severity diagnostics
  1  at least one error: a diagnostic, an unreadable file, or a bad --config
  2  usage error`;

const VERSION = 'mdlineage 0.0.0';

interface ParsedArgs {
  positionals: string[];
  values: {
    format?: string;
    config?: string;
    changed?: boolean;
    untracked?: boolean;
    'no-untracked'?: boolean;
    exclude?: string[];
    help?: boolean;
    version?: boolean;
  };
}

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
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  }) as unknown as ParsedArgs;
}

/** Application entry. Returns the exit code the process should use. */
export async function main(argv: string[]): Promise<number> {
  const parsed = readArgs(argv);

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
  if (command !== 'check') {
    process.stderr.write(`mdlineage: unknown command '${command}'\n\n${HELP}\n`);
    return 2;
  }

  const format = parsed.values.format ?? 'text';
  if (format !== 'text' && format !== 'json') {
    process.stderr.write(`mdlineage: --format must be 'text' or 'json', got '${format}'\n`);
    return 2;
  }

  const cwd = processCwd();
  const paths = parsed.positionals.slice(1);
  const exclude = parsed.values.exclude ?? [];
  const config = parsed.values.config;

  if (parsed.values.changed) {
    // `--untracked` defaults on; `--no-untracked` (or `--untracked=false`)
    // turns it off.
    const untracked = parsed.values['no-untracked'] !== true && parsed.values.untracked !== false;
    return runChanged({ format, cwd, paths, exclude, config, untracked });
  }
  return runPaths({ format, cwd, paths, exclude, config });
}

interface RunOptions {
  format: 'text' | 'json';
  cwd: string;
  paths: string[];
  exclude: string[];
  config?: string;
}

interface ChangedRunOptions extends RunOptions {
  untracked: boolean;
}

/** `mdlineage check [paths...]`: expand, read, validate, report. */
function runPaths(options: RunOptions): number {
  const { files, missed } = expandMarkdownPaths(
    options.paths.length === 0 ? ['.'] : options.paths,
    options.cwd,
    { exclude: options.exclude },
  );

  if (missed.length > 0) {
    for (const path of missed) process.stderr.write(`mdlineage: no such file or pattern: ${path}\n`);
    return 2;
  }

  const result = checkFiles(files, { format: options.format, configFile: options.config, cwd: options.cwd });
  return emit(result, options.format);
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
    // its readers are the workspace layer's concern, M2).
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

  const result = checkFiles(files, { format: options.format, configFile: options.config, cwd: options.cwd });
  return emit(result, options.format);
}

/**
 * Write the report in the requested shape and map it to an exit code.
 *
 * Config diagnostics go to stderr in both formats: they are about the run, not
 * about the documents, and a JSON consumer reading stdout should not have to
 * separate the two streams of the report.
 */
function emit(result: CheckResult, format: 'text' | 'json'): number {
  for (const diag of result.configDiagnostics) {
    process.stderr.write(`mdlineage: ${diag.code} ${diag.severity} ${diag.message}\n`);
  }
  for (const file of result.unreadable) {
    if (format === 'json') process.stderr.write(`mdlineage: could not read ${file.path}: ${file.message}\n`);
  }
  const output = format === 'json' ? renderJson(result) : renderText(result);
  if (output.length > 0) process.stdout.write(`${output}\n`);
  return exitCodeFor(result);
}

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
