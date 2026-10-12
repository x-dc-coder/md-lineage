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
 *     MDLINEAGE_EMBED_PROXY select an undici ProxyAgent; `undici` is a
 *     peer-provided optional module (never a dependency), and when it is
 *     unavailable the request goes direct with a `degraded` note — a
 *     network/设备故障 must never fail a gate (the determinism iron rule).
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
}

export interface EmbeddingsResult {
  /** One embedding per input, in input order. */
  embeddings: number[][];
  /** Degradation notes; an empty array means everything worked as asked. */
  degraded: string[];
}

/** Any adapter failure after its retry budget (config, HTTP, parsing). */
export class EmbeddingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmbeddingsError';
  }
}

const DEFAULT_TIMEOUT_MS = 10_000;
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
  const batchSize = Math.max(1, Math.min(options.batchSize ?? MAX_BATCH, MAX_BATCH));

  await activateProxyIfConfigured(env, options, degraded);

  const embeddings: number[][] = [];
  for (let start = 0; start < inputs.length; start += batchSize) {
    const batch = inputs.slice(start, start + batchSize);
    const data = await requestBatch({ base, apiKey, model, batch, timeoutMs, fetchImpl });
    embeddings.push(...data);
  }
  return { embeddings, degraded };
}

interface BatchRequest {
  base: string;
  apiKey: string;
  model: string;
  batch: string[];
  timeoutMs: number;
  fetchImpl: typeof fetch;
}

/** One batch with the single-retry policy; returns embeddings in input order. */
async function requestBatch(req: BatchRequest): Promise<number[][]> {
  let response: Response;
  try {
    response = await postOnce(req);
    if (response.status === 429 || response.status >= 500) {
      const backoff = retryAfterMs(response) ?? FALLBACK_BACKOFF_MS;
      await sleep(backoff);
      response = await postOnce(req); // exactly one retry, per the contract
    }
  } catch (error) {
    throw new EmbeddingsError(`embeddings request failed: ${errorMessage(error)}`);
  }
  if (!response.ok) {
    // Status only — the body could echo the Authorization header material.
    throw new EmbeddingsError(`embeddings API error: HTTP ${response.status}`);
  }
  return parseEmbeddingsResponse(await safeJson(response));
}

async function postOnce(req: BatchRequest): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), req.timeoutMs);
  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (req.apiKey !== '') headers.authorization = `Bearer ${req.apiKey}`;
    return await req.fetchImpl(`${req.base}/v1/embeddings`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: req.model, input: req.batch }),
      signal: controller.signal,
    });
  } finally {
    // The response body is consumed later; only the connection timer is done.
    clearTimeout(timer);
  }
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

/** Parse `{ data: [{ index, embedding }] }`, ordered by `index`. */
function parseEmbeddingsResponse(payload: unknown): number[][] {
  if (typeof payload !== 'object' || payload === null) {
    throw new EmbeddingsError('embeddings response: expected a JSON object');
  }
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) {
    throw new EmbeddingsError('embeddings response: missing data array');
  }
  const rows = data
    .map((row, position) => ({ row, position }))
    .filter((entry): entry is { row: { index?: unknown; embedding?: unknown }; position: number } =>
      typeof entry.row === 'object' && entry.row !== null)
    .map((entry) => ({
      index: typeof entry.row.index === 'number' ? entry.row.index : entry.position,
      embedding: entry.row.embedding,
    }))
    .filter((entry) => Array.isArray(entry.embedding) && entry.embedding.every((v) => typeof v === 'number'))
    .sort((a, b) => a.index - b.index);
  return rows.map((row) => row.embedding as number[]);
}

/**
 * Install the proxy dispatcher when an environment proxy is configured.
 * `undici` is loaded through a string specifier so it stays an optional peer
 * module: when the import fails the caller proceeds direct (degraded).
 */
async function activateProxyIfConfigured(
  env: EnvLike,
  options: EmbeddingsOptions,
  degraded: string[],
): Promise<void> {
  const proxy =
    env.MDLINEAGE_EMBED_PROXY ?? env.HTTPS_PROXY ?? env.HTTP_PROXY ?? env.ALL_PROXY ?? '';
  if (proxy === '') return;

  const loader =
    options.undiciLoader ??
    (async () => {
      // String specifier (not a literal): TypeScript must not resolve this
      // module — undici is deliberately absent from dependencies.
      const specifier = 'undici';
      return (await import(specifier)) as {
        ProxyAgent?: new (uri: string) => unknown;
        setGlobalDispatcher?: (d: unknown) => void;
      };
    });

  let mod: {
    ProxyAgent?: new (uri: string) => unknown;
    setGlobalDispatcher?: (d: unknown) => void;
  };
  try {
    mod = (await loader()) as typeof mod;
  } catch {
    degraded.push(`proxy-configured-but-undici-unavailable (${redactUrl(proxy)}): direct connection used`);
    return;
  }
  if (typeof mod.ProxyAgent !== 'function' || typeof mod.setGlobalDispatcher !== 'function') {
    degraded.push(`proxy-configured-but-undici-incomplete (${redactUrl(proxy)}): direct connection used`);
    return;
  }
  try {
    mod.setGlobalDispatcher(new mod.ProxyAgent(proxy));
    degraded.push(`proxy-active (${redactUrl(proxy)})`);
  } catch {
    degraded.push(`proxy-setup-failed (${redactUrl(proxy)}): direct connection used`);
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
