/**
 * `mdlineage fix [paths...]`: safe automatic repairs (§10.1, §9.1).
 *
 * Safe means no judgement: insert a missing field from the vocabulary,
 * normalize an enum value that matches exactly one vocabulary member, drop a
 * relation that duplicates another one byte-for-byte within the document, and
 * normalize line endings to the configured policy (§4.2). Everything §9.2
 * reserves for a reviewer — ids, relation targets and types, new relations —
 * is never touched here.
 *
 * The default run is a dry run: fixes are printed, nothing is written.
 * `--write` persists atomically (temp file + rename in the same directory).
 * The patch engine is the MCP server's, so a CRLF document keeps CRLF on every
 * line a fix joins; the line-ending pass uses the config's `eolPolicy`.
 *
 * Exit codes: 0 when the batch completed (dry run or written), 1 when a file
 * could not be read or written, a path tried to leave the workspace, the
 * config could not be loaded, or a patch left the front matter unparseable,
 * and 2 on a usage error (handled by the argument parser).
 */

import { readFileSync, writeFileSync, renameSync, statSync, accessSync, constants as fsConstants, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { cwd as processCwd } from 'node:process';
import { randomBytes } from 'node:crypto';
import {
  loadConfig,
  scanLineEndings,
  validateDocumentSync,
  scanBoundary,
  parseFrontmatter,
  buildLineMap,
} from '@mdlineage/validator';
import { buildProposals, applyProposalToContent, diffOf, type MetadataProposal } from '@mdlineage/mcp-server';
import { expandMarkdownPaths } from './paths.js';
import { createHash } from 'node:crypto';

interface FixValues {
  config?: string;
  write?: boolean;
  exclude?: readonly string[];
}

interface PlannedFix {
  /** file:line the fix is anchored at (1-based line, 0 when not line-bound). */
  readonly at: string;
  /** Short machine-readable label of what kind of repair this is. */
  readonly code: string;
  /** One-line human explanation, shown in the dry-run report. */
  readonly detail: string;
}

/** `mdlineage fix [paths...]`: plan, report, and — with --write — apply. */
export function runFix(args: string[], values: FixValues): number {
  const cwd = processCwd();
  const root = resolve(cwd);

  // Refuse anything that escapes the workspace before any expansion happens.
  const rejected = args.filter((p) => !isInside(root, resolve(cwd, p)));
  for (const p of rejected) {
    process.stderr.write(`mdlineage: refusing path outside the workspace: ${p}\n`);
  }

  const paths = args.filter((p) => isInside(root, resolve(cwd, p)));
  const { files, missed, excluded } = expandMarkdownPaths(paths.length === 0 ? ['.'] : paths, cwd, {
    exclude: values.exclude,
  });
  if (missed.length > 0) {
    for (const path of missed) process.stderr.write(`mdlineage: no such file or pattern: ${path}\n`);
    return 2;
  }
  for (const path of excluded) {
    process.stderr.write(
      `mdlineage: ${path} matches the default exclude list (node_modules, dist); no files were fixed\n`,
    );
  }
  if (rejected.length > 0) return 1;

  const loaded = loadConfig(values.config, values.config ? undefined : cwd);
  // A config the run could not use is reported the way `check` reports it and
  // fails the run: a typo in --config must not read as a clean pass.
  for (const diag of loaded.diagnostics) {
    process.stderr.write(`mdlineage: ${diag.code} ${diag.severity} ${diag.message}\n`);
  }
  const configFailed = loaded.diagnostics.some((d) => d.severity === 'error');
  const write = values.write === true;

  let fixed = 0;
  let written = 0;
  let failed = 0;
  let readonly_ = 0;

  for (const file of files) {
    let content: string;
    try {
      content = readFileSync(file.path, 'utf8');
    } catch (error) {
      process.stderr.write(
        `mdlineage: cannot read ${file.asGiven}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      failed += 1;
      continue;
    }

    const planned = planFixes(content, file.asGiven, loaded.config);
    if (planned === null) {
      // A safe repair that leaves the front matter unparseable is a bug in the
      // pass, not a property of the document: writing it would corrupt the file.
      process.stderr.write(
        `mdlineage: cannot apply fixes to ${file.asGiven}: the patched front matter no longer parses as YAML\n`,
      );
      failed += 1;
      continue;
    }
    const { fixed: patched, fixes } = planned;
    if (fixes.length === 0) continue;
    fixed += fixes.length;
    for (const fix of fixes) process.stdout.write(`${file.asGiven}:${fix.at}: [${fix.code}] ${fix.detail}\n`);
    for (const line of diffOf(content, patched).split('\n')) {
      if (line.length > 0) process.stdout.write(`  ${line}\n`);
    }

    if (!write) continue;

    try {
      accessSync(file.path, fsConstants.W_OK);
    } catch {
      process.stderr.write(`mdlineage: skipping read-only file: ${file.asGiven}\n`);
      readonly_ += 1;
      continue;
    }
    try {
      writeFileAtomic(file.path, patched);
      written += 1;
    } catch (error) {
      process.stderr.write(
        `mdlineage: cannot write ${file.asGiven}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      failed += 1;
    }
  }

  const summary = write
    ? `mdlineage fix: ${fixed} fix${fixed === 1 ? '' : 'es'} in ${written} file${written === 1 ? '' : 's'}` +
      (readonly_ > 0 ? `; ${readonly_} read-only file${readonly_ === 1 ? '' : 's'} skipped` : '')
    : `mdlineage fix: would fix ${fixed} issue${fixed === 1 ? '' : 's'} in ${files.length} file${files.length === 1 ? '' : 's'} (dry run; use --write to apply)`;
  process.stdout.write(`${summary}\n`);
  return failed > 0 || configFailed ? 1 : 0;
}

/** True when `candidate` is `root` or lives under it. */
function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Plan every safe fix for one document. Returns the patched text and the report. */
function planFixes(
  content: string,
  path: string,
  config: ReturnType<typeof loadConfig>['config'],
): { fixed: string; fixes: PlannedFix[] } | null {
  const fixes: PlannedFix[] = [];
  let text = content;

  // Metadata insertions come from the MCP proposal engine, keyed off the same
  // diagnostics the validator emits.
  const loaded = validateDocumentSync({ path, content: text, config });
  const candidate = buildProposals(loaded.diagnostics, {
    vocabulary: {
      kinds: config.vocabulary.kinds ?? [],
      statuses: config.vocabulary.statuses ?? [],
    },
    contentHash: createHash('sha256').update(text, 'utf8').digest('hex'),
    path,
  });
  if (candidate.operations.length > 0) {
    const proposal: MetadataProposal = { ...candidate, id: 'fix', createdAt: '' };
    const applied = applyProposalToContent(proposal, text);
    if (applied) {
      for (let i = 0; i < applied.edits.length; i++) {
        // Only the operations the engine actually placed are reported: a key
        // the document already carries is dropped, not inserted twice.
        const op = candidate.operations.find((o) => o.jsonPointer === applied.applied[i]);
        if (!op) continue;
        fixes.push({
          at: String(applied.edits[i]!.line + 1),
          code: op.jsonPointer.split('/').pop() ?? 'insert',
          detail: op.rationale,
        });
      }
      text = applied.patched;
    }
  }

  // §9.2 operations (ids, relation types/targets, new relations) are built by
  // nobody here: `buildProposals` only emits missing-field insertions, and the
  // passes below are structural, value-preserving repairs.
  text = dropDuplicateRelations(text, fixes);
  text = normalizeEnums(text, loaded.diagnostics, config, fixes, path);
  text = normalizeLineEndings(text, config.eolPolicy, fixes);

  // A safe repair must leave the document at least as parseable as it found it.
  if (frontmatterParsed(content) && !frontmatterParsed(text)) return null;
  return { fixed: text, fixes };
}

/** True when `text`'s front matter block parses as YAML (or it has no closed block). */
function frontmatterParsed(text: string): boolean {
  const boundary = scanBoundary(text);
  if (boundary === null || boundary.closeStart === null) return true;
  return parseFrontmatter(boundary.raw, boundary.rawStart, buildLineMap(text)).parsed !== null;
}

/** A line of a document with its own terminator attached. */
interface TextLine {
  text: string;
  eol: string;
}

/** Split on LF, CRLF or lone CR, keeping each line's terminator. */
function splitLines(text: string): TextLine[] {
  const out: TextLine[] = [];
  const pattern = /\r\n|\r|\n/g;
  let start = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    out.push({ text: text.slice(start, match.index), eol: match[0] });
    start = match.index + match[0].length;
  }
  if (start < text.length) out.push({ text: text.slice(start), eol: '' });
  return out;
}

/** Join lines back, terminators included. */
function joinLines(lines: readonly TextLine[]): string {
  return lines.map((line) => line.text + line.eol).join('');
}

/**
 * Remove relations that repeat an earlier one exactly (same type, target and
 * reason) inside the same document — §9.1's deduplication, which cannot pick a
 * target or change a direction because it keeps the first copy untouched.
 */
function dropDuplicateRelations(text: string, fixes: PlannedFix[]): string {
  const boundary = scanBoundary(text);
  if (!boundary) return text;
  const end = boundary.closeStart ?? text.length;
  const lines = splitLines(text.slice(0, end));
  const tail = text.slice(end);

  const relationsAt = lines.findIndex((l) => /^(\s*)relations:\s*$/.test(l.text));
  if (relationsAt < 0) return text;
  const indentOf = (l: TextLine) => (l.text.match(/^ */) ?? [''])[0]!.length;
  const baseIndent = indentOf(lines[relationsAt]!);

  // Collect entries: each `- ` line opens one, until the block's indent ends.
  const entries: { start: number; lines: number[]; key: string | null }[] = [];
  for (let i = relationsAt + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.text.trim() === '') continue;
    if (indentOf(line) <= baseIndent) break;
    if (/^\s*-\s/.test(line.text)) entries.push({ start: i, lines: [i], key: null });
    else if (entries.length > 0) entries[entries.length - 1]!.lines.push(i);
  }

  const value = (entry: { lines: number[] }, field: string): string | null => {
    for (const i of entry.lines) {
      // A sequence item's first key sits behind the `- ` marker.
      const m = new RegExp(`^\\s*-?\\s*${field}:\\s*(.*)$`).exec(lines[i]!.text);
      if (m) return m[1]!.trim().replace(/^['"]|['"]$/g, '');
    }
    return null;
  };

  const seen = new Set<string>();
  const drop = new Set<number>();
  for (const entry of entries) {
    const type = value(entry, 'type');
    const target = value(entry, 'target');
    if (type === null || target === null) continue;
    const key = `${type}\u0000${target}\u0000${value(entry, 'reason') ?? ''}`;
    if (seen.has(key)) {
      for (const i of entry.lines) drop.add(i);
      fixes.push({
        at: String(entry.start + 1),
        code: 'duplicate-relation',
        detail: `relation ${type} -> ${target} repeats an earlier relation in this document; removed the later copy`,
      });
    } else {
      seen.add(key);
    }
  }
  if (drop.size === 0) return text;

  // Preserve each surviving line's own terminator: only the dropped lines go,
  // and the join keeps the file's style exactly as it was.
  return joinLines(lines.filter((_, i) => !drop.has(i))) + tail;
}

/**
 * Normalize an enum value that is outside the vocabulary but matches exactly
 * one member case-insensitively (§9.1: "唯一匹配枚举值规范化"). Ambiguous or
 * unknown values are left to a reviewer.
 */
function normalizeEnums(
  text: string,
  diagnostics: ReadonlyArray<{ code: string; data?: unknown; message: string }>,
  config: ReturnType<typeof loadConfig>['config'],
  fixes: PlannedFix[],
  path: string,
): string {
  const boundary = scanBoundary(text);
  if (!boundary) return text;
  const end = boundary.closeStart ?? text.length;
  const lines = splitLines(text.slice(0, end));
  const tail = text.slice(end);
  let changed = false;

  const vocab: Record<string, readonly string[]> = {
    kind: config.vocabulary.kinds ?? [],
    status: config.vocabulary.statuses ?? [],
  };

  for (const diag of diagnostics) {
    if (diag.code !== 'MDL103') continue;
    // The diagnostic's `field` is the vocabulary list's name (kinds/statuses);
    // the front-matter key is its singular.
    const data = diag.data as { field?: string } | undefined;
    const field = data?.field === 'kinds' ? 'kind' : data?.field === 'statuses' ? 'status' : undefined;
    const allowed = field !== undefined ? vocab[field] : undefined;
    if (!allowed || allowed.length === 0) continue;

    const keyRe = new RegExp(`^(\\s*)(${field}):\\s*(.*)$`);
    const lineIndex = lines.findIndex((l) => keyRe.test(l.text));
    if (lineIndex < 0) continue;
    const match = keyRe.exec(lines[lineIndex]!.text)!;
    const current = match[3]!.trim().replace(/^['"]|['"]$/g, '');
    if (allowed.includes(current)) continue;
    const hits = allowed.filter((v) => v.toLowerCase() === current.toLowerCase());
    if (hits.length === 1) {
      lines[lineIndex] = { text: `${match[1]}${match[2]}: ${hits[0]}`, eol: lines[lineIndex]!.eol };
      fixes.push({
        at: String(lineIndex + 1),
        code: 'enum-normalized',
        detail: `'${field}: ${current}' normalized to the vocabulary's unique match '${hits[0]}'`,
      });
      changed = true;
      continue;
    }
    // §9.2: several members match case-insensitively, so which one the author
    // meant is a judgement call. Say so rather than passing in silence.
    if (hits.length > 1) {
      process.stderr.write(
        `mdlineage: ${path}: '${field}: ${current}' matches ${hits.length} vocabulary members ` +
          `(${hits.join(', ')}); needs a human decision, not auto-normalized\n`,
      );
    }
  }
  return changed ? joinLines(lines) + tail : text;
}

/**
 * Rewrite every line terminator to the policy's style — the whole-buffer fix
 * MDL601 (mixed) and MDL602 (off-policy) both ask for. Reported once per file.
 */
function normalizeLineEndings(
  text: string,
  policy: 'lf' | 'crlf' | 'cr',
  fixes: PlannedFix[],
): string {
  const scan = scanLineEndings(text);
  // A document with no line terminator at all (the empty file) has nothing to
  // normalize: rewriting it would report a fix that changed zero bytes.
  if (scan.style === 'none') return text;
  if (!scan.mixed && scan.style === policy) return text;
  const target = policy === 'crlf' ? '\r\n' : policy === 'cr' ? '\r' : '\n';
  const reason = scan.mixed ? 'MDL601' : 'MDL602';
  const from = scan.style.toUpperCase();
  fixes.push({
    at: '0',
    code: 'line-endings',
    detail: `line endings normalized ${from} -> ${policy.toUpperCase()} (${reason})`,
  });
  return text.replace(/\r\n|\r|\n/g, target);
}

/** Atomic write: temp file in the target's directory, then rename over it. */
function writeFileAtomic(path: string, content: string): void {
  const mode = statSync(path).mode;
  const tmp = join(dirname(path), `.${randomBytes(6).toString('hex')}.mdlineage-tmp`);
  try {
    writeFileSync(tmp, content, { encoding: 'utf8', mode });
    // rename(2) within the same directory is atomic.
    renameSync(tmp, path);
  } catch (error) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // best effort: nothing to clean up if the temp file never existed
    }
    throw error;
  }
}
