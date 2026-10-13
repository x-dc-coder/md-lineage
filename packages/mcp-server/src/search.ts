/**
 * `search_documents` for the MCP server (Issue #3 Phase 2).
 *
 * The embedder and reranker are created on the first hybrid call and kept
 * for the life of this server. Lexical calls never import `@mdlineage/embed-local`.
 * A missing package or a missing model is a lexical result plus a degraded
 * note. `dispose` runs when the server transport closes.
 */

import {
  extractSections,
  scanWorkspaceUniverse,
  scanBoundary,
  parseFrontmatter,
  buildLineMap,
  type Config,
} from '@mdlineage/validator';
import {
  FileVectorStore,
  isInTreeRealpath,
  searchCorpus,
  discoverCandidatePairs,
  type CandidateDocMeta,
  type CandidatePair,
  type CorpusSection,
  type EmbeddingProvider,
  type RerankProvider,
} from '@mdlineage/retrieve';

const SNIPPET_LENGTH = 100;

export interface SearchDocumentsRequest {
  readonly root: string;
  readonly config: Config;
  readonly query: string;
  readonly top: number;
  readonly mode: 'lexical' | 'hybrid';
}

export interface SearchDocumentsHit {
  readonly rank: number;
  readonly path: string;
  readonly slug: string;
  readonly title: string;
  readonly score: number;
  readonly snippet: string;
}

export interface SearchDocumentsResult {
  readonly query: string;
  readonly mode: 'lexical' | 'hybrid';
  readonly results: readonly SearchDocumentsHit[];
  readonly degraded: readonly string[];
}

export interface DiscoverRelationsRequest {
  readonly root: string;
  readonly config: Config;
  readonly sourcePath?: string;
  readonly top: number;
  readonly threshold?: number;
  readonly mode: 'lexical' | 'hybrid';
}

export interface DiscoverRelationsResult {
  readonly mode: 'lexical' | 'hybrid';
  readonly source?: string;
  readonly pairs: readonly CandidatePair[];
  readonly degraded: readonly string[];
}

interface OpenedRetrieval {
  readonly ready: boolean;
  readonly embedder: EmbeddingProvider | null;
  readonly reranker: RerankProvider | null;
  readonly degraded: readonly string[];
}

interface HeldSession {
  readonly embedder: EmbeddingProvider | null;
  readonly reranker: RerankProvider | null;
  readonly store?: FileVectorStore;
  readonly notes: readonly string[];
  readonly hybrid: boolean;
}

/** One retrieval session per MCP server. */
export class RetrievalSession {
  private opened: Promise<HeldSession> | undefined;

  constructor(
    private readonly root: string,
    private readonly modelDir: string | undefined,
  ) {}

  async search(request: SearchDocumentsRequest): Promise<SearchDocumentsResult> {
    const sections: CorpusSection[] = [];
    const degraded: string[] = [];
    const universe = scanWorkspaceUniverse(request.root, request.config);
    for (const [path, content] of universe.documents) {
      if (!isInTreeRealpath(request.root, path)) {
        degraded.push(`skipped out-of-tree symlink: ${path}`);
        continue;
      }
      for (const section of extractSections(content)) {
        sections.push({ path, slug: section.slug, title: section.title, text: section.text });
      }
    }

    const held = request.mode === 'lexical' ? lexicalHold() : await this.hybrid();
    const outcome = await searchCorpus({
      query: request.query,
      sections,
      top: request.top,
      mode: held.hybrid ? 'hybrid' : 'lexical',
      ...(held.embedder === null ? {} : { embedder: held.embedder }),
      ...(held.reranker === null ? {} : { reranker: held.reranker }),
      ...(held.store === undefined ? {} : { store: held.store }),
    });
    return {
      query: request.query,
      mode: outcome.mode,
      results: outcome.hits.map((hit, index) => ({
        rank: index + 1,
        path: hit.path,
        slug: hit.slug,
        title: hit.title,
        score: hit.score,
        scoreKind: hit.scoreKind,
        snippet: snippet(hit.text),
      })),
      degraded: [...degraded, ...held.notes, ...outcome.degraded],
    };
  }

  async discover(request: DiscoverRelationsRequest): Promise<DiscoverRelationsResult> {
    const sections: CorpusSection[] = [];
    const docsMeta = new Map<string, CandidateDocMeta>();
    const degraded: string[] = [];
    const universe = scanWorkspaceUniverse(request.root, request.config);
    for (const [path, content] of universe.documents) {
      if (!isInTreeRealpath(request.root, path)) {
        degraded.push(`skipped out-of-tree symlink: ${path}`);
        continue;
      }
      docsMeta.set(path, extractDocMeta(content));
      for (const section of extractSections(content)) {
        sections.push({ path, slug: section.slug, title: section.title, text: section.text });
      }
    }

    const held = request.mode === 'lexical' ? lexicalHold() : await this.hybrid();
    const outcome = await discoverCandidatePairs({
      sections,
      docsMeta,
      sourcePath: request.sourcePath,
      top: request.top,
      threshold: request.threshold,
      mode: held.hybrid ? 'hybrid' : 'lexical',
      filterExisting: true,
      ...(held.embedder === null ? {} : { embedder: held.embedder }),
      ...(held.reranker === null ? {} : { reranker: held.reranker }),
      ...(held.store === undefined ? {} : { store: held.store }),
    });

    return {
      mode: held.hybrid ? 'hybrid' : 'lexical',
      source: request.sourcePath,
      pairs: outcome.pairs,
      degraded: [...degraded, ...held.notes, ...outcome.degraded],
    };
  }

  async dispose(): Promise<void> {
    const pending = this.opened;
    this.opened = undefined;
    if (pending === undefined) return;
    try {
      const held = await pending;
      await held.embedder?.dispose();
      await held.reranker?.dispose();
    } catch (error) {
      // The transport is already closing. A session that fails to release
      // must not replace the shutdown with a second failure.
      if (error instanceof Error) return;
      throw error;
    }
  }

  private hybrid(): Promise<HeldSession> {
    if (this.opened === undefined) this.opened = this.open();
    return this.opened;
  }

  private async open(): Promise<HeldSession> {
    const loaded = await loadEmbedLocal(this.modelDir);
    if (!loaded.ok) return { embedder: null, reranker: null, notes: [loaded.reason], hybrid: false };
    const retrieval = loaded.retrieval;
    if (!retrieval.ready || retrieval.embedder === null) {
      const notes =
        retrieval.degraded.length > 0 ? [...retrieval.degraded] : ['models-not-ready: falling back to lexical'];
      await retrieval.embedder?.dispose();
      await retrieval.reranker?.dispose();
      return { embedder: null, reranker: null, notes, hybrid: false };
    }
    const embedder = retrieval.embedder;
    const store =
      embedder.meta.dim > 0
        ? new FileVectorStore(this.root, {
            model: embedder.meta.model,
            dtype: embedder.meta.dtype,
            dim: embedder.meta.dim,
            algo: embedder.meta.algo,
          })
        : undefined;
    return {
      embedder,
      reranker: retrieval.reranker,
      notes: [...retrieval.degraded],
      hybrid: true,
      ...(store === undefined ? {} : { store }),
    };
  }
}

function lexicalHold(): HeldSession {
  return { embedder: null, reranker: null, notes: [], hybrid: false };
}

async function loadEmbedLocal(modelDir: string | undefined): Promise<
  { ok: true; retrieval: OpenedRetrieval } | { ok: false; reason: string }
> {
  const specifier = '@mdlineage/embed-local';
  try {
    const imported: unknown = await import(specifier);
    if (!isOpener(imported)) {
      return { ok: false, reason: 'embed-local-unavailable: openLocalRetrieval is missing; falling back to lexical' };
    }
    const retrieval: unknown = await imported.openLocalRetrieval(modelDir === undefined ? {} : { modelDir });
    if (!isOpenedRetrieval(retrieval)) {
      return { ok: false, reason: 'embed-local-unavailable: openLocalRetrieval returned an unexpected value; falling back to lexical' };
    }
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

function isOpener(value: unknown): value is {
  openLocalRetrieval(options: { modelDir?: string }): Promise<unknown>;
} {
  return isRecord(value) && typeof value.openLocalRetrieval === 'function';
}

function isOpenedRetrieval(value: unknown): value is OpenedRetrieval {
  if (!isRecord(value) || typeof value.ready !== 'boolean') return false;
  if (!Array.isArray(value.degraded) || !value.degraded.every((note) => typeof note === 'string')) return false;
  const embedderOk = value.embedder === null || isEmbedder(value.embedder);
  const rerankerOk = value.reranker === null || isReranker(value.reranker);
  return embedderOk && rerankerOk;
}

function isEmbedder(value: unknown): value is EmbeddingProvider {
  if (!isRecord(value) || typeof value.embed !== 'function' || typeof value.dispose !== 'function') return false;
  if (!isRecord(value.meta)) return false;
  return typeof value.meta.model === 'string' && typeof value.meta.dtype === 'string' && typeof value.meta.dim === 'number';
}

function isReranker(value: unknown): value is RerankProvider {
  return isRecord(value) && typeof value.rerank === 'function' && typeof value.dispose === 'function';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function snippet(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  const chars = [...collapsed];
  return chars.length <= SNIPPET_LENGTH ? collapsed : `${chars.slice(0, SNIPPET_LENGTH).join('')}…`;
}

function extractDocMeta(content: string): CandidateDocMeta {
  const boundary = scanBoundary(content);
  if (!boundary) return {};
  const lineMap = buildLineMap(content);
  const { parsed } = parseFrontmatter(boundary.raw, boundary.rawStart, lineMap);
  if (!parsed || !parsed.data || typeof parsed.data !== 'object') return {};
  const mdlineage = parsed.data.mdlineage;
  if (!mdlineage || typeof mdlineage !== 'object') return {};
  const id =
    typeof (mdlineage as Record<string, unknown>).id === 'string'
      ? ((mdlineage as Record<string, unknown>).id as string)
      : undefined;
  const relsRaw = (mdlineage as Record<string, unknown>).relations;
  const relations: { target: string }[] = [];
  if (Array.isArray(relsRaw)) {
    for (const r of relsRaw) {
      if (r && typeof r === 'object' && typeof (r as Record<string, unknown>).target === 'string') {
        relations.push({ target: (r as Record<string, unknown>).target as string });
      }
    }
  }
  return { ...(id !== undefined ? { id } : {}), relations };
}
