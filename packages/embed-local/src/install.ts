import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CatalogProfile } from './catalog.js';
import { sha256File } from './hash.js';

export interface InstallAssessment {
  readonly ready: boolean;
  readonly problems: readonly string[];
}

/** Filesystem check only. A missing file is not a download, and a pin is verified when one exists. */
export async function assessInstalled(profile: CatalogProfile, modelDir: string): Promise<InstallAssessment> {
  if (profile.pendingExport) return { ready: false, problems: ['weights-pending-export'] };
  const problems: string[] = [];
  for (const file of profile.files) {
    const abs = cachedPath(modelDir, profile.repo, file.path);
    if (!existsSync(abs)) {
      problems.push(`missing ${file.path}`);
      continue;
    }
    if (file.sha256 === '') continue;
    // Full sha256 of the 600MB weights costs ~4s per CLI invocation; skip
    // it when size and mtime match the last verified state (sidecar next
    // to the weights, refreshed only after a digest actually matched).
    if (verifyFastPath(abs, file.sha256)) continue;
    const digest = await sha256File(abs);
    if (digest !== file.sha256) problems.push(`checksum mismatch ${file.path}`);
    else recordVerified(abs, file.sha256);
  }
  return { ready: problems.length === 0, problems };
}

export function cachedPath(modelDir: string, repo: string, file: string): string {
  return join(modelDir, repo, file);
}


/**
 * Size+mtime fast path for repeated verification: `abs + '.verified.json'`
 * stores the digest alongside the stats observed when it matched. Any
 * change to the file invalidates the record and falls back to a full hash.
 */
function verifyFastPath(abs: string, expected: string): boolean {
  try {
    const record = JSON.parse(readFileSync(`${abs}.verified.json`, 'utf8')) as {
      sha256?: string;
      size?: number;
      mtimeMs?: number;
    };
    if (record.sha256 !== expected) return false;
    const stats = statSync(abs);
    return record.size === stats.size && record.mtimeMs === stats.mtimeMs;
  } catch {
    return false;
  }
}

function recordVerified(abs: string, digest: string): void {
  try {
    const stats = statSync(abs);
    writeFileSync(
      `${abs}.verified.json`,
      JSON.stringify({ sha256: digest, size: stats.size, mtimeMs: stats.mtimeMs }),
    );
  } catch {
    // A failed sidecar write only costs the fast path, never correctness.
  }
}
