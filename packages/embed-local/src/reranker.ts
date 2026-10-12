import { RERANK_UNSCORED, type RerankBatch, type RerankCandidate, type RerankOptions, type RerankProvider } from '@mdlineage/retrieve';
import type { CatalogProfile } from './catalog.js';
import { probeDevice, type ExecutionDevice } from './device.js';
import { cachedPath } from './install.js';
import { configureTransformers } from './transformers.js';

/**
 * Documentation task placed in the Qwen3 reranker's `<Instruct>:` slot.
 * The chat skeleton is the Qwen3-Reranker card (system yes/no judge, assistant
 * prefix ending at the empty think block).
 */
export const DEFAULT_RERANK_TASK = 'Given a documentation search query, retrieve relevant Markdown sections';

const SYSTEM_PROMPT =
  'Judge whether the Document meets the requirements based on the Query and the Instruct provided. Note that the answer can only be "yes" or "no".';

const FORBIDDEN_TOKENS = ['<|im_start|>', '<|im_end|>', '<|endoftext|>'] as const;

/**
 * Whole-prompt cap. The Qwen3-Reranker sample uses 8192. One forward at that
 * length allocated about 10GB and was OOM-killed (exit 137) on a 13GB machine
 * during the first rerank window, so prompts truncate at 2048 tokens.
 */
const MAX_LENGTH = 2048;
/** Assistant suffix + margin: the tokens the yes/no logits are read against. */
export const RERANK_TAIL_KEEP = 24;

/**
 * Trim an over-long token sequence from the MIDDLE: keep the head and the
 * final `tailKeep` tokens. Right-side tokenizer truncation would cut off
 * exactly the assistant suffix the YesNo scoring depends on (corpus max
 * section: 5797 tokens).
 */
export function trimMiddleIds<T>(ids: readonly T[], maxLength: number, tailKeep: number): T[] {
  if (ids.length <= maxLength) return [...ids];
  return [...ids.slice(0, maxLength - tailKeep), ...ids.slice(ids.length - tailKeep)];
}

/**
 * YesNo INT8 graph from n24q02m/Qwen3-Reranker-0.6B-ONNX
 * (`onnx/model_yesno_quantized.onnx`). Its output is `[no, yes]`; the score
 * is softmax P(yes), the same reduction as qwen3-embed's `_compute_yes_no_scores`.
 * Sequences are scored one at a time: the exported graph bakes
 * `position_ids = arange(seq_len)`, so padding would move RoPE with the batch.
 */
export function formatRerankPrompt(
  query: string,
  document: string,
  instruction: string = DEFAULT_RERANK_TASK,
): string {
  return (
    `<|im_start|>system\n${SYSTEM_PROMPT}<|im_end|>\n` +
    `<|im_start|>user\n<Instruct>: ${stripSpecial(instruction)}\n` +
    `<Query>: ${stripSpecial(query)}\n<Document>: ${stripSpecial(document)}<|im_end|>\n` +
    `<|im_start|>assistant\n<think>\n\n</think>\n\n`
  );
}

export function yesProbability(noLogit: number, yesLogit: number): number {
  const diff = noLogit - yesLogit;
  if (diff > 40) return 0;
  if (diff < -40) return 1;
  return 1 / (Math.exp(diff) + 1);
}

/**
 * Reranker device policy (pure, unit-tested): CPU unless the operator
 * explicitly opts in. The YesNo int8 graph ends in a Softmax over the full
 * 151k-entry Qwen3 vocabulary, and onnxruntime-node 1.21's CUDA Softmax
 * kernel aborts the PROCESS with an illegal-memory-access on it (eval log
 * 2026-10-12: softmax_impl.cu:96, node_Softmax_248). A native abort cannot
 * be caught or degraded in-process, so auto-CUDA here would turn "rerank"
 * into a crash. `MDLINEAGE_RERANK_DEVICE=auto` follows the probe result for
 * operators who know their ORT/weights combo is fixed; `cpu`/`cuda`/`dml`
 * pin one provider.
 */
export function resolveRerankDevice(
  override: string | undefined,
  probe: ExecutionDevice,
): { device: ExecutionDevice; note?: string } {
  if (override === 'cpu' || override === 'cuda' || override === 'dml') return { device: override };
  if (override === 'auto') return { device: probe };
  return probe === 'cpu'
    ? { device: 'cpu' }
    : {
        device: 'cpu',
        note: 'reranker pinned to cpu (ORT 1.21 CUDA softmax aborts on this graph; set MDLINEAGE_RERANK_DEVICE=auto to override)',
      };
}

export class LocalReranker implements RerankProvider {
  private session: OrtSession | undefined;
  private tokenizer: Tokenizer | undefined;
  private ort: OrtModule | undefined;
  private probeNotes: readonly string[] = [];
  private notesEmitted = false;
  /** Single-flight init: concurrent first calls share one session build. */
  private initPromise: Promise<void> | undefined;
  /** In-flight `session.run` count; dispose waits for it to drain. */
  private inFlight = 0;
  private drainWaiters: Array<() => void> = [];
  private disposed = false;

  constructor(
    private readonly profile: CatalogProfile,
    private readonly modelDir: string,
  ) {}

  async rerank(
    query: string,
    candidates: readonly RerankCandidate[],
    options: RerankOptions = {},
  ): Promise<RerankBatch> {
    if (candidates.length === 0) return { scores: [], degraded: [] };
    const degraded = await this.ensure();
    const scores: number[] = [];
    let stopped = false;
    for (let index = 0; index < candidates.length; index++) {
      const candidate = candidates[index];
      if (candidate === undefined) continue;
      // Budget guard: stop scoring at the deadline instead of burning a CPU
      // core long after the caller gave up. Unscored entries carry the
      // sentinel so the pipeline keeps their RRF order.
      if (options.deadlineAt !== undefined && Date.now() >= options.deadlineAt) {
        stopped = true;
        scores.push(RERANK_UNSCORED);
        continue;
      }
      if (process.env.MDLINEAGE_EMBED_PROGRESS === '1' && candidates.length > 1 && index % 10 === 0) {
        console.error(`embed-local: rerank ${index + 1}/${candidates.length}`);
      }
      scores.push(await this.scoreOne(query, candidate.text));
    }
    if (stopped) {
      degraded.push(`rerank-deadline: scored ${scores.filter((s) => s !== RERANK_UNSCORED).length}/${candidates.length} before deadline`);
    }
    return { scores, degraded };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    // Wait for in-flight scoring runs before releasing the session: ORT
    // undefined-behaves on a session released under an active run.
    if (this.inFlight > 0) {
      await new Promise<void>((resolve) => {
        this.drainWaiters.push(resolve);
      });
    }
    const current = this.session;
    this.session = undefined;
    this.tokenizer = undefined;
    this.initPromise = undefined;
    if (current !== undefined) await current.release();
  }

  private async ensure(): Promise<string[]> {
    if (this.disposed) throw new Error('reranker session is disposed');
    if (this.session !== undefined && this.tokenizer !== undefined && this.ort !== undefined) {
      return this.takeProbeNotes();
    }
    // Single-flight: cache the init promise so concurrent first calls build
    // one session instead of racing to create (and leak) several.
    this.initPromise ??= this.buildSession().then(
      () => undefined,
      (error: unknown) => {
        // A failed init must not pin a rejected promise: the next call retries.
        this.initPromise = undefined;
        throw error;
      },
    );
    await this.initPromise;
    return this.takeProbeNotes();
  }

  private async buildSession(): Promise<void> {
    // The default pin is CPU. Probing CUDA first loads that EP into the
    // process and keeps it after the session is created on CPU. Only an
    // explicit cuda, dml, or auto override pays for the probe.
    // Never device auto (zvec-grep issue #135).
    const override = process.env.MDLINEAGE_RERANK_DEVICE;
    let device: ExecutionDevice;
    if (override === 'auto') {
      const probe = await probeDevice();
      const resolved = resolveRerankDevice(override, probe.device);
      this.probeNotes = resolved.note === undefined ? [...probe.degraded] : [...probe.degraded, resolved.note];
      device = resolved.device;
    } else if (override === 'cuda' || override === 'dml' || override === 'cpu') {
      const resolved = resolveRerankDevice(override, 'cpu');
      this.probeNotes = resolved.note === undefined ? [] : [resolved.note];
      device = resolved.device;
    } else {
      // Default deployment runs CPU-pinned; the operator-facing note names
      // the blocking bug and the escape hatch instead of failing silently
      // into a bare rerank-timeout later.
      this.probeNotes = [
        'reranker on cpu (CUDA blocked by ORT 1.21 softmax bug, leftover #38; MDLINEAGE_RERANK_DEVICE=auto to override)',
      ];
      device = 'cpu';
    }
    const transformers = await configureTransformers(this.modelDir);
    const loaded = await transformers.fromPretrained(this.profile.repo);
    if (!isTokenizer(loaded)) throw new Error('reranker tokenizer did not load');
    this.tokenizer = loaded;
    const ort = await loadOrt();
    const modelPath = cachedPath(this.modelDir, this.profile.repo, this.profile.onnxFile);
    // One explicit provider, chosen by the policy above. Never device auto
    // (zvec-grep issue #135).
    const created = await ort.create(modelPath, [device satisfies ExecutionDevice]);
    if (!isSession(created)) throw new Error('reranker session did not expose input names');
    this.ort = ort;
    this.session = created;
  }

  private takeProbeNotes(): string[] {
    if (this.notesEmitted) return [];
    this.notesEmitted = true;
    return [...this.probeNotes];
  }

  private async scoreOne(query: string, document: string): Promise<number> {
    const session = this.session;
    const tokenizer = this.tokenizer;
    const ort = this.ort;
    if (session === undefined || tokenizer === undefined || ort === undefined) {
      throw new Error('reranker session is not open');
    }
    const prompt = formatRerankPrompt(query, document);
    // Encode the whole prompt first, then trim the MIDDLE: the assistant
    // suffix (`<|im_end|>...\n</think>\n\n`) is what the yes/no logits are
    // read against, and right-side tokenizer truncation would cut exactly
    // that off on long sections (three corpus sections exceed the budget,
    // the longest at 5797 tokens).
    const encoded = await tokenizer(prompt, {
      add_special_tokens: false,
    });
    const ids = trimMiddleIds(tokenIds(encoded), MAX_LENGTH, RERANK_TAIL_KEEP);
    this.inFlight++;
    try {
    if (ids.length === 0) throw new Error('reranker tokenizer returned no tokens');
    const feeds: Record<string, unknown> = {};
    if (!session.inputNames.includes('input_ids')) {
      throw new Error(`reranker inputs are ${session.inputNames.join(', ')}; expected input_ids`);
    }
    feeds.input_ids = ort.int64(ids);
    if (session.inputNames.includes('attention_mask')) {
      feeds.attention_mask = ort.int64(ids.map(() => 1n));
    }
      const result = await session.run(feeds);
      try {
        const logits = yesNoPair(result, session.outputNames);
        return yesProbability(logits.no, logits.yes);
      } finally {
        // session.run's tensors have no finalizer. A 50-wide window times
        // ten queries would otherwise keep every logit buffer.
        disposeRerankTensors(feeds);
        disposeRerankTensors(result);
      }
    } finally {
      this.inFlight--;
      if (this.inFlight === 0) {
        const waiters = this.drainWaiters;
        this.drainWaiters = [];
        for (const w of waiters) w();
      }
    }
  }
}

interface OrtSession {
  readonly inputNames: readonly string[];
  readonly outputNames: readonly string[];
  run(feeds: Record<string, unknown>): Promise<unknown>;
  release(): Promise<void>;
}

interface OrtModule {
  readonly create: (model: string, providers: readonly string[]) => Promise<unknown>;
  readonly int64: (values: readonly bigint[]) => unknown;
}

interface OrtCreateOptions {
  executionProviders: string[];
  enableCpuMemArena: boolean;
  enableMemPattern: boolean;
  intraOpNumThreads: number;
}

async function loadOrt(): Promise<OrtModule> {
  const imported: unknown = await import('onnxruntime-node');
  if (!isRecord(imported)) throw new Error('onnxruntime-node did not export a module');
  // InferenceSession is a class (typeof "function"), not a plain object.
  const session = imported.InferenceSession;
  const tensor = imported.Tensor;
  if (!isSessionHost(session) || !isInt64Ctor(tensor)) {
    throw new Error('onnxruntime-node is missing InferenceSession.create or Tensor');
  }
  return {
    // The default CPU arena kept the high-water mark of a long YesNo
    // sequence. The first rerank window crossed 10GB on a 13GB machine.
    create: (model, providers) => session.create(model, {
      executionProviders: [...providers],
      enableCpuMemArena: false,
      enableMemPattern: false,
      intraOpNumThreads: 1,
    } satisfies OrtCreateOptions),
    int64: (values) => new tensor('int64', BigInt64Array.from(values), [1, values.length]),
  };
}

interface Tokenizer {
  (
    text: string,
    options: {
      add_special_tokens: boolean;
      /** Optional: transformers.js trims right when asked; we trim ourselves. */
      truncation?: boolean;
      max_length?: number;
    },
  ): Promise<unknown> | unknown;
}

function isTokenizer(value: unknown): value is Tokenizer {
  return typeof value === 'function';
}

function isSessionHost(
  value: unknown,
): value is { create(model: string, options: OrtCreateOptions): Promise<unknown> } {
  if (value === null || (typeof value !== 'function' && typeof value !== 'object')) return false;
  return 'create' in value && typeof value.create === 'function';
}

function isInt64Ctor(
  value: unknown,
): value is new (type: 'int64', data: BigInt64Array, dims: readonly number[]) => unknown {
  return typeof value === 'function';
}

function tokenIds(encoded: unknown): bigint[] {
  const data = unwrapData(encoded);
  if (data instanceof BigInt64Array || data instanceof BigUint64Array) {
    return Array.from(data, (item) => BigInt(item));
  }
  if (data instanceof Int32Array || data instanceof Uint32Array || data instanceof Float32Array) {
    return Array.from(data, (item) => BigInt(Math.trunc(item)));
  }
  if (!Array.isArray(data)) throw new Error('reranker tokenizer output has no token ids');
  return data.map((item, index) => {
    if (typeof item === 'bigint') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return BigInt(Math.trunc(item));
    throw new Error(`reranker token ${index} is not an integer`);
  });
}

function unwrapData(value: unknown): unknown {
  if (!isRecord(value)) return value;
  if ('input_ids' in value) return unwrapData(value.input_ids);
  if ('data' in value) return value.data;
  return value;
}

function yesNoPair(result: unknown, outputNames: readonly string[]): { no: number; yes: number } {
  if (!isRecord(result)) throw new Error('reranker output is not a map');
  const name = outputNames[0];
  if (name === undefined) throw new Error('reranker session has no outputs');
  const tensor = result[name];
  if (!isRecord(tensor) || !Array.isArray(tensor.dims) || !ArrayBuffer.isView(tensor.data)) {
    throw new Error(`reranker output '${name}' is not a numeric tensor`);
  }
  const last = tensor.dims[tensor.dims.length - 1];
  if (last !== 2) {
    throw new Error(`reranker output '${name}' last dimension is ${String(last)}, expected 2 ([no, yes])`);
  }
  const data = tensor.data;
  if (!(data instanceof Float32Array) && !(data instanceof Float64Array)) {
    throw new Error(`reranker output '${name}' is not float32 or float64`);
  }
  const no = data[data.length - 2];
  const yes = data[data.length - 1];
  if (no === undefined || yes === undefined || !Number.isFinite(no) || !Number.isFinite(yes)) {
    throw new Error(`reranker output '${name}' logits are not finite`);
  }
  return { no, yes };
}

function isSession(value: unknown): value is OrtSession {
  if (!isRecord(value) || typeof value.run !== 'function' || typeof value.release !== 'function') return false;
  return stringArray(value.inputNames) && stringArray(value.outputNames);
}

function stringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function disposeRerankTensors(value: unknown, seen: WeakSet<object> = new WeakSet()): void {
  if (typeof value !== 'object' || value === null || seen.has(value)) return;
  seen.add(value);
  if ('dispose' in value && typeof value.dispose === 'function' && 'dims' in value) {
    value.dispose.call(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) disposeRerankTensors(item, seen);
    return;
  }
  for (const child of Object.values(value)) disposeRerankTensors(child, seen);
}

function stripSpecial(text: string): string {
  let current = text;
  for (let guard = 0; guard < 8; guard++) {
    const next = FORBIDDEN_TOKENS.reduce((value, token) => value.split(token).join(''), current);
    if (next === current) return current;
    current = next;
  }
  return current;
}
