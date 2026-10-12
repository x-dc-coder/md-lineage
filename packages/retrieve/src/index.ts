/**
 * @mdlineage/retrieve — lexical retrieval primitives for MDLineage
 * (Issue #3 Phase 1).
 *
 * Phase 1 is pure lexical: tokenize → BM25 → (RRF is wired for Phase 2's
 * dense branch). No model runtime, no network, no native dependencies; see
 * the issue's Core Purity iron rule.
 */

export { tokenize } from './tokenize.js';
export { Bm25Index, type Bm25Doc, type Bm25Hit } from './bm25.js';
export { fuse, type FusedRank } from './rrf.js';
export {
  sectionKey,
  profileDirName,
  storeDirectory,
  FileVectorStore,
  type VectorProfile,
  type VectorStore,
  type VectorMeta,
  type StoreManifest,
} from './vector-store.js';
