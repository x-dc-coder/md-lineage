#!/usr/bin/env node
/**
 * Post-build bin repair, two jobs:
 *
 * 1. `tsc` emits every file with mode 644, so the `bin` entry points lose
 *    their executable bit and `node_modules/.bin/mdlineage` fails with
 *    EACCES (exit 126). A Node script rather than shell `chmod`: the repo is
 *    developed from both WSL and Windows, and `chmod` does not exist in
 *    cmd.exe. On Windows the chmod is a near no-op, which is correct.
 *
 * 2. `npm ci` skips creating `node_modules/.bin` links when the bin target
 *    does not exist yet (a fresh clone has no `dist/` before the first
 *    build), and `tsc -b` never asks npm to create them. This recreates any
 *    missing or dangling link. Windows has no usable symlinks without
 *    developer mode, so there the script only reports and skips (npm still
 *    manages shims on a tree where install ran after a build).
 */

import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  statSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packagesDir = join(root, 'packages');
const binDir = join(root, 'node_modules', '.bin');
const MODE = 0o755;
const isWindows = process.platform === 'win32';

let restored = 0;
let relinked = 0;

for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const pkgPath = join(packagesDir, entry.name, 'package.json');
  if (!existsSync(pkgPath)) continue;

  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const declared = pkg.bin;
  const bins = typeof declared === 'string' ? { [pkg.name ?? entry.name]: declared } : declared ?? {};

  for (const [name, target] of Object.entries(bins)) {
    const abs = resolve(packagesDir, entry.name, target);
    if (!existsSync(abs)) continue; // package not built yet

    const current = statSync(abs).mode & 0o777;
    if (current !== MODE) {
      chmodSync(abs, MODE);
      restored += 1;
      process.stdout.write(`${relative(root, abs)}: ${current.toString(8)} -> 755\n`);
    }

    if (isWindows) continue; // no reliable symlinks; npm owns .cmd shims
    if (binLinkOk(name, abs)) continue;
    mkdirSync(binDir, { recursive: true });
    const link = join(binDir, name);
    try {
      unlinkSync(link);
    } catch {
      // missing link is the common case
    }
    symlinkSync(abs, link);
    relinked += 1;
    process.stdout.write(`${relative(root, link)} -> ${relative(root, abs)}\n`);
  }
}

/** True when `<name>` is a symlink pointing at the expected bin target. */
function binLinkOk(name, abs) {
  const link = join(binDir, name);
  let st;
  try {
    st = lstatSync(link);
  } catch {
    return false;
  }
  if (!st.isSymbolicLink()) return false;
  // A relative link target is relative to the link's directory.
  const dest = readlinkSync(link);
  return resolve(binDir, dest) === resolve(abs) || sameFile(link, abs);
}

/** True when both paths resolve to the same existing file. */
function sameFile(a, b) {
  try {
    return statSync(a).ino === statSync(b).ino && statSync(a).dev === statSync(b).dev;
  } catch {
    return false;
  }
}

if (restored === 0 && relinked === 0) process.stdout.write('bin entry points already executable and linked\n');
