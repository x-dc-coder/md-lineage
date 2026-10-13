/**
 * Federation discovery helpers (Issue #4 Phase 3).
 *
 * Pure, filesystem-free: the CLI's scanner (`discover-federations.ts`) hands
 * the candidates it found here, so scope assignment, collision numbering and
 * the emitted YAML are deterministic functions of their inputs — no disk, no
 * clock, no environment. The `entry` shape mirrors the schema's
 * `federations` block so `renderFederationYaml` output validates as-is.
 */

import { isAbsolute, relative, sep } from 'node:path';
import { FEDERATION_SCOPE_PATTERN, RESERVED_SCOPES, foldAliasPrefix } from './federation.js';

/** Directories the sibling scan never descends into or adopts. */
export const DISCOVERY_SKIP_DIRS: ReadonlySet<string> = new Set([
  '.git',
  'node_modules',
  'dist',
  'vendor',
  'build',
  'out',
  'coverage',
  'target',
  '.venv',
  '.venv-win',
  '.tools',
  '.wp',
  '__pycache__',
]);

/** How far above the home root the scan may climb (home root itself is level 0). */
export const MAX_DISCOVER_UP_LEVELS = 2;

/** Longest generated scope name; keeps coordinates (@scope//path) readable. */
const MAX_SCOPE_LENGTH = 32;

/**
 * Turn a directory name into a schema-valid federation scope slug.
 *
 * NFKD-folds and strips combining marks so `café` becomes `cafe`, lowercases,
 * maps every run of non-`[a-z0-9]` to a single hyphen, then trims hyphens. A
 * leading digit gets a `repo-` prefix (the pattern requires a leading letter),
 * and the result is truncated to 32 characters after that prefix. A name with
 * no ASCII alphanumerics (pure CJK, punctuation) yields `''`; any slug that
 * still fails the pattern falls back to `repo`.
 */
export function slugifyScopeName(dirName: string): string {
  const folded = dirName
    .normalize('NFKD')
    // Drop combining marks the NFKD decomposition split off (U+0300–U+036F and
    // the common extended blocks); the base letter survives.
    .replace(/[\u0300-\u036f\u1ab0-\u1aff\u1dc0-\u1dff\u20d0-\u20ff\ufe20-\ufe2f]/g, '')
    .toLowerCase();

  let slug = folded.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (slug === '') return '';

  if (/^[0-9]/.test(slug)) slug = `repo-${slug}`;
  slug = slug.slice(0, MAX_SCOPE_LENGTH).replace(/-+$/, '');
  if (slug === '') return '';

  return FEDERATION_SCOPE_PATTERN.test(slug) ? slug : 'repo';
}

/** One discovered repository and the scope assigned to it. */
export interface ScopeAssignment {
  readonly root: string;
  readonly scope: string;
}

/**
 * Assign a unique scope to every candidate.
 *
 * Candidates are processed in `root` order so the assignment is identical
 * across runs and platforms regardless of directory-read order. `taken` holds
 * the scopes already configured (plus the reserved `home`/`*`, seeded here);
 * a collision gets the smallest free `-2`, `-3`, … suffix.
 */
export function assignDiscoveryScopes(
  candidates: readonly { root: string; basename: string }[],
  taken: ReadonlySet<string>,
): ScopeAssignment[] {
  const used = new Set<string>(taken);
  for (const reserved of RESERVED_SCOPES) used.add(reserved);

  const sorted = [...candidates].sort((a, b) => (a.root < b.root ? -1 : a.root > b.root ? 1 : 0));
  const out: ScopeAssignment[] = [];
  for (const candidate of sorted) {
    const base = slugifyScopeName(candidate.basename) || 'repo';
    let scope = base;
    for (let n = 2; used.has(scope); n++) scope = `${base}-${n}`;
    used.add(scope);
    out.push({ root: candidate.root, scope });
  }
  return out;
}

/** Why a discovered candidate was left out of the proposal. */
export type FederationSkipReason = 'already-declared' | 'cross-device' | 'at-or-above-home';

export interface FederationProposalSkipped {
  readonly root: string;
  readonly scope: string;
  readonly reason: FederationSkipReason;
}

/** One `federations:` entry, shaped to satisfy the config schema. */
export interface FederationProposalEntry {
  readonly scope: string;
  /** Home-root-relative POSIX path, as written under `local.path`. */
  readonly localPath: string;
  /** Physical alias prefix (leading `..` segments stripped). */
  readonly alias: string;
  readonly trust: 'readonly';
  readonly missing: 'warn';
  readonly include: readonly string[];
}

export interface FederationProposal {
  readonly entries: readonly FederationProposalEntry[];
  readonly skipped: readonly FederationProposalSkipped[];
}

/**
 * Shape discovered assignments into a federation proposal.
 *
 * A candidate already declared (same physical root), one on another device
 * (`relative` returns an absolute path), or one at/above the home root (empty
 * alias) is reported as skipped rather than mounted.
 */
export function buildFederationProposal(
  homeRoot: string,
  assignments: readonly ScopeAssignment[],
  existingRoots: ReadonlySet<string>,
): FederationProposal {
  const entries: FederationProposalEntry[] = [];
  const skipped: FederationProposalSkipped[] = [];

  for (const { root, scope } of assignments) {
    if (existingRoots.has(root)) {
      skipped.push({ root, scope, reason: 'already-declared' });
      continue;
    }
    const rel = relative(homeRoot, root);
    if (isAbsolute(rel)) {
      skipped.push({ root, scope, reason: 'cross-device' });
      continue;
    }
    const alias = foldAliasPrefix(homeRoot, root);
    if (alias === '') {
      skipped.push({ root, scope, reason: 'at-or-above-home' });
      continue;
    }
    entries.push({
      scope,
      localPath: rel.split(sep).join('/'),
      alias,
      trust: 'readonly',
      missing: 'warn',
      include: ['**/*.md'],
    });
  }

  return { entries, skipped };
}

/**
 * Render the proposal as a `federations:` YAML fragment (2-space indent), or
 * `''` for an empty proposal — so a caller appends nothing when there is
 * nothing to add.
 */
export function renderFederationYaml(proposals: readonly FederationProposalEntry[]): string {
  if (proposals.length === 0) return '';
  const lines: string[] = ['federations:'];
  for (const entry of proposals) {
    lines.push(`  ${entry.scope}:`);
    lines.push('    local:');
    lines.push(`      path: ${entry.localPath}`);
    lines.push(`    trust: ${entry.trust}`);
    lines.push(`    missing: ${entry.missing}`);
    lines.push('    include:');
    for (const pattern of entry.include) lines.push(`      - '${pattern}'`);
  }
  return `${lines.join('\n')}\n`;
}
