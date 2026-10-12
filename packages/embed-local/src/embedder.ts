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

const EMBED_BATCH_ITEMS = 1;
const EMBED_BATCH_CHARS = 12_000;
/**
 * Attention is quadratic in the token count. One 8k-token section on CPU
 * asked for about 8GB and the process was killed (exit 137). 2048 keeps a
 * single forward inside a 13GB machine. Shorter sections are unchanged.
 */
const EMBED_MAX_TOKENS = 2048;

/**
 * Embed-session device. An explicit `cpu` / `cuda` / `dml` override wins.
 * Anything else, including an unset value, keeps the probed provider.
 * The probed provider is already a concrete name. Never pass device auto.
 */
export function resolveEmbedDevice(override: string | undefined, probe: ExecutionDevice): ExecutionDevice {
  if (override === 'cpu' || override === 'cuda' || override === 'dml') return override;
  return probe;
}

/**
 * One text per forward. A padded batch changes position ids, so a section's
 * vector would depend on its neighbors, and one call over this repository's
 * sections was OOM-killed (exit 137, about 12GB) on a 13GB machine.
 * A text longer than the character budget is still its own chunk.
 */
export function chunkEmbedInputs(inputs: readonly string[]): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let chars = 0;
  const flush = (): void => {
    if (current.length === 0) return;
    chunks.push(current);
    current = [];
    chars = 0;
  };
  for (const text of inputs) {
    const alone = text.length > EMBED_BATCH_CHARS;
    const full = current.length >= EMBED_BATCH_ITEMS;
    const overBudget = current.length > 0 && chars + text.length > EMBED_BATCH_CHARS;
    if (alone || full || overBudget) flush();
    current.push(text);
    chars += text.length;
    if (alone) flush();
  }
  flush();
  return chunks;
}

export class LocalEmbedder implements EmbeddingProvider {
  readonly meta: EmbeddingMeta;
  private extractor: FeatureExtractor | undefined;
  private probeNotes: readonly string[] = [];
  private notesEmitted = false;
  /** Single-flight init: concurrent first calls share one pipeline build. */
  private initPromise: Promise<FeatureExtractor> | undefined;
  /**
   * Set when session creation failed: transformers.js caches the first
   * failed session promise at module level (onnx.js wasmInitPromise), so a
   * later CPU retry in the same process replays the same error. Marking the
   * provider permanently failed turns every later call into one clear,
   * cheap degraded note instead of repeated failures (glm-5.3 review M2).
   */
  private broken: string | undefined;

  constructor(
    private readonly profile: CatalogProfile,
    private readonly modelDir: string,
    private readonly task: string = DEFAULT_EMBED_TASK,
  ) {
    // `algo` is the vector-cache generation: bump it whenever embedding
    // behavior changes (truncation, pooling, batching) so old and new
    // vectors never share a cache directory.
    this.meta = {
      model: profile.repo,
      dtype: profile.dtype,
      dim: profile.dim,
      algo: 'v2-2048-lasttoken-peritem',
    };
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
    if (this.broken !== undefined) {
      throw new Error(`embedder permanently failed earlier in this process: ${this.broken}`);
    }
    let extractor: FeatureExtractor;
    try {
      extractor = await this.session();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.broken = reason;
      throw new Error(
        `embedder session failed permanently for this process (${reason}); ` +
          'hybrid is disabled until restart — see MDLINEAGE_EMBED_DEVICE',
      );
    }
    const degraded = this.takeProbeNotes();
    const vectors: number[][] = [];
    const chunks = chunkEmbedInputs(inputs);
    for (let index = 0; index < chunks.length; index++) {
      const chunk = chunks[index];
      if (chunk === undefined) continue;
      if (process.env.MDLINEAGE_EMBED_PROGRESS === '1' && chunks.length > 1) {
        console.error(`embed-local: chunk ${index + 1}/${chunks.length} (${chunk.length} texts)`);
      }
      vectors.push(...(await embedChunk(extractor, chunk)));
    }
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
    // Single-flight: concurrent first embeds share one pipeline build
    // instead of racing to create (and leak) several.
    this.initPromise ??= this.buildPipeline().catch((error: unknown) => {
      this.initPromise = undefined;
      throw error;
    });
    return this.initPromise;
  }

  private async buildPipeline(): Promise<FeatureExtractor> {
    // An explicit provider skips the probe. Probing CUDA loads that EP into
    // the process even when the session then runs on CPU, and the extra host
    // allocation OOM'd a full-corpus embed on this 13GB machine.
    // Never device auto (zvec-grep issue #135).
    const override = process.env.MDLINEAGE_EMBED_DEVICE;
    const forced = resolveEmbedDevice(override, 'cpu');
    const pinned = override === 'cpu' || override === 'cuda' || override === 'dml';
    let device: ExecutionDevice;
    if (pinned) {
      this.probeNotes = [];
      device = forced;
    } else {
      const probe = await probeDevice();
      this.probeNotes = probe.degraded;
      device = probe.device;
    }
    const transformers = await configureTransformers(this.modelDir);
    const extractor = await transformers.pipeline('feature-extraction', this.profile.repo, {
      dtype: requireQ8(this.profile.dtype),
      device: device satisfies ExecutionDevice,
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

/**
 * One forward, then drop every ONNX tensor it allocated.
 * `extractor()` only returns the pooled row. The hidden state stays
 * allocated for the process lifetime (Tensor has no finalizer), and a
 * 54-chunk pass climbed past 8GB. Pooling here copies the last real
 * token — the last attention-mask 1, which is also index -1 when the
 * Qwen3 tokenizer left-pads — and disposes the inputs and outputs.
 */
async function embedChunk(extractor: FeatureExtractor, texts: readonly string[]): Promise<number[][]> {
  // Standard pipeline call: last-token pooling + normalize. The tokenizer
  // left-pads, so last_token is the last real token for single-item chunks
  // (chunkEmbedInputs feeds one text per chunk); truncation keeps Qwen3
  // inputs inside the model budget. A manual tokenize-and-dispose path used
  // to live here but never executed (transformers.js pipelines expose
  // `model` as a string id, not a callable) and was removed.
  const output = await extractor(texts, { pooling: 'last_token', normalize: true, max_length: EMBED_MAX_TOKENS });
  return readMatrix(output, texts.length);
}

/** Last real token per row, then L2-normalize. `masks` is null when the tokenizer sent none. */
export function poolLastTokenNormalized(
  data: Float32Array | Float64Array,
  dims: readonly number[],
  expectedRows: number,
  masks: readonly (ArrayLike<number> | undefined)[] | null,
): number[][] {
  if (dims.length !== 3) throw new Error(`embedding hidden state rank ${dims.length}, expected 3`);
  const batch = dims[0];
  const seq = dims[1];
  const dim = dims[2];
  if (batch === undefined || seq === undefined || dim === undefined) {
    throw new Error('embedding hidden state shape is incomplete');
  }
  if (batch !== expectedRows) throw new Error(`embedding output has ${batch} rows, expected ${expectedRows}`);
  if (seq < 1 || dim < 1) throw new Error('embedding hidden state is empty');
  const rows: number[][] = [];
  for (let row = 0; row < batch; row++) {
    const mask = masks?.[row];
    const position = lastRealIndex(mask, seq);
    const start = (row * seq + position) * dim;
    const vector: number[] = [];
    let sum = 0;
    for (let i = 0; i < dim; i++) {
      const value = data[start + i] ?? 0;
      vector.push(value);
      sum += value * value;
    }
    const norm = Math.sqrt(sum);
    if (norm !== 0) {
      for (let i = 0; i < vector.length; i++) vector[i] = (vector[i] ?? 0) / norm;
    }
    rows.push(vector);
  }
  return rows;
}

function lastRealIndex(mask: ArrayLike<number> | undefined, seq: number): number {
  if (mask === undefined || mask.length < seq) return seq - 1;
  for (let i = seq - 1; i >= 0; i--) {
    if (mask[i] !== 0) return i;
  }
  return seq - 1;
}

