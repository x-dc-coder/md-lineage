/**
 * remark-lint rule wrapping @mdlineage/validator (docs/remark-language-server-
 * solution.md §6.3, "实时处理链").
 *
 * The rule is a plain unified attacher built with `unified-lint-rule`, so it
 * slots into any remark pipeline: the remark CLI and `.remarkrc.mjs`, the
 * remark-language-server, or a direct `unified()` call. It runs once per tree.
 *
 * The document under validation is the VFile's own value, never the disk copy:
 * this is the "unsaved buffer" channel. The host pipeline is expected to use
 * remark-frontmatter with `['yaml']`, which keeps the front matter bytes inside
 * `file.value` and exposes them as a `yaml` node in the tree; the validator
 * scans that raw buffer itself (its boundary scan and EOL scan are deliberately
 * pre-AST, per docs/remark-language-server-solution.md §4.2 and
 * docs/line-ending-management.md §4.1), so the tree is only consulted by the
 * anchor layer.
 *
 * Diagnostic → VFileMessage mapping (§9.1 capability boundary, M0 review):
 *   - `position` is a unist Position built from the validator's 1-based
 *     line/column, which is what unist/vfile use as well, so the values pass
 *     through unchanged; `offset` is carried too.
 *   - `fatal` reflects the validator's severity, restored after the rule runs:
 *     unified-lint-rule overwrites `fatal` with the rule's remark severity
 *     (this rule is registered as a plain warning, because the severity that
 *     matters is the diagnostic's own), so the validator's value is reapplied
 *     from a `transformer` that runs after it.
 *   - `code` is the MDLxxx string: `unified-language-server` builds its
 *     diagnostic code from the message's own fields, and the LSP `code` is what
 *     `docs/remark-language-server-solution.md` §14.4 pins for cross-entry
 *     consistency, so the registered code is set explicitly here.
 *   - `expected` is set only when the diagnostic names exactly one replacement
 *     string; `unified-language-server`'s `onCodeAction` consumes nothing else.
 */

import type { Root } from 'mdast';
import type { VFile } from 'vfile';
import type { VFileMessage } from 'vfile-message';
import type { Point, Position } from 'unist';
import { lintRule } from 'unified-lint-rule';
import { validateDocumentSync, loadConfig, type Config, type Diagnostic } from '@mdlineage/validator';

/**
 * Rule origin: `source:ruleId`. unified-lint-rule splits on the first colon, so
 * the messages report `source: 'mdlineage'` and `ruleId: 'mdlineage'`, which is
 * the pair `<!--lint ignore mdlineage-->` comments and the language server key
 * on. A slash here would leave both fields undefined.
 */
const ORIGIN = 'mdlineage:mdlineage';

/** Documentation anchor for every MDL code. */
const DOCS_URL = 'https://mdlineage.dev/docs/diagnostic-codes';

/**
 * Plugin options.
 *
 * `configFile` may be a path (relative to the CWD) or omitted, in which case the
 * validator's `loadConfig` walks up from the CWD looking for
 * `mdlineage.config.yaml`; absence means "use the built-in defaults".
 */
export interface RemarkLintMdlineageOptions {
  configFile?: string;
}

/** A config plus its load-time diagnostics, memoized per option value. */
interface ResolvedConfig {
  readonly config: Config;
  readonly diagnostics: Diagnostic[];
}

const configCache = new Map<string, ResolvedConfig>();

/**
 * Load (and memoize) the validator config for this process. Never throws.
 *
 * Memoization matters for the editor channel: the language server calls this
 * rule on every keystroke, and config loading is the only filesystem work it
 * would otherwise repeat. The cache is keyed on the option value so an editor
 * that points at a different config file does not see a stale one.
 */
function resolveConfig(configFile: string | undefined): ResolvedConfig {
  const key = configFile ?? '<auto>';
  const cached = configCache.get(key);
  if (cached) return cached;

  // Config failures are MDL900-style adapter-level diagnostics; they do not stop
  // document validation, which falls back to the built-in defaults.
  const result = loadConfig(configFile);
  const resolved: ResolvedConfig = {
    config: result.config,
    diagnostics: result.diagnostics.map((d) => ({
      code: d.code,
      severity: d.severity,
      message: d.message,
      // A config diagnostic has no document range; the file start stands in.
      range: { start: { line: 1, column: 1, offset: 0 }, end: { line: 1, column: 1, offset: 0 } },
      layer: 'config',
      data: { config: true },
    })),
  };
  configCache.set(key, resolved);
  return resolved;
}

/** Convert a validator Diagnostic to a unist Position. */
function toPosition(diag: Diagnostic): Position {
  const start: Point = { line: diag.range.start.line, column: diag.range.start.column, offset: diag.range.start.offset };
  const end: Point = { line: diag.range.end.line, column: diag.range.end.column, offset: diag.range.end.offset };
  return { start, end };
}

/**
 * A single-value replacement for `expected`, or undefined.
 *
 * `unified-language-server`'s QuickFix builds one `TextEdit.replace(range, x)`
 * per `expected` string, so a diagnostic that cannot name exactly one
 * replacement (an unknown field, a duplicate relation, a missing required
 * field) carries none and is a diagnostic-only report.
 */
function expectedReplacement(diag: Diagnostic): string | undefined {
  const data = diag.data;
  if (!data) return undefined;
  const candidate = data['expected'];
  return typeof candidate === 'string' ? candidate : undefined;
}

const remarkLintMdlineage = lintRule(
  { origin: ORIGIN, url: DOCS_URL },
  function (tree: Root, file: VFile, options: RemarkLintMdlineageOptions | undefined): void {
    void tree;
    const resolved = resolveConfig(options?.configFile);
    const content = file.toString();

    // `path` is advisory: the validator never reads the disk, and when a host
    // hands it an untitled buffer `file.path` is undefined by design.
    const result = validateDocumentSync({ content, path: file.path, config: resolved.config });
    for (const diag of result.diagnostics) {
      report(file, diag);
    }

    // Config load failures are adapter-level, not document-level, so they come
    // last: they must never displace the document's own diagnostics in a
    // message list a user reads top-down.
    for (const diag of resolved.diagnostics) {
      report(file, diag);
    }
  },
);

/**
 * Restore the validator's severity on this run's messages.
 *
 * `unified-lint-rule` runs this rule's transformer inside `wrap` and then does
 * `Object.assign(message, {fatal: ruleSeverity, ...})` over every message the
 * rule created. This rule is registered with no severity (so it is always on,
 * at warning level, since the severity that matters is the diagnostic's own),
 * which means that pass rewrites every `fatal: true` this rule sets back to
 * `false`. Reapplying it from a later transformer puts it back, and later
 * transformers are how every other message-producing plugin composes.
 */
function restoreSeverity() {
  return function (_tree: Root, file: VFile): void {
    for (const message of file.messages) {
      const data = (message as CodedMessage).data;
      if (data && typeof data.mdlSeverity === 'string') {
        message.fatal = data.mdlSeverity === 'error';
      }
    }
  };
}

export default Object.assign(remarkLintMdlineage, {
  /**
   * The severity-restoring transformer, for pipelines that compose plugins by
   * hand. `unified-lint-rule` overwrites `fatal` on this rule's own messages
   * regardless of what runs after it, so `.remarkrc.mjs` attaches
   * `restoreSeverity` right after the rule (review round M1-b: without it,
   * every error-level MDL code surfaces as a warning in editors).
   */
  restoreSeverity,
});

/**
 * The MDL code carried on the message, as an own property.
 *
 * `VFileMessage` declares `ruleId` and `source` (which unified-lint-rule sets
 * from the origin) but no `code`, and `unified-language-server` builds its LSP
 * diagnostic code from the message's own fields. §14.4 pins the MDLxxx string
 * as the cross-entry contract, so it is defined here explicitly.
 */
interface CodedMessage extends VFileMessage {
  code?: string;
  data?: Record<string, unknown>;
}

/**
 * Turn one validator Diagnostic into a VFileMessage on `file`.
 *
 * `fatal` is set here for direct callers, and re-set by `restoreSeverity` for
 * pipeline callers: `unified-lint-rule` overwrites it with the rule's own
 * severity after this transformer returns (see `restoreSeverity`).
 */
function report(file: VFile, diag: Diagnostic): void {
  const message = file.message(diag.message, toPosition(diag), ORIGIN) as CodedMessage;
  message.code = diag.code;
  message.note = `MDLineage ${diag.code} (${diag.layer})`;
  message.actual = diag.data?.['actual'] as string | undefined;
  const expected = expectedReplacement(diag);
  if (expected !== undefined) message.expected = [expected];
  message.data = {
    ...diag.data,
    mdlCode: diag.code,
    mdlLayer: diag.layer,
    mdlSeverity: diag.severity,
  };
  message.fatal = diag.severity === 'error';
}
