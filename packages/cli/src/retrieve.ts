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
 * fail a gate.
 */

import { loadConfig, scanWorkspaceUniverse, extractSections } from '@mdlineage/validator';
import { Bm25Index, type Bm25Doc } from '@mdlineage/retrieve';

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
  for (const diag of loaded.diagnostics) {
    process.stderr.write(`mdlineage: ${diag.code} ${diag.severity} ${diag.message}\n`);
  }

  const universe = scanWorkspaceUniverse(options.cwd, loaded.config);
  const docs: Bm25Doc[] = [];
  for (const [path, content] of universe.documents) {
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
          degraded: [],
        },
        null,
        2,
      )}\n`,
    );
  } else if (results.length === 0) {
    process.stdout.write(`mdlineage: no sections matched '${options.query}'\n`);
  } else {
    for (const r of results) {
      process.stdout.write(`${r.rank}  ${r.path}#${r.slug}  ${r.score.toFixed(4)}  ${r.title}  ${r.snippet}\n`);
    }
    process.stdout.write(`mdlineage: ${results.length} section${results.length === 1 ? '' : 's'} matched (bm25)\n`);
  }
  return 0;
}

/** First ~100 characters of the body, whitespace collapsed to one line. */
function snippet(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length <= SNIPPET_LENGTH ? collapsed : `${collapsed.slice(0, SNIPPET_LENGTH)}…`;
}
