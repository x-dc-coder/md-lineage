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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, statSync, readdirSync, chmodSync } from 'node:fs';
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
      assert.equal(byName.get('apply_metadata_patch')?.annotations?.destructiveHint, false, 'the write is additive');
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
