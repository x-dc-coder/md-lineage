/**
 * `mdlineage config validate` (spec §10.1).
 *
 * Checks that a configuration file loads and passes the config schema,
 * reusing the loader `check` uses so the diagnostics cannot drift. A missing
 * config file found by the implicit walk-up is a legal state (defaults apply),
 * so it is reported and the run succeeds; an explicitly named `--config` that
 * cannot be used yields MDL900 diagnostics and fails the run, same as `check`.
 */

import { loadConfig } from '@mdlineage/validator';

export interface ConfigValidateOptions {
  format: 'text' | 'json';
  /** Explicit config path; omitted means the walk-up lookup from `cwd`. */
  configFile?: string;
  cwd: string;
}

/** Run the config check; returns the exit code (0 OK, 1 diagnostics). */
export function configValidate(options: ConfigValidateOptions): number {
  const loaded = loadConfig(options.configFile, options.configFile ? undefined : options.cwd);
  const source = loaded.config.source;
  const diagnostics = loaded.diagnostics.map((d) => ({
    code: d.code,
    severity: d.severity,
    message: d.message,
  }));

  if (options.format === 'json') {
    process.stdout.write(`${JSON.stringify({ source, diagnostics }, null, 2)}\n`);
  } else {
    for (const diag of diagnostics) {
      process.stderr.write(`mdlineage: ${diag.code} ${diag.severity} ${diag.message}\n`);
    }
    if (diagnostics.length === 0) {
      if (source === null) {
        process.stdout.write('mdlineage: no config file found, using built-in defaults\n');
      } else {
        process.stdout.write(`mdlineage: config OK (${source})\n`);
      }
    }
  }
  return diagnostics.length > 0 ? 1 : 0;
}
