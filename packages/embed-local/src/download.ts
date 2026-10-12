import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** Stream one Hub file to `dest`. A failed attempt leaves no partial file. */
export async function downloadFile(url: string, dest: string): Promise<void> {
  const response = await fetch(url, {
    headers: { 'user-agent': 'mdlineage-embed-local' },
    redirect: 'follow',
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  if (response.body === null) throw new Error(`empty body for ${url}`);
  await mkdir(dirname(dest), { recursive: true });
  const partial = `${dest}.partial`;
  try {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
    await rename(partial, dest);
  } catch (error) {
    await rm(partial, { force: true });
    if (error instanceof Error) throw new Error(`download failed for ${url}: ${error.message}`);
    throw error;
  }
}

export function remoteFileUrl(mirror: string, repo: string, file: string): string {
  return `${mirror.replace(/\/+$/, '')}/${repo}/resolve/main/${file}`;
}
