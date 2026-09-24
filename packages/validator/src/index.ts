/**
 * @mdlineage/validator — transport-independent MDLineage validation core.
 *
 * One pure function, `validateDocument`, runs the whole single-document rule
 * stack (docs/remark-language-server-solution.md §4):
 *
 *   eol-scan → frontmatter boundary → YAML → JSON Schema → document semantics
 *
 * Every layer is a pure function of the input; the module performs no IO, holds
 * no mutable global state, and never throws. The remark plugin, the CLI, the
 * LSP and the MCP server all call this function, which is how
 * §14.4's one-fixture-many-entries consistency promise is kept.
 *
 * Workspace-layer codes (MDL301 duplicate id, MDL302 unresolved target,
 * MDL305 forbidden cycle) and link-layer codes (MDL401/MDL402) need more than
 * one document and are therefore never produced here.
 */

import type { Root } from 'mdast';
import type { Config } from './config.js';
import { defaultConfig } from './config.js';
import type { Diagnostic } from './diagnostic.js';
import { severityOf, layerOf } from './diagnostic.js';
import { buildLineMap, rangeAt } from './source-map.js';
import { validateLineEndings } from './line-endings.js';
import { scanBoundary, parseFrontmatter } from './parse-frontmatter.js';
import { parseMarkdownSync } from './parse-markdown.js';
import { validateAgainstSchema } from './schema-validator.js';
import { relationOffsetsOf, validateDocumentSemantics } from './document-validator.js';
import type { ValidateInput, ValidateResult } from './index-types.js';

export type { Config, ConfigLoadResult, ConfigDiagnostic, EolPolicy } from './config.js';
export { defaultConfig, loadConfig, defaultConfigIsValid, resolveSeverity, vocabularyAllows } from './config.js';
export type { Diagnostic, DiagnosticLayer, Severity, Position, Range } from './diagnostic.js';
export { layerOf, severityOf, sortByRange } from './diagnostic.js';
export { buildLineMap, positionAt, rangeAt } from './source-map.js';
export type { LineMap, ResolvedRange } from './source-map.js';
export { scanLineEndings, validateLineEndings } from './line-endings.js';
export { scanBoundary, parseFrontmatter } from './parse-frontmatter.js';
export { parseMarkdown, parseMarkdownSync } from './parse-markdown.js';
export { getSchemaValidator, validateAgainstSchema, resolveErrorRange } from './schema-validator.js';
export { validateDocumentSemantics, relationOffsetsOf, mdlineageFieldOffset, collectAnchors, collectHeadingTexts, extractSamePageLinks } from './document-validator.js';
export { Slugger, slugifyHeading } from './slugger.js';
export type { ValidateInput, ValidateResult } from './index-types.js';
export type { WorkspaceIndex, DocEntry, DocPath, RelationEntry, LinkEntry, UpdateResult } from './workspace-index.js';
export {
  createWorkspaceIndex,
  updateFile,
  removeFile,
  updateFiles,
  resolveLinkPath,
  evidenceResolves,
} from './workspace-index.js';
export type { WorkspaceDiagnostic, ValidateWorkspaceOptions } from './workspace-validator.js';
export { validateWorkspace } from './workspace-validator.js';
export type { Baseline, BaselineParseResult, BaselineSuppressed } from './baseline.js';
export {
  BASELINE_FILE_NAME,
  BASELINE_VERSION,
  parseBaseline,
  baselineMatches,
  suppressWithBaseline,
  diffAgainstBaseline,
  writeBaseline,
  pruneBaseline,
} from './baseline.js';

/** The signature every adapter calls. Kept re-exported for the M2 CLI/LSP. */
export type { BoundaryScan, ParsedFrontmatter } from './parse-frontmatter.js';

/**
 * Validate one document. Pure: no IO, no network, no shared mutable state.
 *
 * The layers run in dependency order and accumulate: a YAML parse failure does
 * not stop the eol scan or the Markdown parse, but it does prevent the schema
 * and document-semantic layers from running, because there is no object to
 * validate. Produced diagnostics are sorted by offset.
 *
 * `validateDocument` is the documented async entry point; `validateDocumentSync`
 * does the same work without a promise because remark-parse is sync-parseable.
 */
export async function validateDocument(input: ValidateInput): Promise<ValidateResult> {
  return validateDocumentSync(input);
}

export function validateDocumentSync(input: ValidateInput): ValidateResult {
  const content = input.content;
  const config = input.config ?? defaultConfig();
  const lineMap = buildLineMap(content);
  const diagnostics: Diagnostic[] = [];

  // 1. Raw-buffer line-ending scan (before AST parsing, by design).
  diagnostics.push(
    ...validateLineEndings(content, lineMap, config.eolPolicy, config.diagnostics as Record<string, 'error' | 'warning' | 'information' | 'hint'>),
  );

  // 2. Front matter boundary scan (before remark-frontmatter, by design).
  const boundary = scanBoundary(content);
  const metadataKey = config.metadata.key;

  let frontmatter: Record<string, unknown> | null = null;
  let mdlineage: Record<string, unknown> | null = null;
  let mdlineageRange: { start: number; end: number } | null = null;
  let bodyStart = 0;

  if (boundary) {
    const rawStart = boundary.rawStart;
    if (boundary.closeStart === null) {
      // MDL001: the boundary scanner reports the unclosed block before YAML,
      // because remark-frontmatter would degrade it to ordinary text.
      diagnostics.push(
        mdl('MDL001', 'Front matter block is not closed', { start: 0, end: lineEnd(lineMap, 0) }, lineMap, config),
      );
    } else {
      bodyStart = boundary.closeStart;
      const parsed = parseFrontmatter(boundary.raw, rawStart, lineMap);
      if (parsed.error) {
        const at = { start: parsed.error.range.start.offset, end: parsed.error.range.end.offset };
        diagnostics.push(
          mdl('MDL002', `Front matter YAML could not be parsed: ${parsed.error.message}`, at, lineMap, config),
        );
      } else if (parsed.parsed) {
        frontmatter = parsed.parsed.data;
        mdlineageRange = keySourceRange(parsed.parsed.doc, metadataKey, rawStart);
        const value = frontmatter === null ? undefined : frontmatter[metadataKey];
        if (value !== undefined && value !== null) {
          if (typeof value === 'object' && !Array.isArray(value)) {
            mdlineage = value as Record<string, unknown>;
          } else {
            // A non-object mdlineage value fails the schema's type check; report
            // it here because there is nothing for ajv to walk.
            diagnostics.push(
              mdl(
                'MDL103',
                `Invalid type, pattern, or value at /${metadataKey}`,
                mdlineageRange ?? { start: rawStart, end: rawStart + 1 },
                lineMap,
                config,
              ),
            );
          }
        }
      }
    }
  }

  // 3. Missing-metadata check (suppressed entirely when metadata.required is
  // false, and when MDL001/MDL002 already explained why no metadata could be
  // extracted — one diagnostic per problem, per the registry's stability note).
  const frontmatterBroken = diagnostics.some((d) => d.code === 'MDL001' || d.code === 'MDL002');
  if (mdlineage === null && config.metadata.required && !frontmatterBroken) {
    const where = mdlineageRange ?? { start: 0, end: lineEnd(lineMap, 0) };
    diagnostics.push(
      mdl('MDL003', `Missing mdlineage metadata: no '${metadataKey}' key`, where, lineMap, config),
    );
  }

  // 4. JSON Schema (only when there is an object to validate).
  if (mdlineage !== null && boundary) {
    const parsed = parseFrontmatter(boundary.raw, boundary.rawStart, lineMap);
    if (parsed.parsed) {
      diagnostics.push(
        ...validateAgainstSchema(mdlineage, {
          rawStart: boundary.rawStart,
          lineMap,
          doc: parsed.parsed.doc,
          config,
          metadataKey,
          mdlineageRange,
        }),
      );
    }
  }

  // 5. Markdown parse (headings/anchors). Degrades to a diagnostic, never throws.
  let tree: Root | null = null;
  try {
    tree = parseMarkdownSync(bodyStart === 0 ? content : content.slice(bodyStart));
  } catch (error) {
    diagnostics.push(mdl('MDL900', `Markdown parse failed: ${errorMessage(error)}`, { start: 0, end: lineEnd(lineMap, 0) }, lineMap, config));
  }

  // 6. Document semantics.
  if (mdlineage !== null && boundary) {
    const parsed = parseFrontmatter(boundary.raw, boundary.rawStart, lineMap);
    const offsets = relationOffsetsOf(parsed.parsed?.doc ?? null, mdlineageRange?.start ?? boundary.rawStart);
    diagnostics.push(...validateDocumentSemantics(mdlineage, tree, lineMap, boundary.rawStart, offsets, config, bodyStart));
  }

  diagnostics.sort(byOffset);
  const layers = new Set<string>();
  for (const d of diagnostics) layers.add(d.layer);

  return { diagnostics, tree, frontmatter, bodyStart, layers };
}

function byOffset(a: Diagnostic, b: Diagnostic): number {
  return a.range.start.offset - b.range.start.offset || a.code.localeCompare(b.code);
}

/** Build a Diagnostic from a document-relative offset range. */
function mdl(
  code: string,
  message: string,
  range: { start: number; end: number },
  lineMap: ReturnType<typeof buildLineMap>,
  config: Config,
): Diagnostic {
  return {
    code,
    severity: severityOf(code, config.diagnostics as Record<string, 'error' | 'warning' | 'information' | 'hint'>),
    message,
    range: rangeAt(lineMap, range.start, range.end),
    layer: layerOf(code) ?? 'config',
  };
}

/** Offset just past the end of line `index` (0-based line index). */
function lineEnd(lineMap: ReturnType<typeof buildLineMap>, index: number): number {
  const next = lineMap.lineStarts[index + 1];
  return next === undefined ? lineMap.length : Math.max(1, next - 1);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Source range of the top-level metadata key, in document coordinates. */
function keySourceRange(
  doc: import('yaml').Document,
  key: string,
  rawStart: number,
): { start: number; end: number } | null {
  const contents = doc.contents as
    | {
        items?: Array<{
          key?: { value?: unknown; range?: readonly [number, number, number] };
          value?: { range?: readonly [number, number, number] };
        }>;
      }
    | null;
  if (!contents || !Array.isArray(contents.items)) return null;
  const pair = contents.items.find((p) => p.key?.value === key);
  if (!pair) return null;
  const range = pair.value?.range ?? pair.key?.range;
  if (!range) return null;
  return { start: rawStart + range[0], end: rawStart + range[1] };
}

