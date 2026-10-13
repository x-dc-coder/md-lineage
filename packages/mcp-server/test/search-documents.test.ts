/**
 * MCP `search_documents`. The default suite never loads a model: lexical
 * stays lexical, and hybrid against an empty model directory degrades.
 * A real hybrid call is gated by MDLINEAGE_EMBED_TESTS=1.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { connectToTransport, createContext } from '../src/server.js';

interface Harness {
  client: Client;
  close(): Promise<void>;
}

async function harness(root: string, modelDir?: string): Promise<Harness> {
  const context = createContext(root, undefined, modelDir);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'mdlineage-search-test', version: '0.0.0' });
  await connectToTransport(context, serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    async close() {
      await client.close();
    },
  };
}

function corpus(): string {
  const root = mkdtempSync(join(tmpdir(), 'mdl-mcp-search-'));
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(
    join(root, 'docs', 'search-engine.md'),
    [
      '---',
      'mdlineage:',
      '  schema: 1',
      '  id: docs.fixtures.search-engine',
      '  kind: reference',
      '  status: active',
      '---',
      '# 检索引擎',
      '',
      'BM25 是词法检索的经典打分函数。',
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    join(root, 'docs', 'weather.md'),
    [
      '---',
      'mdlineage:',
      '  schema: 1',
      '  id: docs.fixtures.weather',
      '  kind: guide',
      '  status: active',
      '---',
      '# 天气',
      '',
      '明天北京有小雨，最高气温十二度。',
      '',
    ].join('\n'),
    'utf8',
  );
  return root;
}

interface SearchPayload {
  readonly mode: string;
  readonly degraded: readonly string[];
  readonly results: readonly { readonly path: string; readonly rank: number }[];
}

function isSearchPayload(value: unknown): value is SearchPayload {
  if (typeof value !== 'object' || value === null) return false;
  if (!('mode' in value) || typeof value.mode !== 'string') return false;
  if (!('degraded' in value) || !Array.isArray(value.degraded)) return false;
  if (!value.degraded.every((note) => typeof note === 'string')) return false;
  if (!('results' in value) || !Array.isArray(value.results)) return false;
  return value.results.every(
    (hit) =>
      typeof hit === 'object' &&
      hit !== null &&
      'path' in hit &&
      typeof hit.path === 'string' &&
      'rank' in hit &&
      typeof hit.rank === 'number',
  );
}

async function search(
  h: Harness,
  args: { query: string; top_k?: number; mode?: 'lexical' | 'hybrid' },
): Promise<SearchPayload> {
  const result = await h.client.callTool({ name: 'search_documents', arguments: args });
  const content: unknown = result.content;
  if (!Array.isArray(content)) throw new Error('search_documents returned no content');
  const block = content.find(
    (item) => typeof item === 'object' && item !== null && 'type' in item && item.type === 'text' && 'text' in item,
  );
  const text = typeof block === 'object' && block !== null && 'text' in block ? block.text : undefined;
  assert.equal(typeof text, 'string');
  const parsed: unknown = JSON.parse(typeof text === 'string' ? text : '');
  assert.equal(isSearchPayload(parsed), true);
  if (!isSearchPayload(parsed)) throw new Error('search payload was not an object');
  return parsed;
}

describe('MCP search_documents', () => {
  it('lexical search ranks the matching section and does not open a model', async () => {
    const root = corpus();
    const models = mkdtempSync(join(tmpdir(), 'mdl-mcp-models-'));
    const h = await harness(root, models);
    try {
      const payload = await search(h, { query: 'BM25 打分', mode: 'lexical', top_k: 5 });
      assert.equal(payload.mode, 'lexical');
      assert.deepEqual(payload.degraded, []);
      assert.match(payload.results[0]?.path ?? '', /search-engine\.md$/);
    } finally {
      await h.close();
      rmSync(root, { recursive: true, force: true });
      rmSync(models, { recursive: true, force: true });
    }
  });

  it('hybrid without weights falls back to lexical and says so', async () => {
    const root = corpus();
    const models = mkdtempSync(join(tmpdir(), 'mdl-mcp-models-'));
    const h = await harness(root, models);
    try {
      const payload = await search(h, { query: 'BM25 打分', mode: 'hybrid' });
      assert.equal(payload.mode, 'lexical');
      assert.ok(payload.degraded.some((note) => note.includes('falling back to lexical')));
      assert.match(payload.results[0]?.path ?? '', /search-engine\.md$/);
    } finally {
      await h.close();
      rmSync(root, { recursive: true, force: true });
      rmSync(models, { recursive: true, force: true });
    }
  });

  it('hybrid with a local model returns hybrid hits', { skip: process.env.MDLINEAGE_EMBED_TESTS !== '1' }, async () => {
    const root = corpus();
    const h = await harness(root);
    try {
      const payload = await search(h, { query: 'BM25 是什么', mode: 'hybrid', top_k: 2 });
      assert.equal(payload.mode, 'hybrid');
      assert.match(payload.results[0]?.path ?? '', /search-engine\.md$/);
    } finally {
      await h.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('MCP `discover_relations`', () => {
  it('discovers candidate pairs across the corpus in lexical mode', async () => {
    const root = corpus();
    const h = await harness(root);
    try {
      const result = await h.client.callTool({
        name: 'discover_relations',
        arguments: { mode: 'lexical', top_k: 5 },
      });
      assert.equal(result.isError, undefined);
      const text = (result.content as Array<{ text: string }>)[0]?.text ?? '{}';
      const payload = JSON.parse(text);
      assert.equal(payload.mode, 'lexical');
      assert.ok(Array.isArray(payload.pairs));
    } finally {
      await h.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
