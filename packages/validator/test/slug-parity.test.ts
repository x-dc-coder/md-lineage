/**
 * Slug parity against github-slugger (docs/remark-language-server-solution.md
 * §14.1: "GFM slug、重复 heading、Unicode heading").
 *
 * `src/slugger.ts` classifies code points with a derived table instead of
 * github-slugger's generated regex, because the validator package stays
 * dependency-free. This file is the pin on that derivation: every case below
 * is the value the real package produces, recorded here so a table regression
 * fails a test instead of silently changing every anchor in a repository.
 *
 * Run with: node --import tsx --test packages/validator/test/slug-parity.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { slugifyHeading, Slugger } from '../src/slugger.js';
import { defaultConfig } from '../src/index.js';
import { createWorkspaceIndex } from '../src/workspace-index.js';
import { validateWorkspace } from '../src/workspace-validator.js';

describe('slugifyHeading — github-slugger parity (authoritative values)', () => {
  // [heading, github-slugger's anchor]. Values recorded from github-slugger 2.0.0.
  const cases: ReadonlyArray<readonly [string, string]> = [
    // The review finding: punctuation used to survive.
    ['Hello, World!', 'hello-world'],
    ['Q&A Session', 'qa-session'],
    ['C++ Guide', 'c-guide'],
    ['v1.2 Release', 'v12-release'],
    ['v1.2', 'v12'],
    ['3.1.4 Timeline', '314-timeline'],
    ['HTTP/2 Notes', 'http2-notes'],
    ['a.b.c', 'abc'],
    ['100% Coverage', '100-coverage'],
    ['The "Best" Option', 'the-best-option'],
    ['Understanding [RFC] 5322', 'understanding-rfc-5322'],
    ['Run `npm build`', 'run-npm-build'],
    ['Hello World', 'hello-world'],
    ['Pricing — 2026', 'pricing--2026'],
    ['Curly’quote', 'curlyquote'],
    // Whitespace: only the ASCII space hyphenates, runs are not collapsed.
    ['A  B', 'a--b'],
    ['  lead and trail  ', '--lead-and-trail--'],
    ['--emph--', '--emph--'],
    // A tab is dropped with the punctuation, not hyphenated.
    ['tab\there', 'tabhere'],
    // Unicode letters are kept; combining marks survive; emoji are dropped.
    ['缓存有效期', '缓存有效期'],
    ['Café', 'café'],
    ['café\u0301', 'café́'],
    ['Ω Γλῶσσα', 'ω-γλῶσσα'],
    ['Тест на русском', 'тест-на-русском'],
    ['日本語の見出し', '日本語の見出し'],
    ['한국어 제목', '한국어-제목'],
    ['标题 😀 trailing', '标题--trailing'],
    ['𝔲𝔫𝔦𝔠𝔬𝔡𝔢', '𝔲𝔫𝔦𝔠𝔬𝔡𝔢'],
    // github-slugger keeps letters that a category test would drop.
    ['ª and º and µ', 'ª-and-º-and-µ'],
    // and removes letters a category test would keep — the space around them
    // still hyphenates, so the arrow characters leave a bare leading hyphen.
    ['˂˃˄˅ arrows', '-arrows'],
    // Case folding is Unicode-aware.
    ['ÇAPS LOCK', 'çaps-lock'],
    ['İstanbul', 'i̇stanbul'],
    ['ẛ̣pecial', 'ẛ̣pecial'],
  ];

  for (const [heading, expected] of cases) {
    it(`${JSON.stringify(heading)} → ${expected}`, () => {
      assert.equal(slugifyHeading(heading), expected);
    });
  }

  it('the empty heading stays empty', () => {
    assert.equal(slugifyHeading(''), '');
    assert.equal(slugifyHeading('😀'), '');
    assert.equal(slugifyHeading(',.;:!?'), '');
  });

  it('emoji are dropped even between kept letters', () => {
    assert.equal(slugifyHeading('a😀b'), 'ab');
    assert.equal(slugifyHeading('🎉🎉'), '');
  });

  it('a surrogate half never leaks into the slug', () => {
    // A lone high surrogate cannot form an astral code point; it is dropped.
    assert.equal(slugifyHeading('a\uD83Db'), 'ab');
  });
});

describe('Slugger — duplicate handling', () => {
  it('the first heading is the bare slug and repeats get -n', () => {
    const s = new Slugger();
    assert.equal(s.slug('Notes'), 'notes');
    assert.equal(s.slug('Notes'), 'notes-1');
    assert.equal(s.slug('Notes'), 'notes-2');
  });

  it('anchors() exposes every generated anchor, including suffixed ones', () => {
    const s = new Slugger();
    s.slug('Notes');
    s.slug('Notes');
    s.slug('Notes');
    assert.deepEqual([...s.anchors()].sort(), ['notes', 'notes-1', 'notes-2']);
  });

  it('two different headings that slug to the same base still collide', () => {
    const s = new Slugger();
    assert.equal(s.slug('Hello, World!'), 'hello-world');
    assert.equal(s.slug('Hello World'), 'hello-world-1');
  });

  it('a heading that slugifies to empty still gets successive anchors', () => {
    const s = new Slugger();
    assert.equal(s.slug('😀'), '');
    // github-slugger appends `-n` to the BASE slug, so an empty base produces
    // a bare suffix. That is not a useful anchor and a repository citing it
    // gets MDL201, which is the honest outcome for two emoji-only headings.
    assert.equal(s.slug('😀'), '-1');
    assert.deepEqual([...s.anchors()], ['', '-1']);
  });
});

describe('slug parity — the same slug feeds MDL201 and MDL402 both ways', () => {
  // `slugifyHeading` is the one implementation behind both anchor rules, so a
  // heading and an evidence value that disagree on punctuation must resolve in
  // exactly one direction: the author who writes the anchor GitHub would have
  // produced is clean, and every other spelling reports.
  const doc = (id: string, relations: string, body = '') =>
    [
      '---',
      'mdlineage:',
      '  schema: 1',
      `  id: ${id}`,
      '  kind: policy',
      '  status: active',
      relations,
      '---',
      '',
      body,
    ].join('\n');

  const rel = (target: string, evidence: string) =>
    [
      '  relations:',
      '    - type: refines',
      `      target: ${target}`,
      '      reason: Punctuation must match the rendered anchor.',
      `      evidence: "${evidence}"`,
    ].join('\n');

  const pair = (evidence: string, heading: string) =>
    new Map<string, string>([
      ['source.md', doc('docs.source', rel('docs.target', `#${evidence}`))],
      ['target.md', doc('docs.target', '', `## ${heading}\n`)],
    ]);

  it('#hello-world resolves for the heading "Hello, World!" (no MDL402)', () => {
    const index = createWorkspaceIndex(pair('hello-world', 'Hello, World!'), defaultConfig());
    const all = validateWorkspace(index, { includeSingleDocument: false });
    assert.equal(all.filter((d) => d.code === 'MDL402').length, 0, 'the anchor matches the GitHub slug');
  });

  it('#q&a-session does NOT resolve for "Q&A Session" (MDL402 reports)', () => {
    // The review finding: the unfiltered slug kept the ampersand, so an
    // evidence value copied from the old behaviour was silently accepted while
    // the real GitHub anchor is "qa-session".
    const index = createWorkspaceIndex(pair('q&a-session', 'Q&A Session'), defaultConfig());
    const all = validateWorkspace(index, { includeSingleDocument: false });
    assert.equal(all.filter((d) => d.code === 'MDL402').length, 1, 'the punctuation must not resolve');
    // The correctly spelled value resolves, proving the rule itself works.
    const fixed = createWorkspaceIndex(pair('qa-session', 'Q&A Session'), defaultConfig());
    assert.equal(
      validateWorkspace(fixed, { includeSingleDocument: false }).filter((d) => d.code === 'MDL402').length,
      0,
    );
  });

  it('a C++ heading anchors as "cpp-guide" both ways', () => {
    assert.equal(slugifyHeading('C++ Guide'), 'c-guide');
    const index = createWorkspaceIndex(pair('c-guide', 'C++ Guide'), defaultConfig());
    assert.equal(
      validateWorkspace(index, { includeSingleDocument: false }).filter((d) => d.code === 'MDL402').length,
      0,
    );
  });

  it('a version-number heading anchors as "v12-release" both ways', () => {
    assert.equal(slugifyHeading('v1.2 Release'), 'v12-release');
    const index = createWorkspaceIndex(pair('v12-release', 'v1.2 Release'), defaultConfig());
    assert.equal(
      validateWorkspace(index, { includeSingleDocument: false }).filter((d) => d.code === 'MDL402').length,
      0,
    );
  });
});

describe('slug parity — code-point classification', () => {
  // Spot checks of the derived table's boundaries, where a category
  // approximation and the real blacklist disagree. `Ⅷ` is a kept character
  // that also case-folds (to ⅷ), which is why the assertion lowercases.
  const kept: string[] = ['ª', 'µ', 'º', 'ᵈ', 'ⱥ', 'ℌ', 'Ⅷ', 'ꜳ'];
  const dropped: string[] = ['×', '÷', '²', '¼', '°', '©', '§', '¶', '—', '–', '’', '•', '†', '‡', '˂', '˃', '⁄', '㌀'];

  for (const ch of kept) {
    it(`${JSON.stringify(ch)} U+${ch.codePointAt(0)!.toString(16)} is kept`, () => {
      assert.equal(slugifyHeading(`a${ch}b`), `a${ch.toLowerCase()}b`);
    });
  }
  for (const ch of dropped) {
    it(`${JSON.stringify(ch)} U+${ch.codePointAt(0)!.toString(16)} is dropped`, () => {
      assert.equal(slugifyHeading(`a${ch}b`), 'ab');
    });
  }
});
