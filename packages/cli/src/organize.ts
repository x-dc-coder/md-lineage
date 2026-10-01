/**
 * `mdlineage organize`: the knowledge-base side of the directory-conventions
 * capability (docs/dir-conventions.md §2 "Layout-aware suggestions").
 *
 * Three read-only reports and one executing mode share one analysis:
 *
 *   --inventory  what the tree holds: kind distribution, directory
 *                distribution, and the scattered files no directory claims
 *                (MDL505's "orphaned from any directory intent").
 *   --report     how well the tree obeys its own declaration: the share of
 *                documents that match the intent of the directory they sit in,
 *                plus the documents the layout exceptions exempt.
 *   --plan       (default) which documents are misplaced, where each one
 *                belongs, and what moving it would cost in links.
 *   --apply      execute that plan through the same move engine `mdlineage
 *     --write    move` uses — one document at a time, in path order, each move
 *                planned against the tree the previous one left behind.
 *
 * A recommendation never invents a destination: it names a directory that
 * DECLARES the document's kind, so `organize` moves documents towards what the
 * repository already said it wanted, and says so when nothing does.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { cwd as processCwd } from 'node:process';
import {
  buildLineMap,
  layoutDiagnostics,
  loadConfig,
  matchesPattern,
  parseFrontmatter,
  scanBoundary,
  type Config,
} from '@mdlineage/validator';
import { Workspace, executeMove, planMove, todayUtc } from './move.js';
import { basenameOf, dirOf, linkHrefs, resolvedTarget, type DocPath } from './link-rewrite.js';

export interface OrganizeValues {
  plan?: boolean;
  apply?: boolean;
  write?: boolean;
  /** Glob that keeps only the matching documents in the analysis. */
  scope?: string;
  inventory?: boolean;
  report?: boolean;
  config?: string;
  exclude?: readonly string[];
}

/** What one document's front matter says, as far as layout cares. */
export interface DocProfile {
  readonly path: DocPath;
  readonly kind: string | null;
  readonly status: string | null;
  readonly authority: string | null;
}

/** A directory the layout rules declare an intent for. */
export interface IntentDirectory {
  /** Workspace-relative directory, POSIX form. */
  readonly dir: string;
  /** The rule's match pattern, for the report. */
  readonly match: string;
  readonly kinds: readonly string[];
  readonly description: string | null;
}

/** A document whose kind is outside the intent of the directory it sits in. */
export interface MisplacedDoc {
  readonly path: DocPath;
  readonly kind: string | null;
  /** The rule that rejected it. */
  readonly match: string;
  /** What that rule declares. */
  readonly declares: string;
}

/** The workspace-level view every mode reads. */
export interface Analysis {
  readonly profiles: readonly DocProfile[];
  readonly misplaced: readonly MisplacedDoc[];
  /** Documents no intent-declaring rule claims. */
  readonly orphans: readonly DocPath[];
  readonly intentDirs: readonly IntentDirectory[];
  /** Documents whose intent violation is not a kind mismatch. */
  readonly otherViolations: number;
  /** Documents a live exception exempts from intent checks. */
  readonly exempted: number;
  readonly total: number;
}

/** One recommended relocation, with the cost it would pay. */
export interface MoveProposal {
  readonly from: DocPath;
  readonly to: DocPath;
  readonly kind: string | null;
  /** Why the document does not belong where it is. */
  readonly reason: string;
  /** Which directory claim the destination comes from. */
  readonly target: string;
  readonly confidence: 'high' | 'medium';
  /** Links into the document that a move rewrites. */
  readonly inLinks: number;
  /** Documents those links live in. */
  readonly referrers: number;
  /** Links inside the document that a move rewrites. */
  readonly outLinks: number;
}

/** An organization plan: what moves, what cannot, and what the batch refuses. */
export interface OrganizePlan {
  readonly proposals: readonly MoveProposal[];
  /** Misplaced documents no directory claims, so nothing can be recommended. */
  readonly unresolved: readonly MisplacedDoc[];
  /**
   * Recommended relocations the batch refuses to execute, because their
   * destination is not free: another proposal in this batch already claims it,
   * a document the batch is still moving sits there, or a file exists on disk.
   */
  readonly collisions: readonly MoveCollision[];
}

/** A relocation the plan refuses, and the path that stands in its way. */
export interface MoveCollision {
  readonly from: DocPath;
  /** The destination the proposal wanted, which stays unwritten. */
  readonly to: DocPath;
  readonly reason: string;
}

/** `mdlineage organize [...flags]`. Returns the process exit code. */
export function runOrganize(argv: readonly string[], values: OrganizeValues, cwd: string = processCwd()): number {
  // `organize` selects documents with `--scope` and never takes paths, the way
  // `check` refuses an argument it has no use for. A dashed argument can only
  // arrive after `--`, because the shared parser rejects unknown flags first.
  const stray = argv.filter((arg) => arg.startsWith('-'));
  if (stray.length > 0) {
    process.stderr.write(`mdlineage: unknown organize option: ${stray.join(', ')}\n`);
    return 2;
  }
  if (argv.length > 0) {
    process.stderr.write(`mdlineage: organize takes no paths (unexpected: ${argv.join(', ')}); use --scope\n`);
    return 2;
  }

  const loaded = loadConfig(values.config, values.config ? undefined : cwd);
  for (const diag of loaded.diagnostics) {
    process.stderr.write(`mdlineage: ${diag.code} ${diag.severity} ${diag.message}\n`);
  }
  if (loaded.diagnostics.some((d) => d.severity === 'error')) return 1;

  const workspace = Workspace.load(cwd, { config: loaded.config, exclude: values.exclude });
  if (workspace.unreadable.length > 0) {
    for (const path of workspace.unreadable) process.stderr.write(`mdlineage: cannot read ${path}\n`);
    return 1;
  }

  const all = workspace.paths();
  const selected = values.scope === undefined ? all : all.filter((path) => matchesPattern(path, values.scope!));
  if (selected.length === 0) {
    process.stderr.write(`mdlineage: --scope matches no document: ${values.scope ?? ''}\n`);
    return 2;
  }

  const analysis = analyze(workspace, selected);
  if (values.inventory === true) printInventory(analysis);
  if (values.report === true) printReport(analysis, loaded.config.layoutExceptions.length);
  if (values.inventory === true || values.report === true) {
    // Both are reports; `--apply` belongs to the plan and would silently do
    // nothing here, so it is called out rather than ignored.
    if (values.apply === true || values.write === true) {
      process.stderr.write('mdlineage: --apply/--write only affect the plan; nothing was written\n');
    }
    return 0;
  }

  const plan = planOrganize(analysis, workspace);
  printPlan(plan, analysis);
  if (values.apply !== true && values.write !== true) return 0;
  return applyOrganize(plan, workspace);
}

// ---------------------------------------------------------------- analysis

/** Profile every selected document and separate the ones that fit from the rest. */
export function analyze(workspace: Workspace, selected: readonly DocPath[]): Analysis {
  const profiles: DocProfile[] = [];
  const misplaced: MisplacedDoc[] = [];
  const orphans: DocPath[] = [];
  const exempted = new Set<DocPath>();
  let otherViolations = 0;

  for (const path of [...selected].sort()) {
    const content = workspace.documents.get(path) ?? '';
    const metadata = metadataOf(content, workspace.config.metadata.key);
    profiles.push(profileOf(path, content, workspace.config.metadata.key));

    // A document no intent-declaring rule claims is MDL505's scattered file: it
    // has no convention to obey, which is itself the finding.
    const governing = metadata === null ? null : governingIntentRule(workspace.config, path);
    if (governing === null) {
      orphans.push(path);
      continue;
    }

    // The same layout pass `check` runs, narrowed to the one rule that governs
    // this directory: a nested intent refines its parent, so the parent's
    // broader complaint about a directory that has since specialised is not the
    // plan's business. `check` still reports it; see the report's note.
    const diagnostics = layoutDiagnostics({
      path,
      mdlineage: metadata,
      lineMap: buildLineMap(content),
      range: { start: 0, end: 0 },
      config: { ...workspace.config, layout: [governing] },
    });
    if (diagnostics.some((d) => d.code === 'MDL503')) exempted.add(path);

    const kindViolation = diagnostics.find((d) => d.code === 'MDL502' && d.data?.['rule'] === 'intent.kinds');
    if (kindViolation) {
      misplaced.push({
        path,
        kind: typeof kindViolation.data?.['kind'] === 'string' ? (kindViolation.data['kind'] as string) : null,
        match: governing.match,
        declares: (governing.intent?.kinds ?? []).join(', '),
      });
    } else if (diagnostics.some((d) => d.code === 'MDL502')) {
      otherViolations += 1;
    }
  }

  return {
    profiles,
    misplaced,
    orphans,
    intentDirs: intentDirectories(workspace.config),
    otherViolations,
    exempted: exempted.size,
    total: profiles.length,
  };
}

/**
 * The intent-declaring rule that governs `path`: the most specific one that
 * matches it.
 *
 * `docs/guides/**` governs a document in `docs/guides/` even though `docs/**`
 * also matches it — the deeper rule is the refinement the author wrote for that
 * directory. When several match at equal depth the first one wins, which is the
 * order the config declared them in.
 */
export function governingIntentRule(config: Config, path: DocPath): Config['layout'][number] | null {
  let best: Config['layout'][number] | null = null;
  let bestSpecificity = -1;
  for (const rule of config.layout) {
    if (!rule.intent) continue;
    if (!matchesPattern(path, rule.match)) continue;
    const dir = intentDirectoryOf(rule.match);
    const specificity = dir === null || dir === '.' ? 0 : dir.split('/').length;
    if (specificity <= bestSpecificity) continue;
    best = rule;
    bestSpecificity = specificity;
  }
  return best;
}

/** Read the metadata fields layout decisions need from one document. */
export function profileOf(path: DocPath, content: string, metadataKey: string): DocProfile {
  const metadata = metadataOf(content, metadataKey);
  if (metadata === null) return { path, kind: null, status: null, authority: null };
  const field = (key: string): string | null => (typeof metadata[key] === 'string' ? (metadata[key] as string) : null);
  return { path, kind: field('kind'), status: field('status'), authority: field('authority') };
}

/** The metadata block's mapping, or null when the document has none to read. */
function metadataOf(content: string, metadataKey: string): Record<string, unknown> | null {
  const boundary = scanBoundary(content);
  if (boundary === null || boundary.closeStart === null) return null;
  const parsed = parseFrontmatter(boundary.raw, boundary.rawStart, buildLineMap(content));
  const metadata = parsed.parsed?.data?.[metadataKey];
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) return null;
  return metadata as Record<string, unknown>;
}

/**
 * The directories a config declares an intent for, least specific first.
 *
 * `docs/guides/**` declares `docs/guides`; a rule that matches at the workspace
 * root (`**\/*.md`) declares no directory, because there is nothing to move a
 * document towards.
 */
export function intentDirectories(config: Config): IntentDirectory[] {
  const out: IntentDirectory[] = [];
  for (const rule of config.layout) {
    if (!rule.intent) continue;
    const dir = intentDirectoryOf(rule.match);
    if (dir === null) continue;
    out.push({
      dir,
      match: rule.match,
      kinds: rule.intent.kinds ?? [],
      description: rule.intent.description ?? null,
    });
  }
  return out.sort((a, b) => a.dir.length - b.dir.length);
}

/** The static directory a layout rule's match pattern covers. */
export function intentDirectoryOf(match: string): string | null {
  const index = match.search(/[*?[{]/);
  const head = index === -1 ? match : match.slice(0, index);
  const lastSlash = head.lastIndexOf('/');
  if (lastSlash === -1) return null;
  const dir = head.slice(0, lastSlash);
  return dir === '' ? '.' : dir;
}

// ------------------------------------------------------------------- plan

/** Turn the misplaced documents into relocations with a cost estimate. */
export function planOrganize(analysis: Analysis, workspace: Workspace): OrganizePlan {
  const proposals: MoveProposal[] = [];
  const unresolved: MisplacedDoc[] = [];
  const collisions: MoveCollision[] = [];
  // Destinations the batch has already committed to. A second proposal for the
  // same path, or one whose destination a later proposal is still moving, would
  // have the second write carry the pre-batch text over the first document's
  // healed links, so the second proposal is refused instead of planned.
  const claimed = new Set<DocPath>();
  const moving = new Set<DocPath>(analysis.misplaced.map((doc) => doc.path));

  for (const doc of analysis.misplaced) {
    const candidates = analysis.intentDirs.filter(
      (intent) => intent.dir !== dirOf(doc.path) && doc.kind !== null && intent.kinds.includes(doc.kind),
    );
    if (candidates.length === 0) {
      unresolved.push(doc);
      continue;
    }
    // Most specific claim wins: `docs/guides/**` says more about a guide than
    // `docs/**` does, and the two are told apart by directory depth.
    const target = candidates[candidates.length - 1]!;
    const to = target.dir === '.' ? basenameOf(doc.path) : `${target.dir}/${basenameOf(doc.path)}`;
    const incoming = inLinksOf(workspace, doc.path);
    const proposal: MoveProposal = {
      from: doc.path,
      to,
      kind: doc.kind,
      reason: `kind '${doc.kind ?? '(none)'}' is not in [${doc.declares}] declared by '${doc.match}'`,
      target: `'${target.match}' declares kinds [${target.kinds.join(', ')}]`,
      confidence: candidates.length === 1 ? 'high' : 'medium',
      inLinks: incoming.destinations,
      referrers: incoming.referrers,
      outLinks: outLinksOf(workspace, doc.path, to),
    };

    if (claimed.has(to)) {
      collisions.push({ from: doc.path, to, reason: `another proposal in this batch already moves a document to ${to}` });
      continue;
    }
    if (moving.has(to)) {
      collisions.push({ from: doc.path, to, reason: `${to} is moved by this batch too, so writing it would erase that move` });
      continue;
    }
    if (existsSync(resolve(workspace.cwd, to))) {
      collisions.push({ from: doc.path, to, reason: `${to} already exists` });
      continue;
    }
    claimed.add(to);
    proposals.push(proposal);
  }

  return { proposals, unresolved, collisions };
}

/** Incoming edges of `path`: how many destinations point at it, from how many documents. */
function inLinksOf(workspace: Workspace, path: DocPath): { destinations: number; referrers: number } {
  let destinations = 0;
  let referrers = 0;
  for (const other of workspace.paths()) {
    if (other === path) continue;
    let from = 0;
    for (const href of linkHrefs(workspace.documents.get(other) ?? '')) {
      if (resolvedTarget(other, href) === path) from += 1;
    }
    if (from > 0) {
      referrers += 1;
      destinations += from;
    }
  }
  return { destinations, referrers };
}

/** Links inside `path` that a move to `to` would re-base. */
function outLinksOf(workspace: Workspace, path: DocPath, to: DocPath): number {
  return planMove(path, to, workspace, todayUtc()).outEdges.length;
}

// ---------------------------------------------------------------- reports

function printInventory(analysis: Analysis): void {
  process.stdout.write(
    `mdlineage organize: inventory (${analysis.total} document${analysis.total === 1 ? '' : 's'})\n`,
  );

  const kinds = new Map<string, number>();
  const dirs = new Map<string, number>();
  for (const profile of analysis.profiles) {
    const kind = profile.kind ?? '(none)';
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
    const dir = dirOf(profile.path);
    dirs.set(dir, (dirs.get(dir) ?? 0) + 1);
  }

  process.stdout.write('\nkind distribution:\n');
  for (const [kind, count] of byCount(kinds)) process.stdout.write(`  ${kind.padEnd(20)} ${count}\n`);

  process.stdout.write('\ndirectory distribution:\n');
  for (const [dir, count] of byCount(dirs)) {
    process.stdout.write(`  ${(dir === '.' ? '(root)' : dir).padEnd(20)} ${count}\n`);
  }

  process.stdout.write(`\nscattered files (no directory declares an intent): ${analysis.orphans.length}\n`);
  for (const path of analysis.orphans) process.stdout.write(`  ${path}\n`);
  if (analysis.orphans.length === 0) process.stdout.write('  (none)\n');
}

function printReport(analysis: Analysis, exceptionCount: number): void {
  const compliant = analysis.total - analysis.misplaced.length - analysis.otherViolations;
  const share = analysis.total === 0 ? 100 : Math.round((compliant / analysis.total) * 100);
  process.stdout.write(
    `mdlineage organize: report — ${compliant}/${analysis.total} documents match their directory intent (${share}%)\n`,
  );
  process.stdout.write(
    `  misplaced (kind):    ${analysis.misplaced.length}\n` +
      `  misplaced (other):   ${analysis.otherViolations}\n` +
      `  exempt by exception: ${analysis.exempted}\n` +
      `  no intent declared:  ${analysis.orphans.length}\n` +
      `  layout exceptions:   ${exceptionCount}\n`,
  );

  if (analysis.intentDirs.length === 0) {
    process.stdout.write('  no directory declares an intent, so every document is unclaimed\n');
    return;
  }
  process.stdout.write(
    '  note: a nested intent refines its parent, so the most specific rule that matches\n' +
      '        governs here; `check` runs every matching rule and may report more.\n',
  );
  process.stdout.write('\ndeclared intents:\n');
  for (const intent of analysis.intentDirs) {
    const kinds = intent.kinds.length > 0 ? `kinds [${intent.kinds.join(', ')}]` : 'no kinds declared';
    process.stdout.write(`  ${intent.match.padEnd(22)} ${intent.dir.padEnd(18)} ${kinds}\n`);
  }
}

function printPlan(plan: OrganizePlan, analysis: Analysis): void {
  if (analysis.intentDirs.length === 0) {
    process.stdout.write(
      'mdlineage organize: no directory declares an intent, so no document can be misplaced; ' +
        'add an intent block to mdlineage.config.yaml first\n',
    );
    return;
  }
  if (plan.proposals.length === 0 && plan.unresolved.length === 0) {
    process.stdout.write(
      `mdlineage organize: ${analysis.total} document${analysis.total === 1 ? '' : 's'}, none misplaced\n`,
    );
    return;
  }

  process.stdout.write('mdlineage organize: plan (dry run; use --apply or --write to execute)\n');
  let links = 0;
  for (const proposal of plan.proposals) {
    const cost = proposal.inLinks + proposal.outLinks;
    links += cost;
    process.stdout.write(`\n  move ${proposal.from} -> ${proposal.to}\n`);
    process.stdout.write(`    reason:     ${proposal.reason}\n`);
    process.stdout.write(`    target:     ${proposal.target}\n`);
    process.stdout.write(`    confidence: ${proposal.confidence}\n`);
    process.stdout.write(
      `    links:      ${proposal.inLinks} incoming (${proposal.referrers} document(s)), ` +
        `${proposal.outLinks} outgoing (${cost} destinations rewritten)\n`,
    );
  }
  for (const doc of plan.unresolved) {
    process.stdout.write(`\n  ${doc.path}: kind '${doc.kind ?? '(none)'}' has no directory declaring it\n`);
    process.stdout.write(`    add a layout rule with intent.kinds including '${doc.kind ?? ''}', or a layoutException\n`);
  }
  for (const collision of plan.collisions) {
    process.stdout.write(`\n  collision: ${collision.from} -> ${collision.to} refused — ${collision.reason}\n`);
  }
  process.stdout.write(`\nmdlineage organize: ${plan.proposals.length} move(s) planned, ${links} link(s) to rewrite\n`);
}

/** Execute the plan through the move engine, one document at a time. */
function applyOrganize(plan: OrganizePlan, workspace: Workspace): number {
  let moved = 0;
  let links = 0;
  let failures = 0;
  for (const proposal of plan.proposals) {
    // Planned fresh, against the snapshot the previous move left behind: a plan
    // computed for the whole batch up front would write each document the
    // pre-batch text, so the second document erased the first one's rewrites.
    const entry = planMove(proposal.from, proposal.to, workspace, todayUtc());
    const cost = entry.outEdges.length + entry.inEdges.reduce((sum, file) => sum + file.rewrites.length, 0);
    const outcome = executeMove(entry, workspace);
    for (const error of outcome.errors) process.stderr.write(`mdlineage: ${error}\n`);
    if (outcome.errors.length > 0) {
      failures += 1;
      continue;
    }
    moved += 1;
    links += cost;
    process.stdout.write(`mdlineage organize: moved ${entry.src} -> ${entry.dst} (${outcome.transfer})\n`);
  }
  process.stdout.write(
    `mdlineage organize: ${moved} file(s) moved, ${plan.proposals.length - moved} skipped, ${links} link(s) rewritten\n`,
  );
  return failures > 0 ? 1 : 0;
}

/** A tally sorted by count (descending), then by key, so reports are stable. */
function byCount(tally: Map<string, number>): [string, number][] {
  return [...tally].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}
