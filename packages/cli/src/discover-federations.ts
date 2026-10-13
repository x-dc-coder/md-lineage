/**
 * Sibling-repository scanning for `mdlineage init --discover-federations`
 * (Issue #4 Phase 3).
 *
 * This is the filesystem half of discovery: it walks up from the home root a
 * bounded number of levels, looks at each ancestor directory's direct
 * children, and keeps the ones that are repositories (carry their own
 * `mdlineage.config.yaml`). Scope assignment and the resulting proposal are
 * pure and live in `@mdlineage/validator` (`federation-discover.ts`); this
 * module only reads the disk and resolves canonical paths.
 *
 * Depth is deliberately small (default 1, ceiling 2): a "sibling repository"
 * is a convention, not a filesystem crawl, and a wide scan would adopt
 * unrelated trees. Every read is guarded — an unreadable or vanished entry is
 * recorded and skipped, never fatal.
 */

import { readdirSync, statSync, realpathSync, existsSync, type Dirent } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import {
  DISCOVERY_SKIP_DIRS,
  MAX_DISCOVER_UP_LEVELS,
  type Config,
} from '@mdlineage/validator';

const CONFIG_FILE = 'mdlineage.config.yaml';

/** A discovered sibling repository, in canonical physical coordinates. */
export interface DiscoveryCandidate {
  /** Absolute realpath of the repository root. */
  readonly root: string;
  /** Basename of the canonical root, the scope slug source. */
  readonly basename: string;
}

export interface DiscoveryScanResult {
  /** Canonical home root the scan was anchored at. */
  readonly homeRoot: string;
  readonly candidates: readonly DiscoveryCandidate[];
  /** Read errors encountered; each scan skips the entry rather than throwing. */
  readonly errors: readonly string[];
}

export interface DiscoveryScanOptions {
  /** Ancestor levels to scan above the home root (default 1, max 2). */
  readonly maxUpLevels?: number;
}

/** `realpathSync` with a fallback to the resolved input on any failure. */
function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function isUnder(parent: string, child: string): boolean {
  return child !== parent && child.startsWith(parent + sep);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Scan for sibling repositories around `homeRoot`.
 *
 * Level 1 inspects the direct children of `dirname(homeRoot)`; level 2 repeats
 * for the grandparent. The walk stops early at the filesystem root. A child is
 * a candidate only when: it is a directory (symlinks followed), it is not a
 * hidden or skipped directory, it is not the home root nor under it, and it
 * carries its own `mdlineage.config.yaml`.
 */
export function collectDiscoveryCandidates(
  homeRoot: string,
  options: DiscoveryScanOptions = {},
): DiscoveryScanResult {
  const home = canonical(homeRoot);
  const requested = options.maxUpLevels ?? 1;
  const maxLevels = Math.max(1, Math.min(MAX_DISCOVER_UP_LEVELS, requested));

  const candidates = new Map<string, DiscoveryCandidate>();
  const errors: string[] = [];

  const scanChildren = (parent: string): void => {
    let entries: Dirent<string>[];
    try {
      entries = readdirSync(parent, { withFileTypes: true, encoding: 'utf8' });
    } catch (error) {
      errors.push(`cannot read ${parent}: ${errorMessage(error)}`);
      return;
    }
    for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const name = entry.name;
      if (name.startsWith('.')) continue;
      if (DISCOVERY_SKIP_DIRS.has(name)) continue;

      const childPath = join(parent, name);
      let real: string;
      try {
        // statSync follows symlinks, so a symlinked repository is adopted
        // through its canonical target.
        if (!statSync(childPath).isDirectory()) continue;
        real = realpathSync(childPath);
      } catch (error) {
        errors.push(`cannot inspect ${childPath}: ${errorMessage(error)}`);
        continue;
      }

      if (real === home || isUnder(home, real)) continue;
      if (candidates.has(real)) continue;
      let hasConfig = false;
      try {
        hasConfig = existsSync(join(real, CONFIG_FILE));
      } catch (error) {
        errors.push(`cannot inspect ${real}: ${errorMessage(error)}`);
        continue;
      }
      if (!hasConfig) continue;

      candidates.set(real, { root: real, basename: basename(real) || name });
    }
  };

  let ancestor = home;
  for (let level = 1; level <= maxLevels; level++) {
    const parent = dirname(ancestor);
    if (parent === ancestor) break; // filesystem root
    scanChildren(parent);
    ancestor = parent;
  }

  const list = [...candidates.values()].sort((a, b) => (a.root < b.root ? -1 : a.root > b.root ? 1 : 0));
  return { homeRoot: home, candidates: list, errors };
}

/**
 * Canonical physical roots of the federation members this home config already
 * declares. `buildFederationProposal` uses it to skip candidates that are
 * already mounted, so a re-run proposes only genuinely new siblings.
 */
export function existingFederationRoots(config: Config, homeRoot: string): Set<string> {
  const out = new Set<string>();
  const base = config.source ? dirname(config.source) : homeRoot;
  for (const member of config.federations.values()) {
    const target = resolve(base, member.localPath);
    out.add(canonical(target));
  }
  return out;
}
