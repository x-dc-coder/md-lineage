/**
 * `mdlineage retrieve search <query>` (Issue #3).
 *
 * Read-only section search: loadConfig → scanWorkspaceUniverse →
 * extractSections → lexical BM25, or hybrid (BM25 + dense + RRF + rerank)
 * when `@mdlineage/embed-local` is installed and its models are ready.
 * The embedder is loaded with a dynamic import so this package does not
 * depend on the native runtime. A missing package or a missing model is a
 * lexical result plus a `degraded` note, never a failing exit.
 *
 * Exit codes follow the determinism iron rule: 0 = success (including every
 * degraded state), 2 = usage error. An explicit `--config` that cannot load
 * is a usage mistake, not a retrieval failure.
 */

import { loadConfig, scanWorkspaceUniverse, extractSections } from '@mdlineage/validator';
import {
  FileVectorStore,
  isInTreeRealpath,
  searchCorpus,
  type Bm25Doc,
  type EmbeddingProvider,
  type RerankProvider,
} from '@mdlineage/retrieve';

export interface RetrieveSearchOptions {
  format: 'text' | 'json';
  configFile?: string;
  cwd: string;
  top: number;
  query: string;
  /** `auto` uses hybrid when a local model is ready, otherwise lexical. */
  mode: 'auto' | 'lexical' | 'hybrid';
  /** False skips the reranker even when a local one is ready. */
  rerank: boolean;
  rerankDepth: number;
  /**
   * Model cache directory forwarded to embed-local. Unset asks the package
   * for its default (`~/.mdlineage/models`).
   */
  modelDir?: string;
}

/** Rough snippet budget: ~100 characters of section body, single line. */
const SNIPPET_LENGTH = 100;

interface LocalRetrieval {
  readonly ready: boolean;
  readonly embedder: EmbeddingProvider | null;
  readonly reranker: RerankProvider | null;
  readonly degraded: readonly string[];
}

type LocalLoad = { ok: true; retrieval: LocalRetrieval } | { ok: false; reason: string };

export async function retrieveSearch(options: RetrieveSearchOptions): Promise<number> {
  const loaded = loadConfig(options.configFile, options.configFile ? undefined : options.cwd);
  if (options.configFile !== undefined && loaded.diagnostics.some((d) => d.severity === 'error')) {
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

  const resolved = await resolveProviders(options);
  for (const note of resolved.notes) {
    process.stderr.write(`mdlineage: ${note}\n`);
    degraded.push(note);
  }
  let outcome;
  try {
    outcome = await searchCorpus({
      query: options.query,
      sections: docs,
      top: options.top,
      mode: resolved.mode,
      rerankDepth: options.rerankDepth,
      ...(resolved.embedder === undefined ? {} : { embedder: resolved.embedder }),
      ...(resolved.reranker === undefined ? {} : { reranker: resolved.reranker }),
      ...(resolved.store === undefined ? {} : { store: resolved.store }),
    });
  } finally {
    await resolved.embedder?.dispose();
    await resolved.reranker?.dispose();
  }
  for (const note of outcome.degraded) {
    process.stderr.write(`mdlineage: ${note}\n`);
    degraded.push(note);
  }

  const results = outcome.hits.map((hit, i) => ({
    rank: i + 1,
    path: hit.path,
    slug: hit.slug,
    title: hit.title,
    score: hit.score,
    scoreKind: hit.scoreKind,
    snippet: snippet(hit.text),
  }));

  if (options.format === 'json') {
    process.stdout.write(
      `${JSON.stringify({ query: options.query, mode: outcome.mode, results, degraded }, null, 2)}\n`,
    );
  } else if (results.length === 0) {
    const echo = options.query.replace(/\s+/g, ' ').trim();
    process.stdout.write(`mdlineage: no sections matched '${echo}'\n`);
  } else {
    for (const r of results) {
      process.stdout.write(`${r.rank}  ${r.path}#${r.slug}  ${r.score.toFixed(4)}  ${r.title}  ${r.snippet}\n`);
    }
    process.stdout.write(
      `mdlineage: ${results.length} section${results.length === 1 ? '' : 's'} matched (${outcome.mode})\n`,
    );
  }
  return 0;
}

interface ResolvedProviders {
  readonly mode: 'lexical' | 'hybrid';
  readonly notes: readonly string[];
  readonly embedder?: EmbeddingProvider;
  readonly reranker?: RerankProvider;
  readonly store?: FileVectorStore;
}

async function resolveProviders(options: RetrieveSearchOptions): Promise<ResolvedProviders> {
  if (options.mode === 'lexical') return { mode: 'lexical', notes: [] };

  const loaded = await loadEmbedLocal(options.modelDir);
  if (!loaded.ok) {
    const reason = options.mode === 'hybrid' ? `hybrid-unavailable: ${loaded.reason}` : loaded.reason;
    return { mode: 'lexical', notes: [reason] };
  }
  const retrieval = loaded.retrieval;
  if (!retrieval.ready || retrieval.embedder === null) {
    const notes =
      retrieval.degraded.length > 0 ? [...retrieval.degraded] : ['models-not-ready: falling back to lexical'];
    await retrieval.embedder?.dispose();
    await retrieval.reranker?.dispose();
    return { mode: 'lexical', notes };
  }

  const embedder = retrieval.embedder;
  const reranker = options.rerank ? (retrieval.reranker ?? undefined) : undefined;
  if (!options.rerank && retrieval.reranker !== null) {
    await retrieval.reranker.dispose();
  }
  const store =
    embedder.meta.dim > 0
      ? new FileVectorStore(options.cwd, {
          model: embedder.meta.model,
          dtype: embedder.meta.dtype,
          dim: embedder.meta.dim,
          algo: embedder.meta.algo,
        })
      : undefined;
  return {
    mode: 'hybrid',
    notes: [...retrieval.degraded],
    embedder,
    ...(reranker === undefined ? {} : { reranker }),
    ...(store === undefined ? {} : { store }),
  };
}

/**
 * Load `@mdlineage/embed-local` if it is installed. A missing module is the
 * normal lexical fallback, not an error: the specifier is a variable so
 * TypeScript does not require the package to be resolvable at build time.
 */
async function loadEmbedLocal(modelDir: string | undefined): Promise<LocalLoad> {
  const specifier = '@mdlineage/embed-local';
  try {
    const mod = (await import(specifier)) as {
      openLocalRetrieval?: (options: { modelDir?: string }) => Promise<LocalRetrieval>;
    };
    if (typeof mod.openLocalRetrieval !== 'function') {
      return { ok: false, reason: 'embed-local-unavailable: openLocalRetrieval is missing; falling back to lexical' };
    }
    const retrieval = await mod.openLocalRetrieval(modelDir === undefined ? {} : { modelDir });
    return { ok: true, retrieval };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const missing =
      message.includes('ERR_MODULE_NOT_FOUND') ||
      message.includes('Cannot find package') ||
      message.includes('Cannot find module');
    if (missing) return { ok: false, reason: 'embed-local-unavailable: falling back to lexical' };
    return { ok: false, reason: `embed-local-unavailable: ${message}; falling back to lexical` };
  }
}

export interface RetrieveSetupOptions {
  readonly profile?: string;
  readonly mirror?: string;
  readonly modelDir?: string;
}

interface SetupReportShape {
  readonly exitCode: 0 | 1 | 2;
  readonly lines: readonly string[];
}

/**
 * `mdlineage retrieve setup`. Downloads pinned weights, or prints export
 * guidance for a profile that has no published file. A missing embed-local
 * package is a usage failure (exit 2): setup cannot degrade to lexical.
 */
export async function retrieveSetup(options: RetrieveSetupOptions): Promise<number> {
  const specifier = '@mdlineage/embed-local';
  let imported: unknown;
  try {
    imported = await import(specifier);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const missing =
      message.includes('ERR_MODULE_NOT_FOUND') ||
      message.includes('Cannot find package') ||
      message.includes('Cannot find module');
    const reason = missing ? 'package is not installed' : message;
    process.stderr.write(`mdlineage: embed-local-unavailable: ${reason}\n`);
    return 2;
  }
  if (!isSetupCaller(imported)) {
    process.stderr.write('mdlineage: embed-local-unavailable: setupLocalModels is missing\n');
    return 2;
  }
  const report: unknown = await imported.setupLocalModels(options);
  if (!isSetupReport(report)) {
    process.stderr.write('mdlineage: embed-local-unavailable: setupLocalModels returned an unexpected report\n');
    return 2;
  }
  const stream = report.exitCode === 0 ? process.stdout : process.stderr;
  for (const line of report.lines) stream.write(`mdlineage: ${line}\n`);
  return report.exitCode;
}

function isSetupCaller(value: unknown): value is {
  setupLocalModels(options: RetrieveSetupOptions): Promise<unknown>;
} {
  return isRecord(value) && typeof value.setupLocalModels === 'function';
}

function isSetupReport(value: unknown): value is SetupReportShape {
  if (!isRecord(value)) return false;
  if (value.exitCode !== 0 && value.exitCode !== 1 && value.exitCode !== 2) return false;
  return Array.isArray(value.lines) && value.lines.every((line) => typeof line === 'string');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
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
