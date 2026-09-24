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
 *     TextEdits plus a reviewable diff. By default it writes nothing: writing
 *     is the caller's step, after a human has read the diff, which is the
 *     "LLM 永远没有直接写 Front Matter 的通道" boundary §12 draws. `write:
 *     true` is the explicit opt-in that lets the accept loop finish here
 *     (§16 M4) without a second tool, and it is guarded so the file it touches
 *     is the one the returned diff describes.
 */

import { createHash, randomBytes } from 'node:crypto';
import {
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  realpathSync,
  lstatSync,
  accessSync,
  openSync,
  closeSync,
  constants,
} from 'node:fs';
import { resolve, isAbsolute, relative, sep, dirname, join, basename } from 'node:path';
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
  type AcceptedProposal,
  type MetadataProposal,
} from './proposals.js';

export { resetProposalIds, ProposalQueue, buildProposals, applyProposalToContent, diffOf };

const SERVER_NAME = 'mdlineage';
// Resolved relative to this file: dist/ sits beside ../package.json in the repo and the tarball.
const SERVER_VERSION = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
).version;

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
        'followed by apply_metadata_patch to fill missing metadata — apply returns a diff and writes nothing ' +
        'unless it is called with write: true, which overwrites the document on disk with the reviewed text. ' +
        'A proposal over a document that was never saved writes that document into existence; one over a document ' +
        'that has since been deleted or renamed is refused instead.',
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

/**
 * Resolve the real path a write would land on, and refuse one that escapes the
 * workspace root.
 *
 * A `path.relative` containment test on the spelling the caller gave is a
 * string prefix test, and a symlink inside the root makes it lie:
 * `root/link/doc.md` compares as inside the root while `link` points anywhere
 * at all. The whole parent chain is therefore resolved with `realpath` before
 * the containment test, and the root is resolved too — a workspace whose root
 * is itself a symlink is a legitimate setup, and a write that lands inside the
 * real root is the correct behaviour, not a rejection.
 *
 * A trailing symlink is followed when it stays inside the real root, and the
 * returned `writePath` is the file it names: writing through the link instead
 * would let the rename replace the link with a regular file, destroying the
 * alias. One that resolves outside the root is refused.
 */
function resolveWriteTarget(
  diskPath: string,
  root: string,
): { ok: true; writePath: string } | { ok: false; error: string } {
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    return { ok: false, error: `the workspace root ${root} cannot be resolved on disk` };
  }

  let realParent: string;
  try {
    realParent = realpathSync(dirname(diskPath));
  } catch {
    return { ok: false, error: `cannot resolve the real path of ${dirname(diskPath)}` };
  }

  const rel = relative(realRoot, realParent);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return {
      ok: false,
      error:
        `Refusing to write outside the workspace root: ${diskPath} resolves to ` +
        `${join(realParent, basename(diskPath))}, which is not inside ${realRoot}.`,
    };
  }

  let isLink = false;
  try {
    isLink = lstatSync(diskPath).isSymbolicLink();
  } catch {
    // Nothing there: a proposal over an unsaved buffer may still create it.
  }
  if (isLink) {
    let realTarget: string;
    try {
      realTarget = realpathSync(diskPath);
    } catch {
      return {
        ok: false,
        error: `Refusing to write through a symbolic link: ${diskPath} is a symlink whose target cannot be resolved.`,
      };
    }
    const targetRel = relative(realRoot, realTarget);
    if (targetRel === '..' || targetRel.startsWith(`..${sep}`) || isAbsolute(targetRel)) {
      return {
        ok: false,
        error:
          `Refusing to write through a symbolic link: ${diskPath} resolves to ${realTarget}, ` +
          `which is not inside ${realRoot}.`,
      };
    }
    // The link survives, and the reviewed text lands on the file it names.
    return { ok: true, writePath: realTarget };
  }

  return { ok: true, writePath: diskPath };
}

/** A file's text, or null when it cannot be read (missing, a directory, …). */
function readDiskText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** True when `path` names a regular file that exists on disk right now. */
function documentIsOnDisk(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Write `text` to `path` through a sibling temporary file and a rename.
 *
 * The rename is what makes the write atomic on one filesystem: a reader sees
 * the old file or the new one, never a truncated one, and a failure before the
 * rename leaves the original untouched. The temporary file is removed when it
 * was created but could not be renamed, so a refused write leaves no litter.
 *
 * `expected` is the text the target held when the guards ran, or null when it
 * was absent. It is re-checked immediately before the rename, which narrows
 * the window a racing process had to turn the target into a symlink (the
 * rename would replace the link itself) or to change its content.
 *
 * Exported for the test suite: the guards around it live in the tool handler,
 * and a test that drives the write directly is the only way to show what a
 * target flipped mid-write costs.
 */
export function writeDocumentAtomically(
  path: string,
  text: string,
  expected: string | null,
): { ok: true } | { ok: false; error: string } {
  const present = statSync(path, { throwIfNoEntry: false }) !== undefined;
  // `rename` checks the DIRECTORY's permissions, not the target file's, so a
  // file its owner marked read-only would be replaced with no error at all.
  // The target's own writability is checked first, and a refusal here has not
  // touched a single byte. A target that is not there yet needs the directory
  // to be writable instead.
  if (present ? !pathIsWritable(path) : !pathIsWritable(dirname(path))) {
    return {
      ok: false,
      error: present
        ? `cannot write ${path}: the file is not writable`
        : `cannot create ${path}: the directory ${dirname(path)} is not writable`,
    };
  }

  const temporary = `${path}.mdlineage-${process.pid}-${randomBytes(8).toString('hex')}.tmp`;
  let mode: number | null = null;
  try {
    mode = statSync(path).mode & 0o777;
  } catch {
    // Nothing there yet: the process umask decides the new file's mode.
  }
  let created = false;
  const discardTemporary = (): void => {
    if (!created) return;
    try {
      rmSync(temporary, { force: true });
    } catch {
      // The temporary file may never have been created; nothing to clean up.
    }
  };
  try {
    // `wx` creates the temporary exclusively: a predictable name would let
    // another process pre-create it, or let a stale one survive a restart.
    const descriptor = openSync(temporary, 'wx', mode ?? 0o666);
    created = true;
    writeFileSync(descriptor, text);
    closeSync(descriptor);
    const verified = verifyWriteTarget(path, expected);
    if (!verified.ok) {
      // A refusal from the re-check is a refusal like any other: the
      // temporary goes before the answer does, so no litter survives it.
      discardTemporary();
      return { ok: false, error: `cannot write ${path}: ${verified.error}` };
    }
    renameSync(temporary, path);
    return { ok: true };
  } catch (error) {
    discardTemporary();
    return { ok: false, error: `cannot write ${path}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * Re-check the target's state immediately before the rename.
 *
 * The guards in the tool ran earlier, and in that window a racing process
 * could have replaced the target with a symbolic link — which the rename would
 * overwrite with a regular file, destroying the link — or edited or removed
 * the file, in which case the write would replace text the reviewed diff does
 * not show. Re-reading narrows that window; it cannot close it, because a
 * genuinely atomic swap needs `renameat2(RENAME_EXCHANGE)` or `linkat`, which
 * Node does not expose.
 */
export function verifyWriteTarget(
  path: string,
  expected: string | null,
): { ok: true } | { ok: false; error: string } {
  let isLink = false;
  try {
    isLink = lstatSync(path).isSymbolicLink();
  } catch {
    // Absent, which is only correct when it was absent before too.
  }
  if (isLink) {
    return { ok: false, error: 'the target became a symbolic link while the write was being prepared' };
  }
  const now = readDiskText(path);
  if (now !== expected) {
    return {
      ok: false,
      error: 'the target changed on disk (removed, replaced or edited) while the write was being prepared',
    };
  }
  return { ok: true };
}

/**
 * True when this process may write to `path` — a file or a directory.
 *
 * `access(W_OK)` is the real check, except that root passes it for any path:
 * there the permission bits are the only signal left that the owner meant the
 * file to stay read-only, so they are read directly.
 */
function pathIsWritable(path: string): boolean {
  try {
    accessSync(path, constants.W_OK);
  } catch {
    return false;
  }
  if (process.getuid?.() === 0) {
    try {
      return (statSync(path).mode & 0o200) !== 0;
    } catch {
      return false;
    }
  }
  return true;
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
        'Analyse a document and propose metadata to fill its gaps: missing required fields (schema, id, kind, status) and missing relation reasons on strong types. Returns PROPOSALS, not diagnostics: nothing is written. Call apply_metadata_patch with a returned proposal id to produce the reviewable edits and diff, and pass `write: true` there to have the reviewed text written to the document.',
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
      // Whether that text had a file behind it is recorded too, because it is
      // what separates a never-saved buffer (which `write: true` may create)
      // from a document that has since been deleted or renamed (which it must
      // not resurrect).
      const proposal = queue.enqueue(candidate, read.content, documentIsOnDisk(read.diskPath));
      return asJson({
        path: read.resolvedPath,
        proposals: [proposal],
        diagnostics: result.diagnostics.map((d) => d.code),
      });
    },
  );
}

/**
 * `apply_metadata_patch(proposal_id, write?)` — the accept action, and the only
 * thing in this server that produces edits.
 *
 * The default is IN MEMORY: the proposal is applied to the text it was derived
 * from, and the TextEdits, the resulting text and a unified diff come back for
 * a human to review. Nothing is opened for writing — the §12 boundary is that
 * accepting produces a reviewable artifact, and writing is a separate,
 * deliberate step the caller takes (an editor applies the edits, or the caller
 * writes the returned text once a human has approved the diff).
 *
 * `write: true` is the explicit opt-in that closes §16 M4's acceptance loop
 * here instead of in a second tool. It writes the reviewed `patchedContent` —
 * the very text the returned diff describes, never a second computation —
 * after the guards below: the target must resolve inside the workspace root,
 * the file must still hold the text the diff was computed against, and the
 * target (or the directory that would hold it) must be writable. A proposal
 * over a document that was on disk and has since been deleted or renamed is
 * refused rather than resurrected; a proposal over a buffer that was never
 * saved creates the document, which is the unsaved-buffer case the decision
 * log requires to stay writable. Every refusal is a structured error that
 * leaves the file untouched, requeues the proposal and reports the new id as
 * `requeuedProposalId` — null when the id named no queued proposal, because
 * then there is nothing to put back.
 */
function registerApplyMetadataPatch(server: McpServer, context: McpServerContext, queue: ProposalQueue): void {
  server.registerTool(
    'apply_metadata_patch',
    {
      title: 'Accept a metadata proposal',
      description:
        'Apply a queued proposal by id. Returns Front Matter TextEdits, the resulting document text and a unified diff for review. ' +
        'By default nothing is written. The edits\' offsets target the ORIGINAL text: apply them from the highest offset downward (never top-to-bottom on the shifting text), or simply write the returned `patchedContent`, after a human has reviewed the diff. ' +
        'Pass `write: true` to OVERWRITE the document on disk with the reviewed `patchedContent` — the write replaces the target file\'s current ' +
        'content and is not reversible from here. The write is refused, with the file untouched and the proposal requeued ' +
        '(`requeuedProposalId`, which is null when the id named no queued proposal and so nothing could be requeued), ' +
        'when the target resolves outside the workspace root (a symbolic link that leaves the root included), when the proposal was made over a ' +
        'document that was on disk and that document has since been deleted or renamed, when the target or the directory that would hold it is ' +
        'not writable, or when the file no longer holds the text the diff was computed against. A proposal made over an unsaved buffer that was ' +
        'never on disk creates the document at its path, and a symbolic link that stays inside the root is followed: the reviewed text lands on ' +
        'the file the link names, and the link itself survives.',
      inputSchema: {
        proposal_id: z.string().min(1).describe('The id returned by suggest_metadata.'),
        write: z
          .boolean()
          .optional()
          .describe(
            'Write the reviewed `patchedContent` to the document on disk, overwriting its current content. Defaults to false: nothing is written, and only the edits, diff and patched text are returned. When the proposal came from a buffer that was never on disk, the write creates the document at its path; when it came from a document that has since been deleted or renamed, the write is refused.',
          ),
      },
      // No readOnlyHint: `write: true` modifies a file, and a client told
      // "read-only" would skip the approval this tool can require. The write
      // replaces the target file's content, which is not reversible from here,
      // so the destructive hint is the schema's default rather than a denial.
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    ({ proposal_id, write }) => {
      const proposal = queue.accept(proposal_id);
      if (!proposal) {
        return asJson({
          proposalId: proposal_id,
          applied: false,
          written: false,
          // Nothing to put back: the id named no proposal, so there is no
          // requeued entry to report. Every other refusal requeues.
          requeuedProposalId: null,
          error:
            `No queued proposal with id '${proposal_id}'. Call suggest_metadata first; the queue lives in memory ` +
            'and does not survive a server restart.',
        });
      }

      // Prefer the buffer snapshot the proposal was built from; the disk is
      // only a fallback for proposals whose source reached the filesystem.
      const sourceText = proposal.sourceContent;
      const read = readDocument(proposal.path, sourceText, context.root);
      if (read.content === null) {
        return asJson({
          proposalId: proposal_id,
          applied: false,
          written: false,
          requeuedProposalId: requeue(queue, proposal).id,
          error: read.error,
        });
      }

      const applied = applyProposalToContent(proposal, read.content);
      if (!applied || applied.edits.length === 0) {
        return asJson({
          proposalId: proposal_id,
          applied: false,
          written: false,
          requeuedProposalId: requeue(queue, proposal).id,
          error:
            'The proposal named no location this document has, or the document has no mdlineage front matter block ' +
            'to insert into (adding one is MDL003’s fix, a human or LLM decision).',
        });
      }

      const answer = {
        proposalId: proposal_id,
        applied: true,
        path: proposal.path,
        diskPath: read.diskPath,
        edits: applied.edits,
        diff: diffOf(read.content, applied.patched),
        patchedContent: applied.patched,
      };

      if (!write) {
        return asJson({
          ...answer,
          written: false,
          note: 'Nothing was written. The edits\' offsets target the original text: apply them from the highest offset downward, or write `patchedContent`, after reviewing `diff`.',
        });
      }

      // Guard 1: the write never leaves the workspace root, whatever spelling
      // the proposal's path arrived in — and a symlink inside the root cannot
      // make a path that points outside compare as inside it.
      const target = resolveWriteTarget(read.diskPath, context.root);
      if (!target.ok) {
        return asJson({
          ...answer,
          applied: false,
          written: false,
          requeuedProposalId: requeue(queue, proposal).id,
          error: target.error,
        });
      }

      // Guard 1b: what the target's absence means. A proposal over a document
      // that was on disk when it was made and has since gone away is a
      // deletion or a rename: writing would resurrect text the user removed,
      // so it is refused. A proposal over a buffer that never reached the disk
      // is the unsaved-buffer case, and `write: true` creates the document —
      // the guards above already put it inside the root, with a writable
      // parent and no symlink at the path.
      const existed = documentIsOnDisk(target.writePath);
      if (!existed && proposal.sourceOnDisk) {
        return asJson({
          ...answer,
          applied: false,
          written: false,
          requeuedProposalId: requeue(queue, proposal).id,
          error:
            `The document ${read.diskPath} no longer exists on disk, so writing would recreate a file the user ` +
            'deleted or renamed. Call suggest_metadata on the document as it is now.',
        });
      }

      // Guard 2: the patch must describe the text the proposal was derived
      // from, and the file must still hold the text the diff was computed
      // against — otherwise the write would replace content the diff, which
      // the human reviewed, never showed.
      const onDisk = readDiskText(target.writePath);
      if (
        hashOf(read.content) !== proposal.contentHash ||
        (onDisk !== null && hashOf(onDisk) !== hashOf(read.content))
      ) {
        return asJson({
          ...answer,
          applied: false,
          written: false,
          requeuedProposalId: requeue(queue, proposal).id,
          error:
            'The document changed since the proposal was made (its content no longer matches the proposal hash), ' +
            'so writing now would replace text the reviewed diff does not show. Call suggest_metadata again.',
        });
      }

      const written = writeDocumentAtomically(target.writePath, applied.patched, onDisk);
      if (!written.ok) {
        return asJson({
          ...answer,
          applied: false,
          written: false,
          requeuedProposalId: requeue(queue, proposal).id,
          error: written.error,
        });
      }

      const notes = [
        `The reviewed \`patchedContent\` was written to ${target.writePath}.`,
        target.writePath === read.diskPath
          ? null
          : `${read.diskPath} is a symbolic link, so the text landed on the file it names and the link survived.`,
        existed
          ? null
          : 'The document was not on disk: the proposal came from an unsaved buffer, so this write created it.',
        'Run validate_document on it to confirm the gaps the proposal addressed are closed.',
      ].filter((line): line is string => line !== null);
      return asJson({
        ...answer,
        written: true,
        writtenPath: target.writePath,
        created: !existed,
        note: notes.join(' '),
      });
    },
  );
}

/**
 * Put a proposal back after a refused or failed accept, and return the entry
 * with its new id.
 *
 * A refusal is a review state, not a lost proposal: the caller keeps the
 * diff and can retry against the requeued id. The id changes because the queue
 * keys on a monotonic sequence, and the requeued answer says so.
 */
function requeue(queue: ProposalQueue, proposal: AcceptedProposal): MetadataProposal {
  const { sourceContent, sourceOnDisk, ...rest } = proposal;
  return queue.enqueue(rest, sourceContent, sourceOnDisk);
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
