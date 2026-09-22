#!/usr/bin/env node
/**
 * The language server's own stdio entry.
 *
 * `mdlineage server --stdio` calls this through the CLI, and the test suite
 * spawns it as a child process to exercise the protocol end to end: stdio is
 * the transport a real editor uses, so testing it tests the framing the client
 * actually sees instead of an in-process shortcut.
 *
 * `--root <dir>` is a test-only spelling that names the tree to scan; a client
 * names the same thing through `initialize`'s `workspaceFolders`.
 *
 * `--stdio` is consumed by `createConnection` (the Node transport reads it from
 * the process arguments itself), so it is recognized and passed through rather
 * than parsed as an option of this entry.
 */

import { startStdio } from './server.js';

const args = process.argv.slice(2);
const rootAt = args.indexOf('--root');
const rootPath = rootAt >= 0 ? args[rootAt + 1] : undefined;

startStdio(rootPath === undefined ? {} : { rootPath });
