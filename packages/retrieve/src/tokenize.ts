/**
 * Retrieval tokenizer (Issue #3 §4: "BM25（CJK bigram + 标识符分词）").
 *
 * Design goals: zero dependencies, byte-deterministic output order, and
 * retrieval-critical identifier handling. Three families of input:
 *
 *   - ASCII identifier runs `[A-Za-z0-9_]+` are emitted lowercased as one
 *     token, plus camelCase/underscore subwords so a query spelling only
 *     part of an identifier still matches ("extractSections" indexes both
 *     "extractsections" and "extract" + "sections").
 *   - CJK text is indexed as overlapping character bigrams (检索引擎 →
 *     检索/索引/引擎), the standard trick that gives BM25 substring recall
 *     over unsegmented Chinese; an isolated CJK character (no CJK
 *     neighbour) is emitted as a unigram so single-character queries and
 *     one-character runs are not lost.
 *   - everything else (punctuation, whitespace, symbols) is dropped.
 */

/** Split an identifier run into subwords at camelCase and `_` boundaries. */
function subwords(word: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 1; i < word.length; i++) {
    const prev = word[i - 1];
    const ch = word[i];
    if (prev === undefined || ch === undefined) break;
    // `_` is an identifier separator: "foo_bar" also indexes "foo" + "bar".
    if (ch === '_') {
      emit(out, word.slice(start, i));
      start = i + 1;
      continue;
    }
    const prevUpper = prev >= 'A' && prev <= 'Z';
    const chUpper = ch >= 'A' && ch <= 'Z';
    // aB: a non-uppercase letter followed by an uppercase letter starts a new
    // subword ("extractSections" → extract|Sections).
    if (!prevUpper && chUpper) {
      emit(out, word.slice(start, i));
      start = i;
      continue;
    }
    // ABc: an uppercase letter followed by Upper+lower means the second
    // uppercase belongs to the next word ("HTTPServer" → HTTP|Server).
    if (prevUpper && chUpper) {
      const next = word[i + 1];
      if (next !== undefined && next >= 'a' && next <= 'z') {
        emit(out, word.slice(start, i));
        start = i;
      }
    }
  }
  emit(out, word.slice(start));
  return out;
}

/** Lowercased push; empty pieces are skipped. */
function emit(out: string[], piece: string): void {
  if (piece.length > 0) out.push(piece.toLowerCase());
}

/** Emit the whole lowercased word, then its subwords when a split happened. */
function emitWord(word: string, out: string[]): void {
  const whole = word.toLowerCase();
  out.push(whole);
  const subs = subwords(word);
  // A word with no internal boundary would re-emit itself; only real splits
  // add tokens ("Cat" → cat, "extractSections" → extractsections + extract
  // + sections).
  if (subs.length > 1 || (subs[0] !== undefined && subs[0] !== whole)) {
    for (const sub of subs) out.push(sub);
  }
}

function isAsciiWordChar(ch: string): boolean {
  return (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch === '_';
}

function isCjkCode(code: number): boolean {
  return (
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x20000 && code <= 0x2a6dd) ||
    (code >= 0x3040 && code <= 0x30ff) ||
    (code >= 0xac00 && code <= 0xd7a3)
  );
}

/** Flush a maximal CJK run: overlapping bigrams, or one unigram when alone. */
function flushCjkRun(run: string[], out: string[]): void {
  if (run.length === 1) {
    out.push(run[0] as string);
  } else {
    for (let i = 0; i + 1 < run.length; i++) {
      out.push(`${run[i]}${run[i + 1]}`);
    }
  }
}

/**
 * Tokenize `text` for BM25. Order is deterministic: input order, whole word
 * before its subwords, bigrams left-to-right. Duplicates are kept — term
 * frequency is the caller's (BM25's) business.
 */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  let word = '';
  let cjkRun: string[] = [];

  for (const ch of text) {
    if (isAsciiWordChar(ch)) {
      if (word.length === 0) flushCjkRun(cjkRun.splice(0), out);
      word += ch;
      continue;
    }
    if (word.length > 0) {
      emitWord(word, out);
      word = '';
    }
    if (isCjkCode(ch.codePointAt(0) ?? 0)) {
      cjkRun.push(ch);
    } else {
      flushCjkRun(cjkRun.splice(0), out);
    }
  }
  if (word.length > 0) emitWord(word, out);
  flushCjkRun(cjkRun, out);
  return out;
}
