/**
 * Configuration loading (docs/remark-language-server-solution.md §7.1).
 *
 * mdlineage.config.yaml is the authoritative, non-executable configuration: it
 * survives the later migration off the remark host. This module reads it, or
 * returns the built-in defaults when the file is absent (this repository ships
 * no mdlineage.config.yaml yet).
 *
 * The built-in defaults MUST validate against schemas/mdlineage-config.schema.json;
 * that invariant is asserted by the test suite.
 *
 * Code number note: MDL9xx is the reserved block for configuration and internal
 * state, but no number has been assigned yet (see the reservedRanges in
 * schemas/diagnostic-codes.json and the open issue in docs/progress.md). Config
 * failures therefore report "MDL900" — a placeholder number, not a registered
 * code. TODO: replace with the assigned MDL9xx number once the block is opened.
 */

import { statSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, sep } from 'node:path';
import { parseDocument } from 'yaml';
// `ajv` ships no `exports` map, so the Draft 2020-12 build is imported by path;
// its default export is the Ajv2020 class.
import { Ajv2020 } from 'ajv/dist/2020.js';

/** Line-ending policy for the raw-buffer scan (MDL602). */
export type EolPolicy = 'lf' | 'crlf' | 'cr';

export interface ConfigVocabulary {
  readonly kinds?: readonly string[];
  readonly statuses?: readonly string[];
  readonly authorities?: readonly string[];
}

export interface RelationSwitch {
  readonly impact?: boolean;
  readonly reasonRequired?: boolean;
  readonly selfReference?: 'allowed' | 'forbidden';
  readonly cycles?: 'allowed' | 'forbidden';
  readonly severity?: 'error' | 'warning' | 'information' | 'hint';
}

/**
 * The configuration the validator consumes, split in two:
 *   - `schema` — every key of mdlineage.config.yaml this version interprets.
 *     This object MUST validate against schemas/mdlineage-config.schema.json
 *     (the test suite asserts it), so it never carries a key the schema does
 *     not know.
 *   - `derived` — values the validator computes that are not config-file keys:
 *     bookkeeping such as `raw`, `source` and `extendsChain`.
 */
export interface Config {
  readonly configVersion: number;
  readonly files: { readonly include: readonly string[]; readonly exclude: readonly string[] };
  readonly metadata: {
    readonly key: string;
    readonly required: boolean;
    readonly preserveUnknownTopLevelFields: boolean;
    readonly rejectUnknownMdlineageFields: boolean;
  };
  readonly vocabulary: ConfigVocabulary;
  readonly relations: Readonly<Record<string, RelationSwitch>>;
  /** Severity overrides keyed by diagnostic code. */
  readonly diagnostics: Readonly<Record<string, 'error' | 'warning' | 'information' | 'hint'>>;
  /** Line-ending policy (§4.3). Schema key; git's `eol` attribute has no CR form. */
  readonly eolPolicy: EolPolicy;
  /** The unparsed configuration object, for keys this version does not interpret. */
  readonly raw: Readonly<Record<string, unknown>> | null;
  /** Absolute path the config was loaded from, or null for built-in defaults. */
  readonly source: string | null;
  /**
   * Presets this config was assembled from, innermost first. Empty for a config
   * with no `extends` (§7.5). The chain's own file is NOT included here — it is
   * `source` — so the two together describe the whole assembly.
   */
  readonly extendsChain: readonly string[];
}

/**
 * The schema-valid projection of a Config: everything the config schema knows.
 * Used by `defaultConfigIsValid()` and by config round-tripping.
 */
export function configToSchema(config: Config): Readonly<Record<string, unknown>> {
  const out: Record<string, unknown> = {
    configVersion: config.configVersion,
    files: { ...config.files },
    metadata: { ...config.metadata },
    vocabulary: { ...config.vocabulary },
    relations: { ...config.relations },
    diagnostics: { ...config.diagnostics },
    eolPolicy: config.eolPolicy,
  };
  for (const key of Object.keys(out)) {
    if (out[key] === undefined) delete out[key];
  }
  return out;
}

/**
 * Built-in defaults. Every value mirrors the `default` annotations in
 * schemas/mdlineage-config.schema.json and the example vocabulary in
 * docs/remark-language-server-solution.md §7.1.
 */
export function defaultConfig(): Config {
  return {
    configVersion: 1,
    files: { include: ['**/*.md'], exclude: ['node_modules/**', 'dist/**', 'vendor/**'] },
    metadata: {
      key: 'mdlineage',
      required: true,
      preserveUnknownTopLevelFields: true,
      rejectUnknownMdlineageFields: true,
    },
    vocabulary: {
      kinds: ['policy', 'guide', 'architecture', 'reference'],
      statuses: ['draft', 'active', 'deprecated'],
      authorities: ['canonical', 'supporting'],
    },
    relations: {
      depends_on: { impact: true, reasonRequired: true, selfReference: 'forbidden' },
      implements: { impact: true, reasonRequired: true },
      refines: { impact: true, reasonRequired: true },
      supersedes: { impact: true, reasonRequired: true, cycles: 'forbidden' },
      contradicts: { severity: 'warning', reasonRequired: true },
      example_of: { impact: false },
      related_to: { impact: false },
    },
    diagnostics: { MDL301: 'error', MDL304: 'warning' },
    eolPolicy: 'lf',
    raw: null,
    source: null,
    extendsChain: [],
  };
}

/** Result of loading configuration: either a usable config or config diagnostics. */
export interface ConfigLoadResult {
  readonly config: Config;
  /**
   * MDL900 diagnostics for a config the caller asked for but could not use:
   * a path that does not exist, a file that cannot be read, YAML that does not
   * parse, or a document that fails the config schema. The built-in default
   * config never produces any. Callers report these to the user; they do not
   * stop document validation, which falls back to the defaults.
   */
  readonly diagnostics: ConfigDiagnostic[];
}

export interface ConfigDiagnostic {
  readonly code: string;
  readonly severity: 'error' | 'warning' | 'information' | 'hint';
  readonly message: string;
  readonly range?: { line: number; column: number };
}

const CONFIG_SCHEMA_FILE = 'mdlineage-config.schema.json';

let compiledConfigValidator: ConfigValidateFn | null = null;

type ConfigValidateFn = ((data: unknown) => boolean) & { errors?: unknown[] };

/** Load and compile the config schema once per process. */
function configValidator(): ConfigValidateFn {
  if (compiledConfigValidator) return compiledConfigValidator;
  const schemaPath = resolveSchemaPath(CONFIG_SCHEMA_FILE);
  const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as Record<string, unknown>;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  const validate = ajv.compile(schema) as ConfigValidateFn;
  compiledConfigValidator = validate;
  return validate;
}

/** Resolve a path to a checked-in schema file, independent of the CWD. */
function resolveSchemaPath(name: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/ at package root -> repo root is three levels up (dist, package, repo).
  const candidates = [
    resolve(here, '..', '..', '..', 'schemas', name),
    resolve(here, '..', 'schemas', name),
  ];
  for (const candidate of candidates) {
    try {
      readFileSync(candidate);
      return candidate;
    } catch {
      // try the next candidate
    }
  }
  return candidates[0]!;
}


/**
 * Load configuration.
 *
 * - `path` given: that file must exist and must validate. A path the caller
 *   named explicitly that does not exist is a configuration error (MDL900) —
 *   silence here would hide a typo in `--config` behind default behaviour — so
 *   the diagnostics carry it and the defaults still apply. A directory is a
 *   search ("look inside it for mdlineage.config.yaml"), so an empty one stays
 *   silent like an implicit lookup.
 * - `path` omitted: walk up from `from` (or the CWD) looking for
 *   mdlineage.config.yaml; absence is not an error, it means "use defaults".
 *
 * This is the only function in the validator package that touches the
 * filesystem, and it is called by adapters at setup time — never by
 * `validateDocument`, which stays pure. A config that `extends` preset files
 * reads those too, through `applyExtends`; the reads stay here so the
 * "no IO outside this module" boundary holds for the whole chain.
 */
export function loadConfig(path?: string, from?: string): ConfigLoadResult {
  const configPath = path ? resolve(path) : findConfig(from ?? process.cwd());
  if (configPath === null) return { config: defaultConfig(), diagnostics: [] };

  let text: string;
  try {
    const stat = statSync(configPath);
    if (stat.isDirectory()) {
      // A directory means "look inside it for mdlineage.config.yaml". That is a
      // search, not a named file, so an empty directory stays silent: it means
      // this tree has no configuration, same as an implicit lookup that finds
      // nothing.
      const inside = resolve(configPath, 'mdlineage.config.yaml');
      if (!pathExists(inside)) return { config: defaultConfig(), diagnostics: [] };
      return loadConfig(inside);
    }
    text = readFileSync(configPath, 'utf8');
  } catch (error) {
    // A missing *implicit* lookup is the normal "no config in this tree" path
    // and stays silent. A missing *explicit* path is MDL900: the caller named
    // a file, so its absence is a broken setup, not an empty one.
    if (path === undefined) {
      return { config: defaultConfig(), diagnostics: [] };
    }
    if (!pathExists(configPath)) {
      return {
        config: defaultConfig(),
        diagnostics: [
          {
            code: 'MDL900',
            severity: 'error',
            message: `Config file not found: ${configPath}`,
          },
        ],
      };
    }
    return {
      config: defaultConfig(),
      diagnostics: [
        {
          code: 'MDL900',
          severity: 'error',
          message: `Cannot read configuration file ${configPath}: ${errorMessage(error)}`,
        },
      ],
    };
  }

  const doc = parseDocument(text);
  if (doc.errors.length > 0) {
    const first = doc.errors[0]!;
    return {
      config: defaultConfig(),
      diagnostics: [
        {
          code: 'MDL900',
          severity: 'error',
          message: `mdlineage.config.yaml is not valid YAML: ${first.message}`,
          range: lineColumnOf(null, first.pos[0] ?? 0),
        },
      ],
    };
  }

  const raw = doc.toJS() as Record<string, unknown>;
  const validate = configValidator();
  const ok = validate(raw);
  if (!ok) {
    const errors = validate.errors ?? [];
    return {
      config: defaultConfig(),
      diagnostics: errors.map((err) => configDiagnostic(err, configPath)),
    };
  }

  // `extends` resolves before `normalize`, so the file the caller named is
  // assembled from its presets first and interpreted once afterwards.
  const extended = applyExtends(raw, configPath);
  if (extended.diagnostics.length > 0) {
    return { config: defaultConfig(), diagnostics: extended.diagnostics };
  }

  return { config: normalize(extended.raw, configPath, extended.chain), diagnostics: [] };
}

/**
 * Organization presets (docs/remark-language-server-solution.md §7.5).
 *
 * `extends: [path|package]` names files whose keys this config inherits. The
 * presets are read, schema-validated and merged BEFORE the file itself is
 * interpreted, and the file's own keys win, which is the §7.5 rule "仓库可收紧
 * preset；放宽 error 级组织规则必须显式写出 override 和原因" made mechanical:
 * an override has to be written in the repository's own file to take effect.
 *
 * Merge is a deep overlay of plain data — arrays and scalars replace, maps
 * merge key by key — which is the whole of what the config schema permits, so
 * no merge rule can produce a shape the schema would reject.
 *
 * Resolution is a relative path (against the extending file's directory, so a
 * preset ships beside or above the configs that use it). A package name is
 * resolved as `node_modules/<name>/mdlineage.config.yaml`, which is the layout
 * a published preset will use; the resolved file is still only READ, never
 * executed (§15's allowlist boundary), so a preset cannot carry code.
 */
function applyExtends(
  raw: Readonly<Record<string, unknown>>,
  configPath: string,
  /** Files already being extended, for cycle detection across the whole chain. */
  ancestors: ReadonlySet<string> = new Set([configPath]),
): { raw: Readonly<Record<string, unknown>>; chain: string[]; diagnostics: ConfigDiagnostic[] } {
  const declared = raw['extends'];
  if (declared === undefined) return { raw, chain: [], diagnostics: [] };
  // The schema permits only a non-empty array of non-empty strings, so a value
  // that reaches here is already shape-valid; `extends: []` means "no presets".
  const names = (Array.isArray(declared) ? declared : []).filter((n): n is string => typeof n === 'string');
  if (names.length === 0) return { raw, chain: [], diagnostics: [] };

  const diagnostics: ConfigDiagnostic[] = [];
  const chain: string[] = [];
  /**
   * Every file the assembly has entered, including this one. A preset's own
   * presets see this set as their ancestors, so a cycle is caught at the link
   * that closes it no matter how deep the chain is.
   */
  const stack = new Set<string>(ancestors);

  let merged: Record<string, unknown> = {};

  for (const name of names) {
    const preset = resolvePresetPath(name, dirname(configPath));
    if (preset === null) {
      diagnostics.push({
        code: 'MDL900',
        severity: 'error',
        message: `Config file not found: ${name} (extended from ${configPath})`,
      });
      continue;
    }
    // A cycle is a hard refusal, not a silent depth limit: `a extends b extends
    // a` would otherwise merge the same files until the stack overflowed, and
    // the honest answer is that the configuration is not well-formed.
    if (stack.has(preset)) {
      diagnostics.push({
        code: 'MDL900',
        severity: 'error',
        message: `Circular extends: ${preset} is already being extended (${[...stack, preset].join(' → ')})`,
      });
      continue;
    }
    const withPreset = new Set(stack);
    withPreset.add(preset);
    try {
      const loaded = loadExtendsFile(preset, withPreset);
      chain.push(preset);
      for (const ancestor of loaded.chain) {
        // A preset's own presets are part of THIS file's assembly, and the
        // chain reports the whole assembly in load order.
        if (!chain.includes(ancestor)) chain.push(ancestor);
      }
      merged = deepMerge(merged, loaded.raw);
    } catch (error) {
      // `loadExtendsFile` reports its own MDL900 for the recoverable cases and
      // re-throws nothing; this is the catch-all for an unexpected throw, which
      // still must not take validation down with it.
      diagnostics.push({
        code: 'MDL900',
        severity: 'error',
        message: `Cannot read configuration file ${preset}: ${errorMessage(error)}`,
      });
    }
  }

  if (diagnostics.length > 0) return { raw, chain: [], diagnostics };

  // The file's own keys overlay the presets it named. `extends` itself is
  // dropped: the assembled config is one document, and carrying the chain
  // forward would make every downstream merge re-walk it.
  const { 'extends': _omit, ...own } = raw as Record<string, unknown>;
  return { raw: deepMerge(merged, own), chain, diagnostics: [] };
}

/**
 * Load one preset file: read, YAML-check, schema-check, then resolve ITS
 * `extends`. A failure throws with a message the caller wraps in MDL900, so
 * the diagnostics the caller reports name the file that is actually broken.
 *
 * `ancestors` is the set of files this preset is nested inside of, passed down
 * so a chain a → b → c refuses the moment c names a again instead of after
 * unwinding back to the top.
 */
function loadExtendsFile(
  path: string,
  ancestors: ReadonlySet<string>,
): { raw: Record<string, unknown>; chain: string[] } {
  const text = readFileSync(path, 'utf8');
  const doc = parseDocument(text);
  if (doc.errors.length > 0) {
    const first = doc.errors[0]!;
    throw new Error(`${path} is not valid YAML: ${first.message}`);
  }
  const raw = doc.toJS() as Record<string, unknown>;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${path} must contain a YAML mapping`);
  }
  const validate = configValidator();
  if (!validate(raw)) {
    const first = (validate.errors ?? [])[0] as { message?: string } | undefined;
    throw new Error(`${path} fails the config schema: ${first?.message ?? 'invalid configuration'}`);
  }

  if (raw['extends'] === undefined) return { raw, chain: [] };
  const extended = applyExtends(raw, path, ancestors);
  if (extended.diagnostics.length > 0) {
    // The chain is broken somewhere below; report it once, at the link the
    // caller can actually see.
    throw new Error(extended.diagnostics[0]!.message);
  }
  return { raw: extended.raw as Record<string, unknown>, chain: extended.chain };
}

/**
 * Where a preset name points.
 *
 * A name with a path separator, or one that is already absolute, is a path
 * resolved against the extending file's directory — the spelling a
 * repository-internal preset uses (`../presets/base.yaml`, `./mdlineage.base.yaml`).
 * A bare name is a package: `node_modules/<name>/mdlineage.config.yaml`, which
 * is the only layout a published preset can guarantee, and the only way to
 * name one without a path that depends on where the repository keeps its
 * configuration.
 */
function resolvePresetPath(name: string, baseDir: string): string | null {
  const isPath = name.startsWith('./') || name.startsWith('../') || name.startsWith('/') || name.includes(sep);
  const candidate = isPath ? resolve(baseDir, name) : resolve(baseDir, 'node_modules', name, 'mdlineage.config.yaml');
  try {
    if (!statSync(candidate).isFile()) return null;
  } catch {
    return null;
  }
  return candidate;
}

/**
 * Deep overlay of `overrides` on `base`, neither of which is mutated.
 *
 * Scalars and arrays REPLACE (a vocabulary the preset narrows is the preset's
 * vocabulary, not a union with the repository's); maps merge key by key so a
 * repository can override one relation type's switches without re-declaring the
 * other six. `undefined` values are dropped, so a key the overlay sets to
 * `undefined` cannot punch a hole in the base.
 */
function deepMerge(
  base: Readonly<Record<string, unknown>>,
  overrides: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) continue;
    const existing = out[key];
    out[key] =
      isPlainObject(existing) && isPlainObject(value)
        ? deepMerge(existing as Record<string, unknown>, value as Record<string, unknown>)
        : value;
  }
  return out;
}

/** True when `value` is a plain mapping (the only shape deepMerge recurses into). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** True when the path exists (file or directory). */
function pathExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Walk up from `from` until a mdlineage.config.yaml is found. */
function findConfig(from: string): string | null {
  let dir = resolve(from);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const candidate = resolve(dir, 'mdlineage.config.yaml');
    try {
      readFileSync(candidate);
      return candidate;
    } catch {
      // keep walking
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Turn an ajv error into a MDL900 config diagnostic. */
function configDiagnostic(err: unknown, configPath: string): ConfigDiagnostic {
  const e = err as {
    instancePath?: string;
    keyword?: string;
    message?: string;
    params?: Record<string, unknown>;
  };
  const at = e.instancePath ? ` at ${e.instancePath}` : '';
  return {
    code: 'MDL900',
    severity: 'error',
    message: `Configuration ${configPath} fails the config schema${at}: ${e.message ?? e.keyword}`,
  };
}

/** Line/column (1-based) of an offset inside the config document. */
function lineColumnOf(_doc: unknown, offset: number): { line: number; column: number } {
  return { line: 1, column: offset + 1 };
}

/** Validate the built-in default config against the config schema. Pure. */
export function defaultConfigIsValid(): boolean {
  return configValidator()(configToSchema(defaultConfig()));
}

/** Map a validated config document onto the Config the validator consumes. */
function normalize(raw: Readonly<Record<string, unknown>>, source: string, extendsChain: readonly string[] = []): Config {
  const base = defaultConfig();
  const files = (raw.files ?? {}) as Record<string, unknown>;
  const metadata = (raw.metadata ?? {}) as Record<string, unknown>;
  const vocabulary = (raw.vocabulary ?? {}) as Record<string, unknown>;
  const relations = (raw.relations ?? {}) as Record<string, unknown>;
  const diagnostics = (raw.diagnostics ?? {}) as Record<string, unknown>;

  return {
    ...base,
    configVersion: typeof raw.configVersion === 'number' ? raw.configVersion : 1,
    source,
    files: {
      include: Array.isArray(files.include) ? (files.include as string[]) : base.files.include,
      exclude: Array.isArray(files.exclude) ? (files.exclude as string[]) : base.files.exclude,
    },
    metadata: {
      key: typeof metadata.key === 'string' ? metadata.key : base.metadata.key,
      required: typeof metadata.required === 'boolean' ? metadata.required : base.metadata.required,
      preserveUnknownTopLevelFields:
        typeof metadata.preserveUnknownTopLevelFields === 'boolean'
          ? metadata.preserveUnknownTopLevelFields
          : base.metadata.preserveUnknownTopLevelFields,
      rejectUnknownMdlineageFields:
        typeof metadata.rejectUnknownMdlineageFields === 'boolean'
          ? metadata.rejectUnknownMdlineageFields
          : base.metadata.rejectUnknownMdlineageFields,
    },
    vocabulary: {
      kinds: Array.isArray(vocabulary.kinds) ? (vocabulary.kinds as string[]) : base.vocabulary.kinds,
      statuses: Array.isArray(vocabulary.statuses) ? (vocabulary.statuses as string[]) : base.vocabulary.statuses,
      authorities: Array.isArray(vocabulary.authorities) ? (vocabulary.authorities as string[]) : base.vocabulary.authorities,
    },
    relations: mergeRelationSwitches(relations, base.relations),
    diagnostics: mergeDiagnostics(diagnostics, base.diagnostics),
    // The schema enum guarantees validity; the guard keeps the cast honest if
    // a caller ever hands `normalize` an unvalidated document.
    eolPolicy:
      raw.eolPolicy === 'lf' || raw.eolPolicy === 'crlf' || raw.eolPolicy === 'cr'
        ? (raw.eolPolicy as EolPolicy)
        : base.eolPolicy,
    raw,
    extendsChain,
  };
}

/**
 * Overlay a config file's `relations` block on the built-in defaults.
 *
 * A type the file says nothing about keeps its default switches: the vocabulary
 * in docs/frontmatter-spec.md defines all seven types, and the schema only
 * permits those keys, so a partial `relations` block means "the rest stay as
 * shipped", not "the rest are unconfigured". Dropping them would silently
 * disable MDL304/MDL305 for every type the file omitted — a config that turns
 * off cycle detection by saying nothing about it.
 *
 * A type the file DOES name is taken in full: the file's entry is authoritative
 * for that type, so `overrides` replaces rather than merges.
 */
function mergeRelationSwitches(
  raw: Record<string, unknown>,
  defaults: Readonly<Record<string, RelationSwitch>>,
): Record<string, RelationSwitch> {
  const out: Record<string, RelationSwitch> = { ...defaults };
  for (const [type, overrides] of Object.entries(raw)) {
    if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) continue;
    out[type] = { ...(overrides as Record<string, unknown>) } as unknown as RelationSwitch;
  }
  return out;
}

/**
 * Overlay a config file's `diagnostics` block on the built-in defaults.
 *
 * The schema permits only registered codes as keys and only the four severities
 * as values, so an entry that reaches `normalize` is already schema-valid; it
 * overrides that code's severity and every other code keeps its default.
 */
function mergeDiagnostics(
  raw: Record<string, unknown>,
  defaults: Readonly<Record<string, 'error' | 'warning' | 'information' | 'hint'>>,
): Config['diagnostics'] {
  const out: Record<string, 'error' | 'warning' | 'information' | 'hint'> = { ...defaults };
  for (const [code, severity] of Object.entries(raw)) {
    if (
      severity === 'error' ||
      severity === 'warning' ||
      severity === 'information' ||
      severity === 'hint'
    ) {
      out[code] = severity;
    }
  }
  return out;
}

/** Pure helper: apply a config's severity overrides to a diagnostic code. */
export function resolveSeverity(config: Config, code: string): 'error' | 'warning' | 'information' | 'hint' {
  return config.diagnostics[code] ?? defaultSeverity(code);
}

const DEFAULT_SEVERITIES: Readonly<Record<string, 'error' | 'warning' | 'information' | 'hint'>> = {
  MDL001: 'error',
  MDL002: 'error',
  MDL003: 'error',
  MDL101: 'error',
  MDL102: 'error',
  MDL103: 'error',
  MDL104: 'error',
  MDL201: 'warning',
  MDL202: 'warning',
  MDL301: 'error',
  MDL302: 'error',
  MDL303: 'error',
  MDL304: 'warning',
  MDL305: 'error',
  MDL401: 'warning',
  MDL402: 'warning',
  MDL601: 'warning',
  MDL602: 'warning',
};

function defaultSeverity(code: string): 'error' | 'warning' | 'information' | 'hint' {
  return DEFAULT_SEVERITIES[code] ?? 'warning';
}

/** True when the config's vocabulary constrains a value. */
export function vocabularyAllows(config: Config, kind: 'kinds' | 'statuses' | 'authorities', value: unknown): boolean {
  const allowed = config.vocabulary[kind];
  if (!Array.isArray(allowed) || allowed.length === 0) return true;
  return allowed.includes(value as string);
}
