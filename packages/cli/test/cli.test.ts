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
import { readFileSync, mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

describe('mdlineage check — fixtures', () => {
  it('reports every invalid fixture with its MDL code over JSON', () => {
    const out = runCli(['check', 'test/fixtures', '--format', 'json']);
    assert.equal(out.status, 1, 'the fixture tree contains error-severity diagnostics');
    const reports = reportsOf(out.stdout);

    const codes = new Map(reports.flatMap((r) => r.diagnostics.map((d) => [d.code, r.path])));
    for (const expected of ['MDL001', 'MDL002', 'MDL003', 'MDL101', 'MDL102', 'MDL103', 'MDL104', 'MDL201', 'MDL202']) {
      assert.ok(codes.has(expected), `expected ${expected} in the CLI output`);
    }
    assert.ok(codes.has('MDL601'), 'the EOL scan layer reaches the CLI');
    assert.ok(codes.has('MDL602'), 'the EOL scan layer reaches the CLI');
  });

  it('valid fixtures produce no diagnostics', () => {
    const out = runCli(['check', 'test/fixtures/valid', '--format', 'json']);
    assert.equal(out.status, 0);
    const reports = reportsOf(out.stdout);
    for (const report of reports) {
      assert.deepEqual(report.diagnostics, [], `${report.path} must be clean`);
    }
    assert.equal(reports.length, 5, 'the five valid fixtures');
  });

  it('the text format is path:line:col CODE SEVERITY message', () => {
    const out = runCli(['check', 'test/fixtures/invalid/e05-id-pattern.md']);
    assert.equal(out.status, 1);
    const lines = out.stdout.trim().split('\n');
    assert.ok(lines[0]!.startsWith('test/fixtures/invalid/e05-id-pattern.md:4:7 MDL103 error '),
      `text format was: ${lines[0]}`);
    assert.ok(out.stdout.includes('1 file checked, 1 diagnostic (1 error, 0 warnings)'));
  });

  it('warnings alone exit 0', () => {
    const out = runCli(['check', 'test/fixtures/invalid/e17-evidence-anchor-missing.md']);
    assert.equal(out.status, 0, 'MDL201 is a warning');
    assert.match(out.stdout, /MDL201 warning/);
  });

  it('CRLF worktree bytes are read, not the index', () => {
    // The whole point of the batch channel reading worktree bytes: under
    // `text=auto eol=lf` a CRLF file's staged blob is LF, so an index-based
    // reader would report nothing (docs/line-ending-management.md §4.1).
    const out = runCli(['check', 'test/fixtures/invalid/e16-crlf-eol.md', '--format', 'json']);
    assert.equal(out.status, 0);
    const [report] = reportsOf(out.stdout);
    assert.ok(report, 'the CRLF fixture was read');
    assert.equal(report.diagnostics[0]!.code, 'MDL602');
  });

  it('a directory expands to its Markdown files', () => {
    const out = runCli(['check', 'test/fixtures/workspace', '--format', 'json']);
    assert.equal(out.status, 0, 'workspace fixtures are individually valid');
    assert.equal(reportsOf(out.stdout).length, 4, 'the four workspace fixtures');
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

  it('a bad --format value is rejected', () => {
    const out = runCli(['check', 'docs', '--format', 'sarif']);
    assert.equal(out.status, 2);
    assert.match(out.stderr, /--format must be/);
  });

  it('node_modules and dist are excluded by default', () => {
    const out = runCli(['check', '.', '--format', 'json']);
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
