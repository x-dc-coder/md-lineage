/**
 * Tests for GitClock and git-backed fallback staleness checks (MDL801).
 *
 * Run with: node --import tsx --test packages/validator/test/git-clock.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultConfig,
  createWorkspaceIndex,
  validateWorkspace,
  clocksFromLog,
  gitClocksForIndex,
  type GitClock,
  type SpawnGitFn,
} from '../src/index.js';

describe('git-clock — spawner invocation and batching', () => {
  it('staleAfterDays: 0 produces zero spawns', async () => {
    let spawnCount = 0;
    const spawnGit: SpawnGitFn = () => {
      spawnCount++;
      return { stdout: '', exitCode: 0 };
    };
    const files = new Map([
      ['a.md', ['---', 'mdlineage:', '  schema: 1', '  id: doc.a', '  kind: policy', '  status: active', '---'].join('\n')],
    ]);
    const config = {
      ...defaultConfig(),
      lifecycle: { ...defaultConfig().lifecycle, staleAfterDays: 0 },
    };
    const index = createWorkspaceIndex(files, config);
    const clocks = await gitClocksForIndex(index, '/repo', { spawnGit });
    assert.equal(spawnCount, 0);
    assert.equal(clocks.size, 0);
  });

  it('all documents having authored timestamps produces zero spawns', async () => {
    let spawnCount = 0;
    const spawnGit: SpawnGitFn = () => {
      spawnCount++;
      return { stdout: '', exitCode: 0 };
    };
    const files = new Map([
      [
        'a.md',
        [
          '---',
          'mdlineage:',
          '  schema: 1',
          '  id: doc.a',
          '  kind: policy',
          '  status: active',
          '  updated_at: "2026-01-01"',
          '---',
        ].join('\n'),
      ],
      [
        'b.md',
        [
          '---',
          'mdlineage:',
          '  schema: 1',
          '  id: doc.b',
          '  kind: policy',
          '  status: active',
          '  created_at: "2026-01-01"',
          '---',
        ].join('\n'),
      ],
    ]);
    const config = {
      ...defaultConfig(),
      lifecycle: { ...defaultConfig().lifecycle, staleAfterDays: 30 },
    };
    const index = createWorkspaceIndex(files, config);
    const clocks = await gitClocksForIndex(index, '/repo', { spawnGit });
    assert.equal(spawnCount, 0);
    assert.equal(clocks.size, 0);
  });

  it('10 paths missing authored timestamps trigger exactly 1 rev-parse + 1 ls-files + 1 log', async () => {
    const files = new Map<string, string>();
    for (let i = 0; i < 10; i++) {
      files.set(
        `doc${i}.md`,
        ['---', 'mdlineage:', '  schema: 1', `  id: doc.${i}`, '  kind: policy', '  status: active', '---'].join('\n'),
      );
    }
    const calls: Array<readonly string[]> = [];
    const spawnGit: SpawnGitFn = (args) => {
      calls.push([...args]);
      if (args[0] === 'rev-parse') return { stdout: '/repo\n', exitCode: 0 };
      if (args.includes('ls-files')) {
        assert.equal(args.includes('--stdin'), false);
        const i = args.indexOf('--');
        const spec = i >= 0 ? args.slice(i + 1) : [];
        return { stdout: spec.join('\0') + (spec.length ? '\0' : ''), exitCode: 0 };
      }
      if (args.includes('log')) return { stdout: '1700000000\ndoc0.md\n1000\n', exitCode: 0 };
      return { stdout: '', exitCode: 0 };
    };

    const config = {
      ...defaultConfig(),
      lifecycle: { ...defaultConfig().lifecycle, staleAfterDays: 30 },
    };
    const index = createWorkspaceIndex(files, config);
    const clocks = await gitClocksForIndex(index, '/repo', { spawnGit, nowMs: 1700000000000 });

    assert.equal(calls.length, 3, 'expected exactly 3 calls: 1 rev-parse + 1 ls-files + 1 log (not 10)');
    assert.equal(calls[0]![0], 'rev-parse');
    assert.ok(calls[1]!.includes('ls-files'));
    assert.ok(calls[2]!.includes('log'));
    assert.equal(clocks.size, 10);
  });

  it('git log runs with core.quotepath=false so non-ASCII paths stay raw UTF-8', async () => {
    const files = new Map([
      ['a.md', ['---', 'mdlineage:', '  schema: 1', '  id: doc.a', '  kind: policy', '  status: active', '---'].join('\n')],
    ]);
    const calls: Array<readonly string[]> = [];
    const spawnGit: SpawnGitFn = (args) => {
      calls.push([...args]);
      if (args[0] === 'rev-parse') return { stdout: '/repo\n', exitCode: 0 };
      if (args.includes('ls-files')) return { stdout: 'a.md\0', exitCode: 0 };
      if (args.includes('log')) return { stdout: '1700000000\na.md\n1000\n', exitCode: 0 };
      return { stdout: '', exitCode: 0 };
    };
    const config = {
      ...defaultConfig(),
      lifecycle: { ...defaultConfig().lifecycle, staleAfterDays: 30 },
    };
    const index = createWorkspaceIndex(files, config);
    await gitClocksForIndex(index, '/repo', { spawnGit, nowMs: 1700000000000 });
    const logCall = calls.find((c) => c.includes('log'));
    assert.ok(logCall, 'expected a log call');
    assert.deepEqual(logCall.slice(0, 2), ['-c', 'core.quotepath=false']);
  });

  it('201 candidates trigger 2 ls-files and 2 log calls, each with <= 200 pathspecs', async () => {
    const files = new Map<string, string>();
    for (let i = 0; i < 201; i++) {
      files.set(
        `doc${i}.md`,
        ['---', 'mdlineage:', '  schema: 1', `  id: doc.${i}`, '  kind: policy', '  status: active', '---'].join('\n'),
      );
    }
    const calls: Array<readonly string[]> = [];
    const spawnGit: SpawnGitFn = (args) => {
      calls.push([...args]);
      if (args[0] === 'rev-parse') return { stdout: '/repo\n', exitCode: 0 };
      if (args.includes('ls-files')) {
        assert.equal(args.includes('--stdin'), false);
        const dashIdx = args.indexOf('--');
        assert.ok(dashIdx >= 0, 'ls-files must include -- separator');
        const spec = args.slice(dashIdx + 1);
        assert.ok(spec.length > 0 && spec.length <= 200, `ls-files chunk must have 1..200 paths, got ${spec.length}`);
        return { stdout: spec.join('\0') + '\0', exitCode: 0 };
      }
      if (args.includes('log')) {
        const dashIdx = args.indexOf('--');
        assert.ok(dashIdx >= 0, 'log must include -- separator');
        const spec = args.slice(dashIdx + 1);
        assert.ok(spec.length > 0 && spec.length <= 200, `log chunk must have 1..200 paths, got ${spec.length}`);
        return { stdout: '1700000000\n' + spec.join('\n') + '\n1000\n', exitCode: 0 };
      }
      return { stdout: '', exitCode: 0 };
    };

    const config = {
      ...defaultConfig(),
      lifecycle: { ...defaultConfig().lifecycle, staleAfterDays: 30 },
    };
    const index = createWorkspaceIndex(files, config);
    const clocks = await gitClocksForIndex(index, '/repo', { spawnGit, nowMs: 1700000000000 });

    const lsCalls = calls.filter((c) => c.includes('ls-files'));
    const logCalls = calls.filter((c) => c.includes('log'));
    assert.equal(lsCalls.length, 2, 'expected exactly 2 ls-files calls');
    assert.equal(logCalls.length, 2, 'expected exactly 2 log calls');
    for (const c of lsCalls) {
      assert.ok(c.includes('--'), 'no ls-files call without pathspec');
    }
    assert.equal(clocks.size, 201);
  });

  it('200 paths of 200 chars each split into at least 2 ls-files chunks due to MAX_PATHSPEC_CHARS', async () => {
    const files = new Map<string, string>();
    for (let i = 0; i < 200; i++) {
      const prefix = 'sub/'.repeat(38);
      const name = `${prefix}doc_${String(i).padStart(4, '0')}_${'x'.repeat(40)}.md`;
      files.set(
        name,
        ['---', 'mdlineage:', '  schema: 1', `  id: doc.${i}`, '  kind: policy', '  status: active', '---'].join('\n'),
      );
    }
    const calls: Array<readonly string[]> = [];
    const spawnGit: SpawnGitFn = (args) => {
      calls.push([...args]);
      if (args[0] === 'rev-parse') return { stdout: '/repo\n', exitCode: 0 };
      if (args.includes('ls-files')) {
        const dashIdx = args.indexOf('--');
        const spec = dashIdx >= 0 ? args.slice(dashIdx + 1) : [];
        return { stdout: spec.join('\0') + (spec.length ? '\0' : ''), exitCode: 0 };
      }
      if (args.includes('log')) {
        return { stdout: '1700000000\n1000\n', exitCode: 0 };
      }
      return { stdout: '', exitCode: 0 };
    };

    const config = {
      ...defaultConfig(),
      lifecycle: { ...defaultConfig().lifecycle, staleAfterDays: 30 },
    };
    const index = createWorkspaceIndex(files, config);
    await gitClocksForIndex(index, '/repo', { spawnGit, nowMs: 1700000000000 });

    const lsCalls = calls.filter((c) => c.includes('ls-files'));
    assert.ok(lsCalls.length >= 2, `expected at least 2 ls-files chunks due to char limit, got ${lsCalls.length}`);
  });

  it('ls-files exiting non-zero immediately aborts with 0 log calls and empty clocks', async () => {
    const files = new Map<string, string>();
    for (let i = 0; i < 10; i++) {
      files.set(
        `doc${i}.md`,
        ['---', 'mdlineage:', '  schema: 1', `  id: doc.${i}`, '  kind: policy', '  status: active', '---'].join('\n'),
      );
    }
    const calls: Array<readonly string[]> = [];
    const spawnGit: SpawnGitFn = (args) => {
      calls.push([...args]);
      if (args[0] === 'rev-parse') return { stdout: '/repo\n', exitCode: 0 };
      if (args.includes('ls-files')) {
        return { stdout: '', exitCode: 1 };
      }
      if (args.includes('log')) {
        return { stdout: '', exitCode: 0 };
      }
      return { stdout: '', exitCode: 0 };
    };

    const config = {
      ...defaultConfig(),
      lifecycle: { ...defaultConfig().lifecycle, staleAfterDays: 30 },
    };
    const index = createWorkspaceIndex(files, config);
    const clocks = await gitClocksForIndex(index, '/repo', { spawnGit, nowMs: 1700000000000 });

    const lsCalls = calls.filter((c) => c.includes('ls-files'));
    const logCalls = calls.filter((c) => c.includes('log'));
    assert.equal(lsCalls.length, 1, 'expected exactly 1 ls-files call before aborting');
    assert.equal(logCalls.length, 0, 'expected 0 log calls on ls-files error');
    assert.equal(clocks.size, 0, 'clocks must be empty');
  });
});

describe('git-clock — clocksFromLog output parsing', () => {
  it('parses timestamps and detects fresh vs cutoff-reached provenStale', () => {
    const stdout = [
      '1727000000',
      'docs/a.md',
      'docs/b.md',
      '',
      '1726000000',
      'docs/c.md',
      '',
      '1725000000',
      'docs/d.md',
      '1720000000',
      'docs/e.md',
    ].join('\n');
    const tracked = new Set(['docs/a.md', 'docs/b.md', 'docs/c.md', 'docs/d.md', 'docs/e.md', 'docs/f.md']);
    const cutoffSec = 1725500000;

    const result = clocksFromLog(stdout, tracked, cutoffSec);
    assert.equal(result.provenStale, true, 'timestamp 1725000000 is <= cutoff, provenStale must be true');
    assert.deepEqual([...result.fresh].sort(), ['docs/a.md', 'docs/b.md', 'docs/c.md']);
  });

  it('untracked paths are not added to fresh', () => {
    const stdout = ['1727000000', 'docs/untracked.md'].join('\n');
    const tracked = new Set(['docs/tracked.md']);
    const result = clocksFromLog(stdout, tracked, 1000);
    assert.equal(result.fresh.has('docs/untracked.md'), false);
  });
});

describe('validateWorkspace — GitClock integration', () => {
  const contentNoAuthored = [
    '---',
    'mdlineage:',
    '  schema: 1',
    '  id: doc.git',
    '  kind: policy',
    '  status: active',
    '---',
    '# Git Doc',
  ].join('\n');

  const config = {
    ...defaultConfig(),
    lifecycle: { ...defaultConfig().lifecycle, staleAfterDays: 30 },
  };

  it('does not report Git-based MDL801 when gitClocks is not provided', () => {
    const files = new Map([['git.md', contentNoAuthored]]);
    const index = createWorkspaceIndex(files, config);
    const all = validateWorkspace(index, { includeSingleDocument: false });
    assert.equal(all.filter((d) => d.code === 'MDL801').length, 0);
  });

  it('reports one Git-based MDL801 when gitClocks has provenStale: true', () => {
    const files = new Map([['git.md', contentNoAuthored]]);
    const index = createWorkspaceIndex(files, config);
    const gitClocks = new Map<string, GitClock>([['git.md', { provenStale: true, seconds: null }]]);
    const all = validateWorkspace(index, { includeSingleDocument: false, gitClocks });
    const d801List = all.filter((d) => d.code === 'MDL801');
    assert.equal(d801List.length, 1);
    assert.match(d801List[0]!.message, /\(git; no authored updated_at or created_at\)/);
    assert.equal(d801List[0]!.data?.source, 'git');
  });

  it('reports only one MDL801 when document already has authored clock even if gitClocks marks provenStale', () => {
    const contentWithAuthored = [
      '---',
      'mdlineage:',
      '  schema: 1',
      '  id: doc.authored',
      '  kind: policy',
      '  status: active',
      '  updated_at: "2020-01-01"',
      '---',
      '# Authored Doc',
    ].join('\n');
    const files = new Map([['git.md', contentWithAuthored]]);
    const index = createWorkspaceIndex(files, config);
    const gitClocks = new Map<string, GitClock>([['git.md', { provenStale: true, seconds: null }]]);
    const all = validateWorkspace(index, { includeSingleDocument: true, gitClocks });
    const d801List = all.filter((d) => d.code === 'MDL801');
    assert.equal(d801List.length, 1, 'must still have only 1 MDL801');
    assert.equal(d801List[0]!.data?.source, 'updated_at');
  });
});
