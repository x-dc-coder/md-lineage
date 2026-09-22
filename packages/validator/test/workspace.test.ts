/**
 * Workspace-layer tests (docs/remark-language-server-solution.md §4.5, §16 M2).
 *
 * Two concerns, kept separate:
 *   - the manifest's `workspace/` fixtures as a set: the four documents pin
 *     MDL301 (dup-id pair), MDL302 (dup-id-b) and MDL305 (cycle pair), and must
 *     produce zero single-document false positives (test/fixtures/README.md
 *     rule 2: `workspace/` carries only cross-file codes);
 *   - synthetic scenarios for the rest of the layer, built inline so each one
 *     names exactly the rule combination it exercises (adding a fixture would
 *     mean extending the protected manifest contract).
 *
 * Run with: node --import tsx --test packages/validator/test/workspace.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defaultConfig } from '../src/index.js';
import { createWorkspaceIndex, updateFile, removeFile, updateFiles } from '../src/workspace-index.js';
import type { WorkspaceIndex } from '../src/workspace-index.js';
import { validateWorkspace } from '../src/workspace-validator.js';
import type { WorkspaceDiagnostic } from '../src/workspace-validator.js';
import { parseBaseline, writeBaseline, pruneBaseline, baselineMatches } from '../src/baseline.js';
import type { Baseline } from '../src/baseline.js';

const repoRoot = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..');
const fixtureRoot = resolve(repoRoot, 'test', 'fixtures', 'workspace');

const WS_FIXTURES = ['dup-id-a.md', 'dup-id-b.md', 'cycle-a.md', 'cycle-b.md'] as const;

function readWorkspaceFixture(path: string): string {
  return readFileSync(resolve(fixtureRoot, path), 'utf8');
}

function workspaceFixtureIndex(paths: readonly string[] = WS_FIXTURES): WorkspaceIndex {
  const files = new Map<string, string>();
  for (const p of paths) files.set(p, readWorkspaceFixture(p));
  return createWorkspaceIndex(files, defaultConfig());
}

/** A minimal valid document with the given id and optional relations/body. */
function doc(id: string, relations: string = '', body = ''): string {
  return ['---', 'mdlineage:', '  schema: 1', `  id: ${id}`, '  kind: policy', '  status: active', relations, '---', '', body].join(
    '\n',
  );
}

function relations(...entries: Array<Record<string, string>>): string {
  if (entries.length === 0) return '';
  const lines = ['  relations:'];
  for (const e of entries) {
    lines.push('    - type: ' + (e.type ?? 'related_to'));
    if (e.target !== undefined) lines.push('      target: ' + e.target);
    if (e.reason !== undefined) lines.push('      reason: ' + JSON.stringify(e.reason));
    if (e.evidence !== undefined) lines.push('      evidence: ' + JSON.stringify(e.evidence));
  }
  return lines.join('\n');
}

/** Diagnostics of one code, as (path, code) pairs, sorted for stability. */
function byCode(all: readonly WorkspaceDiagnostic[], code: string): WorkspaceDiagnostic[] {
  return all.filter((d) => d.code === code).sort((a, b) => a.path.localeCompare(b.path));
}

function pathsOf(all: readonly WorkspaceDiagnostic[]): string[] {
  return [...new Set(all.map((d) => d.path))].sort();
}

/** The validator's own sort key, mirrored here so the tests can assert it. */
function byReportOrder(a: WorkspaceDiagnostic, b: WorkspaceDiagnostic): number {
  return (
    a.path.localeCompare(b.path) ||
    a.range.start.offset - b.range.start.offset ||
    a.code.localeCompare(b.code)
  );
}

describe('workspace fixtures (manifest contract)', () => {
  it('the four workspace fixtures produce MDL301 on the second claimant only', () => {
    const index = workspaceFixtureIndex();
    const all = validateWorkspace(index, { includeSingleDocument: false });
    const d301 = byCode(all, 'MDL301');
    assert.equal(d301.length, 1, `expected one MDL301, got ${d301.length}`);
    // Sorted order makes dup-id-a.md the canonical claimant, so dup-id-b.md reports.
    assert.equal(d301[0]!.path, 'dup-id-b.md');
    assert.deepEqual(
      d301[0]!.data,
      { id: 'docs.duplicate-id-a', claimedBy: 'dup-id-a.md', claimants: ['dup-id-a.md', 'dup-id-b.md'] },
    );
  });

  it('the cycle pair produces one MDL305 for the component', () => {
    const index = workspaceFixtureIndex();
    const all = validateWorkspace(index, { includeSingleDocument: false });
    const d305 = byCode(all, 'MDL305');
    // MDL305 reports per strongly connected component, not per cycle edge: A↔B
    // is one component, so one diagnostic, anchored on the smallest path.
    assert.equal(d305.length, 1, `expected one MDL305 for the SCC, got ${d305.length}`);
    assert.equal(d305[0]!.path, 'cycle-a.md', 'the lexicographically smaller member anchors it');
    assert.deepEqual(d305[0]!.data, {
      type: 'supersedes',
      cycle: ['docs.cycle-a', 'docs.cycle-b'],
      size: 2,
    });
    assert.match(
      d305[0]!.message,
      /supersedes cycle among 2 documents: docs\.cycle-a → docs\.cycle-b → docs\.cycle-a/,
    );
  });

  it('dup-id-b reports MDL302 for its unresolvable target', () => {
    const index = workspaceFixtureIndex();
    const all = validateWorkspace(index, { includeSingleDocument: false });
    const d302 = byCode(all, 'MDL302');
    // Two: dup-id-b's own missing target, plus dup-id-a's depends_on on
    // docs.cache-policy, which no workspace fixture claims.
    assert.equal(d302.length, 2, `expected two MDL302, got ${d302.length}`);
    const ours = d302.find((d) => d.data?.target === 'docs.missing-target')!;
    assert.ok(ours, 'dup-id-b must report its own unresolvable target');
    assert.equal(ours.path, 'dup-id-b.md');
    // The diagnostic lands on the relation declaration, not on line 1.
    const lines = readWorkspaceFixture(ours.path).split('\n');
    const at = lines[ours.range.start.line - 1]!;
    assert.ok(
      at.includes('type:') || at.includes('target:') || at.includes('relations:'),
      `MDL302 range landed on ${JSON.stringify(at)}`,
    );
    assert.ok(ours.range.start.line > 1, 'MDL302 must point inside the front matter');
  });

  it('workspace fixtures produce zero single-document codes', () => {
    const index = workspaceFixtureIndex();
    const all = validateWorkspace(index, { includeSingleDocument: true });
    const singleDocCodes = ['MDL001', 'MDL002', 'MDL003', 'MDL101', 'MDL102', 'MDL103', 'MDL104', 'MDL201', 'MDL202'];
    const noise = all.filter((d) => singleDocCodes.includes(d.code));
    assert.deepEqual(
      [...new Set(noise.map((d) => `${d.path}:${d.code}`))].sort(),
      [],
      'workspace fixtures must produce no single-document codes',
    );
  });

  it('MDL402 is produced when the target lacks the evidence anchor', () => {
    // v01's evidence #cache-key resolves against docs.cache-policy in valid/,
    // which is not part of the workspace fixture set, so the pair pins MDL402.
    const files = new Map<string, string>([
      ['v01.md', readFileSync(resolve(repoRoot, 'test', 'fixtures', 'valid', 'v01-full.md'), 'utf8')],
      ['target.md', doc('docs.authentication-model', relations({ type: 'related_to', target: 'docs.cache-policy' }))],
    ]);
    const index = createWorkspaceIndex(files, defaultConfig());
    const all = validateWorkspace(index, { includeSingleDocument: false });
    const d402 = byCode(all, 'MDL402');
    assert.equal(d402.length, 1, 'expected one MDL402 for the missing cross-file anchor');
    assert.equal(d402[0]!.path, 'v01.md');
    assert.equal(d402[0]!.data?.anchor, 'cache-key');
  });

  it('MDL402 is absent when the target document has the anchor', () => {
    const files = new Map<string, string>([
      ['source.md', doc('docs.a', relations({ type: 'refines', target: 'docs.b', reason: 'narrower.', evidence: '#heading' }))],
      ['target.md', doc('docs.b', relations(), '# Heading\n\nBody.\n')],
    ]);
    const index = createWorkspaceIndex(files, defaultConfig());
    const all = validateWorkspace(index, { includeSingleDocument: false });
    assert.equal(byCode(all, 'MDL402').length, 0);
  });

  it('MDL402 resolves against the target, never the source (MDL201 owns local)', () => {
    const files = new Map<string, string>([
      // The anchor exists in the SOURCE but not in the TARGET: MDL402, not clean.
      ['source.md', doc('docs.a', relations({ type: 'refines', target: 'docs.b', reason: 'x', evidence: '#local' }), '# Local\n')],
      ['target.md', doc('docs.b', relations(), '# Other\n')],
    ]);
    const index = createWorkspaceIndex(files, defaultConfig());
    const all = validateWorkspace(index, { includeSingleDocument: false });
    assert.equal(byCode(all, 'MDL402').length, 1);
    assert.equal(byCode(all, 'MDL201').length, 0, 'an anchor resolving in the source is not an in-document failure');
  });
});

describe('MDL401 — markdown link targets', () => {
  const body = (links: string) => `${links}\n`;

  it('M-1: the line and column are exact with front matter above the link', () => {
    // The mdast tree is parsed from the body slice, so a link offset that is
    // not shifted by the front matter length lands that many code units early:
    // a 6-line front matter put this link on line 1 instead of line 10.
    const frontMatter = [
      '---',
      'mdlineage:',
      '  schema: 1',
      '  id: docs.link-source',
      '  kind: policy',
      '  status: active',
      '---',
      '',
      '# Heading',
      '',
    ].join('\n');
    // Column 5 is the link's text, one past the "See " prefix.
    const content = `${frontMatter}See [the missing one](./nope.md).\n`;
    const files = new Map<string, string>([
      ['a.md', content],
      ['b.md', doc('docs.b')],
    ]);
    const index = createWorkspaceIndex(files, defaultConfig());
    const all = validateWorkspace(index, { includeSingleDocument: false });
    const d401 = byCode(all, 'MDL401');
    assert.equal(d401.length, 1);
    assert.equal(d401[0]!.range.start.line, 10, 'the link is on the third body line');
    assert.equal(d401[0]!.range.start.column, 5, 'the link opens after "See "');
    assert.equal(d401[0]!.range.end.line, 10);
    assert.equal(d401[0]!.range.start.offset, content.indexOf('['));
  });

  it('M-1: a document without front matter keeps the same arithmetic', () => {
    const content = '# Heading\n\nSee [the missing one](./nope.md).\n';
    const files = new Map<string, string>([['a.md', content]]);
    const index = createWorkspaceIndex(files, defaultConfig());
    const all = validateWorkspace(index, { includeSingleDocument: false });
    const d401 = byCode(all, 'MDL401');
    assert.equal(d401[0]!.range.start.line, 3);
    assert.equal(d401[0]!.range.start.column, 5);
  });

  it('reports a relative path that resolves to no indexed document', () => {
    const files = new Map<string, string>([
      ['a.md', doc('docs.a', relations(), body('See [the missing one](./nope.md).'))],
      ['b.md', doc('docs.b', relations(), body('Present.'))],
    ]);
    const index = createWorkspaceIndex(files, defaultConfig());
    const all = validateWorkspace(index, { includeSingleDocument: false });
    const d401 = byCode(all, 'MDL401');
    assert.equal(d401.length, 1);
    assert.equal(d401[0]!.path, 'a.md');
    assert.equal(d401[0]!.data?.path, './nope.md');
    // Points at the link, not at the document start.
    assert.ok(d401[0]!.range.start.line > 1, 'MDL401 must point at the link line');
  });

  it('skips external http(s) links, mailto and other schemes', () => {
    const files = new Map<string, string>([
      [
        'a.md',
        doc(
          'docs.a',
          relations(),
          body([
            '[https](https://example.com/a.md)',
            '[http](http://example.com/a.md)',
            '[mail](mailto:user@example.com)',
            '[ftp](ftp://example.com/a.md)',
            '[doc](./present.md)',
          ].join('\n')),
        ),
      ],
      ['present.md', doc('docs.b')],
    ]);
    const index = createWorkspaceIndex(files, defaultConfig());
    const all = validateWorkspace(index, { includeSingleDocument: false });
    // The external links are skipped; only the resolvable relative one is present.
    assert.equal(byCode(all, 'MDL401').length, 0);
  });

  it('skips a same-page anchor link (MDL201 domain)', () => {
    const files = new Map<string, string>([['a.md', doc('docs.a', relations(), body('See [section](#no-such-anchor).'))]]);
    const index = createWorkspaceIndex(files, defaultConfig());
    const all = validateWorkspace(index, { includeSingleDocument: false });
    assert.equal(byCode(all, 'MDL401').length, 0, 'a #anchor link has no path for MDL401 to check');
  });

  it('splits a file link with an anchor into path and anchor parts', () => {
    const files = new Map<string, string>([
      ['a.md', doc('docs.a', relations(), body('See [it](./present.md#anchor).'))],
      ['present.md', doc('docs.b', relations(), '# Heading\n')],
    ]);
    const index = createWorkspaceIndex(files, defaultConfig());
    const all = validateWorkspace(index, { includeSingleDocument: false });
    assert.equal(byCode(all, 'MDL401').length, 0, 'the path part resolves');
    assert.equal(byCode(all, 'MDL402').length, 0, 'the anchor part resolves in the target');
  });

  it('resolves ../ relative links against the linking document', () => {
    const files = new Map<string, string>([
      ['docs/a.md', doc('docs.a', relations(), body('Up to [root](../root.md).'))],
      ['root.md', doc('docs.b')],
    ]);
    const index = createWorkspaceIndex(files, defaultConfig());
    const all = validateWorkspace(index, { includeSingleDocument: false });
    assert.equal(byCode(all, 'MDL401').length, 0);
    assert.equal(index.linkReferrersOf('root.md').length, 1);
  });

  it('ignores image links', () => {
    const files = new Map<string, string>([
      ['a.md', doc('docs.a', relations(), body('![diagram](./missing.png)'))],
    ]);
    const index = createWorkspaceIndex(files, defaultConfig());
    const all = validateWorkspace(index, { includeSingleDocument: false });
    assert.equal(byCode(all, 'MDL401').length, 0, 'an image reference is not a document link');
  });

  it('checks reference-style links through their definition', () => {
    const files = new Map<string, string>([
      ['a.md', doc('docs.a', relations(), body('See [the doc][ref].\n\n[ref]: ./nope.md\n'))],
    ]);
    const index = createWorkspaceIndex(files, defaultConfig());
    const all = validateWorkspace(index, { includeSingleDocument: false });
    assert.equal(byCode(all, 'MDL401').length, 1);
  });
});

describe('MDL302 / MDL304 — relations', () => {
  it('MDL302 reports every relation that resolves to nothing', () => {
    const files = new Map<string, string>([
      [
        'a.md',
        doc(
          'docs.a',
          relations(
            { type: 'depends_on', target: 'docs.missing', reason: 'r1' },
            { type: 'refines', target: 'docs.also-missing', reason: 'r2' },
          ),
        ),
      ],
    ]);
    const index = createWorkspaceIndex(files, defaultConfig());
    const all = validateWorkspace(index, { includeSingleDocument: false });
    assert.equal(byCode(all, 'MDL302').length, 2);
  });

  it('MDL304 reports a blank reason on a reasonRequired relation', () => {
    const files = new Map<string, string>([
      ['a.md', doc('docs.a', relations({ type: 'depends_on', target: 'docs.b', reason: '   ' }))],
      ['b.md', doc('docs.b')],
    ]);
    const index = createWorkspaceIndex(files, defaultConfig());
    const all = validateWorkspace(index, { includeSingleDocument: false });
    const d304 = byCode(all, 'MDL304');
    assert.equal(d304.length, 1);
    assert.equal(d304[0]!.path, 'a.md');
    assert.equal(d304[0]!.severity, 'warning');
    // MDL102 is NOT produced: the key is present, so the schema layer is silent
    // and only the semantic emptiness is reported.
    assert.equal(byCode(all, 'MDL102').length, 0);
  });

  it('MDL304 reports an empty-string reason', () => {
    const files = new Map<string, string>([
      ['a.md', doc('docs.a', relations({ type: 'refines', target: 'docs.b', reason: '' }))],
      ['b.md', doc('docs.b')],
    ]);
    const index = createWorkspaceIndex(files, defaultConfig());
    const all = validateWorkspace(index, { includeSingleDocument: false });
    assert.equal(byCode(all, 'MDL304').length, 1);
  });

  it('a blank reason is clean when the type is not reasonRequired', () => {
    const files = new Map<string, string>([
      ['a.md', doc('docs.a', relations({ type: 'example_of', target: 'docs.b', reason: '' }))],
      ['b.md', doc('docs.b')],
    ]);
    const index = createWorkspaceIndex(files, defaultConfig());
    const all = validateWorkspace(index, { includeSingleDocument: false });
    assert.equal(byCode(all, 'MDL304').length, 0);
  });

  it('a missing reason key reports MDL102 and stays out of MDL304', () => {
    const files = new Map<string, string>([
      ['a.md', doc('docs.a', relations({ type: 'depends_on', target: 'docs.b' }))],
      ['b.md', doc('docs.b')],
    ]);
    const index = createWorkspaceIndex(files, defaultConfig());
    // The single-document codes ride along on the workspace report.
    const all = validateWorkspace(index, { includeSingleDocument: true });
    assert.equal(byCode(all, 'MDL102').length, 1, 'the schema layer owns the absent key');
    assert.equal(byCode(all, 'MDL304').length, 0);
  });
});

describe('MDL305 — forbidden cycles', () => {
  it('a two-document cycle reports once, anchored on the smaller path', () => {
    const files = new Map<string, string>([
      ['a.md', doc('docs.a', relations({ type: 'supersedes', target: 'docs.b', reason: 'r' }))],
      ['b.md', doc('docs.b', relations({ type: 'supersedes', target: 'docs.a', reason: 'r' }))],
    ]);
    const index = createWorkspaceIndex(files, defaultConfig());
    const all = validateWorkspace(index, { includeSingleDocument: false });
    const d305 = byCode(all, 'MDL305');
    assert.equal(d305.length, 1, 'one SCC → one diagnostic');
    assert.equal(d305[0]!.path, 'a.md');
    assert.equal(d305[0]!.data?.size, 2);
  });

  it('a three-document cycle reports once with the full membership in data', () => {
    const files = new Map<string, string>([
      ['a.md', doc('docs.a', relations({ type: 'supersedes', target: 'docs.b', reason: 'r' }))],
      ['b.md', doc('docs.b', relations({ type: 'supersedes', target: 'docs.c', reason: 'r' }))],
      ['c.md', doc('docs.c', relations({ type: 'supersedes', target: 'docs.a', reason: 'r' }))],
    ]);
    const index = createWorkspaceIndex(files, defaultConfig());
    const all = validateWorkspace(index, { includeSingleDocument: false });
    const d305 = byCode(all, 'MDL305');
    assert.equal(d305.length, 1);
    assert.deepEqual(d305[0]!.data, { type: 'supersedes', cycle: ['docs.a', 'docs.b', 'docs.c'], size: 3 });
  });

  it('a self-loop is one component of size 1', () => {
    const files = new Map<string, string>([
      ['a.md', doc('docs.a', relations({ type: 'supersedes', target: 'docs.a', reason: 'r' }))],
    ]);
    const index = createWorkspaceIndex(files, defaultConfig());
    const all = validateWorkspace(index, { includeSingleDocument: false });
    const d305 = byCode(all, 'MDL305');
    assert.equal(d305.length, 1);
    assert.equal(d305[0]!.data?.size, 1);
    assert.match(d305[0]!.message, /cycle among 1 document: docs\.a → docs\.a/);
  });

  it('two disjoint cycles produce two diagnostics', () => {
    const files = new Map<string, string>([
      ['a.md', doc('docs.a', relations({ type: 'supersedes', target: 'docs.b', reason: 'r' }))],
      ['b.md', doc('docs.b', relations({ type: 'supersedes', target: 'docs.a', reason: 'r' }))],
      ['c.md', doc('docs.c', relations({ type: 'supersedes', target: 'docs.d', reason: 'r' }))],
      ['d.md', doc('docs.d', relations({ type: 'supersedes', target: 'docs.c', reason: 'r' }))],
    ]);
    const index = createWorkspaceIndex(files, defaultConfig());
    const all = validateWorkspace(index, { includeSingleDocument: false });
    const d305 = byCode(all, 'MDL305');
    assert.equal(d305.length, 2, 'two SCCs → two diagnostics');
    assert.deepEqual(pathsOf(d305), ['a.md', 'c.md']);
  });

  it('a component larger than five truncates the message but not the data', () => {
    const files = new Map<string, string>();
    for (let i = 0; i < 8; i++) {
      files.set(`d${i}.md`, doc(`docs.d${i}`, relations({ type: 'supersedes', target: `docs.d${(i + 1) % 8}`, reason: 'r' })));
    }
    const index = createWorkspaceIndex(files, defaultConfig());
    const all = validateWorkspace(index, { includeSingleDocument: false });
    const d305 = byCode(all, 'MDL305');
    assert.equal(d305.length, 1);
    assert.match(d305[0]!.message, /… \(8 documents\)/, 'the listing truncates at five plus a count');
    assert.equal(d305[0]!.data?.size, 8);
    assert.equal((d305[0]!.data?.cycle as string[]).length, 8, 'data keeps the full membership');
  });

  it('a sparse 20-document graph does not blow up (reviewer OOM scenario)', () => {
    // The review finding: 20 documents at out-degree 2 enumerate an exponential
    // number of simple cycles. Per-SCC reporting makes the count bounded by the
    // number of components, and the traversal must complete.
    const files = new Map<string, string>();
    for (let i = 0; i < 20; i++) {
      const targets = [`docs.d${(i + 1) % 20}`, `docs.d${(i + 4) % 20}`];
      files.set(`d${String(i).padStart(2, '0')}.md`, doc(`docs.d${i}`, relations(...targets.map((t) => ({ type: 'supersedes', target: t, reason: 'r' })))));
    }
    const index = createWorkspaceIndex(files, defaultConfig());
    const all = validateWorkspace(index, { includeSingleDocument: false });
    const d305 = byCode(all, 'MDL305');
    assert.ok(d305.length >= 1, 'the dense graph is one component, so MDL305 fires');
    // The whole graph is strongly connected, so exactly one component reports.
    assert.equal(d305.length, 1, 'one SCC → one diagnostic, not thousands');
    assert.equal(d305[0]!.data?.size, 20);
  });

  it('a K9 complete graph reports exactly once and does not overflow the stack', () => {
    // The review finding: 9 mutually-superseding documents overflowed the call
    // stack under recursive simple-cycle enumeration.
    const files = new Map<string, string>();
    for (let i = 0; i < 9; i++) {
      const targets = [];
      for (let j = 0; j < 9; j++) if (j !== i) targets.push(`docs.d${j}`);
      files.set(`d${i}.md`, doc(`docs.d${i}`, relations(...targets.map((t) => ({ type: 'supersedes', target: t, reason: 'r' })))));
    }
    const index = createWorkspaceIndex(files, defaultConfig());
    const all = validateWorkspace(index, { includeSingleDocument: false });
    const d305 = byCode(all, 'MDL305');
    assert.equal(d305.length, 1, 'the complete graph is one SCC');
    assert.equal(d305[0]!.data?.size, 9);
    assert.match(d305[0]!.message, /… \(9 documents\)/);
  });

  it('a long open chain walks 200 documents without recursion or a report', () => {
    const files = new Map<string, string>();
    for (let i = 0; i < 200; i++) {
      const target = i + 1 < 200 ? `docs.d${i + 1}` : 'docs.end';
      files.set(`d${String(i).padStart(3, '0')}.md`, doc(`docs.d${i}`, relations({ type: 'supersedes', target, reason: 'r' })));
    }
    files.set('end.md', doc('docs.end'));
    const index = createWorkspaceIndex(files, defaultConfig());
    const all = validateWorkspace(index, { includeSingleDocument: false });
    assert.equal(byCode(all, 'MDL305').length, 0, 'an open chain has no component');
  });

  it('cycles of an allowed type produce nothing', () => {
    const config = { ...defaultConfig(), relations: { ...defaultConfig().relations, related_to: { impact: false, cycles: 'allowed' } } };
    const files = new Map<string, string>([
      ['a.md', doc('docs.a', relations({ type: 'related_to', target: 'docs.b' }))],
      ['b.md', doc('docs.b', relations({ type: 'related_to', target: 'docs.a' }))],
    ]);
    const index = createWorkspaceIndex(files, config);
    const all = validateWorkspace(index, { includeSingleDocument: false });
    assert.equal(byCode(all, 'MDL305').length, 0);
  });

  it('a chain that does not close produces no cycle', () => {
    const files = new Map<string, string>([
      ['a.md', doc('docs.a', relations({ type: 'supersedes', target: 'docs.b', reason: 'r' }))],
      ['b.md', doc('docs.b', relations({ type: 'supersedes', target: 'docs.c', reason: 'r' }))],
      ['c.md', doc('docs.c')],
    ]);
    const index = createWorkspaceIndex(files, defaultConfig());
    const all = validateWorkspace(index, { includeSingleDocument: false });
    assert.equal(byCode(all, 'MDL305').length, 0);
  });

  it('a type with no cycle policy at all is never checked', () => {
    const config = { ...defaultConfig(), relations: { depends_on: { impact: true } } };
    const files = new Map<string, string>([
      ['a.md', doc('docs.a', relations({ type: 'depends_on', target: 'docs.b', reason: 'r' }))],
      ['b.md', doc('docs.b', relations({ type: 'depends_on', target: 'docs.a', reason: 'r' }))],
    ]);
    const index = createWorkspaceIndex(files, config);
    const all = validateWorkspace(index, { includeSingleDocument: false });
    assert.equal(byCode(all, 'MDL305').length, 0);
  });
});

describe('incremental index maintenance', () => {
  it('removing a file invalidates its referrers and unresolves their targets', () => {
    const files = new Map<string, string>([
      ['a.md', doc('docs.a', relations({ type: 'depends_on', target: 'docs.b', reason: 'r' }))],
      ['b.md', doc('docs.b')],
    ]);
    const index = createWorkspaceIndex(files, defaultConfig());
    assert.deepEqual([...index.referrersOf('docs.b')], ['a.md']);

    const result = removeFile(index, 'b.md');
    assert.deepEqual([...result.affected].sort(), ['a.md', 'b.md']);
    assert.equal(index.pathToId('b.md'), null);
    assert.deepEqual([...index.idToPaths('docs.b')], []);
    // a.md still names docs.b, so the reverse view is honest about the dangling
    // edge — and that is exactly what makes its MDL302 fire now.
    assert.deepEqual([...index.referrersOf('docs.b')], ['a.md']);
    assert.equal(byCode(validateWorkspace(index, { includeSingleDocument: false }), 'MDL302').length, 1);
  });

  it('updating a file reports the affected set and not the whole repository', () => {
    const files = new Map<string, string>([
      ['a.md', doc('docs.a', relations({ type: 'depends_on', target: 'docs.b', reason: 'r' }))],
      ['b.md', doc('docs.b')],
      ['unrelated.md', doc('docs.untouched')],
    ]);
    const index = createWorkspaceIndex(files, defaultConfig());
    const result = updateFile(index, 'b.md', doc('docs.b-renamed'));
    assert.deepEqual([...result.affected].sort(), ['a.md', 'b.md']);
  });

  it('changing A so that B loses its target invalidates B', () => {
    const files = new Map<string, string>([
      ['a.md', doc('docs.a', relations({ type: 'depends_on', target: 'docs.b', reason: 'r' }))],
      ['b.md', doc('docs.b')],
    ]);
    const index = createWorkspaceIndex(files, defaultConfig());
    assert.equal(byCode(validateWorkspace(index, { includeSingleDocument: false }), 'MDL302').length, 0);

    // b.md keeps its content but drops the id a.md points at.
    const result = updateFile(index, 'b.md', doc('docs.something-else'));
    assert.ok(result.affected.has('a.md'), 'a.md must be re-validated: its target went away');
    const scoped = validateWorkspace(index, { includeSingleDocument: false, paths: [...result.affected] });
    assert.equal(byCode(scoped, 'MDL302').length, 1);
    assert.equal(byCode(scoped, 'MDL302')[0]!.path, 'a.md');
  });

  it('a newly created target resolves the referrer that was unresolved', () => {
    const files = new Map<string, string>([['a.md', doc('docs.a', relations({ type: 'depends_on', target: 'docs.b', reason: 'r' }))]]);
    const index = createWorkspaceIndex(files, defaultConfig());
    assert.equal(byCode(validateWorkspace(index, { includeSingleDocument: false }), 'MDL302').length, 1);

    const result = updateFile(index, 'b.md', doc('docs.b'));
    assert.ok(result.affected.has('a.md'));
    assert.equal(byCode(validateWorkspace(index, { includeSingleDocument: false }), 'MDL302').length, 0);
  });

  it('a cycle disappears after an incremental update', () => {
    const files = new Map<string, string>([
      ['a.md', doc('docs.a', relations({ type: 'supersedes', target: 'docs.b', reason: 'r' }))],
      ['b.md', doc('docs.b', relations({ type: 'supersedes', target: 'docs.a', reason: 'r' }))],
    ]);
    const index = createWorkspaceIndex(files, defaultConfig());
    assert.equal(byCode(validateWorkspace(index, { includeSingleDocument: false }), 'MDL305').length, 1);

    updateFile(index, 'b.md', doc('docs.b', relations({ type: 'supersedes', target: 'docs.c', reason: 'r' })));
    const all = validateWorkspace(index, { includeSingleDocument: false });
    assert.equal(byCode(all, 'MDL305').length, 0, 'the cycle is gone');
    assert.equal(byCode(all, 'MDL302').length, 1, 'the new target is unresolved');
  });

  it('a cycle appears after an incremental update', () => {
    const files = new Map<string, string>([
      ['a.md', doc('docs.a', relations({ type: 'supersedes', target: 'docs.b', reason: 'r' }))],
      ['b.md', doc('docs.b')],
    ]);
    const index = createWorkspaceIndex(files, defaultConfig());
    assert.equal(byCode(validateWorkspace(index, { includeSingleDocument: false }), 'MDL305').length, 0);

    updateFile(index, 'b.md', doc('docs.b', relations({ type: 'supersedes', target: 'docs.a', reason: 'r' })));
    assert.equal(byCode(validateWorkspace(index, { includeSingleDocument: false }), 'MDL305').length, 1);
  });

  it('reverse references follow a renamed id', () => {
    const files = new Map<string, string>([
      ['a.md', doc('docs.a', relations({ type: 'depends_on', target: 'docs.b', reason: 'r' }))],
      ['b.md', doc('docs.b')],
    ]);
    const index = createWorkspaceIndex(files, defaultConfig());
    assert.deepEqual([...index.referrersOf('docs.b')], ['a.md']);

    // b.md keeps its content but claims a different id: a.md's edge now dangles.
    updateFile(index, 'b.md', doc('docs.b2'));
    assert.deepEqual([...index.referrersOf('docs.b')], ['a.md'], 'a.md still names the old id');
    assert.deepEqual([...index.idToPaths('docs.b')], []);
    assert.deepEqual([...index.referrersOf('docs.b2')], []);
    assert.deepEqual([...index.idToPaths('docs.b2')], ['b.md']);
    const all = validateWorkspace(index, { includeSingleDocument: false });
    assert.equal(byCode(all, 'MDL302').length, 1, 'a.md target no longer resolves');
  });

  it('updateFiles applies a rename in one transaction', () => {
    const files = new Map<string, string>([['old.md', doc('docs.a')]]);
    const index = createWorkspaceIndex(files, defaultConfig());
    const result = updateFiles(index, [
      ['old.md', null],
      ['new.md', doc('docs.a')],
    ]);
    assert.deepEqual([...result.affected].sort(), ['new.md', 'old.md']);
    assert.equal(index.size, 1);
    assert.deepEqual([...index.idToPaths('docs.a')], ['new.md']);
  });

  it('accepts a plain object and an array of pairs as the file map', () => {
    const byObject = createWorkspaceIndex({ 'a.md': doc('docs.a') }, defaultConfig());
    const byArray = createWorkspaceIndex([['a.md', doc('docs.a')]] as ReadonlyArray<readonly [string, string]>, defaultConfig());
    assert.equal(byObject.size, 1);
    assert.equal(byArray.pathToId('a.md'), 'docs.a');
  });

  it('incremental and full rebuild agree over three random single-file edits', () => {
    const rng = mulberry32(20260922);
    const files = new Map<string, string>();
    const ids = ['docs.alpha', 'docs.beta', 'docs.gamma', 'docs.delta'];
    for (let i = 0; i < 12; i++) {
      files.set(`f${i}.md`, doc(ids[i % ids.length], relations({ type: 'supersedes', target: ids[(i + 3) % ids.length], reason: 'r' })));
    }
    const index = createWorkspaceIndex(files, defaultConfig());

    const snapshot = () => {
      const all = validateWorkspace(index, { includeSingleDocument: false });
      return all
        .map((d) => `${d.path}:${d.code}:${d.range.start.line}:${d.message}`)
        .sort()
        .join('|');
    };

    for (let round = 0; round < 3; round++) {
      const path = `f${Math.floor(rng() * 12)}.md`;
      const target = ids[Math.floor(rng() * ids.length)];
      const content = doc(ids[round % ids.length], relations({ type: 'supersedes', target, reason: 'r' }));
      updateFile(index, path, content);
      files.set(path, content);

      const incremental = snapshot();
      const rebuilt = validateWorkspace(createWorkspaceIndex(files, defaultConfig()), {
        includeSingleDocument: false,
      })
        .map((d) => `${d.path}:${d.code}:${d.range.start.line}:${d.message}`)
        .sort()
        .join('|');
      assert.equal(incremental, rebuilt, `round ${round}: incremental results must equal a full rebuild`);
    }
  });
});

describe('baseline suppression', () => {
  const baseFiles = () =>
    new Map<string, string>([
      ['a.md', doc('docs.a', relations({ type: 'depends_on', target: 'docs.missing', reason: 'r' }))],
      ['b.md', doc('docs.b')],
    ]);

  it('a covered diagnostic is suppressed', () => {
    const index = createWorkspaceIndex(baseFiles(), defaultConfig());
    const all = validateWorkspace(index, { includeSingleDocument: false });
    const d302 = byCode(all, 'MDL302');
    assert.equal(d302.length, 1);

    const baseline: Baseline = { version: 1, codes: { MDL302: ['a.md'] } };
    const suppressed = validateWorkspace(index, { includeSingleDocument: false, baseline });
    assert.equal(byCode(suppressed, 'MDL302').length, 0, 'a baseline entry suppresses the diagnostic');
    assert.equal(suppressed.length, 0, 'a fully covered report is clean for CI');
  });

  it('a new file not in the baseline is still reported', () => {
    const index = createWorkspaceIndex(baseFiles(), defaultConfig());
    const baseline: Baseline = { version: 1, codes: { MDL302: ['a.md'] } };
    updateFile(index, 'c.md', doc('docs.c', relations({ type: 'depends_on', target: 'docs.also-missing', reason: 'r' })));
    const suppressed = validateWorkspace(index, { includeSingleDocument: false, baseline });
    const d302 = byCode(suppressed, 'MDL302');
    assert.equal(d302.length, 1);
    assert.equal(d302[0]!.path, 'c.md', 'the unlisted path is reported');
  });

  it('a fixed violation drops out of a regenerated baseline', () => {
    const index = createWorkspaceIndex(baseFiles(), defaultConfig());
    const all = validateWorkspace(index, { includeSingleDocument: false });
    const previous = JSON.parse(writeBaseline(all)) as Baseline;
    assert.deepEqual(previous.codes.MDL302, ['a.md']);

    // Fix the file: the entry goes stale and prunes away.
    updateFile(index, 'a.md', doc('docs.a', relations({ type: 'depends_on', target: 'docs.b', reason: 'r' })));
    const fixed = validateWorkspace(index, { includeSingleDocument: false });
    assert.equal(byCode(fixed, 'MDL302').length, 0);
    const pruned = pruneBaseline(previous, fixed);
    assert.equal(pruned.codes.MDL302, undefined, 'a stale entry is removed');
    assert.equal(baselineMatches(pruned, 'MDL302', 'a.md'), false);
  });

  it('writeBaseline keeps accepted-but-clean entries and adds new ones', () => {
    const index = createWorkspaceIndex(baseFiles(), defaultConfig());
    const all = validateWorkspace(index, { includeSingleDocument: false });
    const previous: Baseline = { version: 1, codes: { MDL301: ['legacy.md'] } };

    const text = writeBaseline(all, previous);
    assert.ok(text.endsWith('\n'), 'the file is newline-terminated');
    const next = JSON.parse(text) as Baseline;
    assert.equal(next.version, 1);
    assert.deepEqual(next.codes.MDL301, ['legacy.md'], 'accepted debt carries over');
    assert.deepEqual(next.codes.MDL302, ['a.md'], 'current violations are recorded');
  });

  it('parseBaseline round-trips and rejects broken input', () => {
    const index = createWorkspaceIndex(baseFiles(), defaultConfig());
    const all = validateWorkspace(index, { includeSingleDocument: false });
    const text = writeBaseline(all);
    const parsed = parseBaseline(text);
    assert.equal(parsed.error, null);
    assert.deepEqual(parsed.baseline!.codes.MDL302, ['a.md']);

    assert.ok(parseBaseline('{ not json').error !== null, 'bad JSON yields an error, not a throw');
    assert.ok(parseBaseline('{"version": 99}').error !== null, 'an unknown version is rejected');
    assert.ok(parseBaseline('{"version": 1}').error !== null, 'a missing codes object is rejected');
    assert.ok(parseBaseline('{"version": 1, "codes": {"MDL302": "a.md"}}').error !== null, 'a non-array entry is rejected');
    // A broken baseline suppresses nothing: the caller falls back to full reporting.
    const broken = parseBaseline('{');
    assert.equal(broken.baseline, null);
    assert.equal(
      byCode(validateWorkspace(index, { includeSingleDocument: false, baseline: broken.baseline ?? undefined }), 'MDL302').length,
      1,
    );
  });
});

describe('never throws — adversarial inputs', () => {
  const cases: ReadonlyArray<readonly [string, unknown]> = [
    ['null content', null],
    ['undefined content', undefined],
    ['a number as content', 42],
    ['an object as content', { toString: () => 'nope' }],
    ['binary bytes', new Uint8Array([0x00, 0xff, 0xfe, 0x7f])],
    ['a lone BOM', '\uFEFF'],
    ['an unterminated fence', '---\nmdlineage:\n  id: a\n'],
    ['deeply nested relations', '---\nmdlineage:\n  schema: 1\n  id: a\n  kind: p\n  status: d\n  relations:\n' + '    - type: related_to\n      target: ' + 'a.'.repeat(200) + '\n'],
    ['a giant id', '---\nmdlineage:\n  schema: 1\n  id: ' + 'a'.repeat(100000) + '\n  kind: p\n  status: d\n---\n'],
    ['cyclic object content', (() => {
      const c: Record<string, unknown> = { a: '---\n' };
      c.self = c;
      return c;
    })()],
  ];

  for (const [name, content] of cases) {
    it(`fuzz: ${name} produces a result, not an exception`, () => {
      const text = typeof content === 'string' ? content : String(content ?? '');
      let index: WorkspaceIndex;
      try {
        index = createWorkspaceIndex({ 'fuzz.md': text }, defaultConfig());
      } catch (error) {
        // A non-string content the caller handed in is a usage error; assert it
        // is reported rather than silently accepted.
        assert.ok(error instanceof Error, `${name}: expected an Error, got ${String(error)}`);
        return;
      }
      const all = validateWorkspace(index, { includeSingleDocument: true });
      assert.ok(Array.isArray(all), `${name}: expected a diagnostic array`);
      for (const d of all) {
        assert.ok(d.code.startsWith('MDL'), `${name}: unexpected code ${d.code}`);
        assert.ok(d.range.start.line >= 1 && d.range.start.column >= 1, `${name}: out-of-range position`);
      }
      // An incremental pass over the same document must be as stable as the
      // initial one.
      updateFile(index, 'fuzz.md', text);
      assert.deepEqual(
        validateWorkspace(index, { includeSingleDocument: true }).map((d) => `${d.code}`),
        all.map((d) => `${d.code}`),
      );
    });
  }

  it('deeply nested relations produce a bounded, non-recursive traversal', () => {
    const depth = 400;
    const lines = ['---', 'mdlineage:', '  schema: 1', '  id: docs.deep', '  kind: policy', '  status: active', '  relations:'];
    for (let i = 0; i < depth; i++) {
      lines.push(`    - type: related_to`, `      target: docs.deep-${i}`);
    }
    lines.push('---', '', '# Deep', '', '[deep](./missing.md)');
    const index = createWorkspaceIndex({ 'deep.md': lines.join('\n') }, defaultConfig());
    const all = validateWorkspace(index, { includeSingleDocument: true });
    assert.equal(byCode(all, 'MDL302').length, depth);
    assert.equal(byCode(all, 'MDL401').length, 1);
  });

  it('an index built from a Map is not retained by the index', () => {
    const files = new Map<string, string>([['a.md', doc('docs.a')]]);
    const index = createWorkspaceIndex(files, defaultConfig());
    files.delete('a.md');
    assert.equal(index.size, 1, 'the input map is consumed, not stored');
    assert.equal(index.pathToId('a.md'), 'docs.a');
  });
});

describe('query API', () => {
  it('idToPaths is sorted and empty for unknown ids', () => {
    const index = createWorkspaceIndex(
      { 'b.md': doc('docs.shared'), 'a.md': doc('docs.shared'), 'c.md': doc('docs.c') },
      defaultConfig(),
    );
    assert.deepEqual([...index.idToPaths('docs.shared')], ['a.md', 'b.md']);
    assert.deepEqual([...index.idToPaths('docs.unknown')], []);
  });

  it('anchorsOf and relationsOf are empty for unknown paths', () => {
    const index = createWorkspaceIndex({ 'a.md': doc('docs.a') }, defaultConfig());
    assert.equal(index.anchorsOf('nope.md').size, 0);
    assert.equal(index.relationsOf('nope.md').length, 0);
    assert.equal(index.entryOf('nope.md'), null);
    assert.equal(index.pathToId('nope.md'), null);
  });

  it('exposes the config it was built with', () => {
    const config = defaultConfig();
    const index = createWorkspaceIndex({ 'a.md': doc('docs.a') }, config);
    assert.equal(index.config.metadata.key, config.metadata.key);
  });
});

describe('performance — 1000 synthetic documents', () => {
  const N = 1000;

  function syntheticCorpus(): Map<string, string> {
    const files = new Map<string, string>();
    for (let i = 0; i < N; i++) {
      const id = `docs.doc-${String(i).padStart(4, '0')}`;
      // Every document supersedes the next one, so the corpus carries one long
      // chain the cycle detector must walk end to end. The chain is OPEN — no
      // edge back to the start — so updating one document affects only its
      // immediate neighbours, which is what the affected-set budget measures.
      const target = i + 1 < N ? `docs.doc-${String(i + 1).padStart(4, '0')}` : 'docs.terminal';
      const linkTarget = i + 1 < N ? `doc-${String(i + 1).padStart(4, '0')}.md` : './terminal.md';
      const body = `# Doc ${i}\n\nSee [the next one](${linkTarget}) and [the docs](https://example.com).\n`;
      files.set(`doc-${String(i).padStart(4, '0')}.md`, doc(id, relations({ type: 'supersedes', target, reason: 'Chain link.' }), body));
    }
    files.set('terminal.md', doc('docs.terminal'));
    return files;
  }

  it('builds the index and a single-file update stays an order of magnitude cheaper', () => {
    const files = syntheticCorpus();
    const started = process.hrtime.bigint();
    const index = createWorkspaceIndex(files, defaultConfig());
    const buildMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.equal(index.size, N + 1, 'the corpus plus its terminal document');

    // A validation over the built index: the open chain is clean, which is the
    // property the cycle detector must scale to (it still walks 1000 edges).
    const validated = validateWorkspace(index, { includeSingleDocument: false });
    assert.equal(validated.length, 0, 'an open chain must produce no diagnostics');

    const updateStart = process.hrtime.bigint();
    const result = updateFile(index, 'doc-0500.md', doc('docs.doc-0500-renamed', relations({ type: 'related_to', target: 'docs.doc-0000', reason: 'r' })));
    const updateMs = Number(process.hrtime.bigint() - updateStart) / 1e6;
    assert.ok(result.affected.size < 20, `an update must touch few files, got ${result.affected.size}`);

    // The rename invalidated doc-0499's edge into the old id.
    const scoped = validateWorkspace(index, { includeSingleDocument: false, paths: [...result.affected] });
    assert.equal(byCode(scoped, 'MDL302').length, 1, 'the renamed document left a dangling target behind');

    // Order-of-magnitude budget: an update re-parses ONE document and repairs
    // its reverse maps, so it must not approach the cost of building all of N.
    assert.ok(updateMs < buildMs / 10, `update ${updateMs.toFixed(2)}ms is not < build/10 (${(buildMs / 10).toFixed(2)}ms)`);

    // eslint-disable-next-line no-console
    console.log(`  ${N} documents: build ${buildMs.toFixed(1)}ms, single-file update ${updateMs.toFixed(2)}ms (affected ${result.affected.size})`);
  });

  it('a scoped incremental pass costs proportionally to the affected set', () => {
    const files = syntheticCorpus();
    const index = createWorkspaceIndex(files, defaultConfig());
    const result = updateFile(index, 'doc-0000.md', doc('docs.doc-0000-renamed', relations({ type: 'related_to', target: 'docs.doc-0001', reason: 'r' })));

    // The scoped pass skips the documents the change cannot have touched, so it
    // re-validates the affected set and runs the graph rule once, while the full
    // pass re-walks every document. The budget is a multiple, not an equality:
    // both are dominated by the MDL305 graph pass, which always runs whole.
    const scopedStart = process.hrtime.bigint();
    validateWorkspace(index, { includeSingleDocument: false, paths: [...result.affected] });
    const scopedMs = Number(process.hrtime.bigint() - scopedStart) / 1e6;

    const fullStart = process.hrtime.bigint();
    validateWorkspace(index, { includeSingleDocument: false });
    const fullMs = Number(process.hrtime.bigint() - fullStart) / 1e6;

    assert.ok(scopedMs < fullMs * 2, `scoped ${scopedMs}ms vs full ${fullMs}ms — both are graph-pass bound`);
    assert.ok(result.affected.size < 20, `the affected set stays small, got ${result.affected.size}`);
    // eslint-disable-next-line no-console
    console.log(`  scoped pass over ${result.affected.size} files: ${scopedMs.toFixed(2)}ms vs full ${fullMs.toFixed(2)}ms`);
  });
});

describe('report ordering', () => {
  it('orders by path first, then offset, then code', () => {
    // Two diagnostics on the same path sort by offset; two on the same offset
    // by code. The key is (path, offset, code), which is what makes a
    // consumer's output byte-identical between runs and machines.
    const files = new Map<string, string>([
      [
        'a.md',
        doc(
          'docs.a',
          relations(
            { type: 'depends_on', target: 'docs.missing-a', reason: 'r' },
            { type: 'refines', target: 'docs.missing-b', reason: 'r' },
          ),
        ),
      ],
      ['b.md', doc('docs.b', relations({ type: 'depends_on', target: 'docs.missing-c', reason: 'r' }))],
      ['z.md', doc('docs.z', relations({ type: 'depends_on', target: 'docs.missing-d', reason: 'r' }))],
    ]);
    const index = createWorkspaceIndex(files, defaultConfig());
    const all = validateWorkspace(index, { includeSingleDocument: false });
    assert.equal(all.length, 4);
    assert.deepEqual(
      all.map((d) => `${d.path}:${d.range.start.offset}`),
      all
        .slice()
        .sort(byReportOrder)
        .map((d) => `${d.path}:${d.range.start.offset}`),
      'the report is already in its own sort key',
    );
    // The key is path-dominant: b.md's diagnostics all precede z.md's no matter
    // their offsets.
    assert.deepEqual(
      [...new Set(all.map((d) => d.path))],
      ['a.md', 'b.md', 'z.md'],
      'path dominates the order',
    );
  });

  it('the sort key is total: two diagnostics at the same offset split by code', () => {
    // MDL304 (empty reason) and MDL302 land together when a relation both has a
    // blank reason and an unresolvable target; the code breaks the tie.
    const files = new Map<string, string>([
      ['a.md', doc('docs.a', relations({ type: 'depends_on', target: 'docs.missing', reason: '  ' }))],
    ]);
    const index = createWorkspaceIndex(files, defaultConfig());
    const all = validateWorkspace(index, { includeSingleDocument: false });
    const pair = all.filter((d) => d.code === 'MDL302' || d.code === 'MDL304');
    assert.equal(pair.length, 2, 'one diagnostic per problem');
    assert.equal(pair[0]!.code, 'MDL302', 'code is the final tie-breaker');
    assert.equal(pair[1]!.code, 'MDL304');
  });

  it('re-validating the same index yields an identical report (determinism)', () => {
    const files = new Map<string, string>([
      ['b.md', doc('docs.b', relations({ type: 'supersedes', target: 'docs.a', reason: 'r' }))],
      ['a.md', doc('docs.a', relations({ type: 'supersedes', target: 'docs.b', reason: 'r' }))],
      ['c.md', doc('docs.c', relations({ type: 'depends_on', target: 'docs.missing', reason: 'r' }))],
    ]);
    const index = createWorkspaceIndex(files, defaultConfig());
    const first = validateWorkspace(index, { includeSingleDocument: false });
    const second = validateWorkspace(index, { includeSingleDocument: false });
    assert.deepEqual(
      first.map((d) => `${d.path}|${d.code}|${d.range.start.line}|${d.message}`),
      second.map((d) => `${d.path}|${d.code}|${d.range.start.line}|${d.message}`),
      'the same index must serialize identically twice',
    );
  });
});

describe('incremental vs full rebuild equivalence (fuzz)', () => {
  // The review's incremental-consistency property, run harder: random edits
  // over a corpus that contains cycles, dangling targets, duplicates and
  // self-references, so every workspace rule fires at least once.
  const ids = ['docs.alpha', 'docs.beta', 'docs.gamma', 'docs.delta', 'docs.alpha'];

  function corpus(seed: number): Map<string, string> {
    const rng = mulberry32(seed);
    const files = new Map<string, string>();
    for (let i = 0; i < 10; i++) {
      const type = ['supersedes', 'depends_on', 'example_of'][Math.floor(rng() * 3)]!;
      files.set(`f${i}.md`, doc(ids[i % ids.length], relations({ type, target: ids[Math.floor(rng() * 4)]!, reason: 'r' })));
    }
    return files;
  }

  const signature = (index: WorkspaceIndex) =>
    validateWorkspace(index, { includeSingleDocument: false })
      .map((d) => `${d.path}:${d.code}:${d.range.start.line}:${d.message}`)
      .sort()
      .join('|');

  it('three random single-file edits keep the incremental report equal to a rebuild', () => {
    const files = corpus(20260922);
    const index = createWorkspaceIndex(files, defaultConfig());
    const rng = mulberry32(987654321);
    for (let round = 0; round < 3; round++) {
      const path = `f${Math.floor(rng() * 10)}.md`;
      const content = doc(ids[round % ids.length], relations({
        type: ['supersedes', 'depends_on', 'example_of'][round % 3]!,
        target: ids[Math.floor(rng() * 4)]!,
        reason: 'r',
      }));
      updateFile(index, path, content);
      files.set(path, content);
      assert.equal(
        signature(index),
        validateWorkspace(createWorkspaceIndex(files, defaultConfig()), { includeSingleDocument: false })
          .map((d) => `${d.path}:${d.code}:${d.range.start.line}:${d.message}`)
          .sort()
          .join('|'),
        `round ${round}: incremental results must equal a full rebuild`,
      );
    }
  });

  it('ten multi-file transactions (set/delete) stay consistent with a rebuild', () => {
    const files = corpus(4242);
    const index = createWorkspaceIndex(files, defaultConfig());
    const rng = mulberry32(1337);
    for (let round = 0; round < 10; round++) {
      const changes: Array<[string, string | null]> = [];
      for (let k = 0; k < 3; k++) {
        const path = `f${Math.floor(rng() * 10)}.md`;
        if (rng() < 0.3) {
          changes.push([path, null]);
          files.delete(path);
        } else {
          const content = doc(ids[Math.floor(rng() * 4)]!, relations({
            type: ['supersedes', 'depends_on'][Math.floor(rng() * 2)]!,
            target: ids[Math.floor(rng() * 4)]!,
            reason: 'r',
          }));
          changes.push([path, content]);
          files.set(path, content);
        }
      }
      updateFiles(index, changes);
      assert.equal(signature(index), signature(createWorkspaceIndex(files, defaultConfig())), `round ${round}`);
    }
  });
});

describe('MDL103 self-reference (selfReference: forbidden)', () => {
  it('a depends_on self-reference reports once at the declaration', () => {
    const files = new Map<string, string>([
      ['a.md', doc('docs.a', relations({ type: 'depends_on', target: 'docs.a', reason: 'r' }))],
    ]);
    const index = createWorkspaceIndex(files, defaultConfig());
    const all = validateWorkspace(index, { includeSingleDocument: false });
    const d = byCode(all, 'MDL103');
    assert.equal(d.length, 1, 'exactly one self-reference diagnostic');
    assert.equal(d[0]!.path, 'a.md');
    assert.equal(d[0]!.message, "self-reference is forbidden for relation type 'depends_on'");
    assert.equal(d[0]!.severity, 'error');
    // It sits on the relation, not on line 1.
    assert.ok(d[0]!.range.start.line > 1, 'the range points inside the front matter');
    assert.deepEqual(d[0]!.data, { type: 'depends_on', target: 'docs.a', index: 0, selfReference: true });
  });

  it('a self-reference on a type without a selfReference switch is clean', () => {
    // example_of has no selfReference key in the default config, so a
    // self-targeting example_of is allowed: the schema permits the target and
    // nothing in the config forbids the loop back to its own document.
    const files = new Map<string, string>([
      ['a.md', doc('docs.a', relations({ type: 'example_of', target: 'docs.a' }))],
    ]);
    const index = createWorkspaceIndex(files, defaultConfig());
    const all = validateWorkspace(index, { includeSingleDocument: false });
    assert.equal(byCode(all, 'MDL103').length, 0);
  });

  it('selfReference: allowed suppresses the diagnostic', () => {
    const config = {
      ...defaultConfig(),
      relations: { ...defaultConfig().relations, depends_on: { impact: true, reasonRequired: true, selfReference: 'allowed' } },
    };
    const files = new Map<string, string>([
      ['a.md', doc('docs.a', relations({ type: 'depends_on', target: 'docs.a', reason: 'r' }))],
    ]);
    const index = createWorkspaceIndex(files, config);
    const all = validateWorkspace(index, { includeSingleDocument: false });
    assert.equal(byCode(all, 'MDL103').length, 0, 'an explicitly allowed self-reference stays silent');
  });

  it('a shared id makes a self-reference ambiguous, and MDL301 owns it', () => {
    // Two documents claim the same id (MDL301 owns that collision). b.md points
    // at the shared id, which resolves to a.md AND to b.md — so the target DOES
    // resolve to b.md and the self-reference rule fires there too. The rule
    // asks "does this resolve to my own document?", not "is the target my own
    // exclusive id?", because the index's id→paths map is the only resolution
    // it has; MDL301 explains why the resolution is ambiguous.
    const files = new Map<string, string>([
      ['a.md', doc('docs.shared', relations({ type: 'depends_on', target: 'docs.b', reason: 'r' }))],
      ['b.md', doc('docs.shared', relations({ type: 'depends_on', target: 'docs.shared', reason: 'r' }))],
    ]);
    const index = createWorkspaceIndex(files, defaultConfig());
    const all = validateWorkspace(index, { includeSingleDocument: false });
    assert.equal(byCode(all, 'MDL301').length, 1, 'the duplicate id is reported first');
    const d103 = byCode(all, 'MDL103');
    assert.equal(d103.length, 1, 'b.md is one of the id claimants, so the edge is a self-reference');
    assert.equal(d103[0]!.path, 'b.md');
  });

  it('a target resolving to a DIFFERENT document only is not a self-reference', () => {
    const files = new Map<string, string>([
      ['a.md', doc('docs.a', relations({ type: 'depends_on', target: 'docs.b', reason: 'r' }))],
      ['b.md', doc('docs.b', relations({ type: 'depends_on', target: 'docs.a', reason: 'r' }))],
    ]);
    const index = createWorkspaceIndex(files, defaultConfig());
    const all = validateWorkspace(index, { includeSingleDocument: false });
    assert.equal(byCode(all, 'MDL103').length, 0, 'each target resolves to the other document');
  });

  it('a dangling self-target reports MDL302, not a self-reference', () => {
    const files = new Map<string, string>([
      ['a.md', doc('docs.a', relations({ type: 'depends_on', target: 'docs.nope', reason: 'r' }))],
    ]);
    const index = createWorkspaceIndex(files, defaultConfig());
    const all = validateWorkspace(index, { includeSingleDocument: false });
    assert.equal(byCode(all, 'MDL103').length, 0);
    assert.equal(byCode(all, 'MDL302').length, 1, 'an unresolvable target is MDL302');
  });

  it('the default config forbids self-reference only for depends_on', () => {
    const relations = defaultConfig().relations;
    const forbidden = Object.entries(relations).filter(([, sw]) => sw?.selfReference === 'forbidden').map(([type]) => type);
    assert.deepEqual(forbidden, ['depends_on'], 'the schema example and the default config agree');
    // The vocabulary's other strong types leave the switch unset.
    for (const type of ['implements', 'refines', 'supersedes', 'contradicts', 'example_of', 'related_to']) {
      assert.ok(relations[type]?.selfReference === undefined, `${type} has no selfReference switch`);
    }
  });
});

/** Deterministic PRNG so the incremental-consistency run is reproducible. */
function mulberry32(seed: number): () => number {
  let state = seed;
  return function (): number {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
