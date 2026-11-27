import { logger } from '../../lib/logger.js';

/** Missing chain tables or columns. Same codes the ledger treats as "not migrated". */
const SCHEMA_CODES = new Set(['42P01', '42703', 'PGRST204', 'PGRST205']);

let warned = false;

export function escalationErrorCode(err: unknown): string | null {
  if (!err || typeof err !== 'object') return null;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

export function isEscalationSchemaMissing(err: unknown): boolean {
  const code = escalationErrorCode(err);
  return code != null && SCHEMA_CODES.has(code);
}

export function escalationChainsUnavailable(): boolean {
  return warned;
}

/** One warning per process. Routes and the scheduler tick keep running. */
export function noteEscalationUnavailable(): void {
  if (warned) return;
  warned = true;
  logger.warn(
    { event: 'escalation_chains_unavailable' },
    'Escalation chains are off because migration 272 is not applied',
  );
}
