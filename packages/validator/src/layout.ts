/**
 * Layout rules and directory conventions (P2 / MDL501–MDL504).
 *
 * Checks:
 *   - forbidStatus                          (MDL501)
 *   - require.kind                          (MDL501)
 *   - require.authority                     (MDL501)
 *   - require.frontmatter (optional exempts MDL003)
 *   - intent.kinds / intent.authority / intent.forbidStatus   (MDL502)
 *   - intent.maxDepth / intent.naming                          (MDL504)
 *   - layoutExceptions expiry                                  (MDL503)
 *
 * A layout exception that matches a document and has not expired suppresses
 * that document's intent checks (MDL502/MDL504); an expired one reports MDL503
 * and stops exempting. The MDL501 require/forbidStatus checks are unaffected by
 * exceptions, which cover the intent block only.
 */

import type { Config, LayoutException, LayoutIntent, LayoutRule } from './config.js';
import type { Diagnostic } from './diagnostic.js';
import { severityOf } from './diagnostic.js';
import { matchesPattern, normalizeFilterPath } from './path-filter.js';
import type { LineMap } from './source-map.js';
import { rangeAt } from './source-map.js';

export interface LayoutDiagnosticsParams {
  readonly path: string;
  readonly mdlineage: Record<string, unknown> | null;
  readonly lineMap: LineMap;
  readonly range: { start: number; end: number };
  readonly config: Config;
  /** Injected clock for exception expiry; defaults to `Date.now()`. */
  readonly nowMs?: number;
}

/**
 * Check if layout rules exempt frontmatter (require.frontmatter: optional) for a given path.
 */
export function layoutExemptsFrontmatter(path: string, layoutRules: readonly LayoutRule[]): boolean {
  const normalized = normalizeFilterPath(path);
  let exempt = false;
  for (const rule of layoutRules) {
    if (matchesPattern(normalized, rule.match)) {
      if (rule.require?.frontmatter === 'optional') {
        exempt = true;
      } else if (rule.require?.frontmatter === 'required') {
        exempt = false;
      }
    }
  }
  return exempt;
}

/**
 * Validate document metadata against layout rules.
 */
export function layoutDiagnostics(params: LayoutDiagnosticsParams): Diagnostic[] {
  const { path, mdlineage, lineMap, range, config } = params;
  const layoutRules = config.layout;
  const exceptions = config.layoutExceptions ?? [];
  if ((!layoutRules || layoutRules.length === 0) && exceptions.length === 0) return [];

  const normalized = normalizeFilterPath(path);
  const diagnostics: Diagnostic[] = [];
  const at = rangeAt(lineMap, range.start, range.end);
  const overrides = config.diagnostics as Record<string, 'error' | 'warning' | 'information' | 'hint'>;
  const severity501 = severityOf('MDL501', overrides);

  // Exceptions: a matching unexpired entry exempts this document's intent
  // checks; a matching expired entry reports MDL503 and does not exempt.
  let intentExempt = false;
  for (const exception of exceptions) {
    if (!matchesPattern(normalized, exception.path)) continue;
    if (isExceptionExpired(exception, params.nowMs)) {
      diagnostics.push({
        code: 'MDL503',
        severity: severityOf('MDL503', overrides),
        message: `Layout exception for '${exception.path}' expired on ${exception.expires} (reason: ${exception.reason})`,
        range: at,
        layer: 'policy-layout',
        data: {
          path: exception.path,
          reason: exception.reason,
          expires: exception.expires,
        },
      });
    } else {
      intentExempt = true;
    }
  }

  for (const rule of layoutRules ?? []) {
    if (!matchesPattern(normalized, rule.match)) continue;

    // Check forbidStatus
    if (rule.forbidStatus && rule.forbidStatus.length > 0 && mdlineage && typeof mdlineage.status === 'string') {
      if (rule.forbidStatus.includes(mdlineage.status)) {
        diagnostics.push({
          code: 'MDL501',
          severity: severity501,
          message: `Layout rule violation: status '${mdlineage.status}' is forbidden for '${rule.match}'`,
          range: at,
          layer: 'policy-layout',
          data: {
            rule: 'forbidStatus',
            match: rule.match,
            status: mdlineage.status,
          },
        });
      }
    }

    // Check require.kind
    if (rule.require?.kind) {
      const allowedKinds = Array.isArray(rule.require.kind) ? rule.require.kind : [rule.require.kind];
      if (mdlineage && typeof mdlineage.kind === 'string') {
        if (!allowedKinds.includes(mdlineage.kind)) {
          diagnostics.push({
            code: 'MDL501',
            severity: severity501,
            message: `Layout rule violation: kind '${mdlineage.kind}' is not in required kind(s) [${allowedKinds.join(', ')}] for '${rule.match}'`,
            range: at,
            layer: 'policy-layout',
            data: {
              rule: 'require.kind',
              match: rule.match,
              kind: mdlineage.kind,
              allowed: allowedKinds,
            },
          });
        }
      } else if (mdlineage && mdlineage.kind === undefined) {
        diagnostics.push({
          code: 'MDL501',
          severity: severity501,
          message: `Layout rule violation: kind is required for '${rule.match}'`,
          range: at,
          layer: 'policy-layout',
          data: {
            rule: 'require.kind',
            match: rule.match,
            allowed: allowedKinds,
          },
        });
      }
    }

    // Check require.authority
    if (rule.require?.authority) {
      const allowedAuthorities = Array.isArray(rule.require.authority) ? rule.require.authority : [rule.require.authority];
      if (mdlineage && typeof mdlineage.authority === 'string') {
        if (!allowedAuthorities.includes(mdlineage.authority)) {
          diagnostics.push({
            code: 'MDL501',
            severity: severity501,
            message: `Layout rule violation: authority '${mdlineage.authority}' is not in required authority(s) [${allowedAuthorities.join(', ')}] for '${rule.match}'`,
            range: at,
            layer: 'policy-layout',
            data: {
              rule: 'require.authority',
              match: rule.match,
              authority: mdlineage.authority,
              allowed: allowedAuthorities,
            },
          });
        }
      } else if (mdlineage && mdlineage.authority === undefined) {
        diagnostics.push({
          code: 'MDL501',
          severity: severity501,
          message: `Layout rule violation: authority is required for '${rule.match}'`,
          range: at,
          layer: 'policy-layout',
          data: {
            rule: 'require.authority',
            match: rule.match,
            allowed: allowedAuthorities,
          },
        });
      }
    }

    // Check the rule's intent block (unless exempted by a live exception).
    if (rule.intent && !intentExempt) {
      diagnostics.push(...intentDiagnostics(rule, normalized, mdlineage, at, overrides));
    }
  }

  return diagnostics;
}

/** Intent mismatches for one matching rule (MDL502 / MDL504). */
function intentDiagnostics(
  rule: LayoutRule,
  normalizedPath: string,
  mdlineage: Record<string, unknown> | null,
  at: ReturnType<typeof rangeAt>,
  overrides: Record<string, 'error' | 'warning' | 'information' | 'hint'>,
): Diagnostic[] {
  const intent = rule.intent as LayoutIntent;
  const out: Diagnostic[] = [];
  const push502 = (data: Record<string, unknown>, message: string): void => {
    out.push({
      code: 'MDL502',
      severity: severityOf('MDL502', overrides),
      message,
      range: at,
      layer: 'policy-layout',
      data: { match: rule.match, ...data },
    });
  };
  const push504 = (data: Record<string, unknown>, message: string): void => {
    out.push({
      code: 'MDL504',
      severity: severityOf('MDL504', overrides),
      message,
      range: at,
      layer: 'policy-layout',
      data: { match: rule.match, ...data },
    });
  };

  const kind = mdlineage && typeof mdlineage.kind === 'string' ? mdlineage.kind : undefined;
  if (intent.kinds && kind !== undefined && !intent.kinds.includes(kind)) {
    push502(
      { rule: 'intent.kinds', kind, allowed: intent.kinds },
      `Directory intent violation: kind '${kind}' is not in [${intent.kinds.join(', ')}] for '${rule.match}'`,
    );
  }

  const authority = mdlineage && typeof mdlineage.authority === 'string' ? mdlineage.authority : undefined;
  if (intent.authority && authority !== undefined && !intent.authority.includes(authority)) {
    push502(
      { rule: 'intent.authority', authority, allowed: intent.authority },
      `Directory intent violation: authority '${authority}' is not in [${intent.authority.join(', ')}] for '${rule.match}'`,
    );
  }

  const status = mdlineage && typeof mdlineage.status === 'string' ? mdlineage.status : undefined;
  if (intent.forbidStatus && status !== undefined && intent.forbidStatus.includes(status)) {
    push502(
      { rule: 'intent.forbidStatus', status, forbidden: intent.forbidStatus },
      `Directory intent violation: status '${status}' is forbidden by '${rule.match}'`,
    );
  }

  if (intent.maxDepth !== undefined) {
    const depth = directoryDepth(matchPrefix(rule.match), normalizedPath);
    if (depth > intent.maxDepth) {
      push504(
        { rule: 'intent.maxDepth', depth, maxDepth: intent.maxDepth },
        `Directory structure violation: '${normalizedPath}' is ${depth} level(s) deep, exceeding maxDepth ${intent.maxDepth} for '${rule.match}'`,
      );
    }
  }

  if (intent.naming !== undefined) {
    const matcher = compileNaming(intent.naming);
    if (matcher) {
      const basename = normalizedPath.slice(normalizedPath.lastIndexOf('/') + 1);
      const stem = basename.endsWith('.md') ? basename.slice(0, -3) : basename;
      if (!matcher.test(basename) && !matcher.test(stem)) {
        push504(
          { rule: 'intent.naming', pattern: intent.naming, basename },
          `Directory structure violation: filename '${basename}' does not match /${intent.naming}/ for '${rule.match}'`,
        );
      }
    }
  }

  return out;
}

/** True when an exception carries an `expires` date that is before today (UTC). */
function isExceptionExpired(exception: LayoutException, nowMs: number | undefined): boolean {
  if (!exception.expires) return false;
  const today = utcDateString(nowMs ?? Date.now());
  // ISO YYYY-MM-DD strings compare lexicographically, which matches calendar order.
  return exception.expires < today;
}

/** The UTC calendar date of `nowMs` as YYYY-MM-DD. */
function utcDateString(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/**
 * Static directory prefix of a glob: everything before the first metacharacter,
 * trimmed back to the last complete path segment. `docs/**` → `docs/`;
 * `**\/*.md` → `''`; an exact path → `''`.
 */
function matchPrefix(pattern: string): string {
  const index = pattern.search(/[*?[{]/);
  const head = index === -1 ? pattern : pattern.slice(0, index);
  const lastSlash = head.lastIndexOf('/');
  return lastSlash === -1 ? '' : head.slice(0, lastSlash + 1);
}

/** Directory depth of `path` below an already-stripped `prefix` (file excluded). */
function directoryDepth(prefix: string, path: string): number {
  const relative = prefix && path.startsWith(prefix) ? path.slice(prefix.length) : path;
  const segments = relative.split('/').filter((segment) => segment.length > 0);
  return Math.max(0, segments.length - 1);
}

/** Compile a naming pattern, returning null for an invalid regular expression. */
function compileNaming(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern);
  } catch {
    return null;
  }
}
