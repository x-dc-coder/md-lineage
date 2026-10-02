/**
 * `mdlineage index rebuild` (spec §10.1).
 *
 * Scans the workspace, builds the in-memory workspace index, and reports the
 * index size plus the diagnostics the workspace pass finds (duplicate ids,
 * dangling targets, cycles, per-document parse errors). Per §10.3 the index is
 * derived data: nothing is written to disk, so "rebuild" only means "build
 * from scratch and report", not "refresh a cache file".
 */

import { readFileSync } from 'node:fs';
import {
  loadConfig,
  createWorkspaceIndex,
  validateWorkspace,
  gitClocksForIndex,
  stripBom,
} from '@mdlineage/validator';
import { expandMarkdownPaths, knownWorkspacePaths } from './paths.js';

export interface IndexRebuildOptions {
  format: 'text' | 'json';
  configFile?: string;
  cwd: string;
  exclude?: readonly string[];
}

/** Build the index fresh and report; 0 clean, 1 on error-severity diagnostics. */
export async function indexRebuild(options: IndexRebuildOptions): Promise<number> {
  const loaded = loadConfig(options.configFile, options.configFile ? undefined : options.cwd);
  for (const diag of loaded.diagnostics) {
    process.stderr.write(`mdlineage: ${diag.code} ${diag.severity} ${diag.message}\n`);
  }

  const { files, missed } = expandMarkdownPaths(['.'], options.cwd, {
    config: loaded.config,
    exclude: options.exclude,
  });
  if (missed.length > 0) {
    for (const path of missed) process.stderr.write(`mdlineage: no such file or pattern: ${path}\n`);
    return 2;
  }

  const entries: Array<[string, string]> = [];
  let unreadable = 0;
  for (const file of files) {
    try {
      entries.push([file.asGiven, stripBom(readFileSync(file.path, 'utf8'))]);
    } catch (error) {
      unreadable++;
      process.stderr.write(`mdlineage: ${file.asGiven}:1:1 MDL900 error Could not read file: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }

  // Known paths use the entries' vocabulary (cwd-relative), so a link to a real
  // non-Markdown file or directory is not misread as MDL401.
  const knownPaths = new Set(knownWorkspacePaths(options.cwd, { config: loaded.config, exclude: options.exclude }));
  const index = createWorkspaceIndex(entries, loaded.config, knownPaths);
  const gitClocks = await gitClocksForIndex(index, options.cwd);
  const diagnostics = validateWorkspace(index, { gitClocks });

  let ids = 0;
  for (const _ of index.ids()) ids++;
  let relations = 0;
  let anchors = 0;
  for (const path of index.paths()) {
    relations += index.relationsOf(path).length;
    anchors += index.anchorsOf(path).size;
  }
  const stats = { files: index.size, ids, relations, anchors };
  const errors = diagnostics.filter((d) => d.severity === 'error').length;

  if (options.format === 'json') {
    process.stdout.write(
      `${JSON.stringify(
        {
          stats,
          diagnostics: diagnostics.map((d) => ({
            path: d.path,
            code: d.code,
            severity: d.severity,
            message: d.message,
            line: d.range.start.line,
            column: d.range.start.column,
          })),
        },
        null,
        2,
      )}\n`,
    );
  } else {
    for (const d of diagnostics) {
      process.stdout.write(`${d.path}:${d.range.start.line}:${d.range.start.column} ${d.code} ${d.severity} ${d.message}\n`);
    }
    process.stdout.write(
      `mdlineage: index rebuilt: ${stats.files} file${stats.files === 1 ? '' : 's'}, ` +
        `${ids} id${ids === 1 ? '' : 's'}, ${relations} relation${relations === 1 ? '' : 's'}, ` +
        `${anchors} anchor${anchors === 1 ? '' : 's'}, ${diagnostics.length} diagnostic${diagnostics.length === 1 ? '' : 's'} ` +
        `(${errors} error${errors === 1 ? '' : 's'}), not persisted\n`,
    );
  }
  return loaded.diagnostics.length > 0 || errors > 0 || unreadable > 0 ? 1 : 0;
}
