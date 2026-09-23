#!/usr/bin/env node
/**
 * `@mdlineage/validator` and `@mdlineage/mcp-server` read schemas/*.json from
 * disk relative to their own module location (`dist/../../schemas`, then
 * `dist/../schemas`). The checked-in copy lives at the repository root only, so
 * a package built from `files: ["dist"]` would fail at runtime with "could not
 * load https://mdlineage.dev/schemas/mdlineage-v1.schema.json".
 *
 * `prepack` copies the root schemas into the two packages that read them, so
 * `npm pack` / `npm publish` includes them. The copies are build artefacts and
 * are never committed: they exist only for the duration of the pack.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'schemas');

// Consumers of the schema files, by workspace directory name.
const CONSUMERS = ['validator', 'mcp-server'];

if (!existsSync(source)) {
  // Re-packing an already extracted tarball: the copies are already in place.
  process.stdout.write('schemas/ not found; assuming it is already inside the package\n');
  process.exit(0);
}

const names = readdirSync(source).filter((name) => name.endsWith('.json'));

for (const consumer of CONSUMERS) {
  const destination = join(root, 'packages', consumer, 'schemas');
  mkdirSync(destination, { recursive: true });
  for (const name of names) {
    copyFileSync(join(source, name), join(destination, name));
  }
  process.stdout.write(`packages/${consumer}/schemas: ${names.length} file(s)\n`);
}
