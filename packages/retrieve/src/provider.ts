/**
 * Embedding and rerank provider contracts (Issue #3 Phase 2).
 *
 * `@mdlineage/retrieve` stays free of native runtimes. Local ONNX sessions
 * live in `@mdlineage/embed-local` and implement these interfaces; the API
 * adapter below is the remote `/v1/embeddings` implementation.
 *
 * `embed` is the document side (no task prefix). Query-side prefixing is
 * optional via `embedQuery`: local models apply the Qwen instruct prefix
 * there, and the API adapter leaves queries unprefixed.
 */

import { embedTexts, type EmbeddingsOptions } from './embeddings-api.js';

export interface EmbeddingMeta {
  readonly model: string;
  readonly dtype: string;
  readonly dim: number;
  /**
   * Algorithm generation of the vectors this provider produces (truncation
   * budget, pooling, key implementation choices). Part of the vector-cache
   * fingerprint: two providers that would emit different vectors for the
   * same text must not share one cache directory.
   */
  readonly algo: string;
}

export interface EmbedBatch {
  readonly vectors: readonly (readonly number[])[];
  readonly degraded: readonly string[];
}

export interface EmbeddingProvider {
  readonly meta: EmbeddingMeta;
  embed(inputs: readonly string[]): Promise<EmbedBatch>;
  /** Query-side embedding. Absent means the pipeline calls `embed`. */
  embedQuery?(query: string): Promise<EmbedBatch>;
  dispose(): Promise<void>;
}

export interface RerankCandidate {
  readonly key: string;
  readonly text: string;
}

export interface RerankBatch {
  readonly scores: readonly number[];
  readonly degraded: readonly string[];
}

/**
 * Rerank call options. `deadlineAt` is an epoch-ms cutoff: implementations
 * that score candidates one at a time stop at the deadline and return
 * partial scores, marking unscored entries with the `RERANK_UNSCORED`
 * sentinel instead of burning CPU past the budget.
 */
export interface RerankOptions {
  readonly deadlineAt?: number;
}

/** Sentinel for "not scored before the deadline": keep RRF order. */
export const RERANK_UNSCORED = -1;

export interface RerankProvider {
  rerank(
    query: string,
    candidates: readonly RerankCandidate[],
    options?: RerankOptions,
  ): Promise<RerankBatch>;
  dispose(): Promise<void>;
}

/**
 * Remote embeddings as an `EmbeddingProvider`. Dimension is whatever the
 * endpoint returns; pass `dim` when the caller already knows it (the vector
 * cache refuses to open at dim 0).
 */
export class ApiEmbeddingProvider implements EmbeddingProvider {
  readonly meta: EmbeddingMeta;
  private readonly options: EmbeddingsOptions;

  constructor(options: EmbeddingsOptions & { readonly dim?: number } = {}) {
    this.options = options;
    const model = options.model ?? process.env.MDLINEAGE_EMBED_MODEL ?? '';
    this.meta = { model, dtype: 'f32', dim: options.dim ?? 0, algo: 'api-v1' };
  }

  async embed(inputs: readonly string[]): Promise<EmbedBatch> {
    const result = await embedTexts(inputs, this.options);
    const degraded = [...result.degraded];
    if (result.partial) {
      degraded.push(
        `embeddings-partial: returned ${result.embeddings.length} of ${inputs.length} vectors`,
      );
    }
    return { vectors: result.embeddings, degraded };
  }

  async dispose(): Promise<void> {
    // The API adapter holds no session.
  }
}
