/**
 * Language server tests over a real JSON-RPC stdio connection.
 *
 * The server runs as a child process speaking LSP-delimited JSON-RPC over
 * stdio — the transport a real editor uses — so every assertion crosses the
 * protocol boundary: Content-Length framing, `publishDiagnostics` serialized
 * and deserialized, `initialize` capabilities round-tripped. §14.4's
 * one-fixture-many-entries promise depends on it, and an in-process shortcut
 * could not prove the LSP entry emits the same code and range the CLI prints.
 *
 * Run with: node --import tsx --test packages/language-server/test/server.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..');
const serverEntry = resolve(repoRoot, 'packages', 'language-server', 'dist', 'server-entry.js');

/** A child process speaking LSP over stdio, plus the messages it has sent. */
interface Harness {
  /** Send a JSON-RPC message to the server. */
  send(message: Record<string, unknown>): void;
  /** Every message received so far, in arrival order. */
  received: ReceivedMessage[];
  /** The temp workspace the server was told to scan. */
  root: string;
  /** Stop the server and delete the workspace. */
  close(): void;
}

interface ReceivedMessage {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
}

/** `file://` URI of a path under the harness root. */
function uri(h: Harness, relative: string): string {
  return `file://${resolve(h.root, relative)}`;
}

/** `file://` URI from a raw path. */
function pathUri(path: string): string {
  return `file://${path}`;
}

/**
 * Start the server over stdio with `--stdio`, and wait for it to accept a
 * message. The server is the built `dist/main.js`, so the test exercises the
 * same code path the CLI's `mdlineage server --stdio` launches.
 *
 * `--root` is a test-only spelling the server accepts so a suite's temp tree is
 * the tree it scans; a real client names the same thing through
 * `initialize`'s `workspaceFolders`, which the tests also send.
 */
function harness(rootOverride?: string): Harness {
  const root = rootOverride ?? mkdtempSync(resolve(tmpdir(), 'mdl-lsp-'));
  mkdirSync(resolve(root, 'docs'), { recursive: true });
  const args = ['--stdio'];
  if (rootOverride) args.push('--root', rootOverride);
  const child = spawn(process.execPath, [serverEntry, ...args], {
    cwd: repoRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const received: ReceivedMessage[] = [];
  let buffer = Buffer.alloc(0);
  child.stdout.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) break;
      const header = buffer.subarray(0, headerEnd).toString('ascii');
      const match = /Content-Length: (\d+)/.exec(header);
      if (!match) break;
      const length = Number(match[1]);
      const start = headerEnd + 4;
      if (buffer.length < start + length) break;
      received.push(JSON.parse(buffer.subarray(start, start + length).toString('utf8')) as ReceivedMessage);
      buffer = buffer.subarray(start + length);
    }
  });
  // A server that dies mid-test must not leave a green run behind: surface the
  // reason instead of every later assertion timing out.
  child.stderr.on('data', (d: Buffer) => console.error('SERVER-STDERR:', d.toString().slice(0, 300)));
    child.on('error', (error) => {
    throw new Error(`the language server process failed: ${error.message}`);
  });

  return {
    root,
    received,
    send(message) {
      const text = JSON.stringify(message);
      child.stdin.write(`Content-Length: ${Buffer.byteLength(text, 'utf8')}\r\n\r\n${text}`);
    },
    close() {
      child.kill();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/**
 * Wait until a message of `method` arrives (or a response to `id`), flushing
 * the interval once it does.
 */
async function waitFor(
  h: Harness,
  predicate: (message: ReceivedMessage) => boolean,
  timeoutMs = 8000,
): Promise<ReceivedMessage> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = h.received.find(predicate);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error(`no matching message within ${timeoutMs}ms; received ${h.received.length} messages`);
}

/** Send initialize and the initialized notification, return the capabilities. */
async function initialize(h: Harness): Promise<Record<string, unknown>> {
  h.send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      processId: process.pid,
      rootUri: pathUri(h.root),
      workspaceFolders: [{ uri: pathUri(h.root), name: 'mdl' }],
      capabilities: {},
    },
  });
  const response = await waitFor(h, (m) => m.id === 1);
  h.send({ jsonrpc: '2.0', method: 'initialized', params: {} });
  return (response.result as { capabilities: Record<string, unknown> }).capabilities;
}

let nextRequestId = 2;

/**
 * Send a language-feature request and wait for its response.
 *
 * The features answer over the same JSON-RPC stream as the diagnostics, so a
 * request is matched by its id and the response is the feature's own contract:
 * the same shapes a client renders.
 */
async function request(
  h: Harness,
  method: string,
  params: Record<string, unknown>,
): Promise<{ result: unknown; error?: { message?: string } }> {
  const id = nextRequestId++;
  h.send({ jsonrpc: '2.0', id, method, params });
  const response = await waitFor(h, (m) => m.id === id);
  return { result: response.result, error: response.error as { message?: string } | undefined };
}

/** A cursor position in 0-based LSP coordinates. */
function at(line: number, character: number): { line: number; character: number } {
  return { line, character };
}

/**
 * A document of roughly `bytes` total size, past §13's degradation threshold.
 *
 * Headings and prose alternate, which is what a real large document looks
 * like; the scan's cost would dominate `initialize` without the degradation.
 */
function largeDocument(bytes: number): string {
  const head = ['---', 'mdlineage:', '  schema: 1', '  id: docs.huge', '  kind: policy', '  status: active', '---', '', ''].join('\n');
  const body: string[] = [];
  let total = head.length;
  for (let i = 0; total < bytes; i++) {
    const chunk = `## Section ${i}\n\ntext `.repeat(1) + 'word '.repeat(40) + '\n\n';
    body.push(chunk);
    total += chunk.length;
  }
  return head + body.join('');
}

/** The publishDiagnostics for `uri`, or null when none has arrived. */
function diagnosticsFor(h: Harness, uri: string): Array<{
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  severity: number;
  code: string;
  source: string;
  message: string;
}> {
  for (let i = h.received.length - 1; i >= 0; i--) {
    const message = h.received[i]!;
    if (message.method !== 'textDocument/publishDiagnostics') continue;
    const params = message.params as { uri: string; diagnostics: unknown[] };
    if (params.uri === uri) return params.diagnostics as never;
  }
  return [];
}

/** The last publishDiagnostics notification for a document. */
async function waitForDiagnostics(h: Harness, uri: string, timeoutMs = 8000): Promise<never[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = diagnosticsFor(h, uri);
    if (found.length > 0) return found as never[];
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error(`no publishDiagnostics for ${uri} within ${timeoutMs}ms`);
}

/**
 * Wait until the server has published a diagnostics set for `uri` — empty or
 * not.
 *
 * A request that reads the index must wait for the scan and the overlay to
 * land first, or it answers against a stale index. A VALID document publishes
 * an empty set, which is the state the feature tests start from, so this waits
 * for the notification itself rather than for a non-empty one.
 */
async function waitForDiagnosticsSet(h: Harness, uri: string, timeoutMs = 8000): Promise<void> {
  const baseline = h.received.length;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (let i = baseline; i < h.received.length; i++) {
      const message = h.received[i]!;
      if (message.method !== 'textDocument/publishDiagnostics') continue;
      if ((message.params as { uri: string }).uri === uri) return;
    }
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error(`no publishDiagnostics for ${uri} within ${timeoutMs}ms`);
}

/** A valid document, with a tweak per case. */
function doc(overrides: { id?: string; relations?: string; extra?: string } = {}): string {
  const lines = [
    '---',
    'mdlineage:',
    '  schema: 1',
    `  id: ${overrides.id ?? 'docs.probe'}`,
    '  kind: policy',
    '  status: active',
  ];
  if (overrides.relations) lines.push(overrides.relations);
  if (overrides.extra) lines.push(overrides.extra);
  lines.push('---', '', '# Probe', '');
  return lines.join('\n');
}

/** Send didOpen for a document. */
function didOpen(h: Harness, uri: string, version: number, text: string): void {
  h.send({
    jsonrpc: '2.0',
    method: 'textDocument/didOpen',
    params: { textDocument: { uri, languageId: 'markdown', version, text } },
  });
}

describe('initialize handshake', () => {
  it('declares incremental text document sync and workspace folders', async () => {
    const h = harness();
    try {
      const capabilities = await initialize(h);
      const textDocument = capabilities['textDocument'] as Record<string, unknown>;
      const sync = textDocument['synchronization'] as Record<string, unknown>;
      // The explicit sync contract (LSP 3.17): without `change` and
      // `openClose` a strict client never pushes didOpen/didChange, so the
      // whole diagnostics channel would be dead on arrival.
      assert.equal(sync['openClose'], true);
      assert.equal(sync['change'], 2, 'TextDocumentSyncKind.Incremental');
      assert.deepEqual(sync['save'], { includeText: false });
      assert.equal(sync['dynamicRegistration'], false);
      const workspace = capabilities['workspace'] as Record<string, unknown>;
      assert.ok(workspace, 'workspace capabilities are declared');
      assert.ok((workspace['workspaceFolders'] as Record<string, unknown>)?.supported);
    } finally {
      h.close();
    }
  });

  it('declares the §10.2 feature set (M3-b)', async () => {
    const h = harness();
    try {
      const capabilities = await initialize(h);
      const textDocument = capabilities['textDocument'] as Record<string, unknown>;
      assert.ok(textDocument, 'textDocument capabilities are present');
      for (const key of [
        'completion',
        'definition',
        'references',
        'rename',
        'hover',
        'documentSymbol',
        'codeAction',
      ]) {
        assert.ok(textDocument[key] !== undefined, `${key} is declared`);
      }
      assert.ok(
        (capabilities['workspace'] as Record<string, unknown>)['symbol'] !== undefined,
        'workspaceSymbolProvider is declared',
      );
      const completion = textDocument['completion'] as { triggerCharacters: string[] };
      assert.deepEqual(
        [...completion.triggerCharacters].sort(),
        [' ', ':'],
        'completion triggers on the field/value boundary and after a space',
      );
      const rename = textDocument['rename'] as { prepareSupport: boolean };
      assert.equal(rename.prepareSupport, true, 'rename prepares so an invalid id is refused early');
      const codeAction = textDocument['codeAction'] as { codeActionKinds: string[] };
      assert.deepEqual(codeAction.codeActionKinds, ['quickfix'], 'safe fixes only');
    } finally {
      h.close();
    }
  });

  it('keeps ServerContext live across a reconfigure (M4)', async () => {
    // Review M3-a, Major-4: `reconfigure` rebinds the config/index `let`s when
    // `initialize` names a workspace folder, and a context that snapshotted
    // them at registration would keep reporting the pre-reconfigure state. The
    // observable difference is a completion's vocabulary: the harness root is
    // created before the server is told about it, so the server's pre-handshake
    // guess loads the repo-root config (whose vocabulary omits `playground`)
    // and only the client's folder config supplies it — a live context answers
    // from the folder's, a stale one from the repo root's.
    const h = harness();
    try {
      writeFileSync(
        resolve(h.root, 'mdlineage.config.yaml'),
        'configVersion: 1\nvocabulary:\n  kinds: [policy, guide, playground]\n',
      );
      await initialize(h);
      const u = uri(h, 'docs/probe.md');
      didOpen(h, u, 1, doc());
      await waitForDiagnosticsSet(h, u);
      const response = await request(h, 'textDocument/completion', {
        textDocument: { uri: u },
        position: at(4, 9),
      });
      const items = ((response.result as { items: Array<{ label: string }> })?.items) ?? [];
      assert.ok(
        items.some((i) => i.label === 'playground'),
        'the context read the workspace folder\'s config, not the pre-handshake guess',
      );
    } finally {
      h.close();
    }
  });

  it('answers initialize within 3s for a tree containing a 3.7MB file (M5)', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'mdl-big-'));
    try {
      mkdirSync(resolve(root, 'docs'), { recursive: true });
      writeFileSync(resolve(root, 'docs/small.md'), doc({ id: 'docs.small' }));
      // A document past MAX_DOCUMENT_BYTES: §13 degrades it, so the scan
      // indexes it without running its expensive rules and `initialize` does
      // not pay the multi-second validation cost (review M3-a, Major-3/5).
      writeFileSync(resolve(root, 'docs/huge.md'), largeDocument(3.7 * 1024 * 1024));
      const h = harness(root);
      try {
        const started = Date.now();
        await initialize(h);
        const elapsed = Date.now() - started;
        assert.ok(elapsed < 3000, `initialize took ${elapsed}ms over a 3.7MB file`);
        // The degradation must be observable, not just fast: the huge file's
        // expensive rules are skipped, so no diagnostics may be published for
        // it, and the skip is announced exactly once.
        const hugeUri = 'file://' + resolve(root, 'docs/huge.md');
        const hugePublish = h.received.find((m) => (m.params as { uri?: string })?.uri === hugeUri);
        if (hugePublish !== undefined) {
          assert.deepEqual((hugePublish.params as { diagnostics: unknown[] }).diagnostics, []);
        }
        const skips = h.received.filter(
          (m) => m.method === 'window/showMessage' && String((m.params as { message?: string })?.message ?? '').includes('larger than'),
        );
        assert.ok(skips.length <= 1, `the skip notice fired ${skips.length} times, expected at most once`);
      } finally {
        h.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('didOpen publishes diagnostics', () => {
  it('reports MDL103 for a bad id, positioned by UTF-16 character on a Chinese+emoji line', async () => {
    const h = harness();
    try {
      await initialize(h);
      const content = [
        '---',
        'mdlineage:',
        '  schema: 1',
        '  id: 缓存😀策略',
        '  kind: policy',
        '  status: active',
        '---',
        '',
      ].join('\n');
      const u = uri(h, 'docs/probe.md');
      didOpen(h, u, 1, content);

      const diagnostics = await waitForDiagnostics(h, u);
      const bad = diagnostics.find((d) => d.code === 'MDL103');
      assert.ok(bad, 'an emoji id fails the pattern');
      assert.equal(bad!.source, 'mdlineage');
      assert.equal(bad!.severity, 1, 'DiagnosticSeverity.Error');
      assert.equal(bad!.range.start.line, 3, 'the id value is on 0-based line 3');
      // The id line is `  id: 缓存😀策略`. `缓存` is two BMP units and 😀 is
      // two more, so the LSP character must agree with the line's own UTF-16
      // length, and the range must sit inside it. A code-point or byte count
      // would place this diagnostic somewhere else entirely (§8.3).
      const idLine = content.split('\n')[3]!;
      assert.ok(bad!.range.start.character >= 6, 'the value begins after "  id: "');
      assert.ok(
        bad!.range.end.character <= idLine.length,
        `the end stays inside the line's ${idLine.length} UTF-16 units`,
      );
    } finally {
      h.close();
    }
  });

  it('publishes an empty diagnostic set for a clean document', async () => {
    const h = harness();
    try {
      await initialize(h);
      const u = uri(h, 'docs/clean.md');
      didOpen(h, u, 1, doc());
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        const found = diagnosticsFor(h, u);
        if (found.length === 0 && h.received.some((m) => m.method === 'textDocument/publishDiagnostics')) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.deepEqual(diagnosticsFor(h, u), [], 'a valid document carries no diagnostics');
    } finally {
      h.close();
    }
  });
});

describe('didChange', () => {
  it('clears diagnostics once the violation is fixed', async () => {
    const h = harness();
    try {
      await initialize(h);
      const u = uri(h, 'docs/probe.md');
      didOpen(h, u, 1, doc({ id: 'Docs.Bad_ID' }));
      assert.ok((await waitForDiagnostics(h, u)).some((d) => d.code === 'MDL103'));

      h.send({
        jsonrpc: '2.0',
        method: 'textDocument/didChange',
        params: {
          textDocument: { uri: u, version: 2 },
          contentChanges: [{ text: doc({ id: 'docs.fixed' }) }],
        },
      });
      // Wait for a publish that arrived AFTER the didChange was sent and that
      // carries the cleared set: matching the stale didOpen publish would race
      // the debounce and assert before the fixed state lands.
      const baseline = h.received.length;
      await waitFor(
        h,
        (m) =>
          m.method === 'textDocument/publishDiagnostics' &&
          (m.params as { uri: string }).uri === u &&
          h.received.indexOf(m) >= baseline,
      );
      assert.equal(diagnosticsFor(h, u).length, 0, 'the whole-document change repaired the id');
    } finally {
      h.close();
    }
  });

  it('applies a ranged incremental change to the right span', async () => {
    const h = harness();
    try {
      await initialize(h);
      const u = uri(h, 'docs/probe.md');
      didOpen(h, u, 1, doc({ id: 'docs.probe' }));
      await waitFor(h, (m) => m.method === 'textDocument/publishDiagnostics');

      // Replace `policy` with `bogus` on the kind line through a RANGE change:
      // line 4, characters 9..15 of `  kind: policy`. If the overlay applied the
      // edit to the wrong span the document would break in a different place
      // and the diagnostic would name a different field than the one edited.
      h.send({
        jsonrpc: '2.0',
        method: 'textDocument/didChange',
        params: {
          textDocument: { uri: u, version: 2 },
          contentChanges: [
            {
              range: { start: { line: 4, character: 9 }, end: { line: 4, character: 15 } },
              text: 'bogus',
            },
          ],
        },
      });
      const diagnostics = await waitForDiagnostics(h, u);
      const bad = diagnostics.find((d) => d.code === 'MDL103');
      assert.ok(bad, 'an unknown kind is a vocabulary failure');
      assert.match(bad!.message, /kind/i);
    } finally {
      h.close();
    }
  });

  it('debounces a burst of edits into one validation pass', async () => {
    // The debounce window is the server's own default (~200ms, §13), so this is
    // the real coalescing behaviour rather than a zero-delay stand-in.
    const h = harness();
    try {
      await initialize(h);
      const u = uri(h, 'docs/probe.md');
      didOpen(h, u, 1, doc({ id: 'docs.probe' }));
      await waitFor(h, (m) => m.method === 'textDocument/publishDiagnostics');

      // Count the diagnostic notifications FIVE rapid edits produce: a server
      // without a debounce would publish once per change.
      let published = 0;
      const baseline = h.received.length;
      for (let i = 0; i < 5; i++) {
        h.send({
          jsonrpc: '2.0',
          method: 'textDocument/didChange',
          params: {
            textDocument: { uri: u, version: 2 + i },
            contentChanges: [{ text: doc({ id: `docs.probe${i}` }) }],
          },
        });
        await new Promise((r) => setTimeout(r, 10));
      }
      // Give the debounce plus the validation time to land.
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        published = h.received
          .slice(baseline)
          .filter((m) => m.method === 'textDocument/publishDiagnostics').length;
        if (published > 0) await new Promise((r) => setTimeout(r, 400));
        break;
      }
      await new Promise((r) => setTimeout(r, 600));
      published = h.received.slice(baseline).filter((m) => m.method === 'textDocument/publishDiagnostics').length;

      assert.ok(published < 5, `five rapid changes produced ${published} publishes, not five`);
      assert.ok(published >= 1, 'the burst did produce a publish');
    } finally {
      h.close();
    }
  });
});

describe('didClose returns to the disk snapshot', () => {
  it('publishes the on-disk diagnostics after the overlay is dropped', async () => {
    const h = harness();
    try {
      writeFileSync(resolve(h.root, 'docs/probe.md'), doc({ id: 'Docs.Bad_ID' }));
      await initialize(h);
      const u = uri(h, 'docs/probe.md');
      didOpen(h, u, 1, doc({ id: 'docs.fixed' }));
      // The fixed buffer publishes an EMPTY set, so wait for the publish
      // itself (any) rather than waitForDiagnostics, which requires a
      // non-empty set and would time out on a clean document.
      const publishedAt = h.received.length;
      await waitFor(
        h,
        (m) =>
          m.method === 'textDocument/publishDiagnostics' &&
          (m.params as { uri: string }).uri === u &&
          h.received.indexOf(m) >= publishedAt,
      );
      assert.deepEqual(diagnosticsFor(h, u), [], 'the in-memory fix suppresses the error');

      h.send({ jsonrpc: '2.0', method: 'textDocument/didClose', params: { textDocument: { uri: u } } });
      const closedAt = h.received.length;
const closed = await waitFor(
        h,
        (m) =>
          m.method === 'textDocument/publishDiagnostics' &&
          (m.params as { uri: string }).uri === u &&
          h.received.indexOf(m) >= closedAt,
      );
      const closedDiagnostics = (closed.params as { diagnostics: Array<{ code: string }> }).diagnostics;
      assert.ok(closedDiagnostics.some((d) => d.code === 'MDL103'), 'the disk state has the bad id again');
    } finally {
      h.close();
    }
  });
});

describe('workspace/didChangeWatchedFiles', () => {
  it('publishes MDL302 on a referrer when its target is deleted', async () => {
    const h = harness();
    try {
      writeFileSync(resolve(h.root, 'docs/target.md'), doc({ id: 'docs.target' }));
      writeFileSync(
        resolve(h.root, 'docs/referrer.md'),
        doc({ id: 'docs.referrer', relations: '  relations:\n    - type: depends_on\n      target: docs.target\n      reason: needs it' }),
      );
      await initialize(h);
      const referrer = uri(h, 'docs/referrer.md');
      // The initial scan over the tree is what makes the referrer clean at first.
      await waitFor(h, () => diagnosticsFor(h, referrer).length === 0 || true);

      // An external delete: the referrer's MDL302 is the workspace layer's.
      h.send({
        jsonrpc: '2.0',
        method: 'workspace/didChangeWatchedFiles',
        params: { changes: [{ uri: uri(h, 'docs/target.md'), type: 3 /* Deleted */ }] },
      });
      const dangling = await waitForDiagnostics(h, referrer);
      assert.ok(dangling.some((d) => d.code === 'MDL302'), 'the target is gone, so the relation dangles');
    } finally {
      h.close();
    }
  });

  it('publishes a referrer when an external file resolves its target', async () => {
    const h = harness();
    try {
      writeFileSync(
        resolve(h.root, 'docs/referrer.md'),
        doc({ id: 'docs.referrer', relations: '  relations:\n    - type: depends_on\n      target: docs.target\n      reason: needs it' }),
      );
      await initialize(h);
      const referrer = uri(h, 'docs/referrer.md');
      // The startup publish already carries MDL302 over the scanned tree.
      assert.ok((await waitForDiagnostics(h, referrer)).some((d) => d.code === 'MDL302'), 'the target is absent at startup');

      writeFileSync(resolve(h.root, 'docs/target.md'), doc({ id: 'docs.target' }));
      h.send({
        jsonrpc: '2.0',
        method: 'workspace/didChangeWatchedFiles',
        params: { changes: [{ uri: uri(h, 'docs/target.md'), type: 1 /* Created */ }] },
      });
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        if (!diagnosticsFor(h, referrer).some((d) => d.code === 'MDL302')) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.ok(
        !diagnosticsFor(h, referrer).some((d) => d.code === 'MDL302'),
        'the newly created target resolves it',
      );
    } finally {
      h.close();
    }
  });
});

describe('severity mapping', () => {
  it('delivers all four LSP levels, including Information and Hint', async () => {
    // §9.1: the remark channel collapses Information and Hint into Warning; the
    // dedicated LSP is where §8.2's full four-level scale reaches the client.
    const h = harness();
    try {
      writeFileSync(
        resolve(h.root, 'mdlineage.config.yaml'),
        'configVersion: 1\ndiagnostics:\n  MDL103: hint\n  MDL104: information\n',
      );
      writeFileSync(
        resolve(h.root, 'docs/probe.md'),
        // `id` violates the pattern (MDL103) and `tpoics` is unknown (MDL104):
        // the override file below downgrades exactly these two codes, so the
        // fixture must actually trigger both for the severity mapping to be
        // observable.
        ['---', 'mdlineage:', '  schema: 1', '  id: Docs.Bad', '  kind: policy', '  status: active', '  tpoics: x', '---', ''].join('\n'),
      );
      await initialize(h);
      const u = uri(h, 'docs/probe.md');
      didOpen(h, u, 1, readFileSync(resolve(h.root, 'docs/probe.md'), 'utf8'));
      const diagnostics = await waitForDiagnostics(h, u);
      const byCode = new Map(diagnostics.map((d) => [d.code, d]));
      assert.equal(byCode.get('MDL103')?.severity, 4, 'config downgraded MDL103 to Hint');
      assert.equal(byCode.get('MDL104')?.severity, 3, 'config downgraded MDL104 to Information');
    } finally {
      h.close();
    }
  });
});

describe('baseline suppression', () => {
  it('silences a diagnostic the committed baseline accepts', async () => {
    const h = harness();
    try {
      writeFileSync(resolve(h.root, 'docs/probe.md'), doc({ id: 'Docs.Bad_ID' }));
      writeFileSync(
        resolve(h.root, '.mdlineage-baseline.json'),
        JSON.stringify(
          { version: 1, generatedAt: '2026-01-01T00:00:00.000Z', codes: { MDL103: ['docs/probe.md'] } },
          null,
          2,
        ) + '\n',
      );
      await initialize(h);
      const u = uri(h, 'docs/probe.md');
      didOpen(h, u, 1, doc({ id: 'Docs.Bad_ID' }));
      const deadline = Date.now() + 6000;
      while (Date.now() < deadline) {
        if (diagnosticsFor(h, u).length === 0 && h.received.some((m) => m.method === 'textDocument/publishDiagnostics')) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.deepEqual(diagnosticsFor(h, u), [], 'the baseline covers MDL103 for this path');
    } finally {
      h.close();
    }
  });

  it('still reports a violation the baseline does not cover', async () => {
    const h = harness();
    try {
      writeFileSync(resolve(h.root, 'docs/probe.md'), doc({ id: 'Docs.Bad_ID' }));
      // An entry for a DIFFERENT path: the same code, but not this document.
      writeFileSync(
        resolve(h.root, '.mdlineage-baseline.json'),
        JSON.stringify(
          { version: 1, generatedAt: '2026-01-01T00:00:00.000Z', codes: { MDL103: ['docs/other.md'] } },
          null,
          2,
        ) + '\n',
      );
      await initialize(h);
      const u = uri(h, 'docs/probe.md');
      didOpen(h, u, 1, doc({ id: 'Docs.Bad_ID' }));
      const diagnostics = await waitForDiagnostics(h, u);
      assert.ok(diagnostics.some((d) => d.code === 'MDL103'), 'the baseline does not cover this path');
    } finally {
      h.close();
    }
  });
});

describe('initial scan', () => {
  it('indexes the Markdown files under the root at startup', async () => {
    const h = harness();
    try {
      writeFileSync(resolve(h.root, 'docs/a.md'), doc({ id: 'docs.a' }));
      writeFileSync(resolve(h.root, 'docs/b.md'), doc({ id: 'docs.b' }));
      writeFileSync(resolve(h.root, 'not-markdown.txt'), 'no metadata here');
      await initialize(h);
      // The scan is part of initialize, so the index already holds the other
      // document: a link to a file the startup scan missed would report MDL401.
      const u = uri(h, 'docs/b.md');
      didOpen(h, u, 1, doc({ id: 'docs.b' }));
      await waitFor(h, (m) => m.method === 'textDocument/publishDiagnostics');
      assert.equal(diagnosticsFor(h, u).length, 0, 'a document whose target the scan indexed stays clean');
    } finally {
      h.close();
    }
  });

  it('skips node_modules and dist', async () => {
    const h = harness();
    try {
      mkdirSync(resolve(h.root, 'node_modules'), { recursive: true });
      mkdirSync(resolve(h.root, 'dist'), { recursive: true });
      writeFileSync(resolve(h.root, 'docs/a.md'), doc({ id: 'docs.a' }));
      writeFileSync(resolve(h.root, 'node_modules/dep.md'), doc({ id: 'docs.dep' }));
      writeFileSync(resolve(h.root, 'dist/out.md'), doc({ id: 'docs.out' }));
      await initialize(h);
      // An excluded tree never enters the index, so a link into it stays
      // unresolved instead of resolving against a dependency.
      const u = uri(h, 'docs/a.md');
      didOpen(h, u, 1, `${doc({ id: 'docs.link' })}\n[dep](node_modules/dep.md)\n`);
      const diagnostics = await waitForDiagnostics(h, u);
      assert.ok(
        diagnostics.some((d) => d.code === 'MDL401'),
        'a link into an excluded tree does not resolve',
      );
    } finally {
      h.close();
    }
  });
});

/** A two-document workspace: a referrer and its target, both clean. */
function linkedWorkspace(h: Harness): { referrer: string; target: string } {
  writeFileSync(
    resolve(h.root, 'docs/target.md'),
    ['---', 'mdlineage:', '  schema: 1', '  id: docs.target', '  kind: policy', '  status: active', '---', '', '# Target', '', '## Cache policy', ''].join('\n'),
  );
  writeFileSync(
    resolve(h.root, 'docs/referrer.md'),
    [
      '---', 'mdlineage:', '  schema: 1', '  id: docs.referrer', '  kind: policy', '  status: active',
      '  relations:', '    - type: depends_on', '      target: docs.target', '      reason: needs it',
      '---', '', '# Referrer', '',
    ].join('\n'),
  );
  return {
    referrer: uri(h, 'docs/referrer.md'),
    target: uri(h, 'docs/target.md'),
  };
}

describe('completion', () => {
  it('offers the config vocabulary at a `type:` value', async () => {
    const h = harness();
    try {
      linkedWorkspace(h);
      await initialize(h);
      const u = uri(h, 'docs/referrer.md');
      didOpen(h, u, 1, readFileSync(resolve(h.root, 'docs/referrer.md'), 'utf8'));
      await waitForDiagnosticsSet(h, u);
      // Line 7 is `    - type: depends_on`; the cursor sits just past the `:`,
      // where no value has been typed yet and the whole vocabulary applies.
      const response = await request(h, 'textDocument/completion', {
        textDocument: { uri: u },
        position: at(7, 12),
      });
      const items = ((response.result as { items: Array<{ label: string; detail?: string }> })?.items) ?? [];
      const labels = items.map((i) => i.label);
      assert.ok(labels.includes('depends_on'), 'the configured types are offered');
      assert.ok(labels.includes('related_to'), 'the whole vocabulary is offered');
      assert.equal(items[0]!.detail, 'The source document relies on a rule or fact in the target.');
    } finally {
      h.close();
    }
  });

  it('offers every known document id at a `target:` value', async () => {
    const h = harness();
    try {
      linkedWorkspace(h);
      await initialize(h);
      const u = uri(h, 'docs/referrer.md');
      didOpen(h, u, 1, readFileSync(resolve(h.root, 'docs/referrer.md'), 'utf8'));
      await waitForDiagnosticsSet(h, u);
      const response = await request(h, 'textDocument/completion', {
        textDocument: { uri: u },
        position: at(8, 20),
      });
      const items = ((response.result as { items: Array<{ label: string; detail?: string }> })?.items) ?? [];
      assert.ok(items.some((i) => i.label === 'docs.target'), 'the target id is offered');
      assert.match(items.find((i) => i.label === 'docs.target')!.detail!, /target\.md · active/);
    } finally {
      h.close();
    }
  });

  it('offers mdlineage field names while typing a key', async () => {
    const h = harness();
    try {
      await initialize(h);
      const u = uri(h, 'docs/probe.md');
      didOpen(h, u, 1, doc());
      await waitForDiagnosticsSet(h, u);
      const response = await request(h, 'textDocument/completion', {
        textDocument: { uri: u },
        position: at(4, 2),
      });
      const items = ((response.result as { items: Array<{ label: string; insertText?: string }> })?.items) ?? [];
      assert.ok(items.some((i) => i.label === 'authority'), 'the optional fields are offered too');
      assert.equal(items.find((i) => i.label === 'id')!.insertText, 'id: ', 'the value position opens with the key');
    } finally {
      h.close();
    }
  });

  it('offers the target document headings at an `evidence:` value', async () => {
    const h = harness();
    try {
      linkedWorkspace(h);
      await initialize(h);
      const text = [
        '---', 'mdlineage:', '  schema: 1', '  id: docs.t', '  kind: policy', '  status: active',
        '  relations:', '    - type: refines', '      target: docs.target', '      reason: why',
        '      evidence: #cache', '---', '', '# T', '',
      ].join('\n');
      const u = uri(h, 'docs/t.md');
      writeFileSync(resolve(h.root, 'docs/t.md'), text);
      didOpen(h, u, 1, text);
      await waitForDiagnosticsSet(h, u);
      const response = await request(h, 'textDocument/completion', {
        textDocument: { uri: u },
        position: at(10, 20),
      });
      const items = ((response.result as { items: Array<{ label: string; detail?: string }> })?.items) ?? [];
      assert.ok(items.some((i) => i.label === '#cache-policy'), 'the target document headings are offered');
    } finally {
      h.close();
    }
  });
});

describe('hover', () => {
  it('resolves a target id to its path and status', async () => {
    const h = harness();
    try {
      linkedWorkspace(h);
      await initialize(h);
      const u = uri(h, 'docs/referrer.md');
      didOpen(h, u, 1, readFileSync(resolve(h.root, 'docs/referrer.md'), 'utf8'));
      await waitForDiagnosticsSet(h, u);
      const response = await request(h, 'textDocument/hover', { textDocument: { uri: u }, position: at(8, 20) });
      const hover = response.result as { contents: { value: string } };
      assert.match(hover.contents.value, /docs\/target\.md · active/);
    } finally {
      h.close();
    }
  });

  it('documents a relation type', async () => {
    const h = harness();
    try {
      linkedWorkspace(h);
      await initialize(h);
      const u = uri(h, 'docs/referrer.md');
      didOpen(h, u, 1, readFileSync(resolve(h.root, 'docs/referrer.md'), 'utf8'));
      await waitForDiagnosticsSet(h, u);
      const response = await request(h, 'textDocument/hover', { textDocument: { uri: u }, position: at(7, 18) });
      const hover = response.result as { contents: { value: string } };
      assert.match(hover.contents.value, /relies on a rule or fact in the target/);
    } finally {
      h.close();
    }
  });
});

describe('definition', () => {
  it('jumps from a target value to the target document id line', async () => {
    const h = harness();
    try {
      linkedWorkspace(h);
      await initialize(h);
      const u = uri(h, 'docs/referrer.md');
      didOpen(h, u, 1, readFileSync(resolve(h.root, 'docs/referrer.md'), 'utf8'));
      await waitForDiagnosticsSet(h, u);
      const response = await request(h, 'textDocument/definition', { textDocument: { uri: u }, position: at(8, 20) });
      const locations = response.result as Array<{ uri: string; range: { start: { line: number } } }>;
      assert.equal(locations.length, 1, 'exactly one document claims the id');
      assert.equal(locations[0]!.uri, uri(h, 'docs/target.md'));
      assert.equal(locations[0]!.range.start.line, 3, 'the id value is on 0-based line 3');
    } finally {
      h.close();
    }
  });

  it('jumps from an evidence anchor to the target heading', async () => {
    const h = harness();
    try {
      linkedWorkspace(h);
      await initialize(h);
      const text = [
        '---', 'mdlineage:', '  schema: 1', '  id: docs.t', '  kind: policy', '  status: active',
        '  relations:', '    - type: refines', '      target: docs.target', '      reason: why',
        '      evidence: "#cache-policy"', '---', '', '# T', '',
      ].join('\n');
      const u = uri(h, 'docs/t.md');
      writeFileSync(resolve(h.root, 'docs/t.md'), text);
      didOpen(h, u, 1, text);
      await waitForDiagnosticsSet(h, u);
      const response = await request(h, 'textDocument/definition', { textDocument: { uri: u }, position: at(10, 20) });
      const locations = response.result as Array<{ uri: string; range: { start: { line: number } } }>;
      assert.equal(locations.length, 1);
      assert.equal(locations[0]!.uri, uri(h, 'docs/target.md'));
      assert.equal(locations[0]!.range.start.line, 10, '`## Cache policy` is on 0-based line 10');
    } finally {
      h.close();
    }
  });
});

describe('references', () => {
  it('lists every document whose relation points at an id', async () => {
    const h = harness();
    try {
      linkedWorkspace(h);
      await initialize(h);
      const target = uri(h, 'docs/target.md');
      didOpen(h, target, 1, readFileSync(resolve(h.root, 'docs/target.md'), 'utf8'));
      await waitForDiagnosticsSet(h, target);
      const response = await request(h, 'textDocument/references', {
        textDocument: { uri: target },
        position: at(3, 10),
        context: { includeDeclaration: true },
      });
      const locations = response.result as Array<{ uri: string; range: { start: { line: number } } }>;
      assert.ok(locations.some((l) => l.uri === uri(h, 'docs/target.md')), 'the declaration is included');
      assert.ok(locations.some((l) => l.uri === uri(h, 'docs/referrer.md')), 'the referrer is listed');
    } finally {
      h.close();
    }
  });
});

describe('rename', () => {
  it('renames an id and every referrer target', async () => {
    const h = harness();
    try {
      linkedWorkspace(h);
      await initialize(h);
      const target = uri(h, 'docs/target.md');
      didOpen(h, target, 1, readFileSync(resolve(h.root, 'docs/target.md'), 'utf8'));
      await waitForDiagnosticsSet(h, target);
      const response = await request(h, 'textDocument/rename', {
        textDocument: { uri: target },
        position: at(3, 10),
        newName: 'docs.target2',
      });
      const edit = response.result as { changes: Record<string, Array<{ range: { start: { line: number; character: number } }; newText: string }>> };
      const byUri = new Map(Object.entries(edit.changes));
      const own = byUri.get(target);
      const ref = byUri.get(uri(h, 'docs/referrer.md'));
      assert.ok(own && own[0]!.newText === 'docs.target2', 'the declaration is rewritten');
      assert.ok(ref && ref[0]!.newText === 'docs.target2', 'the referrer target value is rewritten');
      assert.equal(ref![0]!.range.start.line, 8, 'the edit lands on the target value line');
    } finally {
      h.close();
    }
  });

  it('refuses an id that breaks the v1 pattern', async () => {
    const h = harness();
    try {
      linkedWorkspace(h);
      await initialize(h);
      const target = uri(h, 'docs/target.md');
      didOpen(h, target, 1, readFileSync(resolve(h.root, 'docs/target.md'), 'utf8'));
      await waitForDiagnosticsSet(h, target);
      const response = await request(h, 'textDocument/rename', {
        textDocument: { uri: target },
        position: at(3, 10),
        newName: 'Docs.BAD_ID',
      });
      assert.ok(response.error, 'an invalid id is an error, not a silent edit');
      assert.match(response.error!.message ?? '', /Invalid mdlineage id/);
    } finally {
      h.close();
    }
  });
});

describe('symbols', () => {
  it('outlines the mdlineage block and the headings', async () => {
    const h = harness();
    try {
      await initialize(h);
      const u = uri(h, 'docs/probe.md');
      didOpen(h, u, 1, doc());
      await waitForDiagnosticsSet(h, u);
      const response = await request(h, 'textDocument/documentSymbol', { textDocument: { uri: u } });
      const symbols = response.result as Array<{ name: string; kind: number; children?: Array<{ name: string }> }>;
      const block = symbols.find((s) => s.name === 'mdlineage');
      assert.ok(block, 'the metadata block is a symbol');
      assert.deepEqual(block!.children!.map((c) => c.name), ['schema', 'id', 'kind', 'status'], 'each authored field is a child');
      assert.ok(symbols.some((s) => s.name === 'Probe'), 'the body heading is a symbol');
    } finally {
      h.close();
    }
  });

  it('finds ids and aliases case-insensitively across the workspace', async () => {
    const h = harness();
    try {
      writeFileSync(
        resolve(h.root, 'docs/a.md'),
        ['---', 'mdlineage:', '  schema: 1', '  id: docs.cache-policy', '  kind: policy', '  status: active', '  aliases:', '    - Cache TTL', '---', '', '# A', ''].join('\n'),
      );
      await initialize(h);
      const response = await request(h, 'workspace/symbol', { query: 'CACHE' });
      const symbols = response.result as Array<{ name: string; location: { uri: string } }>;
      assert.ok(symbols.some((s) => s.name === 'docs.cache-policy'), 'the id matches');
      assert.ok(symbols.length >= 1, 'the alias matched too');
    } finally {
      h.close();
    }
  });
});

describe('code actions', () => {
  it('deletes an unknown mdlineage field (MDL104)', async () => {
    const h = harness();
    try {
      const text = [
        '---', 'mdlineage:', '  schema: 1', '  id: docs.probe', '  kind: policy', '  tpoics: x',
        '---', '', '# Probe', '',
      ].join('\n');
      writeFileSync(resolve(h.root, 'docs/probe.md'), text);
      await initialize(h);
      const u = uri(h, 'docs/probe.md');
      didOpen(h, u, 1, text);
      await waitForDiagnosticsSet(h, u);
      const diagnostics = diagnosticsFor(h, u);
      const response = await request(h, 'textDocument/codeAction', {
        textDocument: { uri: u },
        range: { start: at(5, 0), end: at(5, 12) },
        context: { diagnostics: diagnostics as never },
      });
      const actions = response.result as Array<{ title: string; edit: { changes: Record<string, Array<{ range: { start: { line: number } }; newText: string }>> } }>;
      const remove = actions.find((a) => a.title.includes('unknown'));
      assert.ok(remove, 'the MDL104 fix is offered');
      const edits = remove!.edit.changes[u]!;
      assert.equal(edits[0]!.newText, '', 'the fix is a deletion');
      assert.equal(edits[0]!.range.start.line, 5, 'the offending line is removed');
    } finally {
      h.close();
    }
  });

  it('inserts a skeleton for a missing required field (MDL102)', async () => {
    const h = harness();
    try {
      const text = [
        '---', 'mdlineage:', '  schema: 1', '  id: docs.probe', '  kind: policy',
        '  relations:', '    - type: depends_on', '      target: docs.other', '      reason: needs it',
        '---', '', '# Probe', '',
      ].join('\n');
      writeFileSync(resolve(h.root, 'docs/probe.md'), text);
      await initialize(h);
      const u = uri(h, 'docs/probe.md');
      didOpen(h, u, 1, text);
      await waitForDiagnosticsSet(h, u);
      const diagnostics = diagnosticsFor(h, u);
      const response = await request(h, 'textDocument/codeAction', {
        textDocument: { uri: u },
        range: { start: at(2, 0), end: at(2, 12) },
        context: { diagnostics: diagnostics as never },
      });
      const actions = response.result as Array<{ title: string; edit: { changes: Record<string, Array<{ range: { start: { line: number } }; newText: string }>> } }>;
      const insert = actions.find((a) => a.title.includes('missing'));
      assert.ok(insert, 'the MDL102 fix is offered');
      const edits = insert!.edit.changes[u]!;
      assert.equal(edits[0]!.newText, '  status: draft\n', 'the vocabulary first value is inserted');
      assert.ok(edits[0]!.range.start.line <= 5, 'the skeleton stays inside the mdlineage block');
    } finally {
      h.close();
    }
  });
});
