export { DEFAULT_EMBED_PROFILE_ID, DEFAULT_RERANK_PROFILE_ID, loadCatalog, type CatalogProfile } from './catalog.js';
export { probeDevice, deviceCandidates, type ExecutionDevice, type DeviceProbe } from './device.js';
export {
  formatEmbedQuery,
  DEFAULT_EMBED_TASK,
  chunkEmbedInputs,
  poolLastTokenNormalized,
  resolveEmbedDevice,
  LocalEmbedder,
} from './embedder.js';
export { openLocalRetrieval, type OpenLocalRetrieval, type OpenLocalRetrievalOptions } from './open.js';
export { formatRerankPrompt, yesProbability, DEFAULT_RERANK_TASK, LocalReranker, resolveRerankDevice } from './reranker.js';
export { setupLocalModels, type SetupOptions, type SetupReport } from './setup.js';
