/**
 * Real local inference. Skipped unless MDLINEAGE_EMBED_TESTS=1, and skipped
 * again when the weights are not on disk, so the default suite stays offline.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openLocalRetrieval } from '../src/index.js';

const gated = process.env.MDLINEAGE_EMBED_TESTS === '1';

test(
  'embedQuery is a unit 1024-vector and the reranker prefers the relevant sentence',
  { skip: !gated },
  async (t) => {
    const opened = await openLocalRetrieval();
    if (!opened.ready || opened.embedder === null || opened.reranker === null) {
      t.skip('local models are not installed');
      return;
    }
    try {
      const batch = await opened.embedder.embedQuery('BM25 检索如何打分');
      assert.equal(batch.vectors.length, 1);
      const vector = batch.vectors[0];
      assert.ok(vector !== undefined);
      assert.equal(vector.length, 1024);
      const norm = Math.hypot(...vector);
      assert.ok(Math.abs(norm - 1) < 1e-3, `expected unit norm, got ${norm}`);
      const ranked = await opened.reranker.rerank('BM25 是什么', [
        { key: 'relevant', text: 'BM25 是词法检索的经典打分函数，用词频和文档长度估计相关度。' },
        { key: 'unrelated', text: '明天北京有小雨，最高气温十二度，出门记得带伞。' },
      ]);
      const relevant = ranked.scores[0];
      const unrelated = ranked.scores[1];
      assert.ok(relevant !== undefined && unrelated !== undefined);
      assert.ok(relevant > unrelated, `relevant ${relevant} should beat unrelated ${unrelated}`);
    } finally {
      await opened.embedder.dispose();
      await opened.reranker.dispose();
    }
  },
);
