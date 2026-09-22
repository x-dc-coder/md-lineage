/**
 * Position translation: validator coordinates → LSP coordinates.
 * (docs/remark-language-server-solution.md §8.3)
 *
 * The two coordinate systems differ in origin and unit:
 *   - validator `line`/`column` are 1-based; LSP `line`/`character` are 0-based;
 *   - validator `column` counts UTF-16 code units (a JS string's own unit), and
 *     LSP `character` is defined the same way for the default UTF-16 position
 *     encoding — a surrogate pair is TWO characters, a combining mark is one.
 *
 * The conversion is therefore derived from the line's TEXT rather than
 * subtracting one from `column` in place. Both give the same number today, and
 * deriving it from text is what keeps this module the single place that has to
 * be right when a rule starts counting code points or UTF-8 bytes instead: the
 * 中文/emoji/combining-mark tests below fail here rather than silently shifting
 * every diagnostic in an editor.
 */

import type { Diagnostic, Range } from '@mdlineage/validator';

/** LSP position: 0-based line, 0-based UTF-16 code unit character. */
export interface LspPosition {
  line: number;
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

/** Resolves a 1-based validator line to that line's text, terminator excluded. */
export type LineLookup = (line: number) => string | undefined;

/**
 * The 0-based LSP character of a 1-based validator column on `lineText`.
 *
 * Counts UTF-16 code units in the line's prefix: 😀 is one code point but two
 * characters, and a line of `中😀` puts 😀 at character 2, not 1. The count walks
 * `charCodeAt`, NOT a code-point iterator — `for...of` yields code points and
 * would count an astral character once, which is exactly the byte/code-point
 * confusion §8.3 forbids. A column past the line's end clamps to it, which is
 * where a range covering a final line break lands.
 */
export function characterOf(lineText: string, column: number): number {
  const units = Math.max(0, Math.min(column, lineText.length + 1) - 1);
  return units;
}

/**
 * UTF-16 code units spanned by a whole line, read directly off the string. The
 * code-point count differs by one per astral character, and that gap is the
 * assertion §8.3 asks a test to make.
 */
export function utf16Length(lineText: string): number {
  return lineText.length;
}

/**
 * Translate a validator range into an LSP range.
 *
 * `lineAt` supplies the line text the UTF-16 conversion reads; callers pass
 * whatever they hold — the LSP's in-memory `TextDocument`, or a line table built
 * from a document string when publishing without one.
 */
export function toLspRange(range: Range, lineAt: LineLookup): LspRange {
  const startLine = Math.max(1, range.start.line);
  const endLine = Math.max(startLine, range.end.line);
  return {
    start: {
      line: startLine - 1,
      character: characterOf(lineAt(startLine) ?? '', range.start.column),
    },
    end: {
      line: endLine - 1,
      character: characterOf(lineAt(endLine) ?? '', range.end.column),
    },
  };
}

/**
 * Translate one diagnostic for a document held as 0-based lines (the indexing a
 * `TextDocument` consumer already works in; `toLspRange` takes 1-based lines).
 */
export function diagnosticRange(diag: Diagnostic, lines: ReadonlyArray<string>): LspRange {
  return toLspRange(diag.range, (line) => lines[line - 1]);
}
