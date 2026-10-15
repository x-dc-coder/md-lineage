import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  defaultConfig,
  defaultConfigIsValid,
  validateConfigSchema,
  loadConfig,
  configToSchema,
  resolveFederations,
  FEDERATION_SCOPE_PATTERN,
  createWorkspaceIndex,
  createFederatedIndex,
  applyExternalScopePolicy,
  updateFile,
  resolveLinkPath,
} from '../src/index.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateWorkspace } from '../src/workspace-validator.js';

describe('Federation configuration (Phase 1)', () => {
  it('case 1: tmpdir config with federation member loads cleanly and round-trips via configToSchema', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mdl-fed-test-'));
    try {
      const skillsDir = join(tmp, 'skills');
      mkdirSync(skillsDir, { recursive: true });

      const configFile = join(tmp, 'mdlineage.config.yaml');
      writeFileSync(
        configFile,
        `configVersion: 1
federations:
  skills:
    local:
      path: ./skills
`,
        'utf8'
      );

      const loaded = loadConfig(configFile);
      assert.equal(loaded.diagnostics.length, 0, 'No diagnostics on valid federation declaration');
      assert.ok(loaded.config.federations.has('skills'), 'federations map has skills');

      const skills = loaded.config.federations.get('skills');
      assert.ok(skills);
      assert.equal(skills.localPath, './skills');
      assert.equal(skills.missing, 'warn', 'default missing should be warn');
      assert.deepEqual(skills.include, ['**/*.md'], 'default include should be [**/*.md]');
      assert.equal(skills.trust, 'readonly', 'default trust should be readonly');

      // Round-trip through configToSchema
      const schemaProj = configToSchema(loaded.config);
      assert.ok(typeof schemaProj === 'object' && schemaProj !== null);
      assert.ok('federations' in schemaProj);
      assert.equal(validateConfigSchema(schemaProj), true, 'configToSchema projection satisfies config schema');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('case 2: invalid trust or invalid scope name is rejected by schema with MDL900', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mdl-fed-test-'));
    try {
      // 2a: trust: full is invalid
      const cfgFull = join(tmp, 'bad-trust.yaml');
      writeFileSync(
        cfgFull,
        `configVersion: 1
federations:
  skills:
    local:
      path: ./skills
    trust: full
`,
        'utf8'
      );
      const resBadTrust = loadConfig(cfgFull);
      assert.ok(resBadTrust.diagnostics.some((d) => d.code === 'MDL900'), 'trust: full produces MDL900');
      assert.equal(resBadTrust.config.federations.size, 0, 'bad config falls back to defaultConfig');

      // 2b: reserved scope name 'home'
      const cfgHome = join(tmp, 'bad-scope.yaml');
      writeFileSync(
        cfgHome,
        `configVersion: 1
federations:
  home:
    local:
      path: ./skills
`,
        'utf8'
      );
      const resBadScope = loadConfig(cfgHome);
      assert.ok(resBadScope.diagnostics.some((d) => d.code === 'MDL900'), 'scope "home" produces MDL900');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('case 18: defaultConfigIsValid() remains true (federations omitted when empty)', () => {
    assert.equal(defaultConfig().federations.size, 0);
    assert.equal(defaultConfigIsValid(), true);
  });

  it('case 19: FEDERATION_SCOPE_PATTERN stays in sync with config schema regex', () => {
    const here = resolve(fileURLToPath(import.meta.url), '..');
    const schemaPath = resolve(here, '..', '..', '..', 'schemas', 'mdlineage-config.schema.json');
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as {
      properties?: {
        federations?: {
          propertyNames?: {
            pattern?: string;
          };
        };
      };
    };
    const schemaPattern = schema.properties?.federations?.propertyNames?.pattern;
    assert.ok(schemaPattern, 'schema defines federations.propertyNames.pattern');
    assert.equal(FEDERATION_SCOPE_PATTERN.source, schemaPattern);
  });

  it('case 3: cycle detection H -> A -> B -> A reports MDL901 error with chain', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mdl-fed-test-'));
    try {
      const homeDir = join(tmp, 'home');
      const aDir = join(tmp, 'member-a');
      const bDir = join(tmp, 'member-b');
      mkdirSync(homeDir, { recursive: true });
      mkdirSync(aDir, { recursive: true });
      mkdirSync(bDir, { recursive: true });

      const homeCfg = join(homeDir, 'mdlineage.config.yaml');
      writeFileSync(homeCfg, `configVersion: 1\nfederations:\n  a:\n    local:\n      path: ../member-a\n`, 'utf8');

      const aCfg = join(aDir, 'mdlineage.config.yaml');
      writeFileSync(aCfg, `configVersion: 1\nfederations:\n  b:\n    local:\n      path: ../member-b\n`, 'utf8');

      const bCfg = join(bDir, 'mdlineage.config.yaml');
      writeFileSync(bCfg, `configVersion: 1\nfederations:\n  a:\n    local:\n      path: ../member-a\n`, 'utf8');

      const loaded = loadConfig(homeCfg);
      const res = resolveFederations(loaded.config, homeDir);
      assert.equal(res.federation, null, 'Cycle refuses run, federation is null');
      const mdl901 = res.diagnostics.find((d) => d.code === 'MDL901');
      assert.ok(mdl901, 'Produces MDL901');
      assert.equal(mdl901.severity, 'error');
      assert.ok(mdl901.message.includes('Circular federations'));
      assert.ok(mdl901.message.includes('→'));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('case 4: missing member with missing: error reports MDL902 error and federation is null', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mdl-fed-test-'));
    try {
      const homeDir = join(tmp, 'home');
      mkdirSync(homeDir, { recursive: true });
      const homeCfg = join(homeDir, 'mdlineage.config.yaml');
      writeFileSync(homeCfg, `configVersion: 1\nfederations:\n  missing:\n    local:\n      path: ../no-such-repo\n    missing: error\n`, 'utf8');

      const loaded = loadConfig(homeCfg);
      const res = resolveFederations(loaded.config, homeDir);
      assert.equal(res.federation, null);
      const mdl902 = res.diagnostics.find((d) => d.code === 'MDL902');
      assert.ok(mdl902);
      assert.equal(mdl902.severity, 'error');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('case 5: missing member with missing: warn (default) reports MDL902 warning and skips member', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mdl-fed-test-'));
    try {
      const homeDir = join(tmp, 'home');
      const aDir = join(tmp, 'member-a');
      mkdirSync(homeDir, { recursive: true });
      mkdirSync(aDir, { recursive: true });

      const homeCfg = join(homeDir, 'mdlineage.config.yaml');
      writeFileSync(homeCfg, `configVersion: 1\nfederations:\n  a:\n    local:\n      path: ../member-a\n  missing:\n    local:\n      path: ../no-such-repo\n`, 'utf8');

      const loaded = loadConfig(homeCfg);
      const res = resolveFederations(loaded.config, homeDir);
      assert.ok(res.federation);
      assert.equal(res.federation.members.length, 1);
      assert.equal(res.federation.members[0]?.scope, 'a');
      const mdl902 = res.diagnostics.find((d) => d.code === 'MDL902');
      assert.ok(mdl902);
      assert.equal(mdl902.severity, 'warning');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('case 6: symlink alias collision reports MDL903', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mdl-fed-test-'));
    try {
      const homeDir = join(tmp, 'home');
      const aDir = join(tmp, 'member-a');
      const bSymlink = join(tmp, 'member-b');
      mkdirSync(homeDir, { recursive: true });
      mkdirSync(aDir, { recursive: true });
      try {
        symlinkSync(aDir, bSymlink, 'dir');
      } catch {
        // Skip if symlinks not permitted in environment
        return;
      }

      const homeCfg = join(homeDir, 'mdlineage.config.yaml');
      writeFileSync(homeCfg, `configVersion: 1\nfederations:\n  a:\n    local:\n      path: ../member-a\n  b:\n    local:\n      path: ../member-b\n`, 'utf8');

      const loaded = loadConfig(homeCfg);
      const res = resolveFederations(loaded.config, homeDir);
      assert.equal(res.federation, null);
      const mdl903 = res.diagnostics.find((d) => d.code === 'MDL903');
      assert.ok(mdl903);
      assert.equal(mdl903.severity, 'error');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('case 7: alias collides with home top-level directory reports MDL903', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mdl-fed-test-'));
    try {
      const homeDir = join(tmp, 'home');
      const docsDir = join(homeDir, 'docs');
      const extDocs = join(tmp, 'docs');
      mkdirSync(docsDir, { recursive: true });
      mkdirSync(extDocs, { recursive: true });

      const homeCfg = join(homeDir, 'mdlineage.config.yaml');
      writeFileSync(homeCfg, `configVersion: 1\nfederations:\n  ext:\n    local:\n      path: ../docs\n`, 'utf8');

      const loaded = loadConfig(homeCfg);
      const res = resolveFederations(loaded.config, homeDir);
      assert.equal(res.federation, null);
      const mdl903 = res.diagnostics.find((d) => d.code === 'MDL903');
      assert.ok(mdl903);
      assert.equal(mdl903.severity, 'error');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('case 8: transitive adoption H -> A -> B succeeds without diagnostics', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mdl-fed-test-'));
    try {
      const homeDir = join(tmp, 'home');
      const aDir = join(tmp, 'member-a');
      const bDir = join(tmp, 'member-b');
      mkdirSync(homeDir, { recursive: true });
      mkdirSync(aDir, { recursive: true });
      mkdirSync(bDir, { recursive: true });

      const homeCfg = join(homeDir, 'mdlineage.config.yaml');
      writeFileSync(homeCfg, `configVersion: 1\nfederations:\n  a:\n    local:\n      path: ../member-a\n`, 'utf8');

      const aCfg = join(aDir, 'mdlineage.config.yaml');
      writeFileSync(aCfg, `configVersion: 1\nfederations:\n  b:\n    local:\n      path: ../member-b\n`, 'utf8');

      const loaded = loadConfig(homeCfg);
      const res = resolveFederations(loaded.config, homeDir);
      assert.equal(res.diagnostics.length, 0);
      assert.ok(res.federation);
      assert.equal(res.federation.members.length, 2);
      assert.equal(res.federation.members[0]?.scope, 'a');
      assert.equal(res.federation.members[1]?.scope, 'b');
      assert.equal(res.federation.members[0]?.alias, 'member-a');
      assert.equal(res.federation.members[1]?.alias, 'member-b');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('case 9: diamond federation H->A, H->B, A->C, B->C dedups C with no cycle report', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mdl-fed-test-'));
    try {
      const homeDir = join(tmp, 'home');
      const aDir = join(tmp, 'member-a');
      const bDir = join(tmp, 'member-b');
      const cDir = join(tmp, 'member-c');
      mkdirSync(homeDir, { recursive: true });
      mkdirSync(aDir, { recursive: true });
      mkdirSync(bDir, { recursive: true });
      mkdirSync(cDir, { recursive: true });

      const homeCfg = join(homeDir, 'mdlineage.config.yaml');
      writeFileSync(
        homeCfg,
        `configVersion: 1\nfederations:\n  a:\n    local:\n      path: ../member-a\n  b:\n    local:\n      path: ../member-b\n`,
        'utf8'
      );

      const aCfg = join(aDir, 'mdlineage.config.yaml');
      writeFileSync(aCfg, `configVersion: 1\nfederations:\n  c:\n    local:\n      path: ../member-c\n`, 'utf8');

      const bCfg = join(bDir, 'mdlineage.config.yaml');
      writeFileSync(bCfg, `configVersion: 1\nfederations:\n  c:\n    local:\n      path: ../member-c\n`, 'utf8');

      const loaded = loadConfig(homeCfg);
      const res = resolveFederations(loaded.config, homeDir);
      assert.equal(res.diagnostics.length, 0);
      assert.ok(res.federation);
      const cMembers = res.federation.members.filter((m) => m.scope === 'c');
      assert.equal(cMembers.length, 1, 'C appears exactly once in DFS pre-order');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('case 10: federated proxy exposes merged paths() with scoped coordinates and correct size', () => {
    const config = defaultConfig();
    const home = createWorkspaceIndex(
      {
        'docs/a.md': '---\nmdlineage:\n  id: docs.a\n  kind: guide\n  status: active\n---\n# Home A\n',
      },
      config
    );
    const member = createWorkspaceIndex(
      {
        'docs/x.md': '---\nmdlineage:\n  id: docs.x\n  kind: guide\n  status: active\n---\n# Member X\n',
      },
      config
    );

    const mounts = new Map([
      ['member-a', { scope: 'member-a', index: member, alias: 'member-a' }],
    ]);
    const proxy = createFederatedIndex(home, mounts);

    assert.equal(proxy.size, 2);
    assert.deepEqual([...proxy.paths()], ['docs/a.md', '@member-a//docs/x.md']);

    const entry = proxy.entryOf('@member-a//docs/x.md');
    assert.ok(entry);
    assert.equal(entry.path, '@member-a//docs/x.md');
  });

  it('case 11: alias resolution works for knowsPath and entryOf', () => {
    const config = defaultConfig();
    const home = createWorkspaceIndex(
      {
        'docs/a.md': '---\nmdlineage:\n  id: docs.a\n  kind: guide\n  status: active\n---\n# Home A\n',
      },
      config
    );
    const member = createWorkspaceIndex(
      {
        'docs/x.md': '---\nmdlineage:\n  id: docs.x\n  kind: guide\n  status: active\n---\n# Member X\n',
      },
      config,
      new Set(['docs/x.md', 'assets/logo.png'])
    );

    const mounts = new Map([
      ['member-a', { scope: 'member-a', index: member, alias: 'member-a' }],
    ]);
    const proxy = createFederatedIndex(home, mounts);

    assert.equal(proxy.knowsPath('member-a/docs/x.md'), true);
    assert.equal(proxy.knowsPath('member-a/assets/logo.png'), true);
    assert.equal(proxy.knowsPath('docs/a.md'), true);
    assert.equal(proxy.knowsPath('member-a/missing.md'), false);

    const entry = proxy.entryOf('member-a/docs/x.md');
    assert.ok(entry);
    assert.equal(entry.path, '@member-a//docs/x.md');
    assert.notEqual(entry.path, '@undefined//docs/x.md', 'entry.path must use member scope, never @undefined//');
  });

  it('case 12: home repository entry takes priority over member alias collision', () => {
    const config = defaultConfig();
    const home = createWorkspaceIndex(
      {
        'member-a/toplevel.md': '---\nmdlineage:\n  id: home.toplevel\n  kind: guide\n  status: active\n---\n# Home Top\n',
      },
      config
    );
    const member = createWorkspaceIndex(
      {
        'toplevel.md': '---\nmdlineage:\n  id: member.toplevel\n  kind: guide\n  status: active\n---\n# Member Top\n',
      },
      config
    );

    const mounts = new Map([
      ['member-a', { scope: 'member-a', index: member, alias: 'member-a' }],
    ]);
    const proxy = createFederatedIndex(home, mounts);

    const entry = proxy.entryOf('member-a/toplevel.md');
    assert.ok(entry);
    assert.equal(entry.id, 'home.toplevel', 'Home entry wins over member entry');
  });

  it('case 13: bare id referencing member target from home relations produces MDL302', () => {
    const config = defaultConfig();
    const home = createWorkspaceIndex(
      {
        'docs/a.md': `---
mdlineage:
  id: docs.a
  kind: guide
  status: active
  relations:
    - type: depends_on
      target: docs.x
      reason: cross-repo bare id test
---
# Home Doc
`,
      },
      config
    );
    const member = createWorkspaceIndex(
      {
        'docs/x.md': '---\nmdlineage:\n  id: docs.x\n  kind: guide\n  status: active\n---\n# Member Doc\n',
      },
      config
    );

    const mounts = new Map([
      ['member-a', { scope: 'member-a', index: member, alias: 'member-a' }],
    ]);
    const proxy = createFederatedIndex(home, mounts);
    const diags = validateWorkspace(proxy);

    // Bare id docs.x should NOT resolve across workspace boundary -> MDL302 error
    const mdl302 = diags.find((d) => d.code === 'MDL302');
    assert.ok(mdl302, 'Home doc gets MDL302 for bare member id reference');
    assert.equal(mdl302.path, 'docs/a.md');
  });

  it('case 14: relative markdown link resolving via alias produces no MDL401', () => {
    const config = defaultConfig();
    const home = createWorkspaceIndex(
      {
        'docs/a.md': `---
mdlineage:
  id: docs.a
  kind: guide
  status: active
---
Link to [skills](../member-a/docs/x.md).
`,
      },
      config
    );
    const member = createWorkspaceIndex(
      {
        'docs/x.md': '---\nmdlineage:\n  id: docs.x\n  kind: guide\n  status: active\n---\n# Skills\n',
      },
      config
    );

    const mounts = new Map([
      ['member-a', { scope: 'member-a', index: member, alias: 'member-a' }],
    ]);
    const proxy = createFederatedIndex(home, mounts);
    const diags = validateWorkspace(proxy);

    const mdl401 = diags.find((d) => d.code === 'MDL401');
    assert.equal(mdl401, undefined, 'No MDL401 when cross-repo link resolves via alias');
  });

  it('case 15: duplicate ids within member repository trigger MDL301 scoped to member', () => {
    const config = defaultConfig();
    const home = createWorkspaceIndex(
      {
        'docs/home.md': '---\nmdlineage:\n  id: docs.home\n  kind: guide\n  status: active\n---\n# Home\n',
      },
      config
    );
    const member = createWorkspaceIndex(
      {
        'docs/m1.md': '---\nmdlineage:\n  id: docs.dup\n  kind: guide\n  status: active\n---\n# M1\n',
        'docs/m2.md': '---\nmdlineage:\n  id: docs.dup\n  kind: guide\n  status: active\n---\n# M2\n',
      },
      config
    );

    const mounts = new Map([
      ['member-a', { scope: 'member-a', index: member, alias: 'member-a' }],
    ]);
    const proxy = createFederatedIndex(home, mounts);
    const diags = validateWorkspace(proxy);

    const mdl301s = diags.filter((d) => d.code === 'MDL301');
    assert.equal(mdl301s.length, 1, 'Member duplicate id produces MDL301 on later claimant (canonical claimant wins)');
    assert.ok(mdl301s.every((d) => d.path.startsWith('@member-a//')));
  });

  it('case 16: applyExternalScopePolicy caps external error to warning and drops MDL5xx/MDL801', () => {
    const diags = [
      { path: 'docs/home.md', code: 'MDL305', severity: 'error' as const },
      { path: '@member-a//docs/x.md', code: 'MDL302', severity: 'error' as const },
      { path: '@member-a//docs/y.md', code: 'MDL502', severity: 'warning' as const },
      { path: '@member-a//docs/z.md', code: 'MDL801', severity: 'warning' as const },
      { path: 'docs/home.md', code: 'MDL801', severity: 'warning' as const },
    ];

    const filtered = applyExternalScopePolicy(diags);
    assert.equal(filtered.length, 3);
    assert.deepEqual(filtered, [
      { path: 'docs/home.md', code: 'MDL305', severity: 'error' },
      { path: '@member-a//docs/x.md', code: 'MDL302', severity: 'warning' },
      { path: 'docs/home.md', code: 'MDL801', severity: 'warning' },
    ]);
  });

  it('case 18: MDL404 inside a federated member — member-internal resolution, warning preserved', () => {
    const config = { ...defaultConfig(), links: { ...defaultConfig().links, codeFences: 'corpus' } };
    const home = createWorkspaceIndex(
      {
        // The home fence points INTO the member through the physical alias,
        // the same coordinate the link layer resolves (case 14).
        'docs/home.md': [
          '---',
          'mdlineage:',
          '  schema: 1',
          '  id: docs.home',
          '  kind: guide',
          '  status: active',
          '---',
          '',
          '```bash',
          'python member-a/scripts/exists.py',
          'python member-a/scripts/missing.py',
          '```',
          '',
        ].join('\n'),
      },
      config
    );
    const member = createWorkspaceIndex(
      {
        'docs/x.md': [
          '---',
          'mdlineage:',
          '  schema: 1',
          '  id: docs.x',
          '  kind: guide',
          '  status: active',
          '---',
          '',
          '```bash',
          'python scripts/exists.py',
          'python scripts/missing.py',
          '```',
          '',
        ].join('\n'),
        'scripts/exists.py': '#!/usr/bin/env python3\n',
      },
      config
    );

    // The member's own index (how the LSP routes member documents): the
    // existing member path resolves document-relatively, only the missing one
    // reports.
    const solo = validateWorkspace(member, { includeSingleDocument: false }).filter((d) => d.code === 'MDL404');
    assert.equal(solo.length, 1, 'member-internal existing path does not report in the member index');
    assert.equal(solo[0]!.path, 'docs/x.md');
    assert.equal(solo[0]!.data?.token, 'scripts/missing.py');

    const proxy = createFederatedIndex(home, new Map([['member-a', { scope: 'member-a', index: member, alias: 'member-a' }]]));
    const all = validateWorkspace(proxy, { includeSingleDocument: false });
    const home404 = all.filter((d) => d.code === 'MDL404' && d.path === 'docs/home.md');
    assert.equal(home404.length, 1, 'home fence to the missing member path reports once');
    assert.equal(home404[0]!.data?.token, 'member-a/scripts/missing.py');
    assert.equal(
      all.some((d) => d.code === 'MDL404' && d.data?.token === 'member-a/scripts/exists.py'),
      false,
      'home fence to the existing member path resolves via the alias and stays silent'
    );

    // MDL404 is link-layer: applyExternalScopePolicy neither drops it nor
    // alters its warning severity on external paths.
    const capped = applyExternalScopePolicy(all.filter((d) => d.code === 'MDL404'));
    for (const d of capped) assert.equal(d.severity, 'warning');
    assert.ok(capped.length >= 1, 'the member fence diagnostic survives the sovereignty policy');

    // Issue #7: the member document's OWN relative fence tokens resolve inside
    // the member coordinate system through the proxy — the doc-relative AND
    // the member-root-relative token both hit. Before the fix both folded into
    // home coordinates (`@member-a/scripts/exists.py` collapsed to a home key)
    // and false-positived even though the member solo pass was clean above.
    const memberDoc404 = all.filter((d) => d.code === 'MDL404' && d.path === '@member-a//docs/x.md');
    assert.deepEqual(memberDoc404.map((d) => d.data?.token), ['scripts/missing.py'], 'only the missing member token reports through the proxy');
    const cappedMember = applyExternalScopePolicy(memberDoc404);
    assert.equal(cappedMember.length, 1, 'the missing-token diagnostic survives the sovereignty policy');
    assert.equal(cappedMember[0]!.severity, 'warning', 'external MDL404 stays capped at warning');
  });

  it('case 19: member-internal relative markdown links resolve through the proxy (Issue #7)', () => {
    const config = defaultConfig();
    const home = createWorkspaceIndex(
      {
        'docs/home.md': '---\nmdlineage:\n  id: docs.home\n  kind: guide\n  status: active\n---\n# Home\n',
      },
      config
    );
    const member = createWorkspaceIndex(
      new Map<string, string>([
        [
          'docs/m1.md',
          [
            '---',
            'mdlineage:',
            '  id: docs.m1',
            '  kind: guide',
            '  status: active',
            '---',
            '',
            '[sibling](m2.md) and [member root](README.md) and [missing](missing.md).',
            '',
          ].join('\n'),
        ],
        ['docs/m2.md', '---\nmdlineage:\n  id: docs.m2\n  kind: guide\n  status: active\n---\n# M2\n'],
        ['README.md', '---\nmdlineage:\n  id: docs.mreadme\n  kind: guide\n  status: active\n---\n# Member README\n'],
      ]),
      config
    );

    const proxy = createFederatedIndex(home, new Map([['member-a', { scope: 'member-a', index: member, alias: 'member-a' }]]));
    const all = validateWorkspace(proxy, { includeSingleDocument: false });
    const throughProxy = all.filter((d) => d.code === 'MDL401' && d.path === '@member-a//docs/m1.md');
    assert.deepEqual(throughProxy.map((d) => d.data?.path), ['missing.md'], 'doc-relative and member-root-relative links resolve; only the missing one reports');

    const solo = validateWorkspace(member, { includeSingleDocument: false }).filter((d) => d.code === 'MDL401');
    assert.deepEqual(solo.map((d) => d.data?.path), ['missing.md'], 'the member solo pass agrees — proxy equals member semantics');

    const capped = applyExternalScopePolicy(throughProxy);
    assert.equal(capped.length, 1, 'the missing-target diagnostic survives the sovereignty policy');
    assert.equal(capped[0]!.severity, 'warning', 'external MDL401 stays capped at warning');
  });

  it('case 20: proxy ↔ member resolution equivalence, the name collision, and the home regression table (Issue #7)', () => {
    const config = defaultConfig();
    const home = createWorkspaceIndex(
      new Map<string, string>([
        ['docs/h.md', '---\nmdlineage:\n  id: home.h\n  kind: guide\n  status: active\n---\n# Home H\n'],
        ['root.md', '---\nmdlineage:\n  id: home.root\n  kind: guide\n  status: active\n---\n# Home Root\n'],
        ['docs/b.md', '---\nmdlineage:\n  id: home.b\n  kind: guide\n  status: active\n---\n# Home B\n'],
        ['scripts/tool.md', '---\nmdlineage:\n  id: home.tool\n  kind: guide\n  status: active\n---\n# Home Tool\n'],
      ]),
      config
    );
    const member = createWorkspaceIndex(
      new Map<string, string>([
        ['docs/x.md', '---\nmdlineage:\n  id: member.x\n  kind: guide\n  status: active\n---\n# Member X\n'],
        ['docs/m2.md', '---\nmdlineage:\n  id: member.m2\n  kind: guide\n  status: active\n---\n# Member M2\n'],
        ['README.md', '---\nmdlineage:\n  id: member.readme\n  kind: guide\n  status: active\n---\n# Member README\n'],
        ['scripts/tool.py', '#!/usr/bin/env python3\n'],
        ['scripts/tool.md', '---\nmdlineage:\n  id: member.tool\n  kind: guide\n  status: active\n---\n# Member Tool\n'],
        ['lib/deep/d.md', '---\nmdlineage:\n  id: member.deep\n  kind: guide\n  status: active\n---\n# Deep\n'],
      ]),
      config
    );
    const proxy = createFederatedIndex(home, new Map([['member-a', { scope: 'member-a', index: member, alias: 'member-a' }]]));
    const scoped = (p: string): string => `@member-a//${p}`;

    // Equivalence table: whatever the member index resolves solo, the proxy
    // must resolve to the SAME member document through its scoped coordinate —
    // document-relative, member-root-relative, deep climbs, fancy folds, fence
    // targets, and missing targets alike.
    const rows: ReadonlyArray<readonly [string, string]> = [
      ['docs/x.md', 'm2.md'],
      ['docs/x.md', './m2.md'],
      ['docs/x.md', '../README.md'],
      ['docs/x.md', 'README.md'],
      ['docs/x.md', 'scripts/tool.py'],
      ['docs/x.md', './x/../m2.md'],
      ['lib/deep/d.md', '../../docs/x.md'],
      ['lib/deep/d.md', '../../README.md'],
      ['docs/x.md', 'scripts/tool.md'],
      ['docs/x.md', 'missing.md'],
      ['lib/deep/d.md', '../missing.md'],
      ['docs/x.md', 'gone/deep.md'],
    ];
    for (const [from, dest] of rows) {
      const solo = resolveLinkPath(member, from, dest);
      assert.deepEqual(
        resolveLinkPath(proxy, scoped(from), dest),
        solo.map(scoped),
        `${from} + ${dest}: the proxy must resolve to the member document`,
      );
    }

    // The collision row (adjudication 4): home AND member both have
    // scripts/tool.md; a member document's root-relative reference must land
    // in the MEMBER (its own solo semantics), never the home namesake.
    assert.deepEqual([...resolveLinkPath(proxy, scoped('docs/x.md'), 'scripts/tool.md')], [scoped('scripts/tool.md')]);
    assert.deepEqual([...resolveLinkPath(proxy, 'docs/h.md', 'scripts/tool.md')], ['scripts/tool.md'], 'home documents keep home precedence');

    // Federated absolute destinations are terminal coordinates on both sides.
    assert.deepEqual([...resolveLinkPath(proxy, scoped('docs/x.md'), scoped('docs/m2.md'))], [scoped('docs/m2.md')]);
    assert.deepEqual([...resolveLinkPath(proxy, 'docs/h.md', scoped('docs/m2.md'))], [scoped('docs/m2.md')]);

    // Home regression: every spelling that resolved before Issue #7 resolves
    // identically after it (the `before` column pins the pre-fix behavior).
    const homeRows: ReadonlyArray<readonly [string, string, readonly string[]]> = [
      ['docs/h.md', 'b.md', ['docs/b.md']],
      ['docs/h.md', './b.md', ['docs/b.md']],
      ['docs/h.md', '../root.md', ['root.md']],
      ['docs/h.md', 'root.md', ['root.md']],
      ['docs/h.md', 'missing.md', []],
      ['docs/h.md', '/docs/b.md', []],
      ['docs/h.md', 'https://example.com/x.md', []],
      ['docs/h.md', '../member-a/docs/x.md', ['member-a/docs/x.md']],
      ['docs/h.md', '@member-a//docs/x.md', ['@member-a//docs/x.md']],
      ['docs/h.md', 'b.md/', ['docs/b.md']],
    ];
    for (const [from, dest, expected] of homeRows) {
      assert.deepEqual([...resolveLinkPath(proxy, from, dest)], expected, `${from} + ${dest}: home behavior is byte-identical`);
    }
  });

  it('case 21: home dangling keys on member targets answer both spellings and wake on member creation (Issue #6 × #7)', () => {
    const config = defaultConfig();
    const homeFiles = new Map<string, string>([
      [
        'docs/a.md',
        [
          '---',
          'mdlineage:',
          '  id: docs.a',
          '  kind: guide',
          '  status: active',
          '---',
          '',
          '[scoped](@member-a//m.md) and [alias](../member-a/m2.md).',
          '',
        ].join('\n'),
      ],
    ]);
    const memberFiles = new Map<string, string>([
      ['docs/m3.md', '---\nmdlineage:\n  id: member.m3\n  kind: guide\n  status: active\n---\n[t](t.md).\n'],
    ]);
    const home = createWorkspaceIndex(homeFiles, config);
    const member = createWorkspaceIndex(memberFiles, config);
    const proxy = createFederatedIndex(home, new Map([['member-a', { scope: 'member-a', index: member, alias: 'member-a' }]]));

    // Both spellings of the not-yet-existing member targets are HOME-index
    // wake keys — the query the LSP bridge issues on a member change.
    assert.deepEqual(home.danglingReferrersOf!('@member-a//m.md'), ['docs/a.md']);
    assert.deepEqual(home.danglingReferrersOf!('member-a/m2.md'), ['docs/a.md']);
    assert.deepEqual(home.danglingReferrersOf!('@member-a//nope.md'), []);

    // Member-internal half: the member index wakes its own referrer.
    updateFile(member, 't.md', '---\nmdlineage:\n  id: member.t\n  kind: guide\n  status: active\n---\n# T\n');
    memberFiles.set('t.md', '---\nmdlineage:\n  id: member.t\n  kind: guide\n  status: active\n---\n# T\n');

    // Creating the member targets resolves the home documents' dangling links.
    updateFile(member, 'm.md', '---\nmdlineage:\n  id: member.m\n  kind: guide\n  status: active\n---\n# M\n');
    memberFiles.set('m.md', '---\nmdlineage:\n  id: member.m\n  kind: guide\n  status: active\n---\n# M\n');
    updateFile(member, 'm2.md', '---\nmdlineage:\n  id: member.m2\n  kind: guide\n  status: active\n---\n# M2\n');
    memberFiles.set('m2.md', '---\nmdlineage:\n  id: member.m2\n  kind: guide\n  status: active\n---\n# M2\n');
    assert.deepEqual(
      [...new Set([...home.danglingReferrersOf!('@member-a//m.md'), ...home.danglingReferrersOf!('member-a/m2.md')])],
      ['docs/a.md'],
      'the bridge query names the home referrer',
    );

    // And the proxy's full report equals a rebuild: both MDL401s cleared.
    const rebuilt = createFederatedIndex(
      createWorkspaceIndex(homeFiles, config),
      new Map([['member-a', { scope: 'member-a', index: createWorkspaceIndex(memberFiles, config), alias: 'member-a' }]]),
    );
    assert.deepEqual(
      validateWorkspace(proxy, { includeSingleDocument: false }).map((d) => [d.path, d.code, d.range.start.offset]),
      validateWorkspace(rebuilt, { includeSingleDocument: false }).map((d) => [d.path, d.code, d.range.start.offset]),
      'incremental proxy report equals a full rebuild',
    );
    assert.equal(
      validateWorkspace(proxy, { includeSingleDocument: false }).filter((d) => d.code === 'MDL401' && d.path === 'docs/a.md').length,
      0,
      'both dangling spellings resolve after the member creation',
    );
  });

  it('case 17: updateFile on federated proxy throws Error (read-only enforcement)', () => {
    const config = defaultConfig();
    const home = createWorkspaceIndex({}, config);
    const proxy = createFederatedIndex(home, new Map());
    assert.throws(
      () => {
        updateFile(proxy, 'docs/a.md', '# Content');
      },
      /require the index returned by createWorkspaceIndex/i
    );
  });

});
