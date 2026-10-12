/**
 * BM25 lexical index over sections (Issue #3 Phase 1: pure lexical branch).
 *
 * The corpus unit is the section and the indexed string is
 * `${title}\n${text}` — the same string PR-3's `sectionKey(title, text)`
 * hashes, so a cached vector, a lexical hit and an evidence anchor all
 * describe the same span. k1 = 1.2, b = 0.75 (the canonical Robertson/Sparck
 * Jones defaults); document frequency counts sections, not files.
 *
 * Ranking is byte-deterministic: equal scores are ordered by the `(path,
 * slug)` lexicographic tie-break the issue mandates for the lexical branch.
 */

import { tokenize } from './tokenize.js';

/** One indexable section: the retrieval view of a validator `Section`. */
export interface Bm25Doc {
  /** Workspace-relative document path (the tie-break's first key). */
  path: string;
  /** Section slug (the tie-break's second key). */
  slug: string;
  title: string;
  text: string;
}

export interface Bm25Hit extends Bm25Doc {
  /** BM25 score; only comparable within one index over one query. */
  score: number;
}

const K1 = 1.2;
const B = 0.75;

/**
 * How a section's length enters the BM25 length norm.
 * `token-total` counts every token, including a repeated identifier and its
 * subwords. `unique-terms` counts `tf.size` instead. The default is chosen
 * in the 2026-10-12 hybrid comparison and recorded on the constructor.
 */
export type LengthAccounting = 'token-total' | 'unique-terms';

/**
 * Constructor default. On the 2026-10-12 comparison both accountings scored
 * Recall@10 100% and the same MRR@10, so the length norm stays the token
 * total (leftover #33). The report records the figures.
 */
export const DEFAULT_LENGTH_ACCOUNTING: LengthAccounting = 'token-total';

interface IndexedDoc {
  doc: Bm25Doc;
  tf: Map<string, number>;
  length: number;
}

export class Bm25Index {
  private readonly docs: IndexedDoc[];
  private readonly df = new Map<string, number>();
  private readonly avgdl: number;

  /**
   * Default is `token-total` (see `DEFAULT_LENGTH_ACCOUNTING`). Pass
   * `unique-terms` to score with the set-size length norm. The comparison
   * report records both Recall@10 and MRR@10 figures.
   */
  constructor(
    docs: readonly Bm25Doc[],
    lengthAccounting: LengthAccounting = DEFAULT_LENGTH_ACCOUNTING,
  ) {
    if (lengthAccounting !== 'token-total' && lengthAccounting !== 'unique-terms') {
      throw new Error(`length accounting must be token-total or unique-terms`);
    }
    this.docs = docs.map((doc) => {
      // The corpus string convention: title line then body — kept in sync
      // with the vector cache key so lexical and dense see the same text.
      const terms = tokenize(`${doc.title}\n${doc.text}`);
      const tf = new Map<string, number>();
      for (const term of terms) tf.set(term, (tf.get(term) ?? 0) + 1);
      const length = lengthAccounting === 'unique-terms' ? tf.size : terms.length;
      return { doc, tf, length };
    });
    for (const indexed of this.docs) {
      for (const term of indexed.tf.keys()) {
        this.df.set(term, (this.df.get(term) ?? 0) + 1);
      }
    }
    const total = this.docs.reduce((sum, d) => sum + d.length, 0);
    this.avgdl = this.docs.length === 0 ? 0 : total / this.docs.length;
  }

  get size(): number {
    return this.docs.length;
  }

  /**
   * Rank sections for `query`. Okapi BM25 with the idf
   * `ln(1 + (N - df + 0.5)/(df + 0.5))` (the Lucene variant: strictly
   * positive and uncapped — a term present in every document still yields
   * ln(1 + 1/(2N)) > 0, it never goes negative and never hits zero).
   * `limit <= 0` returns no hits (a negative slice would silently truncate
   * from the end, which is the bug this guard exists for).
   */
  search(query: string, limit?: number): Bm25Hit[] {
    if (limit !== undefined && limit <= 0) return [];
    const queryTerms = [...new Set(tokenize(query))];
    if (queryTerms.length === 0 || this.docs.length === 0) return [];
    const n = this.docs.length;
    const hits: Bm25Hit[] = [];
    for (const indexed of this.docs) {
      let score = 0;
      for (const term of queryTerms) {
        const tf = indexed.tf.get(term);
        if (tf === undefined) continue;
        const df = this.df.get(term) ?? 0;
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
        // Zero-length documents cannot contain the term; guard anyway so the
        // normalization never divides by zero.
        const norm = indexed.length === 0 ? 0 : 1 - B + (B * indexed.length) / this.avgdl;
        score += (idf * tf * (K1 + 1)) / (tf + K1 * norm);
      }
      if (score > 0) hits.push({ ...indexed.doc, score });
    }
    hits.sort(byScoreThenKey);
    return limit === undefined ? hits : hits.slice(0, limit);
  }
}

/** Score descending, then (path, slug) ascending: byte-stable output. */
function byScoreThenKey(a: Bm25Hit, b: Bm25Hit): number {
  if (a.score !== b.score) return b.score - a.score;
  return a.path < b.path ? -1 : a.path > b.path ? 1 : a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
}
