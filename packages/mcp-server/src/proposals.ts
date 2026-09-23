/**
 * Metadata proposals and the review queue (docs/remark-language-server-solution.md
 * §12: the LLM-facing half of the accept loop).
 *
 * A proposal is what `suggest_metadata` returns: a set of edits to the front
 * matter, marked as a PROPOSAL and never as a diagnostic (§12: "返回结果必须
 * 标记为 proposal，不能混入 diagnostics，也不能直接写权威 Front Matter").
 * `apply_metadata_patch` turns a queued proposal into Front Matter TextEdits
 * plus a reviewable diff — the explicit accept action. It writes nothing by
 * default; `write: true` is the opt-in that persists the reviewed text, and it
 * is guarded in the server so the file it touches is the one the diff shows.
 * Writing without that flag stays the caller's job, after a human has read the
 * diff.
 *
 * The queue is in-memory by design. It lives as long as the server session that
 * created it, which is the lifecycle §12 assigns the "本地待审队列": the model
 * suggests within a session, a human accepts within that session, and nothing
 * outlives a process that was never asked to persist. A disk-backed queue is
 * left to a later milestone, where it needs a consent boundary (where the file
 * lives, who owns it) this one does not have.
 */

import type { Diagnostic } from '@mdlineage/validator';
import { scanBoundary, parseFrontmatter, buildLineMap, positionAt, scanLineEndings } from '@mdlineage/validator';
import type { LineMap } from '@mdlineage/validator';

/** One edit to the front matter, addressed the way §8.3 addresses everything. */
export interface MetadataOperation {
  /**
   * JSON Pointer into the mdlineage object (`/status`, `/relations/0/reason`).
   * Matches the `data.jsonPointer` the diagnostics carry, so a caller that has
   * a diagnostic has the address of the edit that would fix it.
   */
  readonly jsonPointer: string;
  /** The value to write at that pointer. */
  readonly value: unknown;
  /** Why this edit is proposed, so a reviewer can judge it without re-deriving it. */
  readonly rationale: string;
}

/**
 * A suggested change set, exactly as `suggest_metadata` emits it.
 *
 * `id` is the handle the queue keys on and the one argument
 * `apply_metadata_patch` takes.
 */
export interface MetadataProposal {
  readonly id: string;
  /** Path of the document the proposal targets, as given to `suggest_metadata`. */
  readonly path: string;
  readonly operations: readonly MetadataOperation[];
  /**
   * The diagnostics the proposal addresses, by code. A reviewer can see what
   * accepting it clears; a test can assert the loop is closed.
   */
  readonly addresses: readonly string[];
  /** When the proposal entered the queue, for ordering and expiry policy later. */
  readonly createdAt: string;
  /**
   * What produced it. `rules` is the deterministic layer this milestone ships;
   * `llm` is reserved for the retrieval/LLM enhancement §12 allows, which stays
   * a stub here so the field exists when the enhancement lands.
   */
  readonly source: 'rules' | 'llm';
  /** The model or engine behind it, informational only. */
  readonly generator?: string;
  /** SHA-256 of the document text the proposal was derived from. */
  readonly contentHash: string;
}

/** A queued proposal plus its accept state. */
interface QueuedProposal {
  readonly proposal: MetadataProposal;
  accepted: boolean;
  /** The buffer snapshot suggest_metadata analysed, when it was given inline. */
  sourceContent?: string;
  /**
   * Whether the document was on disk when the proposal was made.
   *
   * This is what tells a proposal over a never-saved buffer from one over a
   * document that has since been deleted or renamed: the write may create the
   * former and must never resurrect the latter.
   */
  readonly sourceOnDisk: boolean;
}

/**
 * A proposal as `accept` hands it back: the queue entry's source facts, so a
 * requeue can carry them over unchanged.
 */
export type AcceptedProposal = MetadataProposal & {
  /** The buffer snapshot suggest_metadata analysed, when it was given inline. */
  sourceContent?: string;
  /** Whether the document was on disk when the proposal was made. */
  sourceOnDisk: boolean;
};

/** Monotonic proposal id, so the queue's ids are unique within a session. */
let sequence = 0;

/** Reset the id counter. Test-only: a suite needs deterministic ids. */
export function resetProposalIds(): void {
  sequence = 0;
}

/**
 * The in-memory review queue.
 *
 * Kept per server instance (see `createMcpServer`), so two MCP sessions never
 * see each other's proposals and a session's queue dies with it.
 */
export class ProposalQueue {
  private readonly entries = new Map<string, QueuedProposal>();

  /**
   * Add a proposal and return it with its id assigned.
   *
   * `sourceContent` carries the exact buffer the proposal was built from, so
   * `apply` works on unsaved documents that never reached the disk.
   * `sourceOnDisk` records whether that document had a file behind it, which
   * is what separates a never-saved buffer from a deleted one; it defaults to
   * "it did", because a proposal enqueued without a snapshot was necessarily
   * derived from the disk.
   */
  enqueue(
    proposal: Omit<MetadataProposal, 'id' | 'createdAt'>,
    sourceContent?: string,
    sourceOnDisk: boolean = sourceContent === undefined,
  ): MetadataProposal {
    const id = `proposal-${++sequence}`;
    const full: MetadataProposal = { ...proposal, id, createdAt: new Date().toISOString() };
    this.entries.set(id, { proposal: full, accepted: false, sourceContent, sourceOnDisk });
    return full;
  }

  /** Every queued proposal, newest last. */
  list(): readonly MetadataProposal[] {
    return [...this.entries.values()].map((e) => e.proposal);
  }

  /** A proposal by id, or null when the id was never queued (or was applied). */
  get(id: string): MetadataProposal | null {
    return this.entries.get(id)?.proposal ?? null;
  }

  /** Remove a proposal from the queue (accepted, rejected or superseded). */
  remove(id: string): boolean {
    return this.entries.delete(id);
  }

  /** True when `id` names a proposal that is still awaiting review. */
  has(id: string): boolean {
    return this.entries.has(id);
  }

  /** Mark a proposal accepted and drop it: applying it is the caller's step. */
  accept(id: string): AcceptedProposal | null {
    const entry = this.entries.get(id);
    if (!entry) return null;
    entry.accepted = true;
    this.entries.delete(id);
    return entry.sourceContent === undefined
      ? { ...entry.proposal, sourceOnDisk: entry.sourceOnDisk }
      : { ...entry.proposal, sourceContent: entry.sourceContent, sourceOnDisk: entry.sourceOnDisk };
  }
}

/**
 * Build proposals from a document's diagnostics.
 *
 * Deterministic, and deliberately the minimum: the schema's own required list
 * and the config's `reasonRequired` relation switches are the two gaps a
 * machine can fill without guessing, so those are what this fills. Everything
 * that needs judgement — which target a relation should name, what topic
 * describes the document — is left to the LLM enhancement hook, which returns
 * nothing in this milestone.
 *
 * Values are chosen from the config's vocabulary when one constrains the field,
 * so a proposal never suggests a value that would produce a fresh MDL103.
 */
export function buildProposals(
  diagnostics: readonly Diagnostic[],
  options: { vocabulary: { kinds: readonly string[]; statuses: readonly string[] }; contentHash: string; path: string },
): Omit<MetadataProposal, 'id' | 'createdAt'> {
  const operations: MetadataOperation[] = [];
  const addresses: string[] = [];

  const missing = new Map<string, { pointer: string; index?: number }>();
  for (const diag of diagnostics) {
    if (diag.code !== 'MDL102') continue;
    const data = diag.data as { jsonPointer?: string; missingProperty?: string } | undefined;
    const pointer = data?.jsonPointer;
    const field = data?.missingProperty;
    if (!pointer || !field) continue;
    // `/relations/0` with `missingProperty: reason` is the if/then shape; the
    // pointer the diagnostic carries is the relation entry, so the edit lands
    // one level deeper.
    const relation = /^\/relations\/(\d+)$/.exec(pointer);
    if (relation) {
      missing.set(`relation-${relation[1]!}-reason`, {
        pointer: `/relations/${relation[1]}/reason`,
        index: Number(relation[1]),
      });
    } else {
      missing.set(`root-${field}`, { pointer: `/${field}` });
    }
  }

  const { kinds, statuses } = options.vocabulary;

  for (const { pointer, index } of missing.values()) {
    const isReason = pointer.endsWith('/reason');
    if (isReason) {
      // A reason is prose: a placeholder keeps the schema satisfied and makes
      // the human's job visible in the diff. The value is marked as needing
      // replacement by its own text.
      operations.push({
        jsonPointer: pointer,
        value: 'TODO: explain this relationship (proposed by mdlineage)',
        rationale: `MDL102 requires a reason on relation #${index ?? 0}; a strong relation type is not valid without one.`,
      });
    } else {
      const field = pointer.slice(1);
      // `kind` and `status` take the vocabulary's first member — the same value
      // a generator would reach for, and the reason names the list so the
      // reviewer knows what the choice was constrained by.
      const value = field === 'kind' ? kinds[0] : field === 'status' ? statuses[0] : '';
      if (typeof value !== 'string' || value.length === 0) continue;
      operations.push({
        jsonPointer: pointer,
        value,
        rationale: `MDL102 requires '${field}'; proposed from the configured vocabulary (first member of ${field === 'kind' ? 'kinds' : 'statuses'}).`,
      });
    }
    addresses.push('MDL102');
  }

  return {
    path: options.path,
    operations,
    addresses: [...new Set(addresses)],
    source: 'rules',
    generator: 'mdlineage/suggest_metadata/rules-v1',
    contentHash: options.contentHash,
  };
}

/**
 * A Front Matter TextEdit, in the editor vocabulary (§11's LSP-flavoured
 * coordinates: 0-based line and character).
 */
export interface FrontMatterTextEdit {
  /** 0-based line the edit starts on. */
  readonly line: number;
  /** 0-based character the edit starts at. */
  readonly character: number;
  /** Text to insert at that position. Empty when the edit is a pure deletion. */
  readonly newText: string;
  /** Text the edit replaces, empty for a pure insertion. */
  readonly oldText: string;
}

/** The result of applying a proposal: what to review, and what changed. */
export interface AppliedPatch {
  readonly proposalId: string;
  readonly path: string;
  /** The edits, in document order, for an editor or a caller to apply. */
  readonly edits: readonly FrontMatterTextEdit[];
  /** The unified diff a human reviews before anything is written. */
  readonly diff: string;
  /** The document text the edits would produce. */
  readonly patchedContent: string;
  /** The proposal that was applied. */
  readonly proposal: MetadataProposal;
}

/**
 * Turn a queued proposal into edits against `content`, and never touch a file.
 *
 * Insertions are placed by the YAML CST, not by string surgery: each operation
 * lands at the end of the mapping (or sequence item) its JSON Pointer names, at
 * that container's own indentation, so the produced front matter is still valid
 * YAML and still indented the way the document is. Operations are applied
 * deepest-last-in-the-buffer first — every offset was located against the
 * original text, so inserting from the highest one downwards leaves the lower
 * ones valid. Applying them front-to-back instead would write the second
 * insertion into the middle of the first: two relation reasons in one document
 * used to produce `reason: "TODO: … relations` / `reason: "…hip …"` and a
 * document no YAML parser accepts.
 *
 * An operation whose key the document already carries is dropped rather than
 * inserted: a second `reason` in one mapping is a YAML duplicate key, and
 * MDL102 would still report the gap the proposal claimed to close.
 *
 * Returns null when the id is unknown, when the document has no mdlineage map
 * to insert into, or when the proposal carries no operations — each is a
 * caller-visible condition, not an exception.
 */
export function applyProposalToContent(
  proposal: MetadataProposal,
  content: string,
): { edits: FrontMatterTextEdit[]; patched: string; applied: readonly string[] } | null {
  const located = locateInsertions(proposal, content);
  if (!located || located.length === 0) return null;

  const ordered = [...located].sort((a, b) => b.offset - a.offset);
  let text = content;
  const landed: { spot: InsertionSpot; edit: FrontMatterTextEdit }[] = [];

  for (const spot of ordered) {
    const before = text.slice(0, spot.offset);
    const after = text.slice(spot.offset);
    landed.push({
      spot,
      edit: { line: spot.line, character: spot.column, newText: spot.text, oldText: '' },
    });
    text = before + spot.text + after;
  }

  // Document order, so a caller applying the edits top-down still sees valid
  // positions even though they were applied bottom-up.
  landed.reverse();
  return {
    edits: landed.map((entry) => entry.edit),
    patched: text,
    applied: landed.map((entry) => entry.spot.jsonPointer),
  };
}

/** One insertion, positioned in the document. */
interface InsertionSpot {
  readonly jsonPointer: string;
  readonly key: string;
  readonly value: unknown;
  /** Absolute document offset to insert before. */
  readonly offset: number;
  readonly indent: string;
  /** 0-based line and character of the insertion, for the TextEdit. */
  readonly line: number;
  readonly column: number;
  /** The exact text to insert at line:column. */
  readonly text: string;
}

/**
 * Place every operation of a proposal in the document.
 *
 * Root-level pointers (`/status`) go at the end of the mdlineage map. A
 * relation-field pointer (`/relations/N/reason`) goes at the end of that
 * relation's own mapping, so the new key joins the relation instead of the
 * document. An operation whose target key the document already carries is
 * omitted — inserting it would produce a YAML duplicate key, which is the
 * opposite of a repair. Returns null when the document has no mdlineage map,
 * and omits an operation whose pointer cannot be located — reported by the
 * caller, never silently mis-inserted.
 */
export function locateInsertions(
  proposal: MetadataProposal,
  content: string,
): InsertionSpot[] | null {
  const boundary = scanBoundary(content);
  if (!boundary || boundary.closeStart === null) return null;
  const lineMap = buildLineMap(content);
  const parsed = parseFrontmatter(boundary.raw, boundary.rawStart, lineMap);
  if (!parsed.parsed || !parsed.parsed.data) return null;

  const root = parsed.parsed.doc.contents as { items?: unknown[] } | null;
  const mapPair = root?.items?.find((p) => keyValue(p) === MDLINEAGE_KEY) as
    | { value?: { items?: unknown[]; range?: readonly [number, number, number] } }
    | undefined;
  if (!mapPair || !mapPair.value || !Array.isArray(mapPair.value.items)) return null;

  const spots: InsertionSpot[] = [];

  for (const op of proposal.operations) {
    const parts = op.jsonPointer.split('/').filter((p) => p.length > 0);
    if (parts.length === 0) continue;

    if (parts.length === 1) {
      // A key the document already has must not be written twice.
      if (mapPair.value.items.some((p) => keyValue(p) === parts[0]!)) continue;
      const end = mapPair.value.range?.[1];
      if (typeof end !== 'number') continue;
      const offset = boundary.rawStart + end;
      const at = positionAt(lineMap, offset);
      spots.push({
        jsonPointer: op.jsonPointer,
        key: parts[0]!,
        value: op.value,
        offset,
        indent: containerIndent(lineMap, mapPair.value.items, boundary.rawStart),
        line: at.line - 1,
        column: at.column - 1,
        text: `${containerIndent(lineMap, mapPair.value.items, boundary.rawStart)}${parts[0]!}: ${formatValue(op.value)}${eolAt(content, offset)}`,
      });
      continue;
    }

    // `/relations/N/field`: the container is the Nth sequence item's mapping.
    const relationMatch = /^relations\/(\d+)$/.exec(parts.slice(0, -1).join('/'));
    if (!relationMatch) continue;
    const relationsPair = mapPair.value.items.find((p) => keyValue(p) === 'relations') as
      | { value?: { items?: unknown[] } }
      | undefined;
    const item = relationsPair?.value?.items?.[Number(relationMatch[1])];
    if (!item) continue;
    // A block sequence item carries its mapping directly (`item.items`); a flow
    // item wraps it in `node`. Block form is what the fixtures and every
    // document the validator accepts use, but both are walked.
    const itemMap = mapOfItem(item);
    if (!itemMap) continue;
    // The relation already carries the key: MDL102's pointer is the entry, so a
    // relation that has a `reason` and lacks a `target` must not gain a second
    // `reason` (a YAML duplicate key that MDL102 would still report).
    if (itemMap.items.some((p) => keyValue(p) === parts[parts.length - 1]!)) continue;

    // The item's CST range ends at the last byte of its last key, so the new
    // line goes after the whole item — indented like the item's own keys, which
    // is what makes the new key a sibling of `target` rather than a child of
    // the document's mdlineage map.
    const siblingIndent = containerIndent(lineMap, itemMap.items, boundary.rawStart);

    const itemEnd = rangeEnd(item);
    if (itemEnd === null) continue;
    const endOffset = boundary.rawStart + itemEnd;
    // The item's range covers its last key but NOT its line terminator, so
    // inserting at itemEnd would glue the new key onto the `target:` line and
    // corrupt the YAML. The insertion goes at the start of the NEXT line —
    // still inside the sequence, because YAML keeps it at the item's indent.
    // rangeEnd(item) includes the item's trailing terminator, so the sibling
    // key goes right BEFORE that terminator: on its own line, directly under
    // `target: …`, with the front matter closer pushed down intact. The whole
    // terminator is stepped over (a CRLF pair, not just its LF), so a CRLF
    // document keeps its CR on the line it ends.
    const beforeTerminator = terminatorStartBefore(content, endOffset);
    const endLine = positionAt(lineMap, beforeTerminator);
    spots.push({
      jsonPointer: op.jsonPointer,
      key: parts[parts.length - 1]!,
      value: op.value,
      offset: beforeTerminator,
      indent: siblingIndent,
      line: endLine.line - 1,
      column: endLine.column - 1,
      text: `${content.slice(beforeTerminator, endOffset)}${siblingIndent}${parts[parts.length - 1]!}: ${formatValue(op.value)}`,
    });
  }

  return spots;
}

/** A sequence item's mapping, block or flow form. */
function mapOfItem(item: unknown): { items: unknown[] } | null {
  if (!item || typeof item !== 'object') return null;
  const direct = (item as { items?: unknown[] }).items;
  if (Array.isArray(direct)) return { items: direct };
  const wrapped = (item as { node?: { items?: unknown[] } }).node;
  const inner = wrapped ? (wrapped as { items?: unknown[] }).items : undefined;
  return Array.isArray(inner) ? { items: inner } : null;
}

/** The `mdlineage` key's own name, as the schema's default config names it. */
const MDLINEAGE_KEY = 'mdlineage';

/** A key node's value, the way the CST exposes it to a pointer lookup. */
function keyValue(pair: unknown): unknown {
  return (pair as { key?: { value?: unknown } } | null)?.key?.value;
}

/** End offset of a CST node, or null when the node carries no range. */
function rangeEnd(node: unknown): number | null {
  const range = (node as { range?: readonly [number, number, number] } | null)?.range;
  return range && typeof range[1] === 'number' ? range[1] : null;
}

/**
 * The 1-based line an absolute offset falls on.
 *
 * An offset that lands exactly on a line start is the boundary: it belongs to
 * the NEXT line (the byte before it was the previous line's terminator), which
 * is what makes "insert at the end of the mdlineage map" put the new key on the
 * fence's line or before it consistently.
 */
function lineOf(lineMap: LineMap, offset: number): number {
  const starts = lineMap.lineStarts;
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (starts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/** The offset of the line CONTAINING `offset`'s start, absolute. */
function lineStartOf(lineMap: LineMap, offset: number): number {
  return lineMap.lineStarts[lineOf(lineMap, offset) - 1] ?? 0;
}

/**
 * A container's own indentation, read from the column its first key sits at.
 *
 * The container is the mapping the JSON Pointer names, and its indentation is a
 * sibling key's column minus its line's start. The CST offsets are relative to
 * the front matter slice and the line table is absolute, so the slice's origin
 * (`rawStart`) is added to the key before the subtraction. Falls back to two
 * spaces for a container with no keys to measure.
 */
function containerIndent(
  lineMap: LineMap,
  items: unknown[],
  rawStart: number,
  fallback = '  ',
): string {
  const first = items[0] as { key?: { range?: readonly [number, number, number] } } | undefined;
  const keyStart = first?.key?.range?.[0];
  if (typeof keyStart !== 'number') return fallback;
  const absolute = rawStart + keyStart;
  const lineStart = lineStartOf(lineMap, absolute);
  return ' '.repeat(Math.max(0, absolute - lineStart));
}

/**
 * The line ending an insertion at `offset` must use.
 *
 * The terminator that ends the line the insertion joins decides it, so a CRLF
 * document never gains a bare LF (MDL601) from a patch that claims to add one
 * field. A document with no terminator to read falls back to its own style.
 */
function eolAt(content: string, offset: number): string {
  if (offset > 0 && content.charCodeAt(offset - 1) === 0x0a) {
    return offset > 1 && content.charCodeAt(offset - 2) === 0x0d ? '\r\n' : '\n';
  }
  return scanLineEndings(content).style === 'crlf' ? '\r\n' : '\n';
}

/**
 * Offset of the line terminator that ends at `end`, stepping over a CRLF pair
 * as one unit so an insertion placed before it does not strand the CR.
 */
function terminatorStartBefore(content: string, end: number): number {
  let start = end;
  while (start > 0) {
    const code = content.charCodeAt(start - 1);
    if (code !== 0x0a && code !== 0x0d) break;
    start -= 1;
  }
  return start;
}

/** Render a proposal value the way YAML writes it. */
function formatValue(value: unknown): string {
  if (typeof value !== 'string') return JSON.stringify(value);
  // A `: ` inside a plain scalar is a mapping-value indicator in YAML — an
  // unquoted `reason: TODO: explain…` fails to parse. Quote anything that
  // carries one (or would otherwise start a YAML structure).
  if (/[:#{}\[\]&*!|>'"%@`,]|^\s|\s$/.test(value)) {
    return JSON.stringify(value);
  }
  return value;
}

/**
 * A unified diff of the patched document, for review.
 *
 * Deliberately small: a real diff engine is a dependency this package does not
 * need, and the queue's promise is "the caller sees what would change", which
 * a before/after pair of the touched lines delivers.
 */
export function diffOf(original: string, patched: string): string {
  const a = original.split('\n');
  const b = patched.split('\n');
  const out: string[] = [];

  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    const av = a[i];
    const bv = b[j];
    if (av === bv) {
      i++;
      j++;
      continue;
    }
    if (j < b.length) {
      out.push(`+ ${bv}`);
      j++;
    }
    if (i < a.length) {
      out.push(`- ${av}`);
      i++;
    }
  }
  return out.join('\n');
}
