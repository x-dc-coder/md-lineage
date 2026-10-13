/**
 * `mdlineage retrieve setup` usage and the offline profile paths.
 * The checksum case plants a stand-in file so a pinned digest fails closed
 * without contacting the mirror.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..');
const cliBin = resolve(repoRoot, 'packages', 'cli', 'dist', 'main.js');
const modelsJson = resolve(repoRoot, 'packages', 'embed-local', 'models.json');

interface RunOutput {
  stdout: string;
  stderr: string;
  status: number | null;
}

function runCli(args: string[], cwd: string, env: Record<string, string>): RunOutput {
  const result = spawnSync(process.execPath, [cliBin, ...args], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, ...env },
  });
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status };
}

test('unknown retrieve subcommand mentions setup', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mdl-retrieve-setup-'));
  try {
    const result = runCli(['retrieve', 'nope'], dir, { MDLINEAGE_MODELS_DIR: dir });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /expected search, discover, or setup/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('retrieve setup rejects a positional query', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mdl-retrieve-setup-'));
  try {
    const result = runCli(['retrieve', 'setup', 'extra'], dir, { MDLINEAGE_MODELS_DIR: dir });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /does not take a query/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('unknown profile exits 2', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mdl-retrieve-setup-'));
  try {
    const result = runCli(
      ['retrieve', 'setup', '--profile', 'local:missing', '--mirror', 'https://example.invalid'],
      dir,
      { MDLINEAGE_MODELS_DIR: dir },
    );
    assert.equal(result.status, 2);
    assert.match(result.stderr, /unknown profile 'local:missing'/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pending 4b profile prints export guidance and writes no weight', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mdl-retrieve-setup-'));
  try {
    const result = runCli(
      ['retrieve', 'setup', '--profile', 'local:qwen3-4b', '--mirror', 'https://example.invalid'],
      dir,
      { MDLINEAGE_MODELS_DIR: dir },
    );
    assert.equal(result.status, 0);
    assert.match(result.stdout, /权重待导出/);
    assert.match(result.stdout, /optimum-cli export onnx/);
    assert.equal(result.stderr.includes('download failed'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface CatalogFile {
  readonly path: string;
  readonly sha256: string;
}

interface CatalogProfile {
  readonly id: string;
  readonly repo: string;
  readonly files: readonly CatalogFile[];
}

function readEmbedProfile(): CatalogProfile {
  const parsed: unknown = JSON.parse(readFileSync(modelsJson, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || !('profiles' in parsed) || !Array.isArray(parsed.profiles)) {
    throw new Error('models.json has no profiles');
  }
  for (const entry of parsed.profiles) {
    if (!isProfile(entry) || entry.id !== 'local:qwen3-0.6b') continue;
    return entry;
  }
  throw new Error('models.json is missing local:qwen3-0.6b');
}

function isProfile(value: unknown): value is CatalogProfile {
  if (typeof value !== 'object' || value === null) return false;
  if (!('id' in value) || typeof value.id !== 'string') return false;
  if (!('repo' in value) || typeof value.repo !== 'string') return false;
  if (!('files' in value) || !Array.isArray(value.files)) return false;
  return value.files.every(
    (file) =>
      typeof file === 'object' &&
      file !== null &&
      'path' in file &&
      typeof file.path === 'string' &&
      'sha256' in file &&
      typeof file.sha256 === 'string',
  );
}

test('a planted file that misses the pin exits 1 without downloading', () => {
  const profile = readEmbedProfile();
  const pinned = profile.files.find((file) => file.sha256 !== '');
  assert.ok(pinned !== undefined, 'local:qwen3-0.6b has no sha256 pin yet');
  assert.match(pinned.sha256, /^[0-9a-f]{64}$/);

  const dir = mkdtempSync(join(tmpdir(), 'mdl-retrieve-setup-'));
  try {
    const planted = join(dir, profile.repo, pinned.path);
    mkdirSync(dirname(planted), { recursive: true });
    writeFileSync(planted, 'not-the-weight');
    const result = runCli(
      ['retrieve', 'setup', '--profile', 'local:qwen3-0.6b', '--mirror', 'https://example.invalid'],
      dir,
      { MDLINEAGE_MODELS_DIR: dir },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /checksum mismatch/);
    assert.equal(result.stderr.includes('download failed'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
