import { createHash } from 'node:crypto';
import { canonicalJson } from '../../../shared/canonicalJson.js';
import {
  SETUP_EDIT_ALLOWANCE_IDS_MAX,
  SETUP_EDIT_HISTORY_LIMIT,
  SETUP_EDIT_HISTORY_READ_BATCH,
} from '../../../shared/setupEditAllowance.js';
import type { BaselineIdentity } from './setupSnapshotCore.js';

export { SETUP_EDIT_ALLOWANCE_IDS_MAX, SETUP_EDIT_HISTORY_LIMIT, SETUP_EDIT_HISTORY_READ_BATCH };

/** PostgREST / Postgres codes that mean migration 274 is not in this database. */
const SCHEMA_CODES = new Set(['42P01', '42703', '42883', 'PGRST202', 'PGRST204', 'PGRST205']);

const IN_FLIGHT = new Set(['open', 'applying']);

/** An apply that has not finished returns to open after this long. */
export const APPLY_HEARTBEAT_MS = 10 * 60 * 1000;

export function applyingIsStale(heartbeat: string | null | undefined, now: Date): boolean {
  if (!heartbeat) return true;
  const at = Date.parse(heartbeat);
  if (Number.isNaN(at)) return true;
  return now.getTime() - at >= APPLY_HEARTBEAT_MS;
}

/** Applying rows whose heartbeat is missing or older than the reclaim window. */
export function staleApplyIds(
  rows: ReadonlyArray<{ id: string; status: string; apply_heartbeat_at?: string | null }>,
  now: Date,
): string[] {
  return rows
    .filter((row) => row.status === 'applying' && applyingIsStale(row.apply_heartbeat_at ?? null, now))
    .map((row) => row.id);
}

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
  /** Absent on rows loaded before the wizard needed to resume a draft. */
  draft_id?: string | null;
  applied_summary?: unknown;
  opened_by_name?: string | null;
  /**
   * Frozen identity of this edit's baseline snapshot. Present on rows whose
   * baseline was loaded. The wizard uses this instead of the draft.
   */
  baseline_identity?: BaselineIdentity | null;
}

/** The in-flight row, if the list contains one. The list order is preserved. */
export function openEditOf<T extends { status: string }>(edits: readonly T[]): T | null {
  return edits.find((edit) => IN_FLIGHT.has(edit.status)) ?? null;
}

const TRAINER_HIDDEN = new Set(['abandoned', 'failed']);

/** Abandoned and failed edits are returned to admins only. Open edits stay, for resume. */
export function historyForViewer<T extends { status: string }>(edits: readonly T[], isAdmin: boolean): T[] {
  if (isAdmin) return [...edits];
  return edits.filter((edit) => !TRAINER_HIDDEN.has(edit.status));
}

/**
 * Keep the first `limit` rows of each scenario. Rows must already be newest-first,
 * which is the order the history query uses.
 */
export function capRowsPerScenario<T extends { scenario_id: string }>(
  rowsNewestFirst: readonly T[],
  limit: number,
): T[] {
  const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0;
  if (cap === 0) return [];
  const seen = new Map<string, number>();
  const kept: T[] = [];
  for (const row of rowsNewestFirst) {
    const count = seen.get(row.scenario_id) ?? 0;
    if (count >= cap) continue;
    seen.set(row.scenario_id, count + 1);
    kept.push(row);
  }
  return kept;
}

const ALLOWANCE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type AllowanceIdParse =
  | { ok: true; ids: string[] }
  | { ok: false; reason: 'empty' | 'invalid' | 'too_many' };

/** Comma-separated scenario ids for the library allowance read. Duplicates are dropped. */
export function parseAllowanceIds(raw: string): AllowanceIdParse {
  const parts = raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0) return { ok: false, reason: 'empty' };
  if (parts.length > SETUP_EDIT_ALLOWANCE_IDS_MAX) return { ok: false, reason: 'too_many' };
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    if (!ALLOWANCE_ID.test(part)) return { ok: false, reason: 'invalid' };
    const key = part.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    ids.push(part);
  }
  if (ids.length === 0) return { ok: false, reason: 'empty' };
  return { ok: true, ids };
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

export interface SetupEditAllowanceRows {
  used: number;
  edits: SetupEditSummary[];
}

export type ListAllowancesResult =
  | { available: false }
  | { available: true; byId: Record<string, SetupEditAllowanceRows> };
