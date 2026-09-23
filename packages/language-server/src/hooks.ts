/**
 * Language-feature mount points (§10.2), for M3-b.
 *
 * M3-a ships the diagnostics channel and the index that feeds it. Every §10.2
 * feature reads the same `ServerContext` — the same index a `didChange` just
 * updated — so a completion's target list cannot drift from the diagnostics a
 * developer is looking at. Registering is a hook rather than a parameter per
 * feature because the features arrive in one package in M3-b and none of them
 * changes how `createServer` drives the lifecycle.
 */

import type { ServerContext } from './server.js';

/**
 * What M3-b supplies. Everything defaults to absent, so a server without hooks
 * is the diagnostics-only server M3-a delivers.
 */
export interface ServerHooks {
  /**
   * Called once, after the index and the document manager are live and before
   * the client's `initialized` notification is answered. M3-b registers its
   * request/notification handlers here against the exported `ServerContext`
   * (§10.2):
   *
   *   - completion        `index.paths()` / `ids()` for targets, the config's
   *                        vocabulary for kinds/statuses/authorities
   *   - hover             `index.entryOf(path)` for field docs and relation
   *                        direction/status
   *   - definition        `index.idToPaths(target)` for a relation's target, or
   *                        `resolveLinkPath` for a Markdown link
   *   - references        `index.referrersOf(id)` / `linkReferrersOf(path)`
   *   - rename            `referrersOf` + `WorkspaceEdit`; MDL301's `data` and
   *                        the reverse maps are the machinery it needs
   *   - codeAction        §9.1's safe fixes; the diagnostic's `data` names what
   *                        a fix edits, with `message` parsing only as a fallback
   *   - documentSymbol    `index.anchorsOf(path)` plus the mdast tree the index
   *                        keeps on the entry
   *   - workspaceSymbol   `ids()`, `aliases` and `index.headingsOf(path)` — the
   *                        title search §10.2 names — over the whole index
   *
   * Each handler also needs its capability declared in `createServer`'s
   * `onInitialize` result; M3-b adds those declarations beside the handlers.
   */
  register?(context: ServerContext): void;
}
