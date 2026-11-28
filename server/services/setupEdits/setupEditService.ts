import { supabaseAdmin } from '../../lib/supabaseAdmin.js';
import { logger } from '../../lib/logger.js';
import { activeObjectives, activeTeams, activeTemplateInjects, stampOrgIdentity } from '../../lib/templateRows.js';
import { backfillDependencyTeamUids } from '../../../shared/teamDependencies.js';
import { canonicalJson } from '../../../shared/canonicalJson.js';
import { isAdmin } from '../creditService.js';
import { env } from '../../env.js';
import {
  isSetupEditSchemaMissing,
  staleApplyIds,
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
  materializeLegacyPrimary,
  snapshotFromScenario,
  stableOrgUid,
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
  'id, opened_by, opened_by_admin, status, edit_number, counted, error, created_at, applied_at, draft_id, applied_summary';

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

type PersistIdentityResult = { ok: true; state: unknown } | { ok: false; reason: 'conflict' };

function stampScenarioIdentity(
  initialState: unknown,
  scenarioId: string,
  teams: readonly { team_uid?: string | null; team_name?: string | null }[],
): unknown {
  return backfillDependencyTeamUids(
    stampOrgIdentity(materializeLegacyPrimary(initialState, scenarioId)),
    teams,
  );
}

/**
 * Write org_uid stamps only when the scenario row is still the one we read.
 * A concurrent save wins the first attempt. Re-read once and try again. If
 * that write also misses, the caller abandons the edit instead of snapshotting
 * uids that were never saved.
 */
async function persistOrgIdentity(
  scenarioId: string,
  updatedAt: string | null,
  initialState: unknown,
  teams: readonly { team_uid?: string | null; team_name?: string | null }[],
): Promise<PersistIdentityResult> {
  const next = stampScenarioIdentity(initialState, scenarioId, teams);
  if (canonicalJson(next) === canonicalJson(initialState)) return { ok: true, state: initialState };
  if (await writeIdentity(scenarioId, updatedAt, next)) return { ok: true, state: next };

  const again = await supabaseAdmin
    .from('scenarios')
    .select('initial_state, updated_at')
    .eq('id', scenarioId)
    .maybeSingle<{ initial_state: unknown; updated_at: string | null }>();
  if (again.error || !again.data) return { ok: false, reason: 'conflict' };
  const restamped = stampScenarioIdentity(again.data.initial_state, scenarioId, teams);
  if (canonicalJson(restamped) === canonicalJson(again.data.initial_state)) {
    return { ok: true, state: again.data.initial_state };
  }
  if (await writeIdentity(scenarioId, again.data.updated_at, restamped)) {
    return { ok: true, state: restamped };
  }
  return { ok: false, reason: 'conflict' };
}

async function writeIdentity(
  scenarioId: string,
  updatedAt: string | null,
  initialState: unknown,
): Promise<boolean> {
  let query = supabaseAdmin
    .from('scenarios')
    .update({ initial_state: initialState })
    .eq('id', scenarioId);
  if (typeof updatedAt === 'string' && updatedAt) query = query.eq('updated_at', updatedAt);
  const written = await query.select('id');
  if (written.error) {
    logger.error({ error: written.error, scenarioId }, 'Failed to stamp organisation identity');
    throw new Error(`Organisation identity stamp failed: ${written.error.message}`);
  }
  return Array.isArray(written.data) && written.data.length > 0;
}

export interface AttachDraftContext {
  userId: string;
  remaining: number | null;
}

export type AttachDraftResult =
  | { available: false }
  | { available: true; ok: false; reason: 'not_found' | 'failed' | 'conflict' }
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
    draft_id: typeof row.draft_id === 'string' ? row.draft_id : null,
    applied_summary: row.applied_summary ?? null,
  };
}

export interface AppliedSetupChange {
  id: string;
  applied_at: string;
  edit_number: number | null;
  opened_by_admin: boolean;
  opened_by_name: string | null;
  summary: unknown;
}

/**
 * Applied edits whose apply time is after the session was created.
 * A missing migration 274 is "no changes", not an error.
 */
export async function listAppliedSetupChanges(
  scenarioId: string,
  createdAt: string,
): Promise<{ available: boolean; changes: AppliedSetupChange[] }> {
  const listed = await supabaseAdmin
    .from('scenario_setup_edits')
    .select('id, applied_at, edit_number, opened_by, opened_by_admin, applied_summary')
    .eq('scenario_id', scenarioId)
    .eq('status', 'applied')
    .gt('applied_at', createdAt)
    .order('applied_at', { ascending: true });
  if (listed.error) {
    if (isSetupEditSchemaMissing(listed.error)) {
      noteSetupEditsUnavailable();
      return { available: false, changes: [] };
    }
    logger.error({ error: listed.error, scenarioId }, 'Failed to list setup changes for a session');
    throw new Error(`Setup change list failed: ${listed.error.message}`);
  }
  const rows = (listed.data ?? []) as Array<Record<string, unknown>>;
  const names = await openerNames(rows.map((row) => (typeof row.opened_by === 'string' ? row.opened_by : '')));
  return {
    available: true,
    changes: rows
      .filter((row) => typeof row.applied_at === 'string')
      .map((row) => ({
        id: String(row.id),
        applied_at: String(row.applied_at),
        edit_number: row.edit_number == null ? null : Number(row.edit_number),
        opened_by_admin: Boolean(row.opened_by_admin),
        opened_by_name: typeof row.opened_by === 'string' ? (names.get(row.opened_by) ?? null) : null,
        summary: row.applied_summary ?? null,
      })),
  };
}

async function openerNames(ids: readonly string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id) => id.length > 0))];
  if (unique.length === 0) return new Map();
  try {
    const profiles = await supabaseAdmin.from('user_profiles').select('id, full_name').in('id', unique);
    if (profiles.error || !Array.isArray(profiles.data)) return new Map();
    const names = new Map<string, string>();
    for (const row of profiles.data as Array<{ id?: string; full_name?: string | null }>) {
      if (typeof row.id === 'string' && typeof row.full_name === 'string' && row.full_name.trim()) {
        names.set(row.id, row.full_name.trim());
      }
    }
    return names;
  } catch (err) {
    logger.warn({ err }, 'setup_edit_opener_names_unavailable');
    return new Map();
  }
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

  const listed = await listEditRows(scenarioId);
  if (listed === 'unavailable') return { available: false };

  const now = new Date();
  const stale = new Set(
    staleApplyIds(
      listed.map((row) => ({
        id: String(row.id),
        status: String(row.status),
        apply_heartbeat_at:
          typeof row.apply_heartbeat_at === 'string' ? row.apply_heartbeat_at : null,
      })),
      now,
    ),
  );
  for (const id of stale) {
    const released = await supabaseAdmin
      .from('scenario_setup_edits')
      .update({ status: 'open', error: null })
      .eq('id', id)
      .eq('scenario_id', scenarioId)
      .eq('status', 'applying')
      .select('id');
    if (released.error) {
      logger.error({ error: released.error, scenarioId, editId: id }, 'Failed to reclaim a stale apply');
      throw new Error(`Setup edit reclaim failed: ${released.error.message}`);
    }
  }

  const used = Number(scenario.data.setup_edits_used);
  const edits = listed.map((row) => toSummary(stale.has(String(row.id)) ? { ...row, status: 'open' } : row));
  const names = await openerNames(edits.map((edit) => edit.opened_by ?? ''));
  return {
    available: true,
    found: true,
    used: Number.isFinite(used) ? used : 0,
    edits: edits.map((edit) => ({
      ...edit,
      opened_by_name: edit.opened_by ? (names.get(edit.opened_by) ?? null) : null,
    })),
  };
}

async function listEditRows(
  scenarioId: string,
): Promise<Array<Record<string, unknown>> | 'unavailable'> {
  const first = await supabaseAdmin
    .from('scenario_setup_edits')
    .select(`${EDIT_COLUMNS}, apply_heartbeat_at`)
    .eq('scenario_id', scenarioId)
    .order('created_at', { ascending: false });
  if (!first.error) return (first.data ?? []) as unknown as Array<Record<string, unknown>>;
  if (!columnMissing(first.error, 'apply_heartbeat_at')) {
    if (isSetupEditSchemaMissing(first.error)) {
      noteSetupEditsUnavailable();
      return 'unavailable';
    }
    logger.error({ error: first.error, scenarioId }, 'Failed to list setup edits');
    throw new Error(`Setup edit list failed: ${first.error.message}`);
  }
  const second = await supabaseAdmin
    .from('scenario_setup_edits')
    .select(EDIT_COLUMNS)
    .eq('scenario_id', scenarioId)
    .order('created_at', { ascending: false });
  if (second.error) {
    if (isSetupEditSchemaMissing(second.error)) {
      noteSetupEditsUnavailable();
      return 'unavailable';
    }
    logger.error({ error: second.error, scenarioId }, 'Failed to list setup edits');
    throw new Error(`Setup edit list failed: ${second.error.message}`);
  }
  return (second.data ?? []) as unknown as Array<Record<string, unknown>>;
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
    .select('id, title, description, briefing, duration_minutes, initial_state, updated_at')
    .eq('id', scenarioId)
    .maybeSingle<{
      id: string;
      title: string | null;
      description: string | null;
      briefing: string | null;
      duration_minutes: number | null;
      initial_state: unknown;
      updated_at: string | null;
    }>();
  if (scenario.error) {
    if (isSetupEditSchemaMissing(scenario.error)) {
      noteSetupEditsUnavailable();
      return { available: false };
    }
    logger.error(
      { error: scenario.error, scenarioId },
      'Failed to load scenario for setup snapshot',
    );
    throw new Error(`Setup snapshot failed: ${scenario.error.message}`);
  }
  if (!scenario.data) return { available: true, ok: false, reason: 'not_found' };

  let teams: SnapshotTeamRow[];
  try {
    teams = await loadActiveTeams(scenarioId);
  } catch (err) {
    if (err instanceof SnapshotUnavailable) {
      await persistOrgIdentity(
        scenarioId,
        scenario.data.updated_at,
        scenario.data.initial_state,
        [],
      );
      return { available: false };
    }
    throw err;
  }

  const persisted = await persistOrgIdentity(
    scenarioId,
    scenario.data.updated_at,
    scenario.data.initial_state,
    teams,
  );
  if (!persisted.ok) return { available: true, ok: false, reason: 'conflict' };
  const stamped = persisted.state;

  let injects: SnapshotInjectRow[];
  let objectives: ScenarioSnapshotSource['objectives'];
  let buildRequest: unknown;
  try {
    injects = await loadActiveInjects(scenarioId);
    objectives = await loadObjectiveTexts(scenarioId);
    buildRequest = await loadBuildRequest(scenarioId, stamped);
  } catch (err) {
    if (err instanceof SnapshotUnavailable) return { available: false };
    throw err;
  }
  const source: ScenarioSnapshotSource = {
    scenario: {
      title: scenario.data.title,
      description: scenario.data.description,
      briefing: scenario.data.briefing,
      duration_minutes: scenario.data.duration_minutes,
      initial_state: stamped,
    },
    teams,
    injects,
    objectives,
    build_request: buildRequest,
  };
  const snapshot = snapshotFromScenario(source, {
    assignOrgUid: (orgKey) => stableOrgUid(scenarioId, orgKey),
  });
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
  const full = 'id, team_uid, team_name, team_description, org_key, function_key, charter';
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

async function loadObjectiveTexts(scenarioId: string): Promise<ScenarioSnapshotSource['objectives']> {
  const result = await activeObjectives(
    supabaseAdmin
      .from('scenario_objectives')
      .select('objective_id, objective_name, description')
      .eq('scenario_id', scenarioId),
  );
  if (result.error) {
    if (isSetupEditSchemaMissing(result.error)) {
      noteSetupEditsUnavailable();
      throw new SnapshotUnavailable();
    }
    throw new Error(`Setup snapshot objectives failed: ${result.error.message}`);
  }
  return (result.data ?? []) as NonNullable<ScenarioSnapshotSource['objectives']>;
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
  if (
    stored &&
    typeof stored === 'object' &&
    !Array.isArray(stored) &&
    Object.keys(stored).length > 0
  ) {
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
    logger.error(
      { error: result.error, scenarioId },
      'Failed to load build request for setup snapshot',
    );
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
