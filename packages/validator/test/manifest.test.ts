/**
 * Out-of-band manifest tests (manifestFile & inline manifest).
 *
 * Run with: node --import tsx --test packages/validator/test/manifest.test.ts
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import {
  validateDocumentSync,
  createWorkspaceIndex,
  validateWorkspace,
  loadConfig,
  defaultConfig,
  defaultConfigIsValid,
} from '../src/index.js';
import type { Config } from '../src/index.js';

describe('out-of-band metadata manifest', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(resolve(tmpdir(), 'mdlineage-manifest-test-'));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('defaultConfig remains schema-valid', () => {
    assert.equal(defaultConfigIsValid(), true);
  });

  it('loads external manifestFile and merges with inline manifest (inline wins)', () => {
    const manifestPath = resolve(workDir, 'manifest.yaml');
    writeFileSync(
      manifestPath,
      [
        'documents:',
        '  doc-a.md:',
        '    id: doc.a',
        '    kind: policy',
        '    status: draft',
        '  doc-b.md:',
        '    id: doc.b.external',
        '    kind: guide',
      ].join('\n'),
      'utf8',
    );

    const configPath = resolve(workDir, 'mdlineage.config.yaml');
    writeFileSync(
      configPath,
      [
        'configVersion: 1',
        'manifestFile: manifest.yaml',
        'manifest:',
        '  documents:',
        '    doc-b.md:',
        '      id: doc.b.inline',
        '      kind: guide',
        '      status: active',
      ].join('\n'),
      'utf8',
    );

    const res = loadConfig(configPath);
    assert.equal(res.diagnostics.length, 0, `Diagnostics: ${JSON.stringify(res.diagnostics)}`);
    assert.equal(res.config.manifestDocuments.size, 2);

    const docA = res.config.manifestDocuments.get('doc-a.md');
    assert.ok(docA);
    assert.equal(docA.id, 'doc.a');
    assert.equal(docA.status, 'draft');

    // Inline override doc-b.md
    const docB = res.config.manifestDocuments.get('doc-b.md');
    assert.ok(docB);
    assert.equal(docB.id, 'doc.b.inline');
    assert.equal(docB.status, 'active');
  });

  it('reports MDL900 when manifestFile is not found', () => {
    const configPath = resolve(workDir, 'mdlineage.config.yaml');
    writeFileSync(
      configPath,
      ['configVersion: 1', 'manifestFile: non-existent-manifest.yaml'].join('\n'),
      'utf8',
    );

    const res = loadConfig(configPath);
    assert.equal(res.diagnostics.length, 1);
    assert.equal(res.diagnostics[0]?.code, 'MDL900');
    assert.match(res.diagnostics[0]?.message ?? '', /Manifest file not found/);
  });

  it('reports MDL900 when manifestFile is invalid YAML', () => {
    const manifestPath = resolve(workDir, 'bad-manifest.yaml');
    writeFileSync(manifestPath, 'documents: [invalid: yaml: :', 'utf8');

    const configPath = resolve(workDir, 'mdlineage.config.yaml');
    writeFileSync(
      configPath,
      ['configVersion: 1', 'manifestFile: bad-manifest.yaml'].join('\n'),
      'utf8',
    );

    const res = loadConfig(configPath);
    assert.equal(res.diagnostics.length, 1);
    assert.equal(res.diagnostics[0]?.code, 'MDL900');
    assert.match(res.diagnostics[0]?.message ?? '', /Manifest is not valid YAML/);
  });

  it('exempts MDL003 for plain markdown when manifest provides metadata', () => {
    const configPath = resolve(workDir, 'mdlineage.config.yaml');
    writeFileSync(
      configPath,
      [
        'configVersion: 1',
        'manifest:',
        '  documents:',
        '    guide.md:',
        '      id: docs.guide',
        '      kind: guide',
        '      status: active',
      ].join('\n'),
      'utf8',
    );

    const { config } = loadConfig(configPath);
    const plainMarkdown = '# Just Plain Markdown\n\nNo frontmatter here at all.';

    // Without manifest, guide.md would report MDL003
    const resWithout = validateDocumentSync({
      path: 'guide.md',
      content: plainMarkdown,
      config: defaultConfig(),
    });
    assert.ok(resWithout.diagnostics.some((d) => d.code === 'MDL003'));

    // With manifest matching guide.md, MDL003 is exempt
    const resWith = validateDocumentSync({
      path: 'guide.md',
      content: plainMarkdown,
      config,
    });
    const mdl003 = resWith.diagnostics.find((d) => d.code === 'MDL003');
    assert.equal(mdl003, undefined, 'MDL003 should be exempt when metadata is in manifest');
  });

  it('workspace index indexes manifest-injected id and relations for idToPaths and relationsOf', () => {
    const configPath = resolve(workDir, 'mdlineage.config.yaml');
    writeFileSync(
      configPath,
      [
        'configVersion: 1',
        'manifest:',
        '  documents:',
        '    docs/a.md:',
        '      id: service.alpha',
        '      kind: architecture',
        '      status: active',
        '      relations:',
        '        - type: depends_on',
        '          target: service.beta',
        '          reason: alpha needs beta',
        '    docs/b.md:',
        '      id: service.beta',
        '      kind: architecture',
        '      status: active',
      ].join('\n'),
      'utf8',
    );

    const { config } = loadConfig(configPath);

    const files = new Map<string, string>([
      ['docs/a.md', '# Alpha\n\nContent for alpha'],
      ['docs/b.md', '# Beta\n\nContent for beta'],
    ]);

    const index = createWorkspaceIndex(files, config);

    assert.deepEqual(index.idToPaths('service.alpha'), ['docs/a.md']);
    assert.deepEqual(index.idToPaths('service.beta'), ['docs/b.md']);

    const relationsOfA = index.relationsOf('docs/a.md');
    assert.equal(relationsOfA.length, 1);
    assert.equal(relationsOfA[0]?.type, 'depends_on');
    assert.equal(relationsOfA[0]?.target, 'service.beta');
    assert.equal(relationsOfA[0]?.reason, 'alpha needs beta');

    // Cross-file validation should be completely clean (no MDL302)
    const wsResult = validateWorkspace(index, { includeSingleDocument: false });
    assert.equal(wsResult.length, 0);
  });

  it('catches circular dependency (MDL305) declared in manifest', () => {
    const configPath = resolve(workDir, 'mdlineage.config.yaml');
    writeFileSync(
      configPath,
      [
        'configVersion: 1',
        'manifest:',
        '  documents:',
        '    cycle-a.md:',
        '      id: cycle.a',
        '      kind: policy',
        '      status: active',
        '      relations:',
        '        - type: supersedes',
        '          target: cycle.b',
        '          reason: a supersedes b',
        '    cycle-b.md:',
        '      id: cycle.b',
        '      kind: policy',
        '      status: active',
        '      relations:',
        '        - type: supersedes',
        '          target: cycle.a',
        '          reason: b supersedes a',
      ].join('\n'),
      'utf8',
    );

    const { config } = loadConfig(configPath);

    const files = new Map<string, string>([
      ['cycle-a.md', '# Cycle A'],
      ['cycle-b.md', '# Cycle B'],
    ]);

    const index = createWorkspaceIndex(files, config);
    const wsResult = validateWorkspace(index, { includeSingleDocument: false });

    const mdl305 = wsResult.find((d) => d.code === 'MDL305');
    assert.ok(mdl305, 'Should report MDL305 forbidden cycle for circular supersedes in manifest');
  });
});
