/**
 * Opening a model directory that has no weights is a lexical fallback.
 * It must not download and must not call the network.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLocalRetrieval } from '../src/index.js';

test('an empty model dir is not ready and does not fetch', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mdl-embed-open-'));
  const original = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error('fetch must not run when weights are missing');
  };
  try {
    const opened = await openLocalRetrieval({ modelDir: dir });
    assert.equal(opened.ready, false);
    assert.equal(opened.embedder, null);
    assert.equal(opened.reranker, null);
    assert.ok(opened.degraded.some((note) => note.includes('falling back to lexical')));
  } finally {
    globalThis.fetch = original;
    rmSync(dir, { recursive: true, force: true });
  }
});
