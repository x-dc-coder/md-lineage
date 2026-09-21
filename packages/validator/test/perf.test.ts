/**
 * Performance smoke test (docs/remark-language-server-solution.md §13:
 * "普通文档单文件解析和 Schema 校验目标 P95 小于 50ms").
 *
 * Not a correctness test: it asserts the budget holds over 1000 runs of the
 * realistic valid fixture, so a regression in the hot path is caught here
 * rather than in an editor.
 *
 * Run with: node --import tsx --test packages/validator/test/perf.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateDocumentSync } from '../src/index.js';

const repoRoot = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..');
const fixtureRoot = resolve(repoRoot, 'test', 'fixtures');

const RUNS = 1000;
const P95_BUDGET_MS = 50;

describe('performance smoke', () => {
  it(`v01-full.md: ${RUNS} validations, P95 < ${P95_BUDGET_MS}ms`, () => {
    const content = readFileSync(resolve(fixtureRoot, 'valid', 'v01-full.md'), 'utf8');

    // Warm the parser and the schema compiler so the measurement covers the
    // steady state, not the one-time module and ajv setup.
    validateDocumentSync({ content });
    validateDocumentSync({ content });

    const timings: number[] = [];
    for (let i = 0; i < RUNS; i++) {
      const started = process.hrtime.bigint();
      const result = validateDocumentSync({ content });
      timings.push(Number(process.hrtime.bigint() - started) / 1e6);
      assert.equal(result.diagnostics.length, 0, 'the fixture stays clean under load');
    }

    timings.sort((a, b) => a - b);
    const p95 = timings[Math.floor(RUNS * 0.95) - 1]!;
    const median = timings[Math.floor(RUNS / 2)]!;
    const total = timings.reduce((sum, value) => sum + value, 0);

    console.log(
      `  ${RUNS} runs: median ${median.toFixed(2)}ms, P95 ${p95.toFixed(2)}ms, ` +
        `total ${total.toFixed(0)}ms (${(total / RUNS).toFixed(2)}ms/run)`,
    );
    assert.ok(p95 < P95_BUDGET_MS, `P95 ${p95.toFixed(2)}ms exceeds the ${P95_BUDGET_MS}ms budget`);
  });
});
