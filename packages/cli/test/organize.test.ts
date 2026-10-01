/**
 * `mdlineage organize` end-to-end tests (docs/dir-conventions.md §2
 * "Layout-aware suggestions").
 *
 * The plan is asserted through the same binary a user runs: what it recommends,
 * what it refuses to recommend, and what `--apply` leaves on disk.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..');
const cliBin = resolve(repoRoot, 'packages', 'cli', 'dist', 'main.js');

interface RunOutput {
  stdout: string;
  stderr: string;
  status: number | null;
}

function runCli(args: string[], cwd: string): RunOutput {
  const result = spawnSync(process.execPath, [cliBin, ...args], { cwd, encoding: 'utf8', windowsHide: true });
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status };
}

/** Isolated scratch tree with a config that declares directory intents. */
function scratchWorkspace(files: Record<string, string>): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'mdlineage-organize-'));
  for (const [name, content] of Object.entries(files)) {
    const path = resolve(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** A document with the given kind, or with no front matter at all. */
function doc(id: string, kind: string, body = '# body\n'): string {
  return ['---', 'mdlineage:', '  schema: 1', `  id: ${id}`, `  kind: ${kind}`, '  status: active', '---', '', body].join(
    '\n',
  );
}

/** Config: the docs tree holds policies, guides/ holds guides, reference/ holds references. */
const CONFIG = [
  'configVersion: 1',
  '',
  'metadata:',
  '  required: false',
  '',
  'vocabulary:',
  '  kinds: [policy, guide, reference]',
  '  statuses: [draft, active, deprecated]',
  '',
  'layout:',
  "  - match: '**/*.md'",
  '    require:',
  '      frontmatter: optional',
  "  - match: 'docs/**'",
  '    intent:',
  '      kinds: [policy]',
  "  - match: 'docs/guides/**'",
  '    intent:',
  '      kinds: [guide]',
  "  - match: 'docs/reference/**'",
  '    intent:',
  '      kinds: [reference]',
  '',
].join('\n');

/** A tree in which `docs/foo.md` is a reference sitting in the policy tree. */
function misplacedTree(): Record<string, string> {
  return {
    'mdlineage.config.yaml': CONFIG,
    'README.md': ['# top', '', 'A [policy](docs/policy.md), a [reference](docs/foo.md) and a [guide](docs/guides/guide.md).', ''].join(
      '\n',
    ),
    'docs/policy.md': doc('docs.policy', 'policy', '# policy\n'),
    'docs/foo.md': doc('docs.foo', 'reference', '# foo\n\nThe [guide](guides/guide.md) and the [readme](../README.md#top).\n'),
    'docs/guides/guide.md': doc('docs.guide', 'guide', '# guide\n\nBack to [foo](../foo.md#foo).\n'),
  };
}

/** Occurrences of a diagnostic code across a JSON check run. */
function countOf(stdout: string, code: string): number {
  const parsed = JSON.parse(stdout) as { reports: Array<{ diagnostics: Array<{ code: string }> }> };
  let n = 0;
  for (const report of parsed.reports) for (const d of report.diagnostics) if (d.code === code) n += 1;
  return n;
}

describe('mdlineage organize — inventory and report', () => {
  it('--inventory reports the kind and directory distribution and the scattered files', () => {
    const ws = scratchWorkspace(misplacedTree());
    try {
      const out = runCli(['organize', '--inventory'], ws.root);
      assert.equal(out.status, 0, out.stderr);
      assert.match(out.stdout, /organize: inventory \(4 documents\)/);

      assert.match(out.stdout, /kind distribution:/);
      assert.match(out.stdout, /\(none\)\s+1/, 'README.md carries no front matter');
      assert.match(out.stdout, /guide\s+1/);
      assert.match(out.stdout, /reference\s+1/);
      assert.match(out.stdout, /policy\s+1/);

      assert.match(out.stdout, /directory distribution:/);
      assert.match(out.stdout, /docs\s+2/, 'two documents sit directly in docs/');
      assert.match(out.stdout, /docs\/guides\s+1/);

      // No rule declares an intent for the root, so README.md is unclaimed.
      assert.match(out.stdout, /scattered files \(no directory declares an intent\): 1/);
      assert.match(out.stdout, /README\.md/);
    } finally {
      ws.cleanup();
    }
  });

  it('--report states the intent compliance rate and counts the exceptions', () => {
    const ws = scratchWorkspace(misplacedTree());
    try {
      const out = runCli(['organize', '--report'], ws.root);
      assert.equal(out.status, 0, out.stderr);
      assert.match(out.stdout, /organize: report — 3\/4 documents match their directory intent \(75%\)/);
      assert.match(out.stdout, /misplaced \(kind\):\s+1/);
      assert.match(out.stdout, /layout exceptions:\s+0/);
      assert.match(out.stdout, /declared intents:/);
      assert.match(out.stdout, /docs\/guides\/\*\*\s+docs\/guides\s+kinds \[guide\]/);
    } finally {
      ws.cleanup();
    }
  });

  it('--inventory and --report both print, and neither writes', () => {
    const ws = scratchWorkspace(misplacedTree());
    try {
      const out = runCli(['organize', '--inventory', '--report', '--write'], ws.root);
      assert.equal(out.status, 0, out.stderr);
      assert.match(out.stdout, /organize: inventory/);
      assert.match(out.stdout, /organize: report/);
      // `--write` belongs to the plan: a report mode is called out for it.
      assert.match(out.stderr, /--apply\/--write only affect the plan; nothing was written/);
      assert.equal(readFileSync(join(ws.root, 'docs', 'foo.md'), 'utf8'), misplacedTree()['docs/foo.md']);
    } finally {
      ws.cleanup();
    }
  });
});

describe('mdlineage organize — plan and apply', () => {
  it('--plan identifies the misplaced document and names the directory that claims its kind', () => {
    const ws = scratchWorkspace(misplacedTree());
    try {
      const out = runCli(['organize', '--plan'], ws.root);
      assert.equal(out.status, 0, out.stderr);
      assert.match(out.stdout, /organize: plan \(dry run; use --apply or --write to execute\)/);
      assert.match(out.stdout, /move docs\/foo\.md -> docs\/reference\/foo\.md/);
      assert.match(out.stdout, /reason:\s+kind 'reference' is not in \[policy\] declared by 'docs\/\*\*'/);
      assert.match(out.stdout, /target:\s+'docs\/reference\/\*\*' declares kinds \[reference\]/);
      assert.match(out.stdout, /confidence: high/);
      // The cost is stated before anything moves: README and the guide both
      // link to it, and it links out twice.
      assert.match(out.stdout, /links:\s+2 incoming \(2 document\(s\)\), 2 outgoing/);
      assert.match(out.stdout, /1 move\(s\) planned, 4 link\(s\) to rewrite/);

      // A plan is a plan: nothing moved.
      assert.equal(existsSync(join(ws.root, 'docs', 'reference', 'foo.md')), false);
      assert.equal(readFileSync(join(ws.root, 'docs', 'foo.md'), 'utf8'), misplacedTree()['docs/foo.md']);
    } finally {
      ws.cleanup();
    }
  });

  it('a kind no directory declares is reported, never guessed at', () => {
    const ws = scratchWorkspace({
      'mdlineage.config.yaml': CONFIG,
      // `spec` is outside the vocabulary, and no directory declares it either.
      'docs/spec.md': ['---', 'mdlineage:', '  schema: 1', '  id: docs.spec', '  kind: spec', '  status: active', '---', ''].join(
        '\n',
      ),
    });
    try {
      const out = runCli(['organize', '--plan'], ws.root);
      assert.equal(out.status, 0, out.stderr);
      assert.match(out.stdout, /docs\/spec\.md: kind 'spec' has no directory declaring it/);
      assert.ok(!/move docs\/spec\.md/.test(out.stdout), 'no destination is invented');
      assert.match(out.stdout, /0 move\(s\) planned/);
      assert.equal(existsSync(join(ws.root, 'docs', 'spec.md')), true);
    } finally {
      ws.cleanup();
    }
  });

  it('--apply executes the plan and leaves the tree consistent', () => {
    const ws = scratchWorkspace(misplacedTree());
    try {
      const plan = runCli(['organize', '--plan'], ws.root);
      const out = runCli(['organize', '--apply'], ws.root);
      assert.equal(out.status, 0, out.stderr);
      assert.match(out.stdout, /moved docs\/foo\.md -> docs\/reference\/foo\.md/);
      assert.match(out.stdout, /1 file\(s\) moved, 0 skipped, 4 link\(s\) rewritten/);

      // The moved document is gone from its old place and healed at its new one.
      assert.equal(existsSync(join(ws.root, 'docs', 'foo.md')), false);
      assert.equal(existsSync(join(ws.root, 'docs', 'reference', 'foo.md')), true);
      assert.match(readFileSync(join(ws.root, 'README.md'), 'utf8'), /\[reference\]\(\.\/docs\/reference\/foo\.md\)/);
      assert.match(
        readFileSync(join(ws.root, 'docs', 'guides', 'guide.md'), 'utf8'),
        /\[foo\]\(\.\.\/reference\/foo\.md#foo\)/,
      );
      assert.match(readFileSync(join(ws.root, 'docs', 'reference', 'foo.md'), 'utf8'), /\[guide\]\(\.\.\/guides\/guide\.md\)/);

      // Nothing dangles, and the second run agrees there is nothing left to do.
      const checked = runCli(['check', '.', '--no-baseline', '--format', 'json'], ws.root);
      assert.equal(countOf(checked.stdout, 'MDL401'), 0, `MDL401 after the move: ${checked.stdout}`);
      // `check` runs EVERY matching rule, so the blunt `docs/**` intent still
      // rejects both trees below docs/; the plan resolves the most specific
      // claim, which is the documented difference, and it is now satisfied.
      const reports = (
        JSON.parse(checked.stdout) as { reports: Array<{ path: string; diagnostics: Array<{ code: string }> }> }
      ).reports;
      const flagged = reports.filter((r) => r.diagnostics.some((d) => d.code === 'MDL502')).map((r) => r.path);
      assert.deepEqual(flagged.sort(), ['docs/guides/guide.md', 'docs/reference/foo.md']);
      assert.match(plan.stdout, /move docs\/foo\.md/);

      const again = runCli(['organize', '--plan'], ws.root);
      assert.match(again.stdout, /4 documents, none misplaced/);
    } finally {
      ws.cleanup();
    }
  });

  it('--write is the alias --apply documents', () => {
    const ws = scratchWorkspace(misplacedTree());
    try {
      const out = runCli(['organize', '--write'], ws.root);
      assert.equal(out.status, 0, out.stderr);
      assert.match(out.stdout, /moved docs\/foo\.md -> docs\/reference\/foo\.md/);
      assert.equal(existsSync(join(ws.root, 'docs', 'reference', 'foo.md')), true);
    } finally {
      ws.cleanup();
    }
  });

  it('--apply heals both destinations of a document two moved files are linked from', () => {
    const ws = scratchWorkspace({
      'mdlineage.config.yaml': CONFIG,
      'README.md': ['# top', '', 'A [b](docs/b.md) and a [c](docs/c.md).', ''].join('\n'),
      'docs/policy.md': doc('docs.policy', 'policy', '# policy\n'),
      'docs/b.md': doc('docs.b', 'reference', '# b\n'),
      'docs/c.md': doc('docs.c', 'reference', '# c\n'),
    });
    try {
      const out = runCli(['organize', '--apply'], ws.root);
      assert.equal(out.status, 0, out.stderr);
      assert.match(out.stdout, /moved docs\/b\.md -> docs\/reference\/b\.md/);
      assert.match(out.stdout, /moved docs\/c\.md -> docs\/reference\/c\.md/);
      assert.match(out.stdout, /2 file\(s\) moved, 0 skipped, 2 link\(s\) rewritten/);

      // Every move is planned against the tree the previous one left behind, so
      // the second move does not write the document its pre-batch text over
      // the first move's rewrites.
      assert.equal(existsSync(join(ws.root, 'docs', 'b.md')), false);
      assert.equal(existsSync(join(ws.root, 'docs', 'c.md')), false);
      const readme = readFileSync(join(ws.root, 'README.md'), 'utf8');
      assert.match(readme, /\[b\]\(\.\/docs\/reference\/b\.md\)/);
      assert.match(readme, /\[c\]\(\.\/docs\/reference\/c\.md\)/);

      const checked = runCli(['check', '.', '--no-baseline', '--format', 'json'], ws.root);
      assert.equal(countOf(checked.stdout, 'MDL401'), 0, `MDL401 after the apply: ${checked.stdout}`);
    } finally {
      ws.cleanup();
    }
  });

  it('--apply refuses a destination another move in the same batch claims', () => {
    const ws = scratchWorkspace({
      'mdlineage.config.yaml': CONFIG,
      'README.md': '# top\n',
      'docs/a/same.md': doc('docs.a.same', 'reference', '# a/same\n'),
      'docs/b/same.md': doc('docs.b.same', 'reference', '# b/same\n'),
    });
    try {
      const plan = runCli(['organize', '--plan'], ws.root);
      assert.match(plan.stdout, /1 move\(s\) planned/);
      assert.match(plan.stdout, /collision: docs\/b\/same\.md -> docs\/reference\/same\.md refused/);
      assert.equal(existsSync(join(ws.root, 'docs', 'reference', 'same.md')), false, 'the plan writes nothing');

      const out = runCli(['organize', '--apply'], ws.root);
      assert.equal(out.status, 0, out.stderr);
      assert.match(out.stdout, /1 file\(s\) moved, 0 skipped/);

      // The claimed destination holds the first document; the colliding one is
      // left exactly where it was instead of being written over it.
      assert.equal(existsSync(join(ws.root, 'docs', 'a', 'same.md')), false);
      assert.match(readFileSync(join(ws.root, 'docs', 'reference', 'same.md'), 'utf8'), /# a\/same/);
      assert.match(readFileSync(join(ws.root, 'docs', 'b', 'same.md'), 'utf8'), /# b\/same/);
    } finally {
      ws.cleanup();
    }
  });

  it('--apply refuses a destination that is itself still being moved', () => {
    const ws = scratchWorkspace({
      'mdlineage.config.yaml': CONFIG,
      'README.md': '# top\n',
      // A guide in docs/ belongs in docs/guides/, which holds a reference that
      // belongs in docs/reference/: two moves, one of them into the other's way.
      'docs/x.md': doc('docs.x', 'guide', '# x\n'),
      'docs/guides/x.md': doc('docs.guides.x', 'reference', '# guides/x\n'),
    });
    try {
      const plan = runCli(['organize', '--plan'], ws.root);
      assert.match(plan.stdout, /collision: docs\/x\.md -> docs\/guides\/x\.md refused/);
      assert.match(plan.stdout, /1 move\(s\) planned/);

      const out = runCli(['organize', '--apply'], ws.root);
      assert.equal(out.status, 0, out.stderr);
      assert.match(out.stdout, /moved docs\/guides\/x\.md -> docs\/reference\/x\.md/);
      // The blocked move stays put, so the document the other move evacuated is
      // not silently overwritten.
      assert.equal(existsSync(join(ws.root, 'docs', 'guides', 'x.md')), false);
      assert.match(readFileSync(join(ws.root, 'docs', 'x.md'), 'utf8'), /# x/);
      assert.match(readFileSync(join(ws.root, 'docs', 'reference', 'x.md'), 'utf8'), /# guides\/x/);
    } finally {
      ws.cleanup();
    }
  });

  it('a nested intent governs its own directory, so a guide in docs/guides is not misplaced', () => {
    const ws = scratchWorkspace({
      'mdlineage.config.yaml': CONFIG,
      'docs/guides/guide.md': doc('docs.guide', 'guide', '# guide\n'),
      'docs/guides/deep/nested.md': doc('docs.deep', 'guide', '# nested\n'),
    });
    try {
      const out = runCli(['organize', '--plan'], ws.root);
      assert.equal(out.status, 0, out.stderr);
      assert.match(out.stdout, /2 documents, none misplaced/);
      // `check` still runs every matching rule, so the broader `docs/**` intent
      // complains there; the plan is documented as the narrower view.
      const checked = runCli(['check', '.', '--no-baseline', '--format', 'json'], ws.root);
      assert.equal(countOf(checked.stdout, 'MDL502'), 2);
    } finally {
      ws.cleanup();
    }
  });

  it('a config with no intent block says so instead of moving anything', () => {
    const ws = scratchWorkspace({
      'mdlineage.config.yaml': ['configVersion: 1', '', 'metadata:', '  required: false', ''].join('\n'),
      'docs/foo.md': doc('docs.foo', 'reference', '# foo\n'),
    });
    try {
      const out = runCli(['organize', '--plan'], ws.root);
      assert.equal(out.status, 0, out.stderr);
      assert.match(out.stdout, /no directory declares an intent, so no document can be misplaced/);
      const report = runCli(['organize', '--report'], ws.root);
      assert.match(report.stdout, /no directory declares an intent, so every document is unclaimed/);
      assert.equal(existsSync(join(ws.root, 'docs', 'foo.md')), true);
    } finally {
      ws.cleanup();
    }
  });
});

describe('mdlineage organize — scope and usage errors', () => {
  it('--scope narrows the analysis to the matching documents', () => {
    const ws = scratchWorkspace(misplacedTree());
    try {
      const out = runCli(['organize', '--inventory', '--scope', 'docs/guides/**'], ws.root);
      assert.equal(out.status, 0, out.stderr);
      assert.match(out.stdout, /organize: inventory \(1 document\)/);
      assert.match(out.stdout, /guide\s+1/);
      assert.ok(!/reference/.test(out.stdout), 'documents outside the scope are not analysed');
    } finally {
      ws.cleanup();
    }
  });

  it('a --scope that matches nothing is a usage error', () => {
    const ws = scratchWorkspace(misplacedTree());
    try {
      const out = runCli(['organize', '--scope', 'nowhere/**'], ws.root);
      assert.equal(out.status, 2);
      assert.match(out.stderr, /--scope matches no document: nowhere\/\*\*/);
      assert.ok(!/^\s+at /m.test(out.stderr), 'no stack trace on a usage error');
    } finally {
      ws.cleanup();
    }
  });

  it('organize takes no paths and rejects a stray argument', () => {
    const ws = scratchWorkspace(misplacedTree());
    try {
      const out = runCli(['organize', 'docs/foo.md'], ws.root);
      assert.equal(out.status, 2);
      assert.match(out.stderr, /organize takes no paths/);
      const unknown = runCli(['organize', '--nonsense'], ws.root);
      assert.equal(unknown.status, 2);
      assert.ok(unknown.stderr.includes('Unknown option'), `stderr: ${unknown.stderr}`);
      assert.ok(!/^\s+at /m.test(unknown.stderr));
    } finally {
      ws.cleanup();
    }
  });
});
