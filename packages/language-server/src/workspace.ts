/**
 * Repository access for the language server.
 *
 * The index is pure data (packages/validator/src/workspace-index.ts keeps IO out
 * of it on purpose), so the LSP's half of the bargain is: read the files, key
 * them by a path the index can carry, and stay quiet about the ones it cannot
 * read. Everything here is sync because `createWorkspaceIndex` is sync and the
 * server rebuilds the index at initialize time, before the client expects a
 * response.
 */

import { readFileSync, statSync, readdirSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Config } from '@mdlineage/validator';

/**
 * §13's degradation threshold: a document above this is parsed for the cheap
 * layers only, and the user is told once. Two megabytes is where the parse plus
 * schema validation stops being the ~50ms P95 §13 targets on ordinary hardware.
 */
export const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;

/** Only Markdown documents are MDLineage's business (§10.3's scan step). */
export function isMarkdownUri(uri: string): boolean {
  return uri.toLowerCase().endsWith('.md');
}

/**
 * `file://` URI → an absolute filesystem path, or null for any other scheme.
 *
 * The index carries paths, not URIs, because the validator and the CLI use paths
 * and the LSP must key the same documents the same way (§14.4's one-fixture-
 * many-entries promise). `vscode-uri` does the percent-decoding.
 */
export function uriToPath(uri: string): string | null {
  if (!uri.startsWith('file:')) return null;
  try {
    return fileURLToPath(uri);
  } catch {
    return null;
  }
}

/** Absolute path → the `file://` URI the client addresses documents by. */
export function pathToUri(path: string, rootPath: string): string {
  // The index keys documents relative to the root, so the root is what turns a
  // key back into the absolute path a `file://` URI names. `resolve` is a no-op
  // for a path that is already absolute, which keeps an out-of-root key — the
  // one spelling `toIndexPath` leaves absolute — round-tripping.
  return pathToFileURL(resolve(rootPath, path)).href;
}

/**
 * The index's path vocabulary: a root-relative POSIX path.
 *
 * Every transport keys the same tree the same way — the CLI by the spelling its
 * arguments produced, the MCP by `relative(root, …)` — so one document's
 * diagnostics carry the same `path` and the same message whichever entry point
 * produced them (§14.4). It is also what makes root-relative Markdown links
 * (`docs/vision.md` from a repository README) resolve: `resolveLinkPath` matches
 * a destination against the index's keys verbatim, so a tree keyed by absolute
 * paths answers "target does not exist" for every one of them.
 *
 * A path outside the root keeps its absolute spelling, which simply never
 * matches a root-relative key; the CLI and the MCP make the same choice.
 */
export function toIndexPath(root: string, path: string): string {
  const absolute = isAbsolute(path) ? path : resolve(root, path);
  const rel = relative(root, absolute);
  if (rel === '' || rel.startsWith('..')) return absolute;
  return rel.split(sep).join('/');
}

/** The `file://` URI of a request → the index key of the document it names. */
export function indexPathOfUri(root: string, uri: string): string | null {
  const absolute = uriToPath(uri);
  return absolute === null ? null : toIndexPath(root, absolute);
}

/** The absolute filesystem path an index key names. */
export function toAbsolutePath(root: string, path: string): string {
  return resolve(root, path);
}

/**
 * The directory a root hint names: `path` itself when it is one, its parent
 * when it is a file, null when it cannot be read.
 *
 * A client's `rootUri`/`rootPath` is supposed to name a folder, but some spell
 * the document they opened (`rootPath: /tree/docs/a.md`), and a FILE as the
 * root corrupts the index's vocabulary: `toIndexPath` never applies its
 * root-relative spelling to the root itself, the document keeps an absolute
 * key, and its Markdown links then resolve against an index keyed
 * root-relatively — so each one reports MDL401 for a target that IS in the
 * tree. The document's own directory is the only reading of the hint that is
 * defensible, and it is what an editor that reports a file means by "here".
 *
 * A path that does not exist yields null rather than the parent chain: the
 * parent of a typo is another directory this server has no business scanning,
 * and the caller falls back to the CWD it already chose.
 */
export function toRootDirectory(path: string): string | null {
  try {
    const stats = statSync(path);
    return stats.isDirectory() ? path : dirname(path);
  } catch {
    return null;
  }
}

/** True when a path is worth indexing: a readable Markdown file under `root`. */
function isCandidate(path: string, root: string): boolean {
  if (!isMarkdownUri(path)) return false;
  const relativePath = relative(root, path);
  // A path outside the root (the `..` of a symlink escape) is not this
  // workspace's document.
  if (relativePath === '' || relativePath.startsWith('..')) return false;
  // The default excludes mirror the CLI's (packages/cli/src/paths.ts): a
  // dependency tree and a build output tree are not documents to validate.
  const normalized = relativePath.split(sep).join('/');
  for (const pattern of EXCLUDE_PREFIXES) {
    if (normalized === pattern || normalized.startsWith(`${pattern}/`)) return false;
  }
  return true;
}

const EXCLUDE_PREFIXES = ['node_modules', 'dist', 'vendor'] as const;

/**
 * Read a document's text, or null when it is not readable UTF-8.
 *
 * Never throws: an unreadable file is reported to the developer through the
 * caller's notice, not by killing the server.
 */
export function readDocument(path: string): string | null {
  try {
    const stats = statSync(path);
    if (!stats.isFile()) return null;
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * The Markdown documents under `root`, as a root-relative path → content map
 * the index takes directly.
 *
 * The keys are the index's own vocabulary (`toIndexPath`), the same spelling
 * the CLI and the MCP key a tree by, so a document's diagnostics are identical
 * whichever channel produced them and a root-relative link resolves.
 *
 * `config.files.exclude` is consulted as a prefix check, which covers the
 * patterns the config schema allows (glob-free directory names) without pulling
 * a glob engine into the server's startup path; a pattern with a `*` matches
 * literally, and the config schema's own examples are plain directory names.
 */
export function scanWorkspace(root: string, config: Config): Map<string, string> {
  const files = new Map<string, string>();
  const exclude = Array.isArray(config.files.exclude) ? config.files.exclude : [];
  const queue = [resolve(root)];

  while (queue.length > 0) {
    const dir = queue.pop() as string;
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (isExcludedDir(path, root, exclude)) continue;
        queue.push(path);
        continue;
      }
      if (!isCandidate(path, root)) continue;
      const text = readDocument(path);
      if (text !== null) files.set(toIndexPath(root, path), text);
    }
  }

  return files;
}

/** A directory the config or the defaults say to walk past. */
function isExcludedDir(path: string, root: string, exclude: readonly string[]): boolean {
  const normalized = relative(root, path).split(sep).join('/');
  for (const pattern of EXCLUDE_PREFIXES) {
    if (normalized === pattern) return true;
  }
  for (const pattern of exclude) {
    const trimmed = pattern.replace(/^\.?\//, '').replace(/\/$/, '');
    if (trimmed.length === 0) continue;
    if (normalized === trimmed) return true;
    // A `**/prefix` or trailing-`/**` shape reduces to the directory name.
    if (pattern.startsWith('**/') && normalized === pattern.slice(3).replace(/\/\*+$/, '')) return true;
    if (pattern.endsWith('/**') && normalized === pattern.slice(0, -3)) return true;
  }
  return false;
}
