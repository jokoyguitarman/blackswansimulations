import { supabaseAdmin } from '../../lib/supabaseAdmin.js';
import { logger } from '../../lib/logger.js';
import { activeTeams, activeTemplateInjects, stampOrgIdentity } from '../../lib/templateRows.js';
import {
  cloneCasualtyRows,
  cloneColumnRows,
  cloneHazardRows,
  cloneInjectRows,
  cloneObjectiveRows,
  cloneScenarioInsert,
  cloneSceneRows,
  cloneTeamRows,
  EQUIPMENT_CLONE_COLUMNS,
  FLOOR_PLAN_CLONE_COLUMNS,
  isCloneSchemaError,
  missingColumnName,
  OPTIONAL_CLONE_TABLES,
  resolveCloneTitle,
  SCENARIO_SOURCE_COLUMNS,
  SOP_CLONE_COLUMNS,
  type CloneFailure,
} from './cloneColumns.js';

/**
 * Full-fidelity clone. The route calls clone_scenario (migration 276) so the
 * copy is one transaction. When that function is missing, or it fails because
 * the database schema doesn't match the column list, the same copy runs here.
 * Child-table failures are logged and the new scenario is still returned.
 */

export interface ClonePayload {
  data: unknown;
  error: CloneFailure | null;
}

export interface CloneQuery extends PromiseLike<ClonePayload> {
  select(columns: string): CloneQuery;
  insert(values: unknown): CloneQuery;
  update(values: Record<string, unknown>): CloneQuery;
  eq(column: string, value: unknown): CloneQuery;
  is(column: string, value: null): CloneQuery;
  single(): Promise<ClonePayload>;
  maybeSingle(): Promise<ClonePayload>;
}

export interface CloneDb {
  rpc(fn: string, args: Record<string, unknown>): Promise<ClonePayload>;
  from(table: string): CloneQuery;
}

export type CloneScenarioResult =
  { ok: true; id: string; via: 'rpc' | 'rows' } | { ok: false; status: 404 | 500; error: string };

const SESSION_SCOPED = new Set(['scenario_hazards', 'scenario_casualties']);
const MISSING_RELATION = new Set(['42P01', 'PGRST205']);

let rpcWarned = false;
let schemaWarned = false;

export function resetCloneFallbackForTests(): void {
  rpcWarned = false;
  schemaWarned = false;
}

function noteRpcUnavailable(): void {
  if (rpcWarned) return;
  rpcWarned = true;
  logger.warn(
    { event: 'clone_scenario_rpc_unavailable' },
    'clone_scenario is unavailable; cloning by copying rows',
  );
}

function noteSchemaGap(table: string, column: string | null): void {
  if (schemaWarned) return;
  schemaWarned = true;
  logger.warn(
    { event: 'clone_schema_gap', table, column },
    'Scenario clone skipped a column or table this database does not have',
  );
}

function rowsOf(data: unknown): Record<string, unknown>[] {
  if (!data) return [];
  if (Array.isArray(data))
    return data.filter((row) => row && typeof row === 'object') as Record<string, unknown>[];
  if (typeof data === 'object') return [data as Record<string, unknown>];
  return [];
}

function rpcScenarioId(data: unknown): string | null {
  if (typeof data === 'string' && data.trim()) return data.trim();
  if (Array.isArray(data)) return data.length > 0 ? rpcScenarioId(data[0]) : null;
  if (data && typeof data === 'object') {
    const id = (data as Record<string, unknown>).clone_scenario;
    if (typeof id === 'string' && id.trim()) return id.trim();
  }
  return null;
}

function isMissingRelation(err: CloneFailure | null): boolean {
  if (!err) return false;
  if (err.code && MISSING_RELATION.has(err.code)) return true;
  return /relation .* does not exist|could not find the table/i.test(
    `${err.message ?? ''} ${err.details ?? ''}`,
  );
}

async function insertRows(
  db: CloneDb,
  table: string,
  rows: Record<string, unknown>[],
): Promise<CloneFailure | null> {
  if (rows.length === 0) return null;
  let payload = rows.map((row) => ({ ...row }));
  const dropped = new Set<string>();
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const { error } = await db.from(table).insert(payload);
    if (!error) return null;
    const column = missingColumnName(error);
    if (!column || dropped.has(column) || !payload.some((row) => column in row)) return error;
    dropped.add(column);
    noteSchemaGap(table, column);
    payload = payload.map((row) => {
      const next = { ...row };
      delete next[column];
      return next;
    });
  }
  return { message: `clone insert into ${table} exceeded column retries` };
}

async function readScenario(
  db: CloneDb,
  scenarioId: string,
): Promise<{ row: Record<string, unknown> | null; error: CloneFailure | null }> {
  let columns: string[] = [...SCENARIO_SOURCE_COLUMNS];
  const dropped = new Set<string>();
  for (let attempt = 0; attempt < columns.length + 1; attempt += 1) {
    const result = await db
      .from('scenarios')
      .select(columns.join(', '))
      .eq('id', scenarioId)
      .maybeSingle();
    if (!result.error) {
      return { row: (result.data as Record<string, unknown> | null) ?? null, error: null };
    }
    const column = missingColumnName(result.error);
    if (!column || dropped.has(column) || !columns.includes(column)) {
      return { row: null, error: result.error };
    }
    dropped.add(column);
    noteSchemaGap('scenarios', column);
    columns = columns.filter((name) => name !== column);
  }
  return { row: null, error: { message: 'scenario read exceeded column retries' } };
}

async function insertScenario(
  db: CloneDb,
  row: Record<string, unknown>,
): Promise<{ id: string | null; error: CloneFailure | null }> {
  let payload = { ...row };
  const dropped = new Set<string>();
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const result = await db.from('scenarios').insert(payload).select('id').single();
    if (!result.error) {
      const id = (result.data as { id?: unknown } | null)?.id;
      return typeof id === 'string'
        ? { id, error: null }
        : { id: null, error: { message: 'clone insert returned no id' } };
    }
    const column = missingColumnName(result.error);
    if (!column || dropped.has(column) || !(column in payload))
      return { id: null, error: result.error };
    dropped.add(column);
    noteSchemaGap('scenarios', column);
    delete payload[column];
    payload = { ...payload };
  }
  return { id: null, error: { message: 'scenario insert exceeded column retries' } };
}

async function stampCopiedState(db: CloneDb, scenarioId: string): Promise<void> {
  const loaded = await db
    .from('scenarios')
    .select('initial_state')
    .eq('id', scenarioId)
    .maybeSingle();
  if (loaded.error || !loaded.data || typeof loaded.data !== 'object') {
    logger.error(
      { error: loaded.error, scenarioId },
      'Cloned scenario was created but its initial state could not be read for org identity',
    );
    return;
  }
  const current = (loaded.data as { initial_state?: unknown }).initial_state;
  const stamped = stampOrgIdentity(current);
  if (JSON.stringify(stamped) === JSON.stringify(current)) return;
  const updated = await db
    .from('scenarios')
    .update({ initial_state: stamped })
    .eq('id', scenarioId);
  if (updated.error) {
    logger.error(
      { error: updated.error, scenarioId },
      'Cloned scenario was created but org identity was not stamped',
    );
  }
}

async function copyChildren(
  db: CloneDb,
  sourceId: string,
  scenarioId: string,
  createdBy: string,
): Promise<void> {
  let hazardIds = new Map<string, string>();
  for (const table of OPTIONAL_CLONE_TABLES) {
    let query = db.from(table).select('*').eq('scenario_id', sourceId);
    if (SESSION_SCOPED.has(table)) query = query.is('session_id', null);
    const result = await query;
    if (result.error) {
      if (isMissingRelation(result.error)) {
        noteSchemaGap(table, null);
        continue;
      }
      logger.error({ error: result.error, table, scenarioId }, 'Failed to read rows for cloning');
      continue;
    }
    const source = rowsOf(result.data);
    let rows: Record<string, unknown>[] = [];
    let parentLinks: Array<{ id: string; parentId: string }> = [];
    if (table === 'scenario_objectives') rows = cloneObjectiveRows(source, scenarioId);
    else if (table === 'sop_definitions')
      rows = cloneColumnRows(source, SOP_CLONE_COLUMNS, scenarioId);
    else if (table === 'scenario_equipment') {
      rows = cloneColumnRows(source, EQUIPMENT_CLONE_COLUMNS, scenarioId);
    } else if (table === 'scenario_floor_plans') {
      rows = cloneColumnRows(source, FLOOR_PLAN_CLONE_COLUMNS, scenarioId);
    } else if (table === 'rts_scene_configs') rows = cloneSceneRows(source, scenarioId, createdBy);
    else if (table === 'scenario_hazards') {
      const plan = cloneHazardRows(source, scenarioId);
      rows = plan.rows;
      parentLinks = plan.parentLinks;
      hazardIds = plan.idMap;
    } else if (table === 'scenario_casualties') {
      rows = cloneCasualtyRows(source, scenarioId, hazardIds);
    }
    const error = await insertRows(db, table, rows);
    if (error) {
      logger.error(
        { error, table, scenarioId },
        'Failed to clone rows; the scenario was still created',
      );
      continue;
    }
    for (const link of parentLinks) {
      const updated = await db
        .from(table)
        .update({ parent_pin_id: link.parentId })
        .eq('id', link.id);
      if (updated.error) {
        logger.error(
          { error: updated.error, table, scenarioId },
          'Failed to relink a cloned hazard to its parent pin',
        );
      }
    }
  }
}

async function cloneByRows(
  db: CloneDb,
  input: { scenarioId: string; userId: string; title: string | null; nowIso: string },
): Promise<CloneScenarioResult> {
  const source = await readScenario(db, input.scenarioId);
  if (source.error) {
    logger.error(
      { error: source.error, scenarioId: input.scenarioId },
      'Failed to read scenario for cloning',
    );
    return { ok: false, status: 500, error: 'Failed to clone scenario' };
  }
  if (!source.row) return { ok: false, status: 404, error: 'Scenario not found' };

  const title = resolveCloneTitle(String(source.row.title ?? ''), input.title);
  const inserted = await insertScenario(
    db,
    cloneScenarioInsert(source.row, { title, createdBy: input.userId }),
  );
  if (inserted.error || !inserted.id) {
    logger.error(
      { error: inserted.error, scenarioId: input.scenarioId },
      'Failed to clone scenario',
    );
    return { ok: false, status: 500, error: 'Failed to clone scenario' };
  }

  // templateRows-allow: this read is the clone writer; activeTeams drops retired rows.
  const teams = await activeTeams(
    db.from('scenario_teams').select('*').eq('scenario_id', input.scenarioId),
  );
  if (teams.error) {
    logger.error(
      { error: teams.error, scenarioId: inserted.id },
      'Failed to read teams for cloning',
    );
  } else {
    const teamError = await insertRows(
      db,
      'scenario_teams',
      cloneTeamRows(rowsOf(teams.data), inserted.id, input.nowIso),
    );
    if (teamError) {
      logger.error(
        { error: teamError, scenarioId: inserted.id },
        'Failed to clone teams; the scenario was still created',
      );
    }
  }

  // templateRows-allow: template inject read for the clone writer.
  const injects = await activeTemplateInjects(
    db
      .from('scenario_injects')
      .select('*')
      .eq('scenario_id', input.scenarioId)
      .is('session_id', null),
  );
  if (injects.error) {
    logger.error(
      { error: injects.error, scenarioId: inserted.id },
      'Failed to read injects for cloning',
    );
  } else {
    const injectError = await insertRows(
      db,
      'scenario_injects',
      cloneInjectRows(rowsOf(injects.data), inserted.id, input.nowIso),
    );
    if (injectError) {
      logger.error(
        { error: injectError, scenarioId: inserted.id },
        'Failed to clone injects; the scenario was still created',
      );
    }
  }

  await copyChildren(db, input.scenarioId, inserted.id, input.userId);
  return { ok: true, id: inserted.id, via: 'rows' };
}

export async function cloneScenario(
  db: CloneDb,
  input: { scenarioId: string; userId: string; title: string | null; now?: Date },
): Promise<CloneScenarioResult> {
  const nowIso = (input.now ?? new Date()).toISOString();
  const rpc = await db.rpc('clone_scenario', {
    p_scenario_id: input.scenarioId,
    p_user_id: input.userId,
    p_title: input.title,
  });
  if (rpc.error) {
    if (!isCloneSchemaError(rpc.error)) {
      logger.error({ error: rpc.error, scenarioId: input.scenarioId }, 'clone_scenario failed');
      return { ok: false, status: 500, error: 'Failed to clone scenario' };
    }
    noteRpcUnavailable();
    return cloneByRows(db, { ...input, nowIso });
  }
  const id = rpcScenarioId(rpc.data);
  if (!id) return { ok: false, status: 404, error: 'Scenario not found' };
  await stampCopiedState(db, id);
  return { ok: true, id, via: 'rpc' };
}

export const scenarioCloneDb = supabaseAdmin as unknown as CloneDb;
