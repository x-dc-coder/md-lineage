/**
 * Suffix-preserving rerank truncation (review A1): the assistant suffix the
 * YesNo logits are read against must survive the 2048-token budget; only
 * the document middle may be trimmed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trimMiddleIds, RERANK_TAIL_KEEP } from '../src/reranker.js';

test('trimMiddleIds — keeps head and tail, drops the middle, exact budget', () => {
  const ids = Array.from({ length: 5797 }, (_, i) => i);
  const trimmed = trimMiddleIds(ids, 2048, RERANK_TAIL_KEEP);
  assert.equal(trimmed.length, 2048);
  // Head survives...
  assert.deepEqual(trimmed.slice(0, 5), [0, 1, 2, 3, 4]);
  // ...the tail (assistant suffix) survives intact...
  assert.deepEqual(trimmed.slice(-5), [5792, 5793, 5794, 5795, 5796]);
  // ...and the middle is gone.
  assert.ok(!trimmed.includes(3000));
});

test('trimMiddleIds — under-budget sequences pass through unchanged', () => {
  assert.deepEqual(trimMiddleIds([1, 2, 3], 2048, RERANK_TAIL_KEEP), [1, 2, 3]);
});
