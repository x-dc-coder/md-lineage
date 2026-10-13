/**
 * Profile catalog (Issue #3 Phase 2). The two 0.6B profiles must carry a
 * real SHA-256 for every file, including the ONNX weight. An empty pin is
 * not a digest and must not be committed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCatalog } from '../src/index.js';

const PIN = /^[0-9a-f]{64}$/;

test('catalog lists four profiles and pins every published file', () => {
  const catalog = loadCatalog();
  assert.deepEqual(
    catalog.map((profile) => profile.id),
    ['local:qwen3-0.6b', 'local:qwen3-reranker-0.6b', 'local:qwen3-4b', 'local:qwen3-reranker-4b'],
  );
  const pending = catalog.filter((profile) => profile.pendingExport);
  assert.equal(pending.length, 2);
  for (const profile of pending) {
    assert.equal(profile.files.length, 0);
    assert.equal(profile.onnxFile, '');
  }
  for (const profile of catalog) {
    if (profile.pendingExport) continue;
    assert.ok(profile.files.some((file) => file.path === profile.onnxFile));
    for (const file of profile.files) {
      assert.match(file.sha256, PIN, `${profile.id} ${file.path} needs a sha256 pin`);
    }
  }
});

test('catalog supports altSha256 for patched upstream models', () => {
  const catalog = loadCatalog();
  const rerankProfile = catalog.find((p) => p.id === 'local:qwen3-reranker-0.6b');
  assert.ok(rerankProfile);
  const onnx = rerankProfile.files.find((f) => f.path === rerankProfile.onnxFile);
  assert.ok(onnx);
  assert.ok(onnx.altSha256);
  assert.match(onnx.altSha256, PIN);
});
