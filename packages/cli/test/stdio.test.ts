/**
 * Real-subprocess tests for the stdio service routes (server / mcp) and the
 * suggest command, plus the missing-transport error path.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..');
const cliBin = resolve(repoRoot, 'packages', 'cli', 'dist', 'main.js');

const TIMEOUT_MS = 15_000;

/** Raw RPC transport: LSP uses Content-Length frames, MCP uses newline-delimited JSON. */
class Rpc {
  private buffer = '';
  private messages: any[] = [];
  constructor(
    private readonly proc: ReturnType<typeof spawn>,
    private readonly mode: 'lsp' | 'mcp',
  ) {
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => this.onData(chunk));
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      if (this.mode === 'lsp') {
        const headerEnd = this.buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) return;
        const m = /^Content-Length:\s*(\d+)/i.exec(this.buffer.slice(0, headerEnd));
        if (!m) throw new Error(`bad LSP header: ${this.buffer.slice(0, headerEnd)}`);
        const len = Number(m[1]);
        if (this.buffer.length < headerEnd + 4 + len) return;
        const body = this.buffer.slice(headerEnd + 4, headerEnd + 4 + len);
        this.buffer = this.buffer.slice(headerEnd + 4 + len);
        this.messages.push(JSON.parse(body));
      } else {
        const nl = this.buffer.indexOf('\n');
        if (nl === -1) return;
        const body = this.buffer.slice(0, nl);
        this.buffer = this.buffer.slice(nl + 1);
        if (body.trim()) this.messages.push(JSON.parse(body));
      }
    }
  }

  send(msg: object): void {
    const json = JSON.stringify(msg);
    const payload = this.mode === 'lsp' ? `Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}` : `${json}\n`;
    this.proc.stdin.write(payload);
  }

  /** Send a request and poll for the response with the matching id. */
  request(msg: object, id: number | string): Promise<any> {
    this.send(msg);
    return new Promise((res, rej) => {
      const started = Date.now();
      const poll = setInterval(() => {
        const i = this.messages.findIndex((m) => m.id === id);
        if (i !== -1) {
          clearInterval(poll);
          res(this.messages.splice(i, 1)[0]);
        } else if (Date.now() - started > TIMEOUT_MS) {
          clearInterval(poll);
          rej(new Error(`rpc response timeout for id ${id}`));
        }
      }, 10);
    });
  }
}

/** Spawn a stdio child; returns proc plus an rpc helper. Always SIGKILL in finally. */
function startService(args: string[]): { proc: ReturnType<typeof spawn>; rpc: Rpc } {
  const proc = spawn(process.execPath, [cliBin, ...args], { cwd: repoRoot, stdio: ['pipe', 'pipe', 'pipe'] });
  const mode = args[0] === 'server' ? 'lsp' : 'mcp';
  const rpc = new Rpc(proc, mode as 'lsp' | 'mcp');
  return { proc, rpc };
}

function kill(proc: ReturnType<typeof spawn>): void {
  if (!proc.killed && proc.exitCode === null) proc.kill('SIGKILL');
}

describe('server --stdio (LSP)', () => {
  it('completes initialize and reports textDocumentSync', async () => {
    const { proc, rpc } = startService(['server', '--stdio']);
    try {
      const res = await rpc.request(
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { processId: process.pid, capabilities: {}, rootUri: null },
        },
        1,
      );
      assert.equal(res.id, 1);
      assert.ok(res.result, 'initialize should return a result');
      assert.ok(res.result.capabilities, 'capabilities missing');
      assert.ok('textDocumentSync' in res.result.capabilities, 'textDocumentSync missing');
    } finally {
      kill(proc);
    }
  });
});

describe('mcp --stdio (MCP)', () => {
  it('initializes and lists exactly 7 tools', async () => {
    const { proc, rpc } = startService(['mcp', '--stdio']);
    try {
      const init = await rpc.request(
        {
          jsonrpc: '2.0',
          id: 10,
          method: 'initialize',
          params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
        },
        10,
      );
      assert.ok(init.result.serverInfo, 'serverInfo missing');
      rpc.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      const tools = await rpc.request({ jsonrpc: '2.0', id: 11, method: 'tools/list' }, 11);
      const names = tools.result.tools.map((t: { name: string }) => t.name);
      assert.equal(names.length, 7);
      assert.ok(names.includes('validate_document'));
      assert.ok(names.includes('apply_metadata_patch'));
    } finally {
      kill(proc);
    }
  });

  it('exits non-zero without --stdio', () => {
    const r = spawnSync(process.execPath, [cliBin, 'mcp'], { cwd: repoRoot, encoding: 'utf8' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /unknown mcp transport/i);
  });
});

describe('suggest', () => {
  it('emits parseable JSON proposal output', () => {
    const fixture = 'test/fixtures/invalid/e07-missing-kind-status.md';
    const r = spawnSync(process.execPath, [cliBin, 'suggest', fixture], { cwd: repoRoot, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.path, fixture);
    assert.ok(Array.isArray(out.operations));
    assert.ok(Array.isArray(out.addresses));
    assert.ok(out.addresses.includes('MDL102'));
    assert.equal(typeof out.generator, 'string');
  });
});
