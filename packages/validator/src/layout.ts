/**
 * Layout rules and directory conventions (P2 / MDL501).
 *
 * Checks:
 *   - forbidStatus
 *   - require.kind
 *   - require.authority
 *   - require.frontmatter (optional exempts MDL003)
 */

import type { Config, LayoutRule } from './config.js';
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
  if (!layoutRules || layoutRules.length === 0) return [];

  const normalized = normalizeFilterPath(path);
  const diagnostics: Diagnostic[] = [];
  const severity = severityOf('MDL501', config.diagnostics as Record<string, 'error' | 'warning' | 'information' | 'hint'>);

  for (const rule of layoutRules) {
    if (!matchesPattern(normalized, rule.match)) continue;

    // Check forbidStatus
    if (rule.forbidStatus && rule.forbidStatus.length > 0 && mdlineage && typeof mdlineage.status === 'string') {
      if (rule.forbidStatus.includes(mdlineage.status)) {
        diagnostics.push({
          code: 'MDL501',
          severity,
          message: `Layout rule violation: status '${mdlineage.status}' is forbidden for '${rule.match}'`,
          range: rangeAt(lineMap, range.start, range.end),
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
            severity,
            message: `Layout rule violation: kind '${mdlineage.kind}' is not in required kind(s) [${allowedKinds.join(', ')}] for '${rule.match}'`,
            range: rangeAt(lineMap, range.start, range.end),
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
          severity,
          message: `Layout rule violation: kind is required for '${rule.match}'`,
          range: rangeAt(lineMap, range.start, range.end),
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
            severity,
            message: `Layout rule violation: authority '${mdlineage.authority}' is not in required authority(s) [${allowedAuthorities.join(', ')}] for '${rule.match}'`,
            range: rangeAt(lineMap, range.start, range.end),
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
          severity,
          message: `Layout rule violation: authority is required for '${rule.match}'`,
          range: rangeAt(lineMap, range.start, range.end),
          layer: 'policy-layout',
          data: {
            rule: 'require.authority',
            match: rule.match,
            allowed: allowedAuthorities,
          },
        });
      }
    }
  }

  return diagnostics;
}
