/**
 * Validator diagnostics → LSP diagnostics.
 *
 * Two translations, both one-way and both stateless:
 *   - severity: the validator's four levels map onto LSP's four levels 1:1. This
 *     is the channel where all four actually reach the client: remark/unified's
 *     lint severity has three buckets, so Information and Hint collapse into
 *     Warning there (§9.1) and only the dedicated LSP delivers §8.2's full
 *     scale. Config overrides (mdlineage.config.yaml's `diagnostics:` block)
 *     take effect through `severityOf`, which the workspace validator already
 *     applied — the LSP never re-decides a severity.
 *   - range: validator (1-based line, 1-based UTF-16 column) → LSP (0-based
 *     line, 0-based UTF-16 character), see position.ts and §8.3.
 */

import type { Diagnostic } from '@mdlineage/validator';
import { DiagnosticSeverity } from 'vscode-languageserver-protocol';
import { diagnosticRange } from './position.js';

export interface LspDiagnostic {
  range: ReturnType<typeof diagnosticRange>;
  severity: DiagnosticSeverity;
  code: string;
  source: string;
  message: string;
}

/** The validator's four severities, in §8.2's order, as LSP levels. */
export function severityToLsp(severity: Diagnostic['severity']): DiagnosticSeverity {
  switch (severity) {
    case 'error':
      return DiagnosticSeverity.Error;
    case 'warning':
      return DiagnosticSeverity.Warning;
    case 'information':
      return DiagnosticSeverity.Information;
    case 'hint':
      return DiagnosticSeverity.Hint;
  }
}

/**
 * One workspace diagnostic, positioned against the 0-based lines of its own
 * document. `lines` is the document split on any line terminator, which is what
 * `TextDocument` consumers hold.
 */
export function toLspDiagnostic(diag: Diagnostic, lines: ReadonlyArray<string>): LspDiagnostic {
  return {
    range: diagnosticRange(diag, lines),
    severity: severityToLsp(diag.severity),
    code: diag.code,
    source: 'mdlineage',
    message: diag.message,
  };
}
