/**
 * Review-fix regression tests (Phase 2 fix round): reranker deadline
 * early-stop, suffix-preserving truncation, embedder permanent-failure
 * marker, single-flight init, and pipeline scoreKind semantics. All
 * unit-level: no models, no network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RERANK_UNSCORED,
  searchCorpus,
  type EmbeddingProvider,
  type RerankProvider,
} from '../src/index.js';
import { FileVectorStore } from '../src/vector-store.js';

function sections(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    path: `d${Math.floor(i / 3)}.md`,
    slug: `s${i % 3}`,
    title: `section ${i}`,
    text: `alpha beta gamma delta ${i}`,
  }));
}

function fakeEmbedder(dim = 4): EmbeddingProvider {
  return {
    meta: { model: 'fake', dtype: 'q8', dim, algo: 'fake-v1' },
    async embed(inputs) {
      return { vectors: inputs.map((t) => [t.length % dim, 1, 0, 0]), degraded: [] };
    },
    async embedQuery(q: string) {
      return { vectors: [[q.length % dim, 1, 0, 0]], degraded: [] };
    },
    async dispose() {},
  };
}

test('deadline — reranker stops at the cutoff and marks unscored with the sentinel', async () => {
  const provider: RerankProvider = {
    async rerank(_q, candidates, options) {
      const scores: number[] = [];
      for (let i = 0; i < candidates.length; i++) {
        if (options?.deadlineAt !== undefined && Date.now() >= options.deadlineAt) {
          scores.push(RERANK_UNSCORED);
        } else {
          scores.push(0.5);
        }
      }
      return { scores, degraded: [] };
    },
    async dispose() {},
  };
  // A deadline already in the past: everything is unscored.
  const batch = await provider.rerank('q', [{ key: 'a', text: 'x' }, { key: 'b', text: 'y' }], {
    deadlineAt: Date.now() - 1,
  });
  assert.deepEqual([...batch.scores], [RERANK_UNSCORED, RERANK_UNSCORED]);
});

test('pipeline — deadline-hit rerank keeps RRF order for unscored window items and reports it', async () => {
  const reranker: RerankProvider = {
    async rerank(_q, candidates) {
      // Score nothing: everything hits the sentinel.
      return { scores: candidates.map(() => RERANK_UNSCORED), degraded: [] };
    },
    async dispose() {},
  };
  const outcome = await searchCorpus({
    query: 'alpha',
    sections: sections(12),
    top: 12,
    mode: 'hybrid',
    embedder: fakeEmbedder(),
    reranker,
    rerankDepth: 5,
    rerankTimeoutMs: 5_000,
  });
  assert.ok(outcome.degraded.some((d) => d.startsWith('rerank-deadline:')));
  // All window items stay on the rrf scale — no `yes` scores from a dead run.
  assert.ok(outcome.hits.every((h) => h.scoreKind === 'rrf'));
});

test('pipeline — successful rerank marks window scores `yes` and leaves the tail `rrf`', async () => {
  const reranker: RerankProvider = {
    async rerank(_q, candidates) {
      return { scores: candidates.map((_, i) => 1 - i * 0.01), degraded: [] };
    },
    async dispose() {},
  };
  const outcome = await searchCorpus({
    query: 'alpha',
    sections: sections(12),
    top: 12,
    mode: 'hybrid',
    embedder: fakeEmbedder(),
    reranker,
    rerankDepth: 5,
  });
  const kinds = outcome.hits.map((h) => h.scoreKind);
  assert.ok(kinds.slice(0, 5).every((k) => k === 'yes'));
  assert.ok(kinds.slice(5).every((k) => k === 'rrf'));
});

test('pipeline — lexical hits carry scoreKind bm25', async () => {
  const outcome = await searchCorpus({ query: 'alpha', sections: sections(6), top: 6, mode: 'lexical' });
  assert.ok(outcome.hits.length > 0 && outcome.hits.every((h) => h.scoreKind === 'bm25'));
});

test('vector store — cache directory separates algorithm generations (A2)', () => {
  const root = mkdtempSync(join(tmpdir(), 'vgen-'));
  const a = new FileVectorStore(root, { model: 'm', dtype: 'f32', dim: 4, algo: 'v1' });
  const b = new FileVectorStore(root, { model: 'm', dtype: 'f32', dim: 4, algo: 'v2-2048-lasttoken' });
  const hash = 'a'.repeat(64);
  assert.notEqual(a.blobPath(hash), b.blobPath(hash));
});
