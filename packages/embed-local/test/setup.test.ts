/**
 * `setupLocalModels` offline paths. Pending-export profiles must not touch
 * the network. Published profiles are covered by the CLI checksum test once
 * models.json carries real pins.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupLocalModels } from '../src/index.js';

test('unknown profile exits 2 and names the known ids', async () => {
  const report = await setupLocalModels({ profile: 'local:missing', mirror: 'https://example.invalid' });
  assert.equal(report.exitCode, 2);
  assert.match(report.lines.join('\n'), /unknown profile 'local:missing'/);
  assert.match(report.lines.join('\n'), /local:qwen3-0\.6b/);
});

test('pending 4b profile exits 0 with export guidance and does not fetch', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mdl-embed-setup-'));
  const original = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error('fetch must not run for a pending profile');
  };
  try {
    const report = await setupLocalModels({
      profile: 'local:qwen3-4b',
      modelDir: dir,
      mirror: 'https://example.invalid',
    });
    assert.equal(report.exitCode, 0);
    const text = report.lines.join('\n');
    assert.match(text, /权重待导出/);
    assert.match(text, /optimum-cli export onnx --model Qwen\/Qwen3-Embedding-4B/);
    assert.match(text, /onnx\/model_quantized\.onnx/);
  } finally {
    globalThis.fetch = original;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pending reranker 4b points at the YesNo export script', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mdl-embed-setup-'));
  try {
    const report = await setupLocalModels({
      profile: 'local:qwen3-reranker-4b',
      modelDir: dir,
      mirror: 'https://example.invalid',
    });
    assert.equal(report.exitCode, 0);
    assert.match(report.lines.join('\n'), /export_optimized_reranker\.py/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
