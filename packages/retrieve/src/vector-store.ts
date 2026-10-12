/**
 * Content-addressed vector cache (Issue #3 §5, Phase 1 ground work).
 *
 * All vector artifacts are derived data: they live under
 * `.mdlineage-cache/retrieve/<profile>/` (never in front matter — the Data
 * Isolation iron rule), are keyed by the SHA-256 of the normalized section
 * text, and can be dropped and rebuilt at any time. Same-content sections
 * across documents share one blob, so a Front-Matter-only edit reuses every
 * vector it did not invalidate.
 *
 * Layout:
 *   .mdlineage-cache/retrieve/<profile>/blobs/<sha256>.f32
 *       little-endian float32, L2-normalized before storage (DataView writes
 *       the endianness explicitly; platform byte order is never assumed)
 *   .mdlineage-cache/retrieve/<profile>/manifest.json
 *       { version: 1, profile: { model, dtype, dim }, files: { path: [hash…] } }
 *
 * Corrupt blobs (wrong byte length for `dim`, or any read failure) are
 * reported as missing so the caller recomputes them — a cache must degrade
 * to recomputation, never to a crash.
 */

import { createHash } from 'node:crypto';
import { randomBytes } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

/** Model identity of a cache directory: one model+dtype+dim, one profile. */
export interface VectorProfile {
  model: string;
  dtype: 'f32';
  dim: number;
}

/** On-disk manifest: which sections (by hash) each document contributed. */
export interface StoreManifest {
  version: 1;
  profile: VectorProfile;
  files: Record<string, string[]>;
}

/** `meta()` view: the manifest plus on-disk blob statistics. */
export interface VectorMeta extends StoreManifest {
  /** Blob files present under blobs/ (named but not necessarily valid). */
  blobs: number;
}

/**
 * Cache key of one section: `sha256(NFC(title) + "\n" + LF(NFC(text)))` —
 * NFC first, then CRLF→LF, so visually identical sections hash identically
 * across editors and line-ending policies. This is THE convention the BM25
 * corpus string (`${title}\n${text}`) also uses; keep them in sync.
 */
export function sectionKey(title: string, text: string): string {
  const normalizedTitle = title.normalize('NFC');
  const normalizedText = text.normalize('NFC').replace(/\r\n/g, '\n');
  return createHash('sha256').update(`${normalizedTitle}\n${normalizedText}`, 'utf8').digest('hex');
}

/** Storage contract. Implementations must treat corruption as absence. */
export interface VectorStore {
  has(hash: string): boolean;
  get(hash: string): Float32Array | null;
  put(hash: string, vector: readonly number[]): void;
  putManifest(manifest: StoreManifest): void;
  setSections(path: string, hashes: readonly string[]): void;
  removePath(path: string): void;
  /** Delete blobs whose hash is not in `keep`; returns the removed hashes. */
  gc(keep: ReadonlySet<string> | readonly string[]): string[];
  meta(): VectorMeta;
}

/**
 * Deterministic profile directory: model slug + dtype + dim. The slug alone
 * is lossy (two models can slugify to the same name), so the first 8 hex of
 * sha256(model) is appended — the directory name is a lossless function of
 * the profile identity.
 */
export function profileDirName(profile: VectorProfile): string {
  const slug = profile.model
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const hash8 = createHash('sha256').update(profile.model, 'utf8').digest('hex').slice(0, 8);
  return `${slug || 'model'}-${hash8}-${profile.dtype}-d${profile.dim}`;
}

/** Section/blob hashes are sha256 hex digests; anything else is a bug. */
const HASH_PATTERN = /^[0-9a-f]{64}$/;

function assertHash(hash: string): void {
  if (!HASH_PATTERN.test(hash)) {
    throw new Error(`invalid vector blob hash: expected 64 hex characters, got ${JSON.stringify(hash)}`);
  }
}

/**
 * File-backed store under `<root>/.mdlineage-cache/retrieve/<profile>/`.
 * `root` is the workspace root (or any directory the cache should anchor at).
 */
export class FileVectorStore implements VectorStore {
  private readonly dir: string;
  private readonly blobsDir: string;
  private readonly manifestPath: string;
  private readonly profile: VectorProfile;

  constructor(root: string, profile: VectorProfile) {
    this.profile = profile;
    this.dir = join(root, '.mdlineage-cache', 'retrieve', profileDirName(profile));
    this.blobsDir = join(this.dir, 'blobs');
    this.manifestPath = join(this.dir, 'manifest.json');
  }

  /** Blob path of a hash (public for diagnostics/tests). */
  blobPath(hash: string): string {
    assertHash(hash);
    return join(this.blobsDir, `${hash}.f32`);
  }

  has(hash: string): boolean {
    // Explicit guard: readBlob treats ANY throw as absence, so validation
    // must happen before its try/catch swallows the error.
    assertHash(hash);
    return this.readBlob(hash) !== null;
  }

  get(hash: string): Float32Array | null {
    assertHash(hash);
    return this.readBlob(hash);
  }

  /**
   * Store one vector: L2-normalized, little-endian float32, content-
   * addressed so an existing blob is left untouched (same hash ⇒ same bytes,
   * and rewriting would only churn mtimes).
   */
  put(hash: string, vector: readonly number[]): void {
    assertHash(hash);
    // Skip only when a READABLE blob exists. A corrupt file (wrong length,
    // unreadable) must be rewritten, not cached-missed forever.
    if (this.readBlob(hash) !== null) return;
    if (vector.length !== this.profile.dim) {
      throw new Error(
        `vector dimension mismatch: profile dim ${this.profile.dim}, got ${vector.length}`,
      );
    }
    mkdirSync(this.blobsDir, { recursive: true });

    const norm = l2normalize(vector);
    const buffer = new ArrayBuffer(this.profile.dim * 4);
    const view = new DataView(buffer);
    for (let i = 0; i < norm.length; i++) {
      // Explicit little-endian: the .f32 format is defined on bytes, not on
      // whatever the running platform's FloatArray uses.
      view.setFloat32(i * 4, norm[i] ?? 0, true);
    }
    writeFileAtomic(this.blobPath(hash), Buffer.from(buffer));
  }

  putManifest(manifest: StoreManifest): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileAtomic(this.manifestPath, JSON.stringify(manifest, null, 2));
  }

  setSections(path: string, hashes: readonly string[]): void {
    const manifest = this.readManifest();
    manifest.files[path] = [...hashes];
    this.putManifest(manifest);
  }

  removePath(path: string): void {
    const manifest = this.readManifest();
    if (!(path in manifest.files)) return;
    delete manifest.files[path];
    this.putManifest(manifest);
  }

  gc(keep: ReadonlySet<string> | readonly string[]): string[] {
    const keepSet = keep instanceof Set ? keep : new Set(keep);
    let entries: string[] = [];
    try {
      entries = readdirSync(this.blobsDir);
    } catch {
      return [];
    }
    const removed: string[] = [];
    for (const entry of entries) {
      if (!entry.endsWith('.f32')) continue;
      const hash = entry.slice(0, -4);
      if (hash === undefined || keepSet.has(hash)) continue;
      try {
        rmSync(join(this.blobsDir, entry), { force: true });
        removed.push(hash);
      } catch {
        // An undeletable blob stays; gc reports what it actually removed.
      }
    }
    return removed;
  }

  meta(): VectorMeta {
    let blobs = 0;
    try {
      blobs = readdirSync(this.blobsDir).filter((f) => f.endsWith('.f32')).length;
    } catch {
      blobs = 0;
    }
    const manifest = this.readManifest();
    return { ...manifest, blobs };
  }

  /**
   * Read a blob, or null when missing/corrupt. "Corrupt" is any read failure
   * or a byte length that does not match `dim * 4` — both mean the caller
   * must recompute, per the cache-degradation rule.
   */
  private readBlob(hash: string): Float32Array | null {
    let buffer: Buffer;
    try {
      buffer = readFileSync(this.blobPath(hash));
    } catch {
      return null;
    }
    if (buffer.length !== this.profile.dim * 4) return null;
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const out = new Float32Array(this.profile.dim);
    for (let i = 0; i < out.length; i++) {
      out[i] = view.getFloat32(i * 4, true);
    }
    return out;
  }

  /** Manifest read; a missing or unreadable manifest starts empty. */
  private readManifest(): StoreManifest {
    let raw: string;
    try {
      raw = readFileSync(this.manifestPath, 'utf8');
    } catch {
      return { version: 1, profile: this.profile, files: {} };
    }
    try {
      const parsed = JSON.parse(raw) as Partial<StoreManifest>;
      // A manifest written by a DIFFERENT profile (hand-copied cache, changed
      // dim) is treated as absent: its hashes belong to another model and must
      // not be reused as this profile's section index.
      const onDisk = parsed.profile;
      if (
        typeof onDisk === 'object' &&
        onDisk !== null &&
        (onDisk.model !== this.profile.model || onDisk.dtype !== this.profile.dtype || onDisk.dim !== this.profile.dim)
      ) {
        return { version: 1, profile: this.profile, files: {} };
      }
      const files =
        parsed.files && typeof parsed.files === 'object' && !Array.isArray(parsed.files)
          ? parsed.files
          : {};
      return {
        version: 1,
        profile: this.profile,
        files: files as Record<string, string[]>,
      };
    } catch {
      return { version: 1, profile: this.profile, files: {} };
    }
  }
}

/** Unit-vector copy; a zero vector stays zero (nothing to normalize). */
function l2normalize(vector: readonly number[]): number[] {
  let sum = 0;
  for (const v of vector) sum += v * v;
  const norm = Math.sqrt(sum);
  if (norm === 0) return [...vector];
  return vector.map((v) => v / norm);
}

/**
 * Atomic write: temp file in the target's directory, then rename over it
 * (the repository's `fix.ts` convention, including the Windows EPERM/EBUSY
 * rename retry — an interrupted write never leaves a half blob).
 */
function writeFileAtomic(path: string, content: Buffer | string): void {
  const tmp = join(dirname(path), `.${randomBytes(6).toString('hex')}.mdlineage-tmp`);
  try {
    writeFileSync(tmp, content);
    for (let attempt = 0; ; attempt++) {
      try {
        renameSync(tmp, path);
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (attempt >= 2 || (code !== 'EPERM' && code !== 'EBUSY')) {
          throw error;
        }
        // Synchronous sleep: this runs inside a sync CLI code path.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      }
    }
  } catch (error) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // best effort: nothing to clean up if the temp file never existed
    }
    throw error;
  }
}

/** Directory the store anchors at (public for diagnostics/tests). */
export function storeDirectory(root: string, profile: VectorProfile): string {
  return join(root, '.mdlineage-cache', 'retrieve', profileDirName(profile));
}
