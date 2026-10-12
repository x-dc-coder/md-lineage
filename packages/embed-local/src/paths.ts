import { homedir } from 'node:os';
import { join } from 'node:path';

/** `MDLINEAGE_MODELS_DIR`, or `~/.mdlineage/models` when nothing is set. */
export function resolveModelDir(explicit?: string): string {
  if (explicit !== undefined && explicit !== '') return explicit;
  const fromEnv = process.env.MDLINEAGE_MODELS_DIR;
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  return join(homedir(), '.mdlineage', 'models');
}

/** Hugging Face host with no trailing slash. `--mirror` wins over `HF_ENDPOINT`. */
export function resolveMirror(explicit?: string): string {
  const raw = explicit ?? process.env.HF_ENDPOINT ?? 'https://huggingface.co';
  return raw.replace(/\/+$/, '');
}
