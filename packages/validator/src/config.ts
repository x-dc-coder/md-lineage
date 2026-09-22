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
import { dirname, resolve } from 'node:path';
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
 *     the line-ending policy (which comes from .gitattributes and the
 *     repository convention, not from a schema key) and bookkeeping.
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
  /** Line-ending policy. Not a schema key (docs/line-ending-management.md §4.1). */
  readonly eolPolicy: EolPolicy;
  /** The unparsed configuration object, for keys this version does not interpret. */
  readonly raw: Readonly<Record<string, unknown>> | null;
  /** Absolute path the config was loaded from, or null for built-in defaults. */
  readonly source: string | null;
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
 * `validateDocument`, which stays pure.
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

  return { config: normalize(raw, configPath), diagnostics: [] };
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
function normalize(raw: Readonly<Record<string, unknown>>, source: string): Config {
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
    raw,
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
