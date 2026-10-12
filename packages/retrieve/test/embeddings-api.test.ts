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
  // Each batch's mock answer must cover that batch's size (strict validation
  // rejects row-count mismatches on purpose).
  const { impl, calls } = mockFetch([
    (call) => {
      const input = (JSON.parse(String(call.init.body)) as { input: string[] }).input;
      return embeddingsResponse(input.map((_, i) => i));
    },
  ]);
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
  // Save/restore under the REAL key names — an earlier revision wrote the
  // snapshots back under invented keys ('base', 'model', 'key'), leaking the
  // test values into the environment for every later test.
  const previous: [string, string | undefined][] = [
    ['MDLINEAGE_EMBED_API_BASE', process.env.MDLINEAGE_EMBED_API_BASE],
    ['MDLINEAGE_EMBED_MODEL', process.env.MDLINEAGE_EMBED_MODEL],
    ['MDLINEAGE_EMBED_API_KEY', process.env.MDLINEAGE_EMBED_API_KEY],
  ];
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
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
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

// ---------------------------------------------------------------------------
// A2: strict response validation — silent misalignment must throw.
// ---------------------------------------------------------------------------

test('embedTexts — duplicate index across rows is a protocol violation', async () => {
  const { impl } = mockFetch([
    () =>
      new Response(
        // Row 1 defaults to positional index 0; row 2 also claims 0.
        JSON.stringify({ data: [{ embedding: [1] }, { index: 0, embedding: [9] }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
  ]);
  await assert.rejects(
    embedTexts(['a', 'b'], { base: 'https://gw.example.com', model: 'm', fetchImpl: impl }),
    /duplicate index 0/,
  );
});

test('embedTexts — fewer rows than inputs is a protocol violation', async () => {
  const { impl } = mockFetch([() => embeddingsResponse([0, 1])]);
  await assert.rejects(
    embedTexts(['a', 'b', 'c'], { base: 'https://gw.example.com', model: 'm', fetchImpl: impl }),
    /expected 3 rows, got 2/,
  );
});

test('embedTexts — non-numeric embedding components are a protocol violation', async () => {
  const { impl } = mockFetch([
    () =>
      new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 'x'] }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  ]);
  await assert.rejects(
    embedTexts(['a'], { base: 'https://gw.example.com', model: 'm', fetchImpl: impl }),
    /invalid embedding/,
  );
});

test('embedTexts — out-of-range index is a protocol violation; shuffled-but-complete passes', async () => {
  const bad = mockFetch([
    () => new Response(JSON.stringify({ data: [{ index: 7, embedding: [1] }] }), { status: 200 }),
  ]);
  await assert.rejects(
    embedTexts(['a'], { base: 'https://gw.example.com', model: 'm', fetchImpl: bad.impl }),
    /out of range/,
  );

  const good = mockFetch([() => embeddingsResponse([2, 0, 1])]);
  const result = await embedTexts(['a', 'b', 'c'], {
    base: 'https://gw.example.com',
    model: 'm',
    fetchImpl: good.impl,
  });
  assert.deepEqual(result.embeddings, [[0, 1], [10, 11], [20, 21]]);
});

// ---------------------------------------------------------------------------
// B1: the timeout must cover the body read, not only the response headers.
// ---------------------------------------------------------------------------

test('embedTexts — a body stream that never ends is cut off by the timeout', async () => {
  const neverEndingBody = new ReadableStream<Uint8Array>({
    start() {
      // Never enqueue, never close: response.json() would hang forever.
    },
  });
  const impl = (() =>
    Promise.resolve(new Response(neverEndingBody, { status: 200, headers: { 'content-type': 'application/json' } }))) as unknown as typeof fetch;
  const startedAt = Date.now();
  await assert.rejects(
    embedTexts(['x'], {
      base: 'https://gw.example.com',
      model: 'm',
      timeoutMs: 100,
      fetchImpl: impl,
    }),
    (error: unknown) => {
      assert.ok(error instanceof EmbeddingsError);
      assert.match(error.message, /timed out after 100ms/);
      return true;
    },
  );
  const elapsed = Date.now() - startedAt;
  // Order-of-magnitude probe: the budget is 100ms, not an unbounded hang.
  assert.ok(elapsed < 2000, `timeout took ${elapsed}ms`);
});
