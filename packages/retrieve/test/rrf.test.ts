/**
 * RRF fusion tests (Issue #3 §4: k = 60). Hand-computed golden order with the
 * tie-break rule made explicit.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fuse } from '../src/index.js';

test('rrf — hand-computed fused scores, k = 60', () => {
  // a: 1/61 + 1/62, b: 1/62 + 1/61, c: 1/63
  const fused = fuse([['a', 'b', 'c'], ['b', 'a']]);
  assert.deepEqual(fused.map((f) => f.key), ['a', 'b', 'c']);
  assert.ok(Math.abs(fused[0]!.score - (1 / 61 + 1 / 62)) < 1e-12);
  assert.ok(Math.abs(fused[2]!.score - 1 / 63) < 1e-12);
});

test('rrf — equal scores tie-break by key ascending', () => {
  // b ranks first in one list, a in the other: same fused score, so the
  // lexicographic key order decides.
  const fused = fuse([['b'], ['a']]);
  assert.deepEqual(fused.map((f) => f.key), ['a', 'b']);
  assert.equal(fused[0]!.score, fused[1]!.score);
});

test('rrf — items missing from some rankings keep partial credit', () => {
  const fused = fuse([['a', 'b'], ['c', 'a']]);
  // a: 1/61 + 1/62 ≈ 0.032522…, c: 1/61, b: 1/62
  assert.deepEqual(fused.map((f) => f.key), ['a', 'c', 'b']);
  assert.ok(Math.abs(fused[1]!.score - 1 / 61) < 1e-12);
  assert.ok(Math.abs(fused[2]!.score - 1 / 62) < 1e-12);
});

test('rrf — custom k and empty inputs', () => {
  assert.ok(Math.abs(fuse([['x']], 1)[0]!.score - 1 / 2) < 1e-12);
  assert.deepEqual(fuse([]), []);
  assert.deepEqual(fuse([[], []]), []);
});

// ---------------------------------------------------------------------------
// Review-round fixes (Issue #3 Phase 1).
// ---------------------------------------------------------------------------

test('rrf — a duplicate key inside ONE ranking scores once, at first occurrence', () => {
  const fused = fuse([['a', 'b', 'a']]);
  assert.deepEqual(fused.map((f) => f.key), ['a', 'b']);
  assert.ok(Math.abs(fused[0]!.score - 1 / 61) < 1e-12);
  assert.ok(Math.abs(fused[1]!.score - 1 / 62) < 1e-12);
});

test('rrf — the same key MAY appear in different rankings (that is the point)', () => {
  const fused = fuse([['a'], ['a']]);
  assert.ok(Math.abs(fused[0]!.score - 2 / 61) < 1e-12);
});

test('rrf — k must be positive', () => {
  assert.throws(() => fuse([['x']], -1), RangeError);
  assert.throws(() => fuse([['x']], 0), RangeError);
});
