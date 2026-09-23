#!/usr/bin/env node
/**
 * The MCP server's stdio entry.
 *
 * `mdlineage mcp --stdio` reaches this through the CLI, and the test suite
 * spawns it as a child process to exercise the protocol end to end: stdio is
 * the transport a real client uses, so testing it tests the framing the client
 * actually sees instead of an in-process shortcut.
 *
 * `--root <dir>` names the tree to index (a test spelling; a real client names
 * the same thing through its own workspace notion, and the tools resolve paths
 * against the root). `--config <path>` names a config file explicitly.
 */

import { startStdio } from './server.js';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};

const rootPath = flag('--root');
const configFile = flag('--config');

const options = {
  ...(rootPath === undefined ? {} : { root: rootPath }),
  ...(configFile === undefined ? {} : { configFile }),
};

// The MCP server owns stdin/stdout from here on, exactly like the LSP's entry:
// the first framing byte it writes is JSON-RPC, so nothing may print first.
startStdio(options).catch((error) => {
  process.stderr.write(`mdlineage-mcp: cannot start the server: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
