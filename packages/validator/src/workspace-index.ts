/**
 * Workspace index (docs/remark-language-server-solution.md §4.5, §10.3).
 *
 * The single-document validator is a pure function of one file; the workspace
 * layer's codes (MDL301 duplicate id, MDL302 unresolved target, MDL304 empty
 * reason, MDL305 forbidden cycle, MDL401/MDL402 links and anchors) need the
 * derived graph instead. This module IS that graph: it runs the
 * single-document pipeline per file, keeps the derived views the cross-file
 * rules read, and maintains them incrementally.
 *
 * Derived views kept here:
 *   - `id → paths` and `path → id` (identity; MDL301/302),
 *   - relation out-edges per document (MDL302/304/305, and impact analysis),
 *   - reverse references `id → paths that point at it` — §10.3's
 *     "更新反向引用和依赖集合": who is affected when one document changes,
 *   - heading anchors per document (MDL402),
 *   - Markdown links per document (MDL401), split into path and fragment so a
 *     link carrying an anchor is checked in two independent parts,
 *   - single-document diagnostics per file, cached on the entry so an unchanged
 *     file costs nothing on a re-validation.
 *
 * Incremental cost is O(changed file + its referrers), never O(repository):
 * `updateFile` re-parses one document, subtracts that entry's OLD edges from
 * every reverse map, inserts the new ones, and returns the paths whose view of
 * the world changed — the caller re-validates only those.
 *
 * Pure data layer: no IO. Reading files off disk is the caller's job (the CLI
 * reads the worktree, the LSP overlays unsaved buffers), which is what keeps
 * one index usable from every transport in §5's dependency diagram.
 */

import type { Root, Link } from 'mdast';
import type { Config } from './config.js';
import type { Diagnostic } from './diagnostic.js';
import { validateDocumentSync } from './index.js';
import { collectAnchors, collectHeadingTexts, mdlineageFieldOffset, visitTree } from './document-validator.js';
import type { RelationOffsets } from './document-validator.js';
import { relationOffsetsOf } from './document-validator.js';
import { scanBoundary, parseFrontmatter } from './parse-frontmatter.js';
import { buildLineMap } from './source-map.js';
import type { Document } from 'yaml';

/** A document path. The index uses it verbatim and never inspects its shape. */
export type DocPath = string;

/** A relation as read from the front matter (shape only — the schema validated it). */
export interface RelationEntry {
  readonly type: string;
  readonly target: string;
  readonly reason?: string;
  readonly evidence?: string;
}

/**
 * A Markdown link extracted from the document body.
 *
 * `url` is the destination exactly as authored; `path`/`anchor` are the two
 * parts `a.md#section` splits into, checked independently (MDL401 owns the
 * path, MDL402 the fragment). A same-page `#section` link keeps `path` empty,
 * which takes it out of the link layer entirely — an in-page anchor is
 * MDL201's domain, never MDL401's.
 */
export interface LinkEntry {
  readonly url: string;
  /**
   * Absolute document offset of the link's opening bracket.
   *
   * The Markdown tree is parsed from the body slice (after the closing front
   * matter fence), so the mdast `position` offsets are body-relative; storing
   * them unshifted shifts every MDL401 line/column forward by the front matter's
   * length. `bodyStart` is added when the entry is built, which keeps the offset
   * in the same vocabulary as `lineMap`.
   */
  readonly offset: number;
  readonly path: string;
  readonly anchor: string;
}

/**
 * Everything the workspace layer derives from one document.
 *
 * `diagnostics` carries the single-document codes (MDL0xx/1xx/2xx/6xx) so a
 * consumer that asks for the whole repository's state gets one report per file
 * instead of two passes.
 */
export interface DocEntry {
  readonly path: DocPath;
  /** Null when the document has no usable mdlineage id (MDL102 already reports it). */
  readonly id: string | null;
  readonly relations: readonly RelationEntry[];
  readonly links: readonly LinkEntry[];
  /** Heading anchors of the document (GFM slugs); empty when the body did not parse. */
  readonly anchors: ReadonlySet<string>;
  /**
   * Heading TEXT of the document, in document order; empty when the body did
   * not parse. §10.2's symbol query searches these, not the slugs.
   */
  readonly headings: readonly string[];
  /** Offsets of relation fields, so workspace diagnostics land on the declaration. */
  readonly offsets: RelationOffsets;
  /** Absolute offset of the first YAML byte; 0 when there is no front matter. */
  readonly rawStart: number;
  /** Absolute offset of the `id` value, for MDL301; falls back to `rawStart`. */
  readonly idOffset: number;
  readonly lineMap: ReturnType<typeof buildLineMap>;
  /** Single-document diagnostics, sorted by offset (may be empty). */
  readonly diagnostics: readonly Diagnostic[];
}

/** Read-only query API the cross-file rules consume. */
export interface WorkspaceIndex {
  readonly size: number;
  paths(): IterableIterator<DocPath>;
  pathToId(path: DocPath): string | null;
  /** Every path claiming `id`, sorted; empty for unknown ids. */
  idToPaths(id: string): readonly DocPath[];
  ids(): IterableIterator<string>;
  entryOf(path: DocPath): DocEntry | null;
  /** Paths whose relations point at `id`; empty for unknown ids. */
  referrersOf(id: string): readonly DocPath[];
  /** Paths whose Markdown links resolve to `path`; empty for unknown paths. */
  linkReferrersOf(path: DocPath): readonly DocPath[];
  /** Heading anchors of `path`; empty for unknown paths. */
  anchorsOf(path: DocPath): ReadonlySet<string>;
  /**
   * Headings of `path` as authored, oldest first; empty for unknown paths.
   *
   * The TEXT, not the slug: a symbol query is a developer typing a title, and
   * §10.2's search surface is "ID、标题、alias" — the title the heading renders,
   * which the slug only approximates (case, punctuation and CJK are all lost).
   * Slug-based queries belong to evidence anchors and stay on `anchorsOf`.
   */
  headingsOf(path: DocPath): readonly string[];
  /** Relation out-edges of `path`; empty for unknown paths. */
  relationsOf(path: DocPath): readonly RelationEntry[];
  /** Config the index was built with. */
  readonly config: Config;
  /**
   * True when `path` is an indexed document or a file the caller declared to
   * exist in the workspace (see `createWorkspaceIndex`).
   */
  knowsPath(path: DocPath): boolean;
}

/** Result of an incremental update: who must be re-validated. */
export interface UpdateResult {
  readonly affected: ReadonlySet<DocPath>;
}

const EMPTY_PATHS: readonly DocPath[] = Object.freeze([]);
const EMPTY_STRINGS: ReadonlySet<string> = new Set<string>();
const EMPTY_HEADINGS: readonly string[] = Object.freeze([]);
const EMPTY_RELATIONS: readonly RelationEntry[] = Object.freeze([]);

/**
 * Build an index over a snapshot of the workspace.
 *
 * `files` may be a Map, an array of pairs, or a plain object; it is consumed,
 * never stored, so the caller may reuse it afterwards. Paths are used verbatim
 * — relative-vs-absolute normalization is the caller's concern, because the
 * LSP's overlay paths and the CLI's worktree paths already agree with their own
 * callers, and a normalization rule here would be a second source of truth.
 */
export function createWorkspaceIndex(
  files: Map<DocPath, string> | ReadonlyArray<readonly [DocPath, string]> | Readonly<Record<DocPath, string>>,
  config: Config,
  knownPaths?: Iterable<DocPath>,
): WorkspaceIndex {
  return new IndexImpl(config, mapEntries(files), knownPaths);
}

/**
 * Maintain an index after one document changed.
 *
 * Only `path` is re-parsed. The affected set is computed from BOTH the entry's
 * old and new edges, because a change to A can flip another document's result
 * in either direction: B pointing at A's OLD id becomes unresolved when A is
 * renamed, and unresolved B becomes resolved when A newly claims the id. Such
 * documents are only discoverable from the pre-mutation reverse maps, so the
 * old edges are collected before the entry is replaced.
 *
 * Returns the paths whose derived view changed — the caller re-validates those
 * only (§10.3: "校验当前文件和直接受影响引用方").
 */
export function updateFile(index: WorkspaceIndex, path: DocPath, content: string): UpdateResult {
  return { affected: impl(index).set(path, content) };
}

/** Remove a document; returns the paths whose view of it changed. */
export function removeFile(index: WorkspaceIndex, path: DocPath): UpdateResult {
  return { affected: impl(index).delete(path) };
}

/**
 * Apply several changes in one transaction (a rename is a delete plus a set).
 * The affected set is the union of each change's, which is what a bulk watcher
 * event needs.
 */
export function updateFiles(
  index: WorkspaceIndex,
  changes: ReadonlyArray<readonly [DocPath, string | null]>,
): UpdateResult {
  const entries = impl(index);
  const affected = new Set<DocPath>();
  for (const [path, content] of changes) {
    for (const p of content === null ? entries.delete(path) : entries.set(path, content)) affected.add(p);
  }
  return { affected };
}

class IndexImpl implements WorkspaceIndex {
  private readonly entries = new Map<DocPath, DocEntry>();
  private readonly byId = new Map<string, DocPath[]>();
  /** Reverse references by id: who points at me. */
  private readonly referrers = new Map<string, Set<DocPath>>();
  /** Raw destinations, keyed exactly as authored. */
  private readonly linkReferrers = new Map<string, Set<DocPath>>();
  /**
   * The same reverse edges, keyed by the path a destination RESOLVES to — the
   * `./`/`../`-normalized target — so `linkReferrersOf` answers in the
   * vocabulary the caller's paths use.
   */
  private readonly referrersByPath = new Map<string, Set<DocPath>>();
  /**
   * Workspace files the caller scanned but did not index as documents (schemas,
   * configs, images). Metadata handed in by the scanner — never read off disk
   * here — so MDL401 can tell "absent from the repository" from "not Markdown".
   */
  private readonly known: ReadonlySet<DocPath>;
  readonly config: Config;

  constructor(config: Config, files: Iterable<readonly [DocPath, string]>, knownPaths?: Iterable<DocPath>) {
    this.config = config;
    this.known = new Set(knownPaths ?? []);
    for (const [path, content] of files) {
      // A document that fails to parse yields diagnostics, never an exception:
      // one unreadable file must not invalidate the repository's index.
      this.entries.set(path, parseDocument(path, content, config));
    }
    for (const [path, entry] of this.entries) this.reindex(path, entry);
  }

  get size(): number {
    return this.entries.size;
  }

  paths(): IterableIterator<DocPath> {
    return this.entries.keys();
  }

  pathToId(path: DocPath): string | null {
    return this.entries.get(path)?.id ?? null;
  }

  idToPaths(id: string): readonly DocPath[] {
    return this.byId.get(id) ?? EMPTY_PATHS;
  }

  ids(): IterableIterator<string> {
    return this.byId.keys();
  }

  entryOf(path: DocPath): DocEntry | null {
    return this.entries.get(path) ?? null;
  }

  referrersOf(id: string): readonly DocPath[] {
    return sorted(this.referrers.get(id));
  }

  /**
   * Paths whose Markdown links land on `path`.
   *
   * Both the raw destination and its `./`/`../`-normalized form are consulted,
   * because an index over `docs/a.md` and `root.md` can be linked in either
   * spelling.
   */
  linkReferrersOf(path: DocPath): readonly DocPath[] {
    return sorted(this.referrersByPath.get(path));
  }

  anchorsOf(path: DocPath): ReadonlySet<string> {
    return this.entries.get(path)?.anchors ?? EMPTY_STRINGS;
  }

  headingsOf(path: DocPath): readonly string[] {
    return this.entries.get(path)?.headings ?? EMPTY_HEADINGS;
  }

  relationsOf(path: DocPath): readonly RelationEntry[] {
    return this.entries.get(path)?.relations ?? EMPTY_RELATIONS;
  }

  knowsPath(path: DocPath): boolean {
    return this.entries.has(path) || this.known.has(path);
  }

  /** Insert or replace one document, repairing every reverse map. */
  set(path: DocPath, content: string): Set<DocPath> {
    const previous = this.entries.get(path);
    const affected = new Set<DocPath>([path]);
    if (previous) {
      this.collectAffected(affected, previous);
      this.unindex(path, previous);
    }
    const next = parseDocument(path, content, this.config);
    this.entries.set(path, next);
    this.reindex(path, next);
    this.collectAffected(affected, next);
    // Incoming links are keyed by path, not by this document's content, so the
    // reverse map is unchanged by the swap — but a deleted or emptied target is
    // exactly what flips a referrer's MDL401, so those referrers are collected
    // once here, after the swap.
    for (const p of this.linkReferrersOf(path)) affected.add(p);
    return affected;
  }

  delete(path: DocPath): Set<DocPath> {
    const previous = this.entries.get(path);
    if (!previous) return new Set();
    const affected = new Set<DocPath>([path]);
    // Referrers are captured before the entry goes: after `unindex` the reverse
    // maps no longer name them, and the whole point is to tell the caller which
    // documents to re-validate.
    for (const p of this.referrersOf(previous.id ?? '')) affected.add(p);
    // Incoming links are keyed by path, which the deletion does not change, so
    // the reverse map answers the same set before and after `unindex` — one
    // call here is enough.
    for (const p of this.linkReferrersOf(path)) affected.add(p);
    for (const rel of previous.relations) {
      for (const target of this.idToPaths(rel.target)) affected.add(target);
    }
    this.collectAffected(affected, previous);
    this.unindex(path, previous);
    this.entries.delete(path);
    return affected;
  }

  /**
   * The paths whose RESULTS can change because of this entry's edges.
   *
   * Computed from BOTH the pre- and post-mutation state (the caller invokes it
   * once before `unindex` and once after `reindex`), because a change to one
   * document flips another's diagnostic in either direction: B pointing at A's
   * old id becomes unresolved when A is renamed, and B's unresolved target
   * becomes resolved when A newly claims the id. The first case is only visible
   * from the pre-mutation reverse maps, which is why the caller collects BEFORE
   * replacing the entry.
   */
  private collectAffected(affected: Set<DocPath>, entry: DocEntry): void {
    if (entry.id) for (const p of this.referrersOf(entry.id)) affected.add(p);
    for (const rel of entry.relations) for (const p of this.idToPaths(rel.target)) affected.add(p);
    for (const link of entry.links) {
      if (!link.path) continue;
      for (const p of this.resolveLinkTargets(link.path, entry.path)) affected.add(p);
    }
  }

  /** Add one entry's derived edges to every reverse map. */
  private reindex(path: DocPath, entry: DocEntry): void {
    if (entry.id) pushSorted(this.byId, entry.id, path);
    for (const rel of entry.relations) {
      if (rel.target) referrersSet(this.referrers, rel.target).add(path);
    }
    for (const link of entry.links) {
      if (!link.path) continue;
      referrersSet(this.linkReferrers, link.path).add(path);
      for (const target of this.linkTargetPaths(link.path, entry.path)) {
        referrersSet(this.referrersByPath, target).add(path);
      }
    }
  }

  /** Subtract one entry's derived edges from every reverse map. */
  private unindex(path: DocPath, entry: DocEntry): void {
    if (entry.id) removeSorted(this.byId, entry.id, path);
    for (const rel of entry.relations) dropReferrer(this.referrers, rel.target, path);
    for (const link of entry.links) {
      if (!link.path) continue;
      dropReferrer(this.linkReferrers, link.path, path);
      for (const target of this.linkTargetPaths(link.path, entry.path)) {
        dropReferrer(this.referrersByPath, target, path);
      }
    }
  }

  /**
   * Paths a raw link destination RESOLVES to — the same resolution MDL401 uses
   * (`resolveLinkPath`), so the reverse map and the diagnostic agree. Falls
   * back to the raw destination when nothing resolves, keying the raw map.
   */
  private linkResolvesTo(linkPath: string, from: DocPath): readonly DocPath[] {
    const resolved = resolveLinkPath(this, from, linkPath);
    return resolved.length > 0 ? [...resolved] : [linkPath];
  }

  /**
   * The indexed paths a raw destination can mean: only those that actually
   * exist in the index.
   *
   * This is the key used by `linkReferrersOf`, so an external destination
   * (`https://example.com`) — which every document in a corpus may share — must
   * never become one of its keys, or a single edit would pull the whole
   * repository into the affected set. Non-resolving destinations are simply not
   * a reverse edge: MDL401 reports them at the link's source instead.
   */
  private linkTargetPaths(linkPath: string, from: DocPath): readonly DocPath[] {
    const out: DocPath[] = [];
    for (const candidate of this.linkResolvesTo(linkPath, from)) {
      if (this.entries.has(candidate)) out.push(candidate);
    }
    return out;
  }

  /**
   * Resolve a raw link destination to the paths whose links land on the same
   * target: the reverse-map direction, used to compute an update's affected set.
   * Only destinations that resolve to an indexed path count — an external URL
   * shared by every document would otherwise pull the whole repository into a
   * single update's affected set.
   */
  private resolveLinkTargets(linkPath: string, from: DocPath): readonly DocPath[] {
    const out = new Set<DocPath>();
    for (const candidate of this.linkTargetPaths(linkPath, from)) {
      const set = this.linkReferrers.get(candidate);
      if (set) for (const p of set) out.add(p);
    }
    return sorted(out);
  }
}

/** Sorted, duplicate-free append into an id's path list. */
function pushSorted(map: Map<string, DocPath[]>, id: string, path: DocPath): void {
  const list = map.get(id);
  if (!list) {
    map.set(id, [path]);
    return;
  }
  if (list.includes(path)) return;
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (list[mid]! < path) lo = mid + 1;
    else hi = mid;
  }
  list.splice(lo, 0, path);
}

function removeSorted(map: Map<string, DocPath[]>, id: string, path: DocPath): void {
  const list = map.get(id);
  if (!list) return;
  const at = list.indexOf(path);
  if (at < 0) return;
  list.splice(at, 1);
  if (list.length === 0) map.delete(id);
}

function referrersSet(map: Map<string, Set<DocPath>>, key: string): Set<DocPath> {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  return set;
}

function dropReferrer(map: Map<string, Set<DocPath>>, key: string, path: DocPath): void {
  const set = map.get(key);
  if (!set) return;
  set.delete(path);
  if (set.size === 0) map.delete(key);
}

function sorted(values: Set<DocPath> | readonly DocPath[] | undefined): readonly DocPath[] {
  if (!values) return EMPTY_PATHS;
  const list = Array.from(values as Iterable<DocPath>);
  if (list.length === 0) return EMPTY_PATHS;
  return list.sort();
}

/** Narrow the public interface back to the implementation the mutators need. */
function impl(index: WorkspaceIndex): IndexImpl {
  if (!(index instanceof IndexImpl)) {
    throw new Error('updateFile/removeFile/updateFiles require the index returned by createWorkspaceIndex');
  }
  return index;
}

/**
 * Run the single-document pipeline and derive the cross-file views.
 *
 * Never throws: a document whose front matter is broken, whose YAML does not
 * parse, or whose Markdown cannot be parsed produces the single-document
 * diagnostics for exactly that, plus an entry with a null id and no edges. The
 * workspace layer then has nothing to check for it, which is correct — the
 * file's own diagnostics already explain why.
 */
function parseDocument(path: DocPath, content: string, config: Config): DocEntry {
  const lineMap = buildLineMap(content);
  const result = validateDocumentSync({ path, content, config });

  const boundary = scanBoundary(content);
  let mdlineage: Record<string, unknown> | null = null;
  let doc: Document | null = null;
  let rawStart = 0;
  let offsets: RelationOffsets = {
    mdlineageStart: 0,
    relationStart: () => undefined,
    relationField: () => undefined,
  };

  if (boundary) {
    rawStart = boundary.rawStart;
    const parsed = parseFrontmatter(boundary.raw, boundary.rawStart, lineMap);
    if (parsed.parsed) {
      const value = parsed.parsed.data ? parsed.parsed.data[config.metadata.key] : undefined;
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        mdlineage = value as Record<string, unknown>;
        doc = parsed.parsed.doc;
        offsets = relationOffsetsOf(parsed.parsed.doc, boundary.rawStart);
      }
    }
  }

  const id = typeof mdlineage?.['id'] === 'string' ? (mdlineage['id'] as string) : null;

  return {
    path,
    id,
    relations: extractRelations(mdlineage),
    links: extractLinks(result.tree, result.bodyStart),
    rawStart,
    anchors: result.tree ? collectAnchors(result.tree) : EMPTY_STRINGS,
    headings: result.tree ? collectHeadingTexts(result.tree) : EMPTY_HEADINGS,
    offsets,
    idOffset: idFieldOffset(doc, config.metadata.key, rawStart),
    lineMap,
    diagnostics: result.diagnostics,
  };
}

/** Offset of the `id` value: the CST node when available, the YAML start otherwise. */
function idFieldOffset(doc: unknown, metadataKey: string, rawStart: number): number {
  const at = mdlineageFieldOffset(doc, 'id');
  // `mdlineageFieldOffset` reads the key named by the schema; a repository with
  // a renamed metadata key has no `id` under that name, and line 1 is the
  // honest fallback.
  void metadataKey;
  return at === null ? rawStart : rawStart + at;
}

/** Read the relation list defensively: the schema layer already reported shape problems. */
function extractRelations(mdlineage: Record<string, unknown> | null): RelationEntry[] {
  if (!mdlineage) return [];
  const value = mdlineage['relations'];
  if (!Array.isArray(value)) return [];
  const out: RelationEntry[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const rel = item as Record<string, unknown>;
    const type = typeof rel['type'] === 'string' ? (rel['type'] as string) : null;
    const target = typeof rel['target'] === 'string' ? (rel['target'] as string) : null;
    if (!type || !target) continue;
    out.push({
      type,
      target,
      ...(typeof rel['reason'] === 'string' ? { reason: rel['reason'] as string } : {}),
      ...(typeof rel['evidence'] === 'string' ? { evidence: rel['evidence'] as string } : {}),
    });
  }
  return out;
}

/**
 * Markdown links from the body: MDL401's domain.
 *
 * `![alt](url)` images are excluded — an image reference is not a document
 * link, and reporting one would be a false positive for every diagram.
 * Reference-style links (`[text][ref]`) are collected through their definition,
 * so `[a]: b.md` is checked like an inline link. Definitions are gathered in a
 * first pass, because a reference may appear anywhere relative to its
 * definition (CommonMark allows a forward reference) and a single in-order walk
 * would miss every link written that way.
 *
 * `bodyStart` shifts the tree's body-relative offsets onto the whole document:
 * MDL401 positions are read against the full-document `lineMap`, so an
 * unshifted offset lands `bodyStart` code units early on any file with front
 * matter.
 */
function extractLinks(tree: Root | null, bodyStart: number): LinkEntry[] {
  if (!tree) return [];
  const definitions = new Map<string, string>();
  const out: LinkEntry[] = [];

  visitTree(tree, (node) => {
    if (node.type !== 'definition') return;
    const def = node as { identifier?: string; label?: string; url?: string };
    const key = def.identifier ?? def.label;
    if (typeof key === 'string' && typeof def.url === 'string') {
      definitions.set(normalizeLabel(key), def.url);
    }
  });

  visitTree(tree, (node) => {
    if (node.type !== 'link' && node.type !== 'linkReference') return;
    const link = node as Link & { identifier?: string };
    const offset = bodyStart + (link.position?.start?.offset ?? 0);
    const url = typeof link.url === 'string' ? link.url : '';
    if (url) {
      out.push(splitLink(url, offset));
      return;
    }
    // A reference-style link carries no url of its own: it resolves through its
    // definition, and an unresolved reference has no destination for this layer
    // to check (a Markdown linter reports that separately).
    const ref = typeof link.identifier === 'string' ? definitions.get(normalizeLabel(link.identifier)) : undefined;
    if (ref) out.push(splitLink(ref, offset));
  });

  return out;
}

/** Split `a.md#anchor` into its two independent parts. */
function splitLink(url: string, offset: number): LinkEntry {
  const hash = url.indexOf('#');
  if (hash < 0) return { url, offset, path: url, anchor: '' };
  if (hash === 0) {
    // A same-page anchor: the link layer's domain is the link PATH, and an
    // in-page anchor is MDL201's concern, so it is kept out of MDL401's set.
    return { url, offset, path: '', anchor: url.slice(1) };
  }
  return { url, offset, path: url.slice(0, hash), anchor: url.slice(hash + 1) };
}

/** GFM reference-label matching is case-insensitive and collapses whitespace. */
function normalizeLabel(label: string): string {
  return label.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** `./sibling.md` and `../up.md` against the linking document's directory. */
function normalizeRelative(fromPath: DocPath, linkPath: string): string {
  const slash = fromPath.lastIndexOf('/');
  const dir = slash >= 0 ? fromPath.slice(0, slash + 1) : '';
  const parts = (dir + linkPath.replace(/^\.\//, '')).split('/');
  const out: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join('/');
}

/** Normalize the accepted input shapes to one iterable of pairs. */
function mapEntries(
  files: Map<DocPath, string> | ReadonlyArray<readonly [DocPath, string]> | Readonly<Record<DocPath, string>>,
): Iterable<readonly [DocPath, string]> {
  if (files instanceof Map) return files.entries();
  if (Array.isArray(files)) return files;
  return Object.entries(files);
}

/**
 * Resolve a link destination against the index.
 *
 * Exact match first (the common case). A `./`- or `../`-relative destination
 * is normalized against the linking document so a tree that points at a
 * sibling or a parent stays correct.
 */
/**
 * Resolve a link destination against the index.
 *
 * Exact match first (the common case). A `./`- or `../`-relative destination is
 * normalized against the linking document, so a tree pointing at a sibling or a
 * parent resolves correctly.
 */
export function resolveLinkPath(index: WorkspaceIndex, fromPath: DocPath, linkPath: string): readonly DocPath[] {
  // Priority when both resolve: document-relative wins (GitHub and mainstream
  // Markdown renderer semantics); exact root-relative match is the fallback.
  // Absolute paths keep exact-match-only behavior.
  const normalized = linkPath.startsWith('/') ? linkPath : normalizeRelative(fromPath, linkPath);
  if (normalized !== linkPath && index.entryOf(normalized)) return [normalized];
  if (index.entryOf(linkPath)) return [linkPath];
  // Not a document, but the caller may have scanned it as a workspace file
  // (a schema, a config …): it exists, so MDL401 must not report it. No entry
  // comes back, which keeps MDL402 from judging fragments of non-Markdown.
  if (normalized !== linkPath && index.knowsPath(normalized)) return [normalized];
  if (index.knowsPath(linkPath)) return [linkPath];
  return EMPTY_PATHS;
}

/**
 * Resolve an evidence anchor against a target document: MDL402's predicate.
 *
 * Returns false when the target is unknown or ambiguous, because MDL302 and
 * MDL301 own those failures respectively — one diagnostic per problem.
 */
export function evidenceResolves(index: WorkspaceIndex, targetId: string, anchor: string): boolean {
  const paths = index.idToPaths(targetId);
  if (paths.length !== 1) return false;
  return index.anchorsOf(paths[0]!).has(anchor);
}
