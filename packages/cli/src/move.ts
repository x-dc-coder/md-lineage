/**
 * `mdlineage move <src> <dst>`: relocate one document and heal every link that
 * pointed at or out of it (docs/dir-conventions.md §3 "Layout-aware
 * suggestions" and "Move impact").
 *
 * Two promises hold the design together:
 *
 *   - nothing is written without `--write`. The default run prints the plan —
 *     the file that moves, the documents it drags along, and how many relative
 *     links each one keeps correct — exactly the way `fix` and `init` behave,
 *     because a repository-wide link rewrite is the least reversible operation
 *     the CLI can perform.
 *   - the move is one transaction, not a sequence. Every patched document is
 *     computed before the first byte is written, so a document that cannot be
 *     read fails the run before anything has changed; then the file is moved
 *     and the patched documents are written, and the in-memory snapshot is
 *     updated so a batch (`organize --apply`) never plans its second move
 *     against a tree its first move already changed.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { posix } from 'node:path';
import { cwd as processCwd } from 'node:process';
import { loadConfig, stripBom, type Config } from '@mdlineage/validator';
import { UsageError, expandMarkdownPaths } from './paths.js';
import { repositoryRoot } from './git.js';
import {
  dirOf,
  readUpdatedAt,
  refreshUpdatedAt,
  rebaseLinks,
  repointLinks,
  type DocPath,
  type LinkRewrite,
} from './link-rewrite.js';

export interface MoveValues {
  /** Apply the plan instead of printing it. */
  write?: boolean;
  /** Force the plan to be printed even when `--write` is also given. */
  'dry-run'?: boolean;
  config?: string;
  exclude?: readonly string[];
}

/** One document whose links a move rewrites. */
export interface AffectedFile {
  /** Workspace-relative POSIX path. */
  readonly path: DocPath;
  /** The rewritten destinations, in document order. */
  readonly rewrites: readonly LinkRewrite[];
  /** The full patched content, so applying never re-parses. */
  readonly content: string;
}

/** Everything a move will do, computed before anything is written. */
export interface MovePlan {
  readonly src: DocPath;
  readonly dst: DocPath;
  /** New content of the moved document (links re-based, `updated_at` refreshed). */
  readonly movedContent: string;
  /** The date written into `updated_at`; null when there was none to refresh. */
  readonly updatedAt: string | null;
  /** The date `updated_at` carried before the move, for the report. */
  readonly previousUpdatedAt: string | null;
  /** Destinations inside the moved document that were re-based. */
  readonly outEdges: readonly LinkRewrite[];
  /** Documents that link to the moved file, sorted by path. */
  readonly inEdges: readonly AffectedFile[];
}

/** A snapshot of the workspace's Markdown documents, keyed the way the index keys them. */
export class Workspace {
  readonly documents: Map<DocPath, string>;
  readonly unreadable: readonly string[];

  constructor(
    readonly cwd: string,
    readonly config: Config,
    documents: Iterable<readonly [DocPath, string]>,
    unreadable: readonly string[] = [],
  ) {
    this.documents = new Map(documents);
    this.unreadable = unreadable;
  }

  /** Read the workspace's Markdown documents, reporting what could not be read. */
  static load(cwd: string, options: { config: Config; exclude?: readonly string[] }): Workspace {
    const { files, missed } = expandMarkdownPaths(['.'], cwd, {
      config: options.config,
      exclude: options.exclude,
    });
    if (missed.length > 0) {
      // A literal `.` always matches, so a miss here means the exclusion list
      // removed the whole workspace: nothing to plan a move against.
      throw new UsageError(`no Markdown files found under ${cwd}`);
    }
    const documents = new Map<DocPath, string>();
    const unreadable: string[] = [];
    for (const file of files) {
      try {
        documents.set(toPosix(relative(cwd, file.path)), stripBom(readFileSync(file.path, 'utf8')));
      } catch {
        unreadable.push(toPosix(relative(cwd, file.path)));
      }
    }
    return new Workspace(cwd, options.config, documents, unreadable);
  }

  /** Sorted workspace-relative paths, so every report is deterministic. */
  paths(): DocPath[] {
    return [...this.documents.keys()].sort();
  }
}

/** POSIX form of a native path, which is the vocabulary link algebra uses. */
export function toPosix(path: string): string {
  return path.split(sep).join(posix.sep);
}

/** UTC calendar date, the clock the freshness lifecycle (MDL801) reads. */
export function todayUtc(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Plan one move against a workspace snapshot. Pure: no byte is written. */
export function planMove(src: DocPath, dst: DocPath, workspace: Workspace, today: string): MovePlan {
  const srcContent = workspace.documents.get(src) ?? '';
  const rebased = rebaseLinks(srcContent, src, dst);
  const refreshed = refreshUpdatedAt(rebased.content, workspace.config.metadata.key, today);

  const inEdges: AffectedFile[] = [];
  for (const path of workspace.paths()) {
    if (path === src) continue;
    const result = repointLinks(workspace.documents.get(path) ?? '', path, src, dst);
    if (result.rewrites.length === 0) continue;
    inEdges.push({ path, rewrites: result.rewrites, content: result.content });
  }

  return {
    src,
    dst,
    movedContent: refreshed ?? rebased.content,
    updatedAt: refreshed === null ? null : today,
    previousUpdatedAt: readUpdatedAt(rebased.content, workspace.config.metadata.key),
    outEdges: rebased.rewrites,
    inEdges,
  };
}

/** Result of executing one plan. */
export interface MoveOutcome {
  /** How the file itself changed location. */
  readonly transfer: 'rename' | 'git mv';
  /** Documents written, including the moved one when its content changed. */
  readonly written: readonly DocPath[];
  /** What could not be written; a non-empty list fails the run. */
  readonly errors: readonly string[];
}

/**
 * Execute a planned move: relocate the file, then write the patched documents.
 *
 * `git mv` is preferred when the file is tracked, so the repository's history
 * follows the file instead of recording a delete plus an add; a plain rename
 * covers a tree that is not a git repository or a file git does not track yet.
 * The workspace snapshot is updated afterwards, which is what makes a batch of
 * moves see each other.
 */
export function executeMove(plan: MovePlan, workspace: Workspace): MoveOutcome {
  const errors: string[] = [];
  const written: DocPath[] = [];
  const srcAbs = resolve(workspace.cwd, plan.src);
  const dstAbs = resolve(workspace.cwd, plan.dst);

  // A destination that already exists is a collision, never a silent
  // overwrite: the batch's plans are computed before the first byte is
  // written, so a file that appeared since — or a plan that slipped past the
  // planner — stops here instead of erasing what is on disk.
  if (existsSync(dstAbs)) {
    return { transfer: 'rename', written, errors: [`destination already exists: ${plan.dst}`] };
  }

  let transfer: MoveOutcome['transfer'];
  try {
    mkdirSync(dirname(dstAbs), { recursive: true });
    transfer = transferFile(srcAbs, dstAbs, workspace.cwd);
  } catch (error) {
    return { transfer: 'rename', written, errors: [`cannot move ${plan.src}: ${messageOf(error)}`] };
  }

  if (plan.movedContent !== (workspace.documents.get(plan.src) ?? '')) {
    try {
      writeFileAtomic(dstAbs, plan.movedContent);
      written.push(plan.dst);
    } catch (error) {
      errors.push(`cannot write ${plan.dst}: ${messageOf(error)}`);
    }
  }

  for (const affected of plan.inEdges) {
    try {
      writeFileAtomic(resolve(workspace.cwd, affected.path), affected.content);
      written.push(affected.path);
    } catch (error) {
      errors.push(`cannot write ${affected.path}: ${messageOf(error)}`);
    }
  }

  workspace.documents.delete(plan.src);
  workspace.documents.set(plan.dst, plan.movedContent);
  for (const affected of plan.inEdges) workspace.documents.set(affected.path, affected.content);

  return { transfer, written, errors };
}

/** Move `srcAbs` to `dstAbs`, through git when the file is tracked. */
function transferFile(srcAbs: string, dstAbs: string, cwd: string): MoveOutcome['transfer'] {
  const repoRoot = repositoryRoot(cwd);
  if (repoRoot !== null) {
    const relSrc = toPosix(relative(repoRoot, srcAbs));
    const relDst = toPosix(relative(repoRoot, dstAbs));
    const tracked = spawnSync('git', ['ls-files', '--', relSrc], { cwd: repoRoot, encoding: 'utf8', windowsHide: true });
    if (tracked.status === 0 && (tracked.stdout ?? '').trim() !== '') {
      const moved = spawnSync('git', ['mv', relSrc, relDst], { cwd: repoRoot, encoding: 'utf8', windowsHide: true });
      if (moved.status === 0) return 'git mv';
      // git refused (permissions, a staged conflict): the file is still where it
      // was, so the plain rename below is a safe fallback, not a second attempt
      // at something already half-done.
    }
  }
  renameSync(srcAbs, dstAbs);
  return 'rename';
}

/** `mdlineage move [paths...]`. Returns the process exit code. */
export function runMove(argv: readonly string[], values: MoveValues, cwd: string = processCwd()): number {
  const write = values.write === true && values['dry-run'] !== true;
  const target = resolveMoveTargets(argv, cwd);

  const loaded = loadConfig(values.config, values.config ? undefined : cwd);
  for (const diag of loaded.diagnostics) {
    process.stderr.write(`mdlineage: ${diag.code} ${diag.severity} ${diag.message}\n`);
  }
  const configFailed = loaded.diagnostics.some((d) => d.severity === 'error');
  // A configuration the loader could not use would make every destination and
  // layout decision below a guess, so the run stops before anything is read or
  // written — the dry run included.
  if (configFailed) {
    process.stderr.write('mdlineage: configuration has error-level diagnostics; refusing to move\n');
    return 1;
  }

  const workspace = Workspace.load(cwd, { config: loaded.config, exclude: values.exclude });
  if (workspace.unreadable.length > 0) {
    for (const path of workspace.unreadable) {
      process.stderr.write(`mdlineage: cannot read ${path}\n`);
    }
    return 1;
  }

  const src = toPosix(relative(cwd, target.src));
  const dst = toPosix(relative(cwd, target.dst));
  // A source the scan did not index (a git-ignored document, an image) still
  // moves, so its bytes are read here rather than planned as an empty file.
  if (!workspace.documents.has(src)) {
    try {
      workspace.documents.set(src, stripBom(readFileSync(target.src, 'utf8')));
    } catch (error) {
      process.stderr.write(`mdlineage: cannot read ${src}: ${messageOf(error)}\n`);
      return 1;
    }
  }

  const plan = planMove(src, dst, workspace, todayUtc());
  const links = plan.outEdges.length + plan.inEdges.reduce((sum, file) => sum + file.rewrites.length, 0);
  const rewrites = plan.inEdges.length + (plan.movedContent === workspace.documents.get(src) ? 0 : 1);

  process.stdout.write(`mdlineage move: ${src} -> ${dst} (${write ? 'applying' : 'dry run; use --write to apply'})\n`);
  if (values.write === true && values['dry-run'] === true) {
    process.stdout.write('  --dry-run given with --write: printing the plan, writing nothing\n');
  }
  if (plan.updatedAt !== null && plan.previousUpdatedAt !== plan.updatedAt) {
    process.stdout.write(`  ${src}: updated_at ${plan.previousUpdatedAt ?? '(none)'} -> ${plan.updatedAt}\n`);
  }
  if (plan.outEdges.length > 0) {
    process.stdout.write(`  ${src}: ${plan.outEdges.length} link(s) re-based from ${dirOf(src)}\n`);
  }
  for (const affected of plan.inEdges) {
    process.stdout.write(`  ${affected.path}: ${affected.rewrites.length} link(s) re-pointed at ${dst}\n`);
  }

  if (!write) {
    process.stdout.write(
      `mdlineage move: 1 file to move, ${rewrites} file(s) to rewrite, ${links} link(s) rewritten\n`,
    );
    return 0;
  }

  const outcome = executeMove(plan, workspace);
  for (const error of outcome.errors) process.stderr.write(`mdlineage: ${error}\n`);
  process.stdout.write(
    `mdlineage move: 1 file moved (${outcome.transfer}), ${rewrites} file(s) rewritten, ${links} link(s) rewritten\n`,
  );
  return outcome.errors.length > 0 ? 1 : 0;
}

/** The validated source and destination of a `move` invocation. */
export function resolveMoveTargets(argv: readonly string[], cwd: string): { src: string; dst: string } {
  const positionals = argv.filter((arg) => !arg.startsWith('-'));
  if (positionals.length < 2) {
    throw new UsageError('move needs a source and a destination: mdlineage move <src> <dst> [--write]');
  }
  if (positionals.length > 2) {
    throw new UsageError(`move takes exactly two arguments, got ${positionals.length}: ${positionals.join(' ')}`);
  }

  const src = resolve(cwd, positionals[0]!);
  const dstGiven = resolve(cwd, positionals[1]!);
  for (const [label, absolute] of [
    ['<src>', src],
    ['<dst>', dstGiven],
  ] as const) {
    if (!isInside(cwd, absolute)) {
      throw new UsageError(`refusing to move outside the workspace: ${label} ${absolute}`);
    }
  }

  if (!existsSync(src)) throw new UsageError(`no such file: ${positionals[0]}`);
  if (!statSync(src).isFile()) throw new UsageError(`not a file: ${positionals[0]}`);

  // A destination that already exists as a directory means "move it in there",
  // the way `mv` reads it; an existing file is a conflict that would silently
  // overwrite, so it is refused instead.
  let dst = dstGiven;
  if (existsSync(dstGiven)) {
    if (!statSync(dstGiven).isDirectory()) {
      throw new UsageError(`destination already exists: ${positionals[1]}`);
    }
    dst = resolve(dstGiven, basename(src));
  }
  if (dst === src) throw new UsageError('source and destination are the same file');

  return { src, dst };
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Atomic write: temp file in the target's directory, then rename over it. */
function writeFileAtomic(path: string, content: string): void {
  const tmp = join(dirname(path), `.${randomBytes(6).toString('hex')}.mdlineage-tmp`);
  try {
    writeFileSync(tmp, content, { encoding: 'utf8', mode: statSync(path).mode });
    renameSync(tmp, path);
  } catch (error) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // best effort: the temp file never existed
    }
    throw error;
  }
}
