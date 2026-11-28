import { supabaseAdmin } from '../../lib/supabaseAdmin.js';
import { logger } from '../../lib/logger.js';
import { activeTeams, activeTemplateInjects, stampOrgIdentity } from '../../lib/templateRows.js';
import { canonicalJson } from '../../../shared/canonicalJson.js';
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
import {
  baselineHash,
  draftInputFromSnapshot,
  snapshotFromScenario,
  type ScenarioSnapshotSource,
  type SnapshotInjectRow,
  type SnapshotTeamRow,
} from './setupSnapshotCore.js';

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
let buildsUnavailableLogged = false;

class SnapshotUnavailable extends Error {}

export interface AttachDraftContext {
  userId: string;
  remaining: number | null;
}

export type AttachDraftResult =
  | { available: false }
  | { available: true; ok: false; reason: 'not_found' | 'failed' }
  | { available: true; ok: true; draftId: string; baselineHash: string };

export function noteSetupEditsUnavailable(): void {
  if (unavailableLogged) return;
  unavailableLogged = true;
  logger.warn('scenario_setup_edits_unavailable');
}

function noteBuildsUnavailable(): void {
  if (buildsUnavailableLogged) return;
  buildsUnavailableLogged = true;
  logger.warn('warroom_builds_unavailable_for_setup_snapshot');
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

/**
 * After the allowance RPC inserts the placeholder baseline, store the real
 * snapshot and a step-1 wizard draft. Does not change setup_edits_used.
 * An older scenario is stamped with org_uid before the snapshot is taken.
 */
export async function attachOpenedDraft(
  scenarioId: string,
  editId: string,
  ctx: AttachDraftContext,
): Promise<AttachDraftResult> {
  const scenario = await supabaseAdmin
    .from('scenarios')
    .select('id, title, description, briefing, duration_minutes, initial_state')
    .eq('id', scenarioId)
    .maybeSingle<{
      id: string;
      title: string | null;
      description: string | null;
      briefing: string | null;
      duration_minutes: number | null;
      initial_state: unknown;
    }>();
  if (scenario.error) {
    if (isSetupEditSchemaMissing(scenario.error)) {
      noteSetupEditsUnavailable();
      return { available: false };
    }
    logger.error({ error: scenario.error, scenarioId }, 'Failed to load scenario for setup snapshot');
    throw new Error(`Setup snapshot failed: ${scenario.error.message}`);
  }
  if (!scenario.data) return { available: true, ok: false, reason: 'not_found' };

  const stamped = stampOrgIdentity(scenario.data.initial_state);
  if (canonicalJson(stamped) !== canonicalJson(scenario.data.initial_state)) {
    const written = await supabaseAdmin
      .from('scenarios')
      .update({ initial_state: stamped })
      .eq('id', scenarioId);
    if (written.error) {
      logger.error({ error: written.error, scenarioId }, 'Failed to stamp organisation identity');
      throw new Error(`Organisation identity stamp failed: ${written.error.message}`);
    }
  }

  let teams: SnapshotTeamRow[];
  let injects: SnapshotInjectRow[];
  let buildRequest: unknown;
  try {
    teams = await loadActiveTeams(scenarioId);
    injects = await loadActiveInjects(scenarioId);
    buildRequest = await loadBuildRequest(scenarioId, stamped);
  } catch (err) {
    if (err instanceof SnapshotUnavailable) return { available: false };
    throw err;
  }
  const source: ScenarioSnapshotSource = {
    scenario: {
      description: scenario.data.description,
      briefing: scenario.data.briefing,
      duration_minutes: scenario.data.duration_minutes,
      initial_state: stamped,
    },
    teams,
    injects,
    build_request: buildRequest,
  };
  const snapshot = snapshotFromScenario(source);
  const hash = baselineHash(snapshot);
  const input = draftInputFromSnapshot(snapshot, {
    edit_id: editId,
    scenario_id: scenarioId,
    scenario_title: scenario.data.title ?? '',
    remaining: ctx.remaining,
  });

  const draft = await supabaseAdmin
    .from('warroom_wizard_drafts')
    .insert({
      created_by: ctx.userId,
      status: 'draft',
      current_step: 1,
      input,
    })
    .select('id')
    .single<{ id: string }>();
  if (draft.error || !draft.data) {
    if (draft.error && isSetupEditSchemaMissing(draft.error)) {
      noteSetupEditsUnavailable();
      return { available: false };
    }
    logger.error({ error: draft.error, scenarioId, editId }, 'Failed to create setup edit draft');
    return { available: true, ok: false, reason: 'failed' };
  }

  const updated = await supabaseAdmin
    .from('scenario_setup_edits')
    .update({
      baseline: snapshot,
      baseline_hash: hash,
      draft_id: draft.data.id,
    })
    .eq('id', editId)
    .eq('scenario_id', scenarioId)
    .eq('status', 'open')
    .select('id')
    .maybeSingle<{ id: string }>();
  if (updated.error || !updated.data) {
    await supabaseAdmin.from('warroom_wizard_drafts').delete().eq('id', draft.data.id);
    if (updated.error && isSetupEditSchemaMissing(updated.error)) {
      noteSetupEditsUnavailable();
      return { available: false };
    }
    if (updated.error) {
      logger.error({ error: updated.error, scenarioId, editId }, 'Failed to store setup baseline');
      throw new Error(`Setup baseline update failed: ${updated.error.message}`);
    }
    return { available: true, ok: false, reason: 'failed' };
  }
  return { available: true, ok: true, draftId: draft.data.id, baselineHash: hash };
}

function columnMissing(
  err: { code?: string; message?: string; details?: string } | null,
  column: string,
): boolean {
  if (!err) return false;
  if (err.code !== '42703' && err.code !== 'PGRST204') return false;
  const message = `${err.message ?? ''} ${err.details ?? ''}`;
  return message.includes(column);
}

async function loadActiveTeams(scenarioId: string): Promise<SnapshotTeamRow[]> {
  const full =
    'id, team_uid, team_name, team_description, org_key, function_key, charter';
  const first = await activeTeams(
    supabaseAdmin.from('scenario_teams').select(full).eq('scenario_id', scenarioId),
  );
  if (!first.error) return (first.data ?? []) as SnapshotTeamRow[];
  if (columnMissing(first.error, 'team_uid')) {
    const second = await activeTeams(
      supabaseAdmin
        .from('scenario_teams')
        .select('id, team_name, team_description, org_key, function_key, charter')
        .eq('scenario_id', scenarioId),
    );
    if (second.error) {
      if (isSetupEditSchemaMissing(second.error)) {
        noteSetupEditsUnavailable();
        throw new SnapshotUnavailable();
      }
      throw new Error(`Setup snapshot teams failed: ${second.error.message}`);
    }
    return (second.data ?? []) as SnapshotTeamRow[];
  }
  if (isSetupEditSchemaMissing(first.error)) {
    noteSetupEditsUnavailable();
    throw new SnapshotUnavailable();
  }
  throw new Error(`Setup snapshot teams failed: ${first.error.message}`);
}

async function loadActiveInjects(scenarioId: string): Promise<SnapshotInjectRow[]> {
  const result = await activeTemplateInjects(
    supabaseAdmin
      .from('scenario_injects')
      .select('id, delivery_config')
      .eq('scenario_id', scenarioId)
      .is('session_id', null),
  );
  if (result.error) {
    if (isSetupEditSchemaMissing(result.error)) {
      noteSetupEditsUnavailable();
      throw new SnapshotUnavailable();
    }
    throw new Error(`Setup snapshot injects failed: ${result.error.message}`);
  }
  return (result.data ?? []) as SnapshotInjectRow[];
}

async function loadBuildRequest(scenarioId: string, state: unknown): Promise<unknown> {
  const record = state && typeof state === 'object' ? (state as Record<string, unknown>) : null;
  const stored = record?.setup_source;
  if (stored && typeof stored === 'object' && !Array.isArray(stored) && Object.keys(stored).length > 0) {
    return null;
  }
  const result = await supabaseAdmin
    .from('warroom_builds')
    .select('request')
    .eq('scenario_id', scenarioId)
    .order('created_at', { ascending: false })
    .limit(1);
  if (result.error) {
    if (isSetupEditSchemaMissing(result.error)) {
      noteBuildsUnavailable();
      return null;
    }
    logger.error({ error: result.error, scenarioId }, 'Failed to load build request for setup snapshot');
    throw new Error(`Setup snapshot build request failed: ${result.error.message}`);
  }
  const row = (result.data ?? [])[0] as { request?: unknown } | undefined;
  return row?.request ?? null;
}

export const setupEditService = {
  get: getSetupEdit,
  open: openSetupEdit,
  abandon: abandonSetupEdit,
  attachOpenedDraft,
};
