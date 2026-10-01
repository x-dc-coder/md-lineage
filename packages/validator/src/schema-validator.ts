/**
 * JSON Schema validation (docs/remark-language-server-solution.md §4.3, §8.3).
 *
 * Loads schemas/mdlineage-v1.schema.json with ajv (Draft 2020-12 flavour, which
 * is what `$schema: https://json-schema.org/draft/2020-12/schema` requires) and
 * maps every ajv error onto a MDL1xx diagnostic.
 *
 * JSON Pointer → YAML source: ajv only gives `/relations/0/evidence`. This
 * module walks the parsed YAML document (kept with `keepSourceTokens` so every
 * node carries `[start, end, end-after-indent]`) to find the CST node the
 * pointer names. When the pointer cannot be resolved exactly — a `required` on
 * the root, for instance, names no node — the range falls back to the
 * `mdlineage` key itself, and when there is no mdlineage key at all, to the
 * first line of the front matter. Per §8.3 the goal is "at least the mdlineage
 * key and the offending field key or array item".
 *
 * Code assignment (schemas/diagnostic-codes.json):
 *   - `schema` const failure                       → MDL101
 *   - `required` (root or relation if/then)        → MDL102
 *   - everything else inside the mdlineage object  → MDL103
 *   - `additionalProperties`                       → MDL104
 *
 * `additionalProperties` must win over a coincident `required` error, because a
 * misspelled key often displaces the field it meant to be.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
// `ajv` ships no `exports` map, so the Draft 2020-12 build is imported by path;
// its default export is the Ajv2020 class.
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ErrorObject } from 'ajv';
import type { Document, YAMLMap, YAMLSeq } from 'yaml';
import { vocabularyAllows, type Config } from './config.js';
import type { Diagnostic } from './diagnostic.js';
import { severityOf } from './diagnostic.js';
import type { LineMap } from './source-map.js';
import { rangeAt } from './source-map.js';

const SCHEMA_ID = 'https://mdlineage.dev/schemas/mdlineage-v1.schema.json';

/** A compiled schema plus the vocabulary extensions the config supplies. */
export interface SchemaValidator {
  validate(data: unknown): ErrorObject<string, Record<string, unknown>, unknown>[];
}

type CompiledValidate = ((data: unknown) => boolean) & { errors?: ErrorObject[] | null };

let cachedSchema: Record<string, unknown> | null = null;
let cachedValidator: SchemaValidator | null = null;
let cachedSchemaKey: string | null = null;

/** Read the checked-in schema, independent of the process CWD. */
function readSchema(): Record<string, unknown> {
  if (cachedSchema) return cachedSchema;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, '..', '..', '..', 'schemas', 'mdlineage-v1.schema.json'),
    resolve(here, '..', 'schemas', 'mdlineage-v1.schema.json'),
  ];
  for (const candidate of candidates) {
    try {
      cachedSchema = JSON.parse(readFileSync(candidate, 'utf8')) as Record<string, unknown>;
      return cachedSchema;
    } catch {
      // try the next candidate
    }
  }
  throw new Error(`MDLineage could not load ${SCHEMA_ID}; searched ${candidates.join(', ')}`);
}

/**
 * Build (and memoize) the schema validator. The built-in v1 schema is used; a
 * `schemaFile` from the config would select a repository-specific schema, which
 * is loaded in a later milestone.
 */
export function getSchemaValidator(_config?: unknown): SchemaValidator {
  const key = SCHEMA_ID;
  if (cachedValidator && cachedSchemaKey === key) return cachedValidator;

  const schema = readSchema();
  const ajv = new Ajv2020({
    strict: false,
    allErrors: true,
    // The v1 schema legitimately uses `required` inside `then`, where the
    // referenced properties live in the enclosing object.
    strictRequired: false,
  });
  const validate = ajv.compile(schema) as CompiledValidate;
  cachedValidator = {
    validate(data: unknown): ErrorObject[] {
      const ok = validate(data);
      if (ok) return [];
      return validate.errors ?? [];
    },
  };
  cachedSchemaKey = key;
  return cachedValidator;
}

/** Drop the memoized validator; used by tests that swap schemas. */
export function resetSchemaValidatorCache(): void {
  cachedValidator = null;
  cachedSchemaKey = null;
  customSchemaCache.clear();
}

interface CustomSchemaResult {
  validator?: SchemaValidator;
  requiredFields: readonly string[];
  error?: Diagnostic;
}

const customSchemaCache = new Map<string, CustomSchemaResult>();

function toErrorString(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function loadCustomSchema(ctx: SchemaContext): CustomSchemaResult {
  const schemaFile = ctx.config.schemaFile;
  if (!schemaFile) {
    return { validator: getSchemaValidator(), requiredFields: ROOT_REQUIRED_FIELDS };
  }

  const filePath = ctx.config.source
    ? resolve(dirname(ctx.config.source), schemaFile)
    : resolve(schemaFile);

  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (err) {
    return {
      requiredFields: ROOT_REQUIRED_FIELDS,
      error: {
        code: 'MDL900',
        severity: 'error',
        message: `Schema file '${schemaFile}' could not be read: ${toErrorString(err)}`,
        range: rangeAt(ctx.lineMap, 0, 0),
        layer: 'config',
      },
    };
  }

  const cacheKey = `${filePath}:${raw}`;
  const cached = customSchemaCache.get(cacheKey);
  if (cached) return cached;

  let customJson: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Schema root must be a JSON object');
    }
    customJson = parsed as Record<string, unknown>;
  } catch (err) {
    const res: CustomSchemaResult = {
      requiredFields: ROOT_REQUIRED_FIELDS,
      error: {
        code: 'MDL900',
        severity: 'error',
        message: `Schema file '${schemaFile}' is not valid JSON: ${toErrorString(err)}`,
        range: rangeAt(ctx.lineMap, 0, 0),
        layer: 'config',
      },
    };
    customSchemaCache.set(cacheKey, res);
    return res;
  }

  const builtin = readSchema();
  const mergedProperties = {
    ...(builtin.properties as Record<string, unknown> | undefined),
    ...(customJson.properties as Record<string, unknown> | undefined),
  };
  const mergedDefs = {
    ...(builtin.$defs as Record<string, unknown> | undefined),
    ...((customJson.$defs || customJson.definitions) as Record<string, unknown> | undefined),
  };
  const customRequired = Array.isArray(customJson.required)
    ? (customJson.required as string[]).filter((f) => typeof f === 'string')
    : [];
  const builtinRequired = Array.isArray(builtin.required) ? (builtin.required as string[]) : [];
  const mergedRequired = [...new Set([...builtinRequired, ...customRequired])];

  const mergedSchema: Record<string, unknown> = {
    ...builtin,
    ...customJson,
    properties: mergedProperties,
    $defs: mergedDefs,
    required: mergedRequired,
    additionalProperties: false,
  };

  const ajv = new Ajv2020({
    strict: false,
    allErrors: true,
    strictRequired: false,
  });

  try {
    const validate = ajv.compile(mergedSchema) as CompiledValidate;
    const res: CustomSchemaResult = {
      validator: {
        validate(data: unknown): ErrorObject[] {
          const ok = validate(data);
          if (ok) return [];
          return validate.errors ?? [];
        },
      },
      requiredFields: mergedRequired,
    };
    customSchemaCache.set(cacheKey, res);
    return res;
  } catch (err) {
    const res: CustomSchemaResult = {
      requiredFields: ROOT_REQUIRED_FIELDS,
      error: {
        code: 'MDL900',
        severity: 'error',
        message: `Schema file '${schemaFile}' failed to compile: ${toErrorString(err)}`,
        range: rangeAt(ctx.lineMap, 0, 0),
        layer: 'config',
      },
    };
    customSchemaCache.set(cacheKey, res);
    return res;
  }
}

export interface SchemaContext {
  /** Absolute offset of the first YAML byte in the document. */
  rawStart: number;
  /** Line-start table for the whole document, so offsets become ranges. */
  lineMap: LineMap;
  /** Parsed YAML document carrying source tokens. */
  doc: Document | null;
  /** Config severity overrides and vocabulary. */
  config: Config;
  /** The front matter key holding the metadata (config.metadata.key). */
  metadataKey: string;
  /** Where the mdlineage block starts, for range fallbacks. */
  mdlineageRange: { start: number; end: number } | null;
}

/** Validate `data` (the mdlineage object) and convert errors to diagnostics. */
export function validateAgainstSchema(data: unknown, ctx: SchemaContext): Diagnostic[] {
  const out: Diagnostic[] = [];
  let validator: SchemaValidator;
  let requiredFields: readonly string[] = ROOT_REQUIRED_FIELDS;

  if (ctx.config?.schemaFile) {
    const custom = loadCustomSchema(ctx);
    if (custom.error) {
      out.push(custom.error);
      validator = getSchemaValidator();
    } else {
      validator = custom.validator!;
      requiredFields = custom.requiredFields;
    }
  } else {
    validator = getSchemaValidator();
  }

  const errors = validator.validate(data);
  const seen = new Set<string>();

  // ajv reports one `required` error for the whole root object even when many
  // required fields are absent; the M0 contract (test/fixtures/manifest.json,
  // e07: "one MDL102 per missing field") demands one diagnostic each, so the
  // root-level `required` list is expanded here before ajv's own error is
  // dropped. Only the root expansion is contract-relevant; nested `required`
  // (relation entries) keep ajv's per-entry reporting.
  const requiredDiagnostics = expandRootRequired(data, ctx, requiredFields);
  for (const d of requiredDiagnostics) seen.add(`${d.code}:${d.range.start}:${d.range.end}:/`);
  out.push(...requiredDiagnostics);

  for (const err of errors) {
    // The `if` echo of a failed `if/then` duplicates the `then` error.
    if (err.keyword === 'if') continue;
    // Root-level `required` was already expanded per missing field above.
    if (err.keyword === 'required' && err.instancePath === '' && requiredDiagnostics.length > 0) continue;
    const code = errorCode(err);
    const range = resolveErrorRange(err, ctx);
    const dedupe = `${code}:${range.start}:${range.end}:${err.instancePath}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    out.push({
      code,
      severity: severityOf(code, configSeverityOverrides(ctx.config)),
      message: errorMessage(err, code),
      range: rangeAt(ctx.lineMap, range.start, range.end),
      layer: 'schema',
      data: {
        jsonPointer: err.instancePath,
        keyword: err.keyword,
        ...(err.params as Record<string, unknown> | undefined),
      },
    });
  }

  out.push(...validateVocabulary(data, ctx));

  return out;
}

/**
 * Vocabulary check (MDL103): `kind`/`status`/`authority` must be members of the
 * config's word lists when those lists are non-empty (docs/remark-language-
 * server-solution.md §4.3 places the enums in the Schema layer; the values
 * themselves are repository policy, so the JSON Schema only fixes their type).
 */
function validateVocabulary(data: unknown, ctx: SchemaContext): Diagnostic[] {
  if (typeof data !== 'object' || data === null) return [];
  const obj = data as Record<string, unknown>;
  const out: Diagnostic[] = [];

  const checks: Array<{ field: 'kinds' | 'statuses' | 'authorities'; key: string }> = [
    { field: 'kinds', key: 'kind' },
    { field: 'statuses', key: 'status' },
    { field: 'authorities', key: 'authority' },
  ];

  for (const { field, key } of checks) {
    const value = obj[key];
    if (value === undefined) continue;
    if (vocabularyAllows(ctx.config, field, value)) continue;
    const node = ctx.doc ? lookupPointer(ctx.doc, `/${key}`, ctx.metadataKey) : null;
    const located = node ? nodeRange(node) : null;
    const range = located ? shift(located, ctx.rawStart) : (ctx.mdlineageRange ?? { start: 0, end: 0 });
    const allowed = (ctx.config.vocabulary[field] as readonly string[] | undefined) ?? [];
    out.push({
      code: 'MDL103',
      severity: severityOf('MDL103', configSeverityOverrides(ctx.config)),
      message: `'${key}' value ${JSON.stringify(value)} is outside the configured vocabulary (${allowed.join(', ')}).`,
      range: rangeAt(ctx.lineMap, range.start, range.end),
      layer: 'schema',
      data: { jsonPointer: `/${key}`, keyword: 'vocabulary', field },
    });
  }

  return out;
}

/** Severity overrides from the config, in the shape severityOf() expects. */
function configSeverityOverrides(config: Config): Record<string, 'error' | 'warning' | 'information' | 'hint'> {
  return config.diagnostics as Record<string, 'error' | 'warning' | 'information' | 'hint'>;
}

/**
 * Root-level required fields of the v1 schema, expanded to one MDL102 per
 * missing field. Mirrors the `required` list in
 * schemas/mdlineage-v1.schema.json; if the schema adds a required field, this
 * list must move with it.
 */
const ROOT_REQUIRED_FIELDS = ['schema', 'id', 'kind', 'status'] as const;

function expandRootRequired(data: unknown, ctx: SchemaContext, requiredFields: readonly string[] = ROOT_REQUIRED_FIELDS): Diagnostic[] {
  if (typeof data !== 'object' || data === null) return [];
  const obj = data as Record<string, unknown>;
  const out: Diagnostic[] = [];
  for (const field of requiredFields) {
    if (obj[field] !== undefined) continue;
    const node = ctx.doc ? lookupPointer(ctx.doc, `/${field}`, ctx.metadataKey) : null;
    const located = node ? nodeRange(node) : null;
    const range = located ? shift(located, ctx.rawStart) : (ctx.mdlineageRange ?? { start: 0, end: 0 });
    out.push({
      code: 'MDL102',
      severity: severityOf('MDL102', configSeverityOverrides(ctx.config)),
      message: `Missing required mdlineage field: ${field}`,
      range: rangeAt(ctx.lineMap, range.start, range.end),
      layer: 'schema',
      data: { jsonPointer: `/${field}`, keyword: 'required', missingProperty: field },
    });
  }
  return out;
}

/** Pick the MDL code for an ajv error (see the module docstring). */
function errorCode(err: ErrorObject): string {
  if (err.keyword === 'additionalProperties') return 'MDL104';
  if (err.instancePath === '/schema' || err.schemaPath.includes('/properties/schema/const')) return 'MDL101';
  if (err.keyword === 'required') return 'MDL102';
  return 'MDL103';
}

/** Human-readable message per code, per the registry's `message` strings. */
function errorMessage(err: ErrorObject, code: string): string {
  switch (code) {
    case 'MDL101':
      return 'Unsupported metadata schema version';
    case 'MDL102':
      return `Missing required mdlineage field: ${param(err, 'missingProperty')}`;
    case 'MDL103':
      return `Invalid type, pattern, or value at ${err.instancePath || 'the mdlineage object'}`;
    case 'MDL104':
    default:
      return `Unknown mdlineage field: ${param(err, 'additionalProperty')}`;
  }
}

function param(err: ErrorObject, name: string): string {
  const value = (err.params as Record<string, unknown> | undefined)?.[name];
  return typeof value === 'string' ? value : '?';
}

/**
 * Resolve an ajv JSON Pointer to a document range, per §8.3.
 *
 * Precision ladder:
 *   1. the node the pointer names (a scalar, an array item, a map);
 *   2. the parent collection's range;
 *   3. the `mdlineage` key;
 *   4. the first line of the front matter.
 */
export function resolveErrorRange(
  err: ErrorObject,
  ctx: SchemaContext,
): { start: number; end: number } {
  const pointer = err.instancePath;
  // An error at the root of the mdlineage object names no value node, so the
  // keyword-specific lookups below must run — `lookupPointer("")` would
  // otherwise hand back the whole front matter.
  const node = ctx.doc && pointer !== '' ? lookupPointer(ctx.doc, pointer, ctx.metadataKey) : null;

  if (node) {
    const range = nodeRange(node);
    if (range) return shift(range, ctx.rawStart);
  }

  // `required` names no node of its own; point at the key the schema asked for.
  if (err.keyword === 'required') {
    const missing = (err.params as { missingProperty?: string } | undefined)?.missingProperty;
    if (missing) {
      const base = mdlineageMap(ctx);
      if (base) {
        const keyNode = findKeyNode(base, [...pointerParts(err.instancePath), missing]);
        if (keyNode) {
          const range = nodeRange(keyNode);
          if (range) return shift(range, ctx.rawStart);
        }
        // A required field of a relation entry: the entry stands in for it.
        const container = pointerContainer(err.instancePath);
        if (container) {
          const node = findKeyNode(base, container);
          const range = nodeRange(node) ?? nodeRange(valueNode(node));
          if (range) return shift(range, ctx.rawStart);
        }
      }
    }
  }

  if (err.keyword === 'additionalProperties') {
    const name = (err.params as { additionalProperty?: string } | undefined)?.additionalProperty;
    if (name) {
      const base = mdlineageMap(ctx);
      if (base) {
        const keyNode = findKeyNode(base, [...pointerParts(err.instancePath), name]);
        if (keyNode) {
          const range = nodeRange(keyNode);
          if (range) return shift(range, ctx.rawStart);
        }
      }
    }
  }

  if (ctx.mdlineageRange) return ctx.mdlineageRange;
  const first = ctx.lineMap.lineStarts[1] ?? ctx.lineMap.length;
  return { start: 0, end: Math.max(1, first) };
}

/** The mdlineage object's CST node, where key lookups start. */
function mdlineageMap(ctx: SchemaContext): unknown {
  if (!ctx.doc) return null;
  const root = ctx.doc.contents;
  if (root === null || root === undefined) return null;
  return mapAt(root, ctx.metadataKey);
}

/** JSON Pointer split into segments, `[]` for the root. */
function pointerParts(pointer: string): string[] {
  if (!pointer.startsWith('/')) return [];
  return pointer.slice(1).split('/').map(unescapePointer);
}

/** The pointer to the node that *contains* the error (its parent). */
function pointerContainer(pointer: string): string[] | null {
  const parts = pointerParts(pointer);
  if (parts.length === 0) return null;
  return parts.slice(0, -1);
}

/** A Pair's value node, when `node` is a Pair. */
function valueNode(node: unknown): unknown {
  if (node !== null && typeof node === 'object' && 'value' in node) {
    return (node as { value?: unknown }).value;
  }
  return null;
}

function shift(range: { start: number; end: number }, by: number): { start: number; end: number } {
  return { start: range.start + by, end: range.end + by };
}

/** `[start, end)` of a YAML node, or null when the node carries no source. */
function nodeRange(node: unknown): { start: number; end: number } | null {
  if (node === null || typeof node !== 'object') return null;
  const range = (node as { range?: readonly [number, number, number] }).range;
  if (!range) return null;
  return { start: range[0], end: Math.max(range[1], range[0] + 1) };
}

/**
 * Look up a JSON Pointer inside the YAML document.
 *
 * ajv's pointers are relative to the mdlineage object it validated, so the
 * document walk starts at the `mdlineage` value: `/id` means `mdlineage.id`.
 * The `mdlineage` key itself comes from `config.metadata.key`.
 */
function lookupPointer(doc: Document, pointer: string, metadataKey: string): unknown {
  if (pointer === '') return doc.contents;
  if (!pointer.startsWith('/')) return null;
  const parts = pointer.slice(1).split('/').map(unescapePointer);
  if (parts.length === 0) return null;
  const root = doc.contents;
  if (root === null || root === undefined) return null;
  const mdlineage = mapAt(root, metadataKey);
  if (mdlineage === null) return null;
  return descend(mdlineage, parts);
}

/** The value of a top-level key, when that value is a mapping. */
function mapAt(root: unknown, key: string): unknown {
  if (!isMap(root)) return null;
  const pair = root.items.find((p) => (p as { key?: { value?: unknown } }).key?.value === key);
  const value = (pair as { value?: unknown } | undefined)?.value;
  return isMap(value) ? value : null;
}

function unescapePointer(part: string): string {
  return part.replace(/~1/g, '/').replace(/~0/g, '~');
}

/**
 * Walk collections by key/index past the mdlineage object. `yaml` returns a
 * Pair's value for a map key, but a sequence's items are Pairs whose `.node` is
 * the inner map — hence the pair case below.
 */
function descend(node: unknown, parts: string[]): unknown {
  let current: unknown = node;
  for (const part of parts) {
    current = step(current, part);
    if (current === null) return null;
  }
  return current;
}

/** One pointer segment: a map key, an array index, or a pair's inner map. */
function step(node: unknown, part: string): unknown {
  if (node === null || typeof node !== 'object') return null;
  if (isSeq(node)) {
    const index = Number(part);
    if (!Number.isInteger(index) || index < 0 || index >= node.items.length) return null;
    return node.items[index];
  }
  if (isMap(node)) {
    const pair = node.items.find((p) => (p as { key?: { value?: unknown } }).key?.value === part);
    return (pair as { value?: unknown } | undefined)?.value ?? null;
  }
  if (isPair(node)) {
    // An array item is a Pair; its `.node` is the map the next key names.
    const inner = (node as { node?: unknown }).node;
    if (inner !== undefined) return step(inner, part);
    return (node as { value?: unknown }).value ?? null;
  }
  return null;
}

/**
 * Brand a node as a YAML mapping. `yaml` gives both YAMLMap and YAMLSeq an
 * `items` array, so `Array.isArray(items)` cannot tell them apart: a map's
 * constructor is `YAMLMap`.
 */
function isMap(node: unknown): node is YAMLMap {
  if (typeof node !== 'object' || node === null) return false;
  if (!Array.isArray((node as { items?: unknown }).items)) return false;
  return (node as { constructor?: { name?: string } }).constructor?.name === 'YAMLMap';
}

/** Brand a node as a YAML sequence (constructor name, for the same reason). */
function isSeq(node: unknown): node is YAMLSeq {
  if (typeof node !== 'object' || node === null) return false;
  if (!Array.isArray((node as { items?: unknown }).items)) return false;
  return (node as { constructor?: { name?: string } }).constructor?.name === 'YAMLSeq';
}

function isPair(node: unknown): node is { value: unknown; node?: unknown; key: unknown } {
  return typeof node === 'object' && node !== null && 'value' in node && 'key' in node;
}

/**
 * Find the source node of a key inside a (possibly nested) mapping. `path` is a
 * list of keys/indices from the root — `['relations', '0', 'reason']` finds the
 * `reason` key of the first array item. Used for errors that name a key without
 * naming a value: `required` and `additionalProperties`.
 */
function findKeyNode(root: unknown, path: string[]): unknown {
  let current: unknown = root;
  for (let i = 0; i < path.length; i++) {
    const part = path[i]!;
    if (current === null || typeof current !== 'object') return null;
    if (isSeq(current)) {
      const index = Number(part);
      if (!Number.isInteger(index) || index < 0 || index >= current.items.length) return null;
      current = current.items[index];
      continue;
    }
    if (isMap(current)) {
      const pair = current.items.find((p) => (p as { key?: { value?: unknown } }).key?.value === part);
      if (!pair) return null;
      if (i === path.length - 1) return (pair as { key: unknown }).key;
      current = (pair as { value: unknown }).value;
      continue;
    }
    if (isPair(current)) {
      // An array item Pair: step into its inner map for the remaining keys.
      const inner = (current as { node?: unknown }).node;
      if (inner !== undefined && i < path.length) {
        current = findKeyNode(inner, path.slice(i));
        return current;
      }
      return null;
    }
    return null;
  }
  return null;
}
