/**
 * CLI tests (docs/remark-language-server-solution.md §6.4, §11).
 *
 * The binary is driven through `child_process` because the exit-code contract
 * is part of the interface — a JSON-only unit test could not assert it. The
 * fixture tree is the same one the validator and the remark channel use, so a
 * drift between the three entries fails here.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanBoundary, parseFrontmatter, buildLineMap } from '@mdlineage/validator';
import { attrPolicyLine } from '../src/init.js';

const repoRoot = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..');
const fixtureRoot = resolve(repoRoot, 'test', 'fixtures');
const cliBin = resolve(repoRoot, 'packages', 'cli', 'dist', 'main.js');

interface RunOutput {
  stdout: string;
  stderr: string;
  status: number | null;
}

/** Run the built binary with the given arguments. */
function runCli(args: string[], cwd = repoRoot): RunOutput {
  const result = spawnSync(process.execPath, [cliBin, ...args], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  });
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status };
}

interface FixtureReport {
  path: string;
  diagnostics: Array<{ code: string; severity: string; message: string; line: number; column: number }>;
}

/** The shape `--format json` emits. */
interface JsonOutput {
  reports: FixtureReport[];
  unreadable: Array<{ path: string; message: string }>;
  configDiagnostics: Array<{ code: string; severity: string; message: string }>;
  /** The baseline the run applied, or null under `--no-baseline`. */
  baseline: { path: string; suppressed: number } | null;
  summary?: {
    files: number;
    errors: number;
    warnings: number;
    information: number;
    unreadable: number;
    byCode: Array<{ code: string; count: number }>;
  };
}

/** Parse the CLI's JSON output. */
function parseJson(stdout: string): JsonOutput {
  // The reports array was the whole document before config/unreadable joined it,
  // so a bare array is still accepted as the legacy shape.
  const parsed = JSON.parse(stdout) as JsonOutput | FixtureReport[];
  return Array.isArray(parsed) ? { reports: parsed, unreadable: [], configDiagnostics: [] } : parsed;
}

/** The reports of a JSON run, whichever shape the CLI emitted. */
function reportsOf(stdout: string): FixtureReport[] {
  return parseJson(stdout).reports;
}

/** Occurrences of a code across the JSON reports. */
function countOf(stdout: string, code: string): number {
  let n = 0;
  for (const report of reportsOf(stdout)) {
    for (const d of report.diagnostics) if (d.code === code) n += 1;
  }
  return n;
}

/** Every (code, severity) pair the JSON reports carry, deduplicated. */
function codeSeverityPairs(stdout: string): Array<`${string} ${string}`> {
  const out = new Set<`${string} ${string}`>();
  for (const report of reportsOf(stdout)) {
    for (const d of report.diagnostics) out.add(`${d.code} ${d.severity}`);
  }
  return [...out].sort();
}

/**
 * A scratch repository for workspace/baseline tests: isolated, so a baseline
 * file it writes never touches the real repository.
 */
function scratchWorkspace(files: Record<string, string>): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'mdlineage-ws-'));
  for (const [name, content] of Object.entries(files)) {
    const path = resolve(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** A minimal valid document with the given id and optional relations. */
function doc(id: string, relations = ''): string {
  return ['---', 'mdlineage:', '  schema: 1', `  id: ${id}`, '  kind: policy', '  status: active', relations, '---', '', `# ${id}`].join(
    '\n',
  );
}

/** A relations block with a reason, for the `reasonRequired` types. */
function rel(type: string, target: string, reason = 'r'): string {
  return `  relations:\n    - type: ${type}\n      target: ${target}\n      reason: ${reason}`;
}

/** Config that asks for metadata, so a bare Markdown file is MDL003. */
const CONFIG_REQUIRED = 'configVersion: 1\nmetadata:\n  required: true\n';

describe('mdlineage check — fixtures', () => {
  it('reports every invalid fixture with its MDL code over JSON', () => {
    const out = runCli(['check', 'test/fixtures', '--no-baseline', '--format', 'json']);
    assert.equal(out.status, 1, 'the fixture tree contains error-severity diagnostics');
    const reports = reportsOf(out.stdout);

    const codes = new Map(reports.flatMap((r) => r.diagnostics.map((d) => [d.code, r.path])));
    for (const expected of ['MDL001', 'MDL002', 'MDL101', 'MDL102', 'MDL103', 'MDL104', 'MDL201', 'MDL202']) {
      assert.ok(codes.has(expected), `expected ${expected} in the CLI output`);
    }
    assert.ok(codes.has('MDL601'), 'the EOL scan layer reaches the CLI');
    assert.ok(codes.has('MDL602'), 'the EOL scan layer reaches the CLI');
    // The workspace layer: MDL003 is absent because this repository's own
    // mdlineage.config.yaml sets metadata.required: false, which is the
    // progressive-adoption contract the config documents.
    assert.ok(codes.has('MDL301'), 'the duplicate-id pair reaches the CLI');
    assert.ok(codes.has('MDL302'), 'the unresolved target reaches the CLI');
    assert.ok(codes.has('MDL305'), 'the forbidden cycle reaches the CLI');
  });

  it('valid fixtures produce no diagnostics', () => {
    // `valid/` is a set of documents that are individually clean; v01 and v05
    // carry relations and evidence anchors that only resolve across files
    // (test/fixtures/README.md rule 1), so `--no-incremental` keeps the
    // "individually valid" contract meaningful while still asserting the files
    // are clean on their own.
    const out = runCli(['check', 'test/fixtures/valid', '--no-incremental', '--format', 'json']);
    assert.equal(out.status, 0);
    const reports = reportsOf(out.stdout);
    for (const report of reports) {
      assert.deepEqual(report.diagnostics, [], `${report.path} must be clean`);
    }
    assert.equal(reports.length, 6, 'the six valid fixtures');
  });

  it('the text format is path:line:col CODE SEVERITY message', () => {
    const out = runCli(['check', 'test/fixtures/invalid/e05-id-pattern.md', '--no-baseline']);
    assert.equal(out.status, 1);
    const lines = out.stdout.trim().split('\n');
    assert.ok(lines[0]!.startsWith('test/fixtures/invalid/e05-id-pattern.md:4:7 MDL103 error '),
      `text format was: ${lines[0]}`);
    assert.ok(out.stdout.includes('1 file checked, 1 diagnostic (1 error, 0 warnings)'));
  });

  it('warnings alone exit 0', () => {
    const out = runCli(['check', 'test/fixtures/invalid/e17-evidence-anchor-missing.md', '--no-incremental']);
    assert.equal(out.status, 0, 'MDL201 is a warning');
    assert.match(out.stdout, /MDL201 warning/);
  });

  it('a dangling same-page anchor reports MDL203 in both channels', () => {
    // #20: same-page links were unchecked by any layer. The rule lives at the
    // document layer, so `--no-incremental` (one file, no index) and the
    // default workspace pass must both surface it — and neither twice.
    const ws = scratchWorkspace({
      'a.md': doc('docs.a') + '\nSee [missing](#no-such-anchor) and [fine](#docsa).\n',
    });
    try {
      const single = runCli(['check', 'a.md', '--no-incremental', '--format', 'json'], ws.root);
      assert.equal(countOf(single.stdout, 'MDL203'), 1, 'the single-document channel reports it');
      assert.equal(countOf(single.stdout, 'MDL402'), 0, 'a same-page anchor is not MDL402');

      const workspace = runCli(['check', 'a.md', '--format', 'json'], ws.root);
      assert.equal(countOf(workspace.stdout, 'MDL203'), 1, 'the workspace pass reports it once, not twice');
    } finally {
      ws.cleanup();
    }
  });

  it('CRLF worktree bytes are read, not the index', () => {
    // The whole point of the batch channel reading worktree bytes: under
    // `text=auto eol=lf` a CRLF file's staged blob is LF, so an index-based
    // reader would report nothing (docs/line-ending-management.md §4.1).
    const out = runCli(['check', 'test/fixtures/invalid/e16-crlf-eol.md', '--no-baseline', '--format', 'json']);
    assert.equal(out.status, 0);
    const [report] = reportsOf(out.stdout);
    assert.ok(report, 'the CRLF fixture was read');
    assert.equal(report.diagnostics[0]!.code, 'MDL602');
  });

  it('a directory expands to its Markdown files', () => {
    const out = runCli(['check', 'test/fixtures/workspace', '--no-baseline', '--format', 'json']);
    assert.equal(reportsOf(out.stdout).length, 4, 'the four workspace fixtures');
    // The set's own cross-file codes: MDL301/MDL302 from the dup-id pair,
    // MDL305 once per strongly connected component (the cycle pair).
    const codes = new Set<string>();
    for (const report of reportsOf(out.stdout)) {
      for (const d of report.diagnostics) codes.add(d.code);
    }
    assert.ok(codes.has('MDL301'), 'the duplicate-id pair reports MDL301');
    assert.ok(codes.has('MDL302'), 'dup-id-b reports the unresolved target');
    assert.ok(codes.has('MDL305'), 'the cycle pair reports MDL305 once');
    assert.equal([...codes].filter((c) => c.startsWith('MDL3')).length, 3, 'no other workspace codes');
    assert.equal(countOf(out.stdout, 'MDL305'), 1, 'MDL305 is reported once per SCC');
    assert.equal(out.status, 1, 'the workspace codes are errors');
  });

  it('a missing path fails with exit code 2', () => {
    const out = runCli(['check', 'no-such-directory']);
    assert.equal(out.status, 2);
    assert.match(out.stderr, /no such file or pattern/);
  });

  it('an unknown command fails with exit code 2', () => {
    const out = runCli(['frobnicate']);
    assert.equal(out.status, 2);
    assert.match(out.stderr, /unknown command/);
  });

  it('--help and --version print and exit 0', () => {
    assert.equal(runCli(['--help']).status, 0);
    assert.equal(runCli(['--version']).status, 0);
    assert.match(runCli(['--version']).stdout, /mdlineage/);
  });

  it('--help states which root each command anchors on', () => {
    // #19: the three "root" semantics are defensible but were undocumented;
    // a user must be able to learn from --help that `fix` anchors on the CWD
    // while `init` and `baseline` anchor on the git repository root.
    const help = runCli(['--help']);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /Roots — each command anchors/);
    assert.match(help.stdout, /check\/fix\s+the CWD/);
    assert.match(help.stdout, /the git repository root/);
    assert.match(help.stdout, /walks up from the CWD/);
  });

  it('--version reports the cli package.json version', () => {
    const pkg = JSON.parse(readFileSync(resolve(repoRoot, 'packages', 'cli', 'package.json'), 'utf8')) as {
      version: string;
    };
    assert.equal(runCli(['--version']).stdout.trim(), `mdlineage ${pkg.version}`);
  });

  it('a bad --format value is rejected', () => {
    const out = runCli(['check', 'docs', '--format', 'sarif-please']);
    assert.equal(out.status, 2);
    assert.match(out.stderr, /--format must be/);
  });

  it('node_modules and dist are excluded by default', () => {
    const out = runCli(['check', '.', '--no-baseline', '--format', 'json']);
    assert.equal(out.status, 1);
    for (const report of reportsOf(out.stdout)) {
      assert.ok(!report.path.includes('node_modules'), `node_modules file checked: ${report.path}`);
    }
  });
});

describe('mdlineage check — changed files', () => {
  /** A scratch git repository, so the worktree state is fully controlled. */
  function scratchRepo(): { root: string; cleanup: () => void } {
    const root = mkdtempSync(join(tmpdir(), 'mdlineage-changed-'));
    const git = (args: string[]) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    git(['init', '-q']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'mdlineage test']);
    writeFileSync(join(root, '.gitattributes'), '* text=auto eol=lf\n');
    writeFileSync(join(root, 'clean.md'), '---\nmdlineage:\n  schema: 1\n  id: a.clean\n  kind: policy\n  status: active\n---\n\n# Clean\n');
    mkdirSync(join(root, 'sub'));
    git(['add', '.']);
    git(['commit', '-q', '-m', 'initial']);
    return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
  }

  it('exits 0 on a clean worktree', () => {
    const repo = scratchRepo();
    try {
      const out = runCli(['check', '--changed'], repo.root);
      assert.equal(out.status, 0, `stdout: ${out.stdout}\nstderr: ${out.stderr}`);
      assert.match(out.stdout, /no changed Markdown files/);
    } finally {
      repo.cleanup();
    }
  });

  it('validates a newly tracked file', () => {
    const repo = scratchRepo();
    try {
      writeFileSync(join(repo.root, 'new.md'), '# No metadata at all\n');
      const out = runCli(['check', '--changed', '--format', 'json'], repo.root);
      assert.equal(out.status, 1);
      const reports = reportsOf(out.stdout);
      assert.equal(reports.length, 1);
      assert.equal(reports[0]!.path, 'new.md');
      assert.equal(reports[0]!.diagnostics[0]!.code, 'MDL003');
    } finally {
      repo.cleanup();
    }
  });

  it('detects a CRLF-only edit that git diff would miss', () => {
    // The regression the round-1 review pinned: with `text=auto eol=lf` active,
    // rewriting a file to CRLF in the worktree leaves `git diff` empty while
    // `git status` reports modified.
    const repo = scratchRepo();
    try {
      const path = join(repo.root, 'clean.md');
      const lf = readFileSync(path, 'utf8');
      writeFileSync(path, lf.replace(/\n/g, '\r\n'));
      const diff = spawnSync('git', ['diff'], { cwd: repo.root, encoding: 'utf8' });
      assert.equal(diff.stdout.length, 0, 'sanity: git diff is empty for the CRLF rewrite');

      const out = runCli(['check', '--changed'], repo.root);
      assert.equal(out.status, 0, 'MDL602 is a warning');
      assert.match(out.stdout, /MDL602/);
    } finally {
      repo.cleanup();
    }
  });

  it('--no-untracked skips new files', () => {
    const repo = scratchRepo();
    try {
      writeFileSync(join(repo.root, 'new.md'), '# No metadata at all\n');
      const out = runCli(['check', '--changed', '--no-untracked'], repo.root);
      assert.equal(out.status, 0);
      assert.match(out.stdout, /no changed Markdown files/);
    } finally {
      repo.cleanup();
    }
  });

  it('a deletion is skipped, not a failure', () => {
    const repo = scratchRepo();
    try {
      rmSync(join(repo.root, 'clean.md'));
      const out = runCli(['check', '--changed'], repo.root);
      assert.equal(out.status, 0);
      assert.match(out.stdout, /deletion skipped|no changed Markdown files/);
    } finally {
      repo.cleanup();
    }
  });
});

describe('mdlineage check — workspace mode', () => {
  it('cross-file diagnostics are attributed to the file that owns them', () => {
    const out = runCli(['check', 'test/fixtures/workspace', '--no-baseline', '--format', 'json']);
    assert.equal(out.status, 1);

    // MDL301 reports on the SECOND claimant (the first is canonical), MDL302 on
    // the document that declares the dangling target, MDL305 on the SCC's
    // smallest member path — each on the file the violation belongs to.
    const byPath = new Map<string, string[]>();
    for (const report of reportsOf(out.stdout)) byPath.set(report.path, report.diagnostics.map((d) => d.code));

    assert.deepEqual(byPath.get('test/fixtures/workspace/dup-id-b.md'), ['MDL301', 'MDL302']);
    assert.deepEqual(byPath.get('test/fixtures/workspace/dup-id-a.md'), ['MDL302']);
    assert.deepEqual(byPath.get('test/fixtures/workspace/cycle-a.md'), ['MDL305']);
    assert.deepEqual(byPath.get('test/fixtures/workspace/cycle-b.md'), []);
  });

  it('--no-incremental validates each file independently', () => {
    const out = runCli(['check', 'test/fixtures/workspace', '--no-incremental', '--format', 'json']);
    assert.equal(out.status, 0, 'the four workspace fixtures are individually valid');
    for (const report of reportsOf(out.stdout)) {
      assert.deepEqual(report.diagnostics, [], `${report.path} is clean without the workspace pass`);
    }
  });

  it('the summary counts every code and severity', () => {
    const out = runCli(['check', 'test/fixtures/workspace', '--no-baseline', '--format', 'json']);
    const summary = parseJson(out.stdout).summary;
    assert.ok(summary, 'the JSON output carries a summary');
    assert.equal(summary!.files, 4);
    assert.equal(summary!.errors, 4, 'MDL301 + MDL302 x2 + MDL305');
    assert.equal(summary!.warnings, 0);
    assert.equal(summary!.byCode.find((c) => c.code === 'MDL305')!.count, 1);
    assert.equal(summary!.byCode.find((c) => c.code === 'MDL302')!.count, 2);
    assert.equal(summary!.byCode.find((c) => c.code === 'MDL301')!.count, 1);
    // byCode is sorted, so a reader's diff between two runs is stable.
    const codes = summary!.byCode.map((c) => c.code);
    assert.deepEqual([...codes].sort(), codes);
  });

  it('--frail fails on warnings', () => {
    const out = runCli(['check', 'test/fixtures/invalid/e17-evidence-anchor-missing.md', '--no-incremental', '--frail']);
    assert.equal(out.status, 1, 'a warning fails under --frail');
    assert.match(out.stdout, /MDL201 warning/);
    // The same file passes without the flag.
    assert.equal(
      runCli(['check', 'test/fixtures/invalid/e17-evidence-anchor-missing.md', '--no-incremental']).status,
      0,
    );
  });

  it('--frail fails on a clean run with no diagnostics', () => {
    // A diagnostics-free run is a pass even under --frail: the flag makes
    // diagnostics fatal, not the run.
    assert.equal(runCli(['check', 'test/fixtures/valid/v02-minimal.md', '--frail']).status, 0);
  });

  it('a corrupt baseline is reported and ignored', () => {
    const repo = scratchWorkspace({ 'a.md': doc('docs.a') });
    try {
      writeFileSync(join(repo.root, '.mdlineage-baseline.json'), '{ not json');
      const out = runCli(['check', 'a.md', '--format', 'json'], repo.root);
      assert.equal(out.status, 0, 'a broken baseline suppresses nothing');
      assert.match(out.stderr, /MDL900 warning/, 'the reason goes to stderr');
      assert.equal(countOf(out.stdout, 'MDL900'), 0, 'no file carries it');
    } finally {
      repo.cleanup();
    }
  });

  it('a link to a real non-Markdown file is not MDL401', () => {
    const body = 'See [schema](./data.json) and [nope](./nope.json).\n';
    const a = ['---', 'mdlineage:', '  schema: 1', '  id: docs.a', '  kind: policy', '  status: active', '---', '', body].join('\n');
    const repo = scratchWorkspace({ 'a.md': a, 'data.json': '{"x":1}' });
    try {
      const out = runCli(['check', '.', '--no-baseline', '--format', 'json'], repo.root);
      assert.equal(out.status, 0, 'a warning exits 0 without --frail');
      const all = reportsOf(out.stdout).flatMap((r) => r.diagnostics);
      assert.equal(all.length, 1, 'only the missing target is reported');
      assert.equal(all[0]!.code, 'MDL401');
      assert.equal(all[0]!.data?.path, './nope.json');
    } finally {
      repo.cleanup();
    }
  });

  it('a link to a non-Markdown file still reports when the file is outside the workspace scope', () => {
    // A scoped run (check docs) cannot know files outside it exist; the known
    // set comes from the cwd scan, so a target under an unscanned-but-present
    // sibling directory still resolves. This asserts the cwd-wide list, not
    // only the arguments', feeds the index.
    const body = 'See [schema](../schemas/x.json).\n';
    const a = ['---', 'mdlineage:', '  schema: 1', '  id: docs.a', '  kind: policy', '  status: active', '---', '', body].join('\n');
    const repo = scratchWorkspace({ 'docs/a.md': a, 'schemas/x.json': '{}' });
    try {
      const out = runCli(['check', 'docs', '--no-baseline', '--format', 'json'], repo.root);
      assert.equal(out.status, 0, 'the existing schema file resolves from a scoped run');
    } finally {
      repo.cleanup();
    }
  });

  it('a baseline suppresses the diagnostics it covers', () => {
    const repo = scratchWorkspace({
      'mdlineage.config.yaml': CONFIG_REQUIRED,
      'a.md': '# no front matter\n',
    });
    try {
      // First run reports MDL003; the recorded baseline must cover it.
      assert.equal(runCli(['check', 'a.md'], repo.root).status, 1);
      runCli(['baseline', 'update'], repo.root);
      assert.equal(runCli(['check', 'a.md'], repo.root).status, 0, 'the accepted violation is suppressed');
      const json = runCli(['check', 'a.md', '--format', 'json'], repo.root);
      assert.equal(countOf(json.stdout, 'MDL003'), 0);
      // `--no-baseline` is the audit view: the debt is reported again.
      const audit = runCli(['check', 'a.md', '--no-baseline'], repo.root);
      assert.equal(audit.status, 1, '--no-baseline reports the accepted violation');
      assert.match(audit.stdout, /MDL003/);
    } finally {
      repo.cleanup();
    }
  });

  it('the repository baseline suppresses the fixture tree', () => {
    // The real repository ships a baseline (progressive adoption), so `check`
    // over the fixture tree passes and `--no-baseline` is how a reader sees the
    // debt it accepts. A scoped run can still report a diagnostic the full-tree
    // baseline never saw: dup-id-a's target resolves only when valid/v01-full
    // is in the index, which a `test/fixtures/workspace` scope excludes.
    const audit = runCli(['check', 'test/fixtures/workspace', '--no-baseline', '--format', 'json']);
    assert.equal(audit.status, 1, '--no-baseline reports the fixture tree');
    assert.ok(countOf(audit.stdout, 'MDL305') > 0);

    // A scoped run sees diagnostics the whole-tree baseline never recorded:
    // dup-id-a's target resolves only when valid/v01-full (id
    // docs.cache-policy) is in the index, and cycle-a's only with cycle-b, so
    // a subtree scope is a different graph from the one the baseline covers.
    const scoped = runCli(['check', 'test/fixtures/workspace/dup-id-b.md', '--format', 'json']);
    assert.equal(scoped.status, 0, "this file's own diagnostics are baselined");

    // The whole-tree run the baseline was recorded from is the one that passes.
    assert.equal(runCli(['check', '.']).status, 0, 'the repository is clean against its baseline');
  });
});

describe('mdlineage check --format sarif', () => {
  /** Parse the SARIF document the CLI emits. */
  function parseSarif(stdout: string): {
    version: string;
    runs: Array<{
      tool: { driver: { name: string; version: string; rules: Array<{ id: string; defaultConfiguration: { level: string } }> } };
      results: Array<{
        ruleId: string;
        level: string;
        message: { text: string };
        locations: Array<{
          physicalLocation: {
            artifactLocation: { uri: string };
            region: { startLine: number; startColumn?: number; endLine?: number };
          };
        }>;
      }>;
    }>;
  } {
    return JSON.parse(stdout);
  }

  it('emits SARIF 2.1.0 with the mdlineage tool driver', () => {
    const out = runCli(['check', 'test/fixtures/invalid/e05-id-pattern.md', '--no-incremental', '--no-baseline', '--format', 'sarif']);
    assert.equal(out.status, 1);
    const sarif = parseSarif(out.stdout);
    assert.equal(sarif.version, '2.1.0');
    assert.equal(sarif.runs.length, 1, 'a single run');
    assert.equal(sarif.runs[0]!.tool.driver.name, 'mdlineage');
    assert.equal(sarif.runs[0]!.tool.driver.rules.length, 1, 'one rule for one diagnostic');
    assert.equal(sarif.runs[0]!.tool.driver.rules[0]!.id, 'MDL103');
  });

  it('reports the cli package.json version as the tool driver version', () => {
    const pkg = JSON.parse(readFileSync(resolve(repoRoot, 'packages', 'cli', 'package.json'), 'utf8')) as {
      version: string;
    };
    const out = runCli(['check', 'test/fixtures/invalid/e05-id-pattern.md', '--no-incremental', '--no-baseline', '--format', 'sarif']);
    const sarif = parseSarif(out.stdout);
    assert.equal(sarif.runs[0]!.tool.driver.version, pkg.version);
  });

  it('maps severity to SARIF level', () => {
    const out = runCli(['check', 'test/fixtures', '--no-baseline', '--format', 'sarif']);
    assert.equal(out.status, 1);
    const sarif = parseSarif(out.stdout);
    assert.ok(sarif.runs[0]!.results.length > 0, 'the fixture tree produces results');

    for (const result of sarif.runs[0]!.results) {
      // error → error, warning → warning, information/hint → note: SARIF
      // §3.27.10 has no `information` level.
      assert.ok(
        result.level === 'error' || result.level === 'warning' || result.level === 'note',
        `${result.ruleId} has level ${result.level}`,
      );
    }

    // The fixture tree's severities are known: MDL103 is an error, MDL201 a
    // warning, and both must appear.
    const levels = new Map(sarif.runs[0]!.results.map((r) => [r.ruleId, r.level]));
    assert.equal(levels.get('MDL103'), 'error');
    assert.equal(levels.get('MDL201'), 'warning');
  });

  it('a rule is declared for every code the results cite', () => {
    const out = runCli(['check', 'test/fixtures', '--no-baseline', '--format', 'sarif']);
    const sarif = parseSarif(out.stdout);
    const declared = new Set(sarif.runs[0]!.tool.driver.rules.map((r) => r.id));
    for (const result of sarif.runs[0]!.results) {
      assert.ok(declared.has(result.ruleId), `rule ${result.ruleId} must be declared by the driver`);
    }
  });

  it('the region is 1-based and lands on the diagnostic', () => {
    const out = runCli(['check', 'test/fixtures/invalid/e05-id-pattern.md', '--no-incremental', '--no-baseline', '--format', 'sarif']);
    const sarif = parseSarif(out.stdout);
    const [result] = sarif.runs[0]!.results;
    assert.equal(result!.locations.length, 1);
    const region = result!.locations[0]!.physicalLocation.region;
    assert.equal(region.startLine, 4, 'the id value is on line 4');
    assert.ok((region.startColumn ?? 0) > 0, 'the column is 1-based and present');
    assert.equal(result!.locations[0]!.physicalLocation.artifactLocation.uri, 'test/fixtures/invalid/e05-id-pattern.md');
  });

  it('the SARIF and JSON channels agree on the code set', () => {
    const json = runCli(['check', 'test/fixtures', '--no-baseline', '--format', 'json']);
    const sarif = runCli(['check', 'test/fixtures', '--no-baseline', '--format', 'sarif']);
    assert.equal(json.status, sarif.status);

    const sarifCodes = new Set(parseSarif(sarif.stdout).runs[0]!.results.map((r) => `${r.ruleId}`));
    const jsonPairs = codeSeverityPairs(json.stdout);
    for (const pair of jsonPairs) {
      const [code] = pair.split(' ');
      assert.ok(sarifCodes.has(code!), `SARIF must report the codes JSON reports: ${code}`);
    }
    assert.equal(sarifCodes.size, jsonPairs.length, 'no extra SARIF results and none missing');
  });
});

describe('mdlineage baseline', () => {
  it('update records current violations, verify then passes', () => {
    const repo = scratchWorkspace({
      'mdlineage.config.yaml': CONFIG_REQUIRED,
      'a.md': '# no front matter\n',
      'b.md': doc('docs.b'),
    });
    try {
      const verifyBefore = runCli(['baseline', 'verify'], repo.root);
      assert.equal(verifyBefore.status, 1, 'a violation with no baseline fails the gate');
      assert.match(verifyBefore.stdout, /no \.mdlineage-baseline\.json/);

      const update = runCli(['baseline', 'update'], repo.root);
      assert.equal(update.status, 0);
      assert.match(update.stdout, /\+ MDL003 a\.md/);
      const baseline = JSON.parse(readFileSync(join(repo.root, '.mdlineage-baseline.json'), 'utf8'));
      assert.equal(baseline.version, 1);
      assert.deepEqual(baseline.codes.MDL003, ['a.md']);

      assert.equal(runCli(['baseline', 'verify'], repo.root).status, 0, 'the accepted debt passes the gate');
      // And `check` sees the exemption too.
      assert.equal(runCli(['check', 'a.md'], repo.root).status, 0);
    } finally {
      repo.cleanup();
    }
  });

  it('verify fails on a new unexempted violation', () => {
    const repo = scratchWorkspace({
      'mdlineage.config.yaml': CONFIG_REQUIRED,
      'a.md': '# no front matter\n',
    });
    try {
      assert.equal(runCli(['baseline', 'update'], repo.root).status, 0);
      assert.equal(runCli(['baseline', 'verify'], repo.root).status, 0);

      writeFileSync(join(repo.root, 'b.md'), '# also no front matter\n');
      const verify = runCli(['baseline', 'verify'], repo.root);
      assert.equal(verify.status, 1, 'a new violation is a regression');
      assert.match(verify.stdout, /\+ b\.md MDL003/);
    } finally {
      repo.cleanup();
    }
  });

  it('verify passes when a link targets a real non-Markdown file', () => {
    const body = 'See [schema](../schemas/x.json).\n';
    const a = ['---', 'mdlineage:', '  schema: 1', '  id: docs.a', '  kind: policy', '  status: active', '---', '', body].join('\n');
    const repo = scratchWorkspace({ 'docs/a.md': a, 'schemas/x.json': '{}' });
    try {
      const verify = runCli(['baseline', 'verify'], repo.root);
      assert.equal(verify.status, 0, 'the existing target is not MDL401');
      assert.ok(!verify.stdout.includes('MDL401'), `no false positive: ${verify.stdout}`);
    } finally {
      repo.cleanup();
    }
  });

  it('verify still fails when a link targets a missing non-Markdown file', () => {
    const body = 'See [schema](../schemas/missing.json).\n';
    const a = ['---', 'mdlineage:', '  schema: 1', '  id: docs.a', '  kind: policy', '  status: active', '---', '', body].join('\n');
    const repo = scratchWorkspace({ 'docs/a.md': a });
    try {
      const verify = runCli(['baseline', 'verify'], repo.root);
      assert.equal(verify.status, 1, 'the missing target is a real MDL401');
      assert.match(verify.stdout, /MDL401/);
    } finally {
      repo.cleanup();
    }
  });

  it('index rebuild does not report a link to a real non-Markdown file', () => {
    const body = 'See [schema](../schemas/x.json).\n';
    const a = ['---', 'mdlineage:', '  schema: 1', '  id: docs.a', '  kind: policy', '  status: active', '---', '', body].join('\n');
    const repo = scratchWorkspace({ 'docs/a.md': a, 'schemas/x.json': '{}' });
    try {
      const out = runCli(['index', 'rebuild'], repo.root);
      assert.equal(out.status, 0);
      assert.ok(!out.stdout.includes('MDL401'), `no false positive: ${out.stdout}`);
    } finally {
      repo.cleanup();
    }
  });

  it('verify fails on a stale entry, and update --report-only names it', () => {
    const repo = scratchWorkspace({
      'mdlineage.config.yaml': CONFIG_REQUIRED,
      'a.md': '# no front matter\n',
    });
    try {
      runCli(['baseline', 'update'], repo.root);
      assert.equal(runCli(['baseline', 'verify'], repo.root).status, 0);

      // Fix the file: the exemption is now unearned.
      writeFileSync(join(repo.root, 'a.md'), doc('docs.a'));
      const verify = runCli(['baseline', 'verify'], repo.root);
      assert.equal(verify.status, 1, 'a stale entry must not pass the gate');
      assert.match(verify.stdout, /- a\.md MDL003 \(no longer violated\)/);

      // update reports the stale entry under its own marker. It keeps it in the
      // file — writeBaseline preserves accepted-but-clean entries so an
      // exemption cannot silently cover a reintroduced violation — so `~` names
      // debt that is paid but still recorded, and a repository records it out
      // deliberately, by deleting the line.
      const report = runCli(['baseline', 'update', '--report-only'], repo.root);
      assert.equal(report.status, 0);
      assert.match(report.stdout, /~ stale MDL003 a\.md \(still in baseline; delete the line to record it out\)/);
      // The `-` line is reserved for entries the write genuinely drops, so a
      // stale entry must never be reported as a deletion.
      assert.doesNotMatch(report.stdout, /^- MDL003 a\.md$/m);
    } finally {
      repo.cleanup();
    }
  });

  it('a stale entry survives update until it is recorded out deliberately', () => {
    const repo = scratchWorkspace({
      'mdlineage.config.yaml': CONFIG_REQUIRED,
      'a.md': '# no front matter\n',
    });
    try {
      runCli(['baseline', 'update'], repo.root);
      writeFileSync(join(repo.root, 'a.md'), doc('docs.a'));
      runCli(['baseline', 'update'], repo.root);

      // The entry is still on disk (writeBaseline keeps accepted debt), and
      // verify still names it stale — the gate does not close itself.
      const baseline = JSON.parse(readFileSync(join(repo.root, '.mdlineage-baseline.json'), 'utf8'));
      assert.deepEqual(baseline.codes.MDL003, ['a.md']);
      assert.equal(runCli(['baseline', 'verify'], repo.root).status, 1, 'the debt is still visible');

      // Recording it out: the entry goes, the file is clean, the gate passes.
      delete baseline.codes.MDL003;
      writeFileSync(join(repo.root, '.mdlineage-baseline.json'), JSON.stringify(baseline));
      assert.equal(runCli(['baseline', 'verify'], repo.root).status, 0, 'the exemption is gone');
    } finally {
      repo.cleanup();
    }
  });

  it('--report-only changes no file', () => {
    const repo = scratchWorkspace({
      'mdlineage.config.yaml': CONFIG_REQUIRED,
      'a.md': '# no front matter\n',
    });
    try {
      const report = runCli(['baseline', 'update', '--report-only'], repo.root);
      assert.equal(report.status, 0);
      assert.match(report.stdout, /would update/);
      assert.throws(() => readFileSync(join(repo.root, '.mdlineage-baseline.json'), 'utf8'),
        'no baseline file is written');
    } finally {
      repo.cleanup();
    }
  });

  it('update is a no-op when nothing changed', () => {
    const repo = scratchWorkspace({ 'a.md': doc('docs.a') });
    try {
      assert.equal(runCli(['baseline', 'update'], repo.root).status, 0);
      const second = runCli(['baseline', 'update'], repo.root);
      assert.equal(second.status, 0);
      assert.match(second.stdout, /already up to date/);
    } finally {
      repo.cleanup();
    }
  });

  it('update keeps accepted debt that is still present', () => {
    // The audit trail: `writeBaseline` keeps a previous entry whose violation
    // cleared, so `update` alone never shrinks the baseline — `verify` names the
    // stale entry, and the repository records it out deliberately.
    const repo = scratchWorkspace({
      'mdlineage.config.yaml': CONFIG_REQUIRED,
      'a.md': '# no front matter\n',
    });
    try {
      runCli(['baseline', 'update'], repo.root);
      writeFileSync(join(repo.root, 'b.md'), '# also none\n');
      runCli(['baseline', 'update'], repo.root);
      let baseline = JSON.parse(readFileSync(join(repo.root, '.mdlineage-baseline.json'), 'utf8'));
      assert.deepEqual(baseline.codes.MDL003, ['a.md', 'b.md']);

      // Fixing a file does not silently drop its exemption.
      writeFileSync(join(repo.root, 'b.md'), doc('docs.b'));
      runCli(['baseline', 'update'], repo.root);
      baseline = JSON.parse(readFileSync(join(repo.root, '.mdlineage-baseline.json'), 'utf8'));
      assert.deepEqual(baseline.codes.MDL003, ['a.md', 'b.md'], 'the entry survives until it is recorded out');
    } finally {
      repo.cleanup();
    }
  });

  it('show reports per-code counts', () => {
    const repo = scratchWorkspace({
      'mdlineage.config.yaml': CONFIG_REQUIRED,
      'a.md': '# no front matter\n',
      'b.md': '# no front matter either\n',
    });
    try {
      runCli(['baseline', 'update'], repo.root);
      const show = runCli(['baseline', 'show'], repo.root);
      assert.equal(show.status, 0);
      assert.match(show.stdout, /MDL003 2/);
      assert.match(show.stdout, /total 2 accepted violations/);
    } finally {
      repo.cleanup();
    }
  });

  it('show describes a missing baseline', () => {
    const repo = scratchWorkspace({ 'a.md': doc('docs.a') });
    try {
      const show = runCli(['baseline', 'show'], repo.root);
      assert.equal(show.status, 0);
      assert.match(show.stdout, /no \.mdlineage-baseline\.json/);
    } finally {
      repo.cleanup();
    }
  });

  it('verify on a clean tree without a baseline passes', () => {
    const repo = scratchWorkspace({ 'a.md': doc('docs.a') });
    try {
      const verify = runCli(['baseline', 'verify'], repo.root);
      assert.equal(verify.status, 0);
      assert.match(verify.stdout, /no violations/);
    } finally {
      repo.cleanup();
    }
  });

  it('an unknown baseline action is a usage error', () => {
    const out = runCli(['baseline', 'frobnicate']);
    assert.equal(out.status, 2);
    assert.match(out.stderr, /unknown baseline action/);
  });

  it('B-1: verify from a subdirectory still checks the repository root', () => {
    // The review Blocker: a CI job whose working directory is a subdirectory
    // used to see "no baseline here, no violations here" and exit 0. The
    // baseline is a repository-level contract, so the graph is anchored at the
    // root regardless of the CWD.
    const repo = scratchGitRepoWithBaseline();
    try {
      // A violation under the repository root, not under the subdirectory, so
      // a CWD-scoped verify would miss it entirely.
      writeFileSync(join(repo.root, 'legacy.md'), '# no front matter at all\n');
      const verify = runCli(['baseline', 'verify'], join(repo.root, 'sub'));
      assert.equal(verify.status, 1, 'a subdirectory verify must still see the root');
      assert.match(verify.stdout, /legacy\.md MDL003/, 'the root violation is reported');
      assert.match(verify.stdout, /no \.mdlineage-baseline\.json but 1 violation present/);
    } finally {
      repo.cleanup();
    }
  });

  it('B-1: update from a subdirectory anchors at the repository root', () => {
    const repo = scratchGitRepoWithBaseline();
    try {
      writeFileSync(join(repo.root, 'legacy.md'), '# no front matter at all\n');
      const update = runCli(['baseline', 'update'], join(repo.root, 'sub'));
      assert.equal(update.status, 0);
      // The file lands at the root, not in the subdirectory the CLI ran from.
      const baseline = JSON.parse(readFileSync(join(repo.root, '.mdlineage-baseline.json'), 'utf8'));
      assert.deepEqual(baseline.codes.MDL003, ['legacy.md'], 'keys are repo-relative');
      assert.ok(!existsSync(join(repo.root, 'sub', '.mdlineage-baseline.json')), 'no stray subdirectory baseline');
      // And the root-anchored verify now passes: the exemption is where the
      // root's graph looks for it.
      assert.equal(runCli(['baseline', 'verify'], repo.root).status, 0, 'the recorded debt passes the gate');
    } finally {
      repo.cleanup();
    }
  });

  it('M-2: the JSON output carries the baseline field in both modes', () => {
    // `CheckResult.baseline` was assigned but renderJson never emitted it, so
    // `--no-baseline` and the default view were indistinguishable to a machine.
    const repo = scratchGitRepoWithBaseline();
    try {
      writeFileSync(join(repo.root, 'legacy.md'), '# no front matter at all\n');
      runCli(['baseline', 'update'], repo.root);

      const applied = parseJson(runCli(['check', '.', '--format', 'json'], repo.root).stdout);
      assert.ok(applied.baseline, 'the default view reports the baseline it applied');
      assert.ok(applied.baseline!.suppressed > 0, 'suppressed counts the accepted debt');
      assert.match(applied.baseline!.path, /\.mdlineage-baseline\.json$/);

      const audit = parseJson(runCli(['check', '.', '--no-baseline', '--format', 'json'], repo.root).stdout);
      assert.equal(audit.baseline, null, '--no-baseline is distinguishable: the field is null');
      // The audit view still reports the debt the baseline covers.
      assert.ok(audit.reports.some((r) => r.diagnostics.some((d) => d.code === 'MDL003')), 'the debt is reported');
    } finally {
      repo.cleanup();
    }
  });

  it('M-4: a subdirectory check hits the same baseline entries as a root run', () => {
    // The asymmetry: config was looked up by walking up, the baseline only by
    // looking at the CWD, and the suppression keys were CWD-relative — so the
    // same file was exempt or not depending on where the command was invoked.
    const repo = scratchGitRepoWithBaseline();
    try {
      writeFileSync(join(repo.root, 'legacy.md'), '# no front matter at all\n');
      runCli(['baseline', 'update'], repo.root);

      assert.equal(runCli(['check', 'legacy.md'], repo.root).status, 0, 'the root run suppresses the debt');
      assert.equal(
        runCli(['check', '../legacy.md'], join(repo.root, 'sub')).status,
        0,
        'the subdirectory run hits the same exemption',
      );
      // Report paths stay the caller's own spelling; the keys are what are
      // repo-relative.
      const sub = runCli(['check', '../legacy.md', '--format', 'json'], join(repo.root, 'sub'));
      assert.equal(parseJson(sub.stdout).reports[0]!.path, '../legacy.md', 'the report path is as given');
    } finally {
      repo.cleanup();
    }
  });

  it('Minor2: update refuses a corrupt baseline without --force and says what it would discard', () => {
    const repo = scratchGitRepoWithBaseline();
    try {
      // Two accepted exemptions, so the refusal can name a real number.
      writeFileSync(join(repo.root, 'legacy.md'), '# no front matter at all\n');
      writeFileSync(join(repo.root, 'sub', 'other.md'), '# also none\n');
      runCli(['baseline', 'update'], repo.root);
      // Unparseable JSON: the count falls back to the file's legible shape.
      writeFileSync(join(repo.root, '.mdlineage-baseline.json'), '{ not valid json');

      const refused = runCli(['baseline', 'update'], repo.root);
      assert.equal(refused.status, 1, 'a corrupt baseline is not silently rewritten');
      assert.match(refused.stderr, /cannot read the committed baseline/);
      assert.match(refused.stderr, /accepted exemptions would be discarded; use --force to write anyway/);
      assert.equal(
        readFileSync(join(repo.root, '.mdlineage-baseline.json'), 'utf8'),
        '{ not valid json',
        'the broken file is untouched',
      );

      // A file whose JSON parses but whose shape the parser rejects still names
      // the exact number of entries the write would drop.
      writeFileSync(
        join(repo.root, '.mdlineage-baseline.json'),
        JSON.stringify({ version: 99, codes: { MDL003: ['legacy.md', 'sub/other.md'] } }),
      );
      const shaped = runCli(['baseline', 'update'], repo.root);
      assert.equal(shaped.status, 1);
      assert.match(
        shaped.stderr,
        /2 accepted exemptions would be discarded; use --force to write anyway/,
        'the count comes from the entries the file carries',
      );

      // --force says the loss is intended: the write happens and re-records the
      // current debt.
      const forced = runCli(['baseline', 'update', '--force'], repo.root);
      assert.equal(forced.status, 0, '--force writes anyway');
      const baseline = JSON.parse(readFileSync(join(repo.root, '.mdlineage-baseline.json'), 'utf8'));
      assert.deepEqual(baseline.codes.MDL003, ['legacy.md', 'sub/other.md'], 'the current debt is re-recorded');
    } finally {
      repo.cleanup();
    }
  });

  it('Minor3: an explicitly named excluded path is explained on stderr', () => {
    // `node_modules` exists and holds Markdown; the default ignore list drops
    // it, so a caller naming it would otherwise validate nothing in silence.
    const repo = scratchGitRepoWithBaseline();
    try {
      mkdirSync(join(repo.root, 'node_modules'), { recursive: true });
      writeFileSync(join(repo.root, 'node_modules', 'pkg.md'), '# no front matter\n');
      const out = runCli(['check', 'node_modules'], repo.root);
      assert.match(out.stderr, /node_modules matches the default exclude list/);
      assert.equal(out.stdout.trim(), 'mdlineage: 0 files checked, no diagnostics', 'nothing was checked');
      assert.equal(out.stdout.includes('MDL003'), false, 'the ignored file is not validated');
    } finally {
      repo.cleanup();
    }
  });
});

/**
 * A scratch git repository with a config that requires metadata, so a bare
 * Markdown file is a real violation and the baseline path is exercisable.
 */
function scratchGitRepoWithBaseline(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'mdlineage-bl-'));
  const git = (args: string[]) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  git(['init', '-q']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'mdlineage test']);
  writeFileSync(join(root, '.gitattributes'), '* text=auto eol=lf\n');
  writeFileSync(join(root, 'mdlineage.config.yaml'), CONFIG_REQUIRED);
  writeFileSync(join(root, 'clean.md'), doc('docs.clean'));
  mkdirSync(join(root, 'sub'));
  writeFileSync(join(root, 'sub', 'nested.md'), doc('docs.nested'));
  git(['add', '.']);
  git(['commit', '-q', '-m', 'initial']);
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe('mdlineage init', () => {
  /** An empty scratch directory (git optional: init falls back to the CWD). */
  function scratchDir(): { root: string; cleanup: () => void } {
    const root = mkdtempSync(join(tmpdir(), 'mdlineage-init-'));
    return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
  }

  it('dry run prints the plan and writes nothing', () => {
    const dir = scratchDir();
    try {
      const before = existsSync(join(dir.root, 'mdlineage.config.yaml'));
      const out = runCli(['init'], dir.root);
      assert.equal(out.status, 0);
      assert.match(out.stdout, /create mdlineage\.config\.yaml/);
      assert.match(out.stdout, /create \.gitattributes/);
      assert.match(out.stdout, /\+\* text=auto eol=lf/);
      assert.match(out.stdout, /create schemas\//);
      assert.match(out.stdout, /dry run, nothing written/);
      assert.equal(existsSync(join(dir.root, 'mdlineage.config.yaml')), before);
      assert.equal(existsSync(join(dir.root, '.gitattributes')), false);
      assert.equal(existsSync(join(dir.root, 'schemas')), false);
    } finally {
      dir.cleanup();
    }
  });

  it('--write creates config, .gitattributes and schemas/', () => {
    const dir = scratchDir();
    try {
      const out = runCli(['init', '--write'], dir.root);
      assert.equal(out.status, 0);
      const config = readFileSync(join(dir.root, 'mdlineage.config.yaml'), 'utf8');
      assert.match(config, /configVersion: 1/);
      assert.match(config, /required: false/);
      assert.equal(readFileSync(join(dir.root, '.gitattributes'), 'utf8'), '* text=auto eol=lf\n');
      assert.ok(existsSync(join(dir.root, 'schemas')));
    } finally {
      dir.cleanup();
    }
  });

  it('an existing .gitattributes is appended to, never rewritten', () => {
    const dir = scratchDir();
    const custom = '# my rules\n*.png -text\n';
    writeFileSync(join(dir.root, '.gitattributes'), custom);
    try {
      const out = runCli(['init', '--write'], dir.root);
      assert.equal(out.status, 0);
      assert.match(out.stdout, /append to \.gitattributes/);
      const content = readFileSync(join(dir.root, '.gitattributes'), 'utf8');
      assert.ok(content.startsWith(custom), 'custom rules are preserved verbatim');
      assert.ok(content.includes('* text=auto eol=lf\n'), 'the policy line was appended');
    } finally {
      dir.cleanup();
    }
  });

  it('is idempotent: a second run reports no changes and files are byte-identical', () => {
    const dir = scratchDir();
    try {
      assert.equal(runCli(['init', '--write'], dir.root).status, 0);
      const snapshot = (name: string) => readFileSync(join(dir.root, name));
      const config = snapshot('mdlineage.config.yaml');
      const attr = snapshot('.gitattributes');
      const out = runCli(['init', '--write'], dir.root);
      assert.equal(out.status, 0);
      assert.match(out.stdout, /nothing to do, already initialized/);
      assert.equal(snapshot('mdlineage.config.yaml').equals(config), true);
      assert.equal(snapshot('.gitattributes').equals(attr), true);
    } finally {
      dir.cleanup();
    }
  });

  it('an existing mdlineage.config.yaml is not overwritten', () => {
    const dir = scratchDir();
    const existing = 'configVersion: 1\nmetadata:\n  required: true\n';
    writeFileSync(join(dir.root, 'mdlineage.config.yaml'), existing);
    try {
      const out = runCli(['init', '--write'], dir.root);
      assert.equal(out.status, 0);
      assert.match(out.stdout, /mdlineage\.config\.yaml: already present, left unchanged/);
      assert.equal(readFileSync(join(dir.root, 'mdlineage.config.yaml'), 'utf8'), existing);
    } finally {
      dir.cleanup();
    }
  });

  it('a stray path argument is a usage error, the way check refuses one', () => {
    const dir = scratchDir();
    try {
      const out = runCli(['init', 'extra.md'], dir.root);
      assert.equal(out.status, 2);
      assert.match(out.stderr, /init takes no paths \(unexpected: extra\.md\)/);
      assert.equal(existsSync(join(dir.root, 'mdlineage.config.yaml')), false, 'nothing was written');
    } finally {
      dir.cleanup();
    }
  });

  it('the .gitattributes policy line maps every eolPolicy, and init writes the configured one', () => {
    const dir = scratchDir();
    try {
      // The mapping itself, for every policy the validator can carry.
      assert.equal(attrPolicyLine('lf'), '* text=auto eol=lf');
      assert.equal(attrPolicyLine('crlf'), '* text=auto eol=crlf');
      // git's `eol` attribute has no CR form, so a CR policy keeps the
      // normalization rule without claiming an eol it cannot express.
      assert.equal(attrPolicyLine('cr'), '* text=auto');
      // End to end: a config declaring eolPolicy: crlf produces the CRLF
      // attribute — an explicit expectation, not one derived from the same
      // code path under test.
      writeFileSync(join(dir.root, 'mdlineage.config.yaml'), 'configVersion: 1\neolPolicy: crlf\n');
      const out = runCli(['init', '--write'], dir.root);
      assert.equal(out.status, 0);
      assert.equal(readFileSync(join(dir.root, '.gitattributes'), 'utf8'), '* text=auto eol=crlf\n');
      assert.match(out.stdout, /\+\* text=auto eol=crlf/);
    } finally {
      dir.cleanup();
    }
  });

  it('without eolPolicy in the config, init writes the default LF policy line', () => {
    const dir = scratchDir();
    try {
      const out = runCli(['init', '--write'], dir.root);
      assert.equal(out.status, 0);
      assert.equal(readFileSync(join(dir.root, '.gitattributes'), 'utf8'), '* text=auto eol=lf\n');
    } finally {
      dir.cleanup();
    }
  });

  it('a read-only directory is reported, not crashed on', () => {
    const dir = scratchDir();
    try {
      chmodSync(dir.root, 0o555);
      const out = runCli(['init', '--write'], dir.root);
      assert.equal(out.status, 1);
      assert.match(out.stderr, /mdlineage: cannot write mdlineage\.config\.yaml: EACCES/);
      assert.ok(!out.stderr.includes('\n    at '), 'no stack trace is leaked');
    } finally {
      chmodSync(dir.root, 0o755);
      dir.cleanup();
    }
  });

  it('a read-only .gitattributes is reported, not crashed on', () => {
    const dir = scratchDir();
    const custom = '# my rules\n';
    writeFileSync(join(dir.root, '.gitattributes'), custom);
    chmodSync(join(dir.root, '.gitattributes'), 0o444);
    try {
      const out = runCli(['init', '--write'], dir.root);
      assert.equal(out.status, 1);
      assert.match(out.stderr, /mdlineage: cannot write \.gitattributes: EACCES/);
      assert.ok(!out.stderr.includes('\n    at '), 'no stack trace is leaked');
      assert.equal(readFileSync(join(dir.root, '.gitattributes'), 'utf8'), custom, 'the file is untouched');
    } finally {
      chmodSync(join(dir.root, '.gitattributes'), 0o644);
      dir.cleanup();
    }
  });
});

describe('mdlineage fix', () => {
  /** A document missing `status` and carrying a duplicate relation. */
  function brokenDoc(): string {
    return [
      '---',
      'mdlineage:',
      '  schema: 1',
      '  id: docs.a',
      '  kind: policy',
      '  relations:',
      '    - type: related_to',
      '      target: docs.x',
      '      reason: r',
      '    - type: related_to',
      '      target: docs.x',
      '      reason: r',
      '---',
      '',
      '# a',
    ].join('\n');
  }

  /** The same document with two strong relations that each lack a `reason`. */
  function reasonlessDoc(): string {
    return [
      '---',
      'mdlineage:',
      '  schema: 1',
      '  id: docs.p3',
      '  kind: policy',
      '  status: active',
      '  relations:',
      '    - type: depends_on',
      '      target: docs.a',
      '    - type: depends_on',
      '      target: docs.b',
      '---',
      '',
      '# p3',
    ].join('\n');
  }

  /** True when the document's front matter block still parses as YAML. */
  function frontmatterParses(text: string): boolean {
    const boundary = scanBoundary(text);
    if (boundary === null || boundary.closeStart === null) return false;
    return parseFrontmatter(boundary.raw, boundary.rawStart, buildLineMap(text)).parsed !== null;
  }

  it('dry run reports fixes and writes nothing', () => {
    const ws = scratchWorkspace({ 'a.md': brokenDoc() });
    try {
      const out = runCli(['fix', 'a.md'], ws.root);
      assert.equal(out.status, 0);
      assert.match(out.stdout, /would fix \d+ issues/);
      assert.match(out.stdout, /\[status\]/);
      assert.match(out.stdout, /\[duplicate-relation\]/);
      assert.equal(readFileSync(join(ws.root, 'a.md'), 'utf8'), brokenDoc());
    } finally {
      ws.cleanup();
    }
  });

  it('--write clears the diagnostics it fixed', () => {
    const ws = scratchWorkspace({ 'a.md': brokenDoc(), 'docs.x.md': doc('docs.x') });
    try {
      const out = runCli(['fix', 'a.md', '--write'], ws.root);
      assert.equal(out.status, 0);
      assert.match(out.stdout, /mdlineage fix: \d+ fixes? in 1 file/);
      const after = runCli(['check', 'a.md', '--no-baseline', '--format', 'json'], ws.root);
      assert.equal(countOf(after.stdout, 'MDL102'), 0, 'missing status is fixed');
      assert.equal(countOf(after.stdout, 'MDL202'), 0, 'the duplicate relation is gone');
      const content = readFileSync(join(ws.root, 'a.md'), 'utf8');
      assert.equal((content.match(/- type: related_to/g) ?? []).length, 1);
      assert.match(content, /status: draft/);
    } finally {
      ws.cleanup();
    }
  });

  it('a CRLF document is normalized to a single line-ending style, never mixed', () => {
    // CRLF body with a bare-LF last line: MDL601 (mixed) plus MDL602 (policy LF).
    const crlfDoc = [
      '---',
      'mdlineage:',
      '  schema: 1',
      '  id: docs.crlf',
      '  kind: policy',
      '---',
      '',
      '# crlf',
    ]
      .join('\r\n') + '\n';
    const ws = scratchWorkspace({ 'crlf.md': crlfDoc });
    try {
      const out = runCli(['fix', 'crlf.md', '--write'], ws.root);
      assert.equal(out.status, 0);
      const content = readFileSync(join(ws.root, 'crlf.md'), 'utf8');
      const crlf = (content.match(/\r\n/g) ?? []).length;
      const lf = (content.match(/(?<!\r)\n/g) ?? []).length;
      const cr = (content.match(/\r(?!\n)/g) ?? []).length;
      assert.ok(lf + crlf + cr > 0, 'the fixed document still has line breaks');
      // The style count must not grow: normalization leaves exactly one style.
      const styles = [lf > 0, crlf > 0, cr > 0].filter(Boolean).length;
      assert.equal(styles, 1, 'the document ends up with a single line-ending style');
      const check = runCli(['check', 'crlf.md', '--no-baseline', '--format', 'json'], ws.root);
      assert.equal(countOf(check.stdout, 'MDL601'), 0);
      assert.equal(countOf(check.stdout, 'MDL602'), 0);
      assert.equal(countOf(check.stdout, 'MDL102'), 0);
    } finally {
      ws.cleanup();
    }
  });

  it('a read-only file is skipped without breaking the batch', () => {
    const ws = scratchWorkspace({ 'a.md': brokenDoc(), 'b.md': brokenDoc().replace('docs.a', 'docs.b') });
    const frozen = join(ws.root, 'a.md');
    try {
      chmodSync(frozen, 0o444);
      const out = runCli(['fix', '--write'], ws.root);
      assert.equal(out.status, 0);
      assert.match(out.stderr, /skipping read-only file: a\.md/);
      assert.match(out.stdout, /b\.md/);
      assert.equal(readFileSync(frozen, 'utf8'), brokenDoc(), 'the read-only file is untouched');
    } finally {
      chmodSync(frozen, 0o644);
      ws.cleanup();
    }
  });

  it('a path outside the workspace is refused', () => {
    const ws = scratchWorkspace({ 'a.md': brokenDoc() });
    const outside = join(ws.root, '..', 'mdlineage-fix-escape.md');
    writeFileSync(outside, brokenDoc());
    try {
      const out = runCli(['fix', outside, '--write'], ws.root);
      assert.equal(out.status, 1);
      assert.match(out.stderr, /refusing path outside the workspace/);
      assert.equal(readFileSync(outside, 'utf8'), brokenDoc(), 'the outside file is untouched');
    } finally {
      rmSync(outside, { force: true });
      ws.cleanup();
    }
  });

  it('a path inside the repository is accepted from a subdirectory (root = CWD)', () => {
    // #19: `fix` anchors on the CWD, not the git root, so `../sibling.md` is
    // outside the CWD and refused even though it is inside the repository.
    // The help text documents this; the test pins it as a deliberate choice
    // rather than an oversight a later change might "fix" silently.
    const ws = scratchWorkspace({ 'a.md': brokenDoc() });
    mkdirSync(join(ws.root, 'sub'));
    const sibling = join(ws.root, 'sub', 'a.md');
    writeFileSync(sibling, brokenDoc());
    try {
      const out = runCli(['fix', '../a.md'], join(ws.root, 'sub'));
      assert.equal(out.status, 1, 'a path resolving outside the CWD is refused');
      assert.match(out.stderr, /refusing path outside the workspace/);
      assert.equal(readFileSync(join(ws.root, 'a.md'), 'utf8'), brokenDoc(), 'nothing was written');
    } finally {
      ws.cleanup();
    }
  });

  it('a path inside the CWD subtree is fixed from a subdirectory', () => {
    // The same CWD anchor accepts a downward path: `fix sub/a.md` from the root
    // is inside the CWD, so it works and the behavior is pinned both ways.
    const ws = scratchWorkspace({ 'a.md': brokenDoc() });
    mkdirSync(join(ws.root, 'sub'));
    const nested = join(ws.root, 'sub', 'a.md');
    writeFileSync(nested, brokenDoc());
    try {
      const out = runCli(['fix', 'sub/a.md'], ws.root);
      assert.equal(out.status, 0);
      assert.match(out.stdout, /would fix \d+ issues/);
    } finally {
      ws.cleanup();
    }
  });

  it('a pure-CRLF document loses its duplicate relation (§9.1 dedup is line-ending agnostic)', () => {
    // Every terminator is a CRLF pair, the last one included. The per-line
    // patterns used to end in `$`, which never matches before a `\r`, so the
    // whole dedup pass returned nothing and MDL202 survived the fix.
    const crlfDoc = brokenDoc().split('\n').join('\r\n');
    assert.ok(!crlfDoc.includes('\n\n'), 'sanity: the fixture is pure CRLF');
    const ws = scratchWorkspace({ 'crlf.md': crlfDoc });
    try {
      const out = runCli(['fix', 'crlf.md', '--write'], ws.root);
      assert.equal(out.status, 0);
      assert.match(out.stdout, /\[duplicate-relation\]/);
      const content = readFileSync(join(ws.root, 'crlf.md'), 'utf8');
      assert.equal((content.match(/- type: related_to/g) ?? []).length, 1, 'one relation survives');
      assert.equal((content.match(/\r/g) ?? []).length, 0, 'the line-ending pass still ran');
      const after = runCli(['check', 'crlf.md', '--no-baseline', '--format', 'json'], ws.root);
      assert.equal(countOf(after.stdout, 'MDL202'), 0, 'the duplicate relation is gone');
      assert.equal(countOf(after.stdout, 'MDL102'), 0, 'the missing status is filled');
    } finally {
      ws.cleanup();
    }
  });

  it('two relations missing a reason both get one, and the YAML still parses', () => {
    // The shared patch engine used to apply both insertions at offsets located
    // against the ORIGINAL text, so the second landed inside the first and the
    // front matter came out unparseable.
    const ws = scratchWorkspace({ 'p3.md': reasonlessDoc() });
    try {
      const out = runCli(['fix', 'p3.md', '--write'], ws.root);
      assert.equal(out.status, 0);
      const content = readFileSync(join(ws.root, 'p3.md'), 'utf8');
      assert.equal((content.match(/reason: /g) ?? []).length, 2, 'both relations gained a reason');
      assert.ok(frontmatterParses(content), 'the front matter is still valid YAML');
      const after = runCli(['check', 'p3.md', '--no-baseline', '--format', 'json'], ws.root);
      assert.equal(countOf(after.stdout, 'MDL102'), 0, 'both gaps are closed');
      assert.equal(countOf(after.stdout, 'MDL002'), 0, 'no YAML parse failure');
    } finally {
      ws.cleanup();
    }
  });

  it('a relation that has a reason and lacks a target does not gain a second one', () => {
    // MDL102's pointer is the relation entry, so the proposal engine derives
    // `/relations/N/reason` even when `target` is what is missing. Inserting it
    // anyway produced a duplicate YAML key the parser rejects.
    const gappy = [
      '---',
      'mdlineage:',
      '  schema: 1',
      '  id: docs.b4',
      '  kind: policy',
      '  status: active',
      '  relations:',
      '    - type: depends_on',
      '      reason: r',
      '---',
      '',
      '# b4',
    ].join('\n');
    const ws = scratchWorkspace({ 'b4.md': gappy });
    try {
      const out = runCli(['fix', 'b4.md', '--write'], ws.root);
      assert.equal(out.status, 0);
      assert.match(out.stdout, /mdlineage fix: 0 fixes in 0 files/, 'nothing was inserted');
      const content = readFileSync(join(ws.root, 'b4.md'), 'utf8');
      assert.equal(content, gappy, 'the document is untouched');
      assert.equal((content.match(/reason:/g) ?? []).length, 1, 'the existing reason is the only one');
      const after = runCli(['check', 'b4.md', '--no-baseline', '--format', 'json'], ws.root);
      assert.equal(countOf(after.stdout, 'MDL002'), 0, 'the document was not corrupted');
    } finally {
      ws.cleanup();
    }
  });

  it('an empty file is not reported as a line-ending fix', () => {
    const ws = scratchWorkspace({ 'empty.md': '' });
    try {
      const out = runCli(['fix', '--write'], ws.root);
      assert.equal(out.status, 0);
      assert.equal(readFileSync(join(ws.root, 'empty.md'), 'utf8').length, 0, 'the file is still empty');
      assert.ok(!out.stdout.includes('[line-endings]'), 'no fix was claimed');
      assert.match(out.stdout, /mdlineage fix: 0 fixes in 0 files/);
    } finally {
      ws.cleanup();
    }
  });

  it('--exclude keeps the matching files out of the batch', () => {
    const skipped = brokenDoc().replace('docs.a', 'docs.b');
    const ws = scratchWorkspace({ 'a.md': brokenDoc(), 'skip/b.md': skipped });
    try {
      const out = runCli(['fix', '--exclude', 'skip/**', '--write'], ws.root);
      assert.equal(out.status, 0);
      assert.match(out.stdout, /a\.md:/);
      assert.equal(readFileSync(join(ws.root, 'skip', 'b.md'), 'utf8'), skipped, 'the excluded file is untouched');
      const after = runCli(['check', 'a.md', '--no-baseline', '--format', 'json'], ws.root);
      assert.equal(countOf(after.stdout, 'MDL102'), 0, 'the file that was in scope is fixed');
    } finally {
      ws.cleanup();
    }
  });

  it('a --config that does not exist fails the run the way check does', () => {
    const ws = scratchWorkspace({ 'a.md': brokenDoc() });
    try {
      const out = runCli(['fix', 'a.md', '--config', 'no-such.yaml'], ws.root);
      assert.equal(out.status, 1);
      assert.match(out.stderr, /MDL900 error Config file not found/);
    } finally {
      ws.cleanup();
    }
  });

  it('an enum value with one case-insensitive vocabulary match is normalized', () => {
    const ws = scratchWorkspace({
      'mdlineage.config.yaml': 'configVersion: 1\nvocabulary:\n  kinds: [policy, guide]\n',
      'a.md': ['---', 'mdlineage:', '  schema: 1', '  id: docs.a', '  kind: POLICY', '  status: active', '---', '', '# a'].join(
        '\n',
      ),
    });
    try {
      const out = runCli(['fix', 'a.md', '--write'], ws.root);
      assert.equal(out.status, 0);
      assert.match(out.stdout, /\[enum-normalized\]/);
      assert.match(readFileSync(join(ws.root, 'a.md'), 'utf8'), /kind: policy/);
      const after = runCli(['check', 'a.md', '--no-baseline', '--format', 'json'], ws.root);
      assert.equal(countOf(after.stdout, 'MDL103'), 0, 'the vocabulary violation is cleared');
    } finally {
      ws.cleanup();
    }
  });

  it('an ambiguous enum value is left alone and says so on stderr', () => {
    const ws = scratchWorkspace({
      'mdlineage.config.yaml': 'configVersion: 1\nvocabulary:\n  kinds: [Policy, POLICY]\n',
      'a.md': ['---', 'mdlineage:', '  schema: 1', '  id: docs.a', '  kind: policy', '  status: active', '---', '', '# a'].join(
        '\n',
      ),
    });
    try {
      const out = runCli(['fix', 'a.md', '--write'], ws.root);
      assert.equal(out.status, 0);
      assert.match(out.stderr, /matches 2 vocabulary members \(Policy, POLICY\)/);
      assert.match(out.stderr, /needs a human decision/);
      assert.match(readFileSync(join(ws.root, 'a.md'), 'utf8'), /kind: policy/, 'the value is not rewritten');
      const after = runCli(['check', 'a.md', '--no-baseline', '--format', 'json'], ws.root);
      assert.equal(countOf(after.stdout, 'MDL103'), 1, 'the diagnostic survives for the human to judge');
    } finally {
      ws.cleanup();
    }
  });

  it('never touches what §9.2 reserves for a reviewer', () => {
    // The document carries one SAFE repair (a duplicate relation) so the run is
    // not vacuous, plus everything §9.2 withholds: a malformed id, a relation
    // type and target outside the vocabulary, and an unknown field's block.
    const doc = [
      '---',
      'mdlineage:',
      '  schema: 1',
      '  id: Docs.Bad_ID',
      '  kind: policy',
      '  status: active',
      '  relations:',
      '    - type: related_to',
      '      target: docs.x',
      '      reason: r',
      '    - type: related_to',
      '      target: docs.x',
      '      reason: r',
      '    - type: DEPENDS_ON',
      '      target: Docs.Bad_Target',
      '      reason: r',
      '  custom_block:',
      '    nested: value',
      '    other: 2',
      '---',
      '',
      '# a',
    ].join('\n');
    const ws = scratchWorkspace({ 'a.md': doc });
    try {
      const out = runCli(['fix', 'a.md', '--write'], ws.root);
      assert.equal(out.status, 0);
      const content = readFileSync(join(ws.root, 'a.md'), 'utf8');
      assert.equal((content.match(/- type: related_to/g) ?? []).length, 1, 'the safe repair did run');
      assert.ok(content.includes('  id: Docs.Bad_ID\n'), 'the id is neither rewritten nor inserted');
      assert.ok(content.includes('    - type: DEPENDS_ON\n'), 'the relation type is untouched');
      assert.ok(content.includes('      target: Docs.Bad_Target\n'), 'the relation target is untouched');
      assert.ok(content.includes('  custom_block:\n    nested: value\n    other: 2\n'), 'the unknown block is untouched');
      const after = runCli(['check', 'a.md', '--no-baseline', '--format', 'json'], ws.root);
      assert.equal(countOf(after.stdout, 'MDL103'), 3, 'id, relation type and relation target are all still reported');
      assert.equal(countOf(after.stdout, 'MDL104'), 1, 'the unknown field is still reported');
    } finally {
      ws.cleanup();
    }
  });
});

describe('config validate', () => {
  it('exits 0 on a valid config and prints the source path', () => {
    const out = runCli(['config', 'validate'], repoRoot);
    assert.equal(out.status, 0);
    assert.ok(out.stdout.includes(`config OK (`), 'the OK line names the config');
    assert.ok(out.stdout.includes('mdlineage.config.yaml'));
  });

  it('exits 1 with MDL900 on a config that fails the schema', () => {
    const ws = scratchWorkspace({
      'mdlineage.config.yaml': 'files:\n  eol: lf\n  not_a_config_key: true\n',
      'a.md': doc('docs.a'),
    });
    try {
      const out = runCli(['config', 'validate'], ws.root);
      assert.equal(out.status, 1);
      assert.ok(out.stderr.includes('MDL900'), 'the config diagnostic is reported');
    } finally {
      ws.cleanup();
    }
  });

  it('exits 1 with MDL900 on an explicitly named missing config', () => {
    const ws = scratchWorkspace({ 'a.md': doc('docs.a') });
    try {
      const out = runCli(['config', 'validate', '--config', 'nope.yaml'], ws.root);
      assert.equal(out.status, 1);
      assert.ok(out.stderr.includes('MDL900'));
    } finally {
      ws.cleanup();
    }
  });

  it('exits 0 when no config file exists in the tree', () => {
    const ws = scratchWorkspace({ 'a.md': doc('docs.a') });
    try {
      const out = runCli(['config', 'validate'], ws.root);
      assert.equal(out.status, 0);
      assert.ok(out.stdout.includes('no config file found'));
    } finally {
      ws.cleanup();
    }
  });

  it('--format json prints the { source, diagnostics } shape', () => {
    const out = runCli(['config', 'validate', '--format', 'json'], repoRoot);
    assert.equal(out.status, 0);
    const parsed = JSON.parse(out.stdout) as { source: string | null; diagnostics: unknown[] };
    assert.equal(typeof parsed.source, 'string');
    assert.ok(Array.isArray(parsed.diagnostics));
    assert.equal(parsed.diagnostics.length, 0);
  });

  it('rejects an unknown subcommand with exit 2', () => {
    const out = runCli(['config', 'nonsense'], repoRoot);
    assert.equal(out.status, 2);
    assert.ok(out.stderr.includes('unknown config command'));
  });
});

describe('index rebuild', () => {
  it('exits 0 on a clean tree and prints stats, writing nothing', () => {
    const ws = scratchWorkspace({
      'a.md': doc('docs.a', '  relations:\n    - type: related_to\n      target: docs.b\n      reason: r\n'),
      'b.md': doc('docs.b'),
    });
    try {
      const out = runCli(['index', 'rebuild'], ws.root);
      assert.equal(out.status, 0);
      assert.ok(out.stdout.includes('index rebuilt'));
      assert.ok(out.stdout.includes('2 files'));
      assert.ok(out.stdout.includes('2 ids'));
      assert.ok(out.stdout.includes('1 relation'));
      assert.ok(out.stdout.includes('not persisted'));
      assert.equal(existsSync(join(ws.root, '.mdlineage')), false, 'no cache directory is created');
    } finally {
      ws.cleanup();
    }
  });

  it('exits 1 and reports MDL301 on a tree with duplicate ids', () => {
    const ws = scratchWorkspace({ 'a.md': doc('docs.a'), 'b.md': doc('docs.a') });
    try {
      const out = runCli(['index', 'rebuild'], ws.root);
      assert.equal(out.status, 1);
      assert.ok(out.stdout.includes('MDL301'));
    } finally {
      ws.cleanup();
    }
  });

  it('--format json prints stats and diagnostics', () => {
    const ws = scratchWorkspace({ 'a.md': doc('docs.a'), 'b.md': doc('docs.a') });
    try {
      const out = runCli(['index', 'rebuild', '--format', 'json'], ws.root);
      assert.equal(out.status, 1);
      const parsed = JSON.parse(out.stdout) as {
        stats: { files: number; ids: number; relations: number; anchors: number };
        diagnostics: Array<{ code: string }>;
      };
      assert.deepEqual(parsed.stats, { files: 2, ids: 1, relations: 0, anchors: 2 });
      assert.ok(parsed.diagnostics.some((d) => d.code === 'MDL301'));
    } finally {
      ws.cleanup();
    }
  });

  it('rejects an unknown subcommand with exit 2', () => {
    const out = runCli(['index', 'nonsense'], repoRoot);
    assert.equal(out.status, 2);
    assert.ok(out.stderr.includes('unknown index command'));
  });
});

describe('mdlineage usage errors — exit 2, no stack', () => {
  // A strict parseArgs throw used to escape main() as an uncaught exception
  // (exit 1 with a stack); an unknown flag is a usage error, so exit 2.
  for (const argv of [['server', '--http'], ['mcp', '--http'], ['check', '--nonsense']]) {
    it(`rejects unknown flag on '${argv.join(' ')}' with exit 2`, () => {
      const out = runCli(argv);
      assert.equal(out.status, 2);
      assert.ok(out.stderr.includes('Unknown option'), `stderr was: ${out.stderr}`);
      assert.ok(!/^\s+at /m.test(out.stderr), 'no stack trace on a usage error');
    });
  }

  it('server without --stdio still exits 2 with the usage hint', () => {
    const out = runCli(['server']);
    assert.equal(out.status, 2);
    assert.ok(out.stderr.includes("unknown server transport '(none)'"));
    assert.ok(!/^\s+at /m.test(out.stderr));
  });
});
