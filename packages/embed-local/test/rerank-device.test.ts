/**
 * Reranker device policy tests: CPU-pinned default, explicit overrides, and
 * the auto escape hatch (the ORT 1.21 CUDA softmax abort note).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRerankDevice } from '../src/reranker.js';

test('resolveRerankDevice — default pins cpu even when cuda was probed', () => {
  const r = resolveRerankDevice(undefined, 'cuda');
  assert.equal(r.device, 'cpu');
  assert.match(r.note ?? '', /pinned to cpu/);
});

test('resolveRerankDevice — cpu probe with no override has no note', () => {
  assert.deepEqual(resolveRerankDevice(undefined, 'cpu'), { device: 'cpu' });
});

test('resolveRerankDevice — explicit pins are respected without notes', () => {
  assert.deepEqual(resolveRerankDevice('cpu', 'cuda'), { device: 'cpu' });
  assert.deepEqual(resolveRerankDevice('cuda', 'cpu'), { device: 'cuda' });
  assert.deepEqual(resolveRerankDevice('dml', 'cpu'), { device: 'dml' });
});

test('resolveRerankDevice — auto follows the probe', () => {
  assert.deepEqual(resolveRerankDevice('auto', 'cuda'), { device: 'cuda' });
  assert.deepEqual(resolveRerankDevice('auto', 'cpu'), { device: 'cpu' });
});

test('resolveRerankDevice — unknown values fall back to the pinned default', () => {
  const r = resolveRerankDevice('gpu', 'cuda');
  assert.equal(r.device, 'cpu');
  assert.match(r.note ?? '', /pinned to cpu/);
});
