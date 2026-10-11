/**
 * Federation domain model, coordinate utilities, and in-memory proxy index
 * (Issue #4 Phase 1: Declarative external workspaces and read-only routing proxy).
 *
 * This module is pure in-memory: no disk I/O, no git subprocesses.
 * Disk scanning and config loading are performed by the caller or by config.ts.
 */

import { relative, sep } from 'node:path';
import type { Config } from './config.js';
import type { DocEntry, DocPath, RelationEntry, WorkspaceIndex, RelationTargetResolution } from './workspace-index.js';
import type { WorkspaceUniverse } from './workspace-scan.js';
import { matchesPattern } from './path-filter.js';

// schema 的 pattern 字符串与此保持同步，导出供未来 init --discover-federations 复用
export const FEDERATION_SCOPE_PATTERN = /^[a-z][a-z0-9-]*$/;
export const RESERVED_SCOPES: ReadonlySet<string> = new Set(['home', '*']);

/**
 * Compute the physical alias prefix for a member relative to the home root,
 * stripping all leading '..' segments and normalizing to POSIX forward slashes.
 */
export function foldAliasPrefix(homeRoot: string, memberRoot: string): string {
  const rel = relative(homeRoot, memberRoot).split(sep).join('/');
  const segments = rel.split('/').filter((s) => s.length > 0 && s !== '.');
  while (segments.length > 0 && segments[0] === '..') {
    segments.shift();
  }
  return segments.join('/');
}

/** Check if a path is in federated scoped coordinates (@scope//path). */
export function isExternalPath(path: string): boolean {
  return /^@[a-z][a-z0-9-]*\/\//.test(path);
}

/**
 * The federation scope a path belongs to: 'home' for unscoped coordinates
 * and '@home//…', the scope name for '@scope//…'. Write guards use it to
 * refuse any write that would land in a read-only federated member.
 */
export function scopeOfPath(path: string): 'home' | string {
  const m = /^@([a-z0-9][a-z0-9-]*)\/\//.exec(path);
  if (!m) return 'home';
  const name = m[1] ?? 'home';
  return name === 'home' ? 'home' : name;
}

/** Format a scoped path coordinate. */
export function scopedPath(scope: string, memberPath: string): string {
  return `@${scope}//${memberPath}`;
}

/** A relation target split into its optional federation envelope and the id. */
export interface ScopedTarget {
  /** 'bare' when the target carries no scope or wildcard prefix. */
  readonly scope: 'bare' | string;
  readonly id: string;
}

/**
 * Split a relation target into its federation envelope and id. Never throws:
 * a target the schema rejected (MDL103) still arrives here from direct
 * callers (LSP/MCP/tests), and anything envelope-shaped but malformed is
 * reported as the bare spelling it carries — resolution then simply fails.
 */
export function parseScopedTarget(target: string): ScopedTarget {
  const match = /^@([a-z][a-z0-9-]*|\*)\/\/(.+)$/.exec(target);
  if (!match) return { scope: 'bare', id: target };
  return { scope: match[1] ?? '*', id: match[2] ?? target };
}

export interface FederatedMemberMount {
  readonly scope: string;
  readonly index: WorkspaceIndex;
  readonly alias: string;
}

/**
 * Filter a scanned universe by include glob patterns.
 * Preserves knownPaths both with and without trailing slash.
 */
export function filterUniverseByInclude(
  universe: WorkspaceUniverse,
  include: readonly string[]
): WorkspaceUniverse {
  const documents = new Map<string, string>();
  for (const [path, content] of universe.documents.entries()) {
    if (include.some((pattern) => matchesPattern(path, pattern))) {
      documents.set(path, content);
    }
  }

  const knownPaths: string[] = [];
  for (const kp of universe.knownPaths) {
    const trimmed = kp.endsWith('/') ? kp.slice(0, -1) : kp;
    if (include.some((pattern) => matchesPattern(trimmed, pattern) || matchesPattern(trimmed + '/', pattern))) {
      knownPaths.push(kp);
    }
  }

  return { documents, knownPaths };
}

/**
 * Sovereignty policy (Phase 1 Decision 5 & 8):
 * 1. For external documents (@scope//...):
 *    - Skip layout rules (MDL5xx) and freshness (MDL801)
 *    - Cap error severity to warning (exit code sovereignty)
 * 2. Home repository diagnostics are completely untouched.
 */
export function applyExternalScopePolicy<
  T extends { path: string; code: string; severity: 'error' | 'warning' | 'information' | 'hint' }
>(diagnostics: readonly T[]): T[] {
  const out: T[] = [];
  for (const diag of diagnostics) {
    if (isExternalPath(diag.path)) {
      if (/^(?:MDL5\d\d|MDL801)$/.test(diag.code)) {
        continue;
      }
      if (diag.severity === 'error') {
        out.push({ ...diag, severity: 'warning' });
      } else {
        out.push(diag);
      }
    } else {
      out.push(diag);
    }
  }
  return out;
}

/**
 * Read-only federated workspace index implementation (FederatedIndexImpl).
 */
class FederatedIndexImpl implements WorkspaceIndex {
  private readonly home: WorkspaceIndex;
  private readonly members: ReadonlyMap<string, FederatedMemberMount>;
  private readonly missingScopes: ReadonlySet<string>;
  /** Sorted by alias length descending for greedy match. */
  private readonly sortedMounts: readonly FederatedMemberMount[];

  constructor(
    home: WorkspaceIndex,
    members: ReadonlyMap<string, FederatedMemberMount>,
    options?: { readonly missingScopes?: ReadonlySet<string> }
  ) {
    this.home = home;
    this.members = members;
    this.missingScopes = options?.missingScopes ?? new Set<string>();
    this.sortedMounts = [...members.values()].sort((a, b) => b.alias.length - a.alias.length);
  }

  get config(): Config {
    return this.home.config;
  }

  get size(): number {
    let count = this.home.size;
    for (const mount of this.members.values()) {
      count += mount.index.size;
    }
    return count;
  }

  *paths(): IterableIterator<DocPath> {
    for (const p of this.home.paths()) {
      yield p;
    }
    const scopes = [...this.members.keys()].sort();
    for (const scope of scopes) {
      const mount = this.members.get(scope);
      if (!mount) continue;
      for (const p of mount.index.paths()) {
        yield scopedPath(scope, p) as DocPath;
      }
    }
  }

  *ids(): IterableIterator<string> {
    const seen = new Set<string>();
    for (const id of this.home.ids()) {
      if (!seen.has(id)) {
        seen.add(id);
        yield id;
      }
    }
    const scopes = [...this.members.keys()].sort();
    for (const scope of scopes) {
      const mount = this.members.get(scope);
      if (!mount) continue;
      for (const id of mount.index.ids()) {
        if (!seen.has(id)) {
          seen.add(id);
          yield id;
        }
      }
    }
  }

  pathToId(path: DocPath): string | null {
    const entry = this.entryOf(path);
    return entry?.id ?? null;
  }

  /**
   * Unscoped id resolution: returns union of all matching paths across home and members.
   * Document-internal checks use idToPathsIn to keep bare ids scoped to their declaring repository.
   */
  idToPaths(id: string): readonly DocPath[] {
    const homeMatches = this.home.idToPaths(id);
    const result: DocPath[] = [...homeMatches];
    const scopes = [...this.members.keys()].sort();
    for (const scope of scopes) {
      const mount = this.members.get(scope);
      if (!mount) continue;
      for (const p of mount.index.idToPaths(id)) {
        result.push(scopedPath(scope, p) as DocPath);
      }
    }
    return result;
  }

  /**
   * Repository-scoped id resolution (Phase 1 Decision 1):
   * Bare ids only resolve within the repository of contextPath.
   */
  idToPathsIn(id: string, contextPath: DocPath): readonly DocPath[] {
    const match = /^@([a-z][a-z0-9-]*)\/\/(.+)$/.exec(contextPath);
    if (match) {
      const scope = match[1];
      if (scope) {
        const mount = this.members.get(scope);
        if (mount) {
          return mount.index.idToPaths(id).map((p) => scopedPath(scope, p) as DocPath);
        }
      }
    }

    // Check if contextPath matches member alias
    for (const mount of this.sortedMounts) {
      if (contextPath === mount.alias || contextPath.startsWith(mount.alias + '/')) {
        return mount.index.idToPaths(id).map((p) => scopedPath(mount.scope, p) as DocPath);
      }
    }

    // Otherwise contextPath is in home repository
    return this.home.idToPaths(id);
  }

  resolveRelationTarget(target: string, contextPath: DocPath): RelationTargetResolution {
    const { scope, id } = parseScopedTarget(target);
    if (scope === 'bare') {
      const paths = this.idToPathsIn(id, contextPath);
      return paths.length > 0
        ? { kind: 'resolved', paths }
        : { kind: 'unresolved', missingScopes: [] };
    }
    if (scope === '*') {
      const allPaths: DocPath[] = [];
      let scopeHits = 0;

      const homeHits = this.home.idToPaths(id);
      if (homeHits.length > 0) {
        scopeHits++;
        for (const p of homeHits) allPaths.push(p);
      }

      for (const [s, mount] of this.members.entries()) {
        const memberHits = mount.index.idToPaths(id);
        if (memberHits.length > 0) {
          scopeHits++;
          for (const p of memberHits) {
            allPaths.push(scopedPath(s, p) as DocPath);
          }
        }
      }

      if (scopeHits >= 2) return { kind: 'ambiguous', candidates: allPaths };
      if (scopeHits === 1) return { kind: 'resolved', paths: allPaths };
      return { kind: 'unresolved', missingScopes: [...this.missingScopes] };
    }
    if (scope === 'home') {
      const paths = this.home.idToPaths(id);
      return paths.length > 0
        ? { kind: 'resolved', paths }
        : { kind: 'unresolved', missingScopes: [] };
    }
    if (this.missingScopes.has(scope)) return { kind: 'missing-scope', scope };
    const mount = this.members.get(scope);
    if (!mount) return { kind: 'unknown-scope', scope };
    const paths = mount.index.idToPaths(id).map((p) => scopedPath(scope, p) as DocPath);
    return paths.length > 0
      ? { kind: 'resolved', paths }
      : { kind: 'unresolved', missingScopes: [] };
  }

  entryOf(path: DocPath): DocEntry | null {
    // 1. Home repository exact match
    const homeEntry = this.home.entryOf(path);
    if (homeEntry) return homeEntry;

    // 2. Scoped coordinate (@scope//path)
    const match = /^@([a-z][a-z0-9-]*)\/\/(.+)$/.exec(path);
    if (match) {
      const scope = match[1];
      const memberPath = match[2];
      if (scope && memberPath) {
        const mount = this.members.get(scope);
        if (mount) {
          const entry = mount.index.entryOf(memberPath as DocPath);
          if (entry) {
            return {
              ...entry,
              path: scopedPath(scope, entry.path) as DocPath,
            };
          }
        }
      }
    }

    // 3. Physical alias coordinate
    for (const mount of this.sortedMounts) {
      if (path === mount.alias || path.startsWith(mount.alias + '/')) {
        const sub = path.slice(mount.alias.length).replace(/^\/+/, '');
        const entry = mount.index.entryOf(sub as DocPath);
        if (entry) {
          return {
            ...entry,
            path: scopedPath(mount.scope, entry.path) as DocPath,
          };
        }
      }
    }

    return null;
  }

  anchorsOf(path: DocPath): ReadonlySet<string> {
    const match = /^@([a-z][a-z0-9-]*)\/\/(.+)$/.exec(path);
    if (match) {
      const scope = match[1];
      const memberPath = match[2];
      if (scope && memberPath) {
        const mount = this.members.get(scope);
        if (mount) {
          return mount.index.anchorsOf(memberPath as DocPath);
        }
      }
    }

    for (const mount of this.sortedMounts) {
      if (path === mount.alias || path.startsWith(mount.alias + '/')) {
        const sub = path.slice(mount.alias.length).replace(/^\/+/, '');
        return mount.index.anchorsOf(sub as DocPath);
      }
    }

    return this.home.anchorsOf(path);
  }

  headingsOf(path: DocPath): readonly string[] {
    const match = /^@([a-z][a-z0-9-]*)\/\/(.+)$/.exec(path);
    if (match) {
      const scope = match[1];
      const memberPath = match[2];
      if (scope && memberPath) {
        const mount = this.members.get(scope);
        if (mount) {
          return mount.index.headingsOf(memberPath as DocPath);
        }
      }
    }

    for (const mount of this.sortedMounts) {
      if (path === mount.alias || path.startsWith(mount.alias + '/')) {
        const sub = path.slice(mount.alias.length).replace(/^\/+/, '');
        return mount.index.headingsOf(sub as DocPath);
      }
    }

    return this.home.headingsOf(path);
  }

  relationsOf(path: DocPath): readonly RelationEntry[] {
    const match = /^@([a-z][a-z0-9-]*)\/\/(.+)$/.exec(path);
    if (match) {
      const scope = match[1];
      const memberPath = match[2];
      if (scope && memberPath) {
        const mount = this.members.get(scope);
        if (mount) {
          return mount.index.relationsOf(memberPath as DocPath);
        }
      }
    }

    for (const mount of this.sortedMounts) {
      if (path === mount.alias || path.startsWith(mount.alias + '/')) {
        const sub = path.slice(mount.alias.length).replace(/^\/+/, '');
        return mount.index.relationsOf(sub as DocPath);
      }
    }

    return this.home.relationsOf(path);
  }

  knowsPath(path: DocPath): boolean {
    if (this.home.knowsPath(path)) return true;

    const match = /^@([a-z][a-z0-9-]*)\/\/(.+)$/.exec(path);
    if (match) {
      const scope = match[1];
      const memberPath = match[2];
      if (scope && memberPath) {
        const mount = this.members.get(scope);
        if (mount) {
          return mount.index.knowsPath(memberPath as DocPath);
        }
      }
    }

    for (const mount of this.sortedMounts) {
      if (path === mount.alias || path.startsWith(mount.alias + '/')) {
        const sub = path.slice(mount.alias.length).replace(/^\/+/, '');
        if (mount.index.knowsPath(sub as DocPath)) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Find documents whose relations reference `id` (bare or scoped envelope).
   *
   * Design rationale:
   * Lazy derivation — the federated proxy is strictly read-only and does not
   * maintain a dedicated reverse index cache for cross-repository queries,
   * avoiding cache invalidation complexity and stale data risks.
   *
   * Query cost:
   * O(home + Σ member documents) full scan across the federation for scoped
   * queries, scanning live relations of home and each mounted member.
   */
  referrersOf(id: string): readonly DocPath[] {
    const { scope, id: bare } = parseScopedTarget(id);
    const result: DocPath[] = [];

    if (scope === 'bare') {
      result.push(...this.home.referrersOf(bare));
      const scopes = [...this.members.keys()].sort();
      for (const s of scopes) {
        const mount = this.members.get(s);
        if (!mount) continue;
        for (const p of mount.index.referrersOf(bare)) {
          result.push(scopedPath(s, p) as DocPath);
        }
      }
      return [...new Set(result)].sort();
    }

    // Scoped target query (@scope//id or @home//id)
    // 1. Scan home live relations for explicit target match
    for (const p of this.home.paths()) {
      const entry = this.home.entryOf(p);
      if (entry?.relations.some((r) => r.target === id)) {
        result.push(p);
      }
    }

    // 2. Scan each member for explicit scoped target match and for bare id matches
    // if target belongs to that member.
    const scopes = [...this.members.keys()].sort();
    for (const s of scopes) {
      const mount = this.members.get(s);
      if (!mount) continue;

      // Cross-member scoped target declaration in this member (e.g. memberA -> @memberB//x)
      for (const p of mount.index.paths()) {
        const entry = mount.index.entryOf(p);
        if (entry?.relations.some((r) => r.target === id)) {
          result.push(scopedPath(s, p) as DocPath);
        }
      }

      // If the scoped target query is for this member (@s//id), member internal
      // bare referrers of that id also count as referrers of the scoped entity.
      if (s === scope) {
        for (const p of mount.index.referrersOf(bare)) {
          result.push(scopedPath(s, p) as DocPath);
        }
      }
    }

    return [...new Set(result)].sort();
  }

  linkReferrersOf(path: DocPath): readonly DocPath[] {
    const match = /^@([a-z][a-z0-9-]*)\/\/(.+)$/.exec(path);
    if (match) {
      const scope = match[1];
      const memberPath = match[2];
      if (scope && memberPath) {
        const mount = this.members.get(scope);
        if (mount) {
          return mount.index.linkReferrersOf(memberPath as DocPath).map((p) => scopedPath(scope, p) as DocPath);
        }
      }
    }

    for (const mount of this.sortedMounts) {
      if (path === mount.alias || path.startsWith(mount.alias + '/')) {
        const sub = path.slice(mount.alias.length).replace(/^\/+/, '');
        return mount.index.linkReferrersOf(sub as DocPath).map((p) => scopedPath(mount.scope, p) as DocPath);
      }
    }

    return this.home.linkReferrersOf(path);
  }

  caseInsensitiveLookup(path: DocPath): DocPath | null {
    if (this.home.caseInsensitiveLookup) {
      const homeFound = this.home.caseInsensitiveLookup(path);
      if (homeFound) return homeFound;
    }

    const match = /^@([a-z][a-z0-9-]*)\/\/(.+)$/.exec(path);
    if (match) {
      const scope = match[1];
      const memberPath = match[2];
      if (scope && memberPath) {
        const mount = this.members.get(scope);
        if (mount && mount.index.caseInsensitiveLookup) {
          const found = mount.index.caseInsensitiveLookup(memberPath as DocPath);
          if (found) {
            return scopedPath(scope, found) as DocPath;
          }
        }
      }
    }

    for (const mount of this.sortedMounts) {
      if (path === mount.alias || path.startsWith(mount.alias + '/')) {
        const sub = path.slice(mount.alias.length).replace(/^\/+/, '');
        if (mount.index.caseInsensitiveLookup) {
          const found = mount.index.caseInsensitiveLookup(sub as DocPath);
          if (found) {
            return scopedPath(mount.scope, found) as DocPath;
          }
        }
      }
    }

    return null;
  }
}

/**
 * Create a read-only federated workspace index proxy.
 */
export function createFederatedIndex(
  home: WorkspaceIndex,
  members: ReadonlyMap<string, FederatedMemberMount>,
  options?: { readonly missingScopes?: ReadonlySet<string> }
): WorkspaceIndex {
  return new FederatedIndexImpl(home, members, options);
}
