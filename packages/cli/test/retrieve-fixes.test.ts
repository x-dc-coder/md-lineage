/**
 * Review-round fixes for `mdlineage retrieve search` (Issue #3 Phase 1):
 * out-of-tree symlink corpus guard (A1), explicit --config failure → exit 2
 * (B8), code-point-safe snippets (C2) and sanitized no-match echoes (C3).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..');
const cliBin = resolve(repoRoot, 'packages', 'cli', 'dist', 'main.js');

function runCli(args: string[], cwd: string): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync(process.execPath, [cliBin, ...args], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  });
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status };
}

function makeCorpus(): { workspace: string; outside: string } {
  const workspace = mkdtempSync(join(tmpdir(), 'mdl-retrieve-fix-'));
  const outside = mkdtempSync(join(tmpdir(), 'mdl-retrieve-fix-out-'));
  mkdirSync(join(workspace, 'docs'), { recursive: true });
  writeFileSync(
    join(workspace, 'docs', 'caching.md'),
    '# 缓存策略\n\nvector cache content-addressed blobs manifest\n',
    'utf8',
  );
  // Distinctive vocabulary that exists ONLY outside the workspace.
  writeFileSync(join(outside, 'secret.md'), '# 机密外泄文档\n\nZIRCONIUM_PAPAYA_SECRET_TOKEN\n', 'utf8');
  symlinkSync(join(outside, 'secret.md'), join(workspace, 'docs', 'leak.md'));
  return { workspace, outside };
}

test('retrieve search — out-of-tree symlink content never reaches the output (A1)', () => {
  const { workspace, outside } = makeCorpus();
  try {
    const run = runCli(['retrieve', 'search', '--mode', 'lexical', 'ZIRCONIUM_PAPAYA_SECRET_TOKEN', '--format', 'json'], workspace);
    assert.equal(run.status, 0);
    const parsed = JSON.parse(run.stdout) as {
      results: Array<{ path: string; snippet: string }>;
      degraded: string[];
    };
    // The linked document is not part of the corpus: its unique token finds
    // nothing, its path appears in no result, and the skip is reported. (The
    // query string itself echoing in the JSON `query` field is expected.)
    assert.deepEqual(parsed.results, []);
    assert.ok(
      parsed.degraded.some((d) => d === 'skipped out-of-tree symlink: docs/leak.md'),
      `degraded: ${JSON.stringify(parsed.degraded)}`,
    );
    assert.ok(run.stderr.includes('skipped out-of-tree symlink: docs/leak.md'));
    assert.ok(!run.stdout.includes('机密外泄文档'));
    // The path may legitimately appear inside the degraded note; it must not
    // appear as a RESULT entry (already implied by results === []).
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('retrieve search — normal documents keep retrieving after the guard (A1)', () => {
  const { workspace, outside } = makeCorpus();
  try {
    const run = runCli(['retrieve', 'search', '--mode', 'lexical', 'manifest', '--format', 'json'], workspace);
    assert.equal(run.status, 0);
    const parsed = JSON.parse(run.stdout) as { results: Array<{ path: string }>; degraded: string[] };
    assert.equal(parsed.results[0]?.path, 'docs/caching.md');
    assert.ok(parsed.degraded.some((d) => d.includes('docs/leak.md')));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('retrieve search — an explicit --config that cannot load exits 2 (B8)', () => {
  const { workspace, outside } = makeCorpus();
  try {
    const missing = join(tmpdir(), 'mdl-no-such-config.yaml');
    const run = runCli(['retrieve', 'search', '--mode', 'lexical', 'manifest', '--config', missing], workspace);
    assert.equal(run.status, 2);
    assert.ok(run.stderr.includes('cannot load config'));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('retrieve search — snippet cuts at code points, never mid-surrogate (C2)', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'mdl-retrieve-snip-'));
  try {
    mkdirSync(join(workspace, 'docs'), { recursive: true });
    // 120 emoji: every code point is astral (surrogate pair in UTF-16).
    const emoji = '🚀'.repeat(120);
    writeFileSync(join(workspace, 'docs', 'emoji.md'), `# Emoji Doc\n\nalpha ${emoji} omega\n`, 'utf8');
    const run = runCli(['retrieve', 'search', '--mode', 'lexical', 'alpha omega', '--format', 'json'], workspace);
    assert.equal(run.status, 0);
    const parsed = JSON.parse(run.stdout) as { results: Array<{ snippet: string }> };
    const snippet = parsed.results[0]?.snippet ?? '';
    // 100 code points + the ellipsis; no lone surrogate anywhere.
    assert.equal([...snippet].length, 101);
    for (const ch of snippet) {
      const cp = ch.codePointAt(0) ?? 0;
      assert.ok(!(cp >= 0xd800 && cp <= 0xdfff), `lone surrogate in snippet: ${JSON.stringify(snippet)}`);
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('retrieve search — no-match echo collapses query whitespace (C3)', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'mdl-retrieve-echo-'));
  try {
    mkdirSync(join(workspace, 'docs'), { recursive: true });
    writeFileSync(join(workspace, 'docs', 'doc.md'), '# Doc\n\nbody\n', 'utf8');
    const multiline = 'zzz\n\t\tqqq   www';
    const run = runCli(['retrieve', 'search', '--mode', 'lexical', multiline], workspace);
    assert.equal(run.status, 0);
    assert.ok(run.stdout.includes("'zzz qqq www'"));
    assert.ok(!run.stdout.includes('\t'));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
