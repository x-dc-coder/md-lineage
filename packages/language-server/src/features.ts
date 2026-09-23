/**
 * §10.2 language features (docs/remark-language-server-solution.md).
 *
 * Everything here reads the `ServerContext` the server already maintains — the
 * same index a `didChange` just updated, the same config the scan was built
 * with — so a completion's target list cannot drift from the diagnostics the
 * developer is looking at. No feature owns a second copy of that state, and no
 * feature writes it: the only mutation path is `context.validateNow`, which a
 * code action calls after handing its TextEdits to the client.
 *
 * Context awareness for completion works on the document's own lines, not on
 * the parsed YAML object: a completion request arrives mid-keystroke, when the
 * YAML does not parse yet (`type: dep` is not a value any parser will hand
 * back). The rule is therefore lexical — find the enclosing field on the
 * cursor's line and the line's own prefix — which stays correct for the
 * unparseable buffer exactly the way §6.3 demands the unsaved buffer be used.
 *
 * Every handler returns null instead of an empty result where a client treats
 * an empty array as "no symbols here" and a null as "this server has no
 * answer"; both are sent over the wire by the same JSON-RPC path, and a client
 * that got [] for `textDocument/definition` would grey out the menu rather than
 * leave it alone.
 *
 * Never throws: a request against a document that is not in the index, a
 * position outside the front matter, or a YAML structure the validator rejected
 * all degrade to "no answer", never to a crashed connection. The diagnostics
 * already explain what is wrong with the document; a request failure would only
 * add noise.
 */

import {
  CompletionItemKind,
  InsertTextFormat,
  SymbolKind,
  CodeActionKind as Kind,
  DiagnosticSeverity,
  ResponseError,
  ErrorCodes,
  TextEdit,
  Location,
  DocumentSymbol,
  CodeAction,
  SymbolInformation,
} from 'vscode-languageserver-protocol';
import type {
  CompletionItem,
  CompletionList,
  CompletionParams,
  HoverParams,
  DefinitionParams,
  ReferenceParams,
  RenameParams,
  PrepareRenameParams,
  DocumentSymbolParams,
  WorkspaceSymbolParams,
  CodeActionParams,
  Hover,
  WorkspaceEdit,
  MarkupContent,
  Range as LspRange,
  Position as LspPosition,
} from 'vscode-languageserver-protocol';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseDocument } from 'yaml';
import {
  parseMarkdownSync,
  positionAt,
  scanBoundary,
  Slugger,
  type Config,
  type DocPath,
} from '@mdlineage/validator';
import type { ServerContext } from './server.js';
import { characterOf } from './position.js';

/** §10.2's relation vocabulary, with the meaning frontmatter-spec carries. */
const RELATION_MEANINGS: Readonly<Record<string, string>> = {
  depends_on: 'The source document relies on a rule or fact in the target.',
  implements: 'The source documents an implementation of the target.',
  refines: 'The source narrows or adds conditions to the target.',
  supersedes: 'The source replaces the target as the current guidance.',
  contradicts: 'The documents contain claims that appear incompatible.',
  example_of: 'The source is an example of the target concept.',
  related_to: 'A broad topical relationship.',
};

/** The mdlineage fields a document may carry, in the spec's order. */
const MDLINEAGE_FIELDS: ReadonlyArray<{ name: string; doc: string }> = [
  { name: 'schema', doc: 'Metadata schema version (v1: 1).' },
  { name: 'id', doc: 'Stable repository-wide document identifier; must match ^[a-z0-9]+(?:[.-][a-z0-9]+)*$.' },
  { name: 'kind', doc: 'Repository-defined document category (vocabulary.kinds).' },
  { name: 'status', doc: 'Lifecycle state (vocabulary.statuses).' },
  { name: 'authority', doc: 'Source-of-truth designation (vocabulary.authorities).' },
  { name: 'topics', doc: 'Concise human-readable concepts for filtering and discovery.' },
  { name: 'aliases', doc: 'Alternate names, abbreviations, or search terms.' },
  { name: 'relations', doc: 'Confirmed typed relationships to other stable document IDs.' },
];

const ID_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;

/**
 * Register every §10.2 handler on the connection. Called as the default hook;
 * see `ServerHooks.register`.
 */
export function registerLanguageFeatures(context: ServerContext): void {
  const { connection } = context;
  connection.onCompletion((params) => completions(context, params));
  connection.onHover((params) => hover(context, params));
  connection.onDefinition((params) => definition(context, params));
  connection.onReferences((params) => references(context, params));
  connection.onPrepareRename((params) => prepareRename(context, params));
  connection.onRenameRequest((params) => rename(context, params));
  connection.onDocumentSymbol((params) => documentSymbols(context, params));
  connection.onWorkspaceSymbol((params) => workspaceSymbols(context, params));
  connection.onCodeAction((params) => codeActions(context, params));
}

/* ------------------------------------------------------------------ *
 * Document access helpers
 * ------------------------------------------------------------------ */

/** The absolute path of a request's document, or null when not under `file:`. */
function requestPath(_context: ServerContext, params: { textDocument: { uri: string } }): DocPath | null {
  return uriToPathOrNull(params.textDocument.uri);
}

function uriToPathOrNull(uri: string): string | null {
  if (!uri.startsWith('file:')) return null;
  try {
    return fileURLToPath(uri);
  } catch {
    return null;
  }
}

/** The document's current text (overlay first), or null when unavailable. */
function textOf(context: ServerContext, path: DocPath): string | null {
  return context.resolveText(path);
}

/** 0-based line table of a document string, CRLF-aware (mirrors buildLineMap). */
function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

/** Offset of the start of 0-based `line`, or the document's length past the end. */
function lineStartOffset(lines: ReadonlyArray<string>, line: number): number {
  // The LSP line index counts line breaks, so a CRLF pair is one break; the
  // offset table is rebuilt from the same split to keep the two in step.
  let offset = 0;
  for (let i = 0; i < line && i < lines.length; i++) offset += lines[i]!.length + 1;
  return offset;
}

/**
 * The mdlineage block's own line range (0-based), or null when the document
 * carries no front matter at all.
 */
function mdlineageRange(text: string, lines: ReadonlyArray<string>): { start: number; end: number } | null {
  const boundary = scanBoundary(text);
  if (!boundary || boundary.closeStart === null) return null;
  // The closing marker's line index is the count of line breaks before it.
  const start = positionAt({ lineStarts: lineStartTable(text), length: text.length }, boundary.rawStart).line - 1;
  const closeLine = positionAt({ lineStarts: lineStartTable(text), length: text.length }, boundary.closeStart).line - 1;
  void lines;
  return { start, end: closeLine };
}

/** Line-start offsets of a document (the validator's own line-map shape). */
function lineStartTable(text: string): readonly number[] {
  const starts: number[] = [0];
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x0a) {
      starts.push(i + 1);
    } else if (c === 0x0d) {
      if (text.charCodeAt(i + 1) === 0x0a) {
        starts.push(i + 2);
        i += 1;
      } else {
        starts.push(i + 1);
      }
    }
  }
  return starts;
}

/**
 * The YAML key the cursor is inside, and the text already typed after it.
 *
 * `  target: docs.fo|` yields `{ field: 'target', prefix: 'docs.fo', atValue: true }`.
 * A cursor on the key itself (`  tar|get:`) yields `{ field: null, prefix: 'tar' }`,
 * which is the "field name" context. A line that carries no `:` before the
 * cursor (a continuation of a list item, or prose) yields null.
 */
interface CursorContext {
  /** The enclosing mdlineage field name, lowercase as authored. */
  field: string | null;
  /** The text between the `:` (or the line start) and the cursor. */
  prefix: string;
  /** True when the cursor is to the right of the field's `:`. */
  atValue: boolean;
  /** 0-based line and character of the cursor. */
  line: number;
  character: number;
}

function cursorContext(text: string, position: LspPosition): CursorContext | null {
  const lines = splitLines(text);
  if (position.line < 0 || position.line >= lines.length) return null;
  const line = lines[position.line]!;
  const upto = line.slice(0, Math.min(position.character, line.length));

  // The front matter block is where mdlineage fields live; outside it the
  // cursor is prose, and there is nothing mdlineage-specific to complete.
  const block = mdlineageRange(text, lines);
  if (block === null || position.line < block.start || position.line > block.end) return null;

  const colon = upto.lastIndexOf(':');
  if (colon < 0) {
    // A list item continuation (`    - type: x` typed as `    -`) or a bare
    // key being typed. Treat it as the field-name context.
    return { field: null, prefix: upto.trim(), atValue: false, line: position.line, character: position.character };
  }
  const beforeColon = line.slice(0, colon);
  const keyMatch = /\b([A-Za-z_][A-Za-z0-9_-]*)\s*$/.exec(beforeColon);
  // `- type: value` has the relation key as the last identifier before ':'.
  const field = keyMatch ? keyMatch[1]!.toLowerCase() : null;
  const prefix = upto.slice(colon + 1);
  return { field, prefix: prefix.trim(), atValue: colon < position.character, line: position.line, character: position.character };
}

/* ------------------------------------------------------------------ *
 * Completion (§10.2: "Completion：字段、枚举、relation type、target ID、evidence anchor")
 * ------------------------------------------------------------------ */

function completions(context: ServerContext, params: CompletionParams): CompletionList | CompletionItem[] | null {
  const path = requestPath(context, params);
  if (path === null) return null;
  const text = textOf(context, path);
  if (text === null) return null;
  const cursor = cursorContext(text, params.position);
  if (cursor === null) return null;

  const config = context.config;
  const items: CompletionItem[] = [];

  if (cursor.atValue) {
    switch (cursor.field) {
      case 'type':
        items.push(...relationTypeItems(config, cursor.prefix));
        break;
      case 'target':
        items.push(...targetItems(context, cursor.prefix));
        break;
      case 'evidence':
        items.push(...evidenceItems(context, path, cursor.prefix, params.position));
        break;
      case 'kind':
      case 'status':
      case 'authority':
        items.push(...vocabularyItems(config, cursor.field, cursor.prefix));
        break;
      default:
        // A value position of a field with no fixed vocabulary (reason, id,
        // topics) has nothing to suggest; the schema's own diagnostics are the
        // guidance there.
        return null;
    }
  } else {
    // A key position: the mdlineage fields, filtered by what was typed.
    items.push(...fieldItems(cursor.prefix));
  }

  if (items.length === 0) return null;
  // `isIncomplete` false: every list below is the whole answer for its
  // context, so the client does not re-request on further typing inside the
  // same field.
  return { isIncomplete: false, items };
}

/** Relation types from the config's vocabulary, with their documented meaning. */
function relationTypeItems(config: Config, prefix: string): CompletionItem[] {
  return Object.keys(config.relations)
    .filter((type) => type.startsWith(prefix))
    .map((type, index) => ({
      label: type,
      kind: CompletionItemKind.EnumMember,
      detail: RELATION_MEANINGS[type] ?? 'Configured relation type.',
      documentation: RELATION_MEANINGS[type] ?? undefined,
      // A stable order keeps the client's menu from shuffling as the prefix
      // grows, and `sortText` overrides the client's alphabetical default.
      sortText: String(index).padStart(3, '0'),
      insertText: type,
      insertTextFormat: InsertTextFormat.PlainText,
    }));
}

/** Every known document id, with its path and status as the detail line. */
function targetItems(context: ServerContext, prefix: string): CompletionItem[] {
  const items: CompletionItem[] = [];
  for (const id of context.index.ids()) {
    if (!id.startsWith(prefix)) continue;
    const paths = context.index.idToPaths(id);
    const first = paths[0];
    const status = first ? context.index.entryOf(first)?.id : null;
    void status;
    items.push({
      label: id,
      kind: CompletionItemKind.Reference,
      detail:
        paths.length === 1
          ? `${shortPath(context, paths[0]!)} · ${documentStatus(context, paths[0]!)}`
          : `${paths.length} documents · ambiguous (MDL301)`,
      sortText: id,
      insertText: id,
      insertTextFormat: InsertTextFormat.PlainText,
    });
  }
  return items.slice(0, 500);
}

/** A path spelled the way the developer reads it: relative to the root. */
function shortPath(context: ServerContext, path: DocPath): string {
  const root = context.rootPath;
  if (path.startsWith(root + '/') || path.startsWith(root + '\\')) return path.slice(root.length + 1);
  return path;
}

/** The document's status, for the detail line of a target completion. */
function documentStatus(context: ServerContext, path: DocPath): string {
  const entry = context.index.entryOf(path);
  if (!entry) return 'unknown';
  const mdlineage = frontmatterOf(context, path);
  const status = typeof mdlineage?.['status'] === 'string' ? (mdlineage['status'] as string) : null;
  if (entry.id === null) return 'no id';
  return status ?? 'unknown status';
}

/** The parsed mdlineage object of a document, from its own (possibly dirty) text. */
function frontmatterOf(context: ServerContext, path: DocPath): Record<string, unknown> | null {
  const text = textOf(context, path);
  if (text === null) return null;
  return extractMdlineage(context.config, text);
}

/**
 * The mdlineage object of a document string. Kept here because the index's own
 * entry stores the derived views, not the raw object a completion needs to read
 * a partially-typed `status:` from.
 */
function extractMdlineage(config: Config, text: string): Record<string, unknown> | null {
  const boundary = scanBoundary(text);
  if (!boundary || boundary.closeStart === null) return null;
  // A YAML failure is the schema layer's diagnostic, not a completion's; the
  // partial parse is what completion is for, so a throw is swallowed and the
  // caller falls back to "no context".
  try {
    const value = parsePartialYaml(boundary.raw, config.metadata.key);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Read the mdlineage object out of a front matter slice, tolerating the
 * unparseable tail a mid-typing buffer always has.
 *
 * `yaml`'s parser stops at the first error and hands back what it decoded so
 * far (its CST keeps every node it closed), which is exactly the shape
 * completion needs: `type: dep|` parses as a map with a `type` key whose value
 * is a broken scalar, and the caller reads the key, not the value.
 */
function parsePartialYaml(raw: string, metadataKey: string): unknown {
  const doc = parseDocument(raw, { keepSourceTokens: true });
  const js = doc.toJS();
  if (js === null || typeof js !== 'object' || Array.isArray(js)) return null;
  return (js as Record<string, unknown>)[metadataKey] ?? null;
}

/** Vocabulary enums for `kind:` / `status:` / `authority:` values. */
function vocabularyItems(config: Config, field: 'kind' | 'status' | 'authority', prefix: string): CompletionItem[] {
  const list = config.vocabulary[field === 'kind' ? 'kinds' : field === 'status' ? 'statuses' : 'authorities'] ?? [];
  return list
    .filter((value) => value.startsWith(prefix))
    .map((value) => ({
      label: value,
      kind: CompletionItemKind.EnumMember,
      detail: `${field} (vocabulary)`,
      sortText: value,
      insertText: value,
      insertTextFormat: InsertTextFormat.PlainText,
    }));
}

/** Field names at the mdlineage block's top level. */
function fieldItems(prefix: string): CompletionItem[] {
  return MDLINEAGE_FIELDS.filter((f) => f.name.startsWith(prefix.toLowerCase())).map((f, index) => ({
    label: f.name,
    kind: CompletionItemKind.Field,
    detail: 'mdlineage field',
    documentation: f.doc,
    sortText: String(index).padStart(3, '0'),
    // A trailing `: ` puts the cursor at the value, which is where the
    // vocabulary completion above takes over.
    insertText: `${f.name}: `,
    insertTextFormat: InsertTextFormat.PlainText,
  }));
}

/**
 * Anchors of the target the cursor's relation points at (§10.2:
 * "evidence anchor").
 *
 * The anchor set belongs to the TARGET document, not the current one
 * (frontmatter-spec: "The anchor is resolved against the relation's `target`
 * document"), so the relation list is read first and the enclosing relation is
 * the one whose block the cursor sits in.
 */
function evidenceItems(
  context: ServerContext,
  path: DocPath,
  prefix: string,
  position: LspPosition,
): CompletionItem[] {
  const entry = context.index.entryOf(path);
  if (!entry) return [];
  const relation = enclosingRelation(context, path, position);
  if (relation === null) return [];
  // The prefix carries whatever quote and `#` the developer has typed, so the
  // match is against the anchor itself (`"#cac|` → `cache-key`).
  const anchorPrefix = prefix.replace(/^["']?#?/, '');
  const targets = context.index.idToPaths(relation.target);
  if (targets.length !== 1) return [];
  const anchors = context.index.anchorsOf(targets[0]!);
  const items: CompletionItem[] = [];
  for (const anchor of anchors) {
    if (!anchor.startsWith(anchorPrefix)) continue;
    items.push({
      label: `#${anchor}`,
      kind: CompletionItemKind.Reference,
      detail: `heading of ${shortPath(context, targets[0]!)}`,
      sortText: anchor,
      insertText: `"#${anchor}"`,
      insertTextFormat: InsertTextFormat.PlainText,
    });
  }
  return items;
}

/**
 * The relation entry whose YAML block contains the cursor, by offset.
 *
 * The index's `offsets` give each relation its own start offset, so the
 * enclosing relation is the last one that starts at or before the cursor — and
 * the cursor belongs to the NEXT relation's block once it moves past it, which
 * is what makes "enclosing" decidable without parsing the broken tail.
 */
function enclosingRelation(
  context: ServerContext,
  path: DocPath,
  position: LspPosition | null,
): { type: string; target: string } | null {
  const entry = context.index.entryOf(path);
  if (!entry) return null;
  const text = textOf(context, path);
  if (text === null) return null;
  const at = position === null ? Infinity : positionOf(text, position);
  let found: { type: string; target: string } | null = null;
  entry.relations.forEach((rel, index) => {
    const where = entry.offsets.relationStart(index);
    if (where === undefined) return;
    if (entry.rawStart + where > at) return;
    found = rel;
  });
  return found;
}

/** The absolute document offset of an LSP position (0-based line/character). */
function positionOf(text: string, position: LspPosition): number {
  const lines = splitLines(text);
  return lineStartOffset(lines, position.line) + position.character;
}

/* ------------------------------------------------------------------ *
 * Hover (§10.2: "Hover：字段文档、目标文件、关系方向及状态")
 * ------------------------------------------------------------------ */

function hover(context: ServerContext, params: HoverParams): Hover | null {
  const path = requestPath(context, params);
  if (path === null) return null;
  const text = textOf(context, path);
  if (text === null) return null;
  const cursor = cursorContext(text, params.position);
  if (cursor === null || !cursor.atValue) return null;

  const word = wordAt(text, params.position);
  if (word === null) return null;

  if (cursor.field === 'type') {
    const meaning = RELATION_MEANINGS[word];
    if (meaning === undefined) return null;
    return hoverText(`Relation type \`${word}\``, meaning, text, params.position);
  }
  if (cursor.field === 'target' || cursor.field === 'id') {
    const targets = context.index.idToPaths(word);
    if (targets.length === 0) return null;
    const body =
      targets.length === 1
        ? `${shortPath(context, targets[0]!)} · ${documentStatus(context, targets[0]!)}`
        : targets.map((p) => `${shortPath(context, p)} (${documentStatus(context, p)})`).join('\n');
    return hoverText(`Document \`${word}\``, body, text, params.position);
  }
  return null;
}

function hoverText(title: string, body: string, text: string, position: LspPosition): Hover {
  const content: MarkupContent = { kind: 'markdown', value: `**${title}**\n\n${body}` };
  const range = wordRange(text, position);
  return range === null ? { contents: content } : { contents: content, range };
}

/** The word (identifier-ish run) under the cursor, or null. */
function wordAt(text: string, position: LspPosition): string | null {
  const lines = splitLines(text);
  if (position.line < 0 || position.line >= lines.length) return null;
  const line = lines[position.line]!;
  const at = Math.min(position.character, line.length);
  if (at === 0) return null;
  // A cursor just past the word's last character still hovers the word, which
  // is how a developer places it after typing the value in full.
  const left = line.slice(0, at);
  const right = line.slice(at);
  const startMatch = /[A-Za-z0-9._-]*$/.exec(left);
  const endMatch = /^[A-Za-z0-9._-]*/.exec(right);
  const word = `${startMatch ? startMatch[0] : ''}${endMatch ? endMatch[0] : ''}`;
  return word.length > 0 ? word : null;
}

/** The LSP range of the word under the cursor, for the hover highlight. */
function wordRange(text: string, position: LspPosition): LspRange | null {
  const lines = splitLines(text);
  if (position.line < 0 || position.line >= lines.length) return null;
  const line = lines[position.line]!;
  const at = Math.min(position.character, line.length);
  const left = line.slice(0, at);
  const startMatch = /[A-Za-z0-9._-]*$/.exec(left);
  const start = startMatch ? at - startMatch[0].length : at;
  const endMatch = /^[A-Za-z0-9._-]*/.exec(line.slice(at));
  const end = at + (endMatch ? endMatch[0].length : 0);
  if (end === start) return null;
  return {
    start: { line: position.line, character: start },
    end: { line: position.line, character: end },
  };
}

/* ------------------------------------------------------------------ *
 * Definition (§10.2: "Go to Definition：target ID 或链接跳转")
 * ------------------------------------------------------------------ */

function definition(context: ServerContext, params: DefinitionParams): Location | Location[] | null {
  const path = requestPath(context, params);
  if (path === null) return null;
  const text = textOf(context, path);
  if (text === null) return null;
  const cursor = cursorContext(text, params.position);
  if (cursor === null || !cursor.atValue) return null;

  const word = wordAt(text, params.position);
  if (word === null) return null;

  if (cursor.field === 'target' || cursor.field === 'id') {
    // A `target:` value jumps to the target document's id declaration line.
    const locations = idDeclarationLocations(context, word);
    return locations.length > 0 ? locations : null;
  }
  if (cursor.field === 'evidence') {
    // An `evidence:` anchor jumps to the target document's heading. The target
    // is the enclosing relation's, read from the index's derived edges.
    const anchor = word.startsWith('#') ? word.slice(1) : word;
    const location = anchorDefinition(context, path, anchor, params.position);
    return location === null ? null : [location];
  }
  return null;
}

/** Where `id` is declared, in every document that claims it. */
function idDeclarationLocations(context: ServerContext, id: string): Location[] {
  const out: Location[] = [];
  for (const targetPath of context.index.idToPaths(id)) {
    const entry = context.index.entryOf(targetPath);
    if (!entry) continue;
    const lineMap = { lineStarts: lineStartTableOfEntry(entry), length: entry.lineMap.length };
    const at = positionAt(lineMap, entry.idOffset);
    out.push(locationOf(context, targetPath, at.line, at.column));
  }
  return out;
}

function lineStartTableOfEntry(entry: { lineMap: { lineStarts: readonly number[] } }): readonly number[] {
  return entry.lineMap.lineStarts;
}

/**
 * The heading an evidence anchor names, in the relation's target document.
 *
 * The index's anchor set is a membership set, so the heading's line is found by
 * re-parsing the target's body and matching the slug — one walk per request,
 * which is what a jump-to-definition budget allows and what the index chose not
 * to store (it keeps anchors as a Set, not as lines, for MDL402's predicate).
 */
function anchorDefinition(
  context: ServerContext,
  path: DocPath,
  anchor: string,
  position: LspPosition,
): Location | null {
  const entry = context.index.entryOf(path);
  if (!entry) return null;
  // The anchor resolves against the relation the cursor sits in: with several
  // relations the first evidence-carrying one may target a different document.
  const relation = enclosingRelation(context, path, position);
  if (relation === null) return null;
  const targets = context.index.idToPaths(relation.target);
  if (targets.length !== 1) return null;
  const targetPath = targets[0]!;
  const targetText = textOf(context, targetPath);
  if (targetText === null) return null;
  const found = headingLineOf(targetText, anchor);
  if (found === null) return null;
  return locationOf(context, targetPath, found.line, found.column);
}

/** The 1-based line/column of the heading whose GFM slug is `anchor`. */
function headingLineOf(text: string, anchor: string): { line: number; column: number } | null {
  const boundary = scanBoundary(text);
  const bodyStart = bodyStartOf(boundary);
  if (bodyStart === null) return null;
  const tree = parseMarkdownSync(text.slice(bodyStart));
  if (!tree) return null;
  const slugger = new Slugger();
  for (const child of tree.children) {
    if (child.type !== 'heading') continue;
    const slug = slugger.slug(headingText(child));
    if (slug === anchor) {
      const offset = bodyStart + (child.position?.start?.offset ?? 0);
      const at = positionAt({ lineStarts: lineStartTable(text), length: text.length }, offset);
      return { line: at.line, column: at.column };
    }
  }
  return null;
}

/** The offset just past the closing front matter marker (null: no front matter). */
function bodyStartOf(boundary: { closeStart: number | null } | null): number | null {
  if (!boundary || boundary.closeStart === null) return null;
  return boundary.closeStart + 4;
}

/** Concatenated text of a heading, matching the anchor slugger's own input. */
function headingText(node: { children?: unknown[] }): string {
  let out = '';
  collectText(node, (chunk) => {
    out += chunk;
  });
  return out;
}

function collectText(node: unknown, push: (text: string) => void): void {
  if (!node || typeof node !== 'object') return;
  const n = node as { type?: string; value?: string; children?: unknown[] };
  if (n.type === 'text' && typeof n.value === 'string') push(n.value);
  if ((n.type === 'code' || n.type === 'inlineCode') && typeof n.value === 'string') push(n.value);
  if (Array.isArray(n.children)) for (const child of n.children) collectText(child, push);
}

/* ------------------------------------------------------------------ *
 * References (§10.2: "Find References：查找对 ID、文件、标题的引用")
 * ------------------------------------------------------------------ */

function references(context: ServerContext, params: ReferenceParams): Location[] | null {
  const path = requestPath(context, params);
  if (path === null) return null;
  const text = textOf(context, path);
  if (text === null) return null;
  const cursor = cursorContext(text, params.position);
  if (cursor === null || !cursor.atValue) return null;
  const word = wordAt(text, params.position);
  if (word === null) return null;

  // An id declaration's references are every document whose relation points at
  // it — the index's reverse map, which is exactly §10.3's "更新反向引用".
  if (cursor.field === 'id' || cursor.field === 'target') {
    const id = cursor.field === 'id' ? word : resolveTargetId(context, path, word);
    if (id === null) return null;
    const out: Location[] = [];
    // The declaration itself, first: `referrersOf` only lists documents whose
    // relations point at the id, so the declaring document — which carries the
    // id the developer asked about — is added here when the client asked for
    // it (`includeDeclaration`), which is the LSP's own toggle.
    if (params.context.includeDeclaration) {
      for (const declaring of context.index.idToPaths(id)) {
        const entry = context.index.entryOf(declaring);
        if (!entry) continue;
        const at = positionAt({ lineStarts: entry.lineMap.lineStarts, length: entry.lineMap.length }, entry.idOffset);
        out.push(locationOf(context, declaring, at.line, at.column));
      }
    }
    for (const referrer of context.index.referrersOf(id)) {
      const entry = context.index.entryOf(referrer);
      if (!entry) continue;
      out.push(...relationLocations(context, referrer, id));
    }
    return out.length > 0 ? out : null;
  }
  return null;
}

/** The id a `target:` value resolves to, from the index's derived edges. */
function resolveTargetId(context: ServerContext, path: DocPath, target: string): string | null {
  const entry = context.index.entryOf(path);
  if (!entry) return null;
  const rel = entry.relations.find((r) => r.target === target);
  if (rel) return rel.target;
  return target;
}

/** Where the relations of `referrer` name `id`, positioned on the declaration. */
function relationLocations(context: ServerContext, referrer: DocPath, id: string): Location[] {
  const entry = context.index.entryOf(referrer);
  if (!entry) return [];
  const lineMap = { lineStarts: entry.lineMap.lineStarts, length: entry.lineMap.length };
  const out: Location[] = [];
  entry.relations.forEach((rel, index) => {
    if (rel.target !== id) return;
    const where = entry.offsets.relationStart(index) ?? entry.offsets.mdlineageStart;
    const at = positionAt(lineMap, entry.rawStart + where);
    out.push(locationOf(context, referrer, at.line, at.column));
  });
  return out;
}

/* ------------------------------------------------------------------ *
 * Rename (§10.2: "Rename：以 WorkspaceEdit 安全重命名 ID 并更新引用")
 * ------------------------------------------------------------------ */

function prepareRename(context: ServerContext, params: PrepareRenameParams): LspRange | { range: LspRange; placeholder: string } | null {
  const path = requestPath(context, params);
  if (path === null) return null;
  const text = textOf(context, path);
  if (text === null) return null;
  const cursor = cursorContext(text, params.position);
  // Only an id declaration is renamable: a `target:` value is another
  // document's id, and renaming it here would orphan the real one.
  if (cursor === null || !cursor.atValue || cursor.field !== 'id') return null;
  const range = wordRange(text, params.position);
  if (range === null) return null;
  const placeholder = wordAt(text, params.position);
  return placeholder === null ? range : { range, placeholder };
}

function rename(context: ServerContext, params: RenameParams): WorkspaceEdit | null {
  const path = requestPath(context, params);
  if (path === null) return null;
  const text = textOf(context, path);
  if (text === null) return null;
  const cursor = cursorContext(text, params.position);
  if (cursor === null || !cursor.atValue || cursor.field !== 'id') return null;
  const oldId = wordAt(text, params.position);
  if (oldId === null) return null;

  // §9.2: "生成或修改稳定 id" is only ever a suggestion. The request is
  // answered with a WorkspaceEdit the client applies after the user confirms;
  // an id that breaks the v1 pattern is refused with an error instead, because
  // applying it would produce MDL103 in every file it touched.
  if (!ID_PATTERN.test(params.newName)) {
    throw new ResponseError(ErrorCodes.InvalidParams, `Invalid mdlineage id '${params.newName}': must match ^[a-z0-9]+(?:[.-][a-z0-9]+)*$`);
  }
  // Renaming onto an id another document already claims would fabricate
  // MDL301 in every touched file the moment the edit lands; the same
  // ResponseError contract as a broken pattern applies.
  const claimants = context.index.idToPaths(params.newName);
  if (claimants.length > 0) {
    throw new ResponseError(
      ErrorCodes.InvalidParams,
      `mdlineage id '${params.newName}' is already claimed by ${claimants.join(', ')}`,
    );
  }

  const changes: Record<string, TextEdit[]> = {};
  const addEdit = (targetPath: DocPath, edit: TextEdit): void => {
    const key = pathToUriOf(context, targetPath);
    const list = changes[key] ?? [];
    list.push(edit);
    changes[key] = list;
  };

  // The declaration itself: the id value, replaced in place.
  const entry = context.index.entryOf(path);
  if (entry) {
    const at = positionAt({ lineStarts: entry.lineMap.lineStarts, length: entry.lineMap.length }, entry.idOffset);
    const lines = splitLines(text);
    const lineText = lines[at.line - 1] ?? '';
    const valueStart = characterOf(lineText, at.column);
    const valueEnd = valueStart + oldId.length;
    addEdit(path, TextEdit.replace(
      { start: { line: at.line - 1, character: valueStart }, end: { line: at.line - 1, character: valueEnd } },
      params.newName,
    ));
  }

  // Every referrer's `target:` value, replaced where it is authored.
  for (const referrer of context.index.referrersOf(oldId)) {
    const referrerEntry = context.index.entryOf(referrer);
    if (!referrerEntry) continue;
    const refText = textOf(context, referrer);
    const lineMap = { lineStarts: referrerEntry.lineMap.lineStarts, length: referrerEntry.lineMap.length };
    const refLines = refText === null ? [] : splitLines(refText);
    referrerEntry.relations.forEach((rel, index) => {
      if (rel.target !== oldId) return;
      const where = referrerEntry.offsets.relationField(index, 'target') ?? referrerEntry.offsets.relationStart(index) ?? referrerEntry.offsets.mdlineageStart;
      const at = positionAt(lineMap, referrerEntry.rawStart + where);
      const lineText = refLines[at.line - 1] ?? '';
      const start = characterOf(lineText, at.column);
      addEdit(referrer, TextEdit.replace(
        { start: { line: at.line - 1, character: start }, end: { line: at.line - 1, character: start + oldId.length } },
        params.newName,
      ));
    });
  }

  return { changes };
}

/* ------------------------------------------------------------------ *
 * Document symbols (§10.2: "Document Symbols：标题和元数据结构")
 * ------------------------------------------------------------------ */

function documentSymbols(context: ServerContext, params: DocumentSymbolParams): DocumentSymbol[] | null {
  const path = requestPath(context, params);
  if (path === null) return null;
  const text = textOf(context, path);
  if (text === null) return null;

  const symbols: DocumentSymbol[] = [];
  const boundary = scanBoundary(text);
  const bodyStart = bodyStartOf(boundary);

  // The mdlineage block as one parent symbol, with each authored field as a
  // child: an editor's outline then reads like the document's own structure.
  const block = mdlineageRange(text, splitLines(text));
  if (block !== null) {
    const fields = extractMdlineage(context.config, text);
    const children: DocumentSymbol[] = [];
    if (fields) {
      for (const { name, doc } of MDLINEAGE_FIELDS) {
        if (!(name in fields)) continue;
        const line = fieldLine(text, block.start, name);
        if (line === null) continue;
        children.push(
          DocumentSymbol.create(
            name,
            doc,
            name === 'relations' ? SymbolKind.Array : SymbolKind.Field,
            lineRange(line, text),
            lineRange(line, text),
          ),
        );
      }
    }
    symbols.push(
      DocumentSymbol.create(
        'mdlineage',
        context.index.entryOf(path)?.id ?? undefined,
        SymbolKind.Object,
        lineRange(block.start, text),
        lineRange(block.start, text),
        children,
      ),
    );
  }

  // Headings, from the body's own tree. Their mdast offsets are body-relative,
  // so `bodyStart` shifts them back onto the document before line lookup.
  if (bodyStart !== null) {
    const tree = parseMarkdownSync(text.slice(bodyStart));
    if (tree) {
      for (const child of tree.children) {
        if (child.type !== 'heading') continue;
        const startOffset = bodyStart + (child.position?.start?.offset ?? 0);
        const endOffset = bodyStart + (child.position?.end?.offset ?? startOffset);
        const start = positionAt({ lineStarts: lineStartTable(text), length: text.length }, startOffset);
        const end = positionAt({ lineStarts: lineStartTable(text), length: text.length }, endOffset);
        const range: LspRange = {
          start: { line: start.line - 1, character: start.column - 1 },
          end: { line: end.line - 1, character: end.column - 1 },
        };
        symbols.push(
          DocumentSymbol.create(
            headingText(child),
            undefined,
            headingKind(child.depth),
            range,
            range,
          ),
        );
      }
    }
  }

  return symbols.length > 0 ? symbols : null;
}

/** The 0-based line a mdlineage field is authored on, or null. */
function fieldLine(text: string, blockStart: number, field: string): number | null {
  const lines = splitLines(text);
  for (let i = blockStart; i < lines.length; i++) {
    const line = lines[i]!;
    // The field's own key line, at the block's two-space indent. A nested key
    // of the same name (a relation's `target`) is indented deeper and is not
    // the block-level field.
    if (/^\s{2}/.test(line) && new RegExp(`^\\s{2}${field}:`).test(line)) return i;
    if (/^---/.test(line) && i > blockStart) break;
  }
  return null;
}

/** A DocumentSymbol range covering one whole 0-based line. */
function lineRange(line: number, text: string): LspRange {
  const lines = splitLines(text);
  const length = line < lines.length ? lines[line]!.length : 0;
  return { start: { line, character: 0 }, end: { line, character: Math.max(length, 1) } };
}

function headingKind(depth: number | undefined): SymbolKind {
  switch (depth) {
    case 1:
      return SymbolKind.String;
    case 2:
      return SymbolKind.Class;
    default:
      return SymbolKind.Field;
  }
}

/* ------------------------------------------------------------------ *
 * Workspace symbols (§10.2: "Workspace Symbols：按 ID、标题、alias 搜索")
 * ------------------------------------------------------------------ */

function workspaceSymbols(context: ServerContext, params: WorkspaceSymbolParams): SymbolInformation[] | null {
  const query = params.query.trim().toLowerCase();
  const out: import('vscode-languageserver-types').SymbolInformation[] = [];
  for (const id of context.index.ids()) {
    // Case-insensitive substring over the id and every alias, which is the
    // §10.2 search surface; an empty query lists the whole index.
    const idHit = query === '' || id.toLowerCase().includes(query);
    if (!idHit && !aliasHits(context, id, query)) continue;
    const paths = context.index.idToPaths(id);
    const first = paths[0];
    if (first === undefined) continue;
    const entry = context.index.entryOf(first);
    if (!entry) continue;
    const at = positionAt({ lineStarts: entry.lineMap.lineStarts, length: entry.lineMap.length }, entry.idOffset);
    out.push(
      SymbolInformation.create(
        id,
        SymbolKind.Class,
        {
          start: { line: at.line - 1, character: at.column - 1 },
          end: { line: at.line - 1, character: at.column - 1 + id.length },
        },
        pathToUriOf(context, first),
        'mdlineage',
      ),
    );
  }
  return out.length > 0 ? out : null;
}

/** True when any alias of `id` contains the (lowercased) query. */
function aliasHits(context: ServerContext, id: string, query: string): boolean {
  if (query === '') return false;
  for (const p of context.index.idToPaths(id)) {
    const fields = frontmatterOf(context, p);
    const aliases = fields?.['aliases'];
    if (!Array.isArray(aliases)) continue;
    for (const alias of aliases) {
      if (typeof alias === 'string' && alias.toLowerCase().includes(query)) return true;
    }
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * Code actions (§9.1's safe fixes; §10.2: "Code Action：安全修复")
 * ------------------------------------------------------------------ */

function codeActions(context: ServerContext, params: CodeActionParams): CodeAction[] | null {
  if (params.context.only !== undefined && !params.context.only.includes(Kind.QuickFix)) return null;
  const path = requestPath(context, params);
  if (path === null) return null;
  const text = textOf(context, path);
  if (text === null) return null;

  const lines = splitLines(text);
  const out: CodeAction[] = [];
  for (const diag of params.context.diagnostics) {
    if (diag.code === undefined) continue;
    const message = diag.message as string;
    const like: LspDiagnosticLike = {
      range: diag.range,
      code: diag.code,
      message,
      data: diag.data,
    };
    const code = String(diag.code);
    if (code === 'MDL104') {
      // An unknown field: deleting the line is safe only for a SCALAR field
      // (`key: value`). A block-valued field (`key:` with deeper-indented
      // children) would leave orphaned child lines behind and corrupt the
      // YAML, so no quick fix is offered for that shape (§9.1's safe subset).
      const offending = lines[diag.range.start.line] ?? '';
      if (!/^\s{2}[A-Za-z_][\w-]*:\s+\S/.test(offending)) continue;
      const action = deleteLineAction(context, path, lines, like, 'Remove unknown mdlineage field');
      if (action) out.push(action);
    } else if (code === 'MDL102') {
      // A missing required field: insert a skeleton line carrying the
      // vocabulary's first legal value, which is §9.1's "插入缺失数组或空对象"
      // applied to a scalar.
      const action = insertFieldAction(context, path, lines, like);
      if (action) out.push(action);
    } else if (code === 'MDL202') {
      // A duplicate relation: the whole offending block is removed, which is
      // §9.1's "删除当前文档内完全重复的 relation".
      const action = deleteRelationAction(context, path, lines, like);
      if (action) out.push(action);
    }
  }
  return out.length > 0 ? out : null;
}

/** Delete the line a diagnostic sits on. */
function deleteLineAction(
  context: ServerContext,
  path: DocPath,
  lines: ReadonlyArray<string>,
  diag: LspDiagnosticLike,
  title: string,
): CodeAction | null {
  const line = diag.range.start.line;
  if (line < 0 || line >= lines.length) return null;
  // The line plus its terminator: deleting only the text would leave a blank
  // line behind, and the front matter's indentation would then look valid.
  return codeAction(title, [TextEdit.del({ start: { line, character: 0 }, end: { line: line + 1, character: 0 } })], context, path, diag);
}

/**
 * The subset of an LSP Diagnostic the code actions read. Named so a test can
 * build one without the full protocol object.
 */
export interface LspDiagnosticLike {
  range: LspRange;
  code?: number | string;
  message: string;
  data?: unknown;
}

/**
 * Insert a skeleton line for a missing required field, after the last existing
 * mdlineage field so the block stays contiguous.
 */
function insertFieldAction(
  context: ServerContext,
  path: DocPath,
  lines: ReadonlyArray<string>,
  diag: LspDiagnosticLike,
): CodeAction | null {
  const missing = missingFieldOf(diag);
  if (missing === null) return null;
  const value = firstVocabularyValue(context.config, missing);
  if (value === null) return null;
  const block = mdlineageRange(lines.join('\n'), lines);
  if (block === null) return null;
  // The skeleton goes after the last SCALAR field (`key: value` on one line)
  // so it never lands inside a collection's block: `relations:` owns the lines
  // below it, and a sibling scalar inserted after that list would split it.
  let insertAt = block.start + 1;
  for (let i = block.start + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^---/.test(line)) break;
    if (/^\s{2}[A-Za-z_][\w-]*:\s+\S/.test(line)) insertAt = i + 1;
  }
  return codeAction(
    `Insert missing field ${missing}`,
    [TextEdit.insert({ line: insertAt, character: 0 }, `  ${missing}: ${value}\n`)],
    context,
    path,
    diag,
  );
}

/** Delete the whole relation block a duplicate-relation diagnostic points at. */
function deleteRelationAction(
  context: ServerContext,
  path: DocPath,
  lines: ReadonlyArray<string>,
  diag: LspDiagnosticLike,
): CodeAction | null {
  const start = diag.range.start.line;
  // The block continues while the next line is indented DEEPER than the
  // relation's own `- ` item: the item's key at the item's indent ends it, and
  // so does the front matter's `---` or anything after it. Testing "deeper"
  // rather than "not the next item" is what stops the deletion at the block's
  // end instead of running past the closing fence into the body.
  const indent = leadingIndent(lines[start] ?? '');
  let end = start + 1;
  while (end < lines.length && leadingIndent(lines[end]!) > indent) end++;
  return codeAction(
    'Remove duplicate relation',
    [TextEdit.del({ start: { line: start, character: 0 }, end: { line: end, character: 0 } })],
    context,
    path,
    diag,
  );
}

/** Assemble one code action carrying `edits` for a single document. */
function codeAction(
  title: string,
  edits: TextEdit[],
  context: ServerContext,
  path: DocPath,
  diag: LspDiagnosticLike,
): CodeAction {
  const action = CodeAction.create(
    title,
    { changes: { [pathToUriOf(context, path)]: edits } },
    Kind.QuickFix,
  );
  action.diagnostics = [
    {
      range: diag.range,
      severity: DiagnosticSeverity.Error,
      code: diag.code,
      source: 'mdlineage',
      message: diag.message,
    },
  ];
  action.isPreferred = true;
  return action;
}

/** The field name an MDL102 diagnostic names (from its `data` or message). */
function missingFieldOf(diag: LspDiagnosticLike): string | null {
  const data = diag.data as Record<string, unknown> | undefined;
  if (data && typeof data['missingProperty'] === 'string') return data['missingProperty'] as string;
  const match = /Missing required mdlineage field: (\S+)/.exec(diag.message);
  return match ? match[1]! : null;
}

/** The vocabulary's first legal value for a field, or null when free-form. */
function firstVocabularyValue(config: Config, field: string): string | null {
  switch (field) {
    case 'schema':
      return '1';
    case 'kind':
      return config.vocabulary.kinds?.[0] ?? null;
    case 'status':
      return config.vocabulary.statuses?.[0] ?? null;
    case 'authority':
      return config.vocabulary.authorities?.[0] ?? null;
    default:
      // `id` has no vocabulary — §9.2 keeps generating one a suggestion, not an
      // automatic fix — so the action is not offered for it.
      return null;
  }
}

/** Leading space count of a line. */
function leadingIndent(line: string): number {
  const match = /^(\s*)/.exec(line);
  return match ? match[1]!.length : 0;
}

/* ------------------------------------------------------------------ *
 * Shared position/URI helpers
 * ------------------------------------------------------------------ */

/** One validator (1-based) position → one LSP Location. */
function locationOf(context: ServerContext, path: DocPath, line: number, column: number): Location {
  const lines = splitLinesOf(context, path);
  const lineText = lines[line - 1] ?? '';
  return Location.create(pathToUriOf(context, path), {
    start: { line: line - 1, character: characterOf(lineText, column) },
    end: { line: line - 1, character: characterOf(lineText, column) },
  });
}

/** The line table of a document, read once per call (CRLF-aware). */
function splitLinesOf(context: ServerContext, path: DocPath): string[] {
  const text = textOf(context, path);
  return text === null ? [] : splitLines(text);
}

/** The `file://` URI of an indexed path. */
function pathToUriOf(_context: ServerContext, path: DocPath): string {
  return pathToFileURL(path).href;
}
