/**
 * `mdlineage move` end-to-end tests (docs/dir-conventions.md §3 "Move impact").
 *
 * The binary is driven through `child_process`, the way cli.test.ts drives it:
 * the exit-code contract and the "nothing is written without --write" promise
 * are part of the interface, not implementation details.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '@mdlineage/validator';
import { executeMove, planMove, Workspace } from '../src/move.js';

const repoRoot = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..');
const cliBin = resolve(repoRoot, 'packages', 'cli', 'dist', 'main.js');

interface RunOutput {
  stdout: string;
  stderr: string;
  status: number | null;
}

function runCli(args: string[], cwd = repoRoot): RunOutput {
  const result = spawnSync(process.execPath, [cliBin, ...args], { cwd, encoding: 'utf8', windowsHide: true });
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status };
}

/** Isolated scratch tree, so a move never touches the real repository. */
function scratchWorkspace(files: Record<string, string>): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'mdlineage-move-'));
  for (const [name, content] of Object.entries(files)) {
    const path = resolve(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** A document with metadata, so the freshness clock has something to refresh. */
function doc(id: string, body: string, updatedAt = '2026-01-05'): string {
  return [
    '---',
    'mdlineage:',
    '  schema: 1',
    `  id: ${id}`,
    '  kind: reference',
    '  status: active',
    `  updated_at: ${updatedAt}`,
    '---',
    '',
    body,
  ].join('\n');
}

/** The UTC date the freshness clock reads, the way the CLI computes it. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Occurrences of a diagnostic code across a JSON check run. */
function countOf(stdout: string, code: string): number {
  const parsed = JSON.parse(stdout) as { reports: Array<{ diagnostics: Array<{ code: string }> }> };
  let n = 0;
  for (const report of parsed.reports) for (const d of report.diagnostics) if (d.code === code) n += 1;
  return n;
}

/** A tree shaped like a real documentation repository. */
function tree(): Record<string, string> {
  return {
    'README.md': ['# top', '', 'See [foo](./docs/foo.md), [foo again](./docs/foo.md#foo) and [guide](./docs/guides/guide.md).', ''].join(
      '\n',
    ),
    'docs/foo.md': doc(
      'docs.foo',
      [
        '# foo',
        '',
        'The [guide](guides/guide.md), the [readme](../README.md#top) and a diagram:',
        '',
        '![diagram](../assets/diagram.png)',
        '',
        '~~~',
        'A fenced [foo](guides/guide.md) is prose, not a link.',
        '~~~',
      ].join('\n'),
    ),
    'docs/guides/guide.md': doc('docs.guide', ['# guide', '', 'Back to [foo](../foo.md#foo).'].join('\n'), '2026-02-02'),
    'assets/diagram.png': 'not really a png',
  };
}

describe('mdlineage move — plan and apply', () => {
  it('the default run prints the plan and writes nothing', () => {
    const ws = scratchWorkspace(tree());
    try {
      const before = readFileSync(join(ws.root, 'docs', 'foo.md'), 'utf8');
      const out = runCli(['move', 'docs/foo.md', 'docs/guides/foo.md'], ws.root);
      assert.equal(out.status, 0, out.stderr);
      assert.match(out.stdout, /mdlineage move: docs\/foo\.md -> docs\/guides\/foo\.md \(dry run/);
      assert.match(out.stdout, /docs\/guides\/foo\.md/);
      assert.match(out.stdout, /README\.md: \d+ link\(s\) re-pointed/);
      // The dry run is the whole point of the default: nothing moved, nothing
      // rewritten, no directory created.
      assert.equal(existsSync(join(ws.root, 'docs', 'guides', 'foo.md')), false);
      assert.equal(readFileSync(join(ws.root, 'docs', 'foo.md'), 'utf8'), before);
      assert.equal(readFileSync(join(ws.root, 'README.md'), 'utf8'), tree()['README.md']);
      assert.equal(readFileSync(join(ws.root, 'docs', 'guides', 'guide.md'), 'utf8'), tree()['docs/guides/guide.md']);
    } finally {
      ws.cleanup();
    }
  });

  it('--write moves the file, heals in-edges with their anchors and refreshes updated_at', () => {
    const ws = scratchWorkspace(tree());
    try {
      const out = runCli(['move', 'docs/foo.md', 'docs/guides/foo.md', '--write'], ws.root);
      assert.equal(out.status, 0, out.stderr);

      assert.equal(existsSync(join(ws.root, 'docs', 'foo.md')), false, 'the source is gone');
      assert.equal(existsSync(join(ws.root, 'docs', 'guides', 'foo.md')), true, 'the destination exists');

      // In-edge: README's two destinations, the second one keeping its fragment.
      const readme = readFileSync(join(ws.root, 'README.md'), 'utf8');
      assert.match(readme, /\[foo\]\(\.\/docs\/guides\/foo\.md\)/);
      assert.match(readme, /\[foo again\]\(\.\/docs\/guides\/foo\.md#foo\)/, 'the #fragment survives the move');
      // A link to an unrelated document is left exactly as it was.
      assert.match(readme, /\[guide\]\(\.\/docs\/guides\/guide\.md\)/);

      // The freshness clock follows the file: a relocate is a substantive edit.
      const moved = readFileSync(join(ws.root, 'docs', 'guides', 'foo.md'), 'utf8');
      assert.match(moved, new RegExp(`updated_at: ${today()}`), 'updated_at is refreshed to today');

      // The healed tree has no dangling link: the move left nothing behind.
      const checked = runCli(['check', '.', '--no-baseline', '--format', 'json'], ws.root);
      assert.equal(countOf(checked.stdout, 'MDL401'), 0, `MDL401 after the move: ${checked.stdout}`);
    } finally {
      ws.cleanup();
    }
  });

  it('a cross-level move (depth 1 → 2) re-spells every relative destination exactly', () => {
    const ws = scratchWorkspace(tree());
    try {
      const out = runCli(['move', 'docs/foo.md', 'docs/guides/foo.md', '--write'], ws.root);
      assert.equal(out.status, 0, out.stderr);

      const moved = readFileSync(join(ws.root, 'docs', 'guides', 'foo.md'), 'utf8');
      // Out-edges keep the same absolute target: `guides/guide.md` is now a
      // sibling, and the readme is one level further away.
      assert.match(moved, /\[guide\]\(\.\/guide\.md\)/);
      assert.match(moved, /\[readme\]\(\.\.\/\.\.\/README\.md#top\)/);
      // An image destination is healed exactly like a link destination.
      assert.match(moved, /!\[diagram\]\(\.\.\/\.\.\/assets\/diagram\.png\)/);
      // A fenced block is prose: its destination is never rewritten.
      assert.match(moved, /A fenced \[foo\]\(guides\/guide\.md\) is prose/);

      // The referrer one level down keeps pointing at the same file.
      const guide = readFileSync(join(ws.root, 'docs', 'guides', 'guide.md'), 'utf8');
      assert.match(guide, /\[foo\]\(\.\/foo\.md#foo\)/);
    } finally {
      ws.cleanup();
    }
  });

  it('a reference-style definition is healed with the links that use it', () => {
    const ws = scratchWorkspace({
      'docs/foo.md': doc('docs.foo', ['# foo', '', '[the guide][g]', '', '[g]: guides/guide.md'].join('\n')),
      'docs/guides/guide.md': doc('docs.guide', '# guide'),
    });
    try {
      const out = runCli(['move', 'docs/foo.md', 'docs/guides/foo.md', '--write'], ws.root);
      assert.equal(out.status, 0, out.stderr);
      const moved = readFileSync(join(ws.root, 'docs', 'guides', 'foo.md'), 'utf8');
      assert.match(moved, /\[g\]: \.\/guide\.md/, 'the definition is rewritten');
      assert.match(moved, /\[the guide\]\[g\]/, 'the reference itself is unchanged');
    } finally {
      ws.cleanup();
    }
  });

  it('--dry-run with --write still writes nothing', () => {
    const ws = scratchWorkspace(tree());
    try {
      const out = runCli(['move', 'docs/foo.md', 'docs/guides/foo.md', '--write', '--dry-run'], ws.root);
      assert.equal(out.status, 0, out.stderr);
      assert.match(out.stdout, /--dry-run given with --write/);
      assert.equal(existsSync(join(ws.root, 'docs', 'guides', 'foo.md')), false);
      assert.equal(readFileSync(join(ws.root, 'docs', 'foo.md'), 'utf8'), tree()['docs/foo.md']);
    } finally {
      ws.cleanup();
    }
  });

  it('a tracked file is moved with git mv, so history follows it', () => {
    const ws = scratchWorkspace(tree());
    try {
      const git = spawnSync('git', ['init', '-q', '.'], { cwd: ws.root, encoding: 'utf8', windowsHide: true });
      assert.equal(git.status, 0);
      const add = spawnSync('git', ['add', '-A'], { cwd: ws.root, encoding: 'utf8', windowsHide: true });
      assert.equal(add.status, 0);
      const commit = spawnSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-qm', 'init'], {
        cwd: ws.root,
        encoding: 'utf8',
        windowsHide: true,
      });
      assert.equal(commit.status, 0);

      const out = runCli(['move', 'docs/foo.md', 'docs/guides/foo.md', '--write'], ws.root);
      assert.equal(out.status, 0, out.stderr);
      assert.match(out.stdout, /1 file moved \(git mv\)/);

      const status = spawnSync('git', ['status', '--porcelain'], { cwd: ws.root, encoding: 'utf8', windowsHide: true });
      assert.match(status.stdout ?? '', /^R.*docs\/foo\.md -> docs\/guides\/foo\.md/m, 'git records a rename');
    } finally {
      ws.cleanup();
    }
  });

  it('an existing destination directory receives the file beside its contents', () => {
    const ws = scratchWorkspace(tree());
    try {
      const out = runCli(['move', 'docs/foo.md', 'docs/guides', '--write'], ws.root);
      assert.equal(out.status, 0, out.stderr);
      assert.equal(existsSync(join(ws.root, 'docs', 'guides', 'foo.md')), true);
      assert.equal(existsSync(join(ws.root, 'docs', 'foo.md')), false);
      assert.equal(existsSync(join(ws.root, 'docs', 'guides', 'guide.md')), true, 'the directory keeps its contents');
    } finally {
      ws.cleanup();
    }
  });

  it('a document without front matter moves and its links still heal', () => {
    const ws = scratchWorkspace({
      'notes.md': ['# notes', '', 'See [foo](docs/foo.md).'].join('\n'),
      'docs/foo.md': ['# foo', '', 'Back to [notes](../notes.md).'].join('\n'),
    });
    try {
      const out = runCli(['move', 'docs/foo.md', 'docs/archive/foo.md', '--write'], ws.root);
      assert.equal(out.status, 0, out.stderr);
      assert.match(readFileSync(join(ws.root, 'docs', 'archive', 'foo.md'), 'utf8'), /\[notes\]\(\.\.\/\.\.\/notes\.md\)/);
      assert.match(readFileSync(join(ws.root, 'notes.md'), 'utf8'), /\[foo\]\(\.\/docs\/archive\/foo\.md\)/);
    } finally {
      ws.cleanup();
    }
  });

  it('a link whose label spells the destination is healed without rewriting the label', () => {
    const ws = scratchWorkspace({
      'b.md': '# b\n',
      'foo.md': '# foo\n',
      'ref.md': [
        '# ref',
        '',
        'A [b.md](b.md), a [foo.md#bar](foo.md#bar) and a definition:',
        '',
        '[b.md]: b.md',
        '',
      ].join('\n'),
    });
    try {
      const first = runCli(['move', 'b.md', 'guides/b.md', '--write'], ws.root);
      assert.equal(first.status, 0, first.stderr);
      const second = runCli(['move', 'foo.md', 'guides/foo.md', '--write'], ws.root);
      assert.equal(second.status, 0, second.stderr);

      const ref = readFileSync(join(ws.root, 'ref.md'), 'utf8');
      // The label is prose, the URL is the pointer: only the URL moves, and the
      // `#fragment` of the second one survives both moves.
      assert.match(ref, /\[b\.md\]\(\.\/guides\/b\.md\)/, 'the URL is rewritten, the label is not');
      assert.match(ref, /\[foo\.md#bar\]\(\.\/guides\/foo\.md#bar\)/);
      assert.match(ref, /\[b\.md\]: \.\/guides\/b\.md/, 'the definition URL is rewritten, its label is not');
      assert.ok(!/\[\.\/guides/.test(ref), 'no label was rewritten into a path');
    } finally {
      ws.cleanup();
    }
  });
});

describe('mdlineage move — a configuration it cannot use', () => {
  it('refuses to move when the config carries an error-level diagnostic', () => {
    const ws = scratchWorkspace({
      // YAML the loader cannot parse: MDL900 at error level, so the move is
      // refused instead of run against the built-in defaults.
      'mdlineage.config.yaml': 'configVersion: 1\nmetadata: [unclosed\n',
      'a.md': '# a\n',
    });
    try {
      const out = runCli(['move', 'a.md', 'b.md', '--write'], ws.root);
      assert.equal(out.status, 1);
      assert.match(out.stderr, /MDL900 error/);
      assert.match(out.stderr, /refusing to move/);
      assert.equal(readFileSync(join(ws.root, 'a.md'), 'utf8'), '# a\n', 'the source stayed put');
      assert.equal(existsSync(join(ws.root, 'b.md')), false, 'nothing was written');
    } finally {
      ws.cleanup();
    }
  });
});

describe('mdlineage move — executeMove refuses to overwrite a destination', () => {
  it('rejects the whole move when the destination already exists', () => {
    const ws = scratchWorkspace({ 'a.md': '# a\n', 'b.md': '# b\n' });
    try {
      const config = loadConfig(undefined, ws.root).config;
      const workspace = new Workspace(ws.root, config, [['a.md', '# a\n']]);
      const outcome = executeMove(planMove('a.md', 'b.md', workspace, today()), workspace);
      assert.deepEqual(outcome.errors, ['destination already exists: b.md']);
      assert.deepEqual(outcome.written, []);
      assert.equal(readFileSync(join(ws.root, 'a.md'), 'utf8'), '# a\n', 'the source is untouched');
      assert.equal(readFileSync(join(ws.root, 'b.md'), 'utf8'), '# b\n', 'the destination is untouched');
    } finally {
      ws.cleanup();
    }
  });
});

describe('mdlineage move — usage errors (exit 2, no stack)', () => {
  it('rejects a missing destination, a missing source and a third argument', () => {
    const ws = scratchWorkspace({ 'a.md': '# a\n' });
    try {
      for (const args of [
        ['move'],
        ['move', 'a.md'],
        ['move', 'nope.md', 'b.md'],
        ['move', 'a.md', 'b.md', 'c.md'],
        ['move', 'a.md', 'a.md'],
      ]) {
        const out = runCli(args, ws.root);
        assert.equal(out.status, 2, `${args.join(' ')} exited ${out.status}`);
        assert.ok(out.stderr.startsWith('mdlineage: '), `stderr: ${out.stderr}`);
        assert.ok(!/^\s+at /m.test(out.stderr), 'no stack trace on a usage error');
      }
    } finally {
      ws.cleanup();
    }
  });

  it('refuses a destination that already exists', () => {
    const ws = scratchWorkspace({ 'a.md': '# a\n', 'b.md': '# b\n' });
    try {
      const out = runCli(['move', 'a.md', 'b.md'], ws.root);
      assert.equal(out.status, 2);
      assert.match(out.stderr, /destination already exists: b\.md/);
      assert.equal(readFileSync(join(ws.root, 'a.md'), 'utf8'), '# a\n');
      assert.equal(readFileSync(join(ws.root, 'b.md'), 'utf8'), '# b\n');
    } finally {
      ws.cleanup();
    }
  });

  it('refuses a path that leaves the workspace', () => {
    const ws = scratchWorkspace({ 'a.md': '# a\n' });
    try {
      // The containment check runs before any filesystem question, so a path
      // outside the workspace is refused instead of searched for.
      const outside = runCli(['move', '../outside.md', 'b.md'], ws.root);
      assert.equal(outside.status, 2);
      assert.match(outside.stderr, /refusing to move outside the workspace/);

      const missing = runCli(['move', 'nope.md', 'b.md'], ws.root);
      assert.equal(missing.status, 2);
      assert.match(missing.stderr, /no such file: nope\.md/);

      const escaping = runCli(['move', 'a.md', '../b.md'], ws.root);
      assert.equal(escaping.status, 2);
      assert.match(escaping.stderr, /refusing to move outside the workspace/);
      assert.equal(existsSync(join(ws.root, 'a.md')), true, 'the source is untouched');
    } finally {
      ws.cleanup();
    }
  });

  it('an unknown option is a usage error, not a crash', () => {
    const out = runCli(['move', 'a.md', 'b.md', '--nonsense'], repoRoot);
    assert.equal(out.status, 2);
    assert.ok(out.stderr.includes('Unknown option'), `stderr: ${out.stderr}`);
    assert.ok(!/^\s+at /m.test(out.stderr));
  });
});
