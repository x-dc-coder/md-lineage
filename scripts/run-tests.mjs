#!/usr/bin/env node
// Test runner for Node >= 20 compatibility.
//
// Why enumerate manually instead of a glob in the npm script?
// - Node 20's `node --test` does not expand glob patterns (Node 22 added
//   glob support), so a quoted pattern is treated as a literal path and fails.
// - Relying on shell expansion is also wrong: cmd.exe on Windows does not
//   expand globs, and a package without a test/ dir would leave the literal
//   pattern as an argument. Manual enumeration behaves identically on every
//   platform and Node version.
//
// Usage:
//   node scripts/run-tests.mjs            -> enumerate packages/*/test/*.test.ts (repo root)
//   node scripts/run-tests.mjs <dir> ...  -> enumerate <dir>/test/*.test.ts (per-package)

import { readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, relative } from 'node:path';

const roots = process.argv.slice(2);
const cwd = process.cwd();

function packageTestFiles() {
  const files = [];
  for (const entry of readdirSync('packages')) {
    const dir = join('packages', entry, 'test');
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      continue; // package without a test directory
    }
    for (const f of entries.sort()) {
      if (f.endsWith('.test.ts')) files.push(join(dir, f));
    }
  }
  return files;
}

function dirTestFiles(dir) {
  const testDir = join(dir, 'test');
  let entries;
  try {
    entries = readdirSync(testDir);
  } catch {
    return [];
  }
  return entries
    .filter((f) => f.endsWith('.test.ts'))
    .sort()
    .map((f) => join(testDir, f));
}

const testFiles = roots.length === 0 ? packageTestFiles() : roots.flatMap(dirTestFiles);

if (testFiles.length === 0) {
  console.error(
    `run-tests: no *.test.ts files found under ${relative(cwd, cwd) || '.'} ` +
      (roots.length === 0 ? '(searched packages/*/test/)' : `(searched: ${roots.map((d) => join(d, 'test')).join(', ')})`),
  );
  console.error('run-tests: refusing to run silently with zero tests (a green CI with no tests is the worst failure mode).');
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  ['--import', 'tsx', '--test', ...testFiles],
  { stdio: 'inherit' },
);
if (result.error) {
  console.error('run-tests: failed to spawn node:', result.error);
  process.exit(1);
}
process.exit(result.status ?? 1);
