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
 *   - MDL203: a same-page Markdown link (`[x](#sec)`) points at no heading of
 *             the document. The link layer refuses same-page destinations
 *             (MDL401 owns the path, MDL402 the fragment of ANOTHER document),
 *             so the in-page fragment reaches the document layer, which is the
 *             only place the target headings exist.
 *
 * Heading anchors follow GFM slug semantics; `Slugger` implements GitHub's
 * algorithm including the `-n` duplicate suffix.
 */

import type { Root, Heading, Link, Definition } from 'mdast';
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
 * parse failure already has its own diagnostic). `bodyStart` is the document
 * offset of the body slice the tree was parsed from, so link diagnostics land
 * on the link instead of `bodyStart` code units early.
 */
export function validateDocumentSemantics(
  mdlineage: Record<string, unknown> | null,
  tree: Root | null,
  lineMap: LineMap,
  _rawStart: number,
  relationOffsets: RelationOffsets,
  config: Config,
  bodyStart = 0,
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
      out.push(mdl201(anchor, where, lineMap, config));
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
    out.push(mdl202(rel, where, lineMap, config));
  }

  // MDL203: same-page links. The predicate is the document's own anchor set,
  // so it is decidable here and nowhere else: the link layer splits a
  // destination into path and fragment, and a `#sec` destination has an empty
  // path, which takes it out of both MDL401 and MDL402 by construction.
  if (tree && anchors !== null) {
    for (const link of extractSamePageLinks(tree)) {
      if (anchors.has(link.anchor)) continue;
      out.push(mdl203(link, bodyStart, lineMap, config));
    }
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

/**
 * Heading TEXT of every heading in the document, in document order.
 *
 * The text is what a symbol query matches (`workspace/symbol` searches the
 * title a developer reads, and the slug is only its mangled form), so this is
 * the same walk `collectAnchors` takes without the slugger.
 */
export function collectHeadingTexts(tree: Root): string[] {
  const out: string[] = [];
  visit(tree, (node) => {
    if (node.type === 'heading') out.push(textOfHeading(node as unknown as Heading));
  });
  return out;
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

/**
 * Same-page links of a document body: destinations that are a bare fragment.
 *
 * A destination is only same-page when the fragment is the WHOLE url; a
 * `./b.md#sec` link has a path, so its fragment is the target document's
 * concern (MDL402) and never appears here. Images are excluded, as in the
 * workspace link scan: an image is not a document link.
 *
 * `linkReference` nodes carry no url of their own: the destination comes from
 * the matching `definition`, which CommonMark allows to appear later in the
 * document, so definitions are gathered first.
 */
export function extractSamePageLinks(tree: Root): SamePageLink[] {
  const definitions = new Map<string, string>();
  visitTree(tree, (node) => {
    if (node.type !== 'definition') return;
    const def = node as Definition;
    const key = def.identifier ?? def.label;
    if (typeof key === 'string' && typeof def.url === 'string') {
      definitions.set(normalizeLabel(key), def.url);
    }
  });

  const out: SamePageLink[] = [];
  visitTree(tree, (node) => {
    if (node.type !== 'link' && node.type !== 'linkReference') return;
    const link = node as Link & { identifier?: string };
    const url = typeof link.url === 'string' ? link.url : '';
    let destination = url;
    if (!destination) {
      // A reference-style link resolves through its definition; an unresolved
      // one has no destination for any layer to check (a Markdown linter owns
      // that).
      const ref = typeof link.identifier === 'string' ? definitions.get(normalizeLabel(link.identifier)) : undefined;
      if (typeof ref !== 'string') return;
      destination = ref;
    }
    // Only a bare fragment is a same-page anchor: `#`, `#sec`, `#a-b`. An empty
    // fragment (`[x](#)`) is a link to the document itself and not a broken
    // heading reference, so it is skipped like MDL402 skips it.
    if (!destination.startsWith('#')) return;
    const anchor = destination.slice(1);
    if (anchor === '') return;
    out.push({ url: destination, anchor, offset: link.position?.start?.offset ?? 0 });
  });
  return out;
}

/** A same-page link with the anchor it names, body-relative offset included. */
export interface SamePageLink {
  readonly url: string;
  readonly anchor: string;
  /** Offset of the link's opening bracket, relative to the body slice. */
  readonly offset: number;
}

/** GFM reference-label matching is case-insensitive and collapses whitespace. */
function normalizeLabel(label: string): string {
  return label.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Assemble an MDL203 diagnostic positioned on the offending link. */
function mdl203(link: SamePageLink, bodyStart: number, lineMap: LineMap, config: Config): Diagnostic {
  const start = bodyStart + link.offset;
  return {
    code: 'MDL203',
    severity: severityOf('MDL203', config.diagnostics as Record<string, 'error' | 'warning' | 'information' | 'hint'>),
    message: `Same-page anchor does not exist: ${link.url}`,
    range: rangeAt(lineMap, start, start + link.url.length),
    layer: 'document-semantic',
    data: { anchor: link.anchor },
  };
}

function mdl201(anchor: string, where: number, lineMap: LineMap, config: Config): Diagnostic {
  return {
    code: 'MDL201',
    severity: severityOf('MDL201', config.diagnostics as Record<string, 'error' | 'warning' | 'information' | 'hint'>),
    message: `Evidence anchor does not exist: #${anchor}`,
    range: rangeAt(lineMap, where, where + Math.max(1, anchor.length + 1)),
    layer: 'document-semantic',
    data: { anchor },
  };
}

function mdl202(
  rel: RelationLike,
  where: number,
  lineMap: LineMap,
  config: Config,
): Diagnostic {
  return {
    code: 'MDL202',
    severity: severityOf('MDL202', config.diagnostics as Record<string, 'error' | 'warning' | 'information' | 'hint'>),
    message: `Duplicate relation: ${rel.type} → ${rel.target}`,
    range: rangeAt(lineMap, where, where + 1),
    layer: 'document-semantic',
    data: { type: rel.type, target: rel.target, evidence: rel.evidence },
  };
}

/**
 * Source absolute offsets of relation fields, so semantic diagnostics can point
 * at the offending declaration instead of at line 1.
 *
 * The implementation is deliberately defensive: a YAML document whose structure
 * the schema layer already rejected still reaches this code, and every lookup
 * falls back to the anchor offset.
 */
export interface RelationOffsets {
  relationStart(index: number): number | undefined;
  relationField(index: number, field: string): number | undefined;
  readonly mdlineageStart: number;
}

/** Build a RelationOffsets view over a parsed YAML CST document returning absolute offsets. */
export function relationOffsetsOf(doc: unknown, rawStart: number, anchor = rawStart): RelationOffsets {
  const relations = doc === null || typeof doc !== 'object' ? null : relationsNode(doc);
  const items = relations && Array.isArray(relations.items) ? relations.items : [];

  return {
    mdlineageStart: anchor,
    relationStart(index: number): number | undefined {
      const item = items[index];
      if (!item) return undefined;
      const start = rangeStart(item) ?? rangeStart((item as { node?: unknown }).node);
      return start !== undefined ? rawStart + start : anchor;
    },
    relationField(index: number, field: string): number | undefined {
      const item = items[index];
      const map = mapOf(item);
      if (!map) return undefined;
      const pair = map.items.find((p) => keyValue(p) === field);
      if (!pair) return undefined;
      const start = rangeStart((pair as { key?: unknown }).key) ?? rangeStart(pair);
      return start !== undefined ? rawStart + start : anchor;
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
 * id rather than at line 1. The value is relative to `raw` (only this offset
 * remains relative to raw; callers like idOffset, statusOffset, and freshness
 * add rawStart themselves).
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
