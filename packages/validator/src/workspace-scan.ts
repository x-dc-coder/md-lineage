/**
 * Unified workspace directory scanning for LSP and MCP channels.
 *
 * Discovers Markdown documents and builds the known-paths universe
 * (Markdown, non-Markdown files, and directories in both `dir` and `dir/` forms).
 */

import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Config } from './config.js';
import { PathFilter, matchesPattern } from './path-filter.js';
import { stripBom } from './parse-frontmatter.js';

export interface WorkspaceUniverse {
  /** Root-relative path -> content map for Markdown documents. */
  documents: Map<string, string>;
  /**
   * Root-relative known paths for link validation (MDL401/402).
   * Contains non-Markdown files, Markdown files, and directories (both `dir` and `dir/`).
   */
  knownPaths: string[];
}

/**
 * Scan workspace universe rooted at `root` using `config`.
 */
export function scanWorkspaceUniverse(root: string, config: Config): WorkspaceUniverse {
  const absRoot = resolve(root);
  const filter = new PathFilter({ config });
  const hardPrune = filter.hardPrunePatterns();

  const documents = new Map<string, string>();
  const knownPathsSet = new Set<string>();

  let initialRealRoot: string;
  try {
    initialRealRoot = realpathSync(absRoot);
  } catch {
    initialRealRoot = absRoot;
  }
  const visitedPhysical = new Set<string>([initialRealRoot]);

  interface QueueItem {
    logicalDir: string;
    physicalDir: string;
    depth: number;
  }

  const queue: QueueItem[] = [{ logicalDir: '', physicalDir: absRoot, depth: 0 }];

  while (queue.length > 0) {
    const { logicalDir, physicalDir, depth } = queue.pop()!;
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(physicalDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const logicalPath = logicalDir ? `${logicalDir}/${entry.name}` : entry.name;
      const physicalPath = join(physicalDir, entry.name);

      if (entry.isSymbolicLink()) {
        if (!config.files.followSymlinks || depth >= config.files.symlinkMaxDepth) {
          continue;
        }

        let st: import('node:fs').Stats;
        let realTarget: string;
        try {
          st = statSync(physicalPath);
          realTarget = realpathSync(physicalPath);
        } catch {
          // Broken symlink
          continue;
        }

        if (visitedPhysical.has(realTarget)) {
          // Cycle or duplicate traversal
          continue;
        }
        visitedPhysical.add(realTarget);

        if (st.isDirectory()) {
          const cleanDir = logicalPath.endsWith('/') ? logicalPath.slice(0, -1) : logicalPath;
          if (hardPrune.some((pat) => matchesPattern(cleanDir, pat))) {
            continue;
          }
          if (filter.inUniverse(cleanDir)) {
            knownPathsSet.add(cleanDir);
            knownPathsSet.add(cleanDir + '/');
          }
          queue.push({ logicalDir: logicalPath, physicalDir: realTarget, depth: depth + 1 });
        } else if (st.isFile()) {
          if (!filter.inUniverse(logicalPath)) {
            continue;
          }
          knownPathsSet.add(logicalPath);
          if (logicalPath.toLowerCase().endsWith('.md')) {
            try {
              const content = stripBom(readFileSync(realTarget, 'utf8'));
              documents.set(logicalPath, content);
            } catch {
              // Unreadable document is skipped
            }
          }
        }
      } else if (entry.isDirectory()) {
        const cleanDir = logicalPath.endsWith('/') ? logicalPath.slice(0, -1) : logicalPath;
        if (hardPrune.some((pat) => matchesPattern(cleanDir, pat))) {
          continue;
        }
        if (filter.inUniverse(cleanDir)) {
          knownPathsSet.add(cleanDir);
          knownPathsSet.add(cleanDir + '/');
        }
        queue.push({ logicalDir: logicalPath, physicalDir: physicalPath, depth });
      } else if (entry.isFile()) {
        if (!filter.inUniverse(logicalPath)) {
          continue;
        }
        knownPathsSet.add(logicalPath);
        if (logicalPath.toLowerCase().endsWith('.md')) {
          try {
            const content = stripBom(readFileSync(physicalPath, 'utf8'));
            documents.set(logicalPath, content);
          } catch {
            // Unreadable document is skipped
          }
        }
      }
    }
  }

  return {
    documents,
    knownPaths: [...knownPathsSet].sort(),
  };
}
