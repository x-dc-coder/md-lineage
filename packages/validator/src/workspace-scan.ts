/**
 * Unified workspace directory scanning for LSP and MCP channels.
 *
 * Discovers Markdown documents and builds the known-paths universe
 * (Markdown, non-Markdown files, and directories in both `dir` and `dir/` forms).
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import type { Config } from './config.js';
import { PathFilter, matchesPattern } from './path-filter.js';

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
  const queue: string[] = [absRoot];

  while (queue.length > 0) {
    const currentDir = queue.pop() as string;
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);
      const rel = relative(absRoot, fullPath).split(sep).join('/');
      if (rel === '' || rel.startsWith('..')) continue;

      let isDirectory = false;
      let isFile = false;

      if (entry.isDirectory()) {
        isDirectory = true;
      } else if (entry.isFile()) {
        isFile = true;
      } else {
        try {
          const st = statSync(fullPath);
          isDirectory = st.isDirectory();
          isFile = st.isFile();
        } catch {
          continue;
        }
      }

      if (isDirectory) {
        const cleanDir = rel.endsWith('/') ? rel.slice(0, -1) : rel;
        // Check if hard pruned
        if (hardPrune.some((pat) => matchesPattern(cleanDir, pat))) {
          continue;
        }
        if (filter.inUniverse(cleanDir)) {
          knownPathsSet.add(cleanDir);
          knownPathsSet.add(cleanDir + '/');
        }
        queue.push(fullPath);
      } else if (isFile) {
        if (!filter.inUniverse(rel)) {
          continue;
        }
        knownPathsSet.add(rel);
        if (rel.toLowerCase().endsWith('.md')) {
          try {
            const content = readFileSync(fullPath, 'utf8');
            documents.set(rel, content);
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
