/**
 * Execution-provider selection. The probe itself runs in this process: it
 * loads the embedded identity model and does not download anything.
 * `device: 'auto'` must not appear in the package source.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deviceCandidates, probeDevice } from '../src/index.js';

const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

test('device candidates follow the platform', () => {
  assert.deepEqual(deviceCandidates('win32'), ['dml', 'cpu']);
  assert.deepEqual(deviceCandidates('darwin'), ['cpu']);
  assert.deepEqual(deviceCandidates('linux'), ['cuda', 'cpu']);
});

test('package source never passes device auto and records the poisoning issue', () => {
  const sources = readdirSync(srcDir).filter((name) => name.endsWith('.ts'));
  assert.ok(sources.length > 0);
  const banned = /device:\s*['"]auto['"]/;
  let mentionsIssue = false;
  for (const name of sources) {
    const text = readFileSync(join(srcDir, name), 'utf8');
    assert.equal(banned.test(text), false, `${name} passes device auto`);
    if (text.includes('zvec-grep issue #135')) mentionsIssue = true;
  }
  assert.equal(mentionsIssue, true);
});

test('probeDevice accepts the embedded identity model on an explicit provider', async () => {
  const probe = await probeDevice();
  assert.ok(probe.device === 'cpu' || probe.device === 'cuda' || probe.device === 'dml');
  assert.equal(
    probe.degraded.some((note) => note.startsWith('device-probe-failed:')),
    false,
  );
});
