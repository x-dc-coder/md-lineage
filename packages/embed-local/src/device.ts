import { TINY_ONNX } from './tiny-onnx.js';

/**
 * Execution provider chosen for every later ONNX session.
 *
 * Never pass device auto to @huggingface/transformers. Version 3.8.x caches
 * the rejected CUDA session promise and poisons later calls in the same
 * process (zvec-grep issue #135). probeDevice returns an explicit provider
 * (cpu, cuda, or dml); callers pass that string and nothing else.
 */
export type ExecutionDevice = 'cpu' | 'cuda' | 'dml';

export interface DeviceProbe {
  readonly device: ExecutionDevice;
  readonly degraded: readonly string[];
}

const PROBE_TIMEOUT_MS = 8_000;

let cached: DeviceProbe | undefined;

/** Windows tries DirectML, macOS stays on CPU, Linux and WSL try CUDA then CPU. */
export function deviceCandidates(platform: NodeJS.Platform = process.platform): readonly ExecutionDevice[] {
  if (platform === 'win32') return ['dml', 'cpu'];
  if (platform === 'darwin') return ['cpu'];
  return ['cuda', 'cpu'];
}

/**
 * Probe once per process, on the first session rather than at import.
 * A missing GPU records `cuda-unavailable: falling back to cpu` (or the
 * DirectML equivalent) and the cached result is CPU.
 */
export async function probeDevice(): Promise<DeviceProbe> {
  if (cached !== undefined) return cached;
  const candidates = deviceCandidates();
  const degraded: string[] = [];
  for (const candidate of candidates) {
    const ok = await tryDevice(candidate);
    if (ok) {
      cached = { device: candidate, degraded };
      return cached;
    }
    if (candidate !== 'cpu') degraded.push(`${candidate}-unavailable: falling back to cpu`);
  }
  cached = {
    device: 'cpu',
    degraded: [...degraded, 'device-probe-failed: no execution provider accepted the probe model'],
  };
  return cached;
}

interface OrtSession {
  readonly inputNames: readonly string[];
  run(feeds: Record<string, unknown>): Promise<unknown>;
  release(): Promise<void>;
}

interface OrtModule {
  readonly create: (model: Uint8Array, providers: readonly string[]) => Promise<unknown>;
  readonly tensor: new (type: 'float32', data: Float32Array, dims: readonly number[]) => unknown;
}

async function tryDevice(device: ExecutionDevice): Promise<boolean> {
  const ort = await loadOrt();
  let session: OrtSession | undefined;
  try {
    const created = await withTimeout(ort.create(TINY_ONNX, [device]), PROBE_TIMEOUT_MS);
    if (!isSession(created)) return false;
    session = created;
    const input = session.inputNames[0];
    if (input === undefined) return false;
    await session.run({ [input]: new ort.tensor('float32', Float32Array.from([1]), [1]) });
    return true;
  } catch (error) {
    if (error instanceof Error) return false;
    throw error;
  } finally {
    if (session !== undefined) await session.release();
  }
}

async function loadOrt(): Promise<OrtModule> {
  const imported: unknown = await import('onnxruntime-node');
  if (!isRecord(imported)) throw new Error('onnxruntime-node did not export a module');
  // InferenceSession is a class (typeof "function"), not a plain object.
  const session = imported.InferenceSession;
  const tensor = imported.Tensor;
  if (!isSessionHost(session) || !isFloatTensor(tensor)) {
    throw new Error('onnxruntime-node is missing InferenceSession.create or Tensor');
  }
  return {
    create: (model, providers) => session.create(model, { executionProviders: [...providers] }),
    tensor,
  };
}

function isSessionHost(
  value: unknown,
): value is { create(model: Uint8Array, options: { executionProviders: string[] }): Promise<unknown> } {
  if (value === null || (typeof value !== 'function' && typeof value !== 'object')) return false;
  return 'create' in value && typeof value.create === 'function';
}

function isFloatTensor(value: unknown): value is OrtModule['tensor'] {
  return typeof value === 'function';
}

function isSession(value: unknown): value is OrtSession {
  if (!isRecord(value) || typeof value.run !== 'function' || typeof value.release !== 'function') return false;
  return Array.isArray(value.inputNames) && value.inputNames.every((name) => typeof name === 'string');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`device probe timed out after ${ms}ms`)), ms);
  });
  // The race loser must not surface as an unhandled rejection later.
  timeout.catch(() => undefined);
  return Promise.race([work, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}
