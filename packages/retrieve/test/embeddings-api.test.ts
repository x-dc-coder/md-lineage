/**
 * Embeddings adapter tests (Issue #3 Phase 1). Every test injects its own
 * `fetch` (and proxy loader): the suite performs zero real network, per the
 * repo-wide testing rule.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { embedTexts, EmbeddingsError } from '../src/index.js';

interface RecordedCall {
  url: string;
  init: RequestInit;
}

/** fetch mock: fixed responses in order; records every call. */
function mockFetch(responses: Array<(call: RecordedCall) => Response>): {
  impl: typeof fetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  let next = 0;
  const impl = ((url: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? ({} as RequestInit) };
    calls.push(call);
    const handler = responses[Math.min(next, responses.length - 1)];
    next++;
    return Promise.resolve(handler ? handler(call) : new Response('{}', { status: 200 }));
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function embeddingsResponse(order: number[], dim = 2): Response {
  return new Response(
    JSON.stringify({
      data: order.map((index) => ({ index, embedding: Array.from({ length: dim }, (_, k) => index * 10 + k) })),
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

test('embedTexts — posts to {base}/v1/embeddings with model and inputs', async () => {
  // A developer shell may export HTTPS_PROXY etc.; this test pins the
  // no-proxy path, so the proxy variables are snapshot and cleared.
  const proxyVars = ['MDLINEAGE_EMBED_PROXY', 'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY'];
  const saved = proxyVars.map((v) => [v, process.env[v]] as const);
  for (const v of proxyVars) delete process.env[v];
  try {
    const { impl, calls } = mockFetch([() => embeddingsResponse([0])]);
  const result = await embedTexts(['hello'], {
    base: 'https://gw.example.com/',
    apiKey: 'secret-key',
    model: 'qwen3-embedding',
    fetchImpl: impl,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, 'https://gw.example.com/v1/embeddings');
  const body = JSON.parse(String(calls[0]!.init.body)) as { model: string; input: string[] };
  assert.deepEqual(body, { model: 'qwen3-embedding', input: ['hello'] });
  assert.equal((calls[0]!.init.headers as Record<string, string>)['authorization'], 'Bearer secret-key');
    assert.deepEqual(result.embeddings, [[0, 1]]);
    assert.deepEqual(result.degraded, []);
  } finally {
    for (const [v, value] of saved) {
      if (value === undefined) delete process.env[v];
      else process.env[v] = value;
    }
  }
});

test('embedTexts — response rows are ordered by index, not by arrival', async () => {
  // The API returns index 2 first; output must follow input order.
  const { impl } = mockFetch([() => embeddingsResponse([2, 0, 1])]);
  const result = await embedTexts(['a', 'b', 'c'], {
    base: 'https://gw.example.com',
    model: 'm',
    fetchImpl: impl,
  });
  assert.deepEqual(result.embeddings, [[0, 1], [10, 11], [20, 21]]);
});

test('embedTexts — batches stay within the configured cap', async () => {
  const { impl, calls } = mockFetch([() => embeddingsResponse([0]), () => embeddingsResponse([0])]);
  const inputs = Array.from({ length: 100 }, (_, i) => `t${i}`);
  await embedTexts(inputs, {
    base: 'https://gw.example.com',
    model: 'm',
    batchSize: 64,
    fetchImpl: impl,
  });
  assert.equal(calls.length, 2);
  const first = JSON.parse(String(calls[0]!.init.body)) as { input: string[] };
  const second = JSON.parse(String(calls[1]!.init.body)) as { input: string[] };
  assert.equal(first.input.length, 64);
  assert.equal(second.input.length, 36);
});

test('embedTexts — 429 retries exactly once and succeeds', async () => {
  const { impl, calls } = mockFetch([
    () => new Response('rate limited', { status: 429, headers: { 'retry-after': '0' } }),
    () => embeddingsResponse([0]),
  ]);
  const result = await embedTexts(['x'], { base: 'https://gw.example.com', model: 'm', fetchImpl: impl });
  assert.deepEqual(result.embeddings, [[0, 1]]);
  assert.equal(calls.length, 2);
});

test('embedTexts — 5xx retries once; a second failure throws EmbeddingsError', async () => {
  const { impl, calls } = mockFetch([
    () => new Response('boom', { status: 503 }),
    () => new Response('boom again', { status: 500 }),
  ]);
  await assert.rejects(
    embedTexts(['x'], { base: 'https://gw.example.com', model: 'm', fetchImpl: impl }),
    (error: unknown) => {
      assert.ok(error instanceof EmbeddingsError);
      assert.match(error.message, /HTTP 500/);
      return true;
    },
  );
  assert.equal(calls.length, 2);
});

test('embedTexts — timeout aborts the attempt and reports without the key', async () => {
  const secret = 'top-secret-token';
  const impl = ((_url: RequestInfo | URL, init?: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      const signal = (init as { signal?: AbortSignal } | undefined)?.signal;
      signal?.addEventListener('abort', () => {
        const reason = signal.reason instanceof Error ? signal.reason : new Error('aborted');
        reject(reason);
      });
    });
  }) as unknown as typeof fetch;
  await assert.rejects(
    embedTexts(['x'], { base: 'https://gw.example.com', apiKey: secret, model: 'm', timeoutMs: 20, fetchImpl: impl }),
    (error: unknown) => {
      assert.ok(error instanceof EmbeddingsError);
      assert.ok(!error.message.includes(secret));
      return true;
    },
  );
});

test('embedTexts — missing configuration throws a clear EmbeddingsError', async () => {
  await assert.rejects(
    embedTexts(['x'], { base: '', model: '', fetchImpl: ((() => new Response('{}')) as unknown as typeof fetch) }),
    /MDLINEAGE_EMBED_API_BASE/,
  );
});

test('embedTexts — env vars fill unset options', async () => {
  const previous = {
    base: process.env.MDLINEAGE_EMBED_API_BASE,
    model: process.env.MDLINEAGE_EMBED_MODEL,
    key: process.env.MDLINEAGE_EMBED_API_KEY,
  };
  process.env.MDLINEAGE_EMBED_API_BASE = 'https://env.example.com';
  process.env.MDLINEAGE_EMBED_MODEL = 'env-model';
  process.env.MDLINEAGE_EMBED_API_KEY = 'env-key';
  try {
    const { impl, calls } = mockFetch([() => embeddingsResponse([0])]);
    await embedTexts(['x'], { fetchImpl: impl });
    assert.equal(calls[0]!.url, 'https://env.example.com/v1/embeddings');
    const body = JSON.parse(String(calls[0]!.init.body)) as { model: string };
    assert.equal(body.model, 'env-model');
  } finally {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) {
        delete process.env[k as keyof typeof previous];
      } else {
        process.env[k as keyof typeof previous] = v;
      }
    }
  }
});

test('embedTexts — proxy: configured proxy with a failed undici load degrades to direct', async () => {
  const previous = process.env.MDLINEAGE_EMBED_PROXY;
  process.env.MDLINEAGE_EMBED_PROXY = 'http://user:pass@proxy.internal:8080';
  try {
    const { impl } = mockFetch([() => embeddingsResponse([0])]);
    const result = await embedTexts(['x'], {
      base: 'https://gw.example.com',
      model: 'm',
      fetchImpl: impl,
      undiciLoader: async () => {
        throw new Error('MODULE_NOT_FOUND');
      },
    });
    assert.equal(result.degraded.length, 1);
    // Credentials in the proxy URL must never survive into a note.
    assert.ok(!result.degraded[0]!.includes('user:pass'));
    assert.match(result.degraded[0]!, /proxy\.internal:8080/);
  } finally {
    if (previous === undefined) delete process.env.MDLINEAGE_EMBED_PROXY;
    else process.env.MDLINEAGE_EMBED_PROXY = previous;
  }
});

test('embedTexts — proxy: a working undici install activates the dispatcher', async () => {
  const previous = process.env.HTTPS_PROXY;
  process.env.HTTPS_PROXY = 'http://proxy.internal:3128';
  try {
    const installed: unknown[] = [];
    const { impl } = mockFetch([() => embeddingsResponse([0])]);
    const result = await embedTexts(['x'], {
      base: 'https://gw.example.com',
      model: 'm',
      fetchImpl: impl,
      undiciLoader: async () => ({
        ProxyAgent: class {
          constructor(uri: string) {
            installed.push(uri);
          }
        },
        setGlobalDispatcher: (d: unknown) => installed.push(d),
      }),
    });
    assert.equal(installed.length, 2);
    assert.equal(installed[0], 'http://proxy.internal:3128');
    assert.deepEqual(result.degraded, ['proxy-active (http://proxy.internal:3128)']);
  } finally {
    if (previous === undefined) delete process.env.HTTPS_PROXY;
    else process.env.HTTPS_PROXY = previous;
  }
});
