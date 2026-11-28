import { supabaseAdmin } from '../../lib/supabaseAdmin.js';
import { logger } from '../../lib/logger.js';
import { isAdmin } from '../creditService.js';
import { env } from '../../env.js';
import {
  isSetupEditSchemaMissing,
  type AbandonSetupEditResult,
  type OpenSetupEditOutcome,
  type OpenSetupEditResult,
  type SetupEditSnapshot,
  type SetupEditStatus,
  type SetupEditSummary,
} from './setupEditCore.js';

/**
 * Setup-edit allowance. scenarios.setup_edits_used changes only inside the
 * SQL count function in migration 274, which the apply path calls. Opening
 * and abandoning do not. A missing migration reports the feature unavailable
 * and warns once per process.
 */

const EDIT_COLUMNS =
  'id, opened_by, opened_by_admin, status, edit_number, counted, error, created_at, applied_at';

const OPEN_OUTCOMES = new Set<OpenSetupEditOutcome>([
  'opened',
  'existing',
  'busy',
  'limit_reached',
  'not_found',
]);

let unavailableLogged = false;

export function noteSetupEditsUnavailable(): void {
  if (unavailableLogged) return;
  unavailableLogged = true;
  logger.warn('scenario_setup_edits_unavailable');
}

function firstRow<T>(data: T[] | T | null | undefined): T | null {
  if (!data) return null;
  return Array.isArray(data) ? (data[0] ?? null) : data;
}

function toSummary(row: Record<string, unknown>): SetupEditSummary {
  const status = String(row.status) as SetupEditStatus;
  return {
    id: String(row.id),
    status,
    opened_by: typeof row.opened_by === 'string' ? row.opened_by : null,
    opened_by_admin: Boolean(row.opened_by_admin),
    edit_number: row.edit_number == null ? null : Number(row.edit_number),
    counted: Boolean(row.counted),
    error: typeof row.error === 'string' ? row.error : null,
    created_at: String(row.created_at),
    applied_at: typeof row.applied_at === 'string' ? row.applied_at : null,
  };
}

export async function getSetupEdit(scenarioId: string): Promise<SetupEditSnapshot> {
  const scenario = await supabaseAdmin
    .from('scenarios')
    .select('setup_edits_used')
    .eq('id', scenarioId)
    .maybeSingle<{ setup_edits_used: number }>();
  if (scenario.error) {
    if (isSetupEditSchemaMissing(scenario.error)) {
      noteSetupEditsUnavailable();
      return { available: false };
    }
    logger.error({ error: scenario.error, scenarioId }, 'Failed to read setup edit allowance');
    throw new Error(`Setup edit allowance failed: ${scenario.error.message}`);
  }
  if (!scenario.data) return { available: true, found: false };

  const edits = await supabaseAdmin
    .from('scenario_setup_edits')
    .select(EDIT_COLUMNS)
    .eq('scenario_id', scenarioId)
    .order('created_at', { ascending: false });
  if (edits.error) {
    if (isSetupEditSchemaMissing(edits.error)) {
      noteSetupEditsUnavailable();
      return { available: false };
    }
    logger.error({ error: edits.error, scenarioId }, 'Failed to list setup edits');
    throw new Error(`Setup edit list failed: ${edits.error.message}`);
  }

  const used = Number(scenario.data.setup_edits_used);
  return {
    available: true,
    found: true,
    used: Number.isFinite(used) ? used : 0,
    edits: ((edits.data ?? []) as unknown as Array<Record<string, unknown>>).map(toSummary),
  };
}

export async function openSetupEdit(
  scenarioId: string,
  user: { id: string; role?: string },
): Promise<OpenSetupEditResult> {
  const { data, error } = await supabaseAdmin.rpc('open_scenario_setup_edit', {
    p_scenario_id: scenarioId,
    p_user_id: user.id,
    p_is_admin: isAdmin(user),
    p_limit: env.scenarioSetupEditLimit,
  });
  if (error) {
    if (isSetupEditSchemaMissing(error)) {
      noteSetupEditsUnavailable();
      return { available: false };
    }
    logger.error({ error, scenarioId }, 'Failed to open setup edit');
    throw new Error(`Open setup edit failed: ${error.message}`);
  }
  const row = firstRow(data as { out_edit_id: string | null; out_outcome: string }[] | null);
  if (!row || !OPEN_OUTCOMES.has(row.out_outcome as OpenSetupEditOutcome)) {
    throw new Error('open_scenario_setup_edit returned no row');
  }
  return {
    available: true,
    outcome: row.out_outcome as OpenSetupEditOutcome,
    editId: row.out_edit_id,
  };
}

export async function abandonSetupEdit(
  scenarioId: string,
  editId: string,
): Promise<AbandonSetupEditResult> {
  const updated = await supabaseAdmin
    .from('scenario_setup_edits')
    .update({ status: 'abandoned' })
    .eq('id', editId)
    .eq('scenario_id', scenarioId)
    .eq('status', 'open')
    .select('id')
    .maybeSingle<{ id: string }>();
  if (updated.error) {
    if (isSetupEditSchemaMissing(updated.error)) {
      noteSetupEditsUnavailable();
      return { available: false };
    }
    logger.error({ error: updated.error, scenarioId, editId }, 'Failed to abandon setup edit');
    throw new Error(`Abandon setup edit failed: ${updated.error.message}`);
  }
  if (updated.data) return { available: true, outcome: 'abandoned' };

  const existing = await supabaseAdmin
    .from('scenario_setup_edits')
    .select('id')
    .eq('id', editId)
    .eq('scenario_id', scenarioId)
    .maybeSingle<{ id: string }>();
  if (existing.error) {
    if (isSetupEditSchemaMissing(existing.error)) {
      noteSetupEditsUnavailable();
      return { available: false };
    }
    logger.error({ error: existing.error, scenarioId, editId }, 'Failed to read setup edit');
    throw new Error(`Setup edit lookup failed: ${existing.error.message}`);
  }
  if (!existing.data) return { available: true, outcome: 'not_found' };
  return { available: true, outcome: 'not_open' };
}

export const setupEditService = {
  get: getSetupEdit,
  open: openSetupEdit,
  abandon: abandonSetupEdit,
};
