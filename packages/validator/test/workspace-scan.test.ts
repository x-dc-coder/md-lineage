import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig, scanWorkspaceUniverse } from '../src/index.js';

test('scanWorkspaceUniverse — symbolic link handling', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mdl-scan-test-'));

  t.after(() => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  // Setup directory structure
  // root/
  //   real/
  //     sub/
  //       a.md
  //       b.txt
  //   link-dir -> real
  //   broken-link -> nonexistent
  //   cycleA/ -> cycleB
  //   cycleB/ -> cycleA
  const realDir = join(root, 'real');
  const realSub = join(realDir, 'sub');
  mkdirSync(realSub, { recursive: true });
  writeFileSync(join(realSub, 'a.md'), '# Doc A\n\nContent of A');
  writeFileSync(join(realSub, 'b.txt'), 'Plain text');

  // Symlink to directory
  symlinkSync(realDir, join(root, 'link-dir'), 'dir');

  // Broken symlink
  symlinkSync(join(root, 'nonexistent'), join(root, 'broken-link'));

  // Cycle: cycle1 contains a symlink to cycle2, cycle2 contains a symlink to cycle1
  const cycle1 = join(root, 'cycle1');
  const cycle2 = join(root, 'cycle2');
  mkdirSync(cycle1, { recursive: true });
  mkdirSync(cycle2, { recursive: true });
  symlinkSync(cycle2, join(cycle1, 'to-cycle2'), 'dir');
  symlinkSync(cycle1, join(cycle2, 'to-cycle1'), 'dir');

  await t.test('multi-level symlink sub-directory file discovery', () => {
    const config = defaultConfig();
    const result = scanWorkspaceUniverse(root, config);

    // Both real and projected symlink paths should be discovered
    assert.equal(result.documents.has('real/sub/a.md'), true);
    assert.equal(result.documents.has('link-dir/sub/a.md'), true);
    assert.equal(result.documents.get('link-dir/sub/a.md'), '# Doc A\n\nContent of A');

    // Known paths should contain non-md files and directories in both forms
    assert.equal(result.knownPaths.includes('real/sub/b.txt'), true);
    assert.equal(result.knownPaths.includes('link-dir/sub/b.txt'), true);
    assert.equal(result.knownPaths.includes('link-dir'), true);
    assert.equal(result.knownPaths.includes('link-dir/'), true);
    assert.equal(result.knownPaths.includes('link-dir/sub'), true);
    assert.equal(result.knownPaths.includes('link-dir/sub/'), true);
  });

  await t.test('symlink loop / cycle interception', () => {
    const config = defaultConfig();
    // Should terminate gracefully and not infinite loop or crash
    const result = scanWorkspaceUniverse(root, config);
    assert.ok(result);
  });

  await t.test('broken symlink handling', () => {
    const config = defaultConfig();
    const result = scanWorkspaceUniverse(root, config);
    // Broken link shouldn't cause an error or appear as valid document
    assert.equal(result.documents.has('broken-link'), false);
    assert.equal(result.knownPaths.includes('broken-link'), false);
  });

  await t.test('followSymlinks: false ignores symlinks', () => {
    const config = {
      ...defaultConfig(),
      files: {
        ...defaultConfig().files,
        followSymlinks: false,
      },
    };
    const result = scanWorkspaceUniverse(root, config);
    assert.equal(result.documents.has('real/sub/a.md'), true);
    assert.equal(result.documents.has('link-dir/sub/a.md'), false);
    assert.equal(result.knownPaths.includes('link-dir'), false);
  });

  await t.test('symlinkMaxDepth limits depth of traversal', () => {
    // Chain: dir0 -> dir1 -> dir2 -> dir3 with doc.md
    const chainRoot = join(root, 'chain');
    const targetDir = join(chainRoot, 'target');
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, 'deep.md'), '# Deep');

    const hop1 = join(chainRoot, 'hop1');
    mkdirSync(hop1, { recursive: true });
    symlinkSync(targetDir, join(hop1, 'next'), 'dir');

    const hop2 = join(chainRoot, 'hop2');
    mkdirSync(hop2, { recursive: true });
    symlinkSync(hop1, join(hop2, 'next'), 'dir');

    // depth 1 allows 1 traversal
    const configDepth0 = {
      ...defaultConfig(),
      files: {
        ...defaultConfig().files,
        symlinkMaxDepth: 0,
      },
    };
    const res0 = scanWorkspaceUniverse(chainRoot, configDepth0);
    assert.equal(res0.documents.has('target/deep.md'), true);
    assert.equal(res0.documents.has('hop1/next/deep.md'), false);

    const configDepth1 = {
      ...defaultConfig(),
      files: {
        ...defaultConfig().files,
        symlinkMaxDepth: 1,
      },
    };
    const res1 = scanWorkspaceUniverse(chainRoot, configDepth1);
    assert.equal(res1.documents.has('hop1/next/deep.md'), true);
    // hop2 -> hop1 is depth 1, hop1 -> target would be depth 2, which exceeds symlinkMaxDepth 1
    assert.equal(res1.documents.has('hop2/next/next/deep.md'), false);
  });
});
