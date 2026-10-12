/**
 * Hybrid pipeline tests. The embedder and reranker are fakes: this file
 * performs no network access and loads no model.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileVectorStore, searchCorpus, type EmbeddingProvider, type RerankProvider } from '../src/index.js';

const QUERY = 'uniquelexicaltoken';

function section(path: string, text: string) {
  return { path, slug: 's', title: path, text };
}

/** Query and the dense-only document share an axis; everything else is orthogonal. */
function vectorFor(text: string): number[] {
  if (text === QUERY || text.includes('DENSE_TARGET')) return [1, 0, 0, 0];
  return [0, 1, 0, 0];
}

class FakeEmbedder implements EmbeddingProvider {
  readonly meta = { model: 'fake', dtype: 'q8', dim: 4 };
  documentCalls = 0;
  queryCalls = 0;
  async embed(inputs: readonly string[]) {
    this.documentCalls += 1;
    return { vectors: inputs.map((text) => vectorFor(text)), degraded: [] as string[] };
  }
  async embedQuery(query: string) {
    this.queryCalls += 1;
    return { vectors: [vectorFor(query)], degraded: [] as string[] };
  }
  async dispose(): Promise<void> {}
}

const LEXICAL = section('a.md', `alpha ${QUERY} beta`);
const DENSE_ONLY = section('b.md', 'DENSE_TARGET and nothing else');

test('searchCorpus — lexical mode ranks the BM25 hit and ignores the embedder', async () => {
  const embedder = new FakeEmbedder();
  const outcome = await searchCorpus({
    query: QUERY,
    sections: [LEXICAL, DENSE_ONLY],
    top: 5,
    mode: 'lexical',
    embedder,
  });
  assert.equal(outcome.mode, 'lexical');
  assert.deepEqual(outcome.degraded, []);
  assert.equal(outcome.hits[0]?.path, 'a.md');
  assert.ok(outcome.hits.every((hit) => hit.path !== 'b.md'));
  assert.equal(embedder.documentCalls, 0);
  assert.equal(embedder.queryCalls, 0);
});

test('searchCorpus — hybrid recalls a dense-only section and reuses the vector cache', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mdl-pipeline-'));
  const embedder = new FakeEmbedder();
  const store = new FileVectorStore(root, embedder.meta);
  try {
    const first = await searchCorpus({
      query: QUERY,
      sections: [LEXICAL, DENSE_ONLY],
      top: 5,
      mode: 'hybrid',
      embedder,
      store,
      reranker: null,
    });
    assert.equal(first.mode, 'hybrid');
    assert.ok(first.hits.some((hit) => hit.path === 'b.md'));
    assert.equal(embedder.documentCalls, 1);
    assert.equal(embedder.queryCalls, 1);

    const second = await searchCorpus({
      query: QUERY,
      sections: [LEXICAL, DENSE_ONLY],
      top: 5,
      mode: 'hybrid',
      embedder,
      store,
      reranker: null,
    });
    assert.ok(second.hits.some((hit) => hit.path === 'b.md'));
    // Documents came from the cache; the query was embedded again.
    assert.equal(embedder.documentCalls, 1);
    assert.equal(embedder.queryCalls, 2);
    assert.ok(store.meta().blobs >= 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('searchCorpus — rerank reorders the fused window', async () => {
  const embedder = new FakeEmbedder();
  const reranker: RerankProvider = {
    async rerank(_query, candidates) {
      return {
        scores: candidates.map((candidate) => (candidate.text.includes('DENSE_TARGET') ? 0.9 : 0.1)),
        degraded: [],
      };
    },
    async dispose() {},
  };
  const outcome = await searchCorpus({
    query: QUERY,
    sections: [LEXICAL, DENSE_ONLY],
    top: 5,
    mode: 'hybrid',
    embedder,
    reranker,
    rerankDepth: 50,
  });
  assert.equal(outcome.hits[0]?.path, 'b.md');
  assert.deepEqual(outcome.degraded, []);
});

test('searchCorpus — a rerank timeout keeps the fused order and records the skip', async () => {
  const embedder = new FakeEmbedder();
  const hanging: RerankProvider = {
    rerank() {
      return new Promise(() => undefined);
    },
    async dispose() {},
  };
  const baseline = await searchCorpus({
    query: QUERY,
    sections: [LEXICAL, DENSE_ONLY],
    top: 5,
    mode: 'hybrid',
    embedder,
    reranker: null,
  });
  const timed = await searchCorpus({
    query: QUERY,
    sections: [LEXICAL, DENSE_ONLY],
    top: 5,
    mode: 'hybrid',
    embedder,
    reranker: hanging,
    rerankTimeoutMs: 30,
  });
  assert.deepEqual(
    timed.hits.map((hit) => hit.path),
    baseline.hits.map((hit) => hit.path),
  );
  assert.ok(timed.degraded.some((note) => note.startsWith('rerank-timeout:')));
  assert.equal(timed.mode, 'hybrid');
});

test('searchCorpus — a short embed batch keeps the prefix and notes the gap', async () => {
  const embedder: EmbeddingProvider = {
    meta: { model: 'fake', dtype: 'q8', dim: 4 },
    async embed(inputs) {
      const first = inputs[0];
      return {
        vectors: first === undefined ? [] : [vectorFor(first)],
        degraded: ['upstream partial'],
      };
    },
    async embedQuery(query) {
      return { vectors: [vectorFor(query)], degraded: [] };
    },
    async dispose() {},
  };
  const outcome = await searchCorpus({
    query: QUERY,
    sections: [LEXICAL, DENSE_ONLY],
    top: 5,
    mode: 'hybrid',
    embedder,
    reranker: null,
  });
  assert.equal(outcome.mode, 'hybrid');
  assert.ok(outcome.degraded.some((note) => note.includes('embeddings-partial')));
});
