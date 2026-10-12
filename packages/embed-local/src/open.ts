import type { EmbeddingProvider, RerankProvider } from '@mdlineage/retrieve';
import { DEFAULT_EMBED_PROFILE_ID, DEFAULT_RERANK_PROFILE_ID, findProfile } from './catalog.js';
import { LocalEmbedder } from './embedder.js';
import { assessInstalled } from './install.js';
import { resolveModelDir } from './paths.js';
import { LocalReranker } from './reranker.js';

export interface OpenLocalRetrievalOptions {
  readonly modelDir?: string;
  readonly embedProfile?: string;
  readonly rerankProfile?: string;
}

export interface OpenLocalRetrieval {
  readonly ready: boolean;
  readonly embedder: EmbeddingProvider | null;
  readonly reranker: RerankProvider | null;
  readonly degraded: readonly string[];
}

/**
 * Filesystem readiness only. A missing weight does not download, does not
 * import transformers.js, and does not probe CUDA. Sessions start on the
 * first embed or rerank call.
 */
export async function openLocalRetrieval(options: OpenLocalRetrievalOptions = {}): Promise<OpenLocalRetrieval> {
  const modelDir = resolveModelDir(options.modelDir);
  const embedId = options.embedProfile ?? DEFAULT_EMBED_PROFILE_ID;
  const rerankId = options.rerankProfile ?? DEFAULT_RERANK_PROFILE_ID;
  const embedProfile = findProfile(embedId);
  if (embedProfile === undefined || embedProfile.role !== 'embed') {
    return {
      ready: false,
      embedder: null,
      reranker: null,
      degraded: [`models-not-ready: unknown embed profile '${embedId}'; falling back to lexical`],
    };
  }
  const embedState = await assessInstalled(embedProfile, modelDir);
  if (!embedState.ready) {
    return {
      ready: false,
      embedder: null,
      reranker: null,
      degraded: [
        `models-not-ready: ${embedProfile.id} (${embedState.problems.join('; ')}); falling back to lexical`,
      ],
    };
  }

  const degraded: string[] = [];
  let reranker: RerankProvider | null = null;
  const rerankProfile = findProfile(rerankId);
  if (rerankProfile === undefined || rerankProfile.role !== 'rerank') {
    degraded.push(`reranker-unavailable: unknown profile '${rerankId}'`);
  } else {
    const rerankState = await assessInstalled(rerankProfile, modelDir);
    if (!rerankState.ready) {
      degraded.push(`reranker-unavailable: ${rerankProfile.id} (${rerankState.problems.join('; ')})`);
    } else {
      reranker = new LocalReranker(rerankProfile, modelDir);
    }
  }
  return {
    ready: true,
    embedder: new LocalEmbedder(embedProfile, modelDir),
    reranker,
    degraded,
  };
}
