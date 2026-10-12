/**
 * isInTreeRealpath tests (Issue #3 review round 1, A1): the retrieval corpus
 * must not follow symlinks out of the workspace it reports paths against.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isInTreeRealpath } from '../src/index.js';

function setup(): { workspace: string; outside: string } {
  const workspace = mkdtempSync(join(tmpdir(), 'mdl-tree-guard-'));
  const outside = mkdtempSync(join(tmpdir(), 'mdl-tree-guard-out-'));
  mkdirSync(join(workspace, 'docs'), { recursive: true });
  writeFileSync(join(workspace, 'docs', 'real.md'), '# Real\n');
  writeFileSync(join(outside, 'secret.md'), '# Secret\n');
  // In-tree symlink: docs/inside.md -> docs/real.md stays eligible.
  symlinkSync(join(workspace, 'docs', 'real.md'), join(workspace, 'docs', 'inside.md'));
  // Out-of-tree symlink: the leak A1 is about.
  symlinkSync(join(outside, 'secret.md'), join(workspace, 'docs', 'link.md'));
  // Out-of-tree directory symlink.
  symlinkSync(outside, join(workspace, 'external'));
  // Broken symlink.
  symlinkSync(join(outside, 'nowhere.md'), join(workspace, 'docs', 'broken.md'));
  return { workspace, outside };
}

test('isInTreeRealpath — real files and in-tree symlinks stay in the corpus', () => {
  const { workspace } = setup();
  try {
    assert.equal(isInTreeRealpath(workspace, 'docs/real.md'), true);
    assert.equal(isInTreeRealpath(workspace, 'docs/inside.md'), true);
    assert.equal(isInTreeRealpath(workspace, 'README.md'), false); // does not exist
  } finally {
    cleanup(workspace);
  }
});

test('isInTreeRealpath — out-of-tree and broken symlinks are rejected', () => {
  const { workspace } = setup();
  try {
    assert.equal(isInTreeRealpath(workspace, 'docs/link.md'), false);
    assert.equal(isInTreeRealpath(workspace, 'docs/broken.md'), false);
    // A document under a symlinked directory that lands outside the root.
    assert.equal(isInTreeRealpath(workspace, 'external/secret.md'), false);
  } finally {
    cleanup(workspace);
  }
});

test('isInTreeRealpath — sibling directories sharing a prefix never match', () => {
  const { workspace, outside } = setup();
  try {
    // /tmp/mdl-tree-guard-X vs /tmp/mdl-tree-guard-out-Y: a plain string
    // prefix must not be confused with containment.
    const sibling = mkdtempSync(join(tmpdir(), 'mdl-tree-guard-'));
    try {
      assert.ok(sibling.startsWith(join(tmpdir(), 'mdl-tree-guard-')));
      assert.notEqual(sibling, workspace);
      writeFileSync(join(sibling, 'peer.md'), '# Peer\n');
      symlinkSync(join(sibling, 'peer.md'), join(workspace, 'docs', 'peer.md'));
      assert.equal(isInTreeRealpath(workspace, 'docs/peer.md'), false);
    } finally {
      rmSync(sibling, { recursive: true, force: true });
    }
    assert.notEqual(outside, workspace);
  } finally {
    cleanup(workspace);
    rmSync(outside, { recursive: true, force: true });
  }
});

function cleanup(workspace: string): void {
  rmSync(workspace, { recursive: true, force: true });
}
