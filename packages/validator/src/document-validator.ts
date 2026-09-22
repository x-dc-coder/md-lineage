/**
 * Single-document semantics (docs/remark-language-server-solution.md §4.4).
 *
 * Everything here is decidable from one file, which is why these codes are in
 * `invalid/` rather than `workspace/` (test/fixtures/README.md):
 *
 *   - MDL201: an evidence anchor does not resolve to a heading of the CURRENT
 *             document. Cross-file resolution is MDL402 and is not decided here.
 *   - MDL202: the same (type, target) pair — with evidence distinguishing one
 *             declaration from another — is declared more than once in one
 *             document.
 *
 * Heading anchors follow GFM slug semantics; `Slugger` implements GitHub's
 * algorithm including the `-n` duplicate suffix.
 */

import type { Root, Heading } from 'mdast';
import type { Config } from './config.js';
import type { Diagnostic } from './diagnostic.js';
import { severityOf } from './diagnostic.js';
import type { LineMap } from './source-map.js';
import { rangeAt } from './source-map.js';
import { Slugger } from './slugger.js';

/** A relation as read from the front matter. */
interface RelationLike {
  readonly type?: unknown;
  readonly target?: unknown;
  readonly evidence?: unknown;
  readonly reason?: unknown;
}

/**
 * Validate the document-semantic layer.
 *
 * `mdlineage` is the parsed metadata object; `tree` is the mdast tree (null
 * when Markdown failed to parse, in which case anchor checks are skipped — the
 * parse failure already has its own diagnostic).
 */
export function validateDocumentSemantics(
  mdlineage: Record<string, unknown> | null,
  tree: Root | null,
  lineMap: LineMap,
  rawStart: number,
  relationOffsets: RelationOffsets,
  config: Config,
): Diagnostic[] {
  const out: Diagnostic[] = [];
  if (!mdlineage) return out;

  const relations = Array.isArray(mdlineage.relations) ? (mdlineage.relations as RelationLike[]) : [];

  // MDL201: anchors must exist in the current document. Skip a value the schema
  // layer already rejected as malformed (MDL103) — the registry assigns one
  // diagnostic per problem, and a pattern failure is not a missing heading.
  const anchors = tree ? collectAnchors(tree) : null;
  for (let i = 0; i < relations.length; i++) {
    const rel = relations[i];
    // A null item (e.g. `relations:\n  -`) already reported MDL103 at the
    // schema layer; the semantic layer skips it rather than throwing.
    if (!rel || typeof rel !== 'object') continue;
    if (typeof rel.evidence !== 'string') continue;
    if (!/^#\S+$/.test(rel.evidence)) continue;
    const anchor = rel.evidence.slice(1);
    if (anchors !== null && !anchors.has(anchor)) {
      const where = relationOffsets.relationField(i, 'evidence') ?? relationOffsets.relationStart(i) ?? relationOffsets.mdlineageStart;
      out.push(mdl201(anchor, where, lineMap, rawStart, config));
    }
  }

  // MDL202: duplicate (type, target, evidence) triples within one document.
  const seen = new Map<string, number>();
  for (let i = 0; i < relations.length; i++) {
    const rel = relations[i];
    if (!rel || typeof rel !== 'object') continue;
    if (typeof rel.type !== 'string' || typeof rel.target !== 'string') continue;
    const key = JSON.stringify([rel.type, rel.target, typeof rel.evidence === 'string' ? rel.evidence : null]);
    const first = seen.get(key);
    if (first === undefined) {
      seen.set(key, i);
      continue;
    }
    const where = relationOffsets.relationStart(i) ?? relationOffsets.mdlineageStart;
    out.push(mdl202(rel, where, lineMap, rawStart, config));
  }

  return out;
}

/**
 * GFM anchors of every heading in the document, duplicates suffixed.
 *
 * Shared with the workspace layer, which needs the same anchor set of a target
 * document to decide MDL402 (evidence resolving cross-file). Keeping one
 * implementation means an `evidence` value that resolves in-document can never
 * disagree with the same value resolved against another document.
 */
export function collectAnchors(tree: Root): Set<string> {
  const slugger = new Slugger();
  visit(tree, (node) => {
    if (node.type === 'heading') {
      slugger.slug(textOfHeading(node as unknown as Heading));
    }
  });
  return slugger.anchors();
}

/** Visit every node in an mdast tree; shared with the workspace link scan. */
export function visitTree(node: unknown, fn: (node: { type: string }) => void): void {
  if (!node || typeof node !== 'object') return;
  fn(node as { type: string });
  const children = (node as { children?: unknown[] }).children;
  if (Array.isArray(children)) {
    for (const child of children) visitTree(child, fn);
  }
}

/** Visit every node in an mdast tree. */
function visit(node: unknown, fn: (node: { type: string }) => void): void {
  visitTree(node, fn);
}

/** Concatenated text of a heading, matching how GFM renders it to an anchor. */
function textOfHeading(heading: Heading): string {
  let out = '';
  collectText(heading, (chunk) => {
    out += chunk;
  });
  return out;
}

function collectText(node: unknown, push: (text: string) => void): void {
  if (!node || typeof node !== 'object') return;
  const n = node as { type?: string; value?: string; children?: unknown[] };
  if (n.type === 'text' && typeof n.value === 'string') push(n.value);
  // `code` is a fenced-code block child (never under a heading) and
  // `inlineCode` is the heading variant; both render their raw value into
  // the anchor, per github-slugger.
  if ((n.type === 'code' || n.type === 'inlineCode') && typeof n.value === 'string') push(n.value);
  if (Array.isArray(n.children)) for (const child of n.children) collectText(child, push);
}

function mdl201(anchor: string, where: number, lineMap: LineMap, rawStart: number, config: Config): Diagnostic {
  return {
    code: 'MDL201',
    severity: severityOf('MDL201', config.diagnostics as Record<string, 'error' | 'warning' | 'information' | 'hint'>),
    message: `Evidence anchor does not exist: #${anchor}`,
    range: rangeAt(lineMap, rawStart + where, rawStart + where + Math.max(1, anchor.length + 1)),
    layer: 'document-semantic',
    data: { anchor },
  };
}

function mdl202(
  rel: RelationLike,
  where: number,
  lineMap: LineMap,
  rawStart: number,
  config: Config,
): Diagnostic {
  return {
    code: 'MDL202',
    severity: severityOf('MDL202', config.diagnostics as Record<string, 'error' | 'warning' | 'information' | 'hint'>),
    message: `Duplicate relation: ${rel.type} → ${rel.target}`,
    range: rangeAt(lineMap, rawStart + where, rawStart + where + 1),
    layer: 'document-semantic',
    data: { type: rel.type, target: rel.target, evidence: rel.evidence },
  };
}

/**
 * Source offsets of relation fields inside the front matter slice, so semantic
 * diagnostics can point at the offending declaration instead of at line 1.
 *
 * The implementation is deliberately defensive: a YAML document whose structure
 * the schema layer already rejected still reaches this code, and every lookup
 * falls back to the `mdlineage` key's start.
 */
export interface RelationOffsets {
  relationStart(index: number): number | undefined;
  relationField(index: number, field: string): number | undefined;
  readonly mdlineageStart: number;
}

/** Build a RelationOffsets view over a parsed YAML CST document. */
export function relationOffsetsOf(doc: unknown, mdlineageStart: number): RelationOffsets {
  const relations = doc === null || typeof doc !== 'object' ? null : relationsNode(doc);
  const items = relations && Array.isArray(relations.items) ? relations.items : [];

  return {
    mdlineageStart,
    relationStart(index: number): number | undefined {
      const item = items[index];
      if (!item) return undefined;
      return rangeStart(item) ?? rangeStart((item as { node?: unknown }).node) ?? mdlineageStart;
    },
    relationField(index: number, field: string): number | undefined {
      const item = items[index];
      const map = mapOf(item);
      if (!map) return undefined;
      const pair = map.items.find((p) => keyValue(p) === field);
      if (!pair) return undefined;
      return rangeStart((pair as { key?: unknown }).key) ?? rangeStart(pair) ?? mdlineageStart;
    },
  };
}

function relationsNode(doc: unknown): { items: unknown[] } | null {
  const contents = (doc as { contents?: unknown }).contents;
  const root = contents as { items?: unknown[] } | undefined;
  if (!root || !Array.isArray(root.items)) return null;
  const mdlineage = root.items.find((p) => keyValue(p) === 'mdlineage');
  if (!mdlineage) return null;
  const value = (mdlineage as { value?: unknown }).value;
  if (!value || typeof value !== 'object') return null;
  const inner = (value as { items?: unknown[] });
  if (!inner || !Array.isArray(inner.items)) return null;
  const relationsPair = inner.items.find((p) => keyValue(p) === 'relations');
  if (!relationsPair) return null;
  const relationsValue = (relationsPair as { value?: unknown }).value;
  if (!relationsValue || typeof relationsValue !== 'object') return null;
  return relationsValue as { items: unknown[] };
}

function mapOf(item: unknown): { items: unknown[] } | null {
  if (!item || typeof item !== 'object') return null;
  const node = (item as { node?: unknown }).node ?? item;
  if (!node || typeof node !== 'object') return null;
  const items = (node as { items?: unknown[] }).items;
  return Array.isArray(items) ? { items } : null;
}

function keyValue(pair: unknown): unknown {
  return (pair as { key?: { value?: unknown } })?.key?.value;
}

function rangeStart(node: unknown): number | undefined {
  if (!node || typeof node !== 'object') return undefined;
  const range = (node as { range?: readonly [number, number, number] }).range;
  return range ? range[0] : undefined;
}

/**
 * Offset of a scalar field of the mdlineage object (`id`, `kind`, …) inside
 * the front matter slice, or null when the field or its source is absent.
 *
 * The workspace layer uses this for MDL301, which must point at the duplicate
 * id rather than at line 1. The value is relative to `raw`, exactly like the
 * `RelationOffsets` accessors, so the caller adds `rawStart`.
 */
export function mdlineageFieldOffset(doc: unknown, field: string): number | null {
  const value = mdlineageValueOf(doc);
  if (!value) return null;
  const items = value.items;
  if (!Array.isArray(items)) return null;
  const pair = items.find((p) => keyValue(p) === field);
  if (!pair) return null;
  return rangeStart((pair as { value?: unknown }).value) ?? rangeStart(pair) ?? null;
}

/** The CST mapping under the `mdlineage` key, when the document has one. */
function mdlineageValueOf(doc: unknown): { items: unknown[] } | null {
  if (!doc || typeof doc !== 'object') return null;
  const root = (doc as { contents?: unknown }).contents;
  if (!root || typeof root !== 'object') return null;
  const items = (root as { items?: unknown[] }).items;
  if (!Array.isArray(items)) return null;
  const pair = items.find((p) => keyValue(p) === 'mdlineage');
  const value = (pair as { value?: unknown } | undefined)?.value;
  if (!value || typeof value !== 'object') return null;
  const inner = (value as { items?: unknown[] }).items;
  return Array.isArray(inner) ? { items: inner } : null;
}
