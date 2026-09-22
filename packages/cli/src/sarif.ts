/**
 * SARIF 2.1.0 rendering (docs/remark-language-server-solution.md §16 M2).
 *
 * The shape is the one GitHub code scanning consumes: one run, one tool driver,
 * one result per diagnostic. SARIF `level` has four values but the spec
 * (§3.27.10) makes `note` the bucket for everything below warning, so
 * `information` and `hint` both map to `note` — a SARIF reader that needs the
 * exact severity reads `properties.mdlineageSeverity`.
 */

import type { CheckResult } from './check.js';

/** SARIF severity, ordered. `none` is allowed by the spec and unused here. */
type SarifLevel = 'error' | 'warning' | 'note';

const TOOL_NAME = 'mdlineage';
/** The CLI's own version, reported to SARIF consumers. */
const TOOL_VERSION = '0.0.0';
/**
 * Deterministic guid for the driver, per SARIF §3.19.4: a run's tool identity
 * is (name, version, guid), so a stable guid keeps runs grouped across formats.
 */
const TOOL_GUID = '5c1e0d4a-7c9a-4f9b-bc93-2ec0d0ad6c01';
const SARIF_VERSION = '2.1.0';
const SPEC_URI = 'https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/sarif-v2.1.0-errata01-os-complete.html';

/** A SARIF run, minus the results, which `renderSarif` fills in. */
interface SarifSkeleton {
  tool: {
    driver: {
      name: string;
      version: string;
      guid: string;
      rules: SarifRule[];
    };
  };
  results: SarifResult[];
}

interface SarifRule {
  id: string;
  name: string;
  shortDescription: { text: string };
  defaultConfiguration: { level: SarifLevel };
  properties: { mdlineageLayer: string };
}

interface SarifResult {
  ruleId: string;
  level: SarifLevel;
  message: { text: string };
  locations: Array<{
    physicalLocation: {
      artifactLocation: { uri: string };
      region: { startLine: number; startColumn?: number; endLine?: number; endColumn?: number };
    };
  }>;
  properties?: { mdlineageSeverity?: string; mdlineageLayer?: string };
}

/**
 * The MDL severity → SARIF level mapping.
 *
 * `error`→`error` and `warning`→`warning` are the spec's own names; SARIF has
 * no `information` level (§3.27.10 lists error/warning/note/none), so the two
 * informational severities land in `note`.
 */
export function sarifLevel(severity: string): SarifLevel {
  switch (severity) {
    case 'error':
      return 'error';
    case 'warning':
      return 'warning';
    default:
      return 'note';
  }
}

/** The distinct MDL codes a report carries, in first-seen order. */
export function codesOf(result: CheckResult): string[] {
  const out: string[] = [];
  for (const report of result.reports) {
    for (const diag of report.diagnostics) {
      if (!out.includes(diag.code)) out.push(diag.code);
    }
  }
  for (const diag of result.configDiagnostics) {
    if (!out.includes(diag.code)) out.push(diag.code);
  }
  return out;
}

/** A path usable as a SARIF `artifactLocation.uri`: relative, POSIX-shaped. */
function sarifUri(path: string): string {
  return path.replace(/\\/g, '/');
}

/**
 * Render a run as SARIF 2.1.0.
 *
 * Every MDL code that appears becomes a `rules` entry, because GitHub code
 * scanning only presents a finding's rule when the run's tool driver declares
 * it. `results` follows the same order as the text/JSON output, so the three
 * channels never disagree about what happened.
 */
export function renderSarif(result: CheckResult): string {
  const skeleton: SarifSkeleton = {
    tool: { driver: { name: TOOL_NAME, version: TOOL_VERSION, guid: TOOL_GUID, rules: [] } },
    results: [],
  };

  const seen = new Set<string>();
  const pushRule = (code: string, severity: string, layer: string): void => {
    if (seen.has(code)) return;
    seen.add(code);
    skeleton.tool.driver.rules.push({
      id: code,
      name: code,
      shortDescription: { text: sarifRuleText(code, layer) },
      defaultConfiguration: { level: sarifLevel(severity) },
      properties: { mdlineageLayer: layer },
    });
  };

  for (const report of result.reports) {
    for (const diag of report.diagnostics) {
      pushRule(diag.code, diag.severity, diag.layer);
      skeleton.results.push({
        ruleId: diag.code,
        level: sarifLevel(diag.severity),
        message: { text: diag.message },
        locations: [
          {
            physicalLocation: {
              artifactLocation: { uri: sarifUri(report.path) },
              region: {
                startLine: diag.line,
                ...(diag.column > 0 ? { startColumn: diag.column } : {}),
                ...(diag.endLine > diag.line ? { endLine: diag.endLine } : {}),
                ...(diag.endColumn > diag.column ? { endColumn: diag.endColumn } : {}),
              },
            },
          },
        ],
        properties: { mdlineageSeverity: diag.severity, mdlineageLayer: diag.layer },
      });
    }
  }

  // Config diagnostics belong to the run, not a document: the config file is
  // the artifact, and line 1 is where a config problem starts.
  for (const diag of result.configDiagnostics) {
    pushRule(diag.code, diag.severity, 'config');
    skeleton.results.push({
      ruleId: diag.code,
      level: sarifLevel(diag.severity),
      message: { text: diag.message },
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri: sarifUri(result.configPath ?? 'mdlineage.config.yaml') },
            region: { startLine: 1 },
          },
        },
      ],
      properties: { mdlineageSeverity: diag.severity, mdlineageLayer: 'config' },
    });
  }

  // An unreadable file has no diagnostics to attach a rule to, so it is
  // reported as MDL900 — the config/internal block — at the file's start.
  for (const file of result.unreadable) {
    pushRule('MDL900', 'error', 'config');
    skeleton.results.push({
      ruleId: 'MDL900',
      level: 'error',
      message: { text: `Could not read file: ${file.message}` },
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri: sarifUri(file.path) },
            region: { startLine: 1 },
          },
        },
      ],
      properties: { mdlineageSeverity: 'error', mdlineageLayer: 'config' },
    });
  }

  return `${JSON.stringify(sarifSkeletonWithHeader(skeleton), null, 2)}\n`;
}

/** One-line rule description: the code, its layer, and where to read more. */
function sarifRuleText(code: string, layer: string): string {
  return `MDLineage ${code} (${layer}) — see https://mdlineage.dev/docs/diagnostic-codes`;
}

/** Attach the version header that makes the document self-describing. */
function sarifSkeletonWithHeader(skeleton: SarifSkeleton): Record<string, unknown> {
  return {
    $schema: SPEC_URI,
    version: SARIF_VERSION,
    runs: [skeleton],
  };
}
