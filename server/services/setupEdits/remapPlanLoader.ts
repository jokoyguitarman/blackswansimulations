import { INJECT_ROW_COLUMNS, TEAM_ROW_COLUMNS } from '../scenarioClone/cloneColumns.js';
import { supabaseAdmin } from '../../lib/supabaseAdmin.js';
import { logger } from '../../lib/logger.js';
import { activeTeams, activeTemplateInjects } from '../../lib/templateRows.js';
import { textOf as text } from './jsonValue.js';
import type { LobbySession, PlannerInject, PlannerTeam } from './remapPlanner.js';

/**
 * Loads the current scenario state the remap planner reads.
 * Tables from migrations 268–273 that are not on this database are empty.
 * session_call_lines, session_call_takers and session_role_assignments are
 * migration 271 and are absent until that migration is approved.
 */

const MISSING_CODES = new Set(['42P01', '42703', '42883', 'PGRST202', 'PGRST204', 'PGRST205']);

const TEAM_COLUMNS = TEAM_ROW_COLUMNS.join(', ');
const TEAM_COLUMNS_LEGACY =
  'id, team_name, org_key, function_key, team_description, charter, expected_actions, scoring_rubric';

const INJECT_COLUMNS = INJECT_ROW_COLUMNS.join(', ');

export interface RemapState {
  initial_state: unknown;
  teams: PlannerTeam[];
  injects: PlannerInject[];
  sessions: LobbySession[];
}

let warned = false;

export function resetRemapLoaderWarningForTests(): void {
  warned = false;
}

export function isRemapTableMissing(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' && MISSING_CODES.has(code);
}

function warnMissing(table: string): void {
  if (warned) return;
  warned = true;
  logger.warn(
    { event: 'remap_optional_tables_unavailable', table },
    'Remap planning is treating an absent lobby or history table as empty',
  );
}

interface QueryResult {
  data: unknown;
  error: { code?: string; message?: string } | null;
}

async function readOptional(
  table: string,
  query: PromiseLike<QueryResult>,
): Promise<Record<string, unknown>[]> {
  try {
    const result = await query;
    if (result.error) {
      if (isRemapTableMissing(result.error)) {
        warnMissing(table);
        return [];
      }
      throw result.error;
    }
    return Array.isArray(result.data) ? (result.data as Record<string, unknown>[]) : [];
  } catch (err) {
    if (isRemapTableMissing(err)) {
      warnMissing(table);
      return [];
    }
    throw err;
  }
}

export async function loadRemapState(scenarioId: string): Promise<RemapState> {
  const scenario = await supabaseAdmin
    .from('scenarios')
    .select('initial_state')
    .eq('id', scenarioId)
    .maybeSingle<{ initial_state: unknown }>();
  if (scenario.error) throw scenario.error;
  if (!scenario.data) throw new Error(`Scenario ${scenarioId} was not found`);

  const teams = await loadTeams(scenarioId);
  const injects = await loadInjects(scenarioId);
  const sessions = await loadScheduledSessions(scenarioId);
  return { initial_state: scenario.data.initial_state ?? {}, teams, injects, sessions };
}

async function loadTeams(scenarioId: string): Promise<PlannerTeam[]> {
  const first = await activeTeams(
    supabaseAdmin.from('scenario_teams').select(TEAM_COLUMNS).eq('scenario_id', scenarioId),
  );
  const result =
    first.error && isRemapTableMissing(first.error)
      ? await activeTeams(
          supabaseAdmin
            .from('scenario_teams')
            .select(TEAM_COLUMNS_LEGACY)
            .eq('scenario_id', scenarioId),
        )
      : first;
  if (result.error) throw result.error;
  const rows = Array.isArray(result.data) ? (result.data as unknown as Record<string, unknown>[]) : [];
  return rows.map(asTeam);
}

async function loadInjects(scenarioId: string): Promise<PlannerInject[]> {
  const result = await activeTemplateInjects(
    supabaseAdmin
      .from('scenario_injects')
      .select(INJECT_COLUMNS)
      .eq('scenario_id', scenarioId)
      .is('session_id', null),
  );
  if (result.error) throw result.error;
  const rows = Array.isArray(result.data) ? (result.data as unknown as Record<string, unknown>[]) : [];
  const ids = rows.map((row) => text(row.id)).filter((id) => id.length > 0);
  const history = await injectsWithHistory(ids);
  return rows.map((row) => asInject(row, history.has(text(row.id))));
}

export const HISTORY_ID_BATCH = 100;
export const HISTORY_PAGE_SIZE = 1000;

export type HistoryTable = 'inject_publications' | 'inject_deliveries';

export interface HistoryPage {
  data: Array<{ inject_id?: unknown }> | null;
  error: { code?: string; message?: string } | null;
}

/** `from`/`to` are an inclusive PostgREST range over rows for this id batch. */
export type HistoryPageQuery = (
  table: HistoryTable,
  ids: readonly string[],
  from: number,
  to: number,
) => Promise<HistoryPage>;

/**
 * Distinct inject ids that already have a publication or a delivery.
 * Ids are requested in batches so the filter stays inside URL limits, and each
 * batch is paged so PostgREST's row cap cannot hide a later session.
 */
export async function collectInjectsWithHistory(
  ids: readonly string[],
  query: HistoryPageQuery,
  options?: { batchSize?: number; pageSize?: number },
): Promise<Set<string>> {
  const found = new Set<string>();
  const batchSize = options?.batchSize ?? HISTORY_ID_BATCH;
  const pageSize = options?.pageSize ?? HISTORY_PAGE_SIZE;
  const unique = [...new Set(ids.filter((id) => id.length > 0))];
  const tables: HistoryTable[] = ['inject_publications', 'inject_deliveries'];
  for (let index = 0; index < unique.length; index += batchSize) {
    const batch = unique.slice(index, index + batchSize);
    for (const table of tables) {
      let from = 0;
      for (;;) {
        const page = await query(table, batch, from, from + pageSize - 1);
        if (page.error) {
          if (isRemapTableMissing(page.error)) {
            warnMissing(table);
            break;
          }
          throw page.error;
        }
        const rows = page.data ?? [];
        for (const row of rows) {
          const id = text(row.inject_id);
          if (id) found.add(id);
        }
        if (rows.length < pageSize) break;
        from += pageSize;
      }
    }
  }
  return found;
}

async function injectsWithHistory(ids: string[]): Promise<Set<string>> {
  return collectInjectsWithHistory(ids, async (table, batch, from, to) => {
    const result = await supabaseAdmin
      .from(table)
      .select('inject_id')
      .in('inject_id', [...batch])
      .order('inject_id', { ascending: true })
      .range(from, to);
    return {
      data: (result.data ?? null) as HistoryPage['data'],
      error: result.error,
    };
  });
}

async function loadScheduledSessions(scenarioId: string): Promise<LobbySession[]> {
  const result = await supabaseAdmin
    .from('sessions')
    .select('id, status, start_time, scheduled_start_time')
    .eq('scenario_id', scenarioId)
    .eq('status', 'scheduled')
    .is('start_time', null);
  if (result.error) throw result.error;
  const sessions = Array.isArray(result.data) ? (result.data as Record<string, unknown>[]) : [];
  const ids = sessions.map((row) => text(row.id)).filter((id) => id.length > 0);
  if (ids.length === 0) return [];

  const [teams, channels, messages, lines, takers, roles, controllers, pages] = await Promise.all([
    readOptional(
      'session_teams',
      supabaseAdmin
        .from('session_teams')
        .select('session_id, user_id, team_name')
        .in('session_id', ids) as PromiseLike<QueryResult>,
    ),
    readOptional(
      'chat_channels',
      supabaseAdmin
        .from('chat_channels')
        .select('id, session_id, team_name')
        .in('session_id', ids) as PromiseLike<QueryResult>,
    ),
    readOptional(
      'chat_messages',
      supabaseAdmin
        .from('chat_messages')
        .select('channel_id, session_id')
        .in('session_id', ids) as PromiseLike<QueryResult>,
    ),
    readOptional(
      'session_call_lines',
      supabaseAdmin
        .from('session_call_lines')
        .select('session_id, team_name')
        .in('session_id', ids) as PromiseLike<QueryResult>,
    ),
    readOptional(
      'session_call_takers',
      supabaseAdmin
        .from('session_call_takers')
        .select('session_id, team_name, user_id')
        .in('session_id', ids) as PromiseLike<QueryResult>,
    ),
    readOptional(
      'session_role_assignments',
      supabaseAdmin
        .from('session_role_assignments')
        .select('session_id, role_id, user_id')
        .in('session_id', ids) as PromiseLike<QueryResult>,
    ),
    readOptional(
      'session_page_controllers',
      supabaseAdmin
        .from('session_page_controllers')
        .select('session_id, org_key, user_id')
        .in('session_id', ids) as PromiseLike<QueryResult>,
    ),
    readOptional(
      'sim_org_pages',
      supabaseAdmin
        .from('sim_org_pages')
        .select('session_id, org_key')
        .in('session_id', ids) as PromiseLike<QueryResult>,
    ),
  ]);

  const busyChannels = new Set(
    messages.map((row) => text(row.channel_id)).filter((id) => id.length > 0),
  );
  return ids.map((sessionId) => ({
    session_id: sessionId,
    status: 'scheduled',
    start_time: null,
    title: text(sessions.find((row) => text(row.id) === sessionId)?.scheduled_start_time),
    teams: teams
      .filter((row) => text(row.session_id) === sessionId)
      .map((row) => ({ user_id: text(row.user_id), team_name: text(row.team_name) })),
    channels: channels
      .filter((row) => text(row.session_id) === sessionId)
      .map((row) => ({
        team_name: text(row.team_name) || null,
        message_count: busyChannels.has(text(row.id)) ? 1 : 0,
      })),
    call_lines: lines
      .filter((row) => text(row.session_id) === sessionId)
      .map((row) => ({ team_name: text(row.team_name) })),
    call_takers: takers
      .filter((row) => text(row.session_id) === sessionId)
      .map((row) => ({ team_name: text(row.team_name), user_id: text(row.user_id) })),
    role_assignments: roles
      .filter((row) => text(row.session_id) === sessionId)
      .map((row) => ({ role_id: text(row.role_id), user_id: text(row.user_id) })),
    page_controllers: controllers
      .filter((row) => text(row.session_id) === sessionId)
      .map((row) => ({ org_key: text(row.org_key), user_id: text(row.user_id) })),
    org_pages: pages
      .filter((row) => text(row.session_id) === sessionId)
      .map((row) => ({ org_key: text(row.org_key) })),
  }));
}

function asTeam(row: Record<string, unknown>): PlannerTeam {
  const id = text(row.id);
  const uid = text(row.team_uid);
  return {
    id,
    team_uid: uid || id,
    team_name: text(row.team_name),
    org_key: text(row.org_key) || null,
    function_key: text(row.function_key) || null,
    team_description: typeof row.team_description === 'string' ? row.team_description : null,
    charter: row.charter ?? null,
    expected_actions: row.expected_actions ?? null,
    scoring_rubric: row.scoring_rubric ?? null,
    required_roles: Array.isArray(row.required_roles)
      ? row.required_roles.filter((item): item is string => typeof item === 'string')
      : [],
    min_participants: typeof row.min_participants === 'number' ? row.min_participants : null,
    max_participants: typeof row.max_participants === 'number' ? row.max_participants : null,
    counter_definitions: row.counter_definitions ?? null,
    is_investigative: row.is_investigative === true,
  };
}

function asInject(row: Record<string, unknown>, hasHistory: boolean): PlannerInject {
  const config = row.delivery_config;
  return {
    id: text(row.id),
    title: typeof row.title === 'string' ? row.title : null,
    content: typeof row.content === 'string' ? row.content : null,
    type: typeof row.type === 'string' ? row.type : null,
    severity: typeof row.severity === 'string' ? row.severity : null,
    trigger_time_minutes:
      typeof row.trigger_time_minutes === 'number' ? row.trigger_time_minutes : null,
    eligible_after_minutes:
      typeof row.eligible_after_minutes === 'number' ? row.eligible_after_minutes : null,
    target_teams: Array.isArray(row.target_teams)
      ? row.target_teams.filter((item): item is string => typeof item === 'string')
      : [],
    inject_scope: typeof row.inject_scope === 'string' ? row.inject_scope : null,
    requires_response: typeof row.requires_response === 'boolean' ? row.requires_response : null,
    conditions_to_appear: row.conditions_to_appear,
    conditions_to_cancel: row.conditions_to_cancel,
    trigger_condition: typeof row.trigger_condition === 'string' ? row.trigger_condition : null,
    delivery_config:
      config && typeof config === 'object' && !Array.isArray(config)
        ? (config as Record<string, unknown>)
        : null,
    generation_source: typeof row.generation_source === 'string' ? row.generation_source : null,
    has_history: hasHistory,
    affected_roles: row.affected_roles ?? [],
    ai_generated: row.ai_generated === true,
    requires_coordination: row.requires_coordination === true,
    triggered_by_user_id: typeof row.triggered_by_user_id === 'string' ? row.triggered_by_user_id : null,
    required_gate_id: typeof row.required_gate_id === 'string' ? row.required_gate_id : null,
    required_gate_not_met_id:
      typeof row.required_gate_not_met_id === 'string' ? row.required_gate_not_met_id : null,
    objective_penalty: row.objective_penalty ?? null,
    state_effect: row.state_effect ?? null,
    response_type: typeof row.response_type === 'string' ? row.response_type : null,
  };
}
