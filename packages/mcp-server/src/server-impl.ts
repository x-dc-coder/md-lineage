/**
 * MDLineage MCP server (docs/remark-language-server-solution.md §12).
 *
 * One transport, one process: stdio, which is what an editor or a CLI spawns.
 * The tools are the §12 table, implemented against @mdlineage/validator, so a
 * model that asks here gets the same codes, messages and ranges the remark
 * channel, the CLI, the LSP and the validator API itself produce — §14.4's
 * one-fixture-many-entries promise extended to a fifth entry point.
 *
 * The two tools that are NOT pure validation are this milestone's point:
 *   - `suggest_metadata` turns a document's gaps into proposals (never into
 *     diagnostics — §12 is explicit that a proposal is not a diagnostic);
 *   - `apply_metadata_patch` accepts a proposal and returns Front Matter
 *     TextEdits plus a reviewable diff. It writes nothing. Writing is the
 *     caller's step, after a human has read the diff, which is the "LLM 永远
 *     没有直接写 Front Matter 的通道" boundary §12 draws.
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, isAbsolute, relative, sep, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { z } from 'zod';
import {
  validateDocumentSync,
  createWorkspaceIndex,
  validateWorkspace,
  loadConfig,
  parseBaseline,
  type Config,
  type Diagnostic,
  type DocPath,
  type Baseline,
  type LineMap,
} from '@mdlineage/validator';
import {
  ProposalQueue,
  buildProposals,
  applyProposalToContent,
  diffOf,
  resetProposalIds,
} from './proposals.js';

export { resetProposalIds, ProposalQueue, buildProposals, applyProposalToContent, diffOf };

const SERVER_NAME = 'mdlineage';
const SERVER_VERSION = '0.0.0';

/** The checked-in schema files, exposed as tools and as read-only resources. */
const SCHEMA_V1 = 'mdlineage-v1.schema.json';
const SCHEMA_CONFIG = 'mdlineage-config.schema.json';
const RESOURCE_URIS = {
  v1: 'urn:mdlineage:schema:mdlineage-v1',
  config: 'urn:mdlineage:schema:mdlineage-config',
} as const;

/**
 * The workspace a server instance validates.
 *
 * An MCP stdio server is one process per editor, so one context per process is
 * the right granularity: the root is the tree the tools see, and a client that
 * wants two trees runs two servers.
 */
export interface McpServerContext {
  /** Absolute root the workspace tools index. */
  readonly root: string;
  /** Config as loaded for `root`. */
  readonly config: Config;
  /** Config diagnostics (MDL900) for the run; attached to each tool's answer. */
  readonly configDiagnostics: readonly ConfigDiagnosticReport[];
}

export interface ConfigDiagnosticReport {
  readonly code: string;
  readonly severity: string;
  readonly message: string;
}

/**
 * Build the context for a root: config first, because every tool after it
 * depends on which config the repository actually has.
 */
export function createContext(root: string, configFile?: string): McpServerContext {
  const loaded = loadConfig(configFile, configFile ? undefined : root);
  return {
    root: resolve(root),
    config: loaded.config,
    configDiagnostics: loaded.diagnostics.map((d) => ({ code: d.code, severity: d.severity, message: d.message })),
  };
}

/** Create the MCP server with every §12 tool registered. */
export function createMdlineageMcpServer(context: McpServerContext): {
  server: McpServer;
  queue: ProposalQueue;
} {
  const queue = new ProposalQueue();
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        'MDLineage: validate Markdown metadata, resolve document identities, and review metadata proposals. ' +
        'Use validate_document for one file, validate_repository for the whole workspace, and suggest_metadata ' +
        'followed by apply_metadata_patch to fill missing metadata — apply returns a diff and never writes.',
    },
  );

  registerValidateDocument(server, context);
  registerValidateRepository(server, context);
  registerGetSchema(server);
  registerListDocumentIds(server, context);
  registerResolveRelationTarget(server, context);
  registerSuggestMetadata(server, context, queue);
  registerApplyMetadataPatch(server, context, queue);
  registerSchemaResources(server);

  return { server, queue };
}

/**
 * Start the server on stdio. The caller owns the process lifecycle from here:
 * stdin and stdout are the protocol, so nothing may write to them after this.
 */
export async function startStdio(options: McpServerOptions = {}): Promise<McpServer> {
  const context = createContext(options.root ?? process.cwd(), options.configFile);
  const { server } = createMdlineageMcpServer(context);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}

/** What the stdio entry can name: the tree to index, and the config to load. */
export interface McpServerOptions {
  /** Absolute directory the tools index. Defaults to the process CWD. */
  readonly root?: string;
  /** Explicit config file; omitted means "search the root". */
  readonly configFile?: string;
}

/**
 * Attach the server to a caller-supplied transport, for in-process testing.
 *
 * A test pairs this with the SDK's `InMemoryTransport` and drives the server
 * through a real `Client`, so the assertions cross the protocol boundary — the
 * same boundary the stdio entry crosses, minus the process.
 */
export async function connectToTransport(
  context: McpServerContext,
  transport: Transport,
): Promise<{ server: McpServer; queue: ProposalQueue }> {
  const built = createMdlineageMcpServer(context);
  await built.server.connect(transport);
  return built;
}

/** A diagnostic in the shape the MCP tools report: §11's JSON, LSP coordinates. */
export interface ToolDiagnostic {
  readonly code: string;
  readonly severity: string;
  readonly message: string;
  readonly path: string;
  readonly range: {
    readonly start: { readonly line: number; readonly character: number; readonly offset: number };
    readonly end: { readonly line: number; readonly character: number; readonly offset: number };
  };
  readonly layer: string;
  readonly data?: Record<string, unknown>;
}

/** Validator Diagnostic → the tool-reporting shape (LSP coords are 0-based). */
function toToolDiagnostic(diag: Diagnostic, path: string): ToolDiagnostic {
  return {
    code: diag.code,
    severity: diag.severity,
    message: diag.message,
    path,
    range: {
      start: {
        line: diag.range.start.line - 1,
        character: diag.range.start.column - 1,
        offset: diag.range.start.offset,
      },
      end: {
        line: diag.range.end.line - 1,
        character: diag.range.end.column - 1,
        offset: diag.range.end.offset,
      },
    },
    layer: diag.layer,
    ...(diag.data ? { data: diag.data } : {}),
  };
}

/**
 * Read a document the caller named, with the unsaved-content override the
 * §12 signature allows. `content` wins when both are given, which is what a
 * model holding a buffer needs; the file is still read when the caller only
 * named a path, which is what a model looking at the repository needs.
 */
function readDocument(path: string, content: string | undefined, root: string): ReadResult {
  const absolute = isAbsolute(path) ? path : resolve(root, path);
  const resolvedPath = resolvePath(path, root);
  if (content !== undefined) {
    return { content, resolvedPath, diskPath: absolute, error: null };
  }
  try {
    const stats = statSync(absolute);
    if (!stats.isFile()) return { content: null, resolvedPath, diskPath: absolute, error: `not a file: ${absolute}` };
    return { content: readFileSync(absolute, 'utf8'), resolvedPath, diskPath: absolute, error: null };
  } catch (error) {
    return {
      content: null,
      resolvedPath,
      diskPath: absolute,
      error: `cannot read ${resolvedPath}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

interface ReadResult {
  readonly content: string | null;
  /** The path as the tool reports it: rooted when it is outside the workspace. */
  readonly resolvedPath: string;
  /** The path to read from disk, absolute. */
  readonly diskPath: string;
  readonly error: string | null;
}

/**
 * Resolve a path the caller gave against the workspace root.
 *
 * An absolute path is used as given (a client that hands the tool a full path
 * means it). A relative one is resolved against `root`, and the reported path
 * is spelled relative to the root when it is inside it, which is how the index
 * keys documents and how the CLI's reports read.
 */
export function resolvePath(path: string, root: string): string {
  const absolute = isAbsolute(path) ? path : resolve(root, path);
  const rel = relative(root, absolute);
  if (rel === '' || rel.startsWith('..')) return absolute;
  return rel.split(sep).join('/');
}

/** SHA-256 of a document, the content hash every proposal carries. */
function hashOf(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** A tool's structured payload, as one text block the client parses. */
function asJson(payload: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
}

/** Every §12 tool name, in the order the doc's table lists them. */
export const TOOL_NAMES = [
  'validate_document',
  'validate_repository',
  'get_schema',
  'list_document_ids',
  'resolve_relation_target',
  'suggest_metadata',
  'apply_metadata_patch',
] as const;

/**
 * `validate_document(path, content?)` — the single-document channel.
 *
 * Runs the same stack the remark plugin and the LSP run, so the §14.4 fixture
 * contract reaches this entry point too. Config diagnostics are attached once
 * per call: they are about the run, not the document, and a model that ignores
 * them would blame the document for a broken config.
 */
function registerValidateDocument(server: McpServer, context: McpServerContext): void {
  server.registerTool(
    'validate_document',
    {
      title: 'Validate one document',
      description:
        'Validate a single Markdown document: front matter syntax, JSON Schema, single-document semantics and line-ending hygiene. ' +
        'Pass `content` to validate an unsaved buffer instead of the file on disk. Returns MDLxxx diagnostics with LSP coordinates (0-based).',
      inputSchema: {
        path: z.string().min(1).describe('Path to the document, relative to the workspace root or absolute.'),
        content: z.string().optional().describe('Document text to validate instead of reading the file. Use for unsaved buffers.'),
      },
      annotations: { readOnlyHint: true },
    },
    ({ path, content }) => {
      const read = readDocument(path, content, context.root);
      if (read.content === null) {
        return asJson({
          path: read.resolvedPath,
          diagnostics: [],
          unreadable: read.error,
          configDiagnostics: context.configDiagnostics,
        });
      }
      const result = validateDocumentSync({ path: read.resolvedPath, content: read.content, config: context.config });
      return asJson({
        path: read.resolvedPath,
        diagnostics: result.diagnostics.map((d) => toToolDiagnostic(d, read.resolvedPath)),
        layers: [...result.layers],
        configDiagnostics: context.configDiagnostics,
      });
    },
  );
}

/**
 * `validate_repository(paths?)` — the workspace channel, cross-file codes included.
 *
 * Reads the tree the context's root names, builds one index over it and reports
 * the workspace layer's codes on top of the single-document ones — the same
 * pass `mdlineage check` runs, so a model that asks here and a CI that runs
 * the CLI cannot disagree about a duplicate id.
 *
 * A committed baseline is honoured when one is present: accepted debt stays
 * silent, which is the repository's contract, and a model that asks for the
 * repository's state gets the state CI enforces rather than the debt the
 * baseline already owns.
 */
function registerValidateRepository(server: McpServer, context: McpServerContext): void {
  server.registerTool(
    'validate_repository',
    {
      title: 'Validate the repository',
      description:
        'Validate every Markdown document in the workspace: single-document diagnostics plus the cross-file codes (MDL301 duplicate id, MDL302 unresolved target, MDL305 forbidden cycle, MDL401/MDL402 links and anchors). ' +
        'A committed baseline suppresses accepted debt. Optional `paths` restricts the pass to a subset.',
      inputSchema: {
        paths: z
          .array(z.string().min(1))
          .optional()
          .describe('Restrict the pass to these paths (relative to the root or absolute). Omit for the whole workspace.'),
      },
      annotations: { readOnlyHint: true },
    },
    ({ paths }) => {
      const files = scanWorkspaceFiles(context.root, context.config);
      const scope = paths ? new Set(paths.map((p) => resolvePath(p, context.root))) : null;
      const indexFiles = new Map<DocPath, string>();
      for (const [path, content] of files) {
        if (scope && !scope.has(path)) continue;
        indexFiles.set(path, content);
      }
      const index = createWorkspaceIndex(indexFiles, context.config);

      // The baseline is applied by matching (code, path) pairs, so the count of
      // what it covers needs the un-suppressed set too: compute both, report the
      // reported set, and say how many the baseline took.
      const all = validateWorkspace(index);
      const baseline = loadBaseline(context.root);
      const reported = baseline ? validateWorkspace(index, { baseline }) : all;
      const suppressed = baseline ? all.length - reported.length : 0;

      return asJson({
        root: context.root,
        files: index.size,
        baseline: baseline ? { applied: true, suppressed } : null,
        diagnostics: reported.map((d) => toToolDiagnostic(d, d.path)),
        configDiagnostics: context.configDiagnostics,
      });
    },
  );
}

/**
 * `get_schema(version?)` — the front matter contract, so a model can generate
 * metadata against the version the repository expects instead of a remembered one.
 *
 * `version` is validated: v1 is the only version, and asking for another is an
 * error rather than a silent fallback to whatever happens to be on disk.
 */
function registerGetSchema(server: McpServer): void {
  server.registerTool(
    'get_schema',
    {
      title: 'Read the metadata JSON Schema',
      description:
        'Return schemas/mdlineage-v1.schema.json, the front matter metadata contract. Use before generating or editing mdlineage front matter so the produced metadata validates.',
      inputSchema: {
        version: z.number().int().positive().optional().describe('Schema version to return. Only 1 is supported; omitting it also returns v1.'),
      },
      annotations: { readOnlyHint: true },
    },
    ({ version }) => {
      if (version !== undefined && version !== 1) {
        return asJson({
          error: `Unsupported metadata schema version: ${version}. Only version 1 is supported.`,
          supported: [1],
        });
      }
      return asJson({ version: 1, $id: SCHEMA_V1_ID, schema: readSchemaObject(SCHEMA_V1) });
    },
  );
}

/**
 * `list_document_ids(query?, kind?, status?)` — the identity index, which is
 * what a model needs to name a target correctly (a relation target is an id,
 * never a path).
 *
 * `kind` and `status` are read from each entry's front matter directly, since
 * the index keeps ids and relations but not the fields the schema's vocabulary
 * constrains; a document that fails to parse simply has none to report.
 */
function registerListDocumentIds(server: McpServer, context: McpServerContext): void {
  server.registerTool(
    'list_document_ids',
    {
      title: 'List document identities',
      description:
        'List the documents the workspace index knows, with their ids, kinds and statuses. A relation target is a document ID, not a path; use this to find the id to write. Filters narrow the result; a substring `query` matches id, path and kind.',
      inputSchema: {
        query: z.string().min(1).optional().describe('Substring to match against id, path or kind (case-insensitive).'),
        kind: z.string().min(1).optional().describe('Only documents of this kind.'),
        status: z.string().min(1).optional().describe('Only documents with this status.'),
      },
      annotations: { readOnlyHint: true },
    },
    ({ query, kind, status }) => {
      const files = scanWorkspaceFiles(context.root, context.config);
      const index = createWorkspaceIndex(files, context.config);
      const needle = query?.toLowerCase();
      const out: Array<{ id: string; path: string; kind: string | null; status: string | null }> = [];
      for (const path of index.paths()) {
        const entry = index.entryOf(path);
        if (!entry) continue;
        const metadata = entryMetadata(entry, files.get(path) ?? '', context.config);
        if (kind && metadata.kind !== kind) continue;
        if (status && metadata.status !== status) continue;
        if (needle) {
          const haystack = [entry.id ?? '', path, metadata.kind ?? ''].join(' ').toLowerCase();
          if (!haystack.includes(needle)) continue;
        }
        out.push({ id: entry.id ?? '', path, kind: metadata.kind, status: metadata.status });
      }
      out.sort((a, b) => a.id.localeCompare(b.id) || a.path.localeCompare(b.path));
      return asJson({ count: out.length, documents: out });
    },
  );
}

/**
 * `resolve_relation_target(id)` — id → path, with the ambiguous and unknown
 * cases reported as such instead of guessed.
 *
 * MDL303 (ambiguous target) stays unreachable while MDL301 holds, so a
 * multi-hit result here means a duplicate id the repository has not fixed yet;
 * the tool says exactly that rather than picking the first.
 */
function registerResolveRelationTarget(server: McpServer, context: McpServerContext): void {
  server.registerTool(
    'resolve_relation_target',
    {
      title: 'Resolve a relation target',
      description:
        'Resolve a document id to the file path(s) that claim it. Returns every claimant (a duplicate id is reported as multiple hits), and a target no document claims is reported as zero hits. Use before writing a relation target.',
      inputSchema: {
        id: z.string().min(1).describe('The document id to resolve (a relation target is an id, not a path).'),
      },
      annotations: { readOnlyHint: true },
    },
    ({ id }) => {
      const files = scanWorkspaceFiles(context.root, context.config);
      const index = createWorkspaceIndex(files, context.config);
      const paths = index.idToPaths(id);
      return asJson({
        id,
        hits: paths.length,
        paths,
        referrers: index.referrersOf(id),
        resolution: paths.length === 1 ? 'unique' : paths.length === 0 ? 'unresolved' : 'ambiguous',
      });
    },
  );
}

/**
 * `suggest_metadata(path, content?)` — the proposal half of the accept loop.
 *
 * The model gets back proposals, never diagnostics and never a write. Each
 * operation names the JSON Pointer the corresponding diagnostic carries, so a
 * caller that has a diagnostic and a caller that has a proposal are looking at
 * the same address.
 */
function registerSuggestMetadata(server: McpServer, context: McpServerContext, queue: ProposalQueue): void {
  server.registerTool(
    'suggest_metadata',
    {
      title: 'Propose metadata completions',
      description:
        'Analyse a document and propose metadata to fill its gaps: missing required fields (schema, id, kind, status) and missing relation reasons on strong types. Returns PROPOSALS, not diagnostics: nothing is written. Call apply_metadata_patch with a returned proposal id to produce the reviewable edits and diff.',
      inputSchema: {
        path: z.string().min(1).describe('Path to the document, relative to the workspace root or absolute.'),
        content: z.string().optional().describe('Document text to analyse instead of reading the file. Use for unsaved buffers.'),
      },
      annotations: { readOnlyHint: true },
    },
    ({ path, content }) => {
      const read = readDocument(path, content, context.root);
      if (read.content === null) {
        return asJson({ path: read.resolvedPath, error: read.error, proposals: [] });
      }
      const result = validateDocumentSync({ path: read.resolvedPath, content: read.content, config: context.config });
      const candidate = buildProposals(result.diagnostics, {
        vocabulary: {
          kinds: context.config.vocabulary.kinds ?? [],
          statuses: context.config.vocabulary.statuses ?? [],
        },
        contentHash: hashOf(read.content),
        path: read.resolvedPath,
      });
      if (candidate.operations.length === 0) {
        return asJson({
          path: read.resolvedPath,
          proposals: [],
          diagnostics: result.diagnostics.map((d) => d.code),
          note: 'No deterministic completions available; this document needs a human or an LLM judgement for its gaps.',
        });
      }
      // The buffer snapshot travels with the proposal: apply must work on the
      // exact text suggest_metadata analysed, even when it never hit the disk.
      const proposal = queue.enqueue(candidate, read.content);
      return asJson({
        path: read.resolvedPath,
        proposals: [proposal],
        diagnostics: result.diagnostics.map((d) => d.code),
      });
    },
  );
}

/**
 * `apply_metadata_patch(proposal_id)` — the accept action, and the only thing
 * in this server that produces edits.
 *
 * The tool applies the proposal IN MEMORY and returns the TextEdits, the
 * resulting text and a unified diff. It never opens the file for writing: the
 * §12 boundary is that accepting produces a reviewable artifact, and writing
 * is a separate, deliberate step the caller takes (an editor applies the edits,
 * or the caller writes the returned text once a human has approved the diff).
 */
function registerApplyMetadataPatch(server: McpServer, context: McpServerContext, queue: ProposalQueue): void {
  server.registerTool(
    'apply_metadata_patch',
    {
      title: 'Accept a metadata proposal',
      description:
        'Apply a queued proposal by id, IN MEMORY ONLY. Returns Front Matter TextEdits, the resulting document text and a unified diff for review. This tool NEVER writes to disk: apply the returned edits in an editor, or write the returned text, after a human has reviewed the diff.',
      inputSchema: {
        proposal_id: z.string().min(1).describe('The id returned by suggest_metadata.'),
      },
      annotations: { readOnlyHint: true },
    },
    ({ proposal_id }) => {
      const proposal = queue.accept(proposal_id);
      if (!proposal) {
        return asJson({
          proposalId: proposal_id,
          applied: false,
          error:
            `No queued proposal with id '${proposal_id}'. Call suggest_metadata first; the queue lives in memory ` +
            'and does not survive a server restart.',
        });
      }

      // Prefer the buffer snapshot the proposal was built from; the disk is
      // only a fallback for proposals whose source reached the filesystem.
      const sourceText = (proposal as { sourceContent?: string }).sourceContent;
      const read = readDocument(proposal.path, sourceText, context.root);
      if (read.content === null) {
        queue.enqueue(proposal);
        return asJson({ proposalId: proposal_id, applied: false, error: read.error });
      }

      const applied = applyProposalToContent(proposal, read.content);
      if (!applied || applied.edits.length === 0) {
        return asJson({
          proposalId: proposal_id,
          applied: false,
          error:
            'The proposal named no location this document has, or the document has no mdlineage front matter block ' +
            'to insert into (adding one is MDL003’s fix, a human or LLM decision).',
        });
      }

      return asJson({
        proposalId: proposal_id,
        applied: true,
        path: proposal.path,
        diskPath: read.diskPath,
        edits: applied.edits,
        diff: diffOf(read.content, applied.patched),
        patchedContent: applied.patched,
        note: 'Nothing was written. Apply the edits in an editor, or write `patchedContent`, after reviewing `diff`.',
      });
    },
  );
}

/** The two schemas as read-only resources, so a client can read them by URI. */
function registerSchemaResources(server: McpServer): void {
  server.registerResource(
    'mdlineage-v1-schema',
    RESOURCE_URIS.v1,
    {
      title: 'MDLineage metadata schema v1',
      description: 'schemas/mdlineage-v1.schema.json: the front matter metadata contract (read-only).',
      mimeType: 'application/schema+json',
    },
    (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'application/schema+json', text: readSchema(SCHEMA_V1) }],
    }),
  );

  server.registerResource(
    'mdlineage-config-schema',
    RESOURCE_URIS.config,
    {
      title: 'MDLineage configuration schema',
      description: 'schemas/mdlineage-config.schema.json: the mdlineage.config.yaml contract (read-only).',
      mimeType: 'application/schema+json',
    },
    (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'application/schema+json', text: readSchema(SCHEMA_CONFIG) }],
    }),
  );
}

/**
 * The mdlineage metadata of an index entry, read from the document's own front
 * matter. The index keeps ids and relations but not the vocabulary-constrained
 * scalars, so they are read here through the same parsers the validator uses —
 * a `kind` reported here is a `kind` the schema layer validated. Fields a
 * document cannot supply (broken YAML, or no mdlineage block at all) are null,
 * which is what the listing should say rather than an invented value.
 */
function entryMetadata(
  entry: { lineMap: LineMap; rawStart: number },
  content: string,
  config: Config,
): { kind: string | null; status: string | null } {
  const boundary = scanBoundary(content);
  if (!boundary) return { kind: null, status: null };
  const parsed = parseFrontmatter(boundary.raw, boundary.rawStart, entry.lineMap);
  if (!parsed.parsed || !parsed.parsed.data) return { kind: null, status: null };
  const value = parsed.parsed.data[config.metadata.key];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { kind: null, status: null };
  const metadata = value as Record<string, unknown>;
  return {
    kind: typeof metadata['kind'] === 'string' ? (metadata['kind'] as string) : null,
    status: typeof metadata['status'] === 'string' ? (metadata['status'] as string) : null,
  };
}

import { scanBoundary, parseFrontmatter } from '@mdlineage/validator';

/**
 * Read the Markdown files under `root` that the config says to include.
 *
 * The prefix form mirrors the language server's scanner: the config schema
 * allows plain directory names, and a glob engine is not this package's
 * dependency to add at startup.
 */
function scanWorkspaceFiles(root: string, config: Config): Map<DocPath, string> {
  const files = new Map<DocPath, string>();
  const exclude = Array.isArray(config.files.exclude) ? config.files.exclude : [];
  const queue: string[] = [resolve(root)];

  while (queue.length > 0) {
    const dir = queue.pop() as string;
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (isExcludedDir(path, root, exclude)) continue;
        queue.push(path);
        continue;
      }
      if (!path.toLowerCase().endsWith('.md')) continue;
      const rel = relative(root, path).split(sep).join('/');
      if (rel === '' || rel.startsWith('..')) continue;
      let text: string;
      try {
        text = readFileSync(path, 'utf8');
      } catch {
        continue;
      }
      files.set(rel, text);
    }
  }

  return files;
}

/** A directory the config or the defaults say to walk past (same rule as the LSP). */
function isExcludedDir(path: string, root: string, exclude: readonly string[]): boolean {
  const normalized = relative(root, path).split(sep).join('/');
  for (const pattern of DEFAULT_EXCLUDES) {
    if (normalized === pattern) return true;
  }
  for (const pattern of exclude) {
    const trimmed = pattern.replace(/^\.?\//, '').replace(/\/$/, '');
    if (trimmed.length === 0) continue;
    if (normalized === trimmed) return true;
    // A `**/prefix` or trailing-`/**` shape reduces to the directory name.
    if (pattern.startsWith('**/') && normalized === trimmed) return true;
    if (pattern.endsWith('/**') && normalized === pattern.slice(0, -3)) return true;
  }
  return false;
}

const DEFAULT_EXCLUDES = ['node_modules', 'dist', 'vendor'] as const;

/**
 * A committed baseline, when the root has one. Read-only: the tool reports the
 * debt the repository accepted, it never writes a baseline.
 */
function loadBaseline(root: string): Baseline | null {
  const path = resolve(root, '.mdlineage-baseline.json');
  try {
    const text = readFileSync(path, 'utf8');
    return parseBaseline(text).baseline;
  } catch {
    return null;
  }
}

let cachedSchemaDir: string | null = null;

/** The directory holding schemas/, found once from this module's location. */
function schemaDir(): string {
  if (cachedSchemaDir) return cachedSchemaDir;
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/ in this package -> repo root is three levels up (dist, package, repo).
  const candidates = [resolve(here, '..', '..', '..', 'schemas'), resolve(here, '..', 'schemas')];
  for (const candidate of candidates) {
    try {
      statSync(resolve(candidate, SCHEMA_V1));
      cachedSchemaDir = candidate;
      return candidate;
    } catch {
      // try the next candidate
    }
  }
  cachedSchemaDir = candidates[0]!;
  return cachedSchemaDir;
}

/** The schema's own `$id`, so a caller can pin the version it validated against. */
const SCHEMA_V1_ID = 'https://mdlineage.dev/schemas/mdlineage-v1.schema.json';

/** A schema file parsed, resolved from the checked-in copy regardless of CWD. */
function readSchemaObject(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(schemaDir(), name), 'utf8')) as Record<string, unknown>;
}

/** A schema file's text, pretty-printed, for the resource reads. */
function readSchema(name: string): string {
  return JSON.stringify(readSchemaObject(name), null, 2);
}
