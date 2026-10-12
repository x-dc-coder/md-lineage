import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const DEFAULT_EMBED_PROFILE_ID = 'local:qwen3-0.6b';
export const DEFAULT_RERANK_PROFILE_ID = 'local:qwen3-reranker-0.6b';

export interface CatalogFile {
  readonly path: string;
  readonly sha256: string;
}

export interface CatalogProfile {
  readonly id: string;
  readonly role: 'embed' | 'rerank';
  readonly repo: string;
  readonly dtype: string;
  readonly dim: number;
  readonly pendingExport: boolean;
  readonly onnxFile: string;
  readonly files: readonly CatalogFile[];
}

const PIN = /^[0-9a-f]{64}$/;

/** Read `models.json` from the package root (works from `src/` under tsx and from `dist/`). */
export function loadCatalog(): readonly CatalogProfile[] {
  const path = fileURLToPath(new URL('../models.json', import.meta.url));
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if (error instanceof Error) throw new Error(`models.json is unreadable: ${error.message}`);
    throw error;
  }
  return parseCatalog(parsed);
}

export function findProfile(id: string, catalog: readonly CatalogProfile[] = loadCatalog()): CatalogProfile | undefined {
  return catalog.find((profile) => profile.id === id);
}

export function parseCatalog(raw: unknown): readonly CatalogProfile[] {
  if (!isRecord(raw) || !Array.isArray(raw.profiles)) {
    throw new Error('models.json: expected { profiles: [...] }');
  }
  const profiles = raw.profiles.map((entry, index) => parseProfile(entry, index));
  const ids = new Set<string>();
  for (const profile of profiles) {
    if (ids.has(profile.id)) throw new Error(`models.json: duplicate profile '${profile.id}'`);
    ids.add(profile.id);
  }
  if (!ids.has(DEFAULT_EMBED_PROFILE_ID) || !ids.has(DEFAULT_RERANK_PROFILE_ID)) {
    throw new Error('models.json is missing a default 0.6B profile');
  }
  return profiles;
}

function parseProfile(raw: unknown, index: number): CatalogProfile {
  if (!isRecord(raw)) throw new Error(`models.json: profile ${index} is not an object`);
  const id = requiredString(raw, 'id', index);
  const role = requiredString(raw, 'role', index);
  if (role !== 'embed' && role !== 'rerank') {
    throw new Error(`models.json: profile '${id}' role must be embed or rerank`);
  }
  const repo = requiredString(raw, 'repo', index);
  const dtype = requiredString(raw, 'dtype', index);
  const dim = raw.dim;
  if (typeof dim !== 'number' || !Number.isInteger(dim) || dim < 0) {
    throw new Error(`models.json: profile '${id}' dim must be a non-negative integer`);
  }
  if (typeof raw.pendingExport !== 'boolean') {
    throw new Error(`models.json: profile '${id}' pendingExport must be a boolean`);
  }
  const onnxFile = requiredString(raw, 'onnxFile', index, true);
  if (!Array.isArray(raw.files)) throw new Error(`models.json: profile '${id}' files must be an array`);
  const files = raw.files.map((file, fileIndex) => parseFile(file, id, fileIndex));
  if (raw.pendingExport) {
    if (files.length !== 0 || onnxFile !== '') {
      throw new Error(`models.json: pending profile '${id}' must not list files`);
    }
  } else if (onnxFile === '' || !files.some((file) => file.path === onnxFile)) {
    throw new Error(`models.json: profile '${id}' onnxFile must be one of its files`);
  }
  return { id, role, repo, dtype, dim, pendingExport: raw.pendingExport, onnxFile, files };
}

function parseFile(raw: unknown, profileId: string, index: number): CatalogFile {
  if (!isRecord(raw)) throw new Error(`models.json: ${profileId} file ${index} is not an object`);
  const path = requiredString(raw, 'path', index);
  if (!isSafeRelative(path)) {
    throw new Error(`models.json: ${profileId} path '${path}' is not a relative file`);
  }
  const sha256 = requiredString(raw, 'sha256', index, true);
  if (sha256 !== '' && !PIN.test(sha256)) {
    throw new Error(`models.json: ${profileId} ${path} sha256 must be empty or 64 hex chars`);
  }
  return { path, sha256 };
}

function requiredString(raw: Record<string, unknown>, key: string, index: number, allowEmpty = false): string {
  const value = raw[key];
  if (typeof value !== 'string' || (!allowEmpty && value === '')) {
    throw new Error(`models.json: entry ${index} field '${key}' must be a string`);
  }
  return value;
}

function isSafeRelative(path: string): boolean {
  if (path === '' || path.startsWith('/') || path.includes('\\')) return false;
  return !path.split('/').some((part) => part === '' || part === '.' || part === '..');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
