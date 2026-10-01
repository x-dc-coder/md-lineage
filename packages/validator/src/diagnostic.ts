/**
 * Diagnostic data model shared by every layer of the validator and by every
 * transport (remark plugin, CLI, LSP, MCP).
 *
 * Coordinate convention used throughout @mdlineage/validator:
 *   - `line`   is 1-based (the first line of a document is line 1).
 *   - `column` is 1-based (the first code unit of a line is column 1) and is
 *              measured in UTF-16 code units, which is what LSP `character`
 *              means. A surrogate pair counts as two columns.
 *   - `offset` is 0-based and counts UTF-16 code units from the start of the
 *              document, so `offset` values are directly comparable with the
 *              `position.offset` values mdast/yaml produce.
 *
 * These are the DOCUMENT-INTERNAL coordinates. Transport adapters convert them
 * to whatever their protocol means by "position" (LSP is 0-based, so adapters
 * subtract 1 from line and column).
 */

/** The five rule layers of docs/remark-language-server-solution.md §4. */
export type DiagnosticLayer =
  | 'eol-scan'
  | 'frontmatter-syntax'
  | 'schema'
  | 'document-semantic'
  | 'workspace-semantic'
  | 'link'
  | 'policy-layout'
  | 'config';

export type Severity = 'error' | 'warning' | 'information' | 'hint';

/** A point in a document, in the coordinate convention above. */
export interface Position {
  line: number;
  column: number;
  offset: number;
}

export interface Range {
  start: Position;
  end: Position;
}

/**
 * A single report. `data` carries everything a fixer or a downstream tool needs
 * (JSON Pointer, offending value, suggested replacement) without forcing
 * transports to re-parse the document.
 */
export interface Diagnostic {
  code: string;
  severity: Severity;
  message: string;
  range: Range;
  layer: DiagnosticLayer;
  data?: Record<string, unknown>;
}

/**
 * Severity defaults read from schemas/diagnostic-codes.json (§8.2: parse
 * failure, schema failure, duplicate ID, invalid target and forbidden relations
 * are errors; missing recommended reason, deprecated-document references and
 * suspicious relations are warnings). Kept in lockstep with the registry: no
 * code may appear here that is not registered there.
 */
const DEFAULT_SEVERITIES: Readonly<Record<string, Severity>> = {
  MDL001: 'error',
  MDL002: 'error',
  MDL003: 'error',
  MDL101: 'error',
  MDL102: 'error',
  MDL103: 'error',
  MDL104: 'error',
  MDL201: 'warning',
  MDL202: 'warning',
  MDL203: 'warning',
  MDL301: 'error',
  MDL302: 'error',
  MDL303: 'error',
  MDL304: 'warning',
  MDL305: 'error',
  MDL306: 'warning',
  MDL401: 'warning',
  MDL402: 'warning',
  MDL403: 'warning',
  MDL501: 'warning',
  MDL502: 'warning',
  MDL503: 'error',
  MDL504: 'warning',
  MDL505: 'warning',
  MDL601: 'warning',
  MDL602: 'warning',
  MDL801: 'warning',
};

const LAYERS: Readonly<Record<string, DiagnosticLayer>> = {
  MDL001: 'frontmatter-syntax',
  MDL002: 'frontmatter-syntax',
  MDL003: 'frontmatter-syntax',
  MDL101: 'schema',
  MDL102: 'schema',
  MDL103: 'schema',
  MDL104: 'schema',
  MDL201: 'document-semantic',
  MDL202: 'document-semantic',
  MDL203: 'document-semantic',
  MDL301: 'workspace-semantic',
  MDL302: 'workspace-semantic',
  MDL303: 'workspace-semantic',
  MDL304: 'workspace-semantic',
  MDL305: 'workspace-semantic',
  MDL306: 'workspace-semantic',
  MDL401: 'link',
  MDL402: 'link',
  MDL403: 'link',
  MDL501: 'policy-layout',
  MDL502: 'policy-layout',
  MDL503: 'policy-layout',
  MDL504: 'policy-layout',
  MDL505: 'policy-layout',
  MDL601: 'eol-scan',
  MDL602: 'eol-scan',
  MDL801: 'policy-layout',
};

/** Layer of a registered code; undefined for unregistered codes. */
export function layerOf(code: string): DiagnosticLayer | undefined {
  return LAYERS[code];
}

/**
 * Resolve a code's severity, applying an optional `diagnostics` override from
 * mdlineage.config.yaml. Unknown codes and unknown overrides are ignored: only
 * codes registered in schemas/diagnostic-codes.json may be produced.
 */
export function severityOf(code: string, overrides?: Record<string, Severity>): Severity {
  const registered = DEFAULT_SEVERITIES[code];
  if (registered === undefined) return 'warning';
  const override = overrides?.[code];
  return override ?? registered;
}

/** Order diagnostics by document position so transports emit stable output. */
export function sortByRange(a: Diagnostic, b: Diagnostic): number {
  return a.range.start.offset - b.range.start.offset || a.code.localeCompare(b.code);
}
