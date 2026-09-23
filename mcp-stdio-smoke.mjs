import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolve } from 'node:path';

const entry = resolve(process.argv[2]);
const t = new StdioClientTransport({ command: process.execPath, args: [entry, '--stdio'], stderr: 'pipe' });
const c = new Client({ name: 'smoke', version: '0.0.0' });
await c.connect(t);
console.log('server version:', JSON.stringify(c.getServerVersion()));
console.log('capabilities:', JSON.stringify(c.getServerCapabilities()));
const tools = await c.listTools();
console.log('tools:', JSON.stringify(tools.tools.map(x => x.name)));
t.stderr.on('data', (d) => console.log('STDERR:', d.toString()));
const res = await c.callTool({ name: 'validate_document', arguments: { path: 'test/fixtures/invalid/e07-missing-kind-status.md' } });
console.log('result:', JSON.stringify(res.content, null, 1).slice(0, 800));
await c.close();
process.exit(0);
