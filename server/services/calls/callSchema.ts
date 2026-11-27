import { logger } from '../../lib/logger.js';

const SCHEMA_CODES = new Set(['42P01', '42703', 'PGRST204', 'PGRST205']);

export function callErrorCode(err: unknown): string | null {
  if (!err || typeof err !== 'object') return null;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

export function isCallSchemaMissing(err: unknown): boolean {
  const code = callErrorCode(err);
  return code != null && SCHEMA_CODES.has(code);
}

let warned = false;

/** One line per process when migration 269 is not applied. */
export function noteCallsUnavailable(): void {
  if (warned) return;
  warned = true;
  logger.warn(
    { event: 'sim_calls_unavailable' },
    'Phone calls are off because migration 269 is not applied',
  );
}

let tablesMissing = false;

export function callTablesMissing(): boolean {
  return tablesMissing;
}

export function markCallTablesMissing(): void {
  tablesMissing = true;
  noteCallsUnavailable();
}
