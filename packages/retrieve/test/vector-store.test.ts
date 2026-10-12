/**
 * Content-addressed vector cache tests (Issue #3 §5): hit/miss, cross-file
 * dedup, corruption-as-missence, manifest roundtrips and atomic writes.
 * Everything runs in a throwaway tmpdir — the cache is derived data.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FileVectorStore,
  sectionKey,
  profileDirName,
  type VectorProfile,
} from '../src/index.js';

const PROFILE: VectorProfile = { model: 'Qwen/Qwen3-Embedding-0.6B', dtype: 'f32', dim: 4 };

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), 'mdl-vector-store-'));
}

function withRoot(fn: (root: string) => void | Promise<void>): () => Promise<void> {
  return async () => {
    const root = makeRoot();
    try {
      await fn(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
}

test('sectionKey — NFC and LF normalization make visually equal sections equal', () => {
  const composed = 'café'; // U+00E9
  const decomposed = 'cafe\u0301'; // e + combining acute
  assert.equal(sectionKey(composed, '正文'), sectionKey(decomposed, '正文'));
  assert.equal(sectionKey('标题', 'line1\r\nline2\r\n'), sectionKey('标题', 'line1\nline2\n'));
  // Different content must differ.
  assert.notEqual(sectionKey('A', 'x'), sectionKey('A', 'y'));
  assert.notEqual(sectionKey('A', 'x'), sectionKey('B', 'x'));
});

test('profileDirName — deterministic slug of model + dtype + dim', () => {
  assert.equal(profileDirName(PROFILE), 'qwen-qwen3-embedding-0.6b-f32-d4');
});

test(
  'put/get — roundtrip stores L2-normalized little-endian f32',
  withRoot((root) => {
    const store = new FileVectorStore(root, PROFILE);
    const hash = sectionKey('Title', 'text');
    assert.equal(store.has(hash), false);
    assert.equal(store.get(hash), null);

    store.put(hash, [3, 0, 4, 0]); // norm 5 → [0.6, 0, 0.8, 0]
    assert.equal(store.has(hash), true);
    const back = store.get(hash);
    assert.ok(back instanceof Float32Array);
    // float32 precision: compare within one ulp-ish tolerance, not exactly.
    const values = [...(back ?? [])];
    assert.equal(values.length, 4);
    assert.ok(Math.abs(values[0]! - 0.6) < 1e-6);
    assert.equal(values[1], 0);
    assert.ok(Math.abs(values[2]! - 0.8) < 1e-6);
    assert.equal(values[3], 0);

    // Blob is exactly dim*4 bytes on disk.
    const st = statSync(store.blobPath(hash));
    assert.equal(st.size, PROFILE.dim * 4);
  }),
);

test(
  'dedup — the same hash under two paths is one blob',
  withRoot((root) => {
    const store = new FileVectorStore(root, PROFILE);
    const hash = sectionKey('Shared', 'same content');
    store.put(hash, [1, 1, 1, 1]);
    store.setSections('docs/a.md', [hash]);
    store.setSections('docs/b.md', [hash]);
    assert.equal(store.meta().blobs, 1);
    assert.deepEqual(store.meta().files['docs/a.md'], [hash]);
    assert.deepEqual(store.meta().files['docs/b.md'], [hash]);
  }),
);

test(
  'corruption — wrong-length or unreadable blob reads as missing',
  withRoot((root) => {
    const store = new FileVectorStore(root, PROFILE);
    const hash = sectionKey('T', 'x');
    store.put(hash, [1, 0, 0, 0]);

    // Truncate to a wrong byte length: must be treated as absent.
    writeFileSync(store.blobPath(hash), Buffer.alloc(7));
    assert.equal(store.has(hash), false);
    assert.equal(store.get(hash), null);
    // gc keeps it only by hash membership, not validity; recomputation is
    // driven by has()/get() reporting absence.
  }),
);

test(
  'manifest — roundtrip through a second store instance',
  withRoot((root) => {
    const first = new FileVectorStore(root, PROFILE);
    const h1 = sectionKey('A', 'a');
    const h2 = sectionKey('B', 'b');
    first.put(h1, [1, 0, 0, 0]);
    first.put(h2, [0, 1, 0, 0]);
    first.setSections('docs/one.md', [h1, h2]);
    first.setSections('docs/two.md', [h1]);
    first.removePath('docs/two.md');

    const second = new FileVectorStore(root, PROFILE);
    const meta = second.meta();
    assert.equal(meta.version, 1);
    assert.deepEqual(meta.profile, PROFILE);
    assert.deepEqual(meta.files, { 'docs/one.md': [h1, h2] });
    assert.equal(meta.blobs, 2);
    assert.deepEqual([...(second.get(h1) ?? [])], [1, 0, 0, 0]);
  }),
);

test(
  'gc — deletes only blobs outside keep, returns what it removed',
  withRoot((root) => {
    const store = new FileVectorStore(root, PROFILE);
    const h1 = sectionKey('A', 'a');
    const h2 = sectionKey('B', 'b');
    const h3 = sectionKey('C', 'c');
    store.put(h1, [1, 0, 0, 0]);
    store.put(h2, [0, 1, 0, 0]);
    store.put(h3, [0, 0, 1, 0]);

    const removed = store.gc(new Set([h1, h2]));
    assert.deepEqual([...removed].sort(), [h3]);
    assert.equal(store.has(h1), true);
    assert.equal(store.has(h2), true);
    assert.equal(store.has(h3), false);
    assert.equal(store.meta().blobs, 2);
  }),
);

test(
  'atomicity — an interrupted write leaves no blob and no temp file behind',
  withRoot((root) => {
    const store = new FileVectorStore(root, PROFILE);
    const good = sectionKey('T', 'good');
    store.put(good, [1, 0, 0, 0]);

    // A read-only blobs directory makes the temp write itself fail — the
    // interruption point this test can simulate without monkeypatching fs.
    const blobsDir = join(root, '.mdlineage-cache', 'retrieve', profileDirName(PROFILE), 'blobs');
    const blocked = sectionKey('T', 'blocked');
    try {
      chmodSync(blobsDir, 0o555);
      assert.throws(() => store.put(blocked, [1, 0, 0, 0]));
    } finally {
      chmodSync(blobsDir, 0o755);
    }
    assert.equal(store.has(blocked), false);
    assert.equal(store.has(good), true);

    // No half-written blob at the final name and no leftover temp files in
    // the profile directory: interruption must not produce partial state.
    const profileDir = join(root, '.mdlineage-cache', 'retrieve', profileDirName(PROFILE));
    const strays = readdirSync(profileDir).filter((f) => f.includes('mdlineage-tmp'));
    assert.deepEqual(strays, []);
  }),
);

test(
  'manifest write — is atomic JSON at the profile root',
  withRoot((root) => {
    const store = new FileVectorStore(root, PROFILE);
    store.setSections('docs/x.md', [sectionKey('X', 'x')]);
    const manifestPath = join(
      root,
      '.mdlineage-cache',
      'retrieve',
      profileDirName(PROFILE),
      'manifest.json',
    );
    assert.equal(existsSync(manifestPath), true);
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version: number };
    assert.equal(parsed.version, 1);
  }),
);

test(
  'dimension guard — put refuses a vector of the wrong length',
  withRoot((root) => {
    const store = new FileVectorStore(root, PROFILE);
    assert.throws(() => store.put(sectionKey('T', 'x'), [1, 2, 3]));
  }),
);
