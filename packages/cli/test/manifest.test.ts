/**
 * Tests for `mdlineage manifest seed`.
 *
 * Run with: node --import tsx --test packages/cli/test/manifest.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { generateSeedId } from '../src/manifest.js';

const thisDir = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = resolve(thisDir, '..', '..', '..');
const cliBin = resolve(repoRoot, 'packages', 'cli', 'dist', 'main.js');

function runCli(args: string[], cwd: string): { status: number; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [cliBin, ...args], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  });
  return {
    status: res.status ?? (res.signal ? 1 : 0),
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  };
}

describe('manifest seed', () => {
  function scratchDir(): { root: string; cleanup: () => void } {
    const root = mkdtempSync(join(tmpdir(), 'mdlineage-manifest-test-'));
    return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
  }

  describe('id generation rules', () => {
    it('SKILL.md special case maps to skill.<parentSlug>', () => {
      assert.equal(generateSeedId('skills/paper-reader/SKILL.md'), 'skill.paper-reader');
      assert.equal(generateSeedId('tools/pdf-parser/skill.md'), 'skill.pdf-parser');
    });

    it('standard markdown path maps to slug with dots', () => {
      assert.equal(generateSeedId('docs/guides/getting-started.md'), 'docs.guides.getting-started');
      assert.equal(generateSeedId('architecture/system-design.md'), 'architecture.system-design');
    });

    it('normalizes underscores and collapses consecutive separators', () => {
      assert.equal(generateSeedId('my_file.md'), 'my-file');
      assert.equal(generateSeedId('a__b--c.md'), 'a-b-c');
      assert.equal(generateSeedId('foo/bar_baz.md'), 'foo.bar-baz');
    });

    it('non-ASCII path falls back to doc.<sha256[0..8]>', () => {
      const id = generateSeedId('文档/指南.md');
      assert.match(id, /^doc\.[0-9a-f]{8}$/);
      const mixed = generateSeedId('foo/中文.md');
      assert.match(mixed, /^doc\.[0-9a-f]{8}$/);
      const skillNonAscii = generateSeedId('skills/中文技能/SKILL.md');
      assert.match(skillNonAscii, /^doc\.[0-9a-f]{8}$/);
    });
  });

  it('dry-run does not modify files and prints YAML', () => {
    const dir = scratchDir();
    try {
      writeFileSync(join(dir.root, 'mdlineage.config.yaml'), 'configVersion: 1\n');
      writeFileSync(join(dir.root, 'a.md'), '# Doc A\n');

      const out = runCli(['manifest', 'seed'], dir.root);
      assert.equal(out.status, 0);
      assert.match(out.stdout, /documents:/);
      assert.match(out.stdout, /a\.md:/);
      assert.match(out.stdout, /id: a/);
      assert.match(out.stdout, /kind: reference/);
      assert.match(out.stdout, /status: active/);
    } finally {
      dir.cleanup();
    }
  });

  it('--json outputs JSON format', () => {
    const dir = scratchDir();
    try {
      writeFileSync(join(dir.root, 'mdlineage.config.yaml'), 'configVersion: 1\n');
      writeFileSync(join(dir.root, 'a.md'), '# Doc A\n');

      const out = runCli(['manifest', 'seed', '--json'], dir.root);
      assert.equal(out.status, 0);
      const parsed = JSON.parse(out.stdout);
      assert.ok(parsed.documents['a.md']);
      assert.equal(parsed.documents['a.md'].id, 'a');
      assert.equal(parsed.documents['a.md'].kind, 'reference');
      assert.equal(parsed.documents['a.md'].status, 'active');
    } finally {
      dir.cleanup();
    }
  });

  it('--write writes to empty manifest file successfully', () => {
    const dir = scratchDir();
    try {
      writeFileSync(join(dir.root, 'mdlineage.config.yaml'), 'configVersion: 1\nmanifestFile: mdlineage.manifest.yaml\n');
      writeFileSync(join(dir.root, 'mdlineage.manifest.yaml'), 'version: 1\ndocuments: {}\n');
      writeFileSync(join(dir.root, 'a.md'), '# Doc A\n');

      const out = runCli(['manifest', 'seed', '--write'], dir.root);
      assert.equal(out.status, 0);
      assert.match(out.stdout, /wrote 1 entries/);

      const manifestContent = readFileSync(join(dir.root, 'mdlineage.manifest.yaml'), 'utf8');
      assert.match(manifestContent, /a\.md:/);
      assert.match(manifestContent, /id: a/);
      assert.match(manifestContent, /status: active/);
    } finally {
      dir.cleanup();
    }
  });

  it('--write refuses to overwrite non-empty manifest (exit 2)', () => {
    const dir = scratchDir();
    try {
      writeFileSync(join(dir.root, 'mdlineage.config.yaml'), 'configVersion: 1\n');
      writeFileSync(join(dir.root, 'mdlineage.manifest.yaml'), 'version: 1\ndocuments:\n  existing.md:\n    id: existing\n');
      writeFileSync(join(dir.root, 'a.md'), '# Doc A\n');

      const out = runCli(['manifest', 'seed', '--write'], dir.root);
      assert.equal(out.status, 2);
      assert.match(out.stderr, /refusing to overwrite non-empty manifest file/);
    } finally {
      dir.cleanup();
    }
  });

  it('handles name collision with -2 suffix', () => {
    const dir = scratchDir();
    try {
      writeFileSync(join(dir.root, 'mdlineage.config.yaml'), 'configVersion: 1\n');
      // 'foo-bar.md' and 'foo--bar.md' both slugify to 'foo-bar'
      writeFileSync(join(dir.root, 'foo-bar.md'), '# Foo Bar\n');
      writeFileSync(join(dir.root, 'foo--bar.md'), '# Foo Bar 2\n');

      const out = runCli(['manifest', 'seed', '--json'], dir.root);
      assert.equal(out.status, 0);
      const parsed = JSON.parse(out.stdout);
      const id1 = parsed.documents['foo-bar.md']?.id;
      const id2 = parsed.documents['foo--bar.md']?.id;
      assert.notEqual(id1, id2);
      assert.ok(id1 === 'foo-bar' || id2 === 'foo-bar');
      assert.ok(id1 === 'foo-bar-2' || id2 === 'foo-bar-2');
    } finally {
      dir.cleanup();
    }
  });

  it('skips documents that already have front matter metadata', () => {
    const dir = scratchDir();
    try {
      writeFileSync(join(dir.root, 'mdlineage.config.yaml'), 'configVersion: 1\n');
      writeFileSync(
        join(dir.root, 'with-fm.md'),
        '---\nmdlineage:\n  schema: 1\n  id: has.fm\n  kind: guide\n  status: active\n---\n# With FM\n',
      );
      writeFileSync(join(dir.root, 'no-fm.md'), '# No FM\n');

      const out = runCli(['manifest', 'seed', '--json'], dir.root);
      assert.equal(out.status, 0);
      const parsed = JSON.parse(out.stdout);
      assert.equal(parsed.documents['with-fm.md'], undefined);
      assert.ok(parsed.documents['no-fm.md']);
    } finally {
      dir.cleanup();
    }
  });

  it('refuses execution when run from subdirectory where CWD != configDir (exit 2)', () => {
    const dir = scratchDir();
    try {
      writeFileSync(join(dir.root, 'mdlineage.config.yaml'), 'configVersion: 1\n');
      const sub = join(dir.root, 'sub');
      mkdirSync(sub);
      writeFileSync(join(sub, 'a.md'), '# Sub Doc\n');

      const out = runCli(['manifest', 'seed'], sub);
      assert.equal(out.status, 2);
      assert.match(out.stderr, /manifest seed must be run from the configuration directory/);
    } finally {
      dir.cleanup();
    }
  });

  it('regression: seed --write followed by check produces 0 diagnostics', () => {
    const dir = scratchDir();
    try {
      writeFileSync(
        join(dir.root, 'mdlineage.config.yaml'),
        'configVersion: 1\nmanifestFile: mdlineage.manifest.yaml\nmetadata:\n  required: true\n',
      );
      writeFileSync(join(dir.root, 'mdlineage.manifest.yaml'), 'version: 1\ndocuments: {}\n');
      writeFileSync(join(dir.root, 'a.md'), '# Doc A\n\nContent for A.\n');
      writeFileSync(join(dir.root, 'b.md'), '# Doc B\n\nContent for B.\n');
      writeFileSync(join(dir.root, 'my_file.md'), '# My File\n');
      writeFileSync(join(dir.root, 'a__b--c.md'), '# ABC\n');
      mkdirSync(join(dir.root, 'foo'));
      writeFileSync(join(dir.root, 'foo/中文.md'), '# Chinese\n');

      const seedOut = runCli(['manifest', 'seed', '--write'], dir.root);
      assert.equal(seedOut.status, 0);

      const checkOut = runCli(['check', '.'], dir.root);
      assert.equal(checkOut.status, 0, `Expected exit 0, got ${checkOut.status}; stderr: ${checkOut.stderr}`);
      assert.match(checkOut.stdout, /5 files checked, no diagnostics/);
    } finally {
      dir.cleanup();
    }
  });

  it('vocabulary-aware seed: uses custom kinds and statuses', () => {
    const dir = scratchDir();
    try {
      writeFileSync(
        join(dir.root, 'mdlineage.config.yaml'),
        [
          'configVersion: 1',
          'vocabulary:',
          '  kinds:',
          '    - guide',
          '  statuses:',
          '    - draft',
          '    - deprecated',
        ].join('\n'),
      );
      writeFileSync(join(dir.root, 'doc.md'), '# Custom doc\n');

      const out = runCli(['manifest', 'seed', '--json'], dir.root);
      assert.equal(out.status, 0);
      const parsed = JSON.parse(out.stdout);
      assert.ok(parsed.documents['doc.md']);
      assert.equal(parsed.documents['doc.md'].kind, 'guide');
      assert.equal(parsed.documents['doc.md'].status, 'draft');
    } finally {
      dir.cleanup();
    }
  });
});
