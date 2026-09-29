/**
 * Git-backed fallback clock for document freshness (MDL801).
 *
 * Spawns git to discover commit timestamps for documents without authored
 * updated_at or created_at fields.
 *
 * Neither validateDocument nor validateWorkspace imports this module directly.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { resolve, relative } from 'node:path';
import type { WorkspaceIndex, DocPath } from './workspace-index.js';
import { lifecycleExempts, MS_PER_DAY } from './freshness.js';

export interface GitClock {
  readonly provenStale: boolean;
  readonly seconds: number | null;
}

export type SpawnGitResult = { stdout: string; exitCode?: number };
export type SpawnGitFn = (
  args: readonly string[],
  options: { cwd: string; stdin?: string },
) => Promise<SpawnGitResult> | SpawnGitResult | ChildProcess;

export interface GitClockOptions {
  readonly nowMs?: number;
  readonly spawnGit?: SpawnGitFn;
}

/**
 * Parse git log output: numeric lines are commit timestamps (seconds), non-empty
 * lines are changed file paths. Timestamps are in reverse chronological order.
 * Files seen with timestamp > cutoffSec are fresh. When a timestamp <= cutoffSec
 * is reached, remaining unseen tracked files are proven stale and parsing stops.
 */
export function clocksFromLog(
  stdout: string,
  tracked: ReadonlySet<string>,
  cutoffSec: number,
): { fresh: Set<string>; provenStale: boolean } {
  const fresh = new Set<string>();
  let currentSec: number | null = null;
  let provenStale = false;

  const lines = stdout.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^\d+$/.test(line)) {
      currentSec = parseInt(line, 10);
      if (currentSec <= cutoffSec) {
        provenStale = true;
        break;
      }
    } else if (currentSec !== null && currentSec > cutoffSec) {
      if (tracked.has(line)) {
        fresh.add(line);
      }
    }
  }

  return { fresh, provenStale };
}

const MAX_PATHSPECS = 200;
const MAX_PATHSPEC_CHARS = 24_576;

function chunkPathspecs(paths: readonly string[]): string[][] {
  const chunks: string[][] = [];
  let cur: string[] = [];
  let chars = 0;
  for (const p of paths) {
    const cost = p.length + 1;
    if (cur.length > 0 && (cur.length >= MAX_PATHSPECS || chars + cost > MAX_PATHSPEC_CHARS)) {
      chunks.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(p);
    chars += cost;
  }
  if (cur.length > 0) chunks.push(cur);
  return chunks;
}

function writeChildStdin(child: ChildProcess, stdin: string | undefined): void {
  const stream = child.stdin;
  if (stdin === undefined || stream == null) return;
  stream.on('error', () => {
    // EPIPE / ERR_STREAM_DESTROYED: git already exited. Never an uncaught exception.
  });
  try {
    stream.end(stdin);
  } catch {
    // synchronous EPIPE; child close still settles the promise
  }
}

async function runGit(
  args: readonly string[],
  cwd: string,
  stdin?: string,
  customSpawn?: SpawnGitFn,
): Promise<{ stdout: string; exitCode: number }> {
  if (customSpawn) {
    const res = await customSpawn(args, { cwd, stdin });
    if ('stdout' in res && typeof res.stdout === 'string') {
      return { stdout: res.stdout, exitCode: res.exitCode ?? 0 };
    }
    return streamProcess(res as ChildProcess, stdin);
  }

  return new Promise((resolveResult) => {
    try {
      const child = spawn('git', args, {
        cwd,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      let stdout = '';
      child.stdout.on('data', (chunk: Buffer | string) => {
        stdout += chunk.toString();
      });
      child.on('error', () => resolveResult({ stdout: '', exitCode: 1 }));
      child.on('close', (code) => resolveResult({ stdout, exitCode: code ?? 0 }));
      writeChildStdin(child, stdin);
    } catch {
      resolveResult({ stdout: '', exitCode: 1 });
    }
  });
}

function streamProcess(child: ChildProcess, stdin?: string): Promise<{ stdout: string; exitCode: number }> {
  return new Promise((resolveResult) => {
    let stdout = '';
    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.on('error', () => resolveResult({ stdout: '', exitCode: 1 }));
    child.on('close', (code) => resolveResult({ stdout, exitCode: code ?? 0 }));
    writeChildStdin(child, stdin);
  });
}

function streamGitLogProcess(
  child: ChildProcess,
  tracked: ReadonlySet<string>,
  cutoffSec: number,
): Promise<{ fresh: Set<string>; provenStale: boolean }> {
  return new Promise((resolveResult) => {
    const fresh = new Set<string>();
    let currentSec: number | null = null;
    let provenStale = false;
    let remainder = '';

    const handleLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      if (/^\d+$/.test(trimmed)) {
        currentSec = parseInt(trimmed, 10);
        if (currentSec <= cutoffSec) {
          provenStale = true;
          try {
            child.kill('SIGTERM');
          } catch {
            // ignore
          }
        }
      } else if (currentSec !== null && currentSec > cutoffSec) {
        if (tracked.has(trimmed)) {
          fresh.add(trimmed);
        }
      }
    };

    child.stdout?.on('data', (chunk: Buffer | string) => {
      if (provenStale) return;
      const text = remainder + chunk.toString();
      const lines = text.split(/\r?\n/);
      remainder = lines.pop() ?? '';
      for (const line of lines) {
        handleLine(line);
        if (provenStale) break;
      }
    });

    const finish = () => {
      if (!provenStale && remainder.trim()) {
        handleLine(remainder);
      }
      resolveResult({ fresh, provenStale });
    };

    child.on('error', finish);
    child.on('close', finish);
  });
}

async function runGitLogChunk(
  chunkPaths: readonly string[],
  cwd: string,
  tracked: ReadonlySet<string>,
  cutoffSec: number,
  customSpawn?: SpawnGitFn,
): Promise<{ fresh: Set<string>; provenStale: boolean }> {
  if (chunkPaths.length === 0) {
    return { fresh: new Set(), provenStale: false };
  }
  const args = ['--literal-pathspecs', 'log', '--name-only', '--format=%at', '--', ...chunkPaths];

  if (customSpawn) {
    const res = await customSpawn(args, { cwd });
    if ('stdout' in res && typeof res.stdout === 'string') {
      return clocksFromLog(res.stdout, tracked, cutoffSec);
    }
    return streamGitLogProcess(res as ChildProcess, tracked, cutoffSec);
  }

  return new Promise<{ fresh: Set<string>; provenStale: boolean }>((resolveResult) => {
    try {
      const child = spawn('git', args, {
        cwd,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      streamGitLogProcess(child, tracked, cutoffSec).then(resolveResult);
    } catch {
      resolveResult({ fresh: new Set(), provenStale: false });
    }
  });
}

/**
 * Compute Git-backed clocks for documents in index that lack authored timestamps.
 */
export async function gitClocksForIndex(
  index: WorkspaceIndex,
  cwd: string,
  options?: GitClockOptions,
): Promise<ReadonlyMap<DocPath, GitClock>> {
  const config = index.config;
  const staleAfterDays = config.lifecycle.staleAfterDays;
  // 1. staleAfterDays <= 0 -> empty Map, zero freshness-governance spawns from gitClocksForIndex
  if (staleAfterDays <= 0) return new Map();

  // 2. Select candidates: status in staleStatuses, not exempt, updatedAt and createdAt both null
  const candidatePaths: DocPath[] = [];
  for (const path of index.paths()) {
    const entry = index.entryOf(path);
    if (!entry || entry.status === null) continue;
    if (!config.lifecycle.staleStatuses.includes(entry.status)) continue;
    if (lifecycleExempts(path, config.lifecycle.exempt)) continue;
    if (entry.updatedAt !== null || entry.createdAt !== null) continue;
    candidatePaths.push(path);
  }
  // Fast path: if empty, zero freshness-governance spawns from gitClocksForIndex
  if (candidatePaths.length === 0) return new Map();

  // 3. git rev-parse --show-toplevel
  const revParse = await runGit(['rev-parse', '--show-toplevel'], cwd, undefined, options?.spawnGit);
  if (revParse.exitCode !== 0 || !revParse.stdout.trim()) {
    return new Map();
  }
  const gitRoot = revParse.stdout.trim();

  // 4. Map candidate paths to git relative paths
  const docPathByGitPath = new Map<string, DocPath>();
  const gitPaths: string[] = [];
  for (const docPath of candidatePaths) {
    const abs = resolve(cwd, docPath);
    const gitRel = relative(gitRoot, abs).replace(/\\/g, '/');
    docPathByGitPath.set(gitRel, docPath);
    gitPaths.push(gitRel);
  }

  // 5. Query git tracked status via chunked positional pathspecs
  const tracked = new Set<string>();
  for (const chunk of chunkPathspecs(gitPaths)) {
    if (chunk.length === 0) continue;
    const ls = await runGit(
      ['--literal-pathspecs', 'ls-files', '-z', '--', ...chunk],
      gitRoot,
      undefined,
      options?.spawnGit,
    );
    if (ls.exitCode !== 0) return new Map();
    for (const token of ls.stdout.split('\0')) {
      if (token && docPathByGitPath.has(token)) tracked.add(token);
    }
  }
  const trackedGitPaths = gitPaths.filter((p) => tracked.has(p));
  if (trackedGitPaths.length === 0) return new Map();

  // 6. Batches of paths for git log
  const nowMs = options?.nowMs ?? Date.now();
  const cutoffSec = Math.floor((nowMs - staleAfterDays * MS_PER_DAY) / 1000);
  const resultMap = new Map<DocPath, GitClock>();

  for (const chunk of chunkPathspecs(trackedGitPaths)) {
    if (chunk.length === 0) continue;
    const chunkSet = new Set(chunk);
    const { fresh, provenStale } = await runGitLogChunk(
      chunk,
      gitRoot,
      chunkSet,
      cutoffSec,
      options?.spawnGit,
    );
    for (const gitPath of chunk) {
      const docPath = docPathByGitPath.get(gitPath)!;
      if (fresh.has(gitPath)) {
        resultMap.set(docPath, { provenStale: false, seconds: null });
      } else if (provenStale) {
        resultMap.set(docPath, { provenStale: true, seconds: null });
      } else {
        resultMap.set(docPath, { provenStale: false, seconds: null });
      }
    }
  }

  return resultMap;
}
