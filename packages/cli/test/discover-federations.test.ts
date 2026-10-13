/**
 * `mdlineage init --discover-federations` end-to-end tests (Issue #4 Phase 3).
 *
 * The binary is driven through `child_process` because the observable surface
 * of `init` is stdout plus the files it does or does not touch: a dry run must
 * leave the config byte-identical, and `--write` must be idempotent.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
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

function runCli(args: string[], cwd: string): RunOutput {
  const result = spawnSync(process.execPath, [cliBin, ...args], { cwd, encoding: 'utf8', windowsHide: true });
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status };
}

/**
 * A parent directory holding a `home` repository plus its neighbours:
 * two config-bearing siblings (proposal targets), one directory with no
 * config (not a repository), and one hidden config-bearing sibling (skipped).
 */
function scratchNeighbourhood(): { parent: string; home: string; cleanup: () => void } {
  const parent = mkdtempSync(join(tmpdir(), 'mdlineage-discover-'));
  const home = join(parent, 'home');
  mkdirSync(join(home, 'docs'), { recursive: true });
  writeFileSync(join(home, 'mdlineage.config.yaml'), 'configVersion: 1\n', 'utf8');
  writeFileSync(join(home, 'docs', 'index.md'), '# Home\n', 'utf8');

  for (const name of ['sibling-skills', 'sibling-docs']) {
    mkdirSync(join(parent, name), { recursive: true });
    writeFileSync(join(parent, name, 'mdlineage.config.yaml'), 'configVersion: 1\n', 'utf8');
  }
  // No config: not a repository, must not be proposed.
  mkdirSync(join(parent, 'plain-directory'), { recursive: true });
  // Hidden directory: skipped even though it carries a config.
  mkdirSync(join(parent, '.hidden-repo'), { recursive: true });
  writeFileSync(join(parent, '.hidden-repo', 'mdlineage.config.yaml'), 'configVersion: 1\n', 'utf8');

  return { parent, home, cleanup: () => rmSync(parent, { recursive: true, force: true }) };
}

describe('mdlineage init --discover-federations', () => {
  it('dry run prints the proposal and leaves the config untouched', () => {
    const { home, cleanup } = scratchNeighbourhood();
    const configPath = join(home, 'mdlineage.config.yaml');
    const before = readFileSync(configPath, 'utf8');
    try {
      const out = runCli(['init', '--discover-federations'], home);

      assert.equal(out.status, 0, `stdout: ${out.stdout}\nstderr: ${out.stderr}`);
      assert.match(out.stdout, /discover-federations: 2 candidate repositories found/);
      // The proposed YAML block is printed for a human to copy or accept.
      assert.match(out.stdout, /federations to add/);
      assert.match(out.stdout, /federations:\n {2}sibling-docs:/);
      assert.match(out.stdout, /path: \.\.\/sibling-skills/);
      assert.match(out.stdout, /trust: readonly/);
      // The hidden sibling and the config-less directory are absent.
      assert.ok(!out.stdout.includes('hidden-repo'), `hidden repo must be skipped: ${out.stdout}`);
      assert.ok(!out.stdout.includes('plain-directory'), `config-less dir must be skipped: ${out.stdout}`);

      assert.equal(readFileSync(configPath, 'utf8'), before, 'dry run must not write the config');
      assert.ok(!existsSync(join(home, 'mdlineage.manifest.yaml')), 'dry run writes nothing');
    } finally {
      cleanup();
    }
  });

  it('--write appends the federations block and is idempotent', () => {
    const { home, cleanup } = scratchNeighbourhood();
    const configPath = join(home, 'mdlineage.config.yaml');
    try {
      const first = runCli(['init', '--discover-federations', '--write'], home);
      assert.equal(first.status, 0, `stdout: ${first.stdout}\nstderr: ${first.stderr}`);
      assert.match(first.stdout, /federations sibling-docs, sibling-skills|federations sibling-skills, sibling-docs/);

      const written = readFileSync(configPath, 'utf8');
      assert.match(written, /^federations:/m);
      assert.match(written, / {2}sibling-skills:/);
      assert.match(written, / {2}sibling-docs:/);
      assert.match(written, /path: \.\.\/sibling-skills/);

      // The rewritten config still loads cleanly (schema-valid block).
      const validate = runCli(['config', 'validate'], home);
      assert.equal(validate.status, 0, `config validate failed: ${validate.stdout}${validate.stderr}`);

      const second = runCli(['init', '--discover-federations', '--write'], home);
      assert.equal(second.status, 0, `stdout: ${second.stdout}\nstderr: ${second.stderr}`);
      assert.equal(readFileSync(configPath, 'utf8'), written, 'a second --write must not change the config');
      assert.ok(!second.stdout.includes('federations to add'), 'no new proposal on the second run');
    } finally {
      cleanup();
    }
  });

  it('honours a pre-existing federation scope without duplicating it', () => {
    const { home, cleanup } = scratchNeighbourhood();
    const configPath = join(home, 'mdlineage.config.yaml');
    try {
      // Declare sibling-skills under a custom scope; discovery must leave the
      // scope name alone and not re-propose that physical root.
      writeFileSync(
        configPath,
        [
          'configVersion: 1',
          'federations:',
          '  skills:',
          '    local:',
          '      path: ../sibling-skills',
          '',
        ].join('\n'),
        'utf8',
      );

      const out = runCli(['init', '--discover-federations', '--write'], home);
      assert.equal(out.status, 0, `stdout: ${out.stdout}\nstderr: ${out.stderr}`);

      const written = readFileSync(configPath, 'utf8');
      assert.match(written, / {2}skills:/, 'the existing custom scope survives');
      assert.match(written, / {2}sibling-docs:/, 'the new sibling is added');
      assert.ok(!/ {2}sibling-skills:/.test(written), 'the already-declared root is not re-proposed');
    } finally {
      cleanup();
    }
  });

  it('reports nothing to do when no sibling repository exists', () => {
    // The home sits one level inside a dedicated parent so the scanned
    // directory is this test's own (the shared tmpdir holds other fixtures).
    const grandparent = mkdtempSync(join(tmpdir(), 'mdlineage-discover-only-'));
    const parent = join(grandparent, 'scope');
    const home = join(parent, 'home');
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'mdlineage.config.yaml'), 'configVersion: 1\n', 'utf8');
    try {
      const out = runCli(['init', '--discover-federations'], home);
      assert.equal(out.status, 0, `stdout: ${out.stdout}\nstderr: ${out.stderr}`);
      assert.match(out.stdout, /0 candidate repositories found/);
      assert.ok(!out.stdout.includes('federations to add'));
    } finally {
      rmSync(grandparent, { recursive: true, force: true });
    }
  });

  it('rejects an out-of-range --discover-depth', () => {
    const { home, cleanup } = scratchNeighbourhood();
    try {
      const out = runCli(['init', '--discover-federations', '--discover-depth', '3'], home);
      assert.equal(out.status, 2);
      assert.match(out.stderr, /--discover-depth must be 1 or 2/);
    } finally {
      cleanup();
    }
  });
});
