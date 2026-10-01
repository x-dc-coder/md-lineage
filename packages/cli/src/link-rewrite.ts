/**
 * Link self-healing for a document move (docs/dir-conventions.md §3 "Move
 * impact"): the relative-link algebra both directions of a move need.
 *
 * The two directions are not symmetric:
 *   - in-edges — another document links TO the moved file, so its destination
 *     is recomputed against the new location, fragment kept;
 *   - out-edges — the moved document links OUT, so its destinations must keep
 *     pointing at the same absolute files and are re-spelled from the new
 *     directory.
 *
 * Destinations are found through the document AST (the same remark parse the
 * validator uses), so a link written inside a fenced block or inline code is
 * never rewritten, while images and reference-style definitions — which the
 * MDL401 link layer skips — still are: a broken image is exactly as broken as a
 * broken link.
 */

import { posix } from 'node:path';
import { parseMarkdownSync, scanBoundary } from '@mdlineage/validator';

/** Workspace-relative POSIX path, the vocabulary the workspace index uses. */
export type DocPath = string;

/** One rewritten destination, for the plan and the report. */
export interface LinkRewrite {
  /** The destination exactly as authored. */
  readonly from: string;
  /** The destination after the rewrite. */
  readonly to: string;
}

/** Result of one document's link pass. */
export interface RewriteResult {
  readonly content: string;
  readonly rewrites: readonly LinkRewrite[];
}

/** The AST shape this module needs; the validator owns the real parse. */
interface AstNode {
  readonly type?: unknown;
  readonly url?: unknown;
  readonly position?: {
    readonly start?: { readonly offset?: number };
    readonly end?: { readonly offset?: number };
  };
  readonly children?: unknown;
}

/** Node types whose `url` is a link destination. `image` is included on purpose. */
const DESTINATION_NODES: ReadonlySet<string> = new Set(['link', 'image', 'definition']);

/** Directory part of a POSIX path: `docs/guides/foo.md` → `docs/guides`. */
export function dirOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '.' : path.slice(0, slash);
}

/** Basename part of a POSIX path: `docs/guides/foo.md` → `foo.md`. */
export function basenameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/**
 * `<dir>`-relative pointer to `target`.
 *
 * A sibling keeps a `./` prefix, matching the house style the rest of the
 * corpus is written in; a link leaving the directory keeps its `../` chain,
 * which `posix.relative` already produces.
 */
export function relativize(dir: string, target: string): string {
  const rel = posix.relative(dir, target);
  if (rel === '') return '.';
  return rel.startsWith('.') ? rel : `./${rel}`;
}

/** True when `href` names a workspace path a move can invalidate. */
export function isRewritableHref(href: string): boolean {
  if (href === '') return false;
  // A same-page anchor, a root-relative path and a URL are all unaffected by
  // where the linking document lives, so none of them is ever rewritten.
  if (href.startsWith('#') || href.startsWith('/')) return false;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href)) return false;
  return true;
}

/** Split `a.md#anchor` into its path and its `#fragment` (empty when absent). */
export function splitHref(href: string): [string, string] {
  const hash = href.indexOf('#');
  if (hash < 0) return [href, ''];
  return [href.slice(0, hash), href.slice(hash)];
}

/** The workspace path `href` points at from `doc`, or null when it names none. */
export function resolvedTarget(doc: DocPath, href: string): DocPath | null {
  if (!isRewritableHref(href)) return null;
  const [pathPart] = splitHref(href);
  if (pathPart === '') return null;
  return posix.normalize(posix.join(dirOf(doc), pathPart));
}

/**
 * Re-point every destination in `content` that resolves to `from`, at `to`
 * instead. `doc` is the workspace-relative path of the document itself.
 */
export function repointLinks(content: string, doc: DocPath, from: DocPath, to: DocPath): RewriteResult {
  const rewrites: LinkRewrite[] = [];
  const edits: LinkEdit[] = [];
  for (const site of linkSites(content)) {
    if (resolvedTarget(doc, site.href) !== from) continue;
    const next = relativize(dirOf(doc), to) + splitHref(site.href)[1];
    if (next === site.href) continue;
    edits.push({ start: site.start, end: site.end, text: next });
    rewrites.push({ from: site.href, to: next });
  }
  return { content: applyEdits(content, edits), rewrites };
}

/**
 * Re-spell the moved document's own destinations from its new directory.
 *
 * The target file never changes: only the relative path to it does, so
 * `../other/x.md` stays the same file after `docs/a.md` becomes `docs/g/a.md`.
 */
export function rebaseLinks(content: string, fromDoc: DocPath, toDoc: DocPath): RewriteResult {
  const rewrites: LinkRewrite[] = [];
  const edits: LinkEdit[] = [];
  for (const site of linkSites(content)) {
    if (!isRewritableHref(site.href)) continue;
    const [pathPart, fragment] = splitHref(site.href);
    if (pathPart === '') continue;
    const absolute = posix.normalize(posix.join(dirOf(fromDoc), pathPart));
    const next = relativize(dirOf(toDoc), absolute) + fragment;
    if (next === site.href) continue;
    edits.push({ start: site.start, end: site.end, text: next });
    rewrites.push({ from: site.href, to: next });
  }
  return { content: applyEdits(content, edits), rewrites };
}

/** The `updated_at` value the front matter currently carries, or null. */
export function readUpdatedAt(content: string, metadataKey: string): string | null {
  return locateUpdatedAt(content, metadataKey)?.value ?? null;
}

/**
 * Refresh `updated_at` in the front matter to `today` (YYYY-MM-DD).
 *
 * A relocate is a substantive change, so the freshness clock (MDL801) must not
 * keep reading the pre-move date. Returns null when the document has no
 * metadata block, no block-style metadata key, or no `updated_at` key to
 * refresh — the move itself is legitimate without one.
 */
export function refreshUpdatedAt(content: string, metadataKey: string, today: string): string | null {
  const found = locateUpdatedAt(content, metadataKey);
  if (found === null) return null;
  return `${content.slice(0, found.line.start)}${found.indent}updated_at: ${today}${content.slice(found.line.end)}`;
}

/** Where the metadata block's `updated_at` key sits, and what it says. */
function locateUpdatedAt(
  content: string,
  metadataKey: string,
): { line: Line; indent: string; value: string } | null {
  const boundary = scanBoundary(content);
  if (!boundary || boundary.closeStart === null) return null;
  const closeStart = boundary.closeStart;

  const lines = scanLines(content);
  const keyPattern = new RegExp(`^${escapeRegExp(metadataKey)}[ \\t]*:[ \\t]*$`);
  const keyAt = lines.findIndex(
    (line) => line.start >= boundary.rawStart && line.end <= closeStart && keyPattern.test(line.text),
  );
  // A flow-style key (`mdlineage: {updated_at: ...}`) is not rewritten: editing
  // inside a flow mapping is a YAML restructure, not a value replacement.
  if (keyAt < 0) return null;

  const keyIndent = indentOf(lines[keyAt]!.text);
  for (let i = keyAt + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.start >= closeStart) break;
    if (line.text.trim() === '') continue;
    // Past the metadata block: the key it declares does not belong to us.
    if (indentOf(line.text) <= keyIndent) break;
    const match = /^([ \t]*)updated_at[ \t]*:[ \t]*(.*)$/.exec(line.text);
    if (!match) continue;
    return { line, indent: match[1]!, value: match[2]!.trim().replace(/^['"]|['"]$/g, '') };
  }
  return null;
}

interface LinkSite {
  /** Offset of the first byte of the destination text. */
  readonly start: number;
  /** Offset just past the last byte of the destination text. */
  readonly end: number;
  /** The destination exactly as authored. */
  readonly href: string;
}

interface LinkEdit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

interface Line {
  readonly text: string;
  /** Offset of the line's first code unit. */
  readonly start: number;
  /** Offset of the line terminator (or of the end of the document). */
  readonly end: number;
}

/** Lines with their absolute offsets, terminators excluded from `text`. */
function scanLines(text: string): Line[] {
  const out: Line[] = [];
  const pattern = /\r\n|\r|\n/g;
  let start = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    out.push({ text: text.slice(start, match.index), start, end: match.index });
    start = match.index + match[0].length;
  }
  if (start < text.length) out.push({ text: text.slice(start), start, end: text.length });
  return out;
}

function indentOf(line: string): number {
  return (/^[ \t]*/.exec(line) ?? [''])[0]!.length;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Every destination the document's AST carries, in document order. */
export function linkHrefs(text: string): readonly string[] {
  return linkSites(text).map((site) => site.href);
}

/** Every destination the document's AST carries, with its exact text span. */
function linkSites(text: string): LinkSite[] {
  const tree = parseMarkdownSync(text) as unknown as AstNode | null;
  if (!tree) return [];
  const sites: LinkSite[] = [];
  walk(tree, (node) => {
    if (typeof node.type !== 'string' || !DESTINATION_NODES.has(node.type)) return;
    const href = typeof node.url === 'string' ? node.url : '';
    if (href === '') return;
    const start = node.position?.start?.offset;
    const end = node.position?.end?.offset;
    if (typeof start !== 'number' || typeof end !== 'number' || end <= start) return;
    // The node span covers the whole construct — `[text](url "title")`,
    // `![text](url)`, `[label]: url` — so the destination is located inside it
    // rather than assumed. The search starts after the label and the `(` or `:`
    // that introduces the destination, because the label itself can spell the
    // destination verbatim (`[b.md](b.md)`): searching the whole span would
    // rewrite the label and leave the URL pointing where it should not.
    const searchFrom = destinationSearchStart(text, start, end, node.type);
    if (searchFrom === null) return;
    const at = text.slice(searchFrom, end).indexOf(href);
    if (at < 0) return;
    sites.push({ start: searchFrom + at, end: searchFrom + at + href.length, href });
  });
  return sites.sort((a, b) => a.start - b.start);
}

/**
 * Where the destination text may begin: just past the `[label](` of a link or
 * image, or past the `[label]:` of a reference definition. Null when the span
 * does not carry that structure, in which case the destination is left where
 * it is rather than rewritten in the wrong place.
 */
function destinationSearchStart(text: string, start: number, end: number, type: string): number | null {
  const span = text.slice(start, end);
  const open = type === 'image' ? '![' : '[';
  if (!span.startsWith(open)) return null;

  // The label can nest brackets and escape them, so it is skipped as a balanced
  // run instead of by searching for the first `]`.
  let depth = 1;
  let close = -1;
  for (let i = open.length; i < span.length && depth > 0; i += 1) {
    const ch = span[i]!;
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (ch === '[') depth += 1;
    else if (ch === ']') {
      depth -= 1;
      if (depth === 0) close = i;
    }
  }
  if (close < 0) return null;

  const after = span.slice(close + 1);
  if (type === 'definition') {
    // `[label]: url`: the colon and its spacing come before the destination.
    const colon = /^:[ \t]*/.exec(after);
    return colon === null ? null : start + close + 1 + colon[0].length;
  }
  // A title or an angle-bracketed destination still sits between the
  // parentheses, so everything past the `(` is searched.
  return after.startsWith('(') ? start + close + 2 : null;
}

function walk(node: AstNode, visit: (node: AstNode) => void): void {
  visit(node);
  const children = node.children;
  if (!Array.isArray(children)) return;
  for (const child of children) {
    if (typeof child === 'object' && child !== null) walk(child as AstNode, visit);
  }
}

/**
 * Apply edits to `text`. Edits are applied back-to-front, so an earlier
 * destination's offset stays valid after a later one is replaced.
 */
function applyEdits(text: string, edits: readonly LinkEdit[]): string {
  let out = text;
  const ordered = [...edits].sort((a, b) => b.start - a.start);
  for (const edit of ordered) out = `${out.slice(0, edit.start)}${edit.text}${out.slice(edit.end)}`;
  return out;
}
