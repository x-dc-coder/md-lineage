/**
 * Front matter extraction (docs/remark-language-server-solution.md §4.2).
 *
 * remark-frontmatter cannot be the only front matter detector: Markdown degrades
 * an unclosed fence to ordinary paragraph text, which would silently turn
 * MDL001 into "no front matter at all". So the boundary scan runs first, on the
 * raw buffer, before the AST exists.
 *
 * Boundary rules (docs/frontmatter-spec.md):
 *   - the opening `---` must start at offset 0;
 *   - the closing `---` must be the first non-space content of its own line;
 *   - the block ends there.
 *
 * The YAML payload is parsed with the `yaml` library, which reports every node's
 * source offsets — the JSON Pointer → CST → offsets mapping of §8.3 starts here.
 */

import { parseDocument } from 'yaml';
import type { Document } from 'yaml';
import type { LineMap } from './source-map.js';
import { rangeAt } from './source-map.js';

/** Result of the boundary scan. */
export interface BoundaryScan {
  /** Offset of the first YAML byte (after the opening marker line). */
  readonly contentStart: number;
  /** Offset of the closing marker line, or null when the block is unclosed. */
  readonly closeStart: number | null;
  /** Absolute document offset of the first YAML byte (same as contentStart). */
  readonly rawStart: number;
  /** The raw YAML slice between the markers. */
  readonly raw: string;
}

const CLOSE_MARKER = /^-{3,}\s*$/;

/**
 * Scan the raw buffer for a front matter fence. Returns null when the document
 * has no front matter at all — which is only an error when metadata.required.
 */
export function scanBoundary(text: string): BoundaryScan | null {
  if (!text.startsWith('---')) return null;

  // The content starts after the opening marker and its line ending (CRLF, LF
  // or lone CR), so a CRLF file's raw slice does not begin with a stray LF.
  const contentStart = skipEol(text, 3);
  const starts = lineStarts(text);

  // The closing marker must be a line of its own after the opening one.
  let closeStart: number | null = null;
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i]!;
    if (start < contentStart) continue;
    const end = i + 1 < starts.length ? starts[i + 1]! - eolBefore(text, starts[i + 1]!) : text.length;
    const line = text.slice(start, end);
    if (CLOSE_MARKER.test(line)) {
      closeStart = start;
      break;
    }
  }

  const rawEnd = closeStart === null ? text.length : closeStart;
  return {
    contentStart,
    closeStart,
    rawStart: contentStart,
    raw: text.slice(contentStart, rawEnd),
  };
}

/** Length of the line ending at `offset` (CRLF, LF or lone CR). */
function skipEol(text: string, offset: number): number {
  if (text.charCodeAt(offset) === 0x0d) {
    return offset + (text.charCodeAt(offset + 1) === 0x0a ? 2 : 1);
  }
  if (text.charCodeAt(offset) === 0x0a) return offset + 1;
  return offset;
}

/** Length of the line ending that terminates the line that starts at `end`. */
function eolBefore(text: string, end: number): number {
  if (end <= 0) return 0;
  if (text.charCodeAt(end - 1) === 0x0a) return end >= 2 && text.charCodeAt(end - 2) === 0x0d ? 2 : 1;
  return 0;
}

/**
 * Offsets of every line start in `text` (LF, CRLF and lone CR all handled).
 *
 * A CRLF is one line break, so the next line starts after the LF — pushing
 * `crIndex + 1` would land on the LF itself and every "line" would look empty.
 */
export function lineStarts(text: string): number[] {
  const starts: number[] = [0];
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x0a) {
      starts.push(i + 1);
    } else if (c === 0x0d) {
      if (text.charCodeAt(i + 1) === 0x0a) {
        starts.push(i + 2);
        i += 1;
      } else {
        starts.push(i + 1);
      }
    }
  }
  return starts;
}

/** Parsed front matter: the data, the CST (for JSON-Pointer lookups) and the raw slice. */
export interface ParsedFrontmatter {
  /** The whole front matter object, or null when YAML did not parse. */
  data: Record<string, unknown> | null;
  /** Parsed YAML document, carrying every node's source offsets. */
  doc: Document;
  /** Absolute document offset of `raw[0]`. */
  rawStart: number;
  /** Number of non-fatal YAML warnings. */
  warnings: string[];
}

/**
 * Parse the front matter slice. `rawStart` is the absolute document offset of
 * `raw[0]` and is added to every CST offset by the caller.
 *
 * Returns either a parsed document or a MDL002-style error already positioned in
 * document coordinates. Never throws.
 */
export function parseFrontmatter(
  raw: string,
  rawStart: number,
  lineMap: LineMap,
): { parsed: ParsedFrontmatter | null; error: FrontmatterError | null } {
  const doc = parseDocument(raw, { keepSourceTokens: true });

  if (doc.errors.length > 0) {
    // YAML errors carry 1-based line/column relative to `raw`; convert them to
    // absolute document offsets so the diagnostic lands on the offending bytes.
    const first = doc.errors[0]!;
    const lineIndex = first.linePos?.[0];
    const start =
      lineIndex && lineIndex.line >= 1
        ? rawStart + (lineMap.lineStarts[lineIndex.line - 1] ?? 0) + (lineIndex.col - 1)
        : rawStart + (first.pos[0] ?? 0);
    const end = start + Math.max(1, (first.pos[1] ?? first.pos[0] ?? 0) - (first.pos[0] ?? 0));
    return {
      parsed: null,
      error: {
        message: first.message,
        range: rangeAt(lineMap, start, end),
        rawStart,
        raw,
      },
    };
  }

  const js = doc.toJS();
  const data = js === null || typeof js !== 'object' || Array.isArray(js) ? null : (js as Record<string, unknown>);

  return {
    parsed: {
      data,
      doc,
      rawStart,
      warnings: doc.warnings.map((w) => w.message),
    },
    error: null,
  };
}

export interface FrontmatterError {
  message: string;
  range: ReturnType<typeof rangeAt>;
  rawStart: number;
  raw: string;
}
