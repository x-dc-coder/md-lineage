import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

/** SHA-256 of a file, streamed so a 600MB weight never sits in one buffer. */
export async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(file);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
}
