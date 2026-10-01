import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  classifyDestination,
  resolveHostPath,
  checkHostLink,
  defaultConfig,
  createWorkspaceIndex,
  validateWorkspace,
} from '../src/index.js';

describe('classifyDestination', () => {
  it('classifies external URLs correctly', () => {
    assert.equal(classifyDestination('https://example.com/foo'), 'external-url');
    assert.equal(classifyDestination('http://localhost:8080'), 'external-url');
    assert.equal(classifyDestination('mailto:user@example.com'), 'external-url');
    assert.equal(classifyDestination('ftp://files.example.com'), 'external-url');
  });

  it('classifies home-relative paths correctly', () => {
    assert.equal(classifyDestination('~'), 'home-relative');
    assert.equal(classifyDestination('~/docs/foo.md'), 'home-relative');
    assert.equal(classifyDestination('~\\docs\\foo.md'), 'home-relative');
    assert.equal(classifyDestination('$HOME'), 'home-relative');
    assert.equal(classifyDestination('$HOME/docs/foo.md'), 'home-relative');
    assert.equal(classifyDestination('$HOME\\docs\\foo.md'), 'home-relative');
  });

  it('classifies host-absolute paths correctly', () => {
    assert.equal(classifyDestination('/etc/hosts'), 'host-absolute');
    assert.equal(classifyDestination('/var/log/app.log'), 'host-absolute');
    assert.equal(classifyDestination('C:\\Windows\\notepad.exe', 'win32'), 'host-absolute');
    assert.equal(classifyDestination('D:/data/repo', 'win32'), 'host-absolute');
    assert.equal(classifyDestination('\\\\server\\share\\file', 'win32'), 'host-absolute');
  });

  it('classifies workspace-relative paths correctly', () => {
    assert.equal(classifyDestination('docs/readme.md'), 'workspace-relative');
    assert.equal(classifyDestination('./docs/readme.md'), 'workspace-relative');
    assert.equal(classifyDestination('../sibling/readme.md'), 'workspace-relative');
    assert.equal(classifyDestination('readme.md'), 'workspace-relative');
  });
});

describe('resolveHostPath', () => {
  it('resolves home-relative paths with custom homeDir', () => {
    const fakeHome = '/home/testuser';
    assert.equal(resolveHostPath('~', fakeHome), '/home/testuser');
    assert.equal(resolveHostPath('$HOME', fakeHome), '/home/testuser');
    assert.equal(resolveHostPath('~/file.txt', fakeHome), '/home/testuser/file.txt');
    assert.equal(resolveHostPath('$HOME/nested/file.txt', fakeHome), '/home/testuser/nested/file.txt');
  });

  it('resolves host-absolute paths as normalized paths', () => {
    assert.equal(resolveHostPath('/var/log/../log/syslog'), '/var/log/syslog');
  });
});

describe('checkHostLink & policy', () => {
  let tempDir: string;
  let fakeHome: string;
  let fakeRepo: string;
  let fileInHome: string;
  let fileInRepo: string;

  before(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'mdl-hostlinks-test-'));
    fakeHome = join(tempDir, 'fakehome');
    fakeRepo = join(tempDir, 'repo');

    mkdirSync(fakeHome, { recursive: true });
    mkdirSync(join(fakeRepo, 'docs'), { recursive: true });

    fileInHome = join(fakeHome, 'homefile.md');
    fileInRepo = join(fakeRepo, 'docs', 'repofile.md');

    writeFileSync(fileInHome, '# Home File');
    writeFileSync(fileInRepo, '# Repo File');
  });

  after(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('returns null for workspace-relative and external destinations', () => {
    const config = defaultConfig();
    assert.equal(checkHostLink('docs/foo.md', fakeRepo, config, fakeHome), null);
    assert.equal(checkHostLink('https://example.com', fakeRepo, config, fakeHome), null);
  });

  it('policy: forbidden produces MDL403 error regardless of physical existence', () => {
    const config = {
      ...defaultConfig(),
      links: { expandTilde: true, allowHostPaths: 'forbidden' as const },
    };
    const res = checkHostLink('~/homefile.md', fakeRepo, config, fakeHome);
    assert.ok(res?.isHostLink);
    assert.equal(res?.diagnostic?.code, 'MDL403');
    assert.equal(res?.diagnostic?.severity, 'error');
    assert.match(res?.diagnostic?.message ?? '', /Host path forbidden by policy/);
  });

  it('non-existent host path reports MDL403 warning', () => {
    const config = defaultConfig();
    const res = checkHostLink('~/does-not-exist.md', fakeRepo, config, fakeHome);
    assert.ok(res?.isHostLink);
    assert.equal(res?.diagnostic?.code, 'MDL403');
    assert.equal(res?.diagnostic?.severity, 'warning');
    assert.match(res?.diagnostic?.message ?? '', /Host path does not exist on this machine/);
  });

  it('host path inside workspace suggests portable relative link', () => {
    const config = defaultConfig();
    const res = checkHostLink(fileInRepo, fakeRepo, config, fakeHome);
    assert.ok(res?.isHostLink);
    assert.equal(res?.diagnostic?.code, 'MDL403');
    assert.equal(res?.diagnostic?.severity, 'warning');
    assert.match(res?.diagnostic?.message ?? '', /suggest portable relative link: docs\/repofile.md/);
    assert.equal(res?.diagnostic?.data?.suggestion, 'docs/repofile.md');
  });

  it('existing external host path with allowHostPaths: "always" returns no diagnostic', () => {
    const config = {
      ...defaultConfig(),
      links: { expandTilde: true, allowHostPaths: 'always' as const },
    };
    const res = checkHostLink('~/homefile.md', fakeRepo, config, fakeHome);
    assert.ok(res?.isHostLink);
    assert.equal(res?.diagnostic, undefined);
  });

  it('existing external host path with allowHostPaths: "warning" reports MDL403 warning', () => {
    const config = {
      ...defaultConfig(),
      links: { expandTilde: true, allowHostPaths: 'warning' as const },
    };
    const res = checkHostLink('~/homefile.md', fakeRepo, config, fakeHome);
    assert.ok(res?.isHostLink);
    assert.equal(res?.diagnostic?.code, 'MDL403');
    assert.equal(res?.diagnostic?.severity, 'warning');
    assert.match(res?.diagnostic?.message ?? '', /Host path is not portable across machines/);
  });

  it('end-to-end validateWorkspace reports MDL403 without reporting MDL401', () => {
    const docWithHostLinks = [
      '---',
      'mdlineage:',
      '  schema: 1',
      '  id: docs.host-links',
      '  kind: guide',
      '  status: active',
      '---',
      '',
      `See [home doc](~/homefile.md) and [abs missing](/nonexistent/path/doc.md).`,
    ].join('\n');

    const config = {
      ...defaultConfig(),
      links: { expandTilde: true, allowHostPaths: 'warning' as const },
    };

    const files = new Map([['docs/guide.md', docWithHostLinks]]);
    const index = createWorkspaceIndex(files, config);
    const diags = validateWorkspace(index, { root: fakeRepo });

    const mdl401s = diags.filter((d) => d.code === 'MDL401');
    const mdl403s = diags.filter((d) => d.code === 'MDL403');

    // MDL401 should NOT be produced for either host link
    assert.equal(mdl401s.length, 0, 'No MDL401 should be reported for host-style links');
    // Both host links should produce MDL403
    assert.equal(mdl403s.length, 2, 'Two MDL403 diagnostics expected');
  });
});

