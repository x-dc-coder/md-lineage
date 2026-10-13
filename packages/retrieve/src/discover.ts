/**
 * Candidate relation pair discovery (Issue #3 Phase 3).
 *
 * Scans document corpus for potential inter-document relationships,
 * producing candidate pairs with bidirectional evidence anchors.
 * Filters out existing frontmatter relations and self-references to
 * control downstream LLM reasoning budget.
 */
import type { CorpusSection } from './pipeline.js';
import { searchCorpus, type SearchRequest } from './pipeline.js';
import type { EmbeddingProvider, RerankProvider } from './provider.js';
import type { VectorStore } from './vector-store.js';

export interface CandidateDocMeta {
  readonly id?: string;
  readonly relations?: readonly { readonly target: string }[];
}

export interface CandidatePair {
  readonly sourcePath: string;
  readonly sourceSlug: string;
  readonly targetPath: string;
  readonly targetSlug: string;
  readonly targetId?: string;
  readonly score: number;
  readonly scoreKind: 'bm25' | 'rrf' | 'yes';
  readonly evidenceAnchor: string;
  readonly snippet: string;
}

export interface DiscoverOptions {
  readonly sections: readonly CorpusSection[];
  readonly docsMeta: ReadonlyMap<string, CandidateDocMeta>;
  readonly sourcePath?: string;
  readonly top?: number;
  readonly threshold?: number;
  readonly mode?: 'lexical' | 'hybrid';
  readonly filterExisting?: boolean;
  readonly embedder?: EmbeddingProvider;
  readonly reranker?: RerankProvider | null;
  readonly store?: VectorStore;
}

export interface DiscoverOutcome {
  readonly pairs: readonly CandidatePair[];
  readonly degraded: readonly string[];
}

const DEFAULT_TOP_CANDIDATES = 10;
const DEFAULT_SNIPPET_LENGTH = 120;

/**
 * Discover candidate relation pairs across the corpus or for a single source file.
 */
export async function discoverCandidatePairs(options: DiscoverOptions): Promise<DiscoverOutcome> {
  const degraded: string[] = [];
  const topLimit = options.top !== undefined && options.top > 0 ? options.top : DEFAULT_TOP_CANDIDATES;
  const threshold = options.threshold ?? Number.NEGATIVE_INFINITY;
  const filterExisting = options.filterExisting ?? true;
  const mode = options.mode ?? 'lexical';

  // Group sections by document path
  const sectionsByDoc = new Map<string, CorpusSection[]>();
  for (const section of options.sections) {
    const list = sectionsByDoc.get(section.path) ?? [];
    list.push(section);
    sectionsByDoc.set(section.path, list);
  }

  // Determine source document paths
  const sourcePaths =
    options.sourcePath !== undefined ? [options.sourcePath] : [...sectionsByDoc.keys()];

  const pairs: CandidatePair[] = [];
  const seenPairKeys = new Set<string>();

  for (const srcPath of sourcePaths) {
    const srcSections = sectionsByDoc.get(srcPath);
    if (!srcSections || srcSections.length === 0) continue;

    const srcMeta = options.docsMeta.get(srcPath);
    const existingTargets = new Set<string>();
    if (filterExisting && srcMeta?.relations) {
      for (const rel of srcMeta.relations) {
        existingTargets.add(rel.target);
      }
    }

    // Build a representative query for each source section or the document preamble
    for (const srcSection of srcSections) {
      const queryText = `${srcSection.title} ${srcSection.text}`.slice(0, 300).trim();
      if (queryText.length === 0) continue;

      // Filter corpus sections to only other documents (no self-references)
      const targetCorpus = options.sections.filter((s) => s.path !== srcPath);
      if (targetCorpus.length === 0) continue;

      const searchReq: SearchRequest = {
        query: queryText,
        sections: targetCorpus,
        top: topLimit,
        mode,
        embedder: options.embedder,
        reranker: options.reranker,
        store: options.store,
      };

      const outcome = await searchCorpus(searchReq);
      for (const note of outcome.degraded) {
        if (!degraded.includes(note)) degraded.push(note);
      }

      for (const hit of outcome.hits) {
        if (hit.score < threshold) continue;

        const targetMeta = options.docsMeta.get(hit.path);
        // If target has an ID that is already linked, filter it out
        if (targetMeta?.id && existingTargets.has(targetMeta.id)) {
          continue;
        }

        const evidenceAnchor = `#${hit.slug}`;
        const pairKey = `${srcPath}\0${srcSection.slug}\0${hit.path}\0${evidenceAnchor}`;
        if (seenPairKeys.has(pairKey)) continue;
        seenPairKeys.add(pairKey);

        const snippet = hit.text.replace(/\s+/g, ' ').slice(0, DEFAULT_SNIPPET_LENGTH);

        pairs.push({
          sourcePath: srcPath,
          sourceSlug: srcSection.slug,
          targetPath: hit.path,
          targetSlug: hit.slug,
          targetId: targetMeta?.id,
          score: hit.score,
          scoreKind: hit.scoreKind,
          evidenceAnchor,
          snippet,
        });
      }
    }
  }

  // Sort candidate pairs by score descending
  pairs.sort((a, b) => b.score - a.score);

  return {
    pairs: pairs.slice(0, topLimit),
    degraded,
  };
}
