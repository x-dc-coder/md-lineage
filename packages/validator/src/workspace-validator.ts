/**
 * Workspace-layer rules (docs/remark-language-server-solution.md §4.5).
 *
 * Everything here reads the derived graph from `workspace-index.ts` and nothing
 * else, so the rules are pure functions of (index, options) and produce the same
 * diagnostics from the CLI's full-worktree pass, from an LSP's incremental pass
 * over an affected set, or from a test.
 *
 * Rules implemented (§8.1):
 *   - MDL301  an id claimed by more than one document
 *   - MDL302  a relation target resolving to no known id
 *   - MDL103  a self-relation on a type configured `selfReference: 'forbidden'`
 *             (a workspace-layer predicate reusing the schema-layer code; see
 *             `mdlSelfReference` for why and what a new code would change)
 *   - MDL304  a `reasonRequired` relation whose reason is blank (the semantic
 *             "present but empty" case; the schema layer owns "absent", MDL102)
 *   - MDL305  a cycle in a relation type configured `cycles: 'forbidden'`,
 *             reported once per strongly connected component
 *   - MDL401  a Markdown link whose path resolves to no indexed document
 *   - MDL402  a relation evidence anchor absent from the target's headings
 *
 * MDL303 stays unreachable (reserved): the index resolves targets by id only and
 * MDL301 guarantees id uniqueness, so an ambiguous target cannot exist.
 *
 * Comparison note for the whole layer: ids compare CASE-SENSITIVELY. The index
 * keeps every id as authored, so two documents differing only in case are two
 * distinct ids, and a relation spelled in a different case does not resolve.
 *
 * Every rule is defensive: a document that failed to parse has a null id and no
 * edges, so it contributes nothing here, and no input can make this module throw.
 */

import type { Config } from './config.js';
import type { Diagnostic } from './diagnostic.js';
import { layerOf, severityOf } from './diagnostic.js';
import type { LineMap } from './source-map.js';
import { rangeAt } from './source-map.js';
import type { DocEntry, DocPath, WorkspaceIndex } from './workspace-index.js';
import { resolveLinkPath } from './workspace-index.js';
import type { Baseline } from './baseline.js';
import { suppressWithBaseline } from './baseline.js';

/** A read-only empty neighbour list, reused for every node without edges. */
const EMPTY_PATHS: readonly string[] = Object.freeze([]);

/** Diagnostics carrying the file they belong to: the workspace report unit. */
export interface WorkspaceDiagnostic extends Diagnostic {
  /** Path of the document the diagnostic reports, as keyed in the index. */
  readonly path: DocPath;
}

/** Options for a workspace validation pass. */
export interface ValidateWorkspaceOptions {
  /**
   * Baseline of accepted legacy violations (docs/progress.md open issue #2).
   * A covered diagnostic is dropped entirely — see `baseline.ts` for why total
   * silence beats an information-level notice.
   */
  readonly baseline?: Baseline;
  /**
   * Validate only these paths. When omitted, every indexed document is
   * validated. The caller owns the set: an incremental pass passes the affected
   * set from `updateFile`, which is exactly the documents whose own results can
   * have changed. Graph-level rules (MDL305) still run over the whole index,
   * because a cycle is a property of the repository, not of a subset.
   */
  readonly paths?: ReadonlyArray<DocPath>;
  /** False to drop the single-document diagnostics the index already computed. */
  readonly includeSingleDocument?: boolean;
}

/**
 * Validate the workspace: all cross-file rules, plus the single-document
 * diagnostics already produced at index time.
 *
 * Never throws. A document whose parse produced MDL001/MDL002 has a null id and
 * no relation edges, so it yields its own diagnostics and no workspace codes.
 */
export function validateWorkspace(
  index: WorkspaceIndex,
  options: ValidateWorkspaceOptions = {},
): WorkspaceDiagnostic[] {
  const config = index.config;
  const out: WorkspaceDiagnostic[] = [];

  const scope = options.paths ? new Set(options.paths) : null;
  for (const path of index.paths()) {
    if (scope && !scope.has(path)) continue;
    const entry = index.entryOf(path);
    if (!entry) continue;

    if (options.includeSingleDocument !== false) {
      for (const diag of entry.diagnostics) out.push({ ...diag, path });
    }
    out.push(...mdl301(entry, index, config), ...mdl302(entry, index, config), ...mdlSelfReference(entry, index, config));
    out.push(...mdl304(entry, config), ...mdl401(entry, index, config), ...mdl402(entry, index, config));
  }

  // MDL305 is a property of the graph: restricting it to the affected subset
  // would let a cycle survive an incremental pass, so it always walks the whole
  // index and the per-pass scope does not apply to it.
  out.push(...mdl305(index, config));

  const baseline = options.baseline;
  const reported = baseline ? suppressWithBaseline(out, baseline) : out;
  return reported.slice().sort(byReportOrder);
}

/** Order the report by path then position, so a consumer's output is stable. */
function byReportOrder(a: WorkspaceDiagnostic, b: WorkspaceDiagnostic): number {
  return a.path.localeCompare(b.path) || a.range.start.offset - b.range.start.offset || a.code.localeCompare(b.code);
}

/**
 * MDL301 — duplicate document id.
 *
 * Reported on every document claiming the id EXCEPT the first in sorted path
 * order. Reasons:
 *   - "the first occurrence is canonical" is the only policy the validator can
 *     state without a new config knob, and sorted order makes it deterministic
 *     across machines and runs (filesystem or git order would not be);
 *   - every LATER document is told about the collision, because each of them is
 *     the one a developer must act on — reporting only the last would point at
 *     a different file as soon as the first is renamed, which makes the
 *     diagnostic flicker instead of guide.
 * `data.claimedBy` names the winning document for a fixer or an LSP rename.
 */
function mdl301(entry: DocEntry, index: WorkspaceIndex, config: Config): WorkspaceDiagnostic[] {
  if (entry.id === null) return [];
  const all = index.idToPaths(entry.id);
  if (all.length < 2) return [];
  if (all.indexOf(entry.path) <= 0) return []; // the first claimant is canonical

  return [
    build(
      'MDL301',
      `Duplicate document id: ${entry.id} (first claimed by ${all[0]})`,
      entry,
      entry.idOffset,
      config,
      { id: entry.id, claimedBy: all[0], claimants: [...all] },
    ),
  ];
}

/**
 * MDL302 — relation target resolves to no known id.
 *
 * Reported on the relation's declaration in the SOURCE document. A target the
 * schema layer already rejected as malformed (MDL103) cannot resolve either way
 * and is skipped, so one problem keeps one diagnostic.
 *
 * Note on comparison: ids compare CASE-SENSITIVELY throughout the workspace
 * layer. The index never normalizes an id, so `docs.Foo` and `docs.foo` are two
 * distinct ids (the second claim of either is MDL301-free) and a relation
 * spelled with different case is MDL302, not a match.
 */
function mdl302(entry: DocEntry, index: WorkspaceIndex, config: Config): WorkspaceDiagnostic[] {
  const out: WorkspaceDiagnostic[] = [];
  for (let i = 0; i < entry.relations.length; i++) {
    const rel = entry.relations[i]!;
    if (index.idToPaths(rel.target).length > 0) continue;
    const where = entry.offsets.relationStart(i) ?? entry.offsets.mdlineageStart;
    out.push(
      build('MDL302', `Relation target does not exist: ${rel.target}`, entry, where, config, {
        type: rel.type,
        target: rel.target,
        index: i,
      }),
    );
  }
  return out;
}

/**
 * MDL103 — a relation whose target is the document itself, for a relation type
 * configured `selfReference: 'forbidden'`.
 *
 * Code choice: MDL103 is a schema-layer code by registry ("Invalid type,
 * pattern, or value") and this is a workspace-layer predicate — the target
 * resolves, so no schema or pattern rejects it, and only the graph knows the
 * edge points back at its own source. The registry has no free code in the
 * workspace block (MDL303 is alias-resolution reserved, MDL304 is the reason
 * rule, MDL305 is the cycle rule), so MDL103 is REUSED here with `layer:
 * 'workspace-semantic'` and a message that names the config key, which keeps
 * the report self-explanatory without inventing an unregistered code. A future
 * schema version that opens the MDL3xx block should give this its own number;
 * the `data` shape carries everything a rename would need to keep consumers
 * whole.
 *
 * Reported at the relation's declaration, once per offending relation.
 */
function mdlSelfReference(entry: DocEntry, index: WorkspaceIndex, config: Config): WorkspaceDiagnostic[] {
  if (entry.id === null) return [];
  const out: WorkspaceDiagnostic[] = [];
  for (let i = 0; i < entry.relations.length; i++) {
    const rel = entry.relations[i]!;
    if (config.relations[rel.type]?.selfReference !== 'forbidden') continue;
    // Only a target that resolves to THIS document is a self-reference; a
    // dangling one is MDL302, and a target resolving elsewhere is not it.
    const targets = index.idToPaths(rel.target);
    if (!targets.includes(entry.path)) continue;
    const where = entry.offsets.relationStart(i) ?? entry.offsets.mdlineageStart;
    out.push(
      build(
        'MDL103',
        `self-reference is forbidden for relation type '${rel.type}'`,
        entry,
        where,
        config,
        { type: rel.type, target: rel.target, index: i, selfReference: true },
      ),
    );
  }
  return out;
}

/**
 * MDL304 — a `reasonRequired` relation with a blank reason.
 *
 * The semantic counterpart of the schema's structural check, and the two are
 * deliberately non-overlapping:
 *   - MDL102 (schema layer) fires when the `reason` key is ABSENT from a strong
 *     relation — the if/then requirement;
 *   - MDL304 fires here when the key is PRESENT but empty or pure whitespace,
 *     which `minLength: 1` cannot reach once the value is not a string, and
 *     which a repository also wants for a type it promoted to `reasonRequired`
 *     without changing the JSON schema.
 * A non-string reason is MDL103's domain and is skipped here.
 */
function mdl304(entry: DocEntry, config: Config): WorkspaceDiagnostic[] {
  const out: WorkspaceDiagnostic[] = [];
  for (let i = 0; i < entry.relations.length; i++) {
    const rel = entry.relations[i]!;
    if (config.relations[rel.type]?.reasonRequired !== true) continue;
    const reason = rel.reason;
    if (reason === undefined) continue; // absent key: MDL102 owns it
    if (typeof reason !== 'string') continue; // wrong type: MDL103 owns it
    if (reason.trim().length > 0) continue;
    const where =
      entry.offsets.relationField(i, 'reason') ?? entry.offsets.relationStart(i) ?? entry.offsets.mdlineageStart;
    out.push(
      build('MDL304', `Relation ${rel.type} → ${rel.target} has an empty reason`, entry, where, config, {
        type: rel.type,
        target: rel.target,
        index: i,
      }),
    );
  }
  return out;
}

/**
 * MDL305 — a cycle in a relation type configured `cycles: 'forbidden'`.
 *
 * Reported PER STRONGLY CONNECTED COMPONENT, exactly one diagnostic each, and
 * only for a component that actually carries a forbidden edge. The previous
 * semantics enumerated every simple cycle, which is exponential: a complete
 * graph of 9 documents overflows the stack and 20 documents with out-degree 2
 * produces over 13000 diagnostics. The per-SCC report is the bounded form of
 * the same statement — a non-trivial SCC of forbidden edges necessarily
 * contains a cycle, and every document of the component is part of it — so one
 * diagnostic names the whole loop instead of one per rotation of it.
 *
 * The diagnostic is anchored on the component's lexicographically smallest
 * member path (deterministic across runs and machines) and its `data` carries
 * the full membership: `cycle` is the component's ids in lexicographic order,
 * `size` their count. The message lists the ids as a representative closed
 * walk (each member followed by the first, so the loop shape is visible) and
 * truncates the listing at 5 plus "… (N documents)" when the component is
 * large, because a 9000-member component's message is not a message anyone
 * reads.
 *
 * Detection is Tarjan's SCC over the per-type directed graph, iteratively —
 * edge direction is fixed per type (frontmatter-spec), which is what makes
 * "cycle" well-defined, and an explicit frame stack keeps a long chain from
 * overflowing the call stack.
 */
function mdl305(index: WorkspaceIndex, config: Config): WorkspaceDiagnostic[] {
  const forbiddenTypes: string[] = [];
  for (const [type, sw] of Object.entries(config.relations)) {
    if (sw?.cycles === 'forbidden') forbiddenTypes.push(type);
  }
  if (forbiddenTypes.length === 0) return [];

  const out: WorkspaceDiagnostic[] = [];

  for (const type of forbiddenTypes) {
    // The graph is rebuilt per type: a loop mixing two types is not a cycle of
    // either relation's semantics. Nodes are the ids that carry an edge of this
    // type; edges are the ids those edges resolve to.
    const graph = new Map<string, string[]>();
    for (const path of index.paths()) {
      const entry = index.entryOf(path);
      if (!entry || entry.id === null) continue;
      const edges: string[] = [];
      for (const rel of entry.relations) {
        if (rel.type !== type) continue;
        for (const targetPath of index.idToPaths(rel.target)) {
          const targetId = index.pathToId(targetPath);
          if (targetId !== null) edges.push(targetId);
        }
      }
      if (edges.length > 0) graph.set(entry.id, edges);
    }

    for (const component of stronglyConnectedComponents(graph)) {
      // A lone node is only a cycle when it points at itself, in which case the
      // component's single member IS the loop.
      if (component.length === 1 && !graph.get(component[0]!)?.includes(component[0]!)) continue;

      // Every member path, sorted, so the anchor and `data.cycle` are stable.
      const paths: DocPath[] = [];
      for (const id of component) {
        for (const p of index.idToPaths(id)) paths.push(p);
      }
      paths.sort();
      const anchorPath = paths[0]!;
      const entry = index.entryOf(anchorPath);
      if (!entry) continue;

      const at = entry.relations.findIndex((r) => r.type === type);
      const where =
        at >= 0 ? entry.offsets.relationStart(at) ?? entry.offsets.mdlineageStart : entry.offsets.mdlineageStart;

      out.push(
        build(
          'MDL305',
          `${type} ${cycleMessage(component)}`,
          entry,
          where,
          config,
          { type, cycle: [...component], size: component.length },
        ),
      );
    }
  }

  return out;
}

/**
 * The human-readable loop shape of an SCC: each member followed by the first,
 * so the message reads as a closed walk. Sorted members keep it deterministic,
 * and a component larger than five is truncated to its head plus a count — the
 * full membership is in `data.cycle`.
 */
function cycleMessage(members: readonly string[]): string {
  const LIMIT = 5;
  const head = members.slice(0, LIMIT);
  const tail = head.length < members.length ? `… (${members.length} documents)` : head[0]!;
  const noun = members.length === 1 ? 'document' : 'documents';
  return `cycle among ${members.length} ${noun}: ${[...head, tail].join(' → ')}`;
}

/**
 * Strongly connected components of a directed graph, Tarjan, iterative.
 *
 * Yields one sorted-id array per component. Components are emitted as they
 * close, so the caller sees no particular order; each component's ids are
 * sorted, which is the order `mdl305` reports them in. An explicit frame stack
 * keeps the traversal bounded for a long chain.
 */
function stronglyConnectedComponents(graph: Map<string, readonly string[]>): string[][] {
  const out: string[][] = [];
  let index = 0;
  const indices = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const frames: Array<{ node: string; next: number }> = [];

  for (const start of graph.keys()) {
    if (indices.has(start)) continue;
    frames.push({ node: start, next: 0 });

    while (frames.length > 0) {
      const frame = frames[frames.length - 1]!;
      if (!indices.has(frame.node)) {
        indices.set(frame.node, index);
        low.set(frame.node, index);
        index += 1;
        stack.push(frame.node);
        onStack.add(frame.node);
      }

      const neighbors = graph.get(frame.node) ?? EMPTY_PATHS;
      let descended = false;
      while (frame.next < neighbors.length) {
        const target = neighbors[frame.next++]!;
        if (!indices.has(target)) {
          // A node the graph does not name as a source is still reachable and
          // belongs to no component, so only the graph's own nodes descend.
          if (graph.has(target)) {
            frames.push({ node: target, next: 0 });
            descended = true;
            break;
          }
          continue;
        }
        if (onStack.has(target)) {
          low.set(frame.node, Math.min(low.get(frame.node)!, low.get(target)!));
        }
      }
      if (descended) continue;

      if (low.get(frame.node) === indices.get(frame.node)) {
        const component: string[] = [];
        let top: string | undefined;
        do {
          top = stack.pop();
          if (top !== undefined) {
            onStack.delete(top);
            component.push(top);
          }
        } while (top !== undefined && top !== frame.node);
        component.sort();
        out.push(component);
      }

      frames.pop();
      const parent = frames[frames.length - 1];
      if (parent) low.set(parent.node, Math.min(low.get(parent.node)!, low.get(frame.node)!));
    }
  }

  return out;
}

/**
 * MDL401 — a Markdown link whose path resolves to no indexed document.
 *
 * Excluded by design:
 *   - destinations with a URL scheme (`http(s)://`, `mailto:`, `ftp:` …) —
 *     outside the repository, and not MDLineage's to judge;
 *   - same-page anchors (`#section`) — an in-page anchor is MDL201's domain;
 *   - an empty path, which covers a bare `#`.
 * A link carrying BOTH a path and an anchor is split (`splitLink`): the path is
 * checked here and the fragment by MDL402 below, so one bad link produces at
 * most one diagnostic. The fragment check needs the target's heading anchors,
 * so it only fires when the path resolves to exactly one indexed document —
 * a missing target stays MDL401's alone. A same-page anchor (`path === ''`) is
 * skipped: it belongs to MDL201's in-document domain, never the link layer.
 */
function mdl401(entry: DocEntry, index: WorkspaceIndex, config: Config): WorkspaceDiagnostic[] {
  const out: WorkspaceDiagnostic[] = [];
  for (const link of entry.links) {
    if (!link.path) continue;
    if (isExternal(link.path)) continue;
    const targets = resolveLinkPath(index, entry.path, link.path);
    if (targets.length > 0) {
        if (link.anchor !== '' && !index.anchorsOf(targets[0]!).has(link.anchor)) {
        out.push(
          build(
            'MDL402',
            `Markdown link fragment does not exist in ${targets[0]!}: #${link.anchor}`,
            entry,
            link.offset,
            config,
            { url: link.url, path: link.path, anchor: link.anchor },
          ),
        );
      }
      continue;
    }
    out.push(
      build('MDL401', `Markdown link target does not exist: ${link.path}`, entry, link.offset, config, {
        url: link.url,
        path: link.path,
      }),
    );
  }
  return out;
}

/** A destination carrying a URL scheme is outside the repository. */
function isExternal(url: string): boolean {
  const colon = url.indexOf(':');
  if (colon <= 0) return false;
  return /^[a-z][a-z0-9+.-]*$/i.test(url.slice(0, colon));
}

/**
 * MDL402 — a relation evidence anchor absent from the target document.
 *
 * (Link fragments missing from their target are the same code, reported by
 * `mdl401` once the link's path resolves.)
 *
 * `evidence` resolves against the relation's TARGET document (frontmatter-spec:
 * "The anchor is resolved against the relation's `target` document"), so the
 * in-document case belongs to MDL201 and never appears here. A target that
 * resolves to zero or multiple documents is MDL302/MDL301's failure and is
 * skipped — one diagnostic per problem.
 */
function mdl402(entry: DocEntry, index: WorkspaceIndex, config: Config): WorkspaceDiagnostic[] {
  const out: WorkspaceDiagnostic[] = [];
  for (let i = 0; i < entry.relations.length; i++) {
    const rel = entry.relations[i]!;
    if (typeof rel.evidence !== 'string' || !rel.evidence.startsWith('#')) continue;
    const anchor = rel.evidence.slice(1);
    if (anchor === '') continue;
    const targets = index.idToPaths(rel.target);
    if (targets.length !== 1) continue;
    const targetEntry = index.entryOf(targets[0]!);
    if (!targetEntry || targetEntry.anchors.has(anchor)) continue;
    const where =
      entry.offsets.relationField(i, 'evidence') ?? entry.offsets.relationStart(i) ?? entry.offsets.mdlineageStart;
    out.push(
      build('MDL402', `Evidence anchor does not exist in ${rel.target}: ${rel.evidence}`, entry, where, config, {
        target: rel.target,
        anchor,
        type: rel.type,
      }),
    );
  }
  return out;
}

/** Assemble a WorkspaceDiagnostic positioned inside `entry`'s document. */
function build(
  code: string,
  message: string,
  entry: DocEntry,
  offset: number,
  config: Config,
  data?: Record<string, unknown>,
): WorkspaceDiagnostic {
  const overrides = config.diagnostics as Record<string, 'error' | 'warning' | 'information' | 'hint'>;
  return {
    code,
    severity: severityOf(code, overrides),
    message,
    // The range is clamped to the end of the offending line: a rule that names
    // a declaration often has no precise end, and an unclamped width would run
    // past the line into territory a highlight cannot show.
    range: rangeAt(entry.lineMap, offset, lineEnd(entry.lineMap, offset)),
    layer: layerOf(code) ?? 'workspace-semantic',
    path: entry.path,
    ...(data ? { data } : {}),
  };
}

/** Offset one past the last code unit of the line containing `offset`. */
function lineEnd(lineMap: LineMap, offset: number): number {
  const starts = lineMap.lineStarts;
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (starts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  const next = starts[lo + 1];
  return next === undefined ? lineMap.length : Math.max(offset + 1, next - 1);
}
