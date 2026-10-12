/**
 * BM25 golden tests (Issue #3 Phase 1). The corpus below is small enough to
 * verify by hand; every constant below is the closed-form arithmetic, so a
 * formula regression fails loudly.
 *
 * Corpus (tokens = tokenize(`${title}\n${text}`)):
 *   a.md#cat : cat×3, dog×1                     len 4
 *   b.md#bird: bird×4                           len 4
 *   c.md#fish: fish×2, cat×1                    len 3
 * N = 3, avgdl = 11/3, k1 = 1.2, b = 0.75, df(cat) = 2, df(dog) = 1.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bm25Index } from '../src/index.js';

const CORPUS = [
  { path: 'a.md', slug: 'cat', title: 'Cat', text: 'cat cat dog' },
  { path: 'b.md', slug: 'bird', title: 'Bird', text: 'bird bird bird' },
  { path: 'c.md', slug: 'fish', title: 'Fish', text: 'cat fish' },
];

test('bm25 — hand-computed golden ranking for "cat dog"', () => {
  const index = new Bm25Index(CORPUS);
  const hits = index.search('cat dog');
  assert.deepEqual(hits.map((h) => `${h.path}#${h.slug}`), ['a.md#cat', 'c.md#fish']);

  // idf(cat) = ln(1 + (3-2+0.5)/(2+0.5))      = ln(1.6)
  // idf(dog) = ln(1 + (3-1+0.5)/(1+0.5))      = ln(8/3)
  // a: norm = 0.25 + 0.75*4/(11/3) = 47/44
  //    cat: ln(1.6)*3*2.2/(3+1.2*31/22) = 0.7244735…
  //    dog: ln(8/3)*1*2.2/(1+1.2*31/22) = 0.9456506…
  //    total = 1.6701242694590301
  // c: norm = 0.25 + 0.75*3/(11/3) = 19/22
  //    cat: ln(1.6)*1*2.2/(1+1.2*19/22) = 0.5077717780244108
  assert.ok(Math.abs(hits[0]!.score - 1.6701242694590301) < 1e-12);
  assert.ok(Math.abs(hits[1]!.score - 0.5077717780244108) < 1e-12);
});

test('bm25 — tie-break is (path, slug) lexicographic, byte-stable', () => {
  const twins = [
    { path: 'x.md', slug: 'alpha', title: 'Same', text: 'identical words here' },
    { path: 'a.md', slug: 'zeta', title: 'Same', text: 'identical words here' },
    { path: 'a.md', slug: 'alpha', title: 'Same', text: 'identical words here' },
    { path: 'm.md', slug: 'alpha', title: 'Same', text: 'identical words here' },
  ];
  const hits = new Bm25Index(twins).search('identical');
  assert.deepEqual(hits.map((h) => `${h.path}#${h.slug}`), [
    'a.md#alpha',
    'a.md#zeta',
    'm.md#alpha',
    'x.md#alpha',
  ]);
  // Equal scores, provably: identical token multisets over identical lengths.
  const scores = hits.map((h) => h.score);
  assert.ok(scores.every((s) => s === scores[0]));
});

test('bm25 — limit slices after sorting; non-positive limits return nothing', () => {
  const index = new Bm25Index(CORPUS);
  assert.equal(index.search('cat dog', 1).length, 1);
  assert.equal(index.search('cat dog', 0).length, 0);
  // A negative limit must not reach Array.slice (which would truncate from
  // the end and return tail hits as if they were the top).
  assert.equal(index.search('cat dog', -1).length, 0);
  assert.equal(index.search('cat dog', -3).length, 0);
  assert.equal(index.size, 3);
});

test('bm25 — empty query, symbol-only query and empty corpus', () => {
  const index = new Bm25Index(CORPUS);
  assert.deepEqual(index.search(''), []);
  assert.deepEqual(index.search('!!! ???'), []);
  assert.deepEqual(new Bm25Index([]).search('cat'), []);
});

test('bm25 — a term present in every document keeps a strictly positive idf', () => {
  const docs = [
    { path: 'a.md', slug: 's', title: 'shared', text: 'alpha' },
    { path: 'b.md', slug: 's', title: 'shared', text: 'beta' },
    { path: 'c.md', slug: 's', title: 'shared', text: 'gamma' },
  ];
  // 'shared' (df = N) contributes ln(1 + 1/(2N)) > 0 under the Lucene idf
  // (strictly positive, uncapped), so every document is returned; the
  // ranking is driven by nothing else — all scores equal, tie-break path order.
  const hits = new Bm25Index(docs).search('shared');
  assert.deepEqual(hits.map((h) => h.path), ['a.md', 'b.md', 'c.md']);
});
