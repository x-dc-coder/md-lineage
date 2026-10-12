/**
 * extractSections tests (Issue #3 Phase 1): heading-delimited spans, slug
 * parity with evidence anchors, preamble handling, literal code preservation
 * and the 8192-token truncation budget.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractSections, estimateTokens, parseMarkdownSync, collectAnchors } from '../src/index.js';

test('extractSections — ATX headings split sections with document line spans', () => {
  const doc = 'intro text\n\n# Alpha\n\nalpha body\n\n## Beta\n\nbeta body\n';
  const sections = extractSections(doc);
  assert.equal(sections.length, 3);

  const [preamble, alpha, beta] = sections;
  assert.equal(preamble?.title, '(preamble)');
  assert.equal(preamble?.level, 0);
  assert.equal(preamble?.slug, '(preamble)');
  assert.equal(preamble?.startLine, 1);
  assert.equal(preamble?.endLine, 2);
  assert.equal(preamble?.text, 'intro text');

  assert.equal(alpha?.title, 'Alpha');
  assert.equal(alpha?.level, 1);
  assert.equal(alpha?.slug, 'alpha');
  assert.equal(alpha?.startLine, 3);
  assert.equal(alpha?.endLine, 6);
  assert.equal(alpha?.text, 'alpha body');

  assert.equal(beta?.title, 'Beta');
  assert.equal(beta?.level, 2);
  assert.equal(beta?.slug, 'beta');
  assert.equal(beta?.startLine, 7);
  assert.equal(beta?.endLine, 9);
  assert.equal(beta?.text, 'beta body');
});

test('extractSections — setext headings carry depth and spans', () => {
  const doc = 'Setext Title\n=============\n\nbody under setext\n\nSub\n---\n\nsub body\n';
  const sections = extractSections(doc);
  assert.equal(sections.length, 2);
  const [h1, h2] = sections;
  assert.equal(h1?.title, 'Setext Title');
  assert.equal(h1?.level, 1);
  assert.equal(h1?.slug, 'setext-title');
  assert.equal(h1?.startLine, 1);
  assert.equal(h1?.endLine, 5);
  assert.equal(h1?.text, 'body under setext');
  assert.equal(h2?.title, 'Sub');
  assert.equal(h2?.level, 2);
  assert.equal(h2?.slug, 'sub');
  assert.equal(h2?.startLine, 6);
  assert.equal(h2?.endLine, 9);
  assert.equal(h2?.text, 'sub body');
});

test('extractSections — level jumps are kept as-is (no hierarchy repair)', () => {
  const doc = '# One\n\n## Two\n\n#### Four\n\ntail\n';
  const sections = extractSections(doc);
  assert.deepEqual(sections.map((s) => s.level), [1, 2, 4]);
});

test('extractSections — duplicate headings get GitHub -n slugs', () => {
  const doc = '# Notes\n\nfirst\n\n# Notes\n\nsecond\n\n## Notes\n\nthird\n';
  const sections = extractSections(doc);
  assert.deepEqual(sections.map((s) => s.slug), ['notes', 'notes-1', 'notes-2']);
});

test('extractSections — empty document yields no sections', () => {
  assert.deepEqual(extractSections(''), []);
  assert.deepEqual(extractSections('\n\n\n'), []);
  assert.deepEqual(extractSections('---\n---\n'), []);
});

test('extractSections — no heading: the whole body is one preamble', () => {
  const doc = 'just a paragraph\n\nanother paragraph\n';
  const sections = extractSections(doc);
  assert.equal(sections.length, 1);
  const [preamble] = sections;
  assert.equal(preamble?.title, '(preamble)');
  assert.equal(preamble?.level, 0);
  assert.equal(preamble?.slug, '(preamble)');
  assert.equal(preamble?.startLine, 1);
  assert.equal(preamble?.endLine, 3);
  assert.equal(preamble?.text, 'just a paragraph\nanother paragraph');
});

test('extractSections — front matter is stripped, body starts at the marker line', () => {
  const doc = '---\nmdlineage:\n  id: docs.x\n---\n# Title\n\nbody\n';
  const sections = extractSections(doc);
  assert.equal(sections.length, 1);
  const [section] = sections;
  assert.equal(section?.title, 'Title');
  // Document lines 1..3 are the front matter block, the closing marker is
  // line 4 and the heading is line 5: the slice starts at the closing marker,
  // so the heading is slice line 2 and bodyLineOffset(3) maps it to 5.
  assert.equal(section?.startLine, 5);
  assert.equal(section?.endLine, 7);
  assert.equal(section?.text, 'body');
});

test('extractSections — front matter with preamble content before first heading', () => {
  const doc = '---\nkey: value\n---\nlead paragraph\n\n# Heading\n\nbody\n';
  const sections = extractSections(doc);
  assert.equal(sections.length, 2);
  const [preamble, heading] = sections;
  assert.equal(preamble?.slug, '(preamble)');
  // The dropped artifact `---` line is not part of the span: the preamble
  // starts at the lead paragraph (document line 4).
  assert.equal(preamble?.startLine, 4);
  assert.equal(preamble?.endLine, 5);
  assert.equal(preamble?.text, 'lead paragraph');
  assert.equal(heading?.startLine, 6);
});

test('extractSections — code blocks are preserved verbatim', () => {
  const doc = '# Code\n\n```ts\nconst x = extractSections(doc);\nif (x) { reuse(); }\n```\n\ntail\n';
  const sections = extractSections(doc);
  const [section] = sections;
  assert.equal(section?.text, 'const x = extractSections(doc);\nif (x) { reuse(); }\ntail');
});

test('extractSections — list and table text is included', () => {
  const doc = '# Blocks\n\n- one item\n- two item\n\n| Col A | Col B |\n|---|---|\n| a1 | b1 |\n';
  const sections = extractSections(doc);
  const text = sections[0]?.text ?? '';
  assert.match(text, /one item/);
  assert.match(text, /two item/);
  assert.match(text, /Col A/);
  assert.match(text, /b1/);
  // List items stay separated: adjacent items must not fuse into one run.
  assert.doesNotMatch(text, /one itemtwo item/);
});

test('extractSections — inline code is kept literally inside sentences', () => {
  const doc = '# Mixed\n\nCall `parseMarkdownSync` with care around **bold `inlineCode`** text.\n';
  const sections = extractSections(doc);
  assert.equal(sections[0]?.text, 'Call parseMarkdownSync with care around bold inlineCode text.');
});

test('extractSections — Unicode/Chinese heading keeps its characters in slug and text', () => {
  const doc = '# 中文标题 检索\n\n正文内容一段。\n\n## English + 中文\n\nmixed body\n';
  const sections = extractSections(doc);
  const [zh, mixed] = sections;
  assert.equal(zh?.title, '中文标题 检索');
  assert.equal(zh?.slug, '中文标题-检索');
  assert.equal(zh?.text, '正文内容一段。');
  assert.equal(mixed?.slug, 'english--中文');
  assert.equal(mixed?.text, 'mixed body');
});

test('extractSections — sections over the 8192-token budget are truncated and flagged', () => {
  // 9000 CJK characters: 1 token each by the estimate rule.
  const huge = '汉'.repeat(9000);
  const doc = `# Big\n\n${huge}\n`;
  const sections = extractSections(doc);
  const [section] = sections;
  assert.equal(section?.truncated, true);
  // Title (1 word) + newline (pairs with nothing) + 8191 CJK chars fit.
  assert.equal(section?.text.length, 8191);
  assert.ok(estimateTokens(`${section?.title}\n${section?.text ?? ''}`) <= 8192);

  const small = extractSections('# Small\n\nshort\n');
  assert.equal(small[0]?.truncated, false);
  assert.equal(small[0]?.text, 'short');
});

test('estimateTokens — CJK per char, word runs per run, symbols in pairs', () => {
  // 2 CJK + 2 runs + 4 symbols (2 tokens) = 5.
  assert.equal(estimateTokens('中文 foo_bar, ;'), 2 + 1 + 2);
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('。。。'), 1); // three symbol code points -> floor(3/2)
  assert.equal(estimateTokens('extractSections'), 1);
});

test('extractSections — section containing a nested sub-heading hierarchy splits on every heading', () => {
  const doc = '---\nmdlineage:\n  schema: 1\n---\n# A\n\ntext a\n\n### A1\n\ntext a1\n';
  const sections = extractSections(doc);
  assert.deepEqual(
    sections.map((s) => [s.slug, s.startLine, s.endLine]),
    [['a', 5, 8], ['a1', 9, 11]],
  );
});

// ---------------------------------------------------------------------------
// Review-round fixes (Issue #3 Phase 1).
// ---------------------------------------------------------------------------

test('extractSections — nested headings consume duplicate numbering like collectAnchors (B4)', () => {
  const doc = '# Notes\n\nfirst\n\n> # Notes\n\nlast\n\n# Notes\n\ntail\n';
  const sections = extractSections(doc);
  // Only the two top-level headings open sections, but the blockquoted one
  // consumed 'notes-1', so the third heading anchors as 'notes-2' — the same
  // sequence collectAnchors produces for evidence validation.
  assert.deepEqual(sections.map((s) => s.slug), ['notes', 'notes-2']);

  const anchors = collectAnchors(parseMarkdownSync(doc) as never);
  assert.deepEqual([...anchors].sort(), ['notes', 'notes-1', 'notes-2']);
  for (const section of sections) {
    assert.ok(anchors.has(section.slug), `slug ${section.slug} must exist in collectAnchors output`);
  }
});

test('extractSections — preamble slug never collides with a "Preamble" heading (B5)', () => {
  const doc = 'intro text\n\n# Preamble\n\nbody\n';
  const sections = extractSections(doc);
  assert.deepEqual(sections.map((s) => s.slug), ['(preamble)', 'preamble']);
  assert.deepEqual(sections.map((s) => s.title), ['(preamble)', 'Preamble']);
});

test('extractSections — an oversized heading title is truncated within the 8K budget (B3)', () => {
  const doc = `# ${'汉'.repeat(9000)}\n\nbody text\n`;
  const sections = extractSections(doc);
  const section = sections[0]!;
  assert.equal(section.truncated, true);
  // The title alone was over budget: it gets cut by code points, the body
  // is empty, and the estimated title stays within the budget.
  assert.ok(estimateTokens(section.title) <= 8192, `title tokens: ${estimateTokens(section.title)}`);
  assert.ok([...section.title].length <= 9000);
  assert.equal(section.text, '');
  // The slug is derived from the FULL heading text (anchor parity): 9000 CJK
  // characters slugify to themselves.
  assert.ok([...section.slug].length === 9000);
});

test('extractSections — hard breaks separate words instead of fusing them (B7)', () => {
  const doc = '# Breaks\n\nfoo  \nbar\n';
  const sections = extractSections(doc);
  assert.equal(sections[0]?.text, 'foo bar');
});
