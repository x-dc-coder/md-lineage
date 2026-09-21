/**
 * GFM heading slug generation (docs/remark-language-server-solution.md §14.1:
 * "GFM slug、重复 heading、Unicode heading").
 *
 * Implements the github-slugger algorithm as documented by GitHub:
 *   1. lowercase (Unicode-aware, so a Chinese heading keeps its characters);
 *   2. keep letters, numbers, spaces, hyphens and underscores — where "letter"
 *      and "number" are Unicode categories, so CJK and Cyrillic survive while
 *      emoji and punctuation are dropped;
 *   3. replace each run of whitespace with a single hyphen.
 *
 * GitHub additionally appends a numeric suffix when a slug repeats within one
 * document; `Slugger` below keeps a per-document counter so the second
 * `## Notes` becomes `notes-1`.
 */

/** Is the code unit a letter or number outside the ASCII range? */
function isUnicodeAlnum(code: number): boolean {
  // Surrogates are excluded so a heading such as "标题 😀" drops the emoji,
  // matching GitHub's rendering. Combining marks (U+0300–U+036F) are KEPT:
  // github-slugger leaves them in, so an NFD heading such as "Cafe\u0301"
  // produces "cafe\u0301" and only the NFC spelling must not collide with it.
  return (
    (code >= 0x300 && code <= 0x36f) || // combining marks (kept, like github-slugger)
    (code >= 0xc0 && code <= 0x2ff) || // Latin-1 supplement, Latin Extended
    (code >= 0x370 && code <= 0x1fff) || // Greek, Cyrillic, Hebrew, Arabic, Devanagari…
    (code >= 0x3040 && code <= 0xd7ff) || // CJK, Hangul, Hiragana, Katakana
    (code >= 0xf900 && code <= 0xfdff) || // CJK compatibility ideographs
    (code >= 0x10000 && code <= 0xeffff) // astral planes (all non-surrogate code points)
  );
}

/** Characters GitHub keeps, per the github-slugger rules. */
function kept(code: number): boolean {
  if (code >= 0x30 && code <= 0x39) return true; // 0-9
  if (code >= 0x61 && code <= 0x7a) return true; // a-z
  if (code >= 0x41 && code <= 0x5a) return true; // A-Z (lowercased later)
  if (code === 0x2d || code === 0x5f) return true; // - _
  if (code === 0x20 || code === 0x09) return true; // space, tab
  return isUnicodeAlnum(code);
}

/** Base slug without duplicate handling. Unicode letters (CJK etc.) are kept. */
export function slugifyHeading(text: string): string {
  const lower = text.toLowerCase();
  let out = '';
  for (let i = 0; i < lower.length; i++) {
    if (kept(lower.charCodeAt(i))) out += lower[i];
  }
  // Whitespace maps one-to-one to a hyphen: GitHub does not collapse runs,
  // so "## A  B" anchors as "a--b" (github-slugger semantics).
  let collapsed = '';
  for (const ch of lower) {
    collapsed += ch === ' ' || ch === '\t' ? '-' : ch;
  }
  return collapsed;
}

/**
 * Per-document slugger: returns the anchor as authored in an `evidence` value
 * (without the leading `#`), appending GitHub's `-n` suffix when the same base
 * slug appears more than once in the document.
 */
export class Slugger {
  private readonly counts = new Map<string, number>();

  /** Register a heading and get its anchor (no leading `#`). */
  slug(text: string): string {
    const base = slugifyHeading(text);
    const count = this.counts.get(base) ?? 0;
    this.counts.set(base, count + 1);
    return count === 0 ? base : `${base}-${count}`;
  }

  /** Every anchor the document produces, for membership tests. */
  anchors(): Set<string> {
    const out = new Set<string>();
    for (const [base, count] of this.counts) {
      out.add(base);
      // GitHub's repeat headings get -1, -2, … anchors; evidence may cite them.
      for (let n = 1; n < count; n++) out.add(`${base}-${n}`);
    }
    return out;
  }
}
