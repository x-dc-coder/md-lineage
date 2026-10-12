/**
 * `mdlineage retrieve search <query>` (Issue #3 Phase 1).
 *
 * Read-only lexical search over the workspace: loadConfig →
 * scanWorkspaceUniverse → extractSections per document → BM25 → ranked
 * output. Phase 1 is BM25-only by definition (`--bm25-only` is the default
 * behaviour and the flag is a forward-compat placeholder); the dense branch
 * and reranker arrive in Phase 2.
 *
 * Exit codes follow the issue's determinism iron rule: 0 = success
 * (including every degraded state), 2 = usage error. Retrieval can never
 * fail a gate — except an explicit `--config` the user pointed at a file
 * that cannot load, which is a usage mistake, not a retrieval failure.
 */

import { loadConfig, scanWorkspaceUniverse, extractSections } from '@mdlineage/validator';
import { Bm25Index, isInTreeRealpath, type Bm25Doc } from '@mdlineage/retrieve';

export interface RetrieveSearchOptions {
  format: 'text' | 'json';
  configFile?: string;
  cwd: string;
  top: number;
  query: string;
}

/** Rough snippet budget: ~100 characters of section body, single line. */
const SNIPPET_LENGTH = 100;

export async function retrieveSearch(options: RetrieveSearchOptions): Promise<number> {
  const loaded = loadConfig(options.configFile, options.configFile ? undefined : options.cwd);
  if (options.configFile !== undefined && loaded.diagnostics.some((d) => d.severity === 'error')) {
    // An explicitly named config that fails to load is a usage error: the
    // caller asked for THAT file, and silently falling back to defaults would
    // search a differently-configured corpus than the one they named.
    for (const diag of loaded.diagnostics) {
      process.stderr.write(`mdlineage: ${diag.code} ${diag.severity} ${diag.message}\n`);
    }
    process.stderr.write(`mdlineage: cannot load config '${options.configFile}'\n`);
    return 2;
  }

  const degraded: string[] = [];
  for (const diag of loaded.diagnostics) {
    const line = `${diag.code} ${diag.severity} ${diag.message}`;
    process.stderr.write(`mdlineage: ${line}\n`);
    degraded.push(line);
  }

  const universe = scanWorkspaceUniverse(options.cwd, loaded.config);
  const docs: Bm25Doc[] = [];
  for (const [path, content] of universe.documents) {
    // Symlinked documents whose real location escapes the workspace are not
    // corpus material: retrieval prints content, and an out-of-tree target
    // would leak external bytes under an in-tree path.
    if (!isInTreeRealpath(options.cwd, path)) {
      const note = `skipped out-of-tree symlink: ${path}`;
      process.stderr.write(`mdlineage: ${note}\n`);
      degraded.push(note);
      continue;
    }
    for (const section of extractSections(content)) {
      docs.push({ path, slug: section.slug, title: section.title, text: section.text });
    }
  }

  const index = new Bm25Index(docs);
  const hits = index.search(options.query, options.top);
  const results = hits.map((hit, i) => ({
    rank: i + 1,
    path: hit.path,
    slug: hit.slug,
    title: hit.title,
    score: hit.score,
    snippet: snippet(hit.text),
  }));

  if (options.format === 'json') {
    process.stdout.write(
      `${JSON.stringify(
        {
          query: options.query,
          mode: 'bm25',
          results,
          degraded,
        },
        null,
        2,
      )}\n`,
    );
  } else if (results.length === 0) {
    // The query echoes into the terminal: collapse its whitespace so a
    // multi-line or heavily indented query cannot scramble the output.
    const echo = options.query.replace(/\s+/g, ' ').trim();
    process.stdout.write(`mdlineage: no sections matched '${echo}'\n`);
  } else {
    for (const r of results) {
      process.stdout.write(`${r.rank}  ${r.path}#${r.slug}  ${r.score.toFixed(4)}  ${r.title}  ${r.snippet}\n`);
    }
    process.stdout.write(`mdlineage: ${results.length} section${results.length === 1 ? '' : 's'} matched (bm25)\n`);
  }
  return 0;
}

/**
 * First ~100 characters of the body, whitespace collapsed to one line. The
 * cut is by CODE POINT: slicing UTF-16 units can split a surrogate pair and
 * emit a broken character at the boundary.
 */
function snippet(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  const chars = [...collapsed];
  return chars.length <= SNIPPET_LENGTH ? collapsed : `${chars.slice(0, SNIPPET_LENGTH).join('')}…`;
}
