#!/usr/bin/env node
/**
 * `tsc` emits every file with mode 644, so the `bin` entry points of the CLI,
 * language-server and MCP packages lose their executable bit and
 * `node_modules/.bin/mdlineage` fails with EACCES (exit 126).
 *
 * A Node script rather than a shell `chmod`: the repository is developed from
 * both WSL and Windows, and `chmod` does not exist in cmd.exe. On Windows the
 * call is a near no-op, which is the correct outcome.
 */

import { chmodSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packagesDir = join(root, 'packages');
const MODE = 0o755;

let restored = 0;

for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const pkgPath = join(packagesDir, entry.name, 'package.json');
  if (!existsSync(pkgPath)) continue;

  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const declared = pkg.bin;
  const bins = typeof declared === 'string' ? { [pkg.name ?? entry.name]: declared } : declared ?? {};

  for (const target of Object.values(bins)) {
    const abs = resolve(packagesDir, entry.name, target);
    if (!existsSync(abs)) continue; // package not built yet
    const current = statSync(abs).mode & 0o777;
    if (current === MODE) continue;
    chmodSync(abs, MODE);
    restored += 1;
    process.stdout.write(`${relative(root, abs)}: ${current.toString(8)} -> 755\n`);
  }
}

if (restored === 0) process.stdout.write('bin entry points already executable\n');
