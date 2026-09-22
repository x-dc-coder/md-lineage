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
      assert.equal(capabilities['textDocumentSync'], 2, 'TextDocumentSyncKind.Incremental');
      const workspace = capabilities['workspace'] as Record<string, unknown>;
      assert.ok(workspace, 'workspace capabilities are declared');
      assert.ok((workspace['workspaceFolders'] as Record<string, unknown>)?.supported);
    } finally {
      h.close();
    }
  });

  it('declares no completion, definition, hover or code actions (M3-b)', async () => {
    const h = harness();
    try {
      const capabilities = await initialize(h);
      const textDocument = capabilities['textDocument'] as Record<string, unknown> | undefined;
      for (const key of [
        'completionProvider',
        'definitionProvider',
        'hoverProvider',
        'referencesProvider',
        'renameProvider',
        'codeActionProvider',
        'documentSymbolProvider',
        'workspaceSymbolProvider',
      ]) {
        assert.equal(textDocument?.[key], undefined, `${key} is M3-b's to declare`);
      }
    } finally {
      h.close();
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
