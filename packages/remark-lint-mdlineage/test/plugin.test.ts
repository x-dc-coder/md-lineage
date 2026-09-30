/**
 * Manifest-driven tests for the remark channel (docs/remark-language-server-
 * solution.md §14.4: one fixture, many entries — the same MDL codes the
 * validator produces must surface through the remark plugin).
 *
 * The pipeline mirrors `.remarkrc.mjs` (§6.2): remark-gfm, remark-frontmatter
 * with `['yaml']`, remark-lint (for `<!--lint ignore-->` support) and this
 * rule. Input is a string, not a file path, because the whole point of the
 * channel is that unsaved buffer content is what gets validated.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkStringify from 'remark-stringify';
import remarkGfm from 'remark-gfm';
import remarkFrontmatter from 'remark-frontmatter';
import remarkLint from 'remark-lint';
import type { VFile } from 'vfile';
import { VFile } from 'vfile';

import remarkLintMdlineage from '../src/index.js';
import { validateDocumentSync } from '@mdlineage/validator';
import { loadConfig, type Config } from '@mdlineage/validator';

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

/** Codes decidable from one document, matching packages/validator's harness. */
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

/** The manifest's layer-scoped expectation, copied from the validator harness. */
function expectedFor(entry: ManifestEntry): string[] {
  if (entry.workspace) return [];
  if (entry.path.includes('e10-duplicate-relation')) return ['MDL202'];
  if (entry.path.includes('e17-evidence-anchor-missing')) return ['MDL201'];
  if (entry.path.includes('e15-mixed-eol')) return ['MDL601'];
  if (entry.path.includes('e16-crlf-eol')) return ['MDL602'];
  return [...entry.expectedCodes];
}

/**
 * Run one document through the full remark pipeline (string in, VFile out).
 *
 * `processSync` is used rather than `runSync` on purpose: it drives parse → run
 * → stringify the way the remark CLI and remark-language-server do, which means
 * `unified-lint-rule`'s post-processing (it assigns `source`/`ruleId`/`fatal`
 * to the messages a rule created) actually runs. `runSync` alone skips that
 * step, so a harness built on it would not test the messages editors receive.
 */
function lintDocument(content: string, path?: string): VFile {
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkFrontmatter, ['yaml'])
    .use(remarkLint)
    .use(remarkLintMdlineage, { configFile: HARNESS_CONFIG })
    // `unified-lint-rule` overwrites `fatal` with the rule's remark severity
    // after the rule runs; this puts the validator's severity back.
    .use(remarkLintMdlineage.restoreSeverity)
    .use(remarkStringify);
  return processor.processSync(path ? { path, value: content } : { value: content });
}

/**
 * The config this harness runs with, and the option that makes the channel use
 * the same one.
 *
 * The repository ships a mdlineage.config.yaml (docs/ pilot: `docs/**`
 * requires front matter, everything else is exempt), and the plugin's
 * implicit lookup walks the CWD,
 * so a harness that runs from the repo root would otherwise validate against a
 * config the manifest contract does not describe. Pointing both entries at one
 * explicit file keeps the comparison about the channel, not about which config
 * each side happened to find.
 */
const HARNESS_CONFIG = resolve(repoRoot, 'test', 'harness', 'mdlineage.config.yaml');

function harnessConfig(): Config {
  const result = loadConfig(HARNESS_CONFIG);
  assert.equal(result.diagnostics.length, 0, 'the harness config must load cleanly');
  return result.config;
}

/** MDL codes carried on the messages, in document order. */
function mdlCodes(file: VFile): string[] {
  return file.messages.map((m) => (m as { code?: string }).code).filter((c): c is string => typeof c === 'string');
}

describe('remark channel — manifest contract (27 fixtures)', () => {
  for (const entry of manifest.entries) {
    it(`${entry.path} — ${entry.description}`, () => {
      const content = readFileSync(resolve(fixtureRoot, entry.path), 'utf8');

      // The reference: the validator, on the same bytes and the same config the
      // channel resolves. The harness's config is passed explicitly because the
      // plugin's implicit lookup walks the CWD, which finds this repository's
      // own mdlineage.config.yaml (the docs/ pilot requirement, not the
      // validator defaults) instead of the defaults the manifest contract pins.
      const config = harnessConfig();
      const direct = validateDocumentSync({ path: entry.path, content, config });
      const directCodes = direct.diagnostics.map((d) => d.code).filter((c) => SINGLE_DOCUMENT_CODES.has(c));

      // The channel: the remark plugin, on the same bytes.
      const file = lintDocument(content, entry.path);
      const produced = mdlCodes(file).filter((c) => SINGLE_DOCUMENT_CODES.has(c));

      // §14.4: identical code sets at both entries.
      assert.deepEqual([...new Set(produced)].sort(), [...new Set(directCodes)].sort(),
        `${entry.path}: remark channel codes [${produced.join(', ')}] differ from validator [${directCodes.join(', ')}]`);

      const expected = expectedFor(entry);
      for (const code of expected) {
        assert.ok(produced.includes(code), `${entry.path}: expected ${code}, got [${produced.join(', ')}]`);
      }

      if (entry.workspace) {
        assert.deepEqual([...new Set(produced)].sort(), [],
          `${entry.path}: workspace fixture must produce no single-document codes`);
        return;
      }

      if (entry.valid) {
        assert.deepEqual([...new Set(produced)].sort(), [],
          `${entry.path}: valid fixture must produce no codes, got [${produced.join(', ')}]`);
        return;
      }

      assert.ok(produced.length > 0, `${entry.path}: invalid fixture produced no single-document codes`);
    });
  }
});

describe('VFileMessage shape', () => {
  it('positions match the validator range exactly', () => {
    const content = readFileSync(resolve(fixtureRoot, 'invalid', 'e05-id-pattern.md'), 'utf8');
    const direct = validateDocumentSync({ content });
    const file = lintDocument(content, 'e05-id-pattern.md');

    assert.equal(file.messages.length, direct.diagnostics.length);
    for (let i = 0; i < file.messages.length; i++) {
      const message = file.messages[i]!;
      const diag = direct.diagnostics[i]!;
      assert.equal(message.line, diag.range.start.line, `line for ${diag.code}`);
      assert.equal(message.column, diag.range.start.column, `column for ${diag.code}`);
      const place = message.place;
      assert.ok(place, 'a Position is set');
      assert.equal(place!.start.line, diag.range.start.line);
      assert.equal(place!.start.column, diag.range.start.column);
      assert.equal(place!.start.offset, diag.range.start.offset);
      assert.equal(place!.end.line, diag.range.end.line);
      assert.equal(place!.end.column, diag.range.end.column);
      assert.equal(place!.end.offset, diag.range.end.offset);
    }
  });

  it('every message carries its MDL code and the rule origin', () => {
    const content = readFileSync(resolve(fixtureRoot, 'invalid', 'e07-missing-kind-status.md'), 'utf8');
    const file = lintDocument(content, 'e07.md');
    assert.deepEqual(
      file.messages.map((m) => (m as { code?: string }).code),
      ['MDL102', 'MDL102'],
    );
    // `vfile-sort` orders same-position messages by reason, so both orders are
    // legal at the same line/column; assert on the set, not the sequence.
    assert.deepEqual(
      new Set(file.messages.map((m) => m.reason)),
      new Set(['Missing required mdlineage field: kind', 'Missing required mdlineage field: status']),
    );
    for (const message of file.messages) {
      assert.equal(message.source, 'mdlineage', 'the origin splits into source/ruleId');
      assert.equal(message.ruleId, 'mdlineage');
      assert.equal(message.fatal, true, 'MDL102 is a validator error, so it is fatal on the remark channel');
      assert.equal(message.note, 'MDLineage MDL102 (schema)');
    }
  });

  it('error-severity diagnostics set fatal, warning-severity do not', () => {
    const errorFile = lintDocument(readFileSync(resolve(fixtureRoot, 'invalid', 'e01-fm-unclosed.md'), 'utf8'));
    const error = errorFile.messages[0]!;
    assert.equal((error as { code?: string }).code, 'MDL001');
    assert.equal(error.fatal, true, 'MDL001 is an error');

    const warnFile = lintDocument(readFileSync(resolve(fixtureRoot, 'invalid', 'e17-evidence-anchor-missing.md'), 'utf8'));
    const warn = warnFile.messages[0]!;
    assert.equal((warn as { code?: string }).code, 'MDL201');
    assert.equal(warn.fatal, false, 'MDL201 is a warning');
  });

  it('review B1: every error-level MDL message across all fixtures is fatal=true', () => {
    // Regression for the M1-b review Blocker: unified-lint-rule overwrites
    // fatal on this rule's messages; restoreSeverity must put every
    // error-severity code back to fatal=true on the composed channel.
    let errorLevel = 0;
    for (const dir of ['valid', 'invalid', 'workspace'] as const) {
      for (const name of readdirSync(resolve(fixtureRoot, dir))) {
        if (!name.endsWith('.md')) continue;
        const file = lintDocument(readFileSync(resolve(fixtureRoot, dir, name), 'utf8'));
        for (const message of file.messages) {
          const code = (message as { code?: string }).code;
          if (!code?.startsWith('MDL')) continue;
          const severity = (message as { data?: { mdlSeverity?: string } }).data?.mdlSeverity;
          if (severity !== 'error') continue;
          errorLevel++;
          assert.equal(message.fatal, true, `${dir}/${name}: ${code} must be fatal on the remark channel`);
        }
      }
    }
    assert.ok(errorLevel >= 10, `expected a meaningful number of error-level messages, got ${errorLevel}`);
  });

  it('review B1: a pipeline without restoreSeverity leaves error-level codes as warnings (documenting the hazard)', () => {
    // Documents the failure mode the restore transformer exists for: without
    // it, unified-lint-rule demotes every MDL message to non-fatal.
    const processor = unified()
      .use(remarkParse)
      .use(remarkGfm)
      .use(remarkFrontmatter, ['yaml'])
      .use(remarkLint)
      .use(remarkLintMdlineage)
      .use(remarkStringify);
    const file = processor.processSync({
      value: readFileSync(resolve(fixtureRoot, 'invalid', 'e01-fm-unclosed.md'), 'utf8'),
    });
    const message = file.messages.find((m) => (m as { code?: string }).code === 'MDL001');
    assert.ok(message, 'e01 must still produce MDL001');
    assert.equal(message.fatal, false, 'without restoreSeverity the error is demoted (the hazard)');
  });

  it('the severity-restoring transformer only touches this rule’s messages', () => {
    // A plain Markdown document produces one of our MDL003 warnings (no
    // mdlineage metadata) and none of remark-lint's own warnings.
    const content = '# Heading\n';
    const file = lintDocument(content);
    assert.deepEqual(mdlCodes(file), ['MDL003']);
    assert.equal(file.messages.length, 1, 'no remark-lint-native messages on a clean GFM document');
  });

  it('message.data carries the diagnostic data and the code', () => {
    const content = readFileSync(resolve(fixtureRoot, 'invalid', 'e05-id-pattern.md'), 'utf8');
    const file = lintDocument(content);
    const message = file.messages[0]!;
    assert.equal((message as { data?: { jsonPointer?: string } }).data?.jsonPointer, '/id');
    assert.equal((message as { data?: { mdlCode?: string } }).data?.mdlCode, 'MDL103');
  });

  it('stringify does not rewrite the buffer the rule validated', () => {
    const content = readFileSync(resolve(fixtureRoot, 'valid', 'v01-full.md'), 'utf8');
    const file = lintDocument(content);
    // The compiled value is the serializer's output, but the messages were
    // produced from the original bytes; re-running the rule on them is what the
    // editor does on every keystroke.
    assert.deepEqual(mdlCodes(file), []);
    assert.ok(file.toString().includes('# Cache policy'), 'the compiler ran and produced Markdown');
  });

  it('an unsaved-buffer edit is what the rule validates, not the disk file', () => {
    // A valid document on disk, edited in memory to break the id pattern: only
    // the buffer channel can see this.
    const onDisk = readFileSync(resolve(fixtureRoot, 'valid', 'v02-minimal.md'), 'utf8');
    const edited = onDisk.replace('id: docs.minimal', 'id: Docs.Minimal');
    const file = lintDocument(edited);
    assert.deepEqual(mdlCodes(file), ['MDL103']);
  });

  it('front matter survives remark-frontmatter in file.value', () => {
    const content = readFileSync(resolve(fixtureRoot, 'valid', 'v01-full.md'), 'utf8');
    const file = new VFile({ value: content });
    unified()
      .use(remarkParse)
      .use(remarkGfm)
      .use(remarkFrontmatter, ['yaml'])
      .use(remarkLint)
      .use(remarkLintMdlineage)
      .runSync(unified().use(remarkParse).use(remarkFrontmatter, ['yaml']).parse(file), file);
    assert.equal(file.toString(), content, 'the rule must see the original bytes');
    assert.deepEqual(mdlCodes(file), []);
  });

  it('CRLF bytes reach the validator through the buffer', () => {
    const content = readFileSync(resolve(fixtureRoot, 'invalid', 'e16-crlf-eol.md'), 'utf8');
    const file = lintDocument(content);
    assert.deepEqual(mdlCodes(file), ['MDL602']);
  });

  it('the rule runs once per file (one message per problem, no duplicates)', () => {
    const content = readFileSync(resolve(fixtureRoot, 'invalid', 'e04-unknown-mdlineage-fields.md'), 'utf8');
    const file = lintDocument(content);
    assert.equal(file.messages.length, 2, 'two unknown fields, two MDL104 messages');
    assert.deepEqual(mdlCodes(file), ['MDL104', 'MDL104']);
  });
});
