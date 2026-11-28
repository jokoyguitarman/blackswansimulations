import { createHash } from 'node:crypto';
import { canonicalJson } from '../../../shared/canonicalJson.js';

/** PostgREST / Postgres codes that mean migration 274 is not in this database. */
const SCHEMA_CODES = new Set(['42P01', '42703', '42883', 'PGRST202', 'PGRST204', 'PGRST205']);

const IN_FLIGHT = new Set(['open', 'applying']);

export const EMPTY_SETUP_BASELINE: Record<string, never> = {};

/** SHA-256 of the canonical JSON for the empty baseline stored until the snapshot exists. */
export function emptySetupBaselineHash(): string {
  return createHash('sha256').update(canonicalJson(EMPTY_SETUP_BASELINE)).digest('hex');
}

export function isSetupEditSchemaMissing(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' && SCHEMA_CODES.has(code);
}

/**
 * Applied edits still available. Null means unlimited (an admin, whose edits
 * are not counted).
 */
export function remainingEdits(used: number, limit: number, isAdmin: boolean): number | null {
  if (isAdmin) return null;
  return Math.max(0, limit - Math.max(0, used));
}

/** Whether a new edit may be opened. An existing open edit is resumed separately. */
export function canOpen(used: number, limit: number, isAdmin: boolean): boolean {
  if (isAdmin) return true;
  return Math.max(0, used) < limit;
}

export type SetupEditStatus = 'open' | 'applying' | 'applied' | 'abandoned' | 'failed';

export interface SetupEditSummary {
  id: string;
  status: SetupEditStatus;
  opened_by: string | null;
  opened_by_admin: boolean;
  edit_number: number | null;
  counted: boolean;
  error: string | null;
  created_at: string;
  applied_at: string | null;
}

/** The in-flight row, if the list contains one. The list order is preserved. */
export function openEditOf<T extends { status: string }>(edits: readonly T[]): T | null {
  return edits.find((edit) => IN_FLIGHT.has(edit.status)) ?? null;
}

export type OpenSetupEditOutcome = 'opened' | 'existing' | 'busy' | 'limit_reached' | 'not_found';

export type SetupEditSnapshot =
  | { available: false }
  | { available: true; found: false }
  | { available: true; found: true; used: number; edits: SetupEditSummary[] };

export type OpenSetupEditResult =
  { available: false } | { available: true; outcome: OpenSetupEditOutcome; editId: string | null };

export type AbandonSetupEditResult =
  { available: false } | { available: true; outcome: 'abandoned' | 'not_found' | 'not_open' };
