import { existsSync } from 'node:fs';
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
    const digest = await sha256File(abs);
    if (digest !== file.sha256) problems.push(`checksum mismatch ${file.path}`);
  }
  return { ready: problems.length === 0, problems };
}

export function cachedPath(modelDir: string, repo: string, file: string): string {
  return join(modelDir, repo, file);
}
