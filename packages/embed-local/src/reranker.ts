import type { RerankBatch, RerankCandidate, RerankProvider } from '@mdlineage/retrieve';
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

/** Whole-prompt cap from the Qwen3-Reranker sample. Sections in this corpus are far smaller. */
const MAX_LENGTH = 8192;

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

export class LocalReranker implements RerankProvider {
  private session: OrtSession | undefined;
  private tokenizer: Tokenizer | undefined;
  private ort: OrtModule | undefined;
  private probeNotes: readonly string[] = [];
  private notesEmitted = false;

  constructor(
    private readonly profile: CatalogProfile,
    private readonly modelDir: string,
  ) {}

  async rerank(query: string, candidates: readonly RerankCandidate[]): Promise<RerankBatch> {
    if (candidates.length === 0) return { scores: [], degraded: [] };
    const degraded = await this.ensure();
    const scores: number[] = [];
    for (const candidate of candidates) {
      scores.push(await this.scoreOne(query, candidate.text));
    }
    return { scores, degraded };
  }

  async dispose(): Promise<void> {
    const current = this.session;
    this.session = undefined;
    this.tokenizer = undefined;
    if (current !== undefined) await current.release();
  }

  private async ensure(): Promise<string[]> {
    if (this.session !== undefined && this.tokenizer !== undefined && this.ort !== undefined) {
      return this.takeProbeNotes();
    }
    const probe = await probeDevice();
    this.probeNotes = probe.degraded;
    const transformers = await configureTransformers(this.modelDir);
    const loaded = await transformers.fromPretrained(this.profile.repo);
    if (!isTokenizer(loaded)) throw new Error('reranker tokenizer did not load');
    this.tokenizer = loaded;
    const ort = await loadOrt();
    const modelPath = cachedPath(this.modelDir, this.profile.repo, this.profile.onnxFile);
    // Same explicit provider as the embedder. Never device auto (zvec-grep issue #135).
    const created = await ort.create(modelPath, [probe.device satisfies ExecutionDevice]);
    if (!isSession(created)) throw new Error('reranker session did not expose input names');
    this.ort = ort;
    this.session = created;
    return this.takeProbeNotes();
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
    const encoded = await tokenizer(prompt, {
      add_special_tokens: false,
      truncation: true,
      max_length: MAX_LENGTH,
    });
    const ids = tokenIds(encoded);
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
    const logits = yesNoPair(result, session.outputNames);
    return yesProbability(logits.no, logits.yes);
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
    create: (model, providers) => session.create(model, { executionProviders: [...providers] }),
    int64: (values) => new tensor('int64', BigInt64Array.from(values), [1, values.length]),
  };
}

interface Tokenizer {
  (
    text: string,
    options: { add_special_tokens: boolean; truncation: boolean; max_length: number },
  ): Promise<unknown> | unknown;
}

function isTokenizer(value: unknown): value is Tokenizer {
  return typeof value === 'function';
}

function isSessionHost(
  value: unknown,
): value is { create(model: string, options: { executionProviders: string[] }): Promise<unknown> } {
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

function stripSpecial(text: string): string {
  let current = text;
  for (let guard = 0; guard < 8; guard++) {
    const next = FORBIDDEN_TOKENS.reduce((value, token) => value.split(token).join(''), current);
    if (next === current) return current;
    current = next;
  }
  return current;
}
