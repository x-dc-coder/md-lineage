/**
 * Line-ending hygiene (docs/line-ending-management.md §4.1).
 *
 * A raw-buffer scan that runs before AST parsing on purpose: the check stays
 * exact when the Markdown under it fails to parse, and it works on unsaved
 * editor buffers, which is exactly where phantom CRLF appears first.
 *
 * MDL601 — more than one line-ending style (LF, CRLF, CR) in one file.
 * MDL602 — the file's line endings disagree with the configured policy
 *          (default LF). Only the first offending line is reported, so one
 *          diagnostic maps to one whole-buffer normalization fix.
 */

import type { Diagnostic } from './diagnostic.js';
import { severityOf } from './diagnostic.js';
import type { LineMap } from './source-map.js';
import { rangeAt } from './source-map.js';

/** Line-ending classification of one line terminator. */
type EolStyle = 'lf' | 'crlf' | 'cr';

/** Raw-byte scan of a document. Never throws, never allocates per line. */
export interface EolScanResult {
  readonly style: EolStyle | 'none';
  readonly mixed: boolean;
  readonly violations: ReadonlyArray<{ line: number; offset: number; style: EolStyle }>;
}

/**
 * Scan the raw buffer for line-ending styles. `text` is the document string;
 * the scan inspects its code units, so a lone CR, an LF, and a CRLF are three
 * distinguishable terminators.
 */
export function scanLineEndings(text: string): EolScanResult {
  const found = new Set<EolStyle>();
  const violations: { line: number; offset: number; style: EolStyle }[] = [];
  let line = 1;

  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x0d) {
      const style: EolStyle = text.charCodeAt(i + 1) === 0x0a ? 'crlf' : 'cr';
      found.add(style);
      if (style === 'crlf') i += 1;
      violations.push({ line, offset: i, style });
      line += 1;
    } else if (c === 0x0a) {
      found.add('lf');
      violations.push({ line, offset: i, style: 'lf' });
      line += 1;
    }
  }

  return {
    style: found.size === 0 ? 'none' : (firstOf(found) ?? 'lf'),
    mixed: found.size > 1,
    violations,
  };
}

function firstOf(set: Set<EolStyle>): EolStyle | undefined {
  for (const value of set) return value;
  return undefined;
}

/**
 * Produce MDL601/MDL602 diagnostics for a document.
 *
 * MDL601 is reported once, at the first line whose style differs from the
 * document's first style — that is the line a whole-buffer normalization must
 * start considering. MDL602 is reported once, at the first line that violates
 * the policy. A single-run file therefore yields at most one diagnostic.
 */
export function validateLineEndings(
  text: string,
  lineMap: LineMap,
  policy: 'lf' | 'crlf' | 'cr',
  severityOverrides?: Record<string, 'error' | 'warning' | 'information' | 'hint'>,
): Diagnostic[] {
  const scan = scanLineEndings(text);
  const out: Diagnostic[] = [];

  if (scan.mixed) {
    const first = scan.violations[0]!.style;
    const offender = scan.violations.find((v) => v.style !== first);
    if (offender) {
      // Point at the line whose terminator differs, so an editor highlights the
      // line a whole-buffer normalization will rewrite.
      const at = lineStartBefore(lineMap, offender.offset);
      out.push(mdl('MDL601', 'Mixed line endings within one file', lineMap, at, offender, severityOverrides));
    }
  }

  if (scan.style !== 'none' && scan.style !== policy) {
    const offender = scan.violations.find((v) => v.style !== policy) ?? scan.violations[0];
    if (offender) {
      const at = lineStartBefore(lineMap, offender.offset);
      out.push(
        mdl(
          'MDL602',
          `Line ending does not match repository policy (expected ${policy.toUpperCase()})`,
          lineMap,
          at,
          offender,
          severityOverrides,
        ),
      );
    }
  }

  return out;
}

/**
 * Offset of the first code unit of the line whose terminator sits at `offset`.
 *
 * `offset` is what the EOL scan reports: the LF of a CRLF pair (one unit past
 * the CR), or the LF/CR itself. The containing line is the one that starts
 * strictly before that offset.
 */
function lineStartBefore(lineMap: LineMap, offset: number): number {
  const starts = lineMap.lineStarts;
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (starts[mid]! < offset) lo = mid;
    else hi = mid - 1;
  }
  return starts[lo]!;
}

function mdl(
  code: string,
  message: string,
  lineMap: LineMap,
  offset: number,
  offender: { line: number; offset: number; style: EolStyle },
  severityOverrides?: Record<string, 'error' | 'warning' | 'information' | 'hint'>,
): Diagnostic {
  // The range spans the offending line's terminator so a fixer can replace it
  // in place; a CRLF's range is two code units wide.
  const end = offset + (offender.style === 'crlf' ? 2 : 1);
  return {
    code,
    severity: severityOf(code, severityOverrides),
    message,
    range: rangeAt(lineMap, offset, end),
    layer: 'eol-scan',
    data: { style: offender.style, line: offender.line },
  };
}
