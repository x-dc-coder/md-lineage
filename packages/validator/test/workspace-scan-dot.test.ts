import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig, scanWorkspaceUniverse } from '../src/index.js';

test('scanWorkspaceUniverse — dot entries are not workspace content', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mdl-scan-dot-'));
  t.after(() => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  // root/
  //   docs/a.md
  //   .rivet/backups/<ts>/docs/a.md   (a snapshot of the same document)
  //   .git/config
  //   .hidden.md
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, 'docs', 'a.md'), '# a\n');
  mkdirSync(join(root, '.rivet', 'backups', '1', 'docs'), { recursive: true });
  writeFileSync(join(root, '.rivet', 'backups', '1', 'docs', 'a.md'), '# a\n');
  mkdirSync(join(root, '.git'), { recursive: true });
  writeFileSync(join(root, '.git', 'config'), 'x\n');
  writeFileSync(join(root, '.hidden.md'), '# hidden\n');

  const result = scanWorkspaceUniverse(root, defaultConfig());

  assert.equal(result.documents.has('docs/a.md'), true, 'real content is still discovered');
  assert.equal(
    result.documents.has('.rivet/backups/1/docs/a.md'),
    false,
    'a backup snapshot is not a second document (it would claim the same id)',
  );
  assert.equal(result.documents.has('.hidden.md'), false, 'a dot file is not workspace content');
  assert.equal(result.knownPaths.includes('.git/config'), false, 'the VCS directory is not a link target');
});
