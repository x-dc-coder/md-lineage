/**
 * Authored freshness and lifecycle governance (MDL801).
 *
 * Pure functions: no IO, no subprocesses.
 * Evaluates authored timestamps (updated_at, created_at) against staleAfterDays.
 */

import type { Config } from './config.js';
import type { Diagnostic } from './diagnostic.js';
import { severityOf } from './diagnostic.js';
import { matchesPattern, normalizeFilterPath } from './path-filter.js';
import type { LineMap } from './source-map.js';
import { rangeAt } from './source-map.js';
import { mdlineageFieldOffset } from './document-validator.js';

export const MS_PER_DAY = 86_400_000;

const AUTHORED_DATE_REGEX =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(?:(Z)|([+-]\d{2}:\d{2}))?)?$/;

/**
 * Parse an authored timestamp string into epoch milliseconds in UTC.
 * Returns null if the string fails the schema regex.
 * No timezone is treated as UTC. Invalid calendar dates allow UTC roll-over.
 */
export function parseAuthoredInstant(value: string): number | null {
  const match = AUTHORED_DATE_REGEX.exec(value);
  if (!match) return null;

  const year = parseInt(match[1]!, 10);
  const month = parseInt(match[2]!, 10);
  const day = parseInt(match[3]!, 10);
  const hour = match[4] ? parseInt(match[4], 10) : 0;
  const minute = match[5] ? parseInt(match[5], 10) : 0;
  const second = match[6] ? parseInt(match[6], 10) : 0;
  let ms = 0;
  if (match[7]) {
    const fracStr = match[7].padEnd(3, '0').slice(0, 3);
    ms = parseInt(fracStr, 10);
  }

  const d = new Date(0);
  d.setUTCFullYear(year, month - 1, day);
  d.setUTCHours(hour, minute, second, ms);
  let instant = d.getTime();

  if (match[9]) {
    const tz = match[9];
    const sign = tz[0] === '+' ? 1 : -1;
    const tzHours = parseInt(tz.slice(1, 3), 10);
    const tzMins = parseInt(tz.slice(4, 6), 10);
    const tzOffsetMs = sign * (tzHours * 60 + tzMins) * 60_000;
    instant -= tzOffsetMs;
  }

  return instant;
}

/**
 * Strictly older than: nowMs - instantMs > days * MS_PER_DAY.
 */
export function isOlderThan(instantMs: number, nowMs: number, days: number): boolean {
  return nowMs - instantMs > days * MS_PER_DAY;
}

/**
 * Check if a path is exempt from lifecycle freshness rules.
 */
export function lifecycleExempts(path: string | undefined, exempt: readonly string[]): boolean {
  if (!path || !exempt || exempt.length === 0) return false;
  const normalized = normalizeFilterPath(path);
  for (const pattern of exempt) {
    if (matchesPattern(normalized, pattern)) return true;
  }
  return false;
}

export interface FreshnessDiagnosticsInput {
  readonly path?: string;
  readonly mdlineage: Record<string, unknown> | null;
  readonly doc?: unknown;
  readonly rawStart: number;
  readonly lineMap: LineMap;
  readonly config: Config;
  readonly nowMs?: number;
}

/**
 * Compute MDL801 freshness diagnostics from authored metadata timestamps.
 */
export function freshnessDiagnostics(input: FreshnessDiagnosticsInput): Diagnostic[] {
  const { path, mdlineage, doc, rawStart, lineMap, config } = input;
  const staleAfterDays = config.lifecycle.staleAfterDays;

  // 1. staleAfterDays <= 0 -> disabled
  if (staleAfterDays <= 0) return [];

  // 2. Path exempt -> []; status not in staleStatuses -> [] (missing status -> [])
  if (path && lifecycleExempts(path, config.lifecycle.exempt)) return [];
  const status = mdlineage?.['status'];
  if (typeof status !== 'string' || !config.lifecycle.staleStatuses.includes(status)) return [];

  // 3. Authored clock: valid updated_at prioritized, then valid created_at
  let adoptedSource: 'updated_at' | 'created_at' | null = null;
  let adoptedValue = '';
  let adoptedInstant: number | null = null;

  const rawUpdated = mdlineage?.['updated_at'];
  if (typeof rawUpdated === 'string') {
    const instant = parseAuthoredInstant(rawUpdated);
    if (instant !== null) {
      adoptedSource = 'updated_at';
      adoptedValue = rawUpdated;
      adoptedInstant = instant;
    }
  }

  if (adoptedSource === null) {
    const rawCreated = mdlineage?.['created_at'];
    if (typeof rawCreated === 'string') {
      const instant = parseAuthoredInstant(rawCreated);
      if (instant !== null) {
        adoptedSource = 'created_at';
        adoptedValue = rawCreated;
        adoptedInstant = instant;
      }
    }
  }

  if (adoptedSource === null || adoptedInstant === null) return [];

  // 4. Not expired -> []; expired -> report MDL801
  const nowMs = input.nowMs ?? Date.now();
  if (!isOlderThan(adoptedInstant, nowMs, staleAfterDays)) return [];

  const ageDays = Math.floor((nowMs - adoptedInstant) / MS_PER_DAY);
  const fieldOffset = doc ? mdlineageFieldOffset(doc, adoptedSource) : null;
  const start = fieldOffset !== null ? rawStart + fieldOffset : rawStart;
  const end = fieldOffset !== null ? start + adoptedValue.length : start + 1;
  const range = rangeAt(lineMap, start, end);

  // 5. Message: Document not updated in over ${days} days (updated_at 2020-01-01T00:00:00Z)
  const severity = severityOf(
    'MDL801',
    config.diagnostics as Record<string, 'error' | 'warning' | 'information' | 'hint'>,
  );
  const message = `Document not updated in over ${staleAfterDays} days (${adoptedSource} ${adoptedValue})`;

  return [
    {
      code: 'MDL801',
      severity,
      message,
      range,
      layer: 'policy-layout',
      data: {
        staleAfterDays,
        source: adoptedSource,
        instant: adoptedInstant,
        ageDays,
      },
    },
  ];
}
