/**
 * Lazy view of `@huggingface/transformers`. Importing this module does not
 * load the runtime; `loadTransformers` does, and only a session calls it.
 */

export interface TransformersEnv {
  cacheDir: string;
  localModelPath: string;
  allowLocalModels: boolean;
  allowRemoteModels: boolean;
  remoteHost: string;
}

export interface FeatureExtractor {
  (texts: readonly string[], options: { pooling: 'last_token'; normalize: boolean; max_length?: number }): Promise<unknown>;
  dispose?: () => Promise<void>;
}

export interface TransformersHandle {
  readonly env: TransformersEnv;
  pipeline(
    task: 'feature-extraction',
    model: string,
    options: { dtype: string; device: string; local_files_only: boolean },
  ): Promise<FeatureExtractor>;
  fromPretrained(model: string): Promise<unknown>;
}

/** Point the runtime at our cache and refuse a surprise download. */
export async function configureTransformers(modelDir: string): Promise<TransformersHandle> {
  const handle = await loadTransformers();
  handle.env.cacheDir = modelDir;
  handle.env.localModelPath = modelDir;
  handle.env.allowLocalModels = true;
  handle.env.allowRemoteModels = false;
  return handle;
}

export async function loadTransformers(): Promise<TransformersHandle> {
  const imported: unknown = await import('@huggingface/transformers');
  if (!isRecord(imported) || !isPipeline(imported.pipeline) || !isEnv(imported.env)) {
    throw new Error('@huggingface/transformers is missing pipeline or env');
  }
  // AutoTokenizer is a class (typeof "function"), not a plain object.
  const auto = imported.AutoTokenizer;
  if (!isTokenizerClass(auto)) {
    throw new Error('@huggingface/transformers is missing AutoTokenizer.from_pretrained');
  }
  const pipeline = imported.pipeline;
  const fromPretrained = auto.from_pretrained.bind(auto);
  return {
    env: imported.env,
    pipeline: async (task, model, options) => {
      const created: unknown = await pipeline(task, model, options);
      if (!isExtractor(created)) throw new Error('feature-extraction pipeline did not load');
      return created;
    },
    fromPretrained: (model) => fromPretrained(model, { local_files_only: true }),
  };
}

function isPipeline(
  value: unknown,
): value is (task: string, model: string, options: { dtype: string; device: string; local_files_only: boolean }) => Promise<unknown> {
  return typeof value === 'function';
}

function isTokenizerClass(value: unknown): value is {
  from_pretrained(model: string, options: { local_files_only: boolean }): Promise<unknown>;
} {
  if (value === null || (typeof value !== 'function' && typeof value !== 'object')) return false;
  return 'from_pretrained' in value && typeof value.from_pretrained === 'function';
}

function isExtractor(value: unknown): value is FeatureExtractor {
  return typeof value === 'function';
}

function isEnv(value: unknown): value is TransformersEnv {
  if (!isRecord(value)) return false;
  return (
    'cacheDir' in value &&
    'localModelPath' in value &&
    'allowLocalModels' in value &&
    'allowRemoteModels' in value &&
    'remoteHost' in value
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
