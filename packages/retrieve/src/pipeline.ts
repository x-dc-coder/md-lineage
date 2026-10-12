/**
 * Hybrid retrieval pipeline (Issue #3 §4).
 *
 *   lexical: BM25, top-N, (path, slug) tie-break.
 *   hybrid:  BM25 top-100 + dense top-100 → RRF(k=60) → rerank top-50
 *            (5s timeout drops back to the RRF order) → top-N.
 *
 * Document vectors are content-addressed in the caller's `VectorStore`
 * (`sectionKey` hit reuses the blob; misses are embedded in one batch and
 * written back). The query vector is computed on every call and is never
 * stored. A dense or rerank failure degrades to the previous stage and is
 * recorded in `degraded`; it does not throw.
 */

import { Bm25Index, type Bm25Doc } from './bm25.js';
import type { EmbeddingProvider, RerankProvider } from './provider.js';
import { fuse } from './rrf.js';
import { sectionCorpus, sectionKey, type VectorStore } from './vector-store.js';

export interface CorpusSection {
  readonly path: string;
  readonly slug: string;
  readonly title: string;
  readonly text: string;
}

export interface SearchHit {
  readonly path: string;
  readonly slug: string;
  readonly title: string;
  readonly text: string;
  readonly score: number;
}

export interface SearchRequest {
  readonly query: string;
  readonly sections: readonly CorpusSection[];
  readonly top: number;
  /** `lexical` skips the dense branch even when an embedder is supplied. */
  readonly mode: 'lexical' | 'hybrid';
  readonly embedder?: EmbeddingProvider;
  readonly reranker?: RerankProvider | null;
  readonly store?: VectorStore;
  /** How many fused hits the reranker sees. Default 50. */
  readonly rerankDepth?: number;
  /** Rerank budget. Default 5000 ms; exceeding it keeps the RRF order. */
  readonly rerankTimeoutMs?: number;
  readonly lexicalWidth?: number;
  readonly denseWidth?: number;
}

export interface SearchOutcome {
  readonly mode: 'lexical' | 'hybrid';
  readonly hits: readonly SearchHit[];
  readonly degraded: readonly string[];
}

const DEFAULT_WIDTH = 100;
const DEFAULT_RERANK_DEPTH = 50;
const DEFAULT_RERANK_TIMEOUT_MS = 5_000;
const RRF_K = 60;

class RerankTimeout extends Error {
  constructor(ms: number) {
    super(`rerank timed out after ${ms}ms`);
    this.name = 'RerankTimeout';
  }
}

/** Rank `sections` for `query`. See the module comment for the two modes. */
export async function searchCorpus(request: SearchRequest): Promise<SearchOutcome> {
  const degraded: string[] = [];
  const top = request.top <= 0 ? 0 : request.top;
  const lexicalHits = lexicalRank(request.sections, request.query, request.mode === 'lexical' ? top : width(request.lexicalWidth));

  if (request.mode === 'lexical' || request.embedder === undefined) {
    if (request.mode === 'hybrid' && request.embedder === undefined) {
      degraded.push('hybrid-unavailable: no embedding provider; falling back to lexical');
    }
    return { mode: 'lexical', hits: lexicalHits.slice(0, top), degraded };
  }

  const embedder = request.embedder;
  let dense: Ranked[];
  try {
    dense = await denseRank(request, embedder, degraded);
  } catch (error) {
    degraded.push(`dense-failed: ${errorText(error)}; falling back to lexical`);
    return { mode: 'lexical', hits: lexicalRank(request.sections, request.query, top), degraded };
  }

  const fused = fuse(
    [lexicalHits.map(sectionId), dense.map((hit) => hit.id)],
    RRF_K,
  );
  const byId = indexSections(request.sections);
  let ranked: Ranked[] = [];
  for (const item of fused) {
    const section = byId.get(item.key);
    if (section === undefined) continue;
    ranked.push({ id: item.key, section, score: item.score });
  }

  const reranker = request.reranker ?? null;
  if (reranker !== null && ranked.length > 0) {
    ranked = await rerankWindow(reranker, request, ranked, degraded);
  }

  return {
    mode: 'hybrid',
    hits: ranked.slice(0, top).map((hit) => ({ ...hit.section, score: hit.score })),
    degraded,
  };
}

interface Ranked {
  readonly id: string;
  readonly section: CorpusSection;
  readonly score: number;
}

function width(value: number | undefined): number {
  return value === undefined ? DEFAULT_WIDTH : value;
}

function sectionId(section: CorpusSection): string {
  return `${section.path}\0${section.slug}`;
}

function indexSections(sections: readonly CorpusSection[]): Map<string, CorpusSection> {
  const byId = new Map<string, CorpusSection>();
  for (const section of sections) byId.set(sectionId(section), section);
  return byId;
}

function lexicalRank(sections: readonly CorpusSection[], query: string, limit: number): SearchHit[] {
  const docs: Bm25Doc[] = sections.map((section) => ({
    path: section.path,
    slug: section.slug,
    title: section.title,
    text: section.text,
  }));
  // Length norm is the Bm25Index default (unique-terms; leftover #33).
  return new Bm25Index(docs).search(query, limit).map((hit) => ({
    path: hit.path,
    slug: hit.slug,
    title: hit.title,
    text: hit.text,
    score: hit.score,
  }));
}

async function denseRank(
  request: SearchRequest,
  embedder: EmbeddingProvider,
  degraded: string[],
): Promise<Ranked[]> {
  const queryBatch = embedder.embedQuery
    ? await embedder.embedQuery(request.query)
    : await embedder.embed([request.query]);
  degraded.push(...queryBatch.degraded);
  const queryVector = queryBatch.vectors[0];
  if (queryVector === undefined || queryVector.length === 0) {
    throw new Error('query embedding was empty');
  }
  const dim = embedder.meta.dim > 0 ? embedder.meta.dim : queryVector.length;
  if (queryVector.length !== dim) {
    throw new Error(`query embedding dim ${queryVector.length} does not match profile dim ${dim}`);
  }
  const queryUnit = asUnit(queryVector);

  const vectors = new Map<string, Float32Array>();
  const missing: { hash: string; text: string }[] = [];
  const seen = new Set<string>();
  for (const section of request.sections) {
    const text = sectionCorpus(section.title, section.text);
    const hash = sectionKey(section.title, section.text);
    const cached = request.store?.get(hash) ?? null;
    if (cached !== null && cached.length === dim) {
      vectors.set(hash, cached);
      continue;
    }
    if (seen.has(hash)) continue;
    seen.add(hash);
    missing.push({ hash, text });
  }

  if (missing.length > 0) {
    const batch = await embedder.embed(missing.map((item) => item.text));
    degraded.push(...batch.degraded);
    const usable = Math.min(batch.vectors.length, missing.length);
    if (usable < missing.length) {
      degraded.push(
        `embeddings-partial: cached ${usable} of ${missing.length} missing sections`,
      );
    }
    for (let i = 0; i < usable; i++) {
      const item = missing[i];
      const vector = batch.vectors[i];
      if (item === undefined || vector === undefined) break;
      if (vector.length !== dim) {
        degraded.push(`vector-dim-mismatch: expected ${dim}, got ${vector.length}`);
        continue;
      }
      if (request.store !== undefined) {
        request.store.put(item.hash, vector);
        const stored = request.store.get(item.hash);
        if (stored !== null) vectors.set(item.hash, stored);
      } else {
        vectors.set(item.hash, asUnit(vector));
      }
    }
  }

  rememberManifest(request);

  const hits: Ranked[] = [];
  for (const section of request.sections) {
    const vector = vectors.get(sectionKey(section.title, section.text));
    if (vector === undefined) continue;
    const score = dot(queryUnit, vector);
    if (score <= 0) continue;
    hits.push({ id: sectionId(section), section, score });
  }
  hits.sort(byScoreThenSection);
  return hits.slice(0, width(request.denseWidth));
}

/** Record which hashes each path contributed, including cache hits. */
function rememberManifest(request: SearchRequest): void {
  const store = request.store;
  if (store === undefined) return;
  const byPath = new Map<string, string[]>();
  for (const section of request.sections) {
    const hashes = byPath.get(section.path) ?? [];
    hashes.push(sectionKey(section.title, section.text));
    byPath.set(section.path, hashes);
  }
  for (const [path, hashes] of byPath) store.setSections(path, hashes);
}

async function rerankWindow(
  reranker: RerankProvider,
  request: SearchRequest,
  ranked: readonly Ranked[],
  degraded: string[],
): Promise<Ranked[]> {
  const depth = request.rerankDepth ?? DEFAULT_RERANK_DEPTH;
  const timeoutMs = request.rerankTimeoutMs ?? DEFAULT_RERANK_TIMEOUT_MS;
  const window = ranked.slice(0, depth);
  const tail = ranked.slice(depth);
  const pending = reranker.rerank(
    request.query,
    window.map((hit) => ({ key: hit.id, text: sectionCorpus(hit.section.title, hit.section.text) })),
  );
  // The timeout abandons the call; a late rejection must not surface later.
  pending.catch(() => undefined);
  try {
    const batch = await withTimeout(pending, timeoutMs);
    degraded.push(...batch.degraded);
    if (batch.scores.length !== window.length) {
      degraded.push(`rerank-skipped: expected ${window.length} scores, got ${batch.scores.length}`);
      return [...ranked];
    }
    const reordered = window.map((hit, index) => {
      const score = batch.scores[index];
      return { hit, score: score ?? Number.NEGATIVE_INFINITY, index };
    });
    reordered.sort((a, b) => (a.score !== b.score ? b.score - a.score : a.index - b.index));
    return [...reordered.map((item) => ({ ...item.hit, score: item.score })), ...tail];
  } catch (error) {
    if (error instanceof RerankTimeout) {
      degraded.push(`rerank-timeout: skipped after ${timeoutMs}ms`);
    } else {
      degraded.push(`rerank-failed: ${errorText(error)}; kept RRF order`);
    }
    return [...ranked];
  }
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new RerankTimeout(ms)), ms);
  });
  timeout.catch(() => undefined);
  return Promise.race([work, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

function byScoreThenSection(a: Ranked, b: Ranked): number {
  if (a.score !== b.score) return b.score - a.score;
  const path = a.section.path < b.section.path ? -1 : a.section.path > b.section.path ? 1 : 0;
  if (path !== 0) return path;
  return a.section.slug < b.section.slug ? -1 : a.section.slug > b.section.slug ? 1 : 0;
}

function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += (a[i] ?? 0) * (b[i] ?? 0);
  return sum;
}

function asUnit(vector: readonly number[]): Float32Array {
  const out = Float32Array.from(vector);
  let sum = 0;
  for (const value of out) sum += value * value;
  const norm = Math.sqrt(sum);
  if (norm === 0) return out;
  for (let i = 0; i < out.length; i++) out[i] = (out[i] ?? 0) / norm;
  return out;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
