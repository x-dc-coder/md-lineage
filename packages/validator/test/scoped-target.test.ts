// Scoped relation targets and cross-federation semantic routing tests (Issue #4 Phase 2 PR-a).
//
// Covers B1-B15 test matrix from implementation brief:
// - B1: schema accepts bare and valid scoped envelopes
// - B2: schema rejects malformed envelopes (MDL103)
// - B3: parseScopedTarget helper unit test
// - B4: exact scope routing resolves cross-repo target
// - B5: exact scope with non-existent target in mounted member produces MDL302 without unknown-scope suffix
// - B6: undeclared scope produces MDL302 with unknown federation scope message
// - B7: wildcard target uniquely resolving in a member resolves cleanly
// - B8: wildcard target ambiguous across scopes produces MDL307 error with candidates in data
// - B9: missing:warn scope reference produces MDL308 hint without MDL302
// - B10: wildcard target with zero hits and missing:warn scope produces MDL308 hint; contrast with no missing scopes producing MDL302
// - B11: evidence anchor resolution routes to member target (MDL402 on missing anchor; clean on existing)
// - B12: self-reference check in member with scoped coordinate still reports MDL103
// - B13: MDL304 orthogonal to scoped target: blank reason reports MDL304
// - B14: MDL305 cycle detection namespace isolation
// - B15: sovereignty capping: MDL307 declared in member is capped to warning; declared in home is error

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  defaultConfig,
  loadConfig,
  resolveFederations,
  createWorkspaceIndex,
  createFederatedIndex,
  validateWorkspace,
  validateDocumentSync,
  updateFile,
  parseScopedTarget,
  applyExternalScopePolicy,
  scopeOfPath,
  type DocPath,
  type FederatedMemberMount,
} from '../src/index.js';

describe('Scoped targets & federation semantics (Phase 2 PR-a: B1-B15)', () => {
  it('B1: schema accepts bare and valid scoped envelopes (@scope//id, @*//id)', () => {
    const config = defaultConfig();
    const doc = `---
mdlineage:
  schema: 1
  id: docs.test-schema
  kind: guide
  status: active
  relations:
    - type: related_to
      target: docs.bare
    - type: related_to
      target: a-b.c
    - type: related_to
      target: "@member-a//docs.x"
    - type: related_to
      target: "@*//docs.x"
---
# Test Document
`;
    const res = validateDocumentSync({ path: 'test.md', content: doc, config });
    const mdl103 = res.diagnostics.filter((d) => d.code === 'MDL103');
    assert.deepEqual(mdl103, [], 'All valid target patterns should pass schema validation without MDL103');
  });

  it('B2: schema rejects malformed envelopes (uppercase, single slash, empty id, numeric-start scope)', () => {
    const config = defaultConfig();
    const cases = [
      { target: '@Scope//x', desc: 'uppercase in scope' },
      { target: '@skills/x', desc: 'single slash' },
      { target: '@member//', desc: 'empty id' },
      { target: '@1member//x', desc: 'scope starting with number' },
    ];

    for (const c of cases) {
      const doc = `---
mdlineage:
  schema: 1
  id: docs.bad-target
  kind: guide
  status: active
  relations:
    - type: related_to
      target: "${c.target}"
---
# Bad Target
`;
      const res = validateDocumentSync({ path: 'test.md', content: doc, config });
      const mdl103 = res.diagnostics.find((d) => d.code === 'MDL103');
      assert.ok(mdl103, `Schema must reject malformed target '${c.target}' (${c.desc}) with MDL103`);
    }
  });

  it('B3: parseScopedTarget splits bare, @scope//id, @*//id, and falls back on malformed', () => {
    assert.deepEqual(parseScopedTarget('docs.bare'), { scope: 'bare', id: 'docs.bare' });
    assert.deepEqual(parseScopedTarget('@member-a//docs.x'), { scope: 'member-a', id: 'docs.x' });
    assert.deepEqual(parseScopedTarget('@*//docs.x'), { scope: '*', id: 'docs.x' });

    // Malformed envelopes fallback without throwing
    assert.deepEqual(parseScopedTarget('@//x'), { scope: 'bare', id: '@//x' });
    assert.deepEqual(parseScopedTarget('@a//'), { scope: 'bare', id: '@a//' });
    assert.deepEqual(parseScopedTarget('@123//x'), { scope: 'bare', id: '@123//x' });
  });

  it('B4: home doc targeting @member-a//docs.x resolves cleanly when member-a has docs.x', () => {
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
      target: "@member-a//docs.x"
      reason: cross-repo scoped target
---
# Home Doc
`,
      },
      config
    );
    const member = createWorkspaceIndex(
      {
        'docs/x.md': `---
mdlineage:
  id: docs.x
  kind: guide
  status: active
---
# Member Doc
`,
      },
      config
    );

    const mounts = new Map<string, FederatedMemberMount>([
      ['member-a', { scope: 'member-a', index: member, alias: 'member-a' }],
    ]);
    const proxy = createFederatedIndex(home, mounts);
    const diags = validateWorkspace(proxy);

    const mdl302 = diags.find((d) => d.code === 'MDL302');
    assert.equal(mdl302, undefined, 'Scoped target @member-a//docs.x should resolve cleanly');
  });

  it('B5: @member-a//no-such-id produces MDL302 without unknown-scope suffix', () => {
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
      target: "@member-a//no-such-id"
      reason: testing missing id in valid scope
---
# Home Doc
`,
      },
      config
    );
    const member = createWorkspaceIndex(
      {
        'docs/x.md': `---
mdlineage:
  id: docs.x
  kind: guide
  status: active
---
# Member Doc
`,
      },
      config
    );

    const mounts = new Map<string, FederatedMemberMount>([
      ['member-a', { scope: 'member-a', index: member, alias: 'member-a' }],
    ]);
    const proxy = createFederatedIndex(home, mounts);
    const diags = validateWorkspace(proxy);

    const mdl302 = diags.find((d) => d.code === 'MDL302');
    assert.ok(mdl302, 'Should report MDL302');
    assert.equal(mdl302.message, 'Relation target does not exist: @member-a//no-such-id');
  });

  it('B6: @ghost//x with undeclared scope produces MDL302 with unknown federation scope message', () => {
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
      target: "@ghost//docs.x"
      reason: testing undeclared scope
---
# Home Doc
`,
      },
      config
    );

    const mounts = new Map<string, FederatedMemberMount>();
    const proxy = createFederatedIndex(home, mounts);
    const diags = validateWorkspace(proxy);

    const mdl302 = diags.find((d) => d.code === 'MDL302');
    assert.ok(mdl302, 'Should report MDL302');
    assert.ok(
      mdl302.message.includes("unknown federation scope 'ghost'"),
      `Message should state unknown scope: ${mdl302.message}`
    );
  });

  it('B7: @*//docs.x uniquely existing in member-a resolves cleanly with zero diagnostics', () => {
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
      target: "@*//docs.x"
      reason: wildcard target
---
# Home Doc
`,
      },
      config
    );
    const memberA = createWorkspaceIndex(
      {
        'docs/x.md': `---
mdlineage:
  id: docs.x
  kind: guide
  status: active
---
# Doc X in Member A
`,
      },
      config
    );
    const memberB = createWorkspaceIndex(
      {
        'docs/y.md': `---
mdlineage:
  id: docs.y
  kind: guide
  status: active
---
# Doc Y in Member B
`,
      },
      config
    );

    const mounts = new Map<string, FederatedMemberMount>([
      ['member-a', { scope: 'member-a', index: memberA, alias: 'member-a' }],
      ['member-b', { scope: 'member-b', index: memberB, alias: 'member-b' }],
    ]);
    const proxy = createFederatedIndex(home, mounts);
    const diags = validateWorkspace(proxy);

    const targetDiags = diags.filter((d) => ['MDL302', 'MDL307', 'MDL308'].includes(d.code));
    assert.deepEqual(targetDiags, [], 'Unique wildcard match should resolve with zero target diagnostics');
  });

  it('B8: @*//docs.x existing in both member-a and member-b produces MDL307 error with candidates in data', () => {
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
      target: "@*//docs.x"
      reason: ambiguous wildcard target
---
# Home Doc
`,
      },
      config
    );
    const memberA = createWorkspaceIndex(
      {
        'docs/x.md': `---
mdlineage:
  id: docs.x
  kind: guide
  status: active
---
# Doc X in Member A
`,
      },
      config
    );
    const memberB = createWorkspaceIndex(
      {
        'docs/x.md': `---
mdlineage:
  id: docs.x
  kind: guide
  status: active
---
# Doc X in Member B
`,
      },
      config
    );

    const mounts = new Map<string, FederatedMemberMount>([
      ['member-a', { scope: 'member-a', index: memberA, alias: 'member-a' }],
      ['member-b', { scope: 'member-b', index: memberB, alias: 'member-b' }],
    ]);
    const proxy = createFederatedIndex(home, mounts);
    const diags = validateWorkspace(proxy);

    const mdl307 = diags.find((d) => d.code === 'MDL307');
    assert.ok(mdl307, 'Must report MDL307 on ambiguous wildcard relation target');
    assert.equal(mdl307.severity, 'error');
    assert.ok(mdl307.message.includes('member-a'), `Message should list member-a: ${mdl307.message}`);
    assert.ok(mdl307.message.includes('member-b'), `Message should list member-b: ${mdl307.message}`);

    const data = mdl307.data as { candidates?: readonly string[] } | undefined;
    assert.ok(data?.candidates, 'Data must contain candidates');
    assert.ok(data.candidates.includes('@member-a//docs/x.md'));
    assert.ok(data.candidates.includes('@member-b//docs/x.md'));
  });

  it('B9: config declared member-missing (missing:warn), target @missing//x produces MDL308 hint, no MDL302', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mdl-b9-'));
    try {
      const homeDir = join(tmp, 'home');
      mkdirSync(homeDir, { recursive: true });
      const homeCfg = join(homeDir, 'mdlineage.config.yaml');
      writeFileSync(
        homeCfg,
        `configVersion: 1
federations:
  missing:
    local:
      path: ../non-existent-member
    missing: warn
`,
        'utf8'
      );

      const loaded = loadConfig(homeCfg);
      const res = resolveFederations(loaded.config, homeDir);
      assert.ok(res.federation);
      assert.deepEqual(res.federation.missingScopes, ['missing']);

      const homeIndex = createWorkspaceIndex(
        {
          'docs/a.md': `---
mdlineage:
  id: docs.a
  kind: guide
  status: active
  relations:
    - type: depends_on
      target: "@missing//docs.x"
      reason: missing member reference
---
# Home Doc
`,
        },
        loaded.config
      );

      const proxy = createFederatedIndex(homeIndex, new Map(), {
        missingScopes: new Set(res.federation.missingScopes),
      });
      const diags = validateWorkspace(proxy);

      const mdl308 = diags.find((d) => d.code === 'MDL308');
      assert.ok(mdl308, 'Should produce MDL308 hint when target scope is missing:warn');
      assert.equal(mdl308.severity, 'hint');
      assert.ok(mdl308.message.includes("federated member 'missing' is missing"));

      const mdl302 = diags.find((d) => d.code === 'MDL302');
      assert.equal(mdl302, undefined, 'No MDL302 should be reported when MDL308 covers the missing member');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('B10: @*//x with zero hits and missing:warn scope produces MDL308 hint; contrast with no missing scopes producing MDL302', () => {
    const config = defaultConfig();
    const homeIndex = createWorkspaceIndex(
      {
        'docs/a.md': `---
mdlineage:
  id: docs.a
  kind: guide
  status: active
  relations:
    - type: depends_on
      target: "@*//docs.ghost"
      reason: test missing
---
# Home
`,
      },
      config
    );

    // Case with missingScopes: produces MDL308 hint
    const proxyWithMissing = createFederatedIndex(homeIndex, new Map(), {
      missingScopes: new Set(['missing-member']),
    });
    const diagsWithMissing = validateWorkspace(proxyWithMissing);
    const mdl308 = diagsWithMissing.find((d) => d.code === 'MDL308');
    assert.ok(mdl308, 'Should produce MDL308 hint when wildcard target resolves nowhere but missingScopes exist');
    assert.equal(mdl308.severity, 'hint');

    // Case without missingScopes: produces MDL302 error
    const proxyClean = createFederatedIndex(homeIndex, new Map());
    const diagsClean = validateWorkspace(proxyClean);
    const mdl302 = diagsClean.find((d) => d.code === 'MDL302');
    assert.ok(mdl302, 'Should produce MDL302 error when wildcard target resolves nowhere and no missingScopes');
    assert.equal(mdl302.severity, 'error');
  });

  it('B11: evidence anchor resolution routes to member target (MDL402 on missing anchor; clean on existing)', () => {
    const config = defaultConfig();
    const memberIndex = createWorkspaceIndex(
      {
        'docs/x.md': `---
mdlineage:
  id: docs.x
  kind: guide
  status: active
---
# Doc Title

## Real Section
`,
      },
      config
    );

    const mounts = new Map<string, FederatedMemberMount>([
      ['member-a', { scope: 'member-a', index: memberIndex, alias: 'member-a' }],
    ]);

    // Bad evidence anchor -> MDL402
    const homeBad = createWorkspaceIndex(
      {
        'docs/a.md': `---
mdlineage:
  id: docs.a
  kind: guide
  status: active
  relations:
    - type: depends_on
      target: "@member-a//docs.x"
      reason: evidence test
      evidence: "#missing-section"
---
# Home Doc
`,
      },
      config
    );
    const proxyBad = createFederatedIndex(homeBad, mounts);
    const diagsBad = validateWorkspace(proxyBad);
    const mdl402 = diagsBad.find((d) => d.code === 'MDL402');
    assert.ok(mdl402, 'Should report MDL402 for missing evidence anchor in member target');
    assert.ok(mdl402.message.includes('@member-a//docs.x'));

    // Good evidence anchor -> Clean
    const homeGood = createWorkspaceIndex(
      {
        'docs/a.md': `---
mdlineage:
  id: docs.a
  kind: guide
  status: active
  relations:
    - type: depends_on
      target: "@member-a//docs.x"
      reason: evidence test
      evidence: "#real-section"
---
# Home Doc
`,
      },
      config
    );
    const proxyGood = createFederatedIndex(homeGood, mounts);
    const diagsGood = validateWorkspace(proxyGood);
    assert.equal(diagsGood.find((d) => d.code === 'MDL402'), undefined, 'No MDL402 on valid evidence anchor');
  });

  it('B12: member doc self-reference via scoped envelope (@member-a//own-id) still reports MDL103', () => {
    const config = defaultConfig();
    const memberIndex = createWorkspaceIndex(
      {
        'docs/x.md': `---
mdlineage:
  id: docs.x
  kind: guide
  status: active
  relations:
    - type: depends_on
      target: "@member-a//docs.x"
      reason: self ref
---
# Member Doc
`,
      },
      config
    );

    const mounts = new Map<string, FederatedMemberMount>([
      ['member-a', { scope: 'member-a', index: memberIndex, alias: 'member-a' }],
    ]);
    const homeIndex = createWorkspaceIndex({}, config);
    const proxy = createFederatedIndex(homeIndex, mounts);
    const diags = validateWorkspace(proxy);

    const mdl103 = diags.find((d) => d.code === 'MDL103' && d.path === ('@member-a//docs/x.md' as DocPath));
    assert.ok(mdl103, 'Scoped self-reference in member document should report MDL103');
  });

  it('B13: MDL304 is orthogonal to scoped target: blank reason reports MDL304', () => {
    const config = defaultConfig();
    const memberIndex = createWorkspaceIndex(
      {
        'docs/x.md': `---
mdlineage:
  id: docs.x
  kind: guide
  status: active
---
# Member Doc
`,
      },
      config
    );

    const mounts = new Map<string, FederatedMemberMount>([
      ['member-a', { scope: 'member-a', index: memberIndex, alias: 'member-a' }],
    ]);
    const homeIndex = createWorkspaceIndex(
      {
        'docs/a.md': `---
mdlineage:
  id: docs.a
  kind: guide
  status: active
  relations:
    - type: depends_on
      target: "@member-a//docs.x"
      reason: "   "
---
# Home Doc
`,
      },
      config
    );
    const proxy = createFederatedIndex(homeIndex, mounts);
    const diags = validateWorkspace(proxy);

    const mdl304 = diags.find((d) => d.code === 'MDL304');
    assert.ok(mdl304, 'Blank reason on scoped relation target must still report MDL304');
  });

  it('B14: MDL305 namespace isolation: same bare id across members does not fake cycle; cross-repo loop reports cycle with scoped keys', () => {
    const config = defaultConfig();
    // Negative test: member-a and member-b each have docs.a and docs.b,
    // where member-a has docs.a supersedes docs.b (target in member-a),
    // and member-b has docs.b supersedes docs.a (target in member-b).
    // Same bare ids across repos with intra-repo edges -> no cross-repo cycle
    const memberA = createWorkspaceIndex(
      {
        'docs/a.md': `---
mdlineage:
  id: docs.a
  kind: guide
  status: active
  relations:
    - type: supersedes
      target: docs.b
      reason: internal supersedes
---
# A
`,
        'docs/b.md': `---
mdlineage:
  id: docs.b
  kind: guide
  status: active
---
# B
`,
      },
      config
    );
    const memberB = createWorkspaceIndex(
      {
        'docs/a.md': `---
mdlineage:
  id: docs.a
  kind: guide
  status: active
---
# A
`,
        'docs/b.md': `---
mdlineage:
  id: docs.b
  kind: guide
  status: active
  relations:
    - type: supersedes
      target: docs.a
      reason: internal supersedes
---
# B
`,
      },
      config
    );

    const mounts = new Map<string, FederatedMemberMount>([
      ['member-a', { scope: 'member-a', index: memberA, alias: 'member-a' }],
      ['member-b', { scope: 'member-b', index: memberB, alias: 'member-b' }],
    ]);
    const homeIndex = createWorkspaceIndex({}, config);
    const proxyNoCycle = createFederatedIndex(homeIndex, mounts);
    const diagsNoCycle = validateWorkspace(proxyNoCycle);
    assert.equal(diagsNoCycle.find((d) => d.code === 'MDL305'), undefined, 'Identical id across repos must not fabricate MDL305');

    // Positive test: member-a supersedes member-b and vice versa -> cross-repo cycle
    const memberACycle = createWorkspaceIndex(
      {
        'docs/a.md': `---
mdlineage:
  id: docs.a
  kind: guide
  status: active
  relations:
    - type: supersedes
      target: "@member-b//docs.b"
      reason: loop
---
# A
`,
      },
      config
    );
    const memberBCycle = createWorkspaceIndex(
      {
        'docs/b.md': `---
mdlineage:
  id: docs.b
  kind: guide
  status: active
  relations:
    - type: supersedes
      target: "@member-a//docs.a"
      reason: loop
---
# B
`,
      },
      config
    );

    const mountsCycle = new Map<string, FederatedMemberMount>([
      ['member-a', { scope: 'member-a', index: memberACycle, alias: 'member-a' }],
      ['member-b', { scope: 'member-b', index: memberBCycle, alias: 'member-b' }],
    ]);
    const proxyCycle = createFederatedIndex(homeIndex, mountsCycle);
    const diagsCycle = validateWorkspace(proxyCycle);
    const mdl305 = diagsCycle.find((d) => d.code === 'MDL305');
    assert.ok(mdl305, 'Cross-repo supersedes loop must report MDL305');
    const cycleData = mdl305.data as { cycle?: readonly string[] } | undefined;
    assert.ok(cycleData?.cycle);
    assert.ok(cycleData.cycle.includes('@member-a//docs.a'));
    assert.ok(cycleData.cycle.includes('@member-b//docs.b'));
  });

  it('B15: sovereignty capping: MDL307 declared in member is capped to warning; declared in home is error', () => {
    const config = defaultConfig();
    // Home doc has ambiguous @*//docs.x
    const homeIndex = createWorkspaceIndex(
      {
        'docs/home.md': `---
mdlineage:
  id: docs.home
  kind: guide
  status: active
  relations:
    - type: depends_on
      target: "@*//docs.x"
      reason: ambig in home
---
# Home Doc
`,
      },
      config
    );

    // Member-a doc also has ambiguous @*//docs.x
    const memberAIndex = createWorkspaceIndex(
      {
        'docs/x.md': `---
mdlineage:
  id: docs.x
  kind: guide
  status: active
  relations:
    - type: depends_on
      target: "@*//docs.x"
      reason: ambig in member
---
# Member A Doc X
`,
      },
      config
    );

    // Member-b doc provides the second docs.x
    const memberBIndex = createWorkspaceIndex(
      {
        'docs/x.md': `---
mdlineage:
  id: docs.x
  kind: guide
  status: active
---
# Member B Doc X
`,
      },
      config
    );

    const mounts = new Map<string, FederatedMemberMount>([
      ['member-a', { scope: 'member-a', index: memberAIndex, alias: 'member-a' }],
      ['member-b', { scope: 'member-b', index: memberBIndex, alias: 'member-b' }],
    ]);
    const proxy = createFederatedIndex(homeIndex, mounts);
    const rawDiags = validateWorkspace(proxy);
    const cappedDiags = applyExternalScopePolicy(rawDiags);

    const homeDiag = cappedDiags.find((d) => d.code === 'MDL307' && d.path === ('docs/home.md' as DocPath));
    assert.ok(homeDiag, 'Home doc gets MDL307');
    assert.equal(homeDiag.severity, 'error', 'Home MDL307 maintains error severity');

    const memberDiag = cappedDiags.find((d) => d.code === 'MDL307' && d.path === ('@member-a//docs/x.md' as DocPath));
    assert.ok(memberDiag, 'Member doc gets MDL307');
    assert.equal(memberDiag.severity, 'warning', 'Member MDL307 is capped to warning under sovereignty policy');
  });

  it('bare id dangling target in home is always MDL302 error even when federation has missing:warn scopes', () => {
    const config = defaultConfig();
    const homeIndex = createWorkspaceIndex(
      {
        'docs/home.md': `---
mdlineage:
  id: docs.home
  kind: guide
  status: active
  relations:
    - type: depends_on
      target: docs.nonexistent
      reason: missing target
---
# Home Doc
`,
      },
      config
    );

    const mounts = new Map<string, FederatedMemberMount>();
    const proxy = createFederatedIndex(homeIndex, mounts, {
      missingScopes: new Set(['ghost-scope']),
    });

    const diags = validateWorkspace(proxy);
    const mdl302 = diags.find((d) => d.code === 'MDL302');
    const mdl308 = diags.find((d) => d.code === 'MDL308');

    assert.ok(mdl302, 'Dangling bare id must report MDL302');
    assert.equal(mdl302.severity, 'error', 'Dangling bare id must remain error');
    assert.equal(mdl308, undefined, 'Dangling bare id must never be downgraded to MDL308');
  });

  // -------------------------------------------------------------------------
  // Phase 2 PR-b Tests: T1 - T9
  // -------------------------------------------------------------------------

  it('T1 & T2: pure member-to-member cycle is capped to warning and anchored on member path', () => {
    const config = defaultConfig();
    const homeIndex = createWorkspaceIndex({}, config);
    const memberACycle = createWorkspaceIndex(
      {
        'docs/a.md': `---
mdlineage:
  id: docs.a
  kind: guide
  status: active
  relations:
    - type: supersedes
      target: "@member-b//docs.b"
      reason: cross loop A to B
---
# A
`,
      },
      config
    );
    const memberBCycle = createWorkspaceIndex(
      {
        'docs/b.md': `---
mdlineage:
  id: docs.b
  kind: guide
  status: active
  relations:
    - type: supersedes
      target: "@member-a//docs.a"
      reason: cross loop B to A
---
# B
`,
      },
      config
    );

    const mounts = new Map<string, FederatedMemberMount>([
      ['member-a', { scope: 'member-a', index: memberACycle, alias: 'member-a' }],
      ['member-b', { scope: 'member-b', index: memberBCycle, alias: 'member-b' }],
    ]);
    const proxy = createFederatedIndex(homeIndex, mounts);
    const rawDiags = validateWorkspace(proxy);
    const rawMdl305 = rawDiags.find((d) => d.code === 'MDL305');
    assert.ok(rawMdl305, 'T1: Raw validateWorkspace reports MDL305');
    const rawCycle = (rawMdl305.data as { cycle?: readonly string[] })?.cycle;
    assert.ok(rawCycle?.includes('@member-a//docs.a'));
    assert.ok(rawCycle?.includes('@member-b//docs.b'));
    assert.ok(rawMdl305.message.includes('@member-a//docs.a'));

    // T2: policy capping
    const capped = applyExternalScopePolicy(rawDiags);
    const cappedMdl305 = capped.find((d) => d.code === 'MDL305');
    assert.ok(cappedMdl305, 'MDL305 present after policy');
    assert.equal(cappedMdl305.severity, 'warning', 'T2: pure member cycle is capped to warning');
    assert.ok(cappedMdl305.path.startsWith('@member-'), 'Anchored on member path');
  });

  it('T3: home document participating in cycle with @home// retains error severity and anchors on home', () => {
    const config = defaultConfig();
    // Home doc supersedes member doc
    const homeIndex = createWorkspaceIndex(
      {
        'docs/home.md': `---
mdlineage:
  id: docs.home
  kind: guide
  status: active
  relations:
    - type: supersedes
      target: "@member//docs.member"
      reason: home to member
---
# Home Doc
`,
      },
      config
    );
    // Member doc supersedes home doc using @home//docs.home
    const memberIndex = createWorkspaceIndex(
      {
        'docs/m.md': `---
mdlineage:
  id: docs.member
  kind: guide
  status: active
  relations:
    - type: supersedes
      target: "@home//docs.home"
      reason: member to home
---
# Member Doc
`,
      },
      config
    );

    const mounts = new Map<string, FederatedMemberMount>([
      ['member', { scope: 'member', index: memberIndex, alias: 'member' }],
    ]);
    const proxy = createFederatedIndex(homeIndex, mounts);
    const rawDiags = validateWorkspace(proxy);
    const rawMdl305 = rawDiags.find((d) => d.code === 'MDL305');
    assert.ok(rawMdl305, 'T3: cycle with home is detected');
    assert.equal(rawMdl305.path, 'docs/home.md', 'T3: Anchor must be the home path');

    const capped = applyExternalScopePolicy(rawDiags);
    const cappedMdl305 = capped.find((d) => d.code === 'MDL305');
    assert.ok(cappedMdl305, 'MDL305 present after policy');
    assert.equal(cappedMdl305.severity, 'error', 'T3: Home-participating cycle retains error severity');
    assert.equal(cappedMdl305.path, 'docs/home.md');
  });

  it('T4: home active document depends on deprecated member document reports MDL306 warning with scoped targetPath', () => {
    const config = defaultConfig();
    const homeIndex = createWorkspaceIndex(
      {
        'docs/home.md': `---
mdlineage:
  id: docs.home
  kind: guide
  status: active
  relations:
    - type: depends_on
      target: "@member//docs.dep"
      reason: need old stuff
---
# Home Doc
`,
      },
      config
    );
    const memberIndex = createWorkspaceIndex(
      {
        'docs/dep.md': `---
mdlineage:
  id: docs.dep
  kind: guide
  status: deprecated
---
# Deprecated Member Doc
`,
      },
      config
    );
    const mounts = new Map<string, FederatedMemberMount>([
      ['member', { scope: 'member', index: memberIndex, alias: 'member' }],
    ]);
    const proxy = createFederatedIndex(homeIndex, mounts);
    const diags = validateWorkspace(proxy);
    const mdl306 = diags.find((d) => d.code === 'MDL306');
    assert.ok(mdl306, 'T4: MDL306 must be reported');
    assert.equal(mdl306.severity, 'warning');
    assert.equal(mdl306.path, 'docs/home.md');
    const data = mdl306.data as { targetPath?: string } | undefined;
    assert.equal(data?.targetPath, '@member//docs/dep.md');
  });

  it('T5: member document depends on another member deprecated document reports MDL306 warning', () => {
    const config = defaultConfig();
    const homeIndex = createWorkspaceIndex({}, config);
    const memberA = createWorkspaceIndex(
      {
        'docs/a.md': `---
mdlineage:
  id: docs.a
  kind: guide
  status: active
  relations:
    - type: depends_on
      target: "@member-b//docs.dep"
      reason: need dep in b
---
# A
`,
      },
      config
    );
    const memberB = createWorkspaceIndex(
      {
        'docs/dep.md': `---
mdlineage:
  id: docs.dep
  kind: guide
  status: deprecated
---
# Dep
`,
      },
      config
    );
    const mounts = new Map<string, FederatedMemberMount>([
      ['member-a', { scope: 'member-a', index: memberA, alias: 'member-a' }],
      ['member-b', { scope: 'member-b', index: memberB, alias: 'member-b' }],
    ]);
    const proxy = createFederatedIndex(homeIndex, mounts);
    const diags = applyExternalScopePolicy(validateWorkspace(proxy));
    const mdl306 = diags.find((d) => d.code === 'MDL306');
    assert.ok(mdl306, 'T5: MDL306 reported for member-to-member');
    assert.equal(mdl306.severity, 'warning');
    assert.equal(mdl306.path, '@member-a//docs/a.md');
  });

  it('T6 & T7: proxy.referrersOf handles envelope target and updates lazily', () => {
    const config = defaultConfig();
    const homeIndex = createWorkspaceIndex(
      {
        'docs/home.md': `---
mdlineage:
  id: docs.home
  kind: guide
  status: active
  relations:
    - type: depends_on
      target: "@member//docs.x"
      reason: ref x
---
# Home
`,
      },
      config
    );
    const memberIndex = createWorkspaceIndex(
      {
        'docs/x.md': `---
mdlineage:
  id: docs.x
  kind: guide
  status: active
---
# X
`,
      },
      config
    );
    const mounts = new Map<string, FederatedMemberMount>([
      ['member', { scope: 'member', index: memberIndex, alias: 'member' }],
    ]);
    const proxy = createFederatedIndex(homeIndex, mounts);

    // T6: referrersOf with envelope
    const refs = proxy.referrersOf('@member//docs.x');
    assert.deepEqual(refs, ['docs/home.md'], 'T6: home doc referencing @member//docs.x must be found');

    // T7: lazy derivation after updateFile on homeIndex
    updateFile(
      homeIndex,
      'docs/home.md' as DocPath,
      `---
mdlineage:
  id: docs.home
  kind: guide
  status: active
---
# Home Clean
`
    );
    const refsAfter = proxy.referrersOf('@member//docs.x');
    assert.deepEqual(refsAfter, [], 'T7: referrer vanishes after updateFile without stale cache');
  });

  it('T8: proxy.referrersOf finds cross-member referrers with envelope', () => {
    const config = defaultConfig();
    const homeIndex = createWorkspaceIndex({}, config);
    const memberA = createWorkspaceIndex(
      {
        'docs/a.md': `---
mdlineage:
  id: docs.a
  kind: guide
  status: active
  relations:
    - type: depends_on
      target: "@member-b//docs.x"
      reason: cross ref
---
# A
`,
      },
      config
    );
    const memberB = createWorkspaceIndex(
      {
        'docs/x.md': `---
mdlineage:
  id: docs.x
  kind: guide
  status: active
---
# X
`,
      },
      config
    );
    const mounts = new Map<string, FederatedMemberMount>([
      ['member-a', { scope: 'member-a', index: memberA, alias: 'member-a' }],
      ['member-b', { scope: 'member-b', index: memberB, alias: 'member-b' }],
    ]);
    const proxy = createFederatedIndex(homeIndex, mounts);

    const refs = proxy.referrersOf('@member-b//docs.x');
    assert.deepEqual(refs, ['@member-a//docs/a.md'], 'T8: cross-member referrer found as scoped path');
  });

  it('T9: scopeOfPath unit assertions', () => {
    assert.equal(scopeOfPath('docs/a.md'), 'home');
    assert.equal(scopeOfPath('@member//docs/a.md'), 'member');
    assert.equal(scopeOfPath('@custom-scope//deep/path.md'), 'custom-scope');
    assert.equal(scopeOfPath('@home//docs/a.md'), 'home');
    assert.equal(scopeOfPath('invalid@scope//doc.md'), 'home');
    assert.equal(scopeOfPath('@//doc.md'), 'home');
  });
});
