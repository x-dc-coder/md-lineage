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
        '    status: draft',
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

  it('auto-discovery: loads mdlineage.manifest.yaml beside config without manifestFile declaration', () => {
    const manifestPath = resolve(workDir, 'mdlineage.manifest.yaml');
    writeFileSync(
      manifestPath,
      [
        'version: 1',
        'documents:',
        '  guide.md:',
        '    id: docs.guide',
        '    kind: guide',
        '    status: active',
        '    relations:',
        '      - type: depends_on',
        '        target: docs.target',
        '        reason: needs target',
        '  target.md:',
        '    id: docs.target',
        '    kind: guide',
        '    status: active',
      ].join('\n'),
      'utf8',
    );

    const configPath = resolve(workDir, 'mdlineage.config.yaml');
    writeFileSync(configPath, 'configVersion: 1\n', 'utf8');

    const res = loadConfig(configPath);
    assert.equal(res.diagnostics.length, 0);
    assert.equal(res.config.manifestDocuments.size, 2);

    // Guide is exempt from MDL003
    const plainMarkdown = '# Just Plain Markdown\n\nNo frontmatter.';
    const docRes = validateDocumentSync({
      path: 'guide.md',
      content: plainMarkdown,
      config: res.config,
    });
    assert.equal(docRes.diagnostics.find((d) => d.code === 'MDL003'), undefined);

    // Participates in workspace graph validation
    const files = new Map<string, string>([
      ['guide.md', '# Guide'],
      ['target.md', '# Target'],
    ]);
    const index = createWorkspaceIndex(files, res.config);
    assert.deepEqual(index.idToPaths('docs.guide'), ['guide.md']);
    assert.equal(validateWorkspace(index, { includeSingleDocument: false }).length, 0);
  });

  it('auto-discovery: does not trigger when manifest does not exist', () => {
    const configPath = resolve(workDir, 'mdlineage.config.yaml');
    writeFileSync(configPath, 'configVersion: 1\n', 'utf8');

    const res = loadConfig(configPath);
    assert.equal(res.diagnostics.length, 0);
    assert.equal(res.config.manifestDocuments.size, 0);
  });

  it('auto-discovery: silently skips empty file, non-mapping, missing documents, or malformed YAML', () => {
    const configPath = resolve(workDir, 'mdlineage.config.yaml');
    writeFileSync(configPath, 'configVersion: 1\n', 'utf8');
    const manifestPath = resolve(workDir, 'mdlineage.manifest.yaml');

    // Case 1: empty file
    writeFileSync(manifestPath, '', 'utf8');
    let res = loadConfig(configPath);
    assert.equal(res.diagnostics.length, 0);
    assert.equal(res.config.manifestDocuments.size, 0);

    // Case 2: non-mapping (string or array)
    writeFileSync(manifestPath, '- item1\n- item2\n', 'utf8');
    res = loadConfig(configPath);
    assert.equal(res.diagnostics.length, 0);
    assert.equal(res.config.manifestDocuments.size, 0);

    // Case 3: missing documents key
    writeFileSync(manifestPath, 'version: 1\nother: {}\n', 'utf8');
    res = loadConfig(configPath);
    assert.equal(res.diagnostics.length, 0);
    assert.equal(res.config.manifestDocuments.size, 0);

    // Case 4: bad YAML
    writeFileSync(manifestPath, 'documents: [broken: yaml: :', 'utf8');
    res = loadConfig(configPath);
    assert.equal(res.diagnostics.length, 0);
    assert.equal(res.config.manifestDocuments.size, 0);
  });

  it('auto-discovery: explicit manifestFile takes precedence and does not duplicate', () => {
    const autoPath = resolve(workDir, 'mdlineage.manifest.yaml');
    writeFileSync(
      autoPath,
      'documents:\n  doc.md:\n    id: auto.doc\n    kind: guide\n    status: active\n',
      'utf8',
    );

    const explicitPath = resolve(workDir, 'custom.manifest.yaml');
    writeFileSync(
      explicitPath,
      'documents:\n  doc.md:\n    id: explicit.doc\n    kind: guide\n    status: active\n',
      'utf8',
    );

    const configPath = resolve(workDir, 'mdlineage.config.yaml');
    writeFileSync(
      configPath,
      'configVersion: 1\nmanifestFile: custom.manifest.yaml\n',
      'utf8',
    );

    const res = loadConfig(configPath);
    assert.equal(res.diagnostics.length, 0);
    assert.equal(res.config.manifestDocuments.size, 1);
    assert.equal(res.config.manifestDocuments.get('doc.md')?.id, 'explicit.doc');
  });

  it('auto-discovery: inline manifest overrides auto-discovered documents', () => {
    const autoPath = resolve(workDir, 'mdlineage.manifest.yaml');
    writeFileSync(
      autoPath,
      [
        'documents:',
        '  doc-a.md:',
        '    id: doc.a.auto',
        '    kind: guide',
        '    status: active',
        '  doc-b.md:',
        '    id: doc.b.auto',
        '    kind: guide',
        '    status: active',
      ].join('\n'),
      'utf8',
    );

    const configPath = resolve(workDir, 'mdlineage.config.yaml');
    writeFileSync(
      configPath,
      [
        'configVersion: 1',
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
    assert.equal(res.diagnostics.length, 0);
    // Because inline has non-empty documents, auto-discovery is bypassed (per plan)
    // or if inline documents overrides auto:
    // Let's verify what happens: hasInlineDocs is true, so autoManifest is not loaded
    const docB = res.config.manifestDocuments.get('doc-b.md');
    assert.ok(docB);
    assert.equal(docB.id, 'doc.b.inline');
  });

  it('auto-discovery: extends preset with manifestFile treats it as explicit', () => {
    const presetPath = resolve(workDir, 'preset.config.yaml');
    const customManifest = resolve(workDir, 'custom.manifest.yaml');
    writeFileSync(
      customManifest,
      'documents:\n  doc.md:\n    id: preset.doc\n    kind: guide\n    status: active\n',
      'utf8',
    );
    writeFileSync(
      presetPath,
      'configVersion: 1\nmanifestFile: custom.manifest.yaml\n',
      'utf8',
    );

    const autoPath = resolve(workDir, 'mdlineage.manifest.yaml');
    writeFileSync(
      autoPath,
      'documents:\n  doc.md:\n    id: auto.doc\n    kind: guide\n    status: active\n',
      'utf8',
    );

    const configPath = resolve(workDir, 'mdlineage.config.yaml');
    writeFileSync(
      configPath,
      'configVersion: 1\nextends:\n  - ./preset.config.yaml\n',
      'utf8',
    );

    const res = loadConfig(configPath);
    assert.equal(res.diagnostics.length, 0);
    assert.equal(res.config.manifestDocuments.get('doc.md')?.id, 'preset.doc');
  });

  it('reports MDL105 warning when document has front matter and manifest entry', () => {
    const configPath = resolve(workDir, 'mdlineage.config.yaml');
    writeFileSync(
      configPath,
      [
        'configVersion: 1',
        'manifest:',
        '  documents:',
        '    doc.md:',
        '      id: manifest.doc',
        '      kind: guide',
        '      status: active',
      ].join('\n'),
      'utf8',
    );

    const { config } = loadConfig(configPath);
    const content = [
      '---',
      'mdlineage:',
      '  schema: 1',
      '  id: fm.doc',
      '  kind: guide',
      '  status: active',
      '---',
      '# Document',
    ].join('\n');

    const res = validateDocumentSync({
      path: 'doc.md',
      content,
      config,
    });

    const mdl105 = res.diagnostics.find((d) => d.code === 'MDL105');
    assert.ok(mdl105, 'MDL105 warning must be reported');
    assert.equal(mdl105.severity, 'warning');
    assert.match(mdl105.message, /manifest entry is ignored/);
  });

  it('MDL003 uses new message format when missing metadata', () => {
    const res = validateDocumentSync({
      path: 'plain.md',
      content: '# Just text\n',
      config: defaultConfig(),
    });

    const mdl003 = res.diagnostics.find((d) => d.code === 'MDL003');
    assert.ok(mdl003);
    assert.equal(mdl003.message, "Missing mdlineage metadata: no 'mdlineage' key and no manifest entry");
  });

  it('reports MDL102 when manifest entry is missing required status', () => {
    const manifestPath = resolve(workDir, 'manifest.yaml');
    writeFileSync(
      manifestPath,
      [
        'version: 1',
        'documents:',
        '  doc.md:',
        '    id: manifest.doc',
        '    kind: reference',
      ].join('\n'),
      'utf8',
    );

    const configPath = resolve(workDir, 'mdlineage.config.yaml');
    writeFileSync(
      configPath,
      [
        'configVersion: 1',
        'manifestFile: manifest.yaml',
      ].join('\n'),
      'utf8',
    );

    const { config } = loadConfig(configPath);
    const res = validateDocumentSync({
      path: 'doc.md',
      content: '# Plain doc\n',
      config,
    });

    const mdl102List = res.diagnostics.filter((d) => d.code === 'MDL102');
    assert.ok(mdl102List.length > 0, 'Should report MDL102 for missing required field');
    assert.ok(mdl102List.some((d) => d.message.includes('Missing required mdlineage field: status')));
  });

  it('config schema: rejects inline manifest id with underscore or consecutive separators', () => {
    const configPath = resolve(workDir, 'invalid-id.config.yaml');
    // Case 1: underscore
    writeFileSync(
      configPath,
      [
        'configVersion: 1',
        'manifest:',
        '  documents:',
        '    doc.md:',
        '      id: doc_a',
        '      kind: reference',
        '      status: active',
      ].join('\n'),
      'utf8',
    );
    let res = loadConfig(configPath);
    assert.equal(res.diagnostics.length, 1);
    assert.equal(res.diagnostics[0]?.code, 'MDL900');
    assert.match(res.diagnostics[0]?.message ?? '', /must match pattern/);

    // Case 2: consecutive separators (..)
    writeFileSync(
      configPath,
      [
        'configVersion: 1',
        'manifest:',
        '  documents:',
        '    doc.md:',
        '      id: doc..a',
        '      kind: reference',
        '      status: active',
      ].join('\n'),
      'utf8',
    );
    res = loadConfig(configPath);
    assert.equal(res.diagnostics.length, 1);
    assert.equal(res.diagnostics[0]?.code, 'MDL900');
    assert.match(res.diagnostics[0]?.message ?? '', /must match pattern/);

    // Case 3: valid id passes schema
    writeFileSync(
      configPath,
      [
        'configVersion: 1',
        'manifest:',
        '  documents:',
        '    doc.md:',
        '      id: doc.a',
        '      kind: reference',
        '      status: active',
      ].join('\n'),
      'utf8',
    );
    res = loadConfig(configPath);
    assert.equal(res.diagnostics.length, 0);
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
