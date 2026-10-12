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

interface EmbedPipeline {
  tokenizer: (
    texts: readonly string[],
    options: { padding: boolean; truncation: boolean; max_length: number },
  ) => Promise<unknown> | unknown;
  model: (inputs: unknown) => Promise<unknown>;
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
  if (!isEmbedPipeline(extractor)) {
    const output = await extractor(texts, { pooling: 'last_token', normalize: true });
    try {
      return readMatrix(output, texts.length);
    } finally {
      disposeTensors(output, new WeakSet());
    }
  }
  const encoded = await extractor.tokenizer([...texts], {
    padding: true,
    truncation: true,
    max_length: EMBED_MAX_TOKENS,
  });
  const masks = maskRows(encoded);
  let outputs: unknown;
  try {
    outputs = await extractor.model(encoded);
    const hidden = hiddenState(outputs);
    if (hidden === null) throw new Error('embedding model did not return a float last_hidden_state');
    return poolLastTokenNormalized(hidden.data, hidden.dims, texts.length, masks);
  } finally {
    const seen = new WeakSet<object>();
    disposeTensors(encoded, seen);
    disposeTensors(outputs, seen);
  }
}

function isEmbedPipeline(value: FeatureExtractor): value is FeatureExtractor & EmbedPipeline {
  if (!('model' in value) || !('tokenizer' in value)) return false;
  return typeof value.model === 'function' && typeof value.tokenizer === 'function';
}

interface FloatHidden {
  readonly dims: readonly number[];
  readonly data: Float32Array | Float64Array;
}

function hiddenState(outputs: unknown): FloatHidden | null {
  if (!isRecord(outputs)) return null;
  const hidden = outputs.last_hidden_state ?? outputs.logits ?? outputs.token_embeddings;
  if (!isRecord(hidden) || !Array.isArray(hidden.dims)) return null;
  if (!(hidden.data instanceof Float32Array) && !(hidden.data instanceof Float64Array)) return null;
  if (!hidden.dims.every((dim) => typeof dim === 'number')) return null;
  return { dims: hidden.dims, data: hidden.data };
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

function maskRows(encoded: unknown): (ArrayLike<number> | undefined)[] | null {
  if (!isRecord(encoded)) return null;
  const mask = encoded.attention_mask;
  if (!isRecord(mask) || !Array.isArray(mask.dims) || !ArrayBuffer.isView(mask.data)) return null;
  const batch = mask.dims[0];
  const seq = mask.dims[1];
  if (typeof batch !== 'number' || typeof seq !== 'number' || mask.dims.length !== 2) return null;
  const rows: ArrayLike<number>[] = [];
  for (let row = 0; row < batch; row++) {
    const values: number[] = [];
    for (let col = 0; col < seq; col++) values.push(viewNumber(mask.data, row * seq + col));
    rows.push(values);
  }
  return rows;
}

function viewNumber(data: ArrayBufferView, index: number): number {
  if (data instanceof BigInt64Array || data instanceof BigUint64Array) {
    const value = data[index];
    return value === undefined ? 0 : Number(value);
  }
  if (
    data instanceof Float32Array ||
    data instanceof Float64Array ||
    data instanceof Int32Array ||
    data instanceof Uint32Array ||
    data instanceof Int16Array ||
    data instanceof Uint16Array ||
    data instanceof Int8Array ||
    data instanceof Uint8Array
  ) {
    return data[index] ?? 0;
  }
  return 0;
}

function disposeTensors(value: unknown, seen: WeakSet<object>): void {
  if (typeof value !== 'object' || value === null || seen.has(value)) return;
  seen.add(value);
  if ('dispose' in value && typeof value.dispose === 'function' && 'dims' in value) {
    value.dispose.call(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) disposeTensors(item, seen);
    return;
  }
  for (const child of Object.values(value)) disposeTensors(child, seen);
}
