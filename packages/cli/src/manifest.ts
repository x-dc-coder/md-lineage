/**
 * `mdlineage manifest`: manage out-of-band metadata manifests.
 *
 * `manifest seed`: scan workspace documents, generating missing manifest
 * entries without modifying documents.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { cwd as processCwd } from 'node:process';
import { resolve, dirname, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { parseDocument, stringify } from 'yaml';
import {
  loadConfig,
  scanBoundary,
  parseFrontmatter,
  buildLineMap,
  DEFAULT_MANIFEST_FILE,
} from '@mdlineage/validator';
import { expandMarkdownPaths, UsageError, type DiscoveryOptions } from './paths.js';

export interface ManifestSeedOptions {
  config?: string;
  write?: boolean;
  json?: boolean;
  exclude?: string[];
  noIgnore?: boolean;
}

const ID_ALLOWED_REGEX = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const HAS_NON_ASCII_REGEX = /[^\x00-\x7F]/;

/**
 * Generate an id for a document path relative to CWD.
 *
 * Rules:
 * - If the path contains non-ASCII characters, immediately fallback to `doc.<sha256(posixRelPath)[0..8]>`.
 * - Basename is SKILL.md -> `skill.<slug(parentDirName)>`
 * - Otherwise -> `slug(relPath without extension, '/' replaced with '.')`
 * - Normalization: '_' -> '-'; collapse repeated '-' and '.'; strip leading/trailing '-' and '.';
 *   must match `^[a-z0-9]+(?:[.-][a-z0-9]+)*$`; otherwise fallback to `doc.<sha256(posixRelPath)[0..8]>`.
 */
export function generateSeedId(relPosixPath: string): string {
  if (HAS_NON_ASCII_REGEX.test(relPosixPath)) {
    return fallbackHashId(relPosixPath);
  }

  const base = basename(relPosixPath);
  let raw: string;
  if (base.toLowerCase() === 'skill.md') {
    const parent = dirname(relPosixPath);
    const parentName = parent === '.' || parent === '' ? 'root' : basename(parent);
    if (HAS_NON_ASCII_REGEX.test(parentName)) {
      return fallbackHashId(relPosixPath);
    }
    raw = `skill.${slugify(parentName)}`;
  } else {
    // strip .md extension
    const withoutExt = relPosixPath.replace(/\.md$/i, '');
    const parts = withoutExt.split('/').map(slugify);
    raw = parts.join('.');
  }

  const cleaned = cleanId(raw);
  if (cleaned && ID_ALLOWED_REGEX.test(cleaned)) {
    return cleaned;
  }
  return fallbackHashId(relPosixPath);
}

function slugify(segment: string): string {
  const lower = segment.toLowerCase();
  // '_' -> '-', and any non-alphanumeric chars except '.' -> '-'
  const replaced = lower.replace(/_/g, '-').replace(/[^a-z0-9.-]/g, '-');
  return collapseSeparators(replaced);
}

function cleanId(raw: string): string {
  const lower = raw.toLowerCase().replace(/_/g, '-');
  return collapseSeparators(lower);
}

function collapseSeparators(str: string): string {
  // Collapse consecutive separators like '--', '..', '.-', '-.'
  const collapsed = str.replace(/[-.]+/g, (match) => {
    // If the sequence contains '.', simplify to '.'; otherwise '-'
    return match.includes('.') ? '.' : '-';
  });
  return collapsed.replace(/^[-.]+|[-.]+$/g, '');
}

function fallbackHashId(posixPath: string): string {
  const hash = createHash('sha256').update(posixPath).digest('hex').slice(0, 8);
  return `doc.${hash}`;
}

/** Check if document already has valid <metadataKey> in front matter */
function hasFrontMatterMetadata(content: string, metadataKey: string): boolean {
  const boundary = scanBoundary(content);
  if (!boundary || boundary.closeStart === null) return false;
  const parsed = parseFrontmatter(boundary.raw, boundary.rawStart, buildLineMap(boundary.raw));
  if (parsed.error || !parsed.parsed || !parsed.parsed.data) return false;
  const val = parsed.parsed.data[metadataKey];
  return val !== undefined && val !== null;
}

/** Execute `mdlineage manifest seed [paths...]` */
export function runManifestSeed(
  paths: string[],
  values: {
    write?: boolean;
    json?: boolean;
    config?: string;
    exclude?: string[];
    'no-ignore'?: boolean;
    ignore?: boolean;
  },
): number {
  const cwd = processCwd();

  // Precondition: config must be located in CWD (CWD === configDir)
  const preloaded = loadConfig(values.config, values.config ? undefined : cwd);
  const configSource = preloaded.config.source;

  if (configSource) {
    const configDir = dirname(resolve(configSource));
    if (configDir !== resolve(cwd)) {
      process.stderr.write(
        `mdlineage: manifest seed must be run from the configuration directory (repo root), got CWD '${cwd}' vs config in '${configDir}'\n`,
      );
      return 2;
    }
  }

  const manifestFileRel = typeof preloaded.config.raw?.['manifestFile'] === 'string'
    ? (preloaded.config.raw['manifestFile'] as string)
    : DEFAULT_MANIFEST_FILE;
  const manifestPath = resolve(cwd, manifestFileRel);

  // Parse existing manifest if present
  let manifestExists = existsSync(manifestPath);
  let existingDocuments: Record<string, unknown> = {};
  let parsedYamlDoc: ReturnType<typeof parseDocument> | null = null;

  if (manifestExists) {
    try {
      const manifestText = readFileSync(manifestPath, 'utf8');
      parsedYamlDoc = parseDocument(manifestText);
      if (parsedYamlDoc.errors.length > 0) {
        process.stderr.write(`mdlineage: existing manifest file is not valid YAML: ${manifestPath}\n`);
        return 2;
      }
      const js = parsedYamlDoc.toJS() as Record<string, unknown> | null;
      if (js && typeof js === 'object' && js.documents && typeof js.documents === 'object' && !Array.isArray(js.documents)) {
        existingDocuments = js.documents as Record<string, unknown>;
      }
    } catch (err) {
      process.stderr.write(`mdlineage: cannot read existing manifest file ${manifestPath}\n`);
      return 2;
    }
  }

  // Pre-check for --write: only allowed if manifest does not exist or documents map is empty
  const hasExistingEntries = Object.keys(existingDocuments).length > 0;
  if (values.write && hasExistingEntries) {
    process.stderr.write(
      `mdlineage: refusing to overwrite non-empty manifest file '${manifestFileRel}'; manual merge required\n`,
    );
    return 2;
  }

  // Scan markdown paths
  const discoveryOptions: DiscoveryOptions = {
    config: preloaded.config,
    exclude: values.exclude ?? [],
    noIgnore: values['no-ignore'] === true || values.ignore === false,
  };

  let scanResult: ReturnType<typeof expandMarkdownPaths>;
  try {
    scanResult = expandMarkdownPaths(
      paths.length === 0 ? ['.'] : paths,
      cwd,
      discoveryOptions,
    );
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`mdlineage: ${err.message}\n`);
      return 2;
    }
    throw err;
  }

  if (scanResult.missed.length > 0) {
    for (const p of scanResult.missed) {
      process.stderr.write(`mdlineage: no such file or pattern: ${p}\n`);
    }
    return 2;
  }

  // Candidate generation
  // Sort candidate files deterministically by asGiven (posix path relative to CWD)
  const candidateFiles = [...scanResult.files].sort((a, b) => a.asGiven.localeCompare(b.asGiven));
  const metadataKey = preloaded.config.metadata.key;

  // Determine kind and status based on configured vocabulary
  const vocabStatuses = preloaded.config.vocabulary.statuses;
  const seedStatus =
    Array.isArray(vocabStatuses) && vocabStatuses.length > 0
      ? vocabStatuses.includes('active')
        ? 'active'
        : vocabStatuses[0]!
      : 'active';

  const vocabKinds = preloaded.config.vocabulary.kinds;
  const seedKind =
    Array.isArray(vocabKinds) && vocabKinds.length > 0
      ? vocabKinds.includes('reference')
        ? 'reference'
        : vocabKinds[0]!
      : 'reference';

  // Track claimed IDs (from existing manifest + newly generated)
  const claimedIds = new Map<string, string>(); // id -> path
  for (const [docPath, docVal] of Object.entries(existingDocuments)) {
    if (docVal && typeof docVal === 'object' && typeof (docVal as Record<string, unknown>).id === 'string') {
      claimedIds.set((docVal as Record<string, unknown>).id as string, docPath);
    }
  }

  const generatedDocuments: Record<string, { id: string; kind: string; status: string }> = {};

  for (const file of candidateFiles) {
    const relKey = file.asGiven;
    // Skip if already in manifest
    if (existingDocuments[relKey] !== undefined) {
      continue;
    }

    // Skip if document already has front matter metadata
    let content: string;
    try {
      content = readFileSync(file.path, 'utf8');
    } catch {
      continue;
    }

    if (hasFrontMatterMetadata(content, metadataKey)) {
      continue;
    }

    // Generate id
    const baseId = generateSeedId(relKey);
    let chosenId = baseId;
    let counter = 2;
    while (claimedIds.has(chosenId)) {
      chosenId = `${baseId}-${counter}`;
      counter++;
    }

    claimedIds.set(chosenId, relKey);
    generatedDocuments[relKey] = {
      id: chosenId,
      kind: seedKind,
      status: seedStatus,
    };
  }

  if (values.json) {
    const outputObj = { documents: generatedDocuments };
    process.stdout.write(JSON.stringify(outputObj, null, 2) + '\n');
    return 0;
  }

  const yamlOutput = stringify({ documents: generatedDocuments });

  if (values.write) {
    let finalContent: string;
    if (parsedYamlDoc) {
      parsedYamlDoc.set('version', 1);
      parsedYamlDoc.set('documents', generatedDocuments);
      finalContent = parsedYamlDoc.toString();
    } else {
      finalContent = stringify({ version: 1, documents: generatedDocuments });
    }
    try {
      writeFileSync(manifestPath, finalContent, 'utf8');
      process.stdout.write(`mdlineage: wrote ${Object.keys(generatedDocuments).length} entries to ${manifestFileRel}\n`);
      return 0;
    } catch (err) {
      process.stderr.write(`mdlineage: failed to write manifest file ${manifestPath}\n`);
      return 1;
    }
  }

  // Dry-run prints YAML
  process.stdout.write(yamlOutput);
  return 0;
}
