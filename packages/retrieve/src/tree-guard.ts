/**
 * Out-of-tree symlink guard for retrieval corpora (Issue #3 review round 1).
 *
 * `scanWorkspaceUniverse` follows symlinks by design (its semantics belong to
 * check/federation, where a linked directory is a legitimate mount point).
 * Retrieval is different: it prints document CONTENT, so a `docs/link.md`
 * pointing outside the workspace would leak out-of-tree bytes into stdout
 * under an in-tree logical path. Every corpus document must therefore prove
 * its real path lands inside the real workspace root.
 */

import { realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';

/**
 * True when `root/logicalPath` really resolves inside `root` (after following
 * every symlink). realpath failures (broken link, unreadable parent) count as
 * out-of-tree: an unprovable location is not corpus material.
 */
export function isInTreeRealpath(root: string, logicalPath: string): boolean {
  let realRoot: string;
  let realTarget: string;
  try {
    realRoot = realpathSync(resolve(root));
    realTarget = realpathSync(resolve(root, logicalPath));
  } catch {
    return false;
  }
  if (realTarget === realRoot) return true;
  // sep-suffixed prefix compare so /repo/docs-evil never matches /repo/docs.
  return realTarget.startsWith(realRoot.endsWith(sep) ? realRoot : realRoot + sep);
}
