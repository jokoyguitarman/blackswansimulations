import { env } from '../env.js';
import { supabaseAdmin } from './supabaseAdmin.js';
import { logger } from './logger.js';

/**
 * Migration 281 adds opened_at, peace_seconds and peace_ref. Readers remember a
 * missing column for the process, the same way ledgerSchema and templateRows do,
 * so a later tick does not repeat the failed select.
 */

const COLUMN_CODES = new Set(['42703', 'PGRST204']);
const PEACE_COLUMN = /opened_at|peace_seconds|peace_ref/;

export interface PeaceQueryError {
  code?: string;
  message?: string;
  details?: string;
  hint?: string;
}

export interface SessionClockFields {
  opened_at?: string | null;
}

export function openedAtOf(row: SessionClockFields | null | undefined): string | null {
  return typeof row?.opened_at === 'string' ? row.opened_at : null;
}

let columnsMissing = false;
let warned = false;

export function peaceColumnsMissing(): boolean {
  return columnsMissing;
}

export function markPeaceColumnsMissing(): void {
  columnsMissing = true;
  if (warned) return;
  warned = true;
  logger.warn(
    { event: 'peace_period_schema_missing' },
    'Peace period is off because migration 281 is not applied',
  );
}

export function resetPeaceColumnsForTests(): void {
  columnsMissing = false;
  warned = false;
}

export function isPeaceSchemaMissing(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const record = err as PeaceQueryError;
  const code = typeof record.code === 'string' ? record.code : '';
  const message = `${record.message ?? ''} ${record.details ?? ''} ${record.hint ?? ''}`;
  if (!PEACE_COLUMN.test(message)) return false;
  if (code && COLUMN_CODES.has(code)) return true;
  return /column .*(opened_at|peace_seconds|peace_ref).* does not exist|could not find the '(opened_at|peace_seconds|peace_ref)' column/i.test(
    message,
  );
}

/** Exact `base` when peace is off or 281 is known missing. Otherwise `base, opened_at`. */
export function withOpenedAt(base: string): string {
  if (!env.enablePeacePeriod || columnsMissing) return base;
  return `${base}, opened_at`;
}

interface SessionQuery<T> {
  eq(column: string, value: string): SessionQuery<T>;
  not(column: string, operator: string, value: null): SessionQuery<T>;
  single(): PromiseLike<{ data: T | null; error: PeaceQueryError | null }>;
  maybeSingle(): PromiseLike<{ data: T | null; error: PeaceQueryError | null }>;
  then<R>(
    onfulfilled: (value: { data: T[] | null; error: PeaceQueryError | null }) => R | PromiseLike<R>,
    onrejected?: (reason: unknown) => R | PromiseLike<R>,
  ): Promise<R>;
}

/**
 * The generated client only types literal column lists. One bridge here keeps
 * every reader on a real row type. The string passed to PostgREST is `columns`.
 */
function sessionsQuery<T extends SessionClockFields>(columns: string): SessionQuery<T> {
  return supabaseAdmin.from('sessions').select(columns) as unknown as SessionQuery<T>;
}

export async function selectWithOpenedAt<T>(
  baseColumns: string,
  run: (columns: string) => PromiseLike<{ data: T; error: PeaceQueryError | null }>,
): Promise<{ data: T; error: PeaceQueryError | null }> {
  const columns = withOpenedAt(baseColumns);
  const first = await run(columns);
  if (columns !== baseColumns && first.error && isPeaceSchemaMissing(first.error)) {
    markPeaceColumnsMissing();
    return run(baseColumns);
  }
  return first;
}

export function selectSession<T extends SessionClockFields, D = T | null>(
  baseColumns: string,
  run: (query: SessionQuery<T>) => PromiseLike<{ data: D; error: PeaceQueryError | null }>,
): Promise<{ data: D; error: PeaceQueryError | null }> {
  return selectWithOpenedAt(baseColumns, (columns) => run(sessionsQuery<T>(columns)));
}

/** Start-claim payload after 281's columns were rejected. */
export function startClaimWithoutPeaceColumns(
  updates: Record<string, unknown>,
  openedAt: string,
): Record<string, unknown> {
  const next = { ...updates };
  delete next.opened_at;
  delete next.peace_seconds;
  next.start_time = openedAt;
  return next;
}
