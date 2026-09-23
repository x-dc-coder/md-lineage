/**
 * MDLineage Language Server (docs/remark-language-server-solution.md §10.3).
 *
 * The dedicated LSP owns one workspace index per server and keeps it in sync with
 * three sources of truth, in the order §10.3 lists them:
 *
 *   1. the repository, scanned at `initialize` time and re-read whenever the
 *      client reports an external change (`workspace/didChangeWatchedFiles`);
 *   2. the unsaved in-memory buffer, which overlays the disk snapshot for every
 *      open document (an uncommitted edit is the state the developer is looking
 *      at, so it is the state that gets validated);
 *   3. the committed file, which takes over again on `didClose` (§10.3:
 *      "丢弃未保存 overlay → 回到磁盘 snapshot").
 *
 * Diagnostics are pushed after a debounce of ~200ms (§13: "输入停止约 200ms 后
 * 开始校验"), over the changed document PLUS the affected set `updateFile`
 * returns, which is what keeps the incrementality promise of §10.3's
 * "校验当前文件和直接受影响引用方".
 *
 * Never throws: a document that cannot be parsed yields diagnostics, and an
 * unreadable file is skipped, same as in the CLI.
 *
 * M3-b (§10.2) adds the language features: completion, hover, definition,
 * references, rename, document/workspace symbols and safe code actions. They
 * live in `features.ts` and are registered through the `hooks` option, which
 * keeps this module's control flow untouched — the lifecycle a feature needs
 * (the index, the config, the text overlay) is exactly the state this module
 * already maintains, so a feature never owns a second copy of it.
 */

import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import type { Connection } from 'vscode-languageserver';
import type { DidChangeWatchedFilesParams, PublishDiagnosticsParams } from 'vscode-languageserver-protocol';
import {
  createConnection,
  TextDocuments,
  DidChangeWatchedFilesNotification,
  CodeActionKind,
} from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import {
  loadConfig,
  parseBaseline,
  createWorkspaceIndex,
  updateFile,
  removeFile,
  validateWorkspace,
  BASELINE_FILE_NAME,
  type Config,
  type Baseline,
  type WorkspaceIndex,
  type DocPath,
} from '@mdlineage/validator';
import { toLspDiagnostic } from './diagnostics.js';
import type { ServerHooks } from './hooks.js';
import { registerLanguageFeatures } from './features.js';
import {
  scanWorkspace,
  readDocument,
  isMarkdownUri,
  uriToPath,
  pathToUri,
  MAX_DOCUMENT_BYTES,
} from './workspace.js';
import { relative } from 'node:path';
import { sep } from 'node:path';

export { toLspDiagnostic, severityToLsp } from './diagnostics.js';
export { diagnosticRange, toLspRange as rangeToLsp } from './position.js';
export type { ServerHooks } from './hooks.js';
export { registerLanguageFeatures } from './features.js';
export {
  MAX_DOCUMENT_BYTES,
  scanWorkspace,
  readDocument,
  isMarkdownUri,
  uriToPath,
  pathToUri,
} from './workspace.js';

/** §13: the settling window before a burst of edits triggers a validation. */
export const DEFAULT_DEBOUNCE_MS = 200;

/** Options for `createServer`. */
export interface ServerOptions {
  /**
   * Absolute directory the initial scan and the config/baseline lookup anchor
   * to. The root folder the client reports is used when omitted; the CWD is the
   * last resort, which is what makes a stdio smoke test from any directory work.
   */
  rootPath?: string;
  /** Override `mdlineage.config.yaml` discovery (testing and smoke runs). */
  configFile?: string;
  /** The debounce window; defaults to §13's 200ms. */
  debounceMs?: number;
  /**
   * Host the language features M3-b implements (§10.2). `createServer` returns
   * the hook surface regardless, so M3-b can register handlers without touching
   * this module's control flow.
   */
  hooks?: ServerHooks;
}

/**
 * The mount points M3-b extends (§10.2).
 *
 * Every capability M3-a leaves undeclared is a capability M3-b turns on by
 * declaring it here and registering a handler through `hooks.register`.
 */
export interface ServerContext {
  /** The connection M3-b registers requests/notifications on. */
  readonly connection: Connection;
  /**
   * The index every handler reads; already kept in sync by this module.
   *
   * Live: `reconfigure` rebuilds the index when `initialize` names a workspace
   * folder, and this property reads the current one every time. A handler that
   * captured the index in a closure at registration would still hold the empty
   * pre-scan index the module built first — the language features must see the
   * tree the developer is editing, not the one `createServer` started with.
   */
  readonly index: WorkspaceIndex;
  /**
   * The config the index was built with, including severity overrides. Live for
   * the same reason as `index`: `reconfigure` re-reads it from the client's
   * folder, and a stale copy would complete from a vocabulary that no longer
   * applies to this tree.
   */
  readonly config: Config;
  /** The accepted-debt baseline diagnostics are suppressed against. */
  readonly baseline: Baseline | null;
  /** The root the index's paths are relative to. */
  readonly rootPath: string;
  /**
   * Resolve a document to its current text — the in-memory overlay when the
   * document is open, the disk snapshot otherwise. Callers that only need the
   * graph should read the index instead.
   */
  resolveText(path: DocPath): string | null;
  /**
   * Validate `paths` now and publish the results, bypassing the debounce. M3-b's
   * code actions call this after applying an edit, so the diagnostics the next
   * response reads are fresh.
   */
  validateNow(paths: ReadonlyArray<DocPath>): void;
}

/** The running server's handles, for tests and for the CLI's stdio entry. */
export interface LanguageServer {
  readonly connection: Connection;
  readonly context: ServerContext;
  /** True once the initial scan has finished and the index is populated. */
  readonly ready: boolean;
  /**
   * Resolve once the initial scan (§10.3's index-build step) is done, so the
   * caller — `initialize`, or a test — answers its client after the tree is
   * actually indexed.
   */
  whenReady(): Promise<void>;
  /** Stop the server: clears timers and pending callbacks. Idempotent. */
  dispose(): void;
}

/**
 * How many validations were published. A test asserts this is smaller than the
 * number of `didChange` notifications it sent, which is §13's debounce promise
 * in one number.
 */
export interface ValidationCounters {
  validations: number;
  diagnosticsPublished: number;
}

/**
 * Create a server over an existing connection.
 *
 * The connection is the caller's: `startStdio` builds one over stdio, and a
 * test builds one over a stream pair, which is what makes the handshake and the
 * notification round trip observable (§14.4: the LSP entry must produce the same
 * code/range as the validator and the CLI).
 */
export function createServer(connection: Connection, options: ServerOptions = {}): LanguageServer {
  const rootPath = resolve(options.rootPath ?? process.cwd());
  const loaded = loadConfig(options.configFile, options.configFile ? undefined : rootPath);
  // Config and baseline are re-read when `initialize` names a workspace folder
  // (see `reconfigure`), so both stay `let` until the root is settled.
  let config = loaded.config;
  let baseline = loadServerBaseline(rootPath);
  // §10.3's first step is a scan; it is deferred so `initialize` can answer the
  // client once it is done instead of blocking the connection's reader for a
  // whole repository.
  let index = createWorkspaceIndex(new Map(), config);
  let scanPromise: Promise<void> | null = null;
  let scanned = false;
  const counters: ValidationCounters = { validations: 0, diagnosticsPublished: 0 };

  /**
   * Re-read config and baseline from `root`, after `initialize` named it.
   *
   * `options.rootPath` is the pre-handshake guess; the client's folder is the
   * tree the index actually validates, and a config or baseline read from the
   * wrong root would override severities or exempt paths the validated tree
   * never had. The index snapshots the config into every entry it parses
   * (`parseDocument` runs the whole rule stack at insert time), so a new config
   * means a new index: the scan that follows repopulates it from the same root.
   */
  function reconfigure(root: string): void {
    if (options.configFile !== undefined) return;
    const reloaded = loadConfig(undefined, root);
    baseline = loadServerBaseline(root);
    if (reloaded.config.source === config.source) return;
    config = reloaded.config;
    index = createWorkspaceIndex(new Map(), config);
  }

  const documents = new TextDocuments(TextDocument);
  documents.listen(connection);
  documents.onDidChangeContent((event) => {
    const path = uriToPath(event.document.uri);
    if (path === null) return;
    scheduleValidation(path);
  });
  documents.onDidClose((event) => {
    // §10.3: discard the unsaved overlay and revalidate against the disk
    // snapshot, so a closed dirty buffer stops reporting what the file no longer
    // holds.
    const path = uriToPath(event.document.uri);
    if (path === null) return;
    const onDisk = readDocument(path);
    if (onDisk === null) {
      const { affected } = removeFile(index, path);
      publishAffected(new Set([...affected, path]));
      return;
    }
    const { affected } = updateFile(index, path, onDisk);
    publishAffected(new Set([...affected, path]));
  });

  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const pending = new Map<DocPath, ReturnType<typeof setTimeout>>();
  const warnedLarge = new Set<DocPath>();
  // Startup config diagnostics cannot be sent here: `startStdio` calls
  // `listen()` after `createServer`, and a request (showMessageRequest) sent
  // before listen throws. Queue them and surface them as `window/showMessage`
  // NOTIFICATIONS on `initialized`, when the connection is live.
  const startupDiagnostics = loaded.diagnostics.slice();

  function resolveText(path: DocPath): string | null {
    const document = documents.get(pathToUri(path, rootPath));
    return document ? document.getText() : readDocument(path);
  }

  /**
   * §13's degradation for one document: past the threshold the expensive layers
   * are skipped and the developer is told once, so an editor stays responsive
   * on a file the parse plus schema validation would stall.
   *
   * `validateNow` and `rescan` both route through here, which keeps the two
   * entry points from disagreeing about which documents get full validation —
   * the scan previously ran every rule on every file, so a repository's
   * startup cost depended on its largest document (review M3-a, Major-3).
   */
  function degradeLarge(path: DocPath): void {
    if (!warnedLarge.has(path)) {
      warnedLarge.add(path);
      void connection.sendNotification('window/showMessage', {
        type: 2,
        message: `mdlineage: ${path} is larger than ${MAX_DOCUMENT_BYTES} bytes; skipping validation`,
      });
    }
  }

  /** True when `text` crosses §13's degradation threshold. */
  function isLarge(text: string): boolean {
    return Buffer.byteLength(text, 'utf8') > MAX_DOCUMENT_BYTES;
  }

  /** Revalidate `paths` immediately, publishing every diagnostic they own. */
  function validateNow(paths: ReadonlyArray<DocPath>): void {
    const toPublish = new Set<DocPath>();
    for (const path of paths) {
      const text = resolveText(path);
      if (text === null) continue;
      // §13's degradation: a document past the threshold is indexed but its
      // expensive rules are not run, and the developer is told once.
      if (isLarge(text)) {
        degradeLarge(path);
        continue;
      }
      const { affected } = updateFile(index, path, text);
      toPublish.add(path);
      for (const p of affected) toPublish.add(p);
    }
    counters.validations++;
    publishAffected(toPublish);
  }

  /**
   * Publish diagnostics for the paths a change could have moved, clearing each
   * one first: an empty array means "clean" in LSP, and silence would mean the
   * previous report is still the truth.
   *
   * A document §13 degraded is published EMPTY, not skipped: the index still
   * holds it (completion and definition read it), and a stale diagnostic set
   * from before it grew past the threshold would outlive the state that
   * produced it.
   */
  function publishAffected(paths: ReadonlySet<DocPath>): void {
    for (const path of paths) publishOne(path);
  }

  function publishOne(path: DocPath): void {
    const uri = pathToUri(path, rootPath);
    const text = resolveText(path);
    const lines = text === null ? [] : text.split(/\r\n|\r|\n/);
    const diagnostics = text === null || isLarge(text) ? [] : validateWorkspace(index, { paths: [path], baseline: toBaselineSuppression(path) }).map((diag) => toLspDiagnostic(diag, lines));
    const params: PublishDiagnosticsParams = { uri, diagnostics };
    counters.diagnosticsPublished++;
    void connection.sendNotification('textDocument/publishDiagnostics', params);
  }

  /**
   * The index keys documents by absolute path, while the committed baseline keys
   * them relative to the repository root (the CLI's vocabulary, so one file
   * covers a tree checked out anywhere). Spell this path the baseline's way
   * before matching; outside the root the absolute spelling survives and simply
   * never matches an entry, same as the CLI's fallback.
   */
  function toBaselineSuppression(path: DocPath): Baseline | undefined {
    if (baseline === null) return undefined;
    const anchor = effectiveRoot();
    if (path === '') return baseline;
    const absolute = resolve(anchor, path);
    if (absolute !== anchor && !absolute.startsWith(anchor + sep)) return baseline;
    const key = relative(anchor, absolute).split(sep).join('/');
    return key === path ? baseline : { ...baseline, codes: spellKeys(baseline.codes, key, path) };
  }

/**
 * The directory the index, the config and the baseline all anchor to.
 *
 * `createServer` reads config and baseline from `options.rootPath` before
 * `initialize` has named a workspace folder, so the option is the only root
 * known at that point; once `initialize` arrives the client's folder is
 * authoritative (§10.3's scan roots there), and config and baseline must follow
 * it or the diagnostics would be validated against one tree and exempted by a
 * file of another. `null` while uninitialized keeps the option's value, which
 * is what the CLI's stdio entry and a smoke run rely on.
 */
let workspaceRoot: string | null = null;

function effectiveRoot(): string {
  return workspaceRoot ?? rootPath;
}

  /** §13: coalesce a burst of edits into one validation pass per path. */
  function scheduleValidation(path: DocPath): void {
    const existing = pending.get(path);
    if (existing !== undefined) clearTimeout(existing);
    const timer = setTimeout(() => {
      pending.delete(path);
      validateNow([path]);
    }, debounceMs);
    pending.set(path, timer);
  }

  connection.onInitialize((params) => {
    // The workspace folder is authoritative when the client names one; the
    // caller's `rootPath` is the test override. The scan runs before the result
    // is returned, so a client that opens a document right after `initialize`
    // sees the repository's diagnostics and not an empty index.
    const folders = params.workspaceFolders;
    const first = folders && folders.length > 0 ? uriToPath(folders[0]!.uri) : null;
    if (first !== null) {
      workspaceRoot = first;
      // The client's folder is authoritative for config and baseline too: the
      // diagnostics this index produces are this tree's, so the debt record
      // and the severity overrides that apply to them live in this tree.
      reconfigure(first);
    }
    const scanning = first !== null ? rescan(first) : rescan(effectiveRoot());
    return scanning.then(() => {
      // §10.2's feature set. Each declaration has a handler registered by
      // `registerLanguageFeatures` (features.ts); a client reads this table to
      // decide what to offer, so an unlisted feature stays unoffered even
      // though its handler exists. The LSP nests document-scoped providers
      // under `textDocument` and workspace-scoped ones at the root.
      const textDocument: Record<string, unknown> = {
        // Incremental sync: the client sends range-addressed contentChanges,
        // which `TextDocuments` applies to the in-memory overlay. The sync
        // contract is spelled out per LSP 3.17 — an absent `change` means None
        // and an absent `openClose` means false, so a strict client would
        // never push didOpen/didChange without these.
        synchronization: {
          dynamicRegistration: false,
          openClose: true,
          change: 2, // TextDocumentSyncKind.Incremental
          save: { includeText: false },
        },
        completion: {
          // ':' opens a value position (`type:` …) and ' ' continues a field
          // name or a value already begun; both are the points where the next
          // legal token is a small, knowable set.
          triggerCharacters: [':', ' '],
          resolveProvider: false,
        },
        definition: { dynamicRegistration: false },
        references: { dynamicRegistration: false },
        rename: { dynamicRegistration: false, prepareSupport: true },
        hover: { dynamicRegistration: false },
        documentSymbol: { dynamicRegistration: false, hierarchicalDocumentSymbolSupport: true },
        // §9.1's safe fixes: a code action returns TextEdits the client applies
        // only after the user picks it. Never an automatic write.
        codeAction: {
          dynamicRegistration: false,
          codeActionKinds: [CodeActionKind.QuickFix],
          resolveProvider: false,
        },
      };
      return {
        capabilities: {
          textDocument,
          workspace: {
            workspaceFolders: { supported: true, changeNotifications: true },
            symbol: { dynamicRegistration: false },
          },
        },
      };
    });
  });

  connection.onInitialized(() => {
    // Surface startup config diagnostics now: the connection is live, and a
    // notification (not showMessageRequest) needs no client round-trip.
    for (const message of startupDiagnostics) {
      void connection.sendNotification('window/showMessage', {
        type: 2,
        message: `mdlineage: ${message.code} ${message.message}`,
      });
    }
    // Ask the client to watch the repository: the index must learn about a file
    // an editor, a script or a git checkout changed outside this server's open
    // documents. Dynamic registration is optional on the client, so the watch
    // is a best-effort request, not an assumption.
    void connection.client
      .register(DidChangeWatchedFilesNotification.type, {
        watchers: [{ globPattern: '**/*.md' }],
      })
      .catch(() => {
        // A client that cannot watch keeps the initial scan; its diagnostics
        // stay correct for open documents and go stale for external ones.
      });
  });

  connection.onDidSaveTextDocument((event) => {
    // §10.3: the overlay becomes the committed snapshot. The index already holds
    // the same text (the change notifications led it), so this is a refresh that
    // also republishes the file's referrers.
    const path = uriToPath(event.textDocument.uri);
    if (path === null) return;
    validateNow([path]);
  });

  connection.onDidChangeWatchedFiles?.((params: DidChangeWatchedFilesParams) => {
    // An external create/change/delete/rename: apply it to the index and
    // revalidate who it affected. An OPEN document keeps its in-memory overlay —
    // the buffer is still the state the developer is editing, and the watcher's
    // content is not authoritative for it.
    for (const change of params.changes) handleWatchedFile(change);
  });

  function handleWatchedFile(change: { uri: string; type: number }): void {
    const path = uriToPath(change.uri);
    if (path === null || !isMarkdownUri(change.uri)) return;
    if (change.type === 3 /* Deleted */) {
      const { affected } = removeFile(index, path);
      publishAffected(new Set([...affected, path]));
      return;
    }
    if (documents.get(pathToUri(path, rootPath)) !== undefined) return;
    const text = readDocument(path);
    if (text === null) return;
    // The same degradation as every other entry point: a file an external
    // change grew past the threshold is indexed but not validated.
    if (isLarge(text)) degradeLarge(path);
    const { affected } = updateFile(index, path, text);
    publishAffected(new Set([...affected, path]));
  }

  /**
   * Build the initial index over the workspace, and rebuild it over a different
   * root when `initialize` names one.
   */
  function rescan(root: string): Promise<void> {
    // `setImmediate` hands the scan to the event loop instead of running it in
    // the notification that started it, so the connection's reader stays
    // responsive and a large tree's cost lands after `initialize` answers.
    scanPromise = new Promise<void>((fulfill) => {
      setImmediate(() => {
        for (const [path, content] of scanWorkspace(root, config)) {
          if (documents.get(pathToUri(path, rootPath)) !== undefined) continue;
          // §13's degradation applies to the scan too, not just to
          // `validateNow`: without this, a repository's startup cost was a
          // function of its largest document, and `initialize` answered only
          // after a multi-megabyte file's full rule stack ran (review M3-a,
          // Major-3). The document is still indexed — completion, definition
          // and symbol queries read it — only its expensive validation waits.
          if (isLarge(content)) degradeLarge(path);
          updateFile(index, path, content);
        }
        scanned = true;
        // The scan itself is silent (no per-file publish during indexing), so
        // once it lands the client gets one workspace-wide pass: without this,
        // a file nobody has opened would never see its diagnostics until it is
        // edited — which is exactly what the watched-files contract assumes.
        publishAffected(new Set(index.paths()));
        fulfill();
      });
    });
    return scanPromise;
  }

  const context: ServerContext = {
    connection,
    // Getters, not snapshots: `reconfigure` rebinds these `let`s when
    // `initialize` names a workspace folder, and a context that captured the
    // first binding would hand every M3-b handler the config and the index of
    // a tree the scan never validated (review M3-a, Major-4: the context kept
    // reporting config A after `initialize` pointed at B).
    get index(): WorkspaceIndex {
      return index;
    },
    get config(): Config {
      return config;
    },
    get baseline(): Baseline | null {
      return baseline;
    },
    rootPath,
    resolveText,
    validateNow,
  };
  // §10.2's handlers register against the live context. The default hooks carry
  // them; a caller passing its own hooks is the escape hatch for a host that
  // wants a different feature set on the same index.
  (options.hooks ?? { register: registerLanguageFeatures }).register?.(context);

  return {
    connection,
    context,
    get ready() {
      return scanned;
    },
    whenReady() {
      return scanPromise ?? Promise.resolve();
    },
    dispose() {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    },
  };
}

/**
 * Load the committed baseline (CLI semantics: the root's
 * `.mdlineage-baseline.json`, total suppression of what it covers).
 */
function loadServerBaseline(rootPath: string): Baseline | null {
  const path = resolve(rootPath, BASELINE_FILE_NAME);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  return parseBaseline(text).baseline;
}

/**
 * Re-spell a baseline's path keys from the root-relative vocabulary the file
 * carries into the index's absolute vocabulary for one document, so the
 * suppression comparison sees the same spelling both sides key documents by.
 *
 * The baseline is a read-only contract; a copy with translated keys is built
 * per publish rather than mutating the loaded file, which keeps one client's
 * diagnostics from rewriting the debt record another file's publish reads.
 */
function spellKeys(
  codes: Readonly<Record<string, readonly string[]>>,
  relativeKey: string,
  absoluteKey: string,
): Record<string, readonly string[]> {
  const out: Record<string, readonly string[]> = {};
  for (const [code, paths] of Object.entries(codes)) {
    out[code] = paths.map((p) => (p === relativeKey ? absoluteKey : p));
  }
  return out;
}

/**
 * Start the server over stdio. The CLI's `mdlineage server --stdio` calls this,
 * and nothing else in the monorepo does: the connection owns stdin/stdout from
 * here on, so a caller that wants to talk JSON-RPC must use `createServer`.
 *
 * `createConnection` reads `--stdio` from the process arguments itself (the LSP
 * Node transport's own convention), which is why the CLI routes the flag rather
 * than passing streams in.
 */
export function startStdio(options: ServerOptions = {}): Connection {
  // `createConnection` selects the stdio transport when the process arguments
  // name `--stdio` — the Node transport's own convention, and the reason the
  // CLI routes the flag rather than building streams itself. The streams
  // overload is the spelling the compiler can see; the runtime reads the flag.
  process.argv = process.argv.includes('--stdio') ? process.argv : [...process.argv, '--stdio'];
  const connection = createConnection(process.stdin as never, process.stdout as never);
  createServer(connection, options);
  connection.listen();
  return connection;
}
