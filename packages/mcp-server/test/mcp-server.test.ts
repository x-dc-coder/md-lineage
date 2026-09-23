/**
 * MCP server tests (docs/remark-language-server-solution.md §12, §16 M4).
 *
 * The assertions cross a real protocol boundary: the server is driven through
 * the SDK's `Client` over a linked `InMemoryTransport` pair, so `tools/list`,
 * argument validation and the `CallToolResult` shapes are what a client sees,
 * not what an in-process shortcut would show. §14.4's one-fixture-many-entries
 * promise depends on it — the fifth entry point must be shown to agree with the
 * other four, and an in-process call could not prove that.
 *
 * The closed loop this milestone exists for is asserted end to end:
 * `suggest_metadata` queues a proposal, `apply_metadata_patch` accepts it and
 * returns edits plus a diff, and nothing is written unless the caller passes
 * `write: true` — the opt-in is asserted in both directions, including the
 * guards that refuse it.
 *
 * Run with: node --import tsx --test packages/mcp-server/test/mcp-server.test.ts
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
  statSync,
  readdirSync,
  chmodSync,
  symlinkSync,
  lstatSync,
  renameSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  createMdlineageMcpServer,
  connectToTransport,
  createContext,
  resetProposalIds,
} from '../src/server.js';
import type { MetadataProposal, ProposalQueue } from '../src/proposals.js';

const repoRoot = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..');
const fixtureRoot = resolve(repoRoot, 'test', 'fixtures');

/** A document with a mdlineage block that is missing `status` — MDL102's shape. */
const GAPPY_DOCUMENT = '---\nmdlineage:\n  schema: 1\n  id: docs.loop\n  kind: policy\n---\n\n# Loop\n';

/** The same document with CRLF terminators: 8 of them, and no bare LF. */
const GAPPY_CRLF = GAPPY_DOCUMENT.replace(/\n/g, '\r\n');

/** Line-ending census of a text: how many CRLF pairs and how many bare LFs. */
function eolCensus(text: string): { crlf: number; bareLf: number } {
  return {
    crlf: (text.match(/\r\n/g) ?? []).length,
    bareLf: (text.match(/(?<!\r)\n/g) ?? []).length,
  };
}

/** A client and server joined by an in-memory transport pair. */
interface Harness {
  client: Client;
  close(): Promise<void>;
}

/** The same pair, with the server's proposal queue in reach for setup steps. */
interface HarnessWithQueue extends Harness {
  queue: ProposalQueue;
}

/** Start the server over the repo root, wired to a client. */
async function harness(root = repoRoot): Promise<Harness> {
  const context = createContext(root);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'mdlineage-test', version: '0.0.0' });
  await connectToTransport(context, serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    async close() {
      await client.close();
    },
  };
}

/** The same harness, keeping the server's proposal queue for direct setup. */
async function harnessWithQueue(root: string): Promise<HarnessWithQueue> {
  const context = createContext(root);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'mdlineage-test', version: '0.0.0' });
  const { queue } = await connectToTransport(context, serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    queue,
    async close() {
      await client.close();
    },
  };
}

/** The parsed JSON a tool returned, or the raw result when it is not JSON. */
interface ToolAnswer {
  payload: unknown;
  raw: { content: Array<{ type: string; text: string }>; isError?: boolean };
}

async function callTool(h: Harness, name: string, args: Record<string, unknown> = {}): Promise<ToolAnswer> {
  const result = await h.client.callTool({ name, arguments: args });
  const text = (result.content as Array<{ type: string; text: string }>).find((c) => c.type === 'text')?.text ?? '';
  let payload: unknown = text;
  try {
    payload = JSON.parse(text);
  } catch {
    // a tool that answers with prose keeps its text
  }
  return { payload, raw: result as ToolAnswer['raw'] };
}

before(() => {
  resetProposalIds();
});

after(() => {
  resetProposalIds();
});

describe('MCP server — tool surface', () => {
  it('exposes exactly the §12 tool table', async () => {
    const h = await harness();
    try {
      const listed = await h.client.listTools();
      const names = listed.tools.map((t) => t.name).sort();
      assert.deepEqual(
        names,
        [
          'apply_metadata_patch',
          'get_schema',
          'list_document_ids',
          'resolve_relation_target',
          'suggest_metadata',
          'validate_document',
          'validate_repository',
        ],
        'the seven §12 tools, and no others',
      );
      // A tool without an input schema would be unusable from a client; every
      // one of the seven takes arguments.
      for (const tool of listed.tools) {
        assert.equal(tool.inputSchema.type, 'object', `${tool.name} declares an object input schema`);
      }
    } finally {
      await h.close();
    }
  });

  it('keeps the read-only tools read-only and says apply_metadata_patch may write', async () => {
    const h = await harness();
    try {
      const listed = await h.client.listTools();
      const byName = new Map(listed.tools.map((t) => [t.name, t]));
      // `apply_metadata_patch` takes `write: true`, so a readOnlyHint on it
      // would tell a client the opposite of what the tool can do.
      assert.notEqual(byName.get('apply_metadata_patch')?.annotations?.readOnlyHint, true);
      // The write replaces the target file's content and is not reversible
      // from here, so the destructive hint is the schema's default.
      assert.equal(
        byName.get('apply_metadata_patch')?.annotations?.destructiveHint,
        true,
        'the write overwrites the document, which is destructive',
      );
      assert.match(
        byName.get('apply_metadata_patch')?.description ?? '',
        /overwrit/i,
        'the description says the write replaces the file content',
      );
      for (const name of [
        'validate_document',
        'validate_repository',
        'get_schema',
        'list_document_ids',
        'resolve_relation_target',
        'suggest_metadata',
      ]) {
        assert.equal(byName.get(name)?.annotations?.readOnlyHint, true, `${name} stays read-only`);
      }
    } finally {
      await h.close();
    }
  });

  it('advertises the server name and version a client sees on initialize', async () => {
    const h = await harness();
    try {
      assert.deepEqual(h.client.getServerVersion(), { name: 'mdlineage', version: '0.0.0' });
      assert.ok(h.client.getServerCapabilities()?.tools, 'tools capability is advertised');
      assert.ok(h.client.getServerCapabilities()?.resources, 'resources capability is advertised');
    } finally {
      await h.close();
    }
  });
});

describe('MCP server — validate_document', () => {
  it('reports the MDL codes a fixture produces, in LSP coordinates', async () => {
    const h = await harness();
    try {
      const { payload } = await callTool(h, 'validate_document', {
        path: 'test/fixtures/invalid/e07-missing-kind-status.md',
      });
      const answer = payload as {
        path: string;
        diagnostics: Array<{ code: string; severity: string; range: { start: { line: number; character: number } } }>;
      };
      const codes = answer.diagnostics.map((d) => d.code);
      assert.ok(codes.includes('MDL102'), `expected MDL102, got ${codes.join(', ')}`);
      assert.ok(answer.diagnostics.every((d) => d.code.startsWith('MDL')), 'a validation tool reports only MDL codes');
      // LSP coordinates are 0-based; the mdlineage block starts on line 2 (1-based).
      assert.equal(answer.diagnostics[0]!.range.start.line, 2);
      assert.ok(
        answer.diagnostics[0]!.range.start.character >= 0,
        'the character is 0-based, so it is never negative',
      );
    } finally {
      await h.close();
    }
  });

  it('agrees with the validator API on the same fixture (§14.4)', async () => {
    const path = 'test/fixtures/invalid/e09-strong-relation-no-reason.md';
    const content = readFileSync(resolve(fixtureRoot, 'invalid', 'e09-strong-relation-no-reason.md'), 'utf8');
    const h = await harness();
    try {
      const { payload } = await callTool(h, 'validate_document', { path, content });
      const answer = payload as { diagnostics: Array<{ code: string; message: string }> };
      const mcpCodes = answer.diagnostics.map((d) => d.code).sort();

      // The validator is the reference implementation; the MCP entry must not
      // be a second source of truth for what a document's codes are.
      const { validateDocumentSync } = await import('@mdlineage/validator');
      const reference = validateDocumentSync({ path, content }).diagnostics.map((d) => d.code).sort();
      assert.deepEqual(mcpCodes, reference, 'MCP and the validator API report the same codes');
      assert.ok(mcpCodes.includes('MDL102'), 'the fixture pins MDL102 for the missing reason');
    } finally {
      await h.close();
    }
  });

  it('validates an unsaved buffer without touching the file', async () => {
    const h = await harness();
    try {
      const { payload } = await callTool(h, 'validate_document', {
        path: 'test/fixtures/valid/v02-minimal.md',
        content: '---\nmdlineage:\n  schema: 1\n  id: docs.minimal\n  kind: reference\n---\n\n# T\n',
      });
      const answer = payload as { diagnostics: Array<{ code: string }> };
      const codes = answer.diagnostics.map((d) => d.code);
      assert.ok(codes.includes('MDL102'), 'the buffer is missing status, which the schema layer reports');
    } finally {
      await h.close();
    }
  });

  it('reports an unreadable file instead of failing the call', async () => {
    const h = await harness();
    try {
      const { payload } = await callTool(h, 'validate_document', { path: 'test/fixtures/does-not-exist.md' });
      const answer = payload as { unreadable: string; diagnostics: unknown[] };
      assert.ok(answer.unreadable, 'the tool says why it could not read the file');
      assert.deepEqual(answer.diagnostics, []);
    } finally {
      await h.close();
    }
  });
});

describe('MCP server — validate_repository', () => {
  it('reports cross-file codes a single document cannot produce', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'mdl-mcp-ws-'));
    mkdirSync(resolve(root, 'docs'), { recursive: true });
    writeFileSync(
      resolve(root, 'docs', 'a.md'),
      '---\nmdlineage:\n  schema: 1\n  id: docs.a\n  kind: policy\n  status: active\n  relations:\n    - type: supersedes\n      target: docs.b\n      reason: B is older.\n---\n\n# A\n',
    );
    writeFileSync(
      resolve(root, 'docs', 'b.md'),
      '---\nmdlineage:\n  schema: 1\n  id: docs.b\n  kind: policy\n  status: active\n  relations:\n    - type: supersedes\n      target: docs.a\n      reason: A is older.\n---\n\n# B\n',
    );
    try {
      const h = await harness(root);
      try {
        const { payload } = await callTool(h, 'validate_repository', {});
        const answer = payload as {
          files: number;
          diagnostics: Array<{ code: string; path: string }>;
          baseline: null;
        };
        assert.equal(answer.files, 2, 'both documents were indexed');
        const codes = answer.diagnostics.map((d) => d.code);
        assert.ok(codes.includes('MDL305'), 'the forbidden supersedes cycle is reported');
        assert.equal(answer.baseline, null, 'a tree with no baseline file reports none');
      } finally {
        await h.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('suppresses accepted debt through a committed baseline', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'mdl-mcp-bl-'));
    writeFileSync(
      resolve(root, 'a.md'),
      '---\nmdlineage:\n  schema: 1\n  id: docs.a\n  kind: policy\n  status: active\n  relations:\n    - type: supersedes\n      target: docs.missing\n      reason: Accepted debt.\n---\n\n# A\n',
    );
    writeFileSync(
      resolve(root, '.mdlineage-baseline.json'),
      JSON.stringify({
        version: 1,
        generatedAt: '2026-09-23T00:00:00.000Z',
        codes: { MDL302: ['a.md'] },
      }),
    );
    try {
      const h = await harness(root);
      try {
        const withBaseline = (await callTool(h, 'validate_repository', {})).payload as {
          diagnostics: Array<{ code: string }>;
          baseline: { applied: boolean; suppressed: number };
        };
        const codes = withBaseline.diagnostics.map((d) => d.code);
        assert.ok(!codes.includes('MDL302'), 'the baseline covers the accepted dangling target');
        assert.equal(withBaseline.baseline?.applied, true);
        assert.ok((withBaseline.baseline?.suppressed ?? 0) > 0, 'the tool reports how much debt it covered');
      } finally {
        await h.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('MCP server — get_schema and resources', () => {
  it('returns the checked-in v1 schema', async () => {
    const h = await harness();
    try {
      const { payload } = await callTool(h, 'get_schema', {});
      const answer = payload as { version: number; $id: string; schema: { required: string[] } };
      assert.equal(answer.version, 1);
      assert.equal(answer.$id, 'https://mdlineage.dev/schemas/mdlineage-v1.schema.json');
      assert.deepEqual(answer.schema.required, ['schema', 'id', 'kind', 'status']);
    } finally {
      await h.close();
    }
  });

  it('rejects an unsupported schema version instead of falling back', async () => {
    const h = await harness();
    try {
      const { payload } = await callTool(h, 'get_schema', { version: 99 });
      const answer = payload as { error: string; supported: number[] };
      assert.ok(answer.error, 'an unknown version is an error, not a silent v1');
      assert.deepEqual(answer.supported, [1]);
    } finally {
      await h.close();
    }
  });

  it('exposes both schemas as read-only resources', async () => {
    const h = await harness();
    try {
      const listed = await h.client.listResources();
      const uris = listed.resources.map((r) => r.uri).sort();
      assert.deepEqual(uris, ['urn:mdlineage:schema:mdlineage-config', 'urn:mdlineage:schema:mdlineage-v1']);
      const read = await h.client.readResource({ uri: 'urn:mdlineage:schema:mdlineage-v1' });
      const text = (read.contents as Array<{ text: string }>)[0]!.text;
      assert.ok(text.includes('"required"'), 'the resource carries the schema document');
    } finally {
      await h.close();
    }
  });
});

describe('MCP server — identity queries', () => {
  it('lists ids with kind and status', async () => {
    const h = await harness();
    try {
      const { payload } = await callTool(h, 'list_document_ids', { query: 'cache' });
      const answer = payload as { count: number; documents: Array<{ id: string; kind: string | null }> };
      assert.ok(answer.count >= 1, 'the cache-policy document is found by its id');
      const cache = answer.documents.find((d) => d.id === 'docs.cache-policy');
      assert.ok(cache, 'docs.cache-policy is listed');
      assert.equal(cache!.kind, 'policy');
    } finally {
      await h.close();
    }
  });

  it('filters by kind', async () => {
    const h = await harness();
    try {
      const { payload } = await callTool(h, 'list_document_ids', { kind: 'reference' });
      const answer = payload as { documents: Array<{ id: string; kind: string | null }> };
      assert.ok(answer.documents.length > 0);
      assert.ok(answer.documents.every((d) => d.kind === 'reference'), 'the kind filter holds');
      assert.ok(answer.documents.some((d) => d.id === 'docs.authentication-model'));
    } finally {
      await h.close();
    }
  });

  it('resolves a unique target and reports an unknown one as zero hits', async () => {
    const h = await harness();
    try {
      const unique = (await callTool(h, 'resolve_relation_target', { id: 'docs.cache-policy' })).payload as {
        resolution: string;
        hits: number;
        paths: string[];
      };
      assert.equal(unique.resolution, 'unique');
      assert.equal(unique.hits, 1);
      assert.ok(unique.paths[0]!.endsWith('v01-full.md'));

      const unknown = (await callTool(h, 'resolve_relation_target', { id: 'docs.nobody-claims-this' })).payload as {
        resolution: string;
        hits: number;
      };
      assert.equal(unknown.resolution, 'unresolved');
      assert.equal(unknown.hits, 0);
    } finally {
      await h.close();
    }
  });

  it('reports a duplicate id as ambiguous rather than picking one', async () => {
    const h = await harness();
    try {
      const { payload } = await callTool(h, 'resolve_relation_target', { id: 'docs.duplicate-id-a' });
      const answer = payload as { resolution: string; hits: number; paths: string[] };
      assert.equal(answer.resolution, 'ambiguous');
      assert.equal(answer.hits, 2, 'both claimants are returned');
    } finally {
      await h.close();
    }
  });
});

describe('MCP server — the suggest/apply accept loop', () => {
  it('produces a proposal for a document missing a required field', async () => {
    const h = await harness();
    try {
      const { payload } = await callTool(h, 'suggest_metadata', {
        content: '---\nmdlineage:\n  schema: 1\n  id: docs.demo\n  kind: policy\n---\n\n# Demo\n',
        path: 'demo.md',
      });
      const answer = payload as { proposals: MetadataProposal[]; diagnostics: string[] };
      assert.equal(answer.proposals.length, 1);
      const proposal = answer.proposals[0]!;
      assert.equal(proposal.operations.length, 1);
      assert.equal(proposal.operations[0]!.jsonPointer, '/status');
      assert.equal(proposal.operations[0]!.value, 'draft');
      // §12: a proposal is marked as a proposal, and it is never a diagnostic.
      assert.equal(proposal.source, 'rules');
      assert.equal(proposal.addresses[0], 'MDL102');
      assert.match(proposal.contentHash, /^[0-9a-f]{64}$/);
    } finally {
      await h.close();
    }
  });

  it('closes the loop: suggest queues, apply returns edits and a diff, nothing is written', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'mdl-mcp-loop-'));
    writeFileSync(
      resolve(root, 'doc.md'),
      '---\nmdlineage:\n  schema: 1\n  id: docs.loop\n  kind: policy\n---\n\n# Loop\n',
    );
    try {
      const h = await harness(root);
      try {
        const suggested = (await callTool(h, 'suggest_metadata', { path: 'doc.md' })).payload as {
          proposals: MetadataProposal[];
        };
        const proposalId = suggested.proposals[0]!.id;
        assert.ok(proposalId, 'the queued proposal has an id');

        const applied = (await callTool(h, 'apply_metadata_patch', { proposal_id: proposalId })).payload as {
          applied: boolean;
          path: string;
          edits: Array<{ line: number; character: number; newText: string }>;
          diff: string;
          patchedContent: string;
          note: string;
        };
        assert.equal(applied.applied, true);
        assert.equal(applied.edits.length, 1, 'one field is inserted');
        assert.match(applied.edits[0]!.newText, /status: draft/);
        assert.ok(applied.diff.includes('+ '), 'the diff shows the added line');
        assert.ok(applied.patchedContent.includes('status: draft'), 'the patched text carries the new field');

        // The acceptance boundary: the file on disk is unchanged.
        const onDisk = readFileSync(resolve(root, 'doc.md'), 'utf8');
        assert.ok(!onDisk.includes('status: draft'), 'nothing was written to disk');
        assert.ok(applied.note.toLowerCase().includes('never') || applied.note.toLowerCase().includes('nothing'), 'the answer says writing did not happen');

        // A second apply of the same id fails: the queue consumed it.
        const again = (await callTool(h, 'apply_metadata_patch', { proposal_id: proposalId })).payload as {
          applied: boolean;
          error: string;
        };
        assert.equal(again.applied, false);
        assert.ok(again.error, 'a consumed proposal is reported, not re-applied');
      } finally {
        await h.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('proposes a missing relation reason inside the relation block', async () => {
    const h = await harness();
    try {
      const content =
        '---\nmdlineage:\n  schema: 1\n  id: docs.demo\n  kind: policy\n  status: active\n' +
        '  relations:\n    - type: depends_on\n      target: docs.cache-policy\n---\n\n# Demo\n';
      const { payload } = await callTool(h, 'suggest_metadata', { content, path: 'demo.md' });
      const answer = payload as { proposals: MetadataProposal[] };
      const proposal = answer.proposals[0]!;
      assert.equal(proposal.operations[0]!.jsonPointer, '/relations/0/reason');

      const applied = (await callTool(h, 'apply_metadata_patch', { proposal_id: proposal.id })).payload as {
        applied: boolean;
        patchedContent: string;
      };
      assert.equal(applied.applied, true);
      // The reason lands INSIDE the relation entry, as a sibling of `target`,
      // and the patched document re-validates clean — which is the real
      // promise: an accepted proposal does not introduce a new diagnostic.
      assert.ok(
        applied.patchedContent.includes('target: docs.cache-policy\n      reason: '),
        'the reason is a sibling of target inside the relation entry',
      );

      const { validateDocumentSync } = await import('@mdlineage/validator');
      const codes = validateDocumentSync({ content: applied.patchedContent }).diagnostics.map((d) => d.code);
      assert.deepEqual(codes, [], 'the patched document validates clean');
    } finally {
      await h.close();
    }
  });

  it('answers cleanly when there is nothing deterministic to propose', async () => {
    const h = await harness();
    try {
      const content = '---\nmdlineage:\n  schema: 1\n  id: docs.demo\n  kind: policy\n  status: active\n---\n\n# Demo\n';
      const { payload } = await callTool(h, 'suggest_metadata', { content, path: 'demo.md' });
      const answer = payload as { proposals: MetadataProposal[]; note: string };
      assert.deepEqual(answer.proposals, []);
      assert.ok(answer.note, 'the caller learns why nothing was proposed');
    } finally {
      await h.close();
    }
  });
});

describe('MCP server — apply_metadata_patch write opt-in', () => {
  /** Queue one proposal for `path` and return its id. */
  async function propose(h: Harness, path: string, content?: string): Promise<string> {
    const { payload } = await callTool(h, 'suggest_metadata', content === undefined ? { path } : { path, content });
    const answer = payload as { proposals: MetadataProposal[] };
    assert.equal(answer.proposals.length, 1, `a proposal was queued for ${path}`);
    return answer.proposals[0]!.id;
  }

  it('writes nothing by default: the content and the mtime are untouched', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'mdl-mcp-ro-'));
    const target = resolve(root, 'doc.md');
    writeFileSync(target, GAPPY_DOCUMENT);
    try {
      const h = await harness(root);
      try {
        const proposalId = await propose(h, 'doc.md');
        const before = statSync(target);

        const { payload } = await callTool(h, 'apply_metadata_patch', { proposal_id: proposalId });
        const applied = payload as { applied: boolean; written: boolean; patchedContent: string; note: string };

        assert.equal(applied.applied, true);
        assert.equal(applied.written, false, 'the answer states that nothing was written');
        assert.ok(
          applied.note.toLowerCase().includes('nothing') || applied.note.toLowerCase().includes('never'),
          'the answer says writing did not happen',
        );
        assert.equal(readFileSync(target, 'utf8'), GAPPY_DOCUMENT, 'the file still holds the original text');
        assert.equal(statSync(target).mtimeMs, before.mtimeMs, 'the file was not even opened for writing');
      } finally {
        await h.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('write: true writes exactly the reviewed patchedContent and closes the gap', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'mdl-mcp-wr-'));
    const target = resolve(root, 'doc.md');
    writeFileSync(target, GAPPY_DOCUMENT);
    try {
      const h = await harness(root);
      try {
        const proposalId = await propose(h, 'doc.md');

        const { payload } = await callTool(h, 'apply_metadata_patch', { proposal_id: proposalId, write: true });
        const applied = payload as {
          applied: boolean;
          written: boolean;
          writtenPath: string;
          patchedContent: string;
          diff: string;
        };

        assert.equal(applied.applied, true);
        assert.equal(applied.written, true, 'the opt-in was honoured');
        assert.equal(applied.writtenPath, target, 'the answer names the file it wrote');
        assert.equal(
          readFileSync(target, 'utf8'),
          applied.patchedContent,
          'what landed on disk is the text the diff described, not a second computation',
        );
        // The diff names the line that was written: its `+ ` prefix plus the
        // front matter's own two-space indent (the pairing itself is the naive
        // one the queue ships with — see the progress leftovers).
        assert.match(applied.diff, /^\+ {3}status: draft$/m, 'the diff still describes the change that was written');

        // The loop closes: the diagnostic the proposal addressed is gone.
        const validated = (await callTool(h, 'validate_document', { path: 'doc.md' })).payload as {
          diagnostics: Array<{ code: string }>;
        };
        assert.ok(
          !validated.diagnostics.some((d) => d.code === 'MDL102'),
          `the written document no longer reports MDL102, got ${validated.diagnostics.map((d) => d.code).join(', ')}`,
        );
      } finally {
        await h.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('write: true refuses a path outside the workspace root and leaves it alone', async () => {
    const parent = mkdtempSync(resolve(tmpdir(), 'mdl-mcp-esc-'));
    const root = resolve(parent, 'ws');
    const outside = resolve(parent, 'outside');
    mkdirSync(root);
    mkdirSync(outside);
    const outsideDoc = resolve(outside, 'doc.md');
    writeFileSync(outsideDoc, GAPPY_DOCUMENT);
    try {
      const h = await harness(root);
      try {
        const proposalId = await propose(h, '../outside/doc.md');

        const { payload } = await callTool(h, 'apply_metadata_patch', { proposal_id: proposalId, write: true });
        const applied = payload as {
          applied: boolean;
          written: boolean;
          error: string;
          requeuedProposalId: string;
          patchedContent: string;
        };

        assert.equal(applied.written, false, 'the escape was refused');
        assert.equal(applied.applied, false);
        assert.match(applied.error, /outside the workspace root/, 'the refusal says why');
        assert.equal(readFileSync(outsideDoc, 'utf8'), GAPPY_DOCUMENT, 'the file outside the root is unchanged');
        assert.deepEqual(readdirSync(outside), ['doc.md'], 'nothing was created next to it either');

        // The refusal is a review state: the proposal is still queued, and a
        // default apply of it still writes nothing.
        const { payload: retried } = await callTool(h, 'apply_metadata_patch', {
          proposal_id: applied.requeuedProposalId,
        });
        assert.equal((retried as { written: boolean }).written, false);
        assert.equal(readFileSync(outsideDoc, 'utf8'), GAPPY_DOCUMENT, 'the retry wrote nothing either');
      } finally {
        await h.close();
      }
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('write: true refuses a symlinked directory that points outside the workspace root', async () => {
    // The guard is a real-path check, not a string prefix one: `linkdir` lives
    // inside the root, so `relative(root, 'linkdir/escaped.md')` says "inside"
    // while the directory it names is outside.
    const parent = mkdtempSync(resolve(tmpdir(), 'mdl-mcp-link-'));
    const root = resolve(parent, 'ws');
    const outside = resolve(parent, 'outside');
    mkdirSync(root);
    mkdirSync(outside);
    symlinkSync(outside, resolve(root, 'linkdir'), 'dir');
    const escaped = resolve(outside, 'escaped.md');
    writeFileSync(escaped, GAPPY_DOCUMENT);
    try {
      const h = await harness(root);
      try {
        const proposalId = await propose(h, 'linkdir/escaped.md');

        const { payload } = await callTool(h, 'apply_metadata_patch', { proposal_id: proposalId, write: true });
        const applied = payload as {
          applied: boolean;
          written: boolean;
          error: string;
          requeuedProposalId: string;
          patchedContent: string;
        };

        assert.equal(applied.written, false, 'the symlinked escape was refused');
        assert.equal(applied.applied, false);
        assert.match(applied.error!, /outside the workspace root/, 'the refusal names the real path it resolved to');
        assert.equal(readFileSync(escaped, 'utf8'), GAPPY_DOCUMENT, 'the file outside the root is byte-for-byte unchanged');
        assert.deepEqual(readdirSync(outside), ['escaped.md'], 'nothing was created next to it either');
        assert.ok(lstatSync(resolve(root, 'linkdir')).isSymbolicLink(), 'the symlink itself survives for reuse');

        // The refusal is a review state, and a default apply of the requeued
        // proposal still writes nothing.
        const { payload: retried } = await callTool(h, 'apply_metadata_patch', {
          proposal_id: applied.requeuedProposalId,
        });
        assert.equal((retried as { written: boolean }).written, false);
        assert.equal(readFileSync(escaped, 'utf8'), GAPPY_DOCUMENT, 'the retry wrote nothing either');
      } finally {
        await h.close();
      }
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('write: true refuses a trailing symlink instead of replacing the link', async () => {
    // The last component being a symlink: the rename would replace the link
    // itself with a regular file, destroying it, and the text would land
    // wherever the link points.
    const parent = mkdtempSync(resolve(tmpdir(), 'mdl-mcp-trail-'));
    const root = resolve(parent, 'ws');
    const outside = resolve(parent, 'outside');
    mkdirSync(root);
    mkdirSync(outside);
    const real = resolve(outside, 'real.md');
    writeFileSync(real, GAPPY_DOCUMENT);
    symlinkSync(real, resolve(root, 'doc.md'));
    try {
      const h = await harness(root);
      try {
        const proposalId = await propose(h, 'doc.md');

        const { payload } = await callTool(h, 'apply_metadata_patch', { proposal_id: proposalId, write: true });
        const applied = payload as { written: boolean; error: string };

        assert.equal(applied.written, false, 'the trailing symlink was refused');
        assert.match(applied.error!, /symbolic link/, 'the refusal says the target is a link');
        assert.equal(readFileSync(real, 'utf8'), GAPPY_DOCUMENT, 'the file the link points at is unchanged');
        assert.ok(lstatSync(resolve(root, 'doc.md')).isSymbolicLink(), 'the link is still a link, not a regular file');
        assert.deepEqual(readdirSync(root), ['doc.md'], 'no temporary file was left behind');
      } finally {
        await h.close();
      }
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('write: true refuses to create a file outside the root through a symlink', async () => {
    // The target does not exist yet, so the only thing standing between the
    // write and a brand-new file outside the root is the real-path guard.
    const parent = mkdtempSync(resolve(tmpdir(), 'mdl-mcp-newfile-'));
    const root = resolve(parent, 'ws');
    const outside = resolve(parent, 'outside');
    mkdirSync(root);
    mkdirSync(outside);
    symlinkSync(outside, resolve(root, 'linkdir'), 'dir');
    try {
      const h = await harness(root);
      try {
        // The proposal comes from an unsaved buffer: suggest never reads the
        // disk, so a target that is not there yet still gets a proposal.
        const proposalId = await propose(h, 'linkdir/new.md', GAPPY_DOCUMENT);

        const { payload } = await callTool(h, 'apply_metadata_patch', { proposal_id: proposalId, write: true });
        const applied = payload as { written: boolean; error: string };

        assert.equal(applied.written, false, 'no file was created outside the root');
        assert.match(applied.error!, /outside the workspace root/, 'the real-path guard refused it');
        assert.ok(!existsSync(resolve(outside, 'new.md')), 'nothing was created outside the root');
        assert.deepEqual(readdirSync(outside), [], 'the outside directory is still empty');
      } finally {
        await h.close();
      }
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('write: true still writes when the workspace root itself is a symlink', async () => {
    // A symlinked root is a legitimate setup (a checkout reached through a
    // stable path, say): the real-path guard must resolve the root too, or a
    // correct write inside it would be refused.
    const parent = mkdtempSync(resolve(tmpdir(), 'mdl-mcp-rootlink-'));
    const real = resolve(parent, 'real');
    mkdirSync(real);
    const target = resolve(real, 'doc.md');
    writeFileSync(target, GAPPY_DOCUMENT);
    const root = resolve(parent, 'ws');
    symlinkSync(real, root, 'dir');
    try {
      const h = await harness(root);
      try {
        const proposalId = await propose(h, 'doc.md');

        const { payload } = await callTool(h, 'apply_metadata_patch', { proposal_id: proposalId, write: true });
        const applied = payload as { written: boolean; writtenPath: string; patchedContent: string };

        assert.equal(applied.written, true, 'a write inside the real root is honoured');
        assert.equal(applied.writtenPath, resolve(root, 'doc.md'));
        assert.equal(readFileSync(target, 'utf8'), applied.patchedContent, 'the real file carries the reviewed text');
        assert.ok(readFileSync(target, 'utf8').includes('status: draft'), 'the real file was patched');
      } finally {
        await h.close();
      }
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('write: true keeps a CRLF document CRLF instead of mixing in a bare LF', async () => {
    // The inserted line used to carry a hardcoded LF, so a CRLF document came
    // back with one bare LF in it — the write itself introduced MDL601.
    const root = mkdtempSync(resolve(tmpdir(), 'mdl-mcp-crlf-'));
    const target = resolve(root, 'doc.md');
    writeFileSync(target, GAPPY_CRLF);
    const before = eolCensus(GAPPY_CRLF);
    try {
      const h = await harness(root);
      try {
        const proposalId = await propose(h, 'doc.md');

        const { payload } = await callTool(h, 'apply_metadata_patch', { proposal_id: proposalId, write: true });
        const applied = payload as { written: boolean; patchedContent: string };

        assert.equal(applied.written, true);
        const after = readFileSync(target, 'utf8');
        // `includes('\r\n')` stays true even when the write corrupts the file,
        // so the assertion is on the census: the styles present must not grow.
        assert.deepEqual(eolCensus(after), { crlf: before.crlf + 1, bareLf: before.bareLf }, 'no new line-ending style');
        assert.equal(after, applied.patchedContent, 'what landed on disk is the reviewed text');

        const validated = (await callTool(h, 'validate_document', { path: 'doc.md' })).payload as {
          diagnostics: Array<{ code: string }>;
        };
        const codes = validated.diagnostics.map((d) => d.code);
        assert.ok(codes.includes('MDL602'), 'the CRLF policy gap the document already had is still reported');
        assert.ok(!codes.includes('MDL601'), `the write must not mix line endings, got ${codes.join(', ')}`);
      } finally {
        await h.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('write: true refuses a read-only target and changes no bytes', async () => {
    // `rename` checks the directory's permissions, not the target file's, so a
    // chmod 400 file used to be overwritten with no error at all.
    const root = mkdtempSync(resolve(tmpdir(), 'mdl-mcp-rofile-'));
    const target = resolve(root, 'doc.md');
    writeFileSync(target, GAPPY_DOCUMENT);
    chmodSync(target, 0o400);
    try {
      const h = await harness(root);
      try {
        const proposalId = await propose(h, 'doc.md');

        const { payload } = await callTool(h, 'apply_metadata_patch', { proposal_id: proposalId, write: true });
        const applied = payload as { applied: boolean; written: boolean; error: string };

        assert.equal(applied.written, false, 'the read-only file was not written');
        assert.equal(applied.applied, false);
        assert.match(applied.error!, /cannot write/, 'the refusal is a structured error');
        assert.equal(readFileSync(target, 'utf8'), GAPPY_DOCUMENT, 'not one byte of the file changed');
        assert.equal(statSync(target).mode & 0o777, 0o400, 'the mode is untouched too');
        assert.deepEqual(readdirSync(root), ['doc.md'], 'no temporary file was left behind');
      } finally {
        await h.close();
      }
    } finally {
      chmodSync(target, 0o600);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('write: true refuses when only the disk copy moved on since the proposal', async () => {
    // The second disjunct of the staleness guard, on its own: the buffer
    // snapshot still matches the proposal hash, so only the comparison of the
    // disk text against that snapshot can catch this.
    const root = mkdtempSync(resolve(tmpdir(), 'mdl-mcp-diskonly-'));
    const target = resolve(root, 'doc.md');
    writeFileSync(target, GAPPY_DOCUMENT);
    try {
      const h = await harness(root);
      try {
        // The proposal is derived from the inline buffer, not from the disk.
        const proposalId = await propose(h, 'doc.md', GAPPY_DOCUMENT);
        // A human edits the file on disk: the snapshot and the proposal hash
        // still agree, the file does not.
        const edited = GAPPY_DOCUMENT.replace('# Loop', '# Loop, edited by a human');
        writeFileSync(target, edited);

        const { payload } = await callTool(h, 'apply_metadata_patch', { proposal_id: proposalId, write: true });
        const applied = payload as { applied: boolean; written: boolean; error: string; requeuedProposalId: string };

        assert.equal(applied.written, false, 'the disk-only drift was refused');
        assert.match(applied.error!, /changed since the proposal/, 'the refusal names the reason');
        assert.equal(readFileSync(target, 'utf8'), edited, 'the human edit survives');

        const { payload: retried } = await callTool(h, 'apply_metadata_patch', {
          proposal_id: applied.requeuedProposalId,
        });
        assert.equal((retried as { written: boolean }).written, false, 'the requeued proposal writes nothing by default');
      } finally {
        await h.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('write: true refuses when the proposal hash no longer matches the text it was derived from', async () => {
    // The other disjunct of the staleness guard, on its own: the disk still
    // holds the snapshot, so only the proposal-hash comparison can catch this.
    const root = mkdtempSync(resolve(tmpdir(), 'mdl-mcp-hash-'));
    const target = resolve(root, 'doc.md');
    writeFileSync(target, GAPPY_DOCUMENT);
    try {
      const h = await harnessWithQueue(root);
      try {
        const stale = h.queue.enqueue(
          {
            path: 'doc.md',
            operations: [{ jsonPointer: '/status', value: 'draft', rationale: 'MDL102 requires status.' }],
            addresses: ['MDL102'],
            source: 'rules',
            // A hash of some other text: the proposal no longer describes the
            // document it was derived from.
            contentHash: createHash('sha256').update('# Some other document\n', 'utf8').digest('hex'),
          },
          GAPPY_DOCUMENT,
        );

        const { payload } = await callTool(h, 'apply_metadata_patch', { proposal_id: stale.id, write: true });
        const applied = payload as { applied: boolean; written: boolean; error: string };

        assert.equal(applied.written, false, 'the hash mismatch was refused');
        assert.match(applied.error!, /changed since the proposal/, 'the refusal names the reason');
        assert.equal(readFileSync(target, 'utf8'), GAPPY_DOCUMENT, 'the file is untouched');
      } finally {
        await h.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('write: true refuses a document the user deleted instead of recreating it', async () => {
    // A missing target used to pass the staleness guard (the buffer snapshot
    // always matches), so `write: true` recreated the deleted file.
    const root = mkdtempSync(resolve(tmpdir(), 'mdl-mcp-deleted-'));
    const target = resolve(root, 'doc.md');
    writeFileSync(target, GAPPY_DOCUMENT);
    try {
      const h = await harness(root);
      try {
        const proposalId = await propose(h, 'doc.md');
        rmSync(target);

        const { payload } = await callTool(h, 'apply_metadata_patch', { proposal_id: proposalId, write: true });
        const applied = payload as { written: boolean; error: string };

        assert.equal(applied.written, false, 'the deleted document was not recreated');
        assert.match(applied.error!, /no longer exists on disk/, 'the refusal says the target is gone');
        assert.ok(!existsSync(target), 'the file is still gone');
        assert.deepEqual(readdirSync(root), [], 'nothing was created in its place');
      } finally {
        await h.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('write: true refuses a document that was renamed and leaves the old path empty', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'mdl-mcp-renamed-'));
    const target = resolve(root, 'doc.md');
    const moved = resolve(root, 'moved.md');
    writeFileSync(target, GAPPY_DOCUMENT);
    try {
      const h = await harness(root);
      try {
        const proposalId = await propose(h, 'doc.md');
        renameSync(target, moved);

        const { payload } = await callTool(h, 'apply_metadata_patch', { proposal_id: proposalId, write: true });
        const applied = payload as { written: boolean; error: string };

        assert.equal(applied.written, false, 'the old path was not written');
        assert.match(applied.error!, /no longer exists on disk/, 'the refusal names the reason');
        assert.ok(!existsSync(target), 'no fresh copy appeared at the old path');
        assert.equal(readFileSync(moved, 'utf8'), GAPPY_DOCUMENT, 'the renamed document is untouched');
      } finally {
        await h.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('requeues on the branches that used to drop the proposal', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'mdl-mcp-rq-'));
    writeFileSync(resolve(root, 'doc.md'), GAPPY_DOCUMENT);
    try {
      const h = await harnessWithQueue(root);
      try {
        // (a) the document cannot be read: the branch that requeued silently
        // and left the caller holding an id that no longer names anything.
        const unreadable = h.queue.enqueue({
          path: 'gone.md',
          operations: [{ jsonPointer: '/status', value: 'draft', rationale: 'MDL102 requires status.' }],
          addresses: ['MDL102'],
          source: 'rules',
          contentHash: createHash('sha256').update(GAPPY_DOCUMENT, 'utf8').digest('hex'),
        });
        const unreadableAnswer = (await callTool(h, 'apply_metadata_patch', { proposal_id: unreadable.id, write: true }))
          .payload as { applied: boolean; error: string; requeuedProposalId?: string };
        assert.equal(unreadableAnswer.applied, false);
        assert.ok(unreadableAnswer.requeuedProposalId, 'the read failure names the requeued id');
        assert.ok(h.queue.has(unreadableAnswer.requeuedProposalId!), 'the proposal is still queued');

        // (b) no mdlineage front matter block: the branch that used to drop the
        // proposal for good.
        writeFileSync(resolve(root, 'doc.md'), '# Loop\n');
        const noFrontMatter = h.queue.enqueue({
          path: 'doc.md',
          operations: [{ jsonPointer: '/status', value: 'draft', rationale: 'MDL102 requires status.' }],
          addresses: ['MDL102'],
          source: 'rules',
          contentHash: createHash('sha256').update('# Loop\n', 'utf8').digest('hex'),
        });
        const noFrontMatterAnswer = (
          await callTool(h, 'apply_metadata_patch', { proposal_id: noFrontMatter.id, write: true })
        ).payload as { applied: boolean; error: string; requeuedProposalId?: string };
        assert.equal(noFrontMatterAnswer.applied, false);
        assert.ok(noFrontMatterAnswer.requeuedProposalId, 'the missing-block branch requeues too');
        assert.ok(h.queue.has(noFrontMatterAnswer.requeuedProposalId!), 'the proposal is still queued');
        assert.notEqual(
          noFrontMatterAnswer.requeuedProposalId,
          noFrontMatter.id,
          'the requeued id is a new one, and the old one is spent',
        );
      } finally {
        await h.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('write: true refuses to replace a document that moved on since the proposal', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'mdl-mcp-stale-'));
    const target = resolve(root, 'doc.md');
    writeFileSync(target, GAPPY_DOCUMENT);
    try {
      const h = await harness(root);
      try {
        const proposalId = await propose(h, 'doc.md');
        // A human edited the document after the proposal was queued: the diff
        // the caller reviewed no longer describes the file on disk.
        const edited = GAPPY_DOCUMENT.replace('# Loop', '# Loop, edited\n\nA human typed this.');
        writeFileSync(target, edited);

        const { payload } = await callTool(h, 'apply_metadata_patch', { proposal_id: proposalId, write: true });
        const applied = payload as { applied: boolean; written: boolean; error: string };

        assert.equal(applied.written, false, 'the stale write was refused');
        assert.match(applied.error!, /changed since the proposal/, 'the refusal names the reason');
        assert.equal(readFileSync(target, 'utf8'), edited, 'the human edit survives');
      } finally {
        await h.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('write: true keeps the no-front-matter branch and writes nothing', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'mdl-mcp-nofm-'));
    const target = resolve(root, 'doc.md');
    writeFileSync(target, GAPPY_DOCUMENT);
    try {
      const h = await harnessWithQueue(root);
      try {
        // suggest_metadata always travels with the buffer snapshot it analysed,
        // so the branch that reads the document from disk is reached by
        // queueing a proposal without one.
        const queued = h.queue.enqueue({
          path: 'doc.md',
          operations: [{ jsonPointer: '/status', value: 'draft', rationale: 'MDL102 requires status.' }],
          addresses: ['MDL102'],
          source: 'rules',
          contentHash: createHash('sha256').update(GAPPY_DOCUMENT, 'utf8').digest('hex'),
        });
        // The document loses its mdlineage block between the proposal and the
        // accept, which is the branch the tool has always reported.
        const stripped = '# Loop\n';
        writeFileSync(target, stripped);

        const { payload } = await callTool(h, 'apply_metadata_patch', { proposal_id: queued.id, write: true });
        const applied = payload as { applied: boolean; written: boolean; error: string };

        assert.equal(applied.applied, false, 'the existing error branch is unchanged by the flag');
        assert.match(applied.error!, /front matter block/, 'the error names the missing block');
        assert.equal(readFileSync(target, 'utf8'), stripped, 'nothing was written');
      } finally {
        await h.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('write: true reports a failed write as a structured error with no half-written file', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'mdl-mcp-fail-'));
    const target = resolve(root, 'doc.md');
    writeFileSync(target, GAPPY_DOCUMENT);
    chmodSync(root, 0o500);
    try {
      const h = await harness(root);
      try {
        const proposalId = await propose(h, 'doc.md');

        const { payload } = await callTool(h, 'apply_metadata_patch', { proposal_id: proposalId, write: true });
        const applied = payload as { applied: boolean; written: boolean; error: string };

        assert.equal(applied.written, false);
        assert.equal(applied.applied, false);
        assert.match(applied.error!, /cannot write/, 'the failure is reported, not thrown');
        assert.equal(readFileSync(target, 'utf8'), GAPPY_DOCUMENT, 'the original file is intact');
        assert.deepEqual(readdirSync(root), ['doc.md'], 'the temporary file was cleaned up');
      } finally {
        await h.close();
      }
    } finally {
      chmodSync(root, 0o700);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('write: true fails cleanly when the target cannot be replaced', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'mdl-mcp-isdir-'));
    // A directory where the document should be: the proposal comes from the
    // buffer (nothing readable on disk), and the rename that would replace the
    // directory fails — the case a permissions trick cannot produce as root.
    mkdirSync(resolve(root, 'doc.md'));
    try {
      const h = await harness(root);
      try {
        const proposalId = await propose(h, 'doc.md', GAPPY_DOCUMENT);

        const { payload } = await callTool(h, 'apply_metadata_patch', { proposal_id: proposalId, write: true });
        const applied = payload as { applied: boolean; written: boolean; error: string };

        assert.equal(applied.written, false);
        assert.match(applied.error!, /cannot write/, 'the rename failure is reported as an error');
        assert.ok(statSync(resolve(root, 'doc.md')).isDirectory(), 'the directory is still there');
        assert.deepEqual(readdirSync(root), ['doc.md'], 'no temporary file was left behind');
      } finally {
        await h.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('MCP server — argument validation', () => {
  it('rejects a call missing a required argument', async () => {
    const h = await harness();
    try {
      const result = await callTool(h, 'validate_document', {});
      assert.equal(result.raw.isError, true, 'a missing `path` is a client error');
    } finally {
      await h.close();
    }
  });

  it('builds the server without registering a tool twice', () => {
    // Two servers in one process must coexist: the queue is per instance, and
    // the SDK throws when a tool name is registered twice on one server.
    const one = createMdlineageMcpServer(createContext(repoRoot));
    const two = createMdlineageMcpServer(createContext(repoRoot));
    assert.notEqual(one.queue, two.queue, 'each server owns its own proposal queue');
  });
});
