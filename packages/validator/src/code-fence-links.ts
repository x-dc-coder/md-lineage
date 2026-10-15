/**
 * Code-fence path extraction and corpus-relative resolution (MDL404).
 *
 * Fenced code blocks with a shell info string (`bash`, `sh`, `shell`,
 * `console`) are the documentation convention for "run this": SKILL.md-style
 * repositories carry runnable paths inside ``` fences that the Markdown link
 * scan (MDL401) never sees, because a `code` node is not a link. This module
 * extracts the path-shaped tokens from the argument position of a small
 * command-head whitelist and resolves them like any other corpus reference:
 * document-directory first, corpus-root-relative as fallback — the same
 * priority `resolveLinkPath` gives Markdown links.
 *
 * Extraction is deliberately conservative (prefer misses over false
 * positives): unknown command heads are dropped, a flag in the argument slot
 * abandons the whole segment, and every line is re-read from the RAW document
 * text through the line map so CRLF documents keep their columns. The check
 * itself is gated by `links.codeFences` at validation time; extraction at
 * index time is unconditional so index contents depend on document content
 * only (LSP config hot-reloads never need a re-index).
 *
 * Pure functions, no IO, never throws. No new npm dependencies.
 */

import type { Root } from 'mdast';
import { visitTree } from './document-validator.js';
import type { LineMap } from './source-map.js';
import { positionAt } from './source-map.js';
import type { DocPath } from './workspace-index.js';

/** Fence info strings whose blocks this layer reads; every other language (and no language) is skipped. */
export const SHELL_FENCE_LANGS: ReadonlySet<string> = new Set(['bash', 'sh', 'shell', 'console']);

/** One path-shaped token extracted from a shell fence, in document coordinates. */
export interface FenceLinkEntry {
  /** The token as authored, for the message and for resolution. */
  readonly token: string;
  /**
   * Absolute document offset (UTF-16) of the token's first code unit — the
   * same coordinate system `LinkEntry.offset` uses, so transports need no
   * per-layer conversion.
   */
  readonly offset: number;
}

/** Command heads whose first argument is treated as a corpus path. */
const COMMAND_HEADS: ReadonlySet<string> = new Set(['python', 'python3', 'node', 'bash', 'sh', 'source', 'cd']);

/** A segment-initial command is directly executable when it is itself a path. */
const DIRECT_PREFIX = /^(?:\.\.?\/)/;

/**
 * Prompt forms stripped once per line: `$`, `>`, Windows `PS>` — and `#`, but
 * ONLY in the console dialect. In bash/sh/shell a line-initial `#` (leading
 * whitespace allowed) is a comment, never a root prompt, so it must not peel
 * `# python scripts/a.py` into a phantom command.
 */
const PROMPT_RE = /^\s*(?:\$|>|PS>)\s+/;
const CONSOLE_PROMPT_RE = /^\s*(?:\$|#|>|PS>)\s+/;

/** Redirection operators (`>`, `>>`, `2>`, `&>`) — everything from them on is a write target, not a reference. */
const REDIRECT_RE = /(^|\s)[0-9&]?>>?\s/;

/** Command-segment separators: a pipeline or list starts a new segment. */
const SEGMENT_SPLIT_RE = /\|\||&&|;|\|/;

/** Syntax a path token may never carry. */
const FORBIDDEN_CHARS_RE = /[<>*?[\]:=]|\s/;

/**
 * Token checkability predicate: the relative, non-placeholder, non-glob shape
 * a corpus reference must have. Host-absolute, home-relative, env-expanded,
 * URL and flag forms are excluded — MDL403 owns host paths, and everything
 * here is judged only inside the corpus root.
 */
export function isCheckableFenceToken(token: string): boolean {
  if (!token.includes('/')) return false;
  if (token.startsWith('/') || token.startsWith('~') || token.startsWith('$') || token.startsWith('-')) return false;
  if (token.startsWith('http://') || token.startsWith('https://')) return false;
  if (FORBIDDEN_CHARS_RE.test(token)) return false;
  return true;
}

export interface PathToken {
  readonly text: string;
  /** 0-based column of the token's first code unit within the given line. */
  readonly column: number;
}

/**
 * One line's path candidates: the argument-slot token of each whitelisted
 * command segment, after prompt stripping, comment truncation and redirect
 * truncation. Pure and never throws.
 *
 * `lang` selects the prompt dialect (default `bash`): the console dialect
 * strips `#` root prompts, while bash/sh/shell treat a line-initial `#` as a
 * comment — both keep the pipeline honest either way.
 *
 * Pipeline order is fixed:
 *   1. strip one shell prompt (`#` only in the console dialect),
 *   2. drop whole-line comments and truncate trailing ones,
 *   3. truncate at redirection operators,
 *   4. split into command segments,
 *   5. take the first argument slot of a whitelisted head (`-` abandons the
 *      segment — flag VALUES are not paths: `node -r ts-node/register`),
 *   6. a `cd <checkable path>` segment yields its own candidate and trips a
 *      breaker for the REST of the line: cwd rebasing cannot be tracked
 *      reliably, so later segments on the line are dropped (prefer misses
 *      over wrong roots). `extractFenceLinks` carries the breaker across the
 *      fence's remaining lines.
 */
export function extractPathTokens(line: string, lang = 'bash'): readonly PathToken[] {
  return extractLine(line, lang.trim().toLowerCase() === 'console').tokens;
}

/** Line extraction plus whether a `cd` blew the fence-wide breaker. */
interface LineExtraction {
  readonly tokens: readonly PathToken[];
  readonly fuse: boolean;
}

function extractLine(line: string, consolePrompts: boolean): LineExtraction {
  const out: PathToken[] = [];

  // Only the prompt strip removes text from the FRONT; truncations below cut
  // the tail, so one prefix length keeps every later column line-accurate.
  const prompt = (consolePrompts ? CONSOLE_PROMPT_RE : PROMPT_RE).exec(line);
  const prefixLen = prompt ? prompt[0].length : 0;
  let work = line.slice(prefixLen);
  if (work.trim().startsWith('#')) return { tokens: out, fuse: false };
  const hashAt = work.search(/\s#/);
  if (hashAt >= 0) work = work.slice(0, hashAt);

  const redirect = REDIRECT_RE.exec(work);
  if (redirect && redirect.index !== undefined) work = work.slice(0, redirect.index);

  let fuse = false;
  for (const at of segmentRanges(work)) {
    if (fuse) break;
    const segment = work.slice(at.start, at.end);
    const words = [...segment.matchAll(/\S+/g)];
    const head = words[0]?.[0];
    if (head === undefined) continue;
    let slot = -1;
    let isCd = false;
    if (DIRECT_PREFIX.test(head)) {
      slot = 0;
    } else if (COMMAND_HEADS.has(head)) {
      slot = 1;
      isCd = head === 'cd';
    } else if (head === 'uv' && words[1]?.[0] === 'run') {
      // `uv run [flags] python <p>`: the interpreter names the script slot.
      for (let i = 2; i < words.length; i++) {
        const w = words[i]?.[0];
        if (w === 'python' || w === 'python3') {
          slot = i + 1;
          break;
        }
      }
    } else {
      continue;
    }
    const rawMatch = slot >= 0 ? words[slot] : undefined;
    const rawSlot = rawMatch?.[0];
    if (rawSlot === undefined || rawMatch === undefined || rawSlot.startsWith('-')) continue;

    const cleaned = cleanToken(rawSlot);
    if (cleaned === null || !isCheckableFenceToken(cleaned.text)) continue;

    // Column of the token's first code unit in the ORIGINAL line: segment
    // base + word offset, plus whatever leading characters the cleaning peeled.
    const column = prefixLen + at.start + rawMatch.index + cleaned.leading;
    if (column + cleaned.text.length > line.length) continue;
    out.push({ text: cleaned.text, column });
    if (isCd) fuse = true;
  }
  return { tokens: out, fuse };
}

/** Start/end offsets of each command segment within the line body. */
function segmentRanges(work: string): readonly { readonly start: number; readonly end: number }[] {
  const ranges: { start: number; end: number }[] = [];
  const re = new RegExp(SEGMENT_SPLIT_RE.source, 'g');
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(work)) !== null) {
    ranges.push({ start: cursor, end: match.index });
    cursor = match.index + match[0].length;
  }
  ranges.push({ start: cursor, end: work.length });
  return ranges;
}

/** Strip paired quotes and trailing list punctuation (`,` `)` `&`); `(` marks prose, not a path. */
function cleanToken(raw: string): { text: string; leading: number } | null {
  let token = raw;
  let leading = 0;
  const unquote = (): void => {
    if (token.length >= 2 && ((token.startsWith("'") && token.endsWith("'")) || (token.startsWith('"') && token.endsWith('"')))) {
      token = token.slice(1, -1);
      leading += 1;
    }
  };
  unquote();
  while (token.endsWith(',') || token.endsWith(')') || token.endsWith('&')) {
    token = token.slice(0, -1);
    unquote();
  }
  if (token.length === 0 || token.includes('(')) return null;
  return { text: token, leading };
}

/**
 * Path tokens from every shell fence of one document, in document order —
 * the fence-layer counterpart of `extractLinks`.
 *
 * Line text comes from the RAW content through the line map, never from
 * `code.value`: deriving columns from the value would shift every token on a
 * CRLF document by the carriage returns. `bodyStart` shifts the body-relative
 * mdast offsets onto the whole document, as `extractLinks` does.
 */
export function extractFenceLinks(
  content: string,
  tree: Root | null,
  bodyStart: number,
  lineMap: LineMap,
): readonly FenceLinkEntry[] {
  if (!tree) return [];
  const out: FenceLinkEntry[] = [];
  visitTree(tree, (node) => {
    if (node.type !== 'code') return;
    const code = node as { lang?: string | null; position?: { start?: { offset?: number }; end?: { offset?: number } } };
    const lang = typeof code.lang === 'string' ? code.lang.trim().toLowerCase() : null;
    if (lang === null || !SHELL_FENCE_LANGS.has(lang)) return;
    const startOffset = code.position?.start?.offset;
    const endOffset = code.position?.end?.offset;
    if (startOffset === undefined || endOffset === undefined) return;

    // Body-relative node offsets -> whole-document line indexes (0-based).
    const openLine = positionAt(lineMap, bodyStart + startOffset).line - 1;
    const closeLine = positionAt(lineMap, bodyStart + endOffset).line - 1;
    // The closing fence marker line is excluded; an unterminated fence's last
    // line is content (the raw-line check tells the two apart).
    let last = closeLine - 1;
    if (!isClosingFenceLine(rawLineAt(content, lineMap, closeLine))) last = closeLine;

    let fuse = false;
    for (let line0 = openLine + 1; line0 <= last; line0++) {
      // A `cd` above re-based the working directory: every candidate below it
      // in the fence is dropped, so scanning can stop at the first one.
      if (fuse) break;
      const lineStart = lineMap.lineStarts[line0];
      if (lineStart === undefined) continue;
      const line = rawLineAt(content, lineMap, line0);
      const extraction = extractLine(line, lang === 'console');
      for (const token of extraction.tokens) {
        out.push({ token: token.text, offset: lineStart + token.column });
      }
      fuse = extraction.fuse;
    }
  });
  return out;
}

/** True for a ` ``` `/`~~~` fence marker line (the closing delimiter). */
function isClosingFenceLine(line: string): boolean {
  return /^\s{0,3}(?:```|~~~)/.test(line);
}

/** The line's raw text with the trailing line break (`\n`, `\r\n`, `\r`) removed. */
function rawLineAt(content: string, lineMap: LineMap, line0: number): string {
  const start = lineMap.lineStarts[line0];
  if (start === undefined || start >= lineMap.length) return '';
  const next = lineMap.lineStarts[line0 + 1];
  const end = next === undefined ? lineMap.length : next;
  let text = content.slice(start, end);
  while (text.endsWith('\n') || text.endsWith('\r')) text = text.slice(0, -1);
  return text;
}

/**
 * Resolve a fence token to its corpus-root-relative POSIX path, or null when
 * the token escapes the corpus root (a `..` popping an empty stack — those
 * are host paths and belong to MDL403's jurisdiction, not a missing file).
 *
 * Resolution mirrors `normalizeRelative`'s segment folding with the same
 * document-directory-first base, and matches it byte-for-byte on every
 * non-escaping input. `normalizeRelative` itself cannot be reused because it
 * silently absorbs an over-pop; here that is the escape signal.
 *
 * Federated scoped coordinates (`@scope//docs/a.md`) fold inside the member
 * coordinate system after the `//`, matching `resolveLinkPath`'s federation
 * semantics; the returned path carries the same scope prefix.
 */
export function resolveCorpusPath(fromPath: DocPath, token: string): string | null {
  const scoped = /^(@[a-z][a-z0-9-]*\/\/)(.+)$/.exec(fromPath);
  if (scoped) {
    const prefix = scoped[1] ?? '';
    const rest = scoped[2] ?? '';
    const dirEnd = rest.lastIndexOf('/') + 1;
    const inner = foldCorpusSegments(rest.slice(0, dirEnd), token);
    return inner === null ? null : prefix + inner;
  }
  const slash = fromPath.lastIndexOf('/');
  const dir = slash >= 0 ? fromPath.slice(0, slash + 1) : '';
  return foldCorpusSegments(dir, token);
}

/** Segment folding with over-pop detection; empty result = the corpus root itself. */
function foldCorpusSegments(dir: string, token: string): string | null {
  const parts = (dir + token.replace(/^\.[\\/]/, '')).split('/');
  const out: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join('/');
}
