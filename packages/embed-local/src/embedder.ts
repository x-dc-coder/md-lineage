import type { EmbedBatch, EmbeddingMeta, EmbeddingProvider } from '@mdlineage/retrieve';
import type { CatalogProfile } from './catalog.js';
import { probeDevice, type ExecutionDevice } from './device.js';
import { configureTransformers, type FeatureExtractor } from './transformers.js';

/** Task string the local embedder puts on the query side only. */
export const DEFAULT_EMBED_TASK = 'Given a documentation search query, retrieve relevant Markdown sections';

/**
 * Query prefix from the onnx-community/Qwen3-Embedding-0.6B-ONNX card:
 * `Query:${query}` has no space. Issue #3 writes `Query: {query}`; the card
 * omits the space, and that is the string the exported weights were trained on.
 * Document text is embedded with no prefix.
 */
export function formatEmbedQuery(query: string, task: string = DEFAULT_EMBED_TASK): string {
  return `Instruct: ${task}\nQuery:${query}`;
}

export class LocalEmbedder implements EmbeddingProvider {
  readonly meta: EmbeddingMeta;
  private extractor: FeatureExtractor | undefined;
  private probeNotes: readonly string[] = [];
  private notesEmitted = false;

  constructor(
    private readonly profile: CatalogProfile,
    private readonly modelDir: string,
    private readonly task: string = DEFAULT_EMBED_TASK,
  ) {
    this.meta = { model: profile.repo, dtype: profile.dtype, dim: profile.dim };
  }

  async embed(inputs: readonly string[]): Promise<EmbedBatch> {
    return this.run(inputs);
  }

  async embedQuery(query: string): Promise<EmbedBatch> {
    return this.run([formatEmbedQuery(query, this.task)]);
  }

  async dispose(): Promise<void> {
    const current = this.extractor;
    this.extractor = undefined;
    if (current?.dispose !== undefined) await current.dispose();
  }

  private async run(inputs: readonly string[]): Promise<EmbedBatch> {
    if (inputs.length === 0) return { vectors: [], degraded: [] };
    const extractor = await this.session();
    const degraded = this.takeProbeNotes();
    const output = await extractor(inputs, { pooling: 'last_token', normalize: true });
    const vectors = readMatrix(output, inputs.length);
    for (const vector of vectors) {
      if (vector.length !== this.profile.dim) {
        throw new Error(`embedding dim ${vector.length} does not match profile dim ${this.profile.dim}`);
      }
    }
    return { vectors, degraded };
  }

  private takeProbeNotes(): string[] {
    if (this.notesEmitted) return [];
    this.notesEmitted = true;
    return [...this.probeNotes];
  }

  private async session(): Promise<FeatureExtractor> {
    if (this.extractor !== undefined) return this.extractor;
    const probe = await probeDevice();
    this.probeNotes = probe.degraded;
    const transformers = await configureTransformers(this.modelDir);
    // Explicit provider from probeDevice. Never device auto (zvec-grep issue #135).
    const extractor = await transformers.pipeline('feature-extraction', this.profile.repo, {
      dtype: requireQ8(this.profile.dtype),
      device: probe.device satisfies ExecutionDevice,
      local_files_only: true,
    });
    this.extractor = extractor;
    return extractor;
  }
}

function requireQ8(dtype: string): 'q8' {
  if (dtype !== 'q8') throw new Error(`local embedder only loads the transformers.js q8 weight, got '${dtype}'`);
  return 'q8';
}

function readMatrix(output: unknown, expectedRows: number): number[][] {
  const listed = isRecord(output) && typeof output.tolist === 'function' ? output.tolist() : output;
  if (!Array.isArray(listed) || listed.length === 0) {
    throw new Error('embedding output was empty');
  }
  if (isNumberRow(listed)) {
    if (expectedRows !== 1) throw new Error(`embedding output has 1 row, expected ${expectedRows}`);
    return [listed];
  }
  if (!listed.every(isNumberRow)) throw new Error('embedding output is not a numeric matrix');
  if (listed.length !== expectedRows) {
    throw new Error(`embedding output has ${listed.length} rows, expected ${expectedRows}`);
  }
  return listed;
}

function isNumberRow(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'number' && Number.isFinite(item));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
