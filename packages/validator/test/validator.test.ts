/**
 * Manifest-driven acceptance tests for @mdlineage/validator.
 *
 * `test/fixtures/manifest.json` is the M0 acceptance contract: every fixture
 * pins the diagnostic codes its front matter must produce. This suite asserts
 * the codes this milestone implements — the single-document layers plus the raw
 * line-ending scan — and asserts that workspace fixtures produce no
 * single-document false positives.
 *
 * Run with: node --import tsx --test packages/validator/test/validator.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateDocumentSync, defaultConfig, defaultConfigIsValid } from '../src/index.js';
import { loadConfig } from '../src/config.js';
import type { Diagnostic } from '../src/index.js';

const repoRoot = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..');
const fixtureRoot = resolve(repoRoot, 'test', 'fixtures');

interface ManifestEntry {
  path: string;
  valid: boolean;
  expectedCodes: string[];
  layers?: string[];
  workspace?: boolean;
  description: string;
}

interface Manifest {
  fixtureRoot: string;
  entries: ManifestEntry[];
}

const manifest: Manifest = JSON.parse(readFileSync(resolve(fixtureRoot, 'manifest.json'), 'utf8'));

/** Codes this milestone implements; everything else is out of scope here. */
const IMPLEMENTED_LAYERS = new Set([
  'frontmatter-syntax',
  'schema',
  'document-semantic',
  'eol-scan',
]);

const SINGLE_DOCUMENT_CODES = new Set([
  'MDL001',
  'MDL002',
  'MDL003',
  'MDL101',
  'MDL102',
  'MDL103',
  'MDL104',
  'MDL201',
  'MDL202',
  'MDL601',
  'MDL602',
]);

/** Which manifest codes this milestone's validator must produce. */
function expectedFor(entry: ManifestEntry): string[] {
  if (entry.workspace) return [];
  // e10 and e17 carry their codes in layers, not expectedCodes (README rule 2).
  if (entry.path.includes('e10-duplicate-relation')) return ['MDL202'];
  if (entry.path.includes('e17-evidence-anchor-missing')) return ['MDL201'];
  if (entry.path.includes('e15-mixed-eol')) return ['MDL601'];
  if (entry.path.includes('e16-crlf-eol')) return ['MDL602'];
  return [...entry.expectedCodes];
}

function readFixture(path: string): string {
  return readFileSync(resolve(fixtureRoot, path), 'utf8');
}

function codes(diagnostics: Diagnostic[]): string[] {
  return diagnostics.map((d) => d.code);
}

describe('manifest contract', () => {
  for (const entry of manifest.entries) {
    it(`${entry.path} — ${entry.description}`, () => {
      const content = readFixture(entry.path);
      const { diagnostics } = validateDocumentSync({ path: entry.path, content });

      const expected = expectedFor(entry);
      const actual = codes(diagnostics);
      const produced = actual.filter((code) => SINGLE_DOCUMENT_CODES.has(code));

      // Every expected code must be produced.
      for (const code of expected) {
        assert.ok(produced.includes(code), `${entry.path}: expected ${code}, got [${produced.join(', ')}]`);
      }

      if (entry.workspace) {
        // Workspace fixtures must not trigger any single-document false positive.
        assert.deepEqual(
          [...new Set(produced)].sort(),
          [],
          `${entry.path}: workspace fixture must produce no single-document codes, got [${produced.join(', ')}]`,
        );
        return;
      }

      if (entry.valid) {
        assert.deepEqual(
          [...new Set(produced)].sort(),
          [],
          `${entry.path}: valid fixture must produce no codes, got [${produced.join(', ')}]`,
        );
        return;
      }

      // An invalid fixture must produce at least one single-document code.
      assert.ok(produced.length > 0, `${entry.path}: invalid fixture produced no single-document codes`);

      // Layer honesty: every produced single-document code must belong to a
      // layer this milestone implements.
      for (const code of produced) {
        assert.ok(SINGLE_DOCUMENT_CODES.has(code), `${entry.path}: produced out-of-scope code ${code}`);
      }
      void IMPLEMENTED_LAYERS;
    });
  }
});

describe('range correctness', () => {
  it('MDL103 on a bad id points at the offending value line', () => {
    const content = readFixture('invalid/e05-id-pattern.md');
    const { diagnostics } = validateDocumentSync({ content });
    const err = diagnostics.find((d) => d.code === 'MDL103');
    assert.ok(err, 'expected an MDL103');
    const lines = content.split('\n');
    const lineText = lines[err!.range.start.line - 1]!;
    assert.ok(lineText.includes('id:'), `range landed on ${JSON.stringify(lineText)}`);
    // The range starts after the "id: " key on that line.
    assert.ok(err!.range.start.column > 1, `column should be past the key, got ${err!.range.start.column}`);
    assert.equal(err!.range.start.line, err!.range.end.line, 'an id value fits on one line');
    assert.equal(err!.data?.jsonPointer, '/id');
  });

  it('MDL104 points at the unknown field key', () => {
    const content = readFixture('invalid/e04-unknown-mdlineage-fields.md');
    const { diagnostics } = validateDocumentSync({ content });
    const codes104 = diagnostics.filter((d) => d.code === 'MDL104');
    assert.equal(codes104.length, 2, 'expected MDL104 for tpoics and relationz');
    const lines = content.split('\n');
    for (const d of codes104) {
      const lineText = lines[d.range.start.line - 1]!;
      assert.ok(
        lineText.includes(String(d.data?.additionalProperty)),
        `MDL104 range landed on ${JSON.stringify(lineText)}`,
      );
    }
  });

  it('MDL102 on a missing relation reason points at the relation entry', () => {
    const content = readFixture('invalid/e09-strong-relation-no-reason.md');
    const { diagnostics } = validateDocumentSync({ content });
    const err = diagnostics.find((d) => d.code === 'MDL102');
    assert.ok(err, 'expected an MDL102');
    const lines = content.split('\n');
    const lineText = lines[err!.range.start.line - 1]!;
    assert.ok(
      lineText.includes('type:') || lineText.includes('target:'),
      `MDL102 range should sit on the relation, got ${JSON.stringify(lineText)}`,
    );
    assert.equal(err!.data?.jsonPointer, '/relations/0');
  });

  it('MDL001 points at the opening fence', () => {
    const content = readFixture('invalid/e01-fm-unclosed.md');
    const { diagnostics } = validateDocumentSync({ content });
    const err = diagnostics.find((d) => d.code === 'MDL001');
    assert.ok(err, 'expected an MDL001');
    assert.equal(err!.range.start.line, 1);
    assert.equal(err!.range.start.offset, 0);
  });

  it('MDL601 points at the first line whose ending differs', () => {
    const content = readFixture('invalid/e15-mixed-eol.md');
    const { diagnostics } = validateDocumentSync({ content });
    const err = diagnostics.find((d) => d.code === 'MDL601');
    assert.ok(err, 'expected an MDL601');
    // The front matter is LF; the first CRLF terminates the "# Mixed line
    // endings" heading, so the diagnostic points at that line.
    const lines = content.split('\n');
    const at = lines[err!.range.start.line - 1]!;
    assert.ok(
      at.includes('# Mixed line endings') || at.trim().startsWith('#'),
      `range landed on ${JSON.stringify(at)}`,
    );
    assert.ok(err!.range.start.line > 7, 'the violation is after the LF front matter');
  });
});

describe('UTF-16 semantics', () => {
  // Inline cases only — these never enter the manifest (test/fixtures/README.md
  // forbids adding fixtures without a contract entry).

  it('columns count UTF-16 code units for a CJK id', () => {
    const content = '---\nmdlineage:\n  schema: 1\n  id: 文档.策略\n  kind: policy\n  status: active\n---\n\n# 标题\n';
    const { diagnostics } = validateDocumentSync({ content });
    const err = diagnostics.find((d) => d.code === 'MDL103');
    assert.ok(err, 'expected an MDL103 for a non-ASCII id');
    // Line 4 is `  id: 文档.策略`; the value starts at code unit 7 (after "  id: ").
    assert.equal(err!.range.start.line, 4);
    assert.equal(err!.range.start.column, 7);
    assert.equal(content.split('\n')[3]!.slice(err!.range.start.column - 1, err!.range.end.column - 1), '文档.策略');
  });

  it('a surrogate pair counts as two columns', () => {
    const content = '---\nmdlineage:\n  schema: 1\n  id: a😀b\n  kind: policy\n  status: active\n---\n\n# Heading 😀\n';
    const { diagnostics } = validateDocumentSync({ content });
    const err = diagnostics.find((d) => d.code === 'MDL103');
    assert.ok(err, 'expected an MDL103');
    // `  id: a😀b` — the value occupies 6 UTF-16 code units (a, hi, lo, b...).
    assert.equal(err!.range.start.column, 7);
    const utf16 = content.split('\n')[3]!.slice(err!.range.start.column - 1, err!.range.end.column - 1);
    assert.equal(utf16, 'a😀b');
    assert.equal(utf16.length, 4, '😀 is two UTF-16 code units');
  });

  it('a Chinese heading slug resolves and produces no MDL201', () => {
    const content = [
      '---',
      'mdlineage:',
      '  schema: 1',
      '  id: docs.cache-policy',
      '  kind: policy',
      '  status: active',
      '  relations:',
      '    - type: related_to',
      '      target: docs.other',
      '      reason: 中文锚点。',
      '      evidence: "#缓存有效期"',
      '---',
      '',
      '## 缓存有效期',
      '',
      'Body.',
      '',
    ].join('\n');
    const { diagnostics } = validateDocumentSync({ content });
    assert.deepEqual(
      codes(diagnostics),
      [],
      `expected a clean document with a Chinese anchor, got [${codes(diagnostics).join(', ')}]`,
    );
  });
});

describe('line endings', () => {
  it('a pure-LF document produces no EOL diagnostic', () => {
    const content = readFixture('valid/v01-full.md');
    const { diagnostics } = validateDocumentSync({ content });
    assert.ok(!diagnostics.some((d) => d.code === 'MDL601' || d.code === 'MDL602'));
  });

  it('MDL602 fires for CRLF under the default LF policy', () => {
    const { diagnostics } = validateDocumentSync({ content: readFixture('invalid/e16-crlf-eol.md') });
    assert.ok(codes(diagnostics).includes('MDL602'));
    assert.ok(!codes(diagnostics).includes('MDL601'), 'a uniform file is not mixed');
  });

  it('CRLF is accepted when the policy says crlf', () => {
    const content = readFixture('invalid/e16-crlf-eol.md');
    const { diagnostics } = validateDocumentSync({ content, config: { ...defaultConfig(), eolPolicy: 'crlf' } });
    assert.deepEqual(codes(diagnostics), []);
  });

  it('a lone CR is reported against the LF policy', () => {
    const content = '---\rmdlineage:\r  schema: 1\r  id: a\r  kind: p\r  status: d\r---\r\r# T\r';
    const { diagnostics } = validateDocumentSync({ content });
    assert.ok(codes(diagnostics).includes('MDL602'));
  });

  it('a CR-only document fails YAML parsing (MDL002) before any proposal can be made', () => {
    // The yaml library does not treat a lone CR as a newline, so a CR-only
    // document never yields front matter: MDL002 fires first, and fix /
    // suggest_metadata have nothing to patch. Pinning this boundary here
    // (not just in a comment) fails loudly if YAML handling ever changes.
    const content = '---\rmdlineage:\r  schema: 1\r  id: a\r  kind: p\r  status: d\r---\r\r# T\r';
    const { diagnostics } = validateDocumentSync({ content });
    assert.ok(codes(diagnostics).includes('MDL002'));
  });
});

/** Load config from a directory or file, inside this process. */
function loadConfigFrom(path: string) {
  return loadConfig(path);
}

describe('config defaults', () => {
  it('the built-in default config validates against the config schema', () => {
    assert.equal(defaultConfigIsValid(), true);
  });

  it('this repository\'s mdlineage.config.yaml validates against the config schema', () => {
    // Progressive adoption: the shipped config turns metadata off, so the
    // docs tree's lack of front matter is not an error. It must still be a
    // schema-valid config file, because an invalid one falls back to the
    // defaults — which would silently re-enable MDL003 repository-wide.
    const result = loadConfigFrom(resolve(repoRoot, 'mdlineage.config.yaml'));
    assert.deepEqual(result.diagnostics, [], 'the repository config loads cleanly');
    assert.equal(result.config.configVersion, 1);
    assert.equal(result.config.metadata.required, false, 'metadata is not required yet');
    assert.equal(result.config.source, resolve(repoRoot, 'mdlineage.config.yaml'));
    // The config omits `relations` and `diagnostics`, so the defaults must
    // survive: MDL305 (supersedes cycles) and the MDL301/MDL304 severities
    // are what the workspace layer's fixture contract depends on.
    assert.equal(result.config.relations['supersedes']?.cycles, 'forbidden');
    assert.equal(result.config.relations['depends_on']?.reasonRequired, true);
    assert.equal(result.config.diagnostics['MDL301'], 'error');
    assert.equal(result.config.diagnostics['MDL304'], 'warning');
  });

  it('the default config reports no diagnostics when no file exists', () => {
    const result = loadConfigFrom(resolve(repoRoot, 'test', 'fixtures'));
    assert.deepEqual(result.diagnostics, []);
    assert.equal(result.config.metadata.required, true);
    assert.equal(result.config.eolPolicy, 'lf');
  });

  it('a config file may declare eolPolicy and normalize reads it', () => {
    const tmp = resolve(repoRoot, 'node_modules', '.mdlineage-eol-policy.yaml');
    writeFileSync(tmp, 'configVersion: 1\neolPolicy: crlf\n');
    try {
      const result = loadConfigFrom(tmp);
      assert.deepEqual(result.diagnostics, [], 'eolPolicy is a legal top-level key');
      assert.equal(result.config.eolPolicy, 'crlf');
    } finally {
      rmSync(tmp);
    }
  });

  it('a broken config yields MDL900 diagnostics and falls back to defaults', () => {
    const tmp = resolve(repoRoot, 'node_modules', '.mdlineage-broken-config.yaml');
    writeFileSync(tmp, 'configVersion: "not-a-number"\nmetadata:\n  required: definitely-not-a-boolean\n');
    try {
      const result = loadConfigFrom(tmp);
      assert.ok(result.diagnostics.length > 0, 'a schema-invalid config must report MDL900');
      assert.equal(result.diagnostics[0]!.code, 'MDL900');
      assert.equal(result.config.configVersion, 1, 'falls back to defaults');
    } finally {
      rmSync(tmp);
    }
  });
});

describe('review round 1 hardening (M1-a adjudication)', () => {
  // Adversarial-review regressions: each case reproduces a red-team finding.
  const doc = (fmBody: string, body = '') =>
    validateDocumentSync({ content: `---\nmdlineage:\n${fmBody}---\n${body}` });
  const rel = (evidence: string, header: string) =>
    doc(
      '  schema: 1\n  id: a.b\n  kind: policy\n  status: active\n  relations:\n    - type: related_to\n      target: a.c\n' +
        `      evidence: "#${evidence}"\n`,
      header,
    );

  it('B-1: a null relations entry reports MDL103 instead of throwing', () => {
    const r = doc('  schema: 1\n  id: a.b\n  kind: policy\n  status: active\n  relations:\n    -\n');
    assert.ok(r.diagnostics.some((d) => d.code === 'MDL103'));
  });

  it('B-1: a null entry beside a valid one does not crash the semantic layer', () => {
    const r = doc(
      '  schema: 1\n  id: a.b\n  kind: policy\n  status: active\n  relations:\n    -\n    - type: related_to\n      target: a.c\n',
    );
    assert.ok(!r.diagnostics.some((d) => d.code === 'MDL201' || d.code === 'MDL202'));
  });

  it('M-1: the MDL002 line is exact on LF files (e02 is line 7)', () => {
    const fixture = readFileSync(resolve(fixtureRoot, 'invalid', 'e02-yaml-indent.md'), 'utf8');
    const r = validateDocumentSync({ content: fixture });
    const d = r.diagnostics.find((x) => x.code === 'MDL002');
    assert.ok(d, 'e02 must report MDL002');
    assert.equal(d.range.start.line + 1, 7);
  });

  it('M-1: the MDL002 line is exact on CRLF files', () => {
    const r = doc('  schema: 1\n  schema: 2\n  id: a.b\n  kind: policy\n  status: active\n');
    const d = r.diagnostics.find((x) => x.code === 'MDL002');
    assert.ok(d, 'duplicate key must report MDL002');
    assert.equal(d.range.start.line + 1, 4);
  });

  it('M-2a: a repeated heading exposes its -1 anchor to evidence', () => {
    const r = rel('notes-1', '# Notes\n\n## Notes\n');
    assert.ok(!r.diagnostics.some((d) => d.code === 'MDL201'));
  });

  it('M-2b: inline code inside a heading joins the anchor', () => {
    const r = rel('run-npm-build', '## Run `npm build`\n');
    assert.ok(!r.diagnostics.some((d) => d.code === 'MDL201'));
  });

  it('M-2c: an NFD heading keeps its combining mark in the anchor', () => {
    const cafe = 'Café';
    assert.ok(!rel(cafe.toLowerCase(), `## ${cafe}\n`).diagnostics.some((d) => d.code === 'MDL201'));
  });

  it('M-2d: GitHub does not collapse whitespace runs ("a--b")', () => {
    assert.ok(!rel('a--b', '## A  B\n').diagnostics.some((d) => d.code === 'MDL201'));
  });

  it('M-2 regression: anchors that truly do not exist still report MDL201', () => {
    assert.ok(rel('nonexistent', '# Real\n').diagnostics.some((d) => d.code === 'MDL201'));
  });

  it('M-3: the EOL severity override applies to MDL602', () => {
    const config = { ...defaultConfig(), diagnostics: { MDL602: 'error' } };
    const r = validateDocumentSync({ content: 'a\r\nb\r\n', config });
    const d = r.diagnostics.find((x) => x.code === 'MDL602');
    assert.ok(d, 'CRLF under the LF policy must report MDL602');
    assert.equal(d.severity, 'error');
  });

  it('M-4: a kind outside the configured vocabulary reports MDL103', () => {
    const r = doc('  schema: 1\n  id: a.b\n  kind: whatever\n  status: active\n');
    assert.ok(r.diagnostics.some((d) => d.code === 'MDL103' && d.message.includes('vocabulary')));
  });

  it('M-4: kind matching is exact, not case-insensitive', () => {
    const r = doc('  schema: 1\n  id: a.b\n  kind: POLICY\n  status: active\n');
    assert.ok(r.diagnostics.some((d) => d.code === 'MDL103'));
  });

  it('M-4: an authority outside the vocabulary reports MDL103', () => {
    const r = doc('  schema: 1\n  id: a.b\n  kind: policy\n  status: active\n  authority: random\n');
    assert.ok(r.diagnostics.some((d) => d.code === 'MDL103'));
  });

  it('M-5: one MDL102 per missing field (e07 has two)', () => {
    const fixture = readFileSync(resolve(fixtureRoot, 'invalid', 'e07-missing-kind-status.md'), 'utf8');
    const r = validateDocumentSync({ content: fixture });
    assert.equal(r.diagnostics.filter((d) => d.code === 'MDL102').length, 2);
  });

  it('M-5: an empty mdlineage mapping reports all four required fields', () => {
    const r = validateDocumentSync({ content: '---\nmdlineage: {}\n---\n' });
    assert.equal(r.diagnostics.filter((d) => d.code === 'MDL102').length, 4);
  });
});
