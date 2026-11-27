import { logger } from '../../lib/logger.js';

/**
 * PostgREST reports a missing table as PGRST205 (not in the schema cache) and a
 * missing column as PGRST204. Postgres itself uses 42P01 and 42703. Any of these
 * means migration 268 is not applied.
 */
const SCHEMA_CODES = new Set(['42P01', '42703', 'PGRST204', 'PGRST205']);

export function ledgerErrorCode(err: unknown): string | null {
  if (!err || typeof err !== 'object') return null;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

export function isLedgerSchemaMissing(err: unknown): boolean {
  const code = ledgerErrorCode(err);
  return code != null && SCHEMA_CODES.has(code);
}

let warned = false;

/** One line per process, shared by routes and the scheduler. */
export function noteLedgerUnavailable(): void {
  if (warned) return;
  warned = true;
  logger.warn(
    { event: 'inject_ledger_unavailable' },
    'Inject response ledger is off because migration 268 is not applied',
  );
}

let tablesMissing = false;
let chatInjectIdMissing = false;
let directMessageInjectIdMissing = false;

export function ledgerTablesMissing(): boolean {
  return tablesMissing;
}

export function markLedgerTablesMissing(): void {
  tablesMissing = true;
  noteLedgerUnavailable();
}

export function chatInjectIdColumnMissing(): boolean {
  return chatInjectIdMissing;
}

/** The chat line is saved either way. Only the new column is skipped. */
export function markChatInjectIdColumnMissing(): void {
  chatInjectIdMissing = true;
  noteLedgerUnavailable();
}

export function directMessageInjectIdColumnMissing(): boolean {
  return directMessageInjectIdMissing;
}

/** The Messenger row is saved either way. Only migration 270's column is skipped. */
export function markDirectMessageInjectIdColumnMissing(): void {
  if (directMessageInjectIdMissing) return;
  directMessageInjectIdMissing = true;
  logger.warn(
    { event: 'dm_inject_id_unavailable' },
    'sim_direct_messages.inject_id is off because migration 270 is not applied',
  );
}

const otherWarned = new Set<string>();

/** Unexpected ledger errors are logged once per code so a tick cannot spam. */
export function noteLedgerError(err: unknown, where: string): void {
  if (isLedgerSchemaMissing(err)) {
    markLedgerTablesMissing();
    return;
  }
  const code = ledgerErrorCode(err) ?? 'unknown';
  const key = `${where}:${code}`;
  if (otherWarned.has(key)) return;
  otherWarned.add(key);
  logger.warn({ err, code, where, event: 'inject_ledger_error' }, 'Inject ledger query failed');
}

/** True when the caller should stop this ledger operation. */
export function failLedger(err: unknown, where: string): boolean {
  if (!err) return false;
  noteLedgerError(err, where);
  return true;
}
