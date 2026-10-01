/**
 * Directory intent and layout-exception tests (P4 / MDL502–MDL504).
 *
 * Covers the intent block added to LayoutRule and the top-level
 * `layoutExceptions` array: intent.kinds/authority/forbidStatus report MDL502,
 * intent.maxDepth/naming report MDL504, and a matching live exception
 * suppresses intent checks while an expired one reports MDL503 and stops
 * exempting. Backward compatibility with intent-free configurations is pinned
 * here too.
 *
 * Run with: node --import tsx --test packages/validator/test/layout.test.ts
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { validateDocumentSync, defaultConfig, defaultConfigIsValid, resolveSeverity } from '../src/index.js';
import { loadConfig, configToSchema } from '../src/config.js';
import type { Config, LayoutRule, LayoutException } from '../src/index.js';

/** A schema-valid document with the given mdlineage fields. */
function doc(fields: Record<string, string>, heading = '# Sample'): string {
  const lines = ['---', 'mdlineage:', '  schema: 1'];
  for (const [key, value] of Object.entries(fields)) lines.push(`  ${key}: ${value}`);
  lines.push('---', '', heading, '');
  return lines.join('\n');
}

function configWith(
  layout: readonly LayoutRule[],
  layoutExceptions: readonly LayoutException[] = [],
): Config {
  return { ...defaultConfig(), layout, layoutExceptions };
}

/** Standard metadata: a valid id and the given kind/status/authority. */
function meta(kind: string, status = 'active', authority?: string): Record<string, string> {
  const fields: Record<string, string> = { id: 'docs.sample', kind, status };
  if (authority) fields.authority = authority;
  return fields;
}

describe('layout intent — MDL502 (directory-misplaced)', () => {
  it('a kind outside intent.kinds reports MDL502 with rule data', () => {
    const config = configWith([{ match: 'docs/**', intent: { kinds: ['architecture'] } }]);
    const content = doc(meta('guide'));
    const r = validateDocumentSync({ content, path: 'docs/guide.md', config });
    const d = r.diagnostics.find((x) => x.code === 'MDL502');
    assert.ok(d, 'a mismatched kind must report MDL502');
    assert.equal(d.layer, 'policy-layout');
    assert.equal(d.severity, 'warning');
    assert.equal(d.data?.rule, 'intent.kinds');
    assert.equal(d.data?.kind, 'guide');
    assert.deepEqual(d.data?.allowed, ['architecture']);
    assert.match(d.message, /Directory intent violation/);
  });

  it('a kind inside intent.kinds reports nothing', () => {
    const config = configWith([{ match: 'docs/**', intent: { kinds: ['architecture'] } }]);
    const content = doc(meta('architecture'));
    const r = validateDocumentSync({ content, path: 'docs/arch.md', config });
    assert.equal(r.diagnostics.some((x) => x.code === 'MDL502'), false);
  });

  it('an authority outside intent.authority reports MDL502', () => {
    const config = configWith([{ match: 'specs/**', intent: { authority: ['canonical'] } }]);
    const content = doc(meta('guide', 'active', 'supporting'));
    const r = validateDocumentSync({ content, path: 'specs/api.md', config });
    const d = r.diagnostics.find((x) => x.code === 'MDL502');
    assert.ok(d, 'a mismatched authority must report MDL502');
    assert.equal(d.data?.rule, 'intent.authority');
    assert.equal(d.data?.authority, 'supporting');
  });

  it('a status in intent.forbidStatus reports MDL502', () => {
    const config = configWith([{ match: 'docs/**', intent: { forbidStatus: ['deprecated'] } }]);
    const content = doc(meta('policy', 'deprecated'));
    const r = validateDocumentSync({ content, path: 'docs/old.md', config });
    const d = r.diagnostics.find((x) => x.code === 'MDL502');
    assert.ok(d, 'a forbidden status must report MDL502');
    assert.equal(d.data?.rule, 'intent.forbidStatus');
    assert.equal(d.data?.status, 'deprecated');
  });

  it('path outside the rule match is not checked', () => {
    const config = configWith([{ match: 'docs/**', intent: { kinds: ['architecture'] } }]);
    const content = doc(meta('guide'));
    const r = validateDocumentSync({ content, path: 'notes/guide.md', config });
    assert.equal(r.diagnostics.some((x) => x.code === 'MDL502'), false);
  });
});

describe('layout intent — MDL504 (layout-constraint)', () => {
  it('a document deeper than intent.maxDepth reports MDL504', () => {
    const config = configWith([{ match: 'docs/**', intent: { maxDepth: 1 } }]);
    const content = doc(meta('architecture'));
    const deep = validateDocumentSync({ content, path: 'docs/a/b/deep.md', config });
    const d = deep.diagnostics.find((x) => x.code === 'MDL504');
    assert.ok(d, 'a document below maxDepth must report MDL504');
    assert.equal(d.layer, 'policy-layout');
    assert.equal(d.severity, 'warning');
    assert.equal(d.data?.rule, 'intent.maxDepth');
    assert.equal(d.data?.depth, 2);
    assert.equal(d.data?.maxDepth, 1);

    const shallow = validateDocumentSync({ content, path: 'docs/a/ok.md', config });
    assert.equal(shallow.diagnostics.some((x) => x.code === 'MDL504'), false);
  });

  it('a filename not matching intent.naming reports MDL504', () => {
    const config = configWith([{ match: 'docs/**', intent: { naming: '^[a-z0-9-]+$' } }]);
    const bad = validateDocumentSync({ content: doc(meta('architecture')), path: 'docs/Bad_Name.md', config });
    const d = bad.diagnostics.find((x) => x.code === 'MDL504');
    assert.ok(d, 'a bad filename must report MDL504');
    assert.equal(d.data?.rule, 'intent.naming');
    assert.equal(d.data?.basename, 'Bad_Name.md');

    const good = validateDocumentSync({ content: doc(meta('architecture')), path: 'docs/good-name.md', config });
    assert.equal(good.diagnostics.some((x) => x.code === 'MDL504'), false);
  });

  it('an invalid naming regex is ignored rather than throwing', () => {
    const config = configWith([{ match: 'docs/**', intent: { naming: '(' } }]);
    const r = validateDocumentSync({ content: doc(meta('architecture')), path: 'docs/anything.md', config });
    assert.equal(r.diagnostics.some((x) => x.code === 'MDL504'), false);
  });
});

describe('layout exceptions — MDL503 (exception-expired)', () => {
  const nowMs = Date.parse('2026-09-30T00:00:00Z');

  it('a live exception suppresses intent checks for the covered document', () => {
    const config = configWith(
      [{ match: 'docs/**', intent: { kinds: ['architecture'] } }],
      [{ path: 'docs/legacy/**', reason: 'migration in progress', expires: '2999-01-01' }],
    );
    const content = doc(meta('guide'));

    // Sanity: without the exception the same document reports MDL502.
    const unexempt = validateDocumentSync({
      content,
      path: 'docs/legacy/old.md',
      config: configWith([{ match: 'docs/**', intent: { kinds: ['architecture'] } }]),
    });
    assert.ok(unexempt.diagnostics.some((x) => x.code === 'MDL502'));

    const exempt = validateDocumentSync({ content, path: 'docs/legacy/old.md', config, nowMs });
    assert.equal(exempt.diagnostics.some((x) => x.code === 'MDL502'), false, 'intent checks must be suppressed');
    assert.equal(exempt.diagnostics.some((x) => x.code === 'MDL503'), false, 'a live exception is not expired');
    // An exception does not lift the MDL501 checks.
    assert.equal(exempt.diagnostics.some((x) => x.code === 'MDL501'), false);
  });

  it('an expired exception reports MDL503 (error) and no longer exempts', () => {
    const config = configWith(
      [{ match: 'docs/**', intent: { kinds: ['architecture'] } }],
      [{ path: 'docs/legacy/**', reason: 'temporary', expires: '2020-01-01' }],
    );
    const content = doc(meta('guide'));
    const r = validateDocumentSync({ content, path: 'docs/legacy/old.md', config, nowMs });

    const expired = r.diagnostics.find((x) => x.code === 'MDL503');
    assert.ok(expired, 'an expired exception must report MDL503');
    assert.equal(expired.layer, 'policy-layout');
    assert.equal(expired.severity, 'error');
    assert.equal(expired.data?.expires, '2020-01-01');
    assert.equal(expired.data?.reason, 'temporary');

    assert.ok(
      r.diagnostics.some((x) => x.code === 'MDL502'),
      'an expired exception must not suppress intent checks',
    );
  });

  it('an exception without expires never reports MDL503', () => {
    const config = configWith(
      [{ match: 'docs/**', intent: { kinds: ['architecture'] } }],
      [{ path: 'docs/legacy/**', reason: 'permanent' }],
    );
    const r = validateDocumentSync({ content: doc(meta('guide')), path: 'docs/legacy/old.md', config, nowMs });
    assert.equal(r.diagnostics.some((x) => x.code === 'MDL503'), false);
    assert.equal(r.diagnostics.some((x) => x.code === 'MDL502'), false, 'a permanent exception exempts');
  });

  it('a non-matching exception path does not exempt another document', () => {
    const config = configWith(
      [{ match: 'docs/**', intent: { kinds: ['architecture'] } }],
      [{ path: 'docs/other/**', reason: 'elsewhere', expires: '2999-01-01' }],
    );
    const r = validateDocumentSync({ content: doc(meta('guide')), path: 'docs/legacy/old.md', config, nowMs });
    assert.ok(r.diagnostics.some((x) => x.code === 'MDL502'));
  });
});

describe('layout backward compatibility', () => {
  it('a config with no intent and no exceptions behaves exactly as before', () => {
    const config = configWith([{ match: 'rfc/**', forbidStatus: ['deprecated'] }]);
    const content = doc(meta('policy', 'deprecated'));
    const r = validateDocumentSync({ content, path: 'rfc/auth.md', config });
    const codes = r.diagnostics.map((d) => d.code);
    assert.deepEqual([...new Set(codes)], ['MDL501'], `only MDL501 expected, got [${codes.join(', ')}]`);
  });

  it('the built-in default config still validates against the schema', () => {
    assert.equal(defaultConfigIsValid(), true);
  });

  it('intent and layoutExceptions round-trip through configToSchema', () => {
    const config = configWith(
      [
        { match: '**/*.md', require: { frontmatter: 'optional' } },
        { match: 'docs/**', intent: { kinds: ['architecture'], maxDepth: 2, naming: '^[a-z-]+$' } },
      ],
      [{ path: 'docs/legacy/**', reason: 'migration', expires: '2026-12-31' }],
    );
    const projected = configToSchema(config) as {
      layout: Array<{ intent?: { kinds?: string[] } }>;
      layoutExceptions: Array<{ path: string; expires?: string }>;
    };
    assert.deepEqual(projected.layout[1]?.intent?.kinds, ['architecture']);
    assert.equal(projected.layoutExceptions[0]?.path, 'docs/legacy/**');
    assert.equal(projected.layoutExceptions[0]?.expires, '2026-12-31');
  });

  it('MDL503 resolves to error severity', () => {
    assert.equal(resolveSeverity(defaultConfig(), 'MDL503'), 'error');
    assert.equal(resolveSeverity(defaultConfig(), 'MDL502'), 'warning');
    assert.equal(resolveSeverity(defaultConfig(), 'MDL504'), 'warning');
  });
});

describe('layout config parsing', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), 'mdlineage-layout-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const write = (name: string, text: string): string => {
    const path = resolve(dir, name);
    writeFileSync(path, text);
    return path;
  };

  it('a config declaring intent and layoutExceptions loads cleanly and is parsed', () => {
    const cfg = write(
      'mdlineage.config.yaml',
      [
        'configVersion: 1',
        'layout:',
        "  - match: 'docs/**'",
        '    intent:',
        '      description: Architecture records',
        "      kinds: [architecture]",
        "      topics: [structure]",
        '      maxDepth: 2',
        "      naming: '^[a-z0-9-]+$'",
        '      catalog: true',
        'layoutExceptions:',
        "  - path: 'docs/legacy/**'",
        '    reason: migration in progress',
        '    expires: 2026-12-31',
        '',
      ].join('\n'),
    );
    const r = loadConfig(cfg);
    assert.deepEqual(r.diagnostics, [], 'the config must pass the extended schema');
    assert.equal(r.config.layout.length, 1);
    const intent = r.config.layout[0]?.intent;
    assert.deepEqual(intent?.kinds, ['architecture']);
    assert.deepEqual(intent?.topics, ['structure']);
    assert.equal(intent?.maxDepth, 2);
    assert.equal(intent?.naming, '^[a-z0-9-]+$');
    assert.equal(intent?.catalog, true);
    assert.equal(r.config.layoutExceptions.length, 1);
    assert.equal(r.config.layoutExceptions[0]?.path, 'docs/legacy/**');
    assert.equal(r.config.layoutExceptions[0]?.expires, '2026-12-31');
  });

  it('an invalid exception expires format is rejected by the schema (MDL900)', () => {
    const cfg = write(
      'mdlineage.config.yaml',
      [
        'configVersion: 1',
        'layoutExceptions:',
        "  - path: 'docs/**'",
        '    reason: bad date',
        '    expires: 31-12-2026',
        '',
      ].join('\n'),
    );
    const r = loadConfig(cfg);
    assert.ok(r.diagnostics.length > 0, 'a malformed expires must fail schema validation');
    assert.equal(r.diagnostics[0]?.code, 'MDL900');
  });

  it('an intent object with an unknown key is rejected by the schema (MDL900)', () => {
    const cfg = write(
      'mdlineage.config.yaml',
      ['configVersion: 1', 'layout:', "  - match: 'docs/**'", '    intent:', '      typoKey: true', ''].join('\n'),
    );
    const r = loadConfig(cfg);
    assert.ok(r.diagnostics.length > 0, 'unknown intent keys must fail schema validation');
    assert.equal(r.diagnostics[0]?.code, 'MDL900');
  });
});
