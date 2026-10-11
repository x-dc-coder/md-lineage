/**
 * End-to-end CLI federation tests (Issue #4 Phase 1).
 *
 * Runs the compiled CLI binary (packages/cli/dist/main.js) across real
 * multi-repository workspaces, asserting exit-code sovereignty, alias routing,
 * config-level error cycles, and --no-federation flags.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..');
const cliBin = resolve(repoRoot, 'packages', 'cli', 'dist', 'main.js');
const federationFixtureRoot = resolve(repoRoot, 'test', 'fixtures', 'federation');

interface RunOutput {
  stdout: string;
  stderr: string;
  status: number | null;
}

function runCli(args: string[], cwd = repoRoot): RunOutput {
  const result = spawnSync(process.execPath, [cliBin, ...args], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  });
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status };
}

interface JsonOutput {
  reports: Array<{
    path: string;
    diagnostics: Array<{ code: string; severity: string; message: string; line: number; column: number }>;
  }>;
  configDiagnostics: Array<{ code: string; severity: string; message: string }>;
  summary?: {
    files: number;
    errors: number;
    warnings: number;
  };
}

function parseJson(stdout: string): JsonOutput {
  return JSON.parse(stdout) as JsonOutput;
}

describe('CLI federation check (Phase 1)', () => {
  it('case 19: clean check across test/fixtures/federation/home succeeds with scoped reports and missing: warn', () => {
    const homeDir = join(federationFixtureRoot, 'home');
    const out = runCli(['check', '.', '--no-baseline', '--format', 'json'], homeDir);

    assert.equal(out.status, 0, `check should exit 0, stderr: ${out.stderr}`);
    const json = parseJson(out.stdout);

    // Verify member reports are emitted in scoped coordinates
    const reportPaths = json.reports.map((r) => r.path);
    assert.ok(
      reportPaths.includes('@member-a//docs/skills.md'),
      'includes member-a scoped report'
    );
    assert.ok(
      reportPaths.includes('@member-b//docs/b-guide.md'),
      'includes member-b scoped report'
    );
    assert.ok(
      !reportPaths.includes('@member-b//notes/internal.md'),
      'notes/internal.md is excluded by include globs'
    );

    // Home doc linking to member-a has no MDL401
    const homeReport = json.reports.find((r) => r.path === 'docs/index.md');
    assert.ok(homeReport);
    assert.equal(
      homeReport.diagnostics.find((d) => d.code === 'MDL401'),
      undefined,
      'No MDL401 on cross-repo relative link'
    );

    // configDiagnostics contains MDL902 warning for member-missing
    const mdl902 = json.configDiagnostics.find((d) => d.code === 'MDL902');
    assert.ok(mdl902, 'Contains MDL902 warning for missing member');
    assert.equal(mdl902.severity, 'warning');
  });

  it('case 20: exit code sovereignty - member error is capped to warning so exit code is 0', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mdl-cli-fed-'));
    try {
      const homeDir = join(tmp, 'home');
      const memberDir = join(tmp, 'member-err');
      mkdirSync(homeDir, { recursive: true });
      mkdirSync(join(homeDir, 'docs'), { recursive: true });
      mkdirSync(memberDir, { recursive: true });
      mkdirSync(join(memberDir, 'docs'), { recursive: true });

      writeFileSync(
        join(homeDir, 'mdlineage.config.yaml'),
        `configVersion: 1
federations:
  member:
    local:
      path: ../member-err
`,
        'utf8'
      );
      writeFileSync(
        join(homeDir, 'docs', 'index.md'),
        `---
mdlineage:
  schema: 1
  id: docs.home-idx
  kind: guide
  status: active
---
# Home
`,
        'utf8'
      );

      // Member doc with bad metadata (missing required status -> MDL102 error) and bad kind (MDL502)
      writeFileSync(
        join(memberDir, 'mdlineage.config.yaml'),
        `configVersion: 1
metadata:
  required: true
`,
        'utf8'
      );
      writeFileSync(
        join(memberDir, 'docs', 'bad.md'),
        `---
mdlineage:
  id: docs.member-bad
  kind: invalid_kind
---
# Bad Doc
`,
        'utf8'
      );

      const out = runCli(['check', '.', '--no-baseline', '--format', 'json'], homeDir);
      assert.equal(out.status, 0, 'Exit code sovereignty: member error capped to warning, exit is 0');

      const json = parseJson(out.stdout);
      const memberReport = json.reports.find((r) => r.path === '@member//docs/bad.md');
      assert.ok(memberReport, 'Member doc is present in reports');
      assert.ok(memberReport.diagnostics.length > 0, 'Member doc should have diagnostics');

      // Every external diagnostic severity must be warning or lower
      for (const diag of memberReport.diagnostics) {
        assert.notEqual(diag.severity, 'error', `Diagnostic ${diag.code} should be capped to warning`);
        assert.ok(!diag.code.startsWith('MDL5'), `Layout diagnostic ${diag.code} should be dropped`);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('case 21: --no-federation skips federated members and reports MDL401 on links to them', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mdl-cli-fed-'));
    try {
      const homeDir = join(tmp, 'home');
      const memberDir = join(tmp, 'member-x');
      mkdirSync(homeDir, { recursive: true });
      mkdirSync(join(homeDir, 'docs'), { recursive: true });
      mkdirSync(memberDir, { recursive: true });
      mkdirSync(join(memberDir, 'docs'), { recursive: true });

      writeFileSync(
        join(homeDir, 'mdlineage.config.yaml'),
        `configVersion: 1
federations:
  member:
    local:
      path: ../member-x
`,
        'utf8'
      );
      // Home doc with valid schema and link to member
      writeFileSync(
        join(homeDir, 'docs', 'index.md'),
        `---
mdlineage:
  schema: 1
  id: docs.home-idx
  kind: guide
  status: active
---
[Link to member](../../member-x/docs/doc.md)
`,
        'utf8'
      );
      writeFileSync(
        join(memberDir, 'docs', 'doc.md'),
        `---
mdlineage:
  schema: 1
  id: docs.member-doc
  kind: guide
  status: active
---
# Member
`,
        'utf8'
      );

      const out = runCli(['check', '.', '--no-baseline', '--no-federation', '--format', 'json'], homeDir);
      assert.equal(out.status, 0);

      const json = parseJson(out.stdout);
      // Member doc is NOT in reports
      assert.ok(!json.reports.some((r) => r.path.startsWith('@member//')));

      // Link to member is unresolved MDL401 warning
      const homeReport = json.reports.find((r) => r.path === 'docs/index.md');
      assert.ok(homeReport);
      assert.ok(homeReport.diagnostics.some((d) => d.code === 'MDL401'));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('case 22: circular federations produce MDL901 in check and config validate', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mdl-cli-fed-'));
    try {
      const homeDir = join(tmp, 'home');
      const memberDir = join(tmp, 'member-a');
      mkdirSync(homeDir, { recursive: true });
      mkdirSync(memberDir, { recursive: true });

      writeFileSync(
        join(homeDir, 'mdlineage.config.yaml'),
        `configVersion: 1
federations:
  member-a:
    local:
      path: ../member-a
`,
        'utf8'
      );
      writeFileSync(
        join(memberDir, 'mdlineage.config.yaml'),
        `configVersion: 1
federations:
  home-alias:
    local:
      path: ../home
`,
        'utf8'
      );

      // check reports MDL901 and exits 1
      const checkOut = runCli(['check', '.', '--format', 'json'], homeDir);
      assert.equal(checkOut.status, 1, `check should exit 1, got ${checkOut.status}`);
      const checkJson = parseJson(checkOut.stdout);
      assert.ok(
        checkJson.configDiagnostics.some((d) => d.code === 'MDL901'),
        'check reports MDL901 in configDiagnostics'
      );

      // config validate reports MDL901
      const valOut = runCli(['config', 'validate', '--format', 'json'], homeDir);
      assert.equal(valOut.status, 1);
      const valJson = JSON.parse(valOut.stdout) as { diagnostics: Array<{ code: string }> };
      assert.ok(valJson.diagnostics.some((d) => d.code === 'MDL901'));

      // --no-federation on check bypasses federation DFS and avoids MDL901
      const noFedOut = runCli(['check', '.', '--no-federation', '--format', 'json'], homeDir);
      const noFedJson = parseJson(noFedOut.stdout);
      assert.ok(!noFedJson.configDiagnostics.some((d) => d.code === 'MDL901'));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('B16: scoped relation in home resolves across member end-to-end', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mdl-cli-b16-'));
    try {
      const homeDir = join(tmp, 'home');
      const memberDir = join(tmp, 'member-a');
      mkdirSync(join(homeDir, 'docs'), { recursive: true });
      mkdirSync(join(memberDir, 'docs'), { recursive: true });

      writeFileSync(
        join(homeDir, 'mdlineage.config.yaml'),
        `configVersion: 1
federations:
  member-a:
    local:
      path: ../member-a
`,
        'utf8'
      );
      writeFileSync(
        join(homeDir, 'docs', 'index.md'),
        `---
mdlineage:
  schema: 1
  id: docs.home-idx
  kind: guide
  status: active
  relations:
    - type: related_to
      target: "@member-a//docs.fed-skills"
---
# Home Doc
`,
        'utf8'
      );
      writeFileSync(
        join(memberDir, 'docs', 'skills.md'),
        `---
mdlineage:
  schema: 1
  id: docs.fed-skills
  kind: guide
  status: active
---
# Member Skills
`,
        'utf8'
      );

      const out = runCli(['check', '.', '--no-baseline', '--format', 'json'], homeDir);
      assert.equal(out.status, 0, `check should exit 0, stderr: ${out.stderr}`);
      const json = parseJson(out.stdout);
      const homeReport = json.reports.find((r) => r.path === 'docs/index.md');
      assert.ok(homeReport);
      assert.equal(
        homeReport.diagnostics.find((d) => d.code === 'MDL302'),
        undefined,
        'Scoped target should resolve without MDL302'
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('B17: home wildcard target with two member claiming id produces MDL307 and exits 1', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mdl-cli-b17-'));
    try {
      const homeDir = join(tmp, 'home');
      const memberADir = join(tmp, 'member-a');
      const memberBDir = join(tmp, 'member-b');
      mkdirSync(join(homeDir, 'docs'), { recursive: true });
      mkdirSync(join(memberADir, 'docs'), { recursive: true });
      mkdirSync(join(memberBDir, 'docs'), { recursive: true });

      writeFileSync(
        join(homeDir, 'mdlineage.config.yaml'),
        `configVersion: 1
federations:
  member-a:
    local:
      path: ../member-a
  member-b:
    local:
      path: ../member-b
`,
        'utf8'
      );
      writeFileSync(
        join(homeDir, 'docs', 'index.md'),
        `---
mdlineage:
  schema: 1
  id: docs.home-idx
  kind: guide
  status: active
  relations:
    - type: depends_on
      target: "@*//docs.dup"
      reason: ambiguous wildcard
---
# Home Doc
`,
        'utf8'
      );
      writeFileSync(
        join(memberADir, 'docs', 'a.md'),
        `---
mdlineage:
  schema: 1
  id: docs.dup
  kind: guide
  status: active
---
# Member A Dup
`,
        'utf8'
      );
      writeFileSync(
        join(memberBDir, 'docs', 'b.md'),
        `---
mdlineage:
  schema: 1
  id: docs.dup
  kind: guide
  status: active
---
# Member B Dup
`,
        'utf8'
      );

      const out = runCli(['check', '.', '--no-baseline', '--format', 'json'], homeDir);
      assert.equal(out.status, 1, 'MDL307 in home repository must fail with exit code 1');
      const json = parseJson(out.stdout);
      const homeReport = json.reports.find((r) => r.path === 'docs/index.md');
      assert.ok(homeReport);
      const mdl307 = homeReport.diagnostics.find((d) => d.code === 'MDL307');
      assert.ok(mdl307, 'Must report MDL307');
      assert.equal(mdl307.severity, 'error');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('B18: --no-federation causes envelope target to fail with MDL302', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mdl-cli-b18-'));
    try {
      const homeDir = join(tmp, 'home');
      const memberDir = join(tmp, 'member-a');
      mkdirSync(join(homeDir, 'docs'), { recursive: true });
      mkdirSync(join(memberDir, 'docs'), { recursive: true });

      writeFileSync(
        join(homeDir, 'mdlineage.config.yaml'),
        `configVersion: 1
federations:
  member-a:
    local:
      path: ../member-a
`,
        'utf8'
      );
      writeFileSync(
        join(homeDir, 'docs', 'index.md'),
        `---
mdlineage:
  schema: 1
  id: docs.home-idx
  kind: guide
  status: active
  relations:
    - type: depends_on
      target: "@member-a//docs.fed-skills"
      reason: envelope with no fed
---
# Home Doc
`,
        'utf8'
      );
      writeFileSync(
        join(memberDir, 'docs', 'skills.md'),
        `---
mdlineage:
  schema: 1
  id: docs.fed-skills
  kind: guide
  status: active
---
# Member Skills
`,
        'utf8'
      );

      const out = runCli(['check', '.', '--no-federation', '--no-baseline', '--format', 'json'], homeDir);
      assert.equal(out.status, 1, 'Unresolvable envelope target under --no-federation exits 1');
      const json = parseJson(out.stdout);
      const homeReport = json.reports.find((r) => r.path === 'docs/index.md');
      assert.ok(homeReport);
      const mdl302 = homeReport.diagnostics.find((d) => d.code === 'MDL302');
      assert.ok(mdl302, 'Under --no-federation envelope target degrades to MDL302');
      assert.equal(mdl302.severity, 'error');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('home dangling bare id with missing:warn member reports MDL302 error and exits 1', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mdl-cli-bare-dangling-'));
    try {
      const homeDir = join(tmp, 'home');
      mkdirSync(join(homeDir, 'docs'), { recursive: true });

      writeFileSync(
        join(homeDir, 'mdlineage.config.yaml'),
        `configVersion: 1
federations:
  ghost-member:
    local:
      path: ../nonexistent-ghost
    missing: warn
`,
        'utf8'
      );
      writeFileSync(
        join(homeDir, 'docs', 'index.md'),
        `---
mdlineage:
  schema: 1
  id: docs.home-idx
  kind: guide
  status: active
  relations:
    - type: related_to
      target: docs.nonexistent
---
# Home Doc
`,
        'utf8'
      );

      const out = runCli(['check', '.', '--no-baseline', '--format', 'json'], homeDir);
      assert.equal(out.status, 1, 'Dangling bare id must exit 1');
      const json = parseJson(out.stdout);
      const homeReport = json.reports.find((r) => r.path === 'docs/index.md');
      assert.ok(homeReport);
      const mdl302 = homeReport.diagnostics.find((d) => d.code === 'MDL302');
      assert.ok(mdl302, 'Must report MDL302');
      assert.equal(mdl302.severity, 'error');
      const mdl308 = homeReport.diagnostics.find((d) => d.code === 'MDL308');
      assert.equal(mdl308, undefined, 'Must not report MDL308 for bare id');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('home with only missing:warn member and @scope// target mounts proxy, reports MDL308 hint and exits 0', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mdl-cli-all-missing-'));
    try {
      const homeDir = join(tmp, 'home');
      mkdirSync(join(homeDir, 'docs'), { recursive: true });

      writeFileSync(
        join(homeDir, 'mdlineage.config.yaml'),
        `configVersion: 1
federations:
  ghost-member:
    local:
      path: ../nonexistent-ghost
    missing: warn
`,
        'utf8'
      );
      writeFileSync(
        join(homeDir, 'docs', 'index.md'),
        `---
mdlineage:
  schema: 1
  id: docs.home-idx
  kind: guide
  status: active
  relations:
    - type: related_to
      target: "@ghost-member//docs.x"
---
# Home Doc
`,
        'utf8'
      );

      const out = runCli(['check', '.', '--no-baseline', '--format', 'json'], homeDir);
      assert.equal(out.status, 0, 'MDL308 hint must exit 0');
      const json = parseJson(out.stdout);
      const homeReport = json.reports.find((r) => r.path === 'docs/index.md');
      assert.ok(homeReport);
      const mdl308 = homeReport.diagnostics.find((d) => d.code === 'MDL308');
      assert.ok(mdl308, 'Must report MDL308 for missing-scope target');
      assert.equal(mdl308.severity, 'hint');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
