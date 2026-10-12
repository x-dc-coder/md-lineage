/**
 * Section extraction for the retrieval pipeline (Issue #3 Phase 1).
 *
 * `extractSections` is a pure function: full document text in, flat section
 * list out. The unit of lexical (BM25) and later dense retrieval is the
 * section, not the document, so the split must be the same one evidence
 * anchors address — hence the shared `Slugger` and the shared front matter
 * boundary logic, never a second implementation of either.
 */

import { scanBoundary, stripBom, lineStarts } from './parse-frontmatter.js';
import { parseMarkdownSync } from './parse-markdown.js';
import { Slugger } from './slugger.js';

/** One retrieval unit: a heading-delimited span of one document. */
export interface Section {
  /** Heading text; '(preamble)' for the span before the first heading. */
  title: string;
  /** Heading depth 1–6; 0 for the preamble. */
  level: number;
  /**
   * GitHub anchor of the heading, duplicates suffixed `-n` exactly as
   * evidence anchors spell them. The preamble carries the internal marker
   * 'preamble': it has no GitHub anchor (nothing precedes the first heading),
   * so this slug exists only to give the span a stable `(path, slug)` key.
   */
  slug: string;
  /** Plain text of the section body (code blocks kept verbatim). */
  text: string;
  /** First line of the span, 1-based, inclusive of the heading line. */
  startLine: number;
  /** Last line of the span, 1-based. */
  endLine: number;
  /** True when the span was cut at the 8192-token budget. */
  truncated: boolean;
}

/** Hard token budget for one section (Issue #3 §4: 8K cap per section). */
const MAX_SECTION_TOKENS = 8192;

/**
 * Token estimate, deliberately cheap and deterministic:
 *   - every CJK code point counts 1 (CJK carries ~1 token per character);
 *   - every maximal `[A-Za-z0-9_]+` run counts 1 (one identifier/word);
 *   - every other code point counts 1/2, in pairs (2 symbols ≈ 1 token).
 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let runs = 0;
  let others = 0;
  let inRun = false;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    const cls = classify(code);
    if (cls === CharClass.Cjk) {
      cjk++;
      inRun = false;
    } else if (cls === CharClass.Word) {
      if (!inRun) {
        runs++;
        inRun = true;
      }
    } else {
      others++;
      inRun = false;
    }
  }
  return cjk + runs + Math.floor(others / 2);
}

const enum CharClass {
  Cjk,
  Word,
  Other,
}

/** CJK Unified Ideographs + extensions, Hiragana, Katakana, Hangul. */
function classify(code: number): CharClass {
  if (
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x20000 && code <= 0x2a6dd) ||
    (code >= 0x3040 && code <= 0x30ff) ||
    (code >= 0xac00 && code <= 0xd7a3)
  ) {
    return CharClass.Cjk;
  }
  if (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    code === 0x5f
  ) {
    return CharClass.Word;
  }
  return CharClass.Other;
}

/**
 * Longest code-point prefix of `${title}\n${text}` whose `estimateTokens`
 * stays within the budget; the surviving prefix is mapped back to a prefix of
 * `text`. Cutting by code point (never mid-surrogate) keeps the truncated
 * text valid.
 */
function truncateToTokenBudget(title: string, text: string): { text: string; truncated: boolean } {
  const whole = `${title}\n${text}`;
  if (estimateTokens(whole) <= MAX_SECTION_TOKENS) return { text, truncated: false };

  let cjk = 0;
  let runs = 0;
  let others = 0;
  let inRun = false;
  let kept = 0; // UTF-16 length of the accepted prefix
  for (const ch of whole) {
    const code = ch.codePointAt(0) ?? 0;
    const cls = classify(code);
    if (cls === CharClass.Cjk) {
      cjk++;
      inRun = false;
    } else if (cls === CharClass.Word) {
      if (!inRun) {
        runs++;
        inRun = true;
      }
    } else {
      others++;
      inRun = false;
    }
    if (cjk + runs + Math.floor(others / 2) > MAX_SECTION_TOKENS) break;
    kept += ch.length;
  }
  // The budgeted prefix includes the title line; strip that back off so only
  // the body is cut. A title alone over budget leaves an empty body.
  const bodyKept = Math.max(0, kept - (title.length + 1));
  return { text: text.slice(0, bodyKept), truncated: true };
}

/**
 * Split a document (front matter included) into retrieval sections.
 *
 * Front matter is located with the same `scanBoundary` the validation
 * pipeline uses, and the body is parsed from `bodyStart` exactly like
 * `validateDocumentSync` does — the closing `---` marker parses as a thematic
 * break that is dropped here, so reported lines are 1-based document lines.
 */
export function extractSections(content: string): Section[] {
  const text = stripBom(content);
  const boundary = scanBoundary(text);
  // Same convention as validateDocumentSync: an unclosed front matter block
  // is ordinary text from offset 0, and a closed one starts the body at the
  // closing marker line.
  const bodyStart = boundary !== null && boundary.closeStart !== null ? boundary.closeStart : 0;
  const body = bodyStart === 0 ? text : text.slice(bodyStart);
  const tree = parseMarkdownSync(body);
  if (tree === null) return [];

  const children = [...tree.children];
  // Drop the artifact thematic break the slice created at body line 1; only
  // that node is dropped — a real `---` rule later in the body is content.
  const first = children[0];
  if (bodyStart > 0 && first?.type === 'thematicBreak' && first.position?.start.line === 1) {
    children.shift();
  }
  if (children.length === 0) return [];

  // Slice line N is document line N + bodyLineOffset: bodyStart is itself a
  // line start, so the offset is the number of lines fully above it.
  const starts = lineStarts(text);
  const bodyLineOffset = starts.filter((s) => s < bodyStart).length;
  const docLine = (sliceLine: number): number => sliceLine + bodyLineOffset;
  const lastDocLine = lastNonEmptyLine(text, starts);

  const slugger = new Slugger();
  const sections: Section[] = [];
  const headingIndices = children.reduce<number[]>((acc, node, i) => {
    if (node.type === 'heading') acc.push(i);
    return acc;
  }, []);

  const firstHeading = headingIndices[0];

  if (firstHeading === undefined) {
    // No heading at all: the entire body is one preamble section.
    const parts: string[] = [];
    appendBlocks(children, parts);
    sections.push(
      buildSection('(preamble)', 0, 'preamble', parts.join(''), docLine(lineOf(children[0], 1)), lastDocLine),
    );
    return sections;
  }

  if (firstHeading > 0) {
    const parts: string[] = [];
    appendBlocks(children.slice(0, firstHeading), parts);
    const next = children[firstHeading];
    sections.push(
      buildSection(
        '(preamble)',
        0,
        'preamble',
        parts.join(''),
        docLine(lineOf(children[0], 1)),
        Math.max(docLine(lineOf(children[0], 1)), docLine(lineOf(next, 1)) - 1),
      ),
    );
  }

  for (let h = 0; h < headingIndices.length; h++) {
    const i = headingIndices[h];
    if (i === undefined) continue;
    const heading = children[i];
    if (!heading || heading.type !== 'heading') continue;
    const nextHeading = headingIndices[h + 1];
    const bodyEnd = nextHeading === undefined ? children.length : nextHeading;
    const parts: string[] = [];
    appendBlocks(children.slice(i + 1, bodyEnd), parts);
    const startLine = docLine(lineOf(heading, 1));
    const endLine = nextHeading === undefined
      ? Math.max(startLine, lastDocLine)
      : Math.max(startLine, docLine(lineOf(children[nextHeading], startLine)) - 1);
    sections.push(
      buildSection(headingText(heading), heading.depth, slugger.slug(headingText(heading)), parts.join(''), startLine, endLine),
    );
  }
  return sections;
}

function buildSection(
  title: string,
  level: number,
  slug: string,
  text: string,
  startLine: number,
  endLine: number,
): Section {
  const { text: kept, truncated } = truncateToTokenBudget(title, text);
  return { title, level, slug, text: kept, startLine, endLine, truncated };
}

/** 1-based start line of `node`, falling back to `fallback`. */
function lineOf(node: { position?: { start?: { line?: number } } } | undefined, fallback: number): number {
  return node?.position?.start?.line ?? fallback;
}

/**
 * Walk block-level nodes collecting literal text. `text` and `inlineCode`
 * values are taken verbatim, fenced and indented `code` blocks are kept whole
 * (identifiers are retrieval-critical), and list/table cell text is included
 * through the same recursion. Block boundaries become single newlines so
 * words from adjacent blocks never fuse; phrasing within one paragraph
 * concatenates directly, matching how it reads.
 */
function appendBlocks(nodes: readonly unknown[], parts: string[]): void {
  let wrote = false;
  for (const node of nodes) {
    const before = parts.length;
    if (wrote) parts.push('\n');
    appendNodeText(node, parts, blockChildren(node));
    if (parts.length > before) wrote = true;
  }
}

/** Parents whose children are block-level (all other parents hold phrasing). */
const BLOCK_CHILDREN_TYPES = new Set(['root', 'blockquote', 'list', 'listItem', 'table', 'tableRow']);

function blockChildren(node: unknown): boolean {
  const type = typeof node === 'object' && node !== null ? (node as { type?: unknown }).type : undefined;
  return typeof type === 'string' && BLOCK_CHILDREN_TYPES.has(type);
}

function appendNodeText(node: unknown, parts: string[], childBlocks: boolean): void {
  if (typeof node !== 'object' || node === null) return;
  const n = node as { type?: unknown; value?: unknown; children?: unknown[] };
  if (n.type === 'text' || n.type === 'inlineCode' || n.type === 'code') {
    if (typeof n.value === 'string' && n.value.length > 0) parts.push(n.value);
    return;
  }
  if (!Array.isArray(n.children)) return;
  let wrote = false;
  for (const child of n.children) {
    const before = parts.length;
    if (childBlocks && wrote) parts.push('\n');
    appendNodeText(child, parts, blockChildren(child));
    if (parts.length > before) wrote = true;
  }
}

/** Plain text of a heading: phrasing content flattened, inline code verbatim. */
function headingText(node: { children?: unknown[] }): string {
  const parts: string[] = [];
  if (Array.isArray(node.children)) {
    for (const child of node.children) appendNodeText(child, parts, false);
  }
  return parts.join('');
}

/** 1-based number of the last line that carries any non-whitespace byte. */
function lastNonEmptyLine(text: string, starts: number[]): number {
  let last = starts.length; // 1-based line count
  while (last > 1 && text.slice(starts[last - 1] ?? 0).trim() === '') {
    last--;
  }
  return last;
}
