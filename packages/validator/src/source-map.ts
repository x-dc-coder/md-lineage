/**
 * Source-map utilities: translate YAML CST offsets (UTF-16 code units, since
 * `yaml` indexes JavaScript strings) into document-internal line/column.
 *
 * Line/column lookup is a binary search over a precomputed line-start table, so
 * a full document validation costs O(lines + diagnostics · log lines).
 */

export interface LineMap {
  /** Offset (UTF-16 code units) of the first code unit of each line. */
  readonly lineStarts: readonly number[];
  readonly length: number;
}

/** Build a line-start table from a document string. */
export function buildLineMap(text: string): LineMap {
  const lineStarts: number[] = [0];
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x0a) {
      lineStarts.push(i + 1);
    } else if (c === 0x0d) {
      // CRLF is one line break; a lone CR is also one.
      lineStarts.push(i + 1);
      if (text.charCodeAt(i + 1) === 0x0a) i += 1;
    }
  }
  return { lineStarts, length: text.length };
}

/**
 * Resolve an absolute document offset to 1-based line and 1-based UTF-16
 * column. Out-of-range offsets clamp to the document bounds.
 */
export function positionAt(lineMap: LineMap, offset: number): { line: number; column: number; offset: number } {
  const clamped = Math.max(0, Math.min(offset, lineMap.length));
  const starts = lineMap.lineStarts;
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (starts[mid]! <= clamped) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, column: clamped - starts[lo]! + 1, offset: clamped };
}

export interface ResolvedRange {
  start: { line: number; column: number; offset: number };
  end: { line: number; column: number; offset: number };
}

/** Resolve a [start, end) offset pair to a document range. */
export function rangeAt(lineMap: LineMap, start: number, end: number): ResolvedRange {
  const s = positionAt(lineMap, start);
  const e = positionAt(lineMap, Math.max(start, end));
  return { start: s, end: e };
}
