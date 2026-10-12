/**
 * Tokenizer golden tests (Issue #3 Phase 1): identifier subwords, CJK
 * bigrams, symbol dropping — the exact token stream BM25 depends on.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize } from '../src/index.js';

test('tokenize — camelCase identifier: whole word plus subwords', () => {
  assert.deepEqual(tokenize('extractSections'), ['extractsections', 'extract', 'sections']);
  // Consecutive-uppercase runs split only before an Upper+lower pair.
  assert.deepEqual(tokenize('HTTPServer'), ['httpserver', 'http', 'server']);
  // Digits belong to the preceding lowercase run.
  assert.deepEqual(tokenize('mixed123Case'), ['mixed123case', 'mixed123', 'case']);
});

test('tokenize — underscore identifiers index both sides', () => {
  assert.deepEqual(tokenize('foo_bar'), ['foo_bar', 'foo', 'bar']);
  // A word with no internal boundary emits exactly one token.
  assert.deepEqual(tokenize('Cat'), ['cat']);
  assert.deepEqual(tokenize('dog'), ['dog']);
});

test('tokenize — CJK bigrams; isolated CJK char becomes a unigram', () => {
  assert.deepEqual(tokenize('检索引擎'), ['检索', '索引', '引擎']);
  assert.deepEqual(tokenize('中'), ['中']);
  assert.deepEqual(tokenize('a 中 b'), ['a', '中', 'b']);
  // CJK runs break on ASCII, so bigrams never cross the boundary.
  assert.deepEqual(tokenize('中文abc'), ['中文', 'abc']);
});

test('tokenize — mixed CJK and identifiers in input order', () => {
  assert.deepEqual(tokenize('中英混排 mixed123Case'), [
    '中英',
    '英混',
    '混排',
    'mixed123case',
    'mixed123',
    'case',
  ]);
});

test('tokenize — pure symbols and whitespace produce nothing', () => {
  assert.deepEqual(tokenize('!!! ,,, ???'), []);
  assert.deepEqual(tokenize(''), []);
  assert.deepEqual(tokenize('🚀 — …'), []);
});

// ---------------------------------------------------------------------------
// Review-round fixes (Issue #3 Phase 1).
// ---------------------------------------------------------------------------

test('tokenize — NFC identity: composed and decomposed input tokenize identically', () => {
  // Same invariant sectionKey hashes under: visually equal text is equal.
  assert.deepEqual(tokenize('cafe\u0301 bar'), tokenize('café bar'));
});

test('tokenize — CJK Extension C characters produce bigrams', () => {
  // U+2A700 U+2A701 (Ext C): one run of two, overlapping bigram output.
  assert.deepEqual(tokenize('\u{2A700}\u{2A701}'), ['\u{2A700}\u{2A701}']);
  // Isolated Ext C character: unigram.
  assert.deepEqual(tokenize('x \u{2A700} y'), ['x', '\u{2A700}', 'y']);
});
