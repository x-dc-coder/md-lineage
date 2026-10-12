/**
 * Offline guard for the embedder's chunking. The default suite must not
 * load weights. A single padded batch of this repository was OOM-killed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkEmbedInputs, poolLastTokenNormalized } from '../src/embedder.js';

test('chunkEmbedInputs — keeps order and splits a workspace-sized corpus', () => {
  const inputs = Array.from({ length: 400 }, (_, index) => `${index}:${'段落'.repeat(800)}`);
  const chunks = chunkEmbedInputs(inputs);
  assert.deepEqual(chunks.flat(), inputs);
  assert.equal(chunks.length, inputs.length);
  assert.ok(chunks.every((chunk) => chunk.length === 1));
});

test('chunkEmbedInputs — an oversized text is a chunk of its own', () => {
  const huge = '字'.repeat(20_000);
  assert.deepEqual(chunkEmbedInputs(['short', huge, 'tail']), [['short'], [huge], ['tail']]);
});

test('chunkEmbedInputs — empty input has no chunks', () => {
  assert.deepEqual(chunkEmbedInputs([]), []);
});

test('poolLastTokenNormalized — uses the last attention 1, then L2-normalizes', () => {
  // Two rows, seq 3, dim 2. Right-padding on row 0 must not pick the pad.
  const data = Float32Array.from([
    0, 0,
    3, 4,
    9, 12,
    0, 0,
    0, 0,
    5, 12,
  ]);
  const rows = poolLastTokenNormalized(data, [2, 3, 2], 2, [
    [1, 1, 0],
    [0, 0, 1],
  ]);
  assert.equal(rows.length, 2);
  const first = rows[0];
  const second = rows[1];
  assert.ok(first !== undefined && second !== undefined);
  assert.ok(Math.abs((first[0] ?? 0) - 0.6) < 1e-12);
  assert.ok(Math.abs((first[1] ?? 0) - 0.8) < 1e-12);
  assert.ok(Math.abs((second[0] ?? 0) - 5 / 13) < 1e-12);
  assert.ok(Math.abs((second[1] ?? 0) - 12 / 13) < 1e-12);
});
