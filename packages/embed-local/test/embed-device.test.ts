/**
 * Embed-session device policy: an explicit cpu / cuda / dml override wins,
 * and any other value keeps the probed provider.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveEmbedDevice } from '../src/embedder.js';

test('resolveEmbedDevice — unset override keeps the probe', () => {
  assert.equal(resolveEmbedDevice(undefined, 'cuda'), 'cuda');
  assert.equal(resolveEmbedDevice(undefined, 'cpu'), 'cpu');
});

test('resolveEmbedDevice — explicit providers win', () => {
  assert.equal(resolveEmbedDevice('cpu', 'cuda'), 'cpu');
  assert.equal(resolveEmbedDevice('cuda', 'cpu'), 'cuda');
  assert.equal(resolveEmbedDevice('dml', 'cpu'), 'dml');
});

test('resolveEmbedDevice — unknown overrides keep the probe', () => {
  assert.equal(resolveEmbedDevice('gpu', 'cpu'), 'cpu');
  assert.equal(resolveEmbedDevice('auto', 'cuda'), 'cuda');
});
