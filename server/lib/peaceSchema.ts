import { logger } from './logger.js';

const MISSING = new Set(['42P01', '42703', 'PGRST204', 'PGRST205']);

export function isPeaceSchemaMissing(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' && MISSING.has(code);
}

let warned = false;

/** One warning per process when migration 281 is not applied. */
export function warnPeaceSchemaMissing(err?: unknown): void {
  if (warned) return;
  warned = true;
  logger.warn(
    { err, event: 'peace_period_schema_missing' },
    'Peace period is off because migration 281 is not applied',
  );
}
