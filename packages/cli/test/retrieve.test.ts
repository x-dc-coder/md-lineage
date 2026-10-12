/**
 * `mdlineage retrieve search` tests (Issue #3 Phase 1): deterministic BM25
 * ranking over a fixture corpus, the JSON output shape, and the usage-error
 * exit contract (2 = usage; retrieval itself never exits 1).
 *
 * The binary is driven through child_process (same reason as cli.test.ts:
 * the exit code is part of the interface). Phase 1 is BM25-only, so these
 * runs perform no network access at all.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..');
const cliBin = resolve(repoRoot, 'packages', 'cli', 'dist', 'main.js');

interface RunOutput {
  stdout: string;
  stderr: string;
  status: number | null;
}

function runCli(args: string[], cwd: string, env?: Record<string, string>): RunOutput {
  const result = spawnSync(process.execPath, [cliBin, ...args], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    env: env === undefined ? process.env : { ...process.env, ...env },
  });
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status };
}

/** Fixture corpus: three documents with deliberately distinct vocabularies. */
function makeCorpus(): string {
  const root = mkdtempSync(join(tmpdir(), 'mdl-retrieve-'));
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(
    join(root, 'docs', 'search-engine.md'),
    [
      '---',
      'mdlineage:',
      '  schema: 1',
      '  id: docs.fixtures.search-engine',
      '  kind: reference',
      '  status: active',
      '---',
      '# 检索引擎设计',
      '',
      'BM25 是词法检索的经典打分函数，k1 与 b 参数控制词频饱和。',
      '',
      '## 混合检索管道',
      '',
      'BM25 召回 top-100 后与 dense 向量召回经 RRF 融合。',
      '',
      '## 缓存策略',
      '',
      '向量缓存按内容寻址，命中后跳过重算。',
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    join(root, 'docs', 'line-endings.md'),
    [
      '---',
      'mdlineage:',
      '  schema: 1',
      '  id: docs.fixtures.line-endings',
      '  kind: guide',
      '  status: active',
      '---',
      '# 行尾卫生',
      '',
      'CRLF 与 LF 混用会触发 MDL501 诊断，fix 命令统一换行策略。',
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(join(root, 'README.md'), '# Fixture\n\nNothing about search here.\n', 'utf8');
  return root;
}

test('retrieve search — deterministic BM25 ranking over the fixture corpus', () => {
  const root = makeCorpus();
  try {
    const first = runCli(['retrieve', 'search', '--mode', 'lexical', 'BM25 检索'], root);
    assert.equal(first.status, 0, `stderr: ${first.stderr}`);
    const second = runCli(['retrieve', 'search', '--mode', 'lexical', 'BM25 检索'], root);
    // Byte-identical output across runs: the tie-break contract made audible.
    assert.equal(first.stdout, second.stdout);

    const lines = first.stdout.trim().split('\n').filter((l) => l.length > 0);
    assert.ok(lines.length >= 2);
    const top = lines[0] ?? '';
    assert.match(top, /^1\s+docs\/search-engine\.md#/);
    // Best section first: the BM25-heavy preamble of search-engine.md.
    assert.match(top, /检索引擎设计|混合检索管道/);
    // The line-endings document is lexically unrelated to the query.
    assert.ok(!lines.some((l) => l.includes('docs/line-endings.md')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('retrieve search — --format json shape', () => {
  const root = makeCorpus();
  try {
    const run = runCli(['retrieve', 'search', '--mode', 'lexical', 'RRF 融合', '--format', 'json', '--top', '5'], root);
    assert.equal(run.status, 0);
    const parsed = JSON.parse(run.stdout) as {
      query: string;
      mode: string;
      results: Array<{ rank: number; path: string; slug: string; title: string; score: number; snippet: string }>;
      degraded: string[];
    };
    assert.equal(parsed.query, 'RRF 融合');
    assert.equal(parsed.mode, 'lexical');
    assert.deepEqual(parsed.degraded, []);
    assert.ok(parsed.results.length >= 1);
    assert.ok(parsed.results.length <= 5);
    const hit = parsed.results[0]!;
    assert.equal(hit.rank, 1);
    assert.equal(hit.path, 'docs/search-engine.md');
    assert.equal(hit.slug, '混合检索管道');
    assert.equal(hit.title, '混合检索管道');
    assert.ok(hit.score > 0);
    assert.ok(hit.snippet.includes('RRF'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('retrieve search — usage errors exit 2', () => {
  const root = makeCorpus();
  try {
    assert.equal(runCli(['retrieve'], root).status, 2);
    assert.equal(runCli(['retrieve', 'frobnicate'], root).status, 2);
    assert.equal(runCli(['retrieve', 'search'], root).status, 2);
    assert.equal(runCli(['retrieve', 'search', 'x', '--top', 'abc'], root).status, 2);
    assert.equal(runCli(['retrieve', 'search', 'x', '--top', '0'], root).status, 2);
    assert.equal(runCli(['retrieve', 'search', 'x', '--format', 'sarif'], root).status, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('retrieve search — zero matches still exits 0, text and json', () => {
  const root = makeCorpus();
  try {
    const text = runCli(['retrieve', 'search', '--mode', 'lexical', 'zzz_no_such_token_qqq'], root);
    assert.equal(text.status, 0);
    assert.match(text.stdout, /no sections matched/);

    const json = runCli(['retrieve', 'search', '--mode', 'lexical', 'zzz_no_such_token_qqq', '--format', 'json'], root);
    assert.equal(json.status, 0);
    const parsed = JSON.parse(json.stdout) as { results: unknown[]; degraded: string[] };
    assert.deepEqual(parsed.results, []);
    assert.deepEqual(parsed.degraded, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('retrieve search — --top limits the result count', () => {
  const root = makeCorpus();
  try {
    const run = runCli(['retrieve', 'search', '--mode', 'lexical', 'BM25 检索 缓存 向量', '--top', '1'], root);
    assert.equal(run.status, 0);
    const resultLines = run.stdout.trim().split('\n').filter((l) => /^\d+\s/.test(l));
    assert.equal(resultLines.length, 1);
    assert.match(resultLines[0]!, /^1\s/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('retrieve search — unknown mode, bad rerank depth, and contradictory flags exit 2', () => {
  const root = makeCorpus();
  try {
    assert.equal(runCli(['retrieve', 'search', 'x', '--mode', 'dense'], root).status, 2);
    assert.equal(runCli(['retrieve', 'search', 'x', '--rerank', '0'], root).status, 2);
    assert.equal(runCli(['retrieve', 'search', 'x', '--rerank', 'nope'], root).status, 2);
    assert.equal(runCli(['retrieve', 'search', 'x', '--rerank', '10', '--no-rerank'], root).status, 2);
    const conflict = runCli(['retrieve', 'search', 'x', '--mode', 'hybrid', '--bm25-only'], root);
    assert.equal(conflict.status, 2);
    assert.match(conflict.stderr, /--bm25-only cannot be combined/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('retrieve search — auto without a local model falls back to lexical and stays exit 0', () => {
  const root = makeCorpus();
  const modelDir = mkdtempSync(join(tmpdir(), 'mdl-models-empty-'));
  try {
    const run = runCli(['retrieve', 'search', 'BM25 检索', '--format', 'json'], root, {
      MDLINEAGE_MODELS_DIR: modelDir,
    });
    assert.equal(run.status, 0, run.stderr);
    const parsed = JSON.parse(run.stdout) as { mode: string; degraded: string[]; results: unknown[] };
    assert.equal(parsed.mode, 'lexical');
    assert.ok(parsed.results.length >= 1);
    assert.ok(
      parsed.degraded.some((note) => note.includes('falling back to lexical')),
      parsed.degraded.join('\n'),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(modelDir, { recursive: true, force: true });
  }
});
