/**
 * OpenAI-compatible `/v1/embeddings` adapter (Issue #3 Phase 1).
 *
 * The dense branch's remote option: any provider speaking the standard
 * embeddings endpoint (a local gateway, Ollama, vLLM, or a cloud API).
 * Contract rules baked in here:
 *
 *   - the API key comes from options or `MDLINEAGE_EMBED_API_KEY` and is
 *     never written to disk, never echoed in a message (errors carry status
 *     codes and URLs only, and proxy URLs are host-redacted);
 *   - per-attempt AbortController timeout (default 10 s);
 *   - 429/5xx: exactly one backoff retry (`Retry-After` when offered);
 *   - batches of at most 64 inputs, sequential (a rate-limited provider
 *     must not be hit with parallel bursts);
 *   - proxy awareness: HTTPS_PROXY / HTTP_PROXY / ALL_PROXY /
 *     MDLINEAGE_EMBED_PROXY select an undici ProxyAgent passed on that
 *     request only (`fetch(url, { dispatcher })`, never
 *     `setGlobalDispatcher` — a process-wide dispatcher poisons a
 *     long-lived MCP server). `undici` is a peer-provided optional module
 *     (never a dependency); when it is unavailable the request goes direct
 *     with a `degraded` note;
 *   - the batch loop has one deadline (default 120s). A later batch that
 *     fails returns the vectors already received (`partial: true`) instead
 *     of discarding them.
 */

export interface EmbeddingsOptions {
  /** API base, e.g. `https://api.example.com` (no trailing /v1). */
  base?: string;
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  /** Max inputs per request; the endpoint contract caps at 64. */
  batchSize?: number;
  /** Injectable fetch (tests run with zero real network). */
  fetchImpl?: typeof fetch;
  /** Loads the optional undici module; injectable for the same reason. */
  undiciLoader?: () => Promise<unknown>;
  /**
   * Wall-clock budget for the whole batch loop (default 120s). Exceeding it
   * throws `EmbeddingsError`; a single batch failing inside the budget returns
   * the vectors already in hand instead (see `partial`).
   */
  deadlineMs?: number;
}

export interface EmbeddingsResult {
  /**
   * Embeddings in input order. When `partial` is true this is a prefix: a
   * later batch failed and the vectors already received were kept.
   */
  embeddings: number[][];
  /** Degradation notes; an empty array means everything worked as asked. */
  degraded: string[];
  /** True when a later batch failed and earlier batches were returned. */
  partial: boolean;
}

/** Any adapter failure after its retry budget (config, HTTP, parsing). */
export class EmbeddingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmbeddingsError';
  }
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_DEADLINE_MS = 120_000;
const MAX_BATCH = 64;
const FALLBACK_BACKOFF_MS = 500;

interface EnvLike {
  MDLINEAGE_EMBED_API_BASE?: string;
  MDLINEAGE_EMBED_API_KEY?: string;
  MDLINEAGE_EMBED_MODEL?: string;
  MDLINEAGE_EMBED_PROXY?: string;
  HTTPS_PROXY?: string;
  HTTP_PROXY?: string;
  ALL_PROXY?: string;
}

/**
 * Embed `inputs` through the configured endpoint. Throws `EmbeddingsError`
 * on unrecoverable failures; the caller decides whether that is degradable.
 */
export async function embedTexts(inputs: readonly string[], options: EmbeddingsOptions = {}): Promise<EmbeddingsResult> {
  const env = process.env as EnvLike;
  const base = (options.base ?? env.MDLINEAGE_EMBED_API_BASE ?? '').replace(/\/+$/, '');
  const apiKey = options.apiKey ?? env.MDLINEAGE_EMBED_API_KEY ?? '';
  const model = options.model ?? env.MDLINEAGE_EMBED_MODEL ?? '';
  if (base === '' || model === '') {
    throw new EmbeddingsError(
      'embeddings endpoint not configured: set MDLINEAGE_EMBED_API_BASE and MDLINEAGE_EMBED_MODEL',
    );
  }

  const degraded: string[] = [];
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const batchSize = Math.max(1, Math.min(options.batchSize ?? MAX_BATCH, MAX_BATCH));
  const dispatcher = await resolveProxyDispatcher(env, options, degraded);

  const embeddings: number[][] = [];
  const started = Date.now();
  for (let start = 0; start < inputs.length; start += batchSize) {
    const remaining = deadlineMs - (Date.now() - started);
    if (remaining <= 0) {
      throw new EmbeddingsError(`embeddings deadline exceeded after ${deadlineMs}ms`);
    }
    const batch = inputs.slice(start, start + batchSize);
    try {
      const data = await requestBatch({
        base,
        apiKey,
        model,
        batch,
        // Cap this attempt at the time still inside the overall deadline so a
        // hung request cannot outlive the budget.
        timeoutMs: Math.min(timeoutMs, remaining),
        fetchImpl,
        ...(dispatcher === undefined ? {} : { dispatcher }),
      });
      embeddings.push(...data);
    } catch (error) {
      if (Date.now() - started >= deadlineMs - 15) {
        throw new EmbeddingsError(`embeddings deadline exceeded after ${deadlineMs}ms`);
      }
      if (embeddings.length > 0) {
        degraded.push(
          `batch failed at input offset ${start}: ${errorMessage(error)}; returning ${embeddings.length} partial embeddings`,
        );
        return { embeddings, degraded, partial: true };
      }
      if (error instanceof EmbeddingsError) throw error;
      throw new EmbeddingsError(`embeddings request failed: ${errorMessage(error)}`);
    }
  }
  return { embeddings, degraded, partial: false };
}

interface BatchRequest {
  base: string;
  apiKey: string;
  model: string;
  batch: string[];
  timeoutMs: number;
  fetchImpl: typeof fetch;
  /** Per-request undici dispatcher. Never installed on the process. */
  dispatcher?: unknown;
}

/** One HTTP attempt plus the machinery of its timeout (headers AND body). */
interface Attempt {
  response: Response;
  controller: AbortController;
  timer: NodeJS.Timeout;
  /** Rejects when the attempt timer fires; see `postOnce`. */
  timeout: Promise<never>;
}

/** One batch with the single-retry policy; returns embeddings in input order. */
async function requestBatch(req: BatchRequest): Promise<number[][]> {
  try {
    let attempt = await postOnce(req);
    if (attempt.response.status === 429 || attempt.response.status >= 500) {
      // Release the failed attempt's connection, stop its timer, then back
      // off — exactly one retry, per the contract.
      void attempt.response.body?.cancel();
      clearTimeout(attempt.timer);
      const backoff = retryAfterMs(attempt.response) ?? FALLBACK_BACKOFF_MS;
      await sleep(backoff);
      attempt = await postOnce(req);
    }
    if (!attempt.response.ok) {
      clearTimeout(attempt.timer);
      // Status only — the body could echo the Authorization header material.
      throw new EmbeddingsError(`embeddings API error: HTTP ${attempt.response.status}`);
    }
    // The attempt timer covers the body read too: it is cleared only after
    // the JSON has fully arrived (or the race below rejects first).
    const jsonPromise = safeJson(attempt.response);
    // The race loser must not surface as an unhandled rejection later.
    jsonPromise.catch(() => undefined);
    let payload: unknown;
    try {
      payload = await Promise.race([jsonPromise, attempt.timeout]);
    } finally {
      clearTimeout(attempt.timer);
    }
    return parseEmbeddingsResponse(payload, req.batch.length);
  } catch (error) {
    if (error instanceof EmbeddingsError) throw error;
    throw new EmbeddingsError(`embeddings request failed: ${errorMessage(error)}`);
  }
}

async function postOnce(req: BatchRequest): Promise<Attempt> {
  const controller = new AbortController();
  let fire: () => void = () => undefined;
  const timeout = new Promise<never>((_, reject) => {
    fire = () => reject(new EmbeddingsError(`embeddings request timed out after ${req.timeoutMs}ms`));
  });
  // When the fetch itself throws (e.g. the abort), this promise is never
  // raced; mark its (possible) rejection handled so it cannot surface as an
  // unhandledRejection after the caller has already failed another way.
  timeout.catch(() => undefined);
  // One timer per attempt spanning headers AND body: a provider that streams
  // the body forever must not hang the caller past the budget.
  const timer = setTimeout(() => {
    controller.abort();
    fire();
  }, req.timeoutMs);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (req.apiKey !== '') headers.authorization = `Bearer ${req.apiKey}`;
  const init: RequestInit = {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: req.model, input: req.batch }),
    signal: controller.signal,
  };
  // Local to this call. `setGlobalDispatcher` would poison every later fetch
  // in a long-lived MCP process (leftover #34). The dispatcher stays `unknown`
  // so this package does not import undici; Object.assign attaches it without
  // pretending the value is a typed Dispatcher.
  if (req.dispatcher !== undefined) Object.assign(init, { dispatcher: req.dispatcher });
  const response = await req.fetchImpl(`${req.base}/v1/embeddings`, init);
  return { response, controller, timer, timeout };
}

function retryAfterMs(response: Response): number | undefined {
  const raw = response.headers.get('retry-after');
  if (raw === null) return undefined;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.min(seconds * 1000, 30_000);
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    throw new EmbeddingsError(`embeddings response was not JSON: ${errorMessage(error)}`);
  }
}

/**
 * Parse `{ data: [{ index, embedding }] }` strictly. The provider contract is
 * one row per input, so anything else — a missing row, a duplicate or
 * out-of-range `index`, a non-finite component — is a protocol violation and
 * throws instead of silently misaligning embeddings with their inputs. Errors
 * carry counts/indices only, never body text or key material.
 */
function parseEmbeddingsResponse(payload: unknown, expectedCount: number): number[][] {
  if (typeof payload !== 'object' || payload === null) {
    throw new EmbeddingsError('embeddings response: expected a JSON object');
  }
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) {
    throw new EmbeddingsError('embeddings response: missing data array');
  }
  if (data.length !== expectedCount) {
    throw new EmbeddingsError(`embeddings response: expected ${expectedCount} rows, got ${data.length}`);
  }
  const rows: number[][] = new Array<number[]>(expectedCount);
  const seen = new Set<number>();
  for (let position = 0; position < data.length; position++) {
    const row = data[position];
    if (typeof row !== 'object' || row === null) {
      throw new EmbeddingsError(`embeddings response: row ${position} is not an object`);
    }
    const rawIndex = (row as { index?: unknown }).index;
    // An absent index falls back to the row's position (a legal provider
    // shape); a present-but-malformed index is a violation, not a fallback.
    let index = position;
    if (rawIndex !== undefined) {
      if (typeof rawIndex !== 'number' || !Number.isInteger(rawIndex)) {
        throw new EmbeddingsError(`embeddings response: row ${position} has a non-integer index`);
      }
      index = rawIndex;
    }
    if (index < 0 || index >= expectedCount) {
      throw new EmbeddingsError(`embeddings response: index ${index} out of range for ${expectedCount} rows`);
    }
    if (seen.has(index)) {
      throw new EmbeddingsError(`embeddings response: duplicate index ${index}`);
    }
    seen.add(index);
    const embedding = (row as { embedding?: unknown }).embedding;
    if (!Array.isArray(embedding) || !embedding.every((v) => typeof v === 'number' && Number.isFinite(v))) {
      throw new EmbeddingsError(`embeddings response: row ${position} has an invalid embedding`);
    }
    rows[index] = embedding as number[];
  }
  return rows;
}

/**
 * Build a per-request proxy dispatcher when an environment proxy is set.
 * `undici` is loaded through a string specifier so it stays an optional peer
 * module: when the import fails the caller proceeds direct (degraded).
 * The dispatcher is passed to that one `fetch` and is never installed globally.
 */
async function resolveProxyDispatcher(
  env: EnvLike,
  options: EmbeddingsOptions,
  degraded: string[],
): Promise<unknown> {
  const proxy =
    env.MDLINEAGE_EMBED_PROXY ?? env.HTTPS_PROXY ?? env.HTTP_PROXY ?? env.ALL_PROXY ?? '';
  if (proxy === '') return undefined;

  const loader =
    options.undiciLoader ??
    (async () => {
      // String specifier (not a literal): TypeScript must not resolve this
      // module — undici is deliberately absent from dependencies.
      const specifier = 'undici';
      return (await import(specifier)) as {
        ProxyAgent?: new (uri: string) => unknown;
      };
    });

  let mod: { ProxyAgent?: new (uri: string) => unknown };
  try {
    mod = (await loader()) as typeof mod;
  } catch (error) {
    if (error instanceof Error) {
      degraded.push(`proxy-configured-but-undici-unavailable (${redactUrl(proxy)}): direct connection used`);
      return undefined;
    }
    throw error;
  }
  if (typeof mod.ProxyAgent !== 'function') {
    degraded.push(`proxy-configured-but-undici-incomplete (${redactUrl(proxy)}): direct connection used`);
    return undefined;
  }
  try {
    const dispatcher = new mod.ProxyAgent(proxy);
    degraded.push(`proxy-active (${redactUrl(proxy)})`);
    return dispatcher;
  } catch (error) {
    if (error instanceof Error) {
      degraded.push(`proxy-setup-failed (${redactUrl(proxy)}): direct connection used`);
      return undefined;
    }
    throw error;
  }
}

/** Strip credentials: `http://user:pass@host:port` → `http://host:port`. */
function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return '(invalid proxy URL)';
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
