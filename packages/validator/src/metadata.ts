import type { Config } from './config.js';
import { normalizeFilterPath } from './path-filter.js';
import { scanBoundary, parseFrontmatter } from './parse-frontmatter.js';
import { buildLineMap } from './source-map.js';

/** Front matter wins as a whole; manifest metadata only fills an absent block. */
export function resolveMetadata(
  frontmatterMetadata: Record<string, unknown> | null,
  path: string | undefined,
  config: Config,
): { metadata: Record<string, unknown> | null; ignoredManifest: boolean } {
  const manifestEntry = path
    ? (config.manifestDocuments.get(path) ?? config.manifestDocuments.get(normalizeFilterPath(path)))
    : undefined;
  return {
    metadata: frontmatterMetadata ?? (manifestEntry as unknown as Record<string, unknown> | undefined) ?? null,
    ignoredManifest: frontmatterMetadata !== null && manifestEntry !== undefined,
  };
}

/** Read effective metadata without running validation or producing diagnostics. */
export function readDocumentMetadata(content: string, path: string, config: Config): Record<string, unknown> | null {
  const boundary = scanBoundary(content);
  let metadata: Record<string, unknown> | null = null;
  if (boundary && boundary.closeStart !== null) {
    const parsed = parseFrontmatter(boundary.raw, boundary.rawStart, buildLineMap(content));
    const value = parsed.parsed?.data?.[config.metadata.key];
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      metadata = value as Record<string, unknown>;
    }
  }
  return resolveMetadata(metadata, path, config).metadata;
}
