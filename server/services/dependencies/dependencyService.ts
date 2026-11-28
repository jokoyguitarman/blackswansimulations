/**
 * Per-session dependency states. Migration 280 missing (42P01 / 42703 /
 * PGRST204 / PGRST205) turns the runtime off: keys stay false, one warn.
 * Writes are conditional on the previous status so two ticks cannot both transition.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { supabaseAdmin } from '../../lib/supabaseAdmin.js';
import { logger } from '../../lib/logger.js';
import { env } from '../../env.js';
import { getWebSocketService } from '../websocketService.js';
import {
  registerReferencedInjectKeysResolver,
  registerSourceTeamResolver,
} from '../conditions/crossTeamCore.js';
import type { EvaluationContext } from '../conditionEvaluatorService.js';
import type { TeamDependencyEdge, TeamRef } from '../../../shared/teamDependencies.js';
import { resolveTeamRef } from '../../../shared/teamDependencies.js';
import { teamDependenciesSchema } from './dependencySchema.js';
import { loadScenarioTeams } from './dependencyContext.js';
import { evaluateDependency, nextState } from './dependencyRuntimeCore.js';
import {
  dependencyIdFromKey,
  emptyDependencyState,
  guardKeysForDependency,
  isDependencyStatus,
  nextHoldMinute,
  planDependencyWrite,
  projectDependencyStates,
  sourceTeamsFromState,
  type DependencyEvidence,
  type DependencyRuntimeState,
  type DependencyStatus,
  type StoredDependencyRow,
} from './dependencyConditionsCore.js';

export interface DependencySession {
  id: string;
  scenario_id: string;
  trainer_id?: string | null;
  start_time?: string | null;
}

export interface SessionDependencyView {
  id: string;
  kind: TeamDependencyEdge['kind'];
  upstream: TeamRef;
  downstream: TeamRef[];
  deliverable: string;
  why: string;
  due: TeamDependencyEdge['due'];
  lag_minutes: number;
  severity: TeamDependencyEdge['severity'];
  consequence_keys: string[];
  source: TeamDependencyEdge['source'];
  inert: boolean;
  state: DependencyRuntimeState & { evidence: DependencyEvidence[] };
}

const SCHEMA_CODES = new Set(['42P01', '42703', 'PGRST204', 'PGRST205']);

let tableMissing = false;
let tableWarned = false;
const sourcesBySession = new Map<string, Map<string, readonly string[]>>();
const referencesBySession = new Map<string, Map<string, readonly string[]>>();
const sessionScope = new AsyncLocalStorage<string>();
const inertLogged = new Set<string>();

export function dependencyTableMissing(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  if (error.code && SCHEMA_CODES.has(error.code)) return true;
  const message = error.message ?? '';
  return (
    /session_dependency_states/i.test(message) &&
    /does not exist|schema cache|could not find/i.test(message)
  );
}

function noteTableMissing(): void {
  tableMissing = true;
  if (tableWarned) return;
  tableWarned = true;
  logger.warn(
    { event: 'session_dependency_states_unavailable' },
    'Team dependency runtime is off because migration 280 is not applied',
  );
}

export function rememberDependencySources(
  sessionId: string,
  teams: ReadonlyMap<string, readonly string[]>,
): void {
  sourcesBySession.set(sessionId, new Map(teams));
}

/** Inject keys each dependency stands for, for the loop guard and cascade depth. */
export function rememberDependencyReferences(
  sessionId: string,
  refs: ReadonlyMap<string, readonly string[]>,
): void {
  referencesBySession.set(sessionId, new Map(refs));
}

/** The source-team resolver reads this session for the duration of `fn`, including its awaits. */
export function withDependencySession<T>(sessionId: string, fn: () => T): T {
  return sessionScope.run(sessionId, fn);
}

registerSourceTeamResolver('dependency_*', (key) => {
  const sessionId = sessionScope.getStore();
  if (!sessionId) return [];
  const depId = dependencyIdFromKey(key);
  if (!depId) return [];
  return sourcesBySession.get(sessionId)?.get(depId) ?? [];
});

registerReferencedInjectKeysResolver('dependency_*', (key) => {
  const sessionId = sessionScope.getStore();
  if (!sessionId) return [];
  const depId = dependencyIdFromKey(key);
  if (!depId) return [];
  return referencesBySession.get(sessionId)?.get(depId) ?? [];
});

function codeOf(err: unknown): string | null {
  if (!err || typeof err !== 'object') return null;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

function messageOf(err: unknown): string {
  if (!err || typeof err !== 'object') return '';
  const message = (err as { message?: unknown }).message;
  return typeof message === 'string' ? message : '';
}

function asMinute(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

function asStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim() !== '');
}

function asEvidence(value: unknown): DependencyEvidence[] {
  if (!Array.isArray(value)) return [];
  const evidence: DependencyEvidence[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const row = item as { key?: unknown; detail?: unknown; minute?: unknown };
    if (typeof row.key !== 'string') continue;
    evidence.push({
      key: row.key,
      detail: typeof row.detail === 'string' ? row.detail : '',
      minute: typeof row.minute === 'number' ? row.minute : 0,
    });
  }
  return evidence;
}

function rowFrom(raw: Record<string, unknown>): StoredDependencyRow | null {
  const depId = raw.dep_id;
  if (typeof depId !== 'string' || !isDependencyStatus(raw.status)) return null;
  return {
    dep_id: depId,
    status: raw.status,
    upstream_team: typeof raw.upstream_team === 'string' ? raw.upstream_team : null,
    downstream_teams: asStrings(raw.downstream_teams),
    broken_minute: asMinute(raw.broken_minute),
    met_minute: asMinute(raw.met_minute),
    recovered_minute: asMinute(raw.recovered_minute),
    hold_until_minute: asMinute(raw.hold_until_minute),
    evidence: asEvidence(raw.evidence),
  };
}

export function sessionMinute(startTime: string | null | undefined, now = Date.now()): number {
  if (!startTime) return 0;
  const start = Date.parse(startTime);
  if (!Number.isFinite(start)) return 0;
  return Math.max(0, Math.floor((now - start) / 60000));
}

export async function loadScenarioDependencyEdges(scenarioId: string): Promise<TeamDependencyEdge[]> {
  try {
    const { data, error } = await supabaseAdmin
      .from('scenarios')
      .select('initial_state')
      .eq('id', scenarioId)
      .maybeSingle();
    if (error || !data) {
      if (error) logger.warn({ err: error, scenarioId }, 'dependency edges were not loaded');
      return [];
    }
    const initial = data.initial_state as { team_dependencies?: unknown } | null;
    const parsed = teamDependenciesSchema.safeParse(initial?.team_dependencies);
    return parsed.success ? parsed.data.edges : [];
  } catch (err) {
    logger.warn({ err, scenarioId }, 'dependency edges were not loaded');
    return [];
  }
}

async function loadRows(
  sessionId: string,
): Promise<{ missing: boolean; rows: StoredDependencyRow[] }> {
  if (tableMissing) return { missing: true, rows: [] };
  try {
    const { data, error } = await supabaseAdmin
      .from('session_dependency_states')
      .select(
        'dep_id, status, upstream_team, downstream_teams, broken_minute, met_minute, recovered_minute, hold_until_minute, evidence',
      )
      .eq('session_id', sessionId);
    if (error) {
      if (dependencyTableMissing(error)) {
        noteTableMissing();
        return { missing: true, rows: [] };
      }
      logger.warn({ err: error, sessionId }, 'dependency states were not loaded');
      return { missing: false, rows: [] };
    }
    const rows: StoredDependencyRow[] = [];
    for (const raw of data ?? []) {
      const row = rowFrom(raw as Record<string, unknown>);
      if (row) rows.push(row);
    }
    return { missing: false, rows };
  } catch (err) {
    if (dependencyTableMissing({ code: codeOf(err) ?? undefined, message: messageOf(err) })) {
      noteTableMissing();
      return { missing: true, rows: [] };
    }
    logger.warn({ err, sessionId }, 'dependency states were not loaded');
    return { missing: false, rows: [] };
  }
}

function noteInert(sessionId: string, depId: string): void {
  const token = `${sessionId}:${depId}`;
  if (inertLogged.has(token)) return;
  inertLogged.add(token);
  logger.warn(
    { event: 'dependency_inert', sessionId, depId },
    'Dependency upstream team is gone; the edge stays pending',
  );
}

function publishMap(
  ctx: EvaluationContext,
  sessionId: string,
  map: Record<string, DependencyRuntimeState>,
  edges: readonly TeamDependencyEdge[] = [],
  evidenceById: ReadonlyMap<string, readonly { key: string }[]> = new Map(),
): Record<string, DependencyRuntimeState> {
  ctx.currentState.dependency_state = map;
  rememberDependencySources(sessionId, sourceTeamsFromState(map));
  const refs = new Map<string, readonly string[]>();
  for (const edge of edges) {
    refs.set(edge.id, guardKeysForDependency(edge.broken_when, evidenceById.get(edge.id)));
  }
  rememberDependencyReferences(sessionId, refs);
  return map;
}

function emitChanged(
  trainerId: string | null | undefined,
  sessionId: string,
  depId: string,
  state: DependencyRuntimeState,
): void {
  if (!trainerId) return;
  try {
    getWebSocketService().emitToUser(trainerId, {
      type: 'dependency.changed',
      data: {
        session_id: sessionId,
        dep_id: depId,
        status: state.status,
        broken_minute: state.broken_minute,
        met_minute: state.met_minute,
        recovered_minute: state.recovered_minute,
        hold_until_minute: state.hold_until_minute,
        upstream: state.upstream,
        downstream: state.downstream,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    logger.debug({ err, sessionId, depId }, 'dependency.changed was not emitted');
  }
}

async function conditionalUpdate(
  sessionId: string,
  depId: string,
  whereStatus: DependencyStatus,
  row: Record<string, unknown>,
): Promise<'wrote' | 'lost' | 'missing' | 'error'> {
  const { data, error } = await supabaseAdmin
    .from('session_dependency_states')
    .update({ ...row, updated_at: new Date().toISOString() })
    .eq('session_id', sessionId)
    .eq('dep_id', depId)
    .eq('status', whereStatus)
    .select('dep_id');
  if (error) {
    if (dependencyTableMissing(error)) {
      noteTableMissing();
      return 'missing';
    }
    logger.warn({ err: error, sessionId, depId }, 'dependency state was not updated');
    return 'error';
  }
  return Array.isArray(data) && data.length > 0 ? 'wrote' : 'lost';
}

async function applyWrite(
  sessionId: string,
  depId: string,
  plan: NonNullable<ReturnType<typeof planDependencyWrite>>,
  extra: Record<string, unknown> = {},
): Promise<'wrote' | 'lost' | 'missing' | 'error'> {
  if (tableMissing) return 'missing';
  const stamped = { ...plan.row, ...extra, updated_at: new Date().toISOString() };
  try {
    if (plan.op === 'insert') {
      const { error } = await supabaseAdmin.from('session_dependency_states').insert({
        session_id: sessionId,
        dep_id: depId,
        ...stamped,
      });
      if (!error) return 'wrote';
      if (error.code === '23505') {
        const rest: Record<string, unknown> = { ...plan.row, ...extra };
        delete rest.upstream_team;
        delete rest.downstream_teams;
        return conditionalUpdate(sessionId, depId, 'pending', rest);
      }
      if (dependencyTableMissing(error)) {
        noteTableMissing();
        return 'missing';
      }
      logger.warn({ err: error, sessionId, depId }, 'dependency state was not inserted');
      return 'error';
    }
    if (!plan.whereStatus) return 'error';
    return conditionalUpdate(sessionId, depId, plan.whereStatus, { ...plan.row, ...extra });
  } catch (err) {
    if (dependencyTableMissing({ code: codeOf(err) ?? undefined, message: messageOf(err) })) {
      noteTableMissing();
      return 'missing';
    }
    logger.warn({ err, sessionId, depId }, 'dependency state was not written');
    return 'error';
  }
}

async function loadTeams(scenarioId: string) {
  try {
    const loaded = await loadScenarioTeams(scenarioId);
    if ('error' in loaded) {
      logger.warn({ err: loaded.error, scenarioId }, 'dependency teams were not loaded');
      return [];
    }
    return loaded.teams;
  } catch (err) {
    logger.warn({ err, scenarioId }, 'dependency teams were not loaded');
    return [];
  }
}

/**
 * Evaluate every non-terminal edge and upsert transitions.
 * Returns the map placed on `ctx.currentState.dependency_state`, or null when the flag is off.
 * An unapplied migration returns an empty map so every dependency_* key is false.
 */
export async function updateDependencyStates(
  session: DependencySession,
  ctx: EvaluationContext,
  elapsed: number,
  edges?: readonly TeamDependencyEdge[],
): Promise<Record<string, DependencyRuntimeState> | null> {
  if (!env.crossTeamDependencies) return null;
  const list = edges ? [...edges] : await loadScenarioDependencyEdges(session.scenario_id);
  if (list.length === 0) {
    rememberDependencySources(session.id, new Map());
    rememberDependencyReferences(session.id, new Map());
    return null;
  }
  const stored = await loadRows(session.id);
  if (stored.missing) return publishMap(ctx, session.id, {});
  const teams = await loadTeams(session.scenario_id);
  const rowsById = new Map(stored.rows.map((row) => [row.dep_id, row]));
  const evidenceById = new Map<string, readonly { key: string }[]>(
    stored.rows.map((row) => [row.dep_id, row.evidence]),
  );
  const map = projectDependencyStates(list, stored.rows, teams);
  const changed: string[] = [];
  for (const edge of list) {
    const current = map[edge.id];
    if (!current || !resolveTeamRef(edge.upstream, teams)) {
      noteInert(session.id, edge.id);
      continue;
    }
    if (current.status === 'met' || current.status === 'recovered' || current.status === 'waived') {
      continue;
    }
    const evaluation = evaluateDependency(edge, ctx, teams);
    const upcoming = nextState(current, evaluation, elapsed);
    map[edge.id] = upcoming;
    const previous = rowsById.get(edge.id)?.status ?? null;
    const plan = planDependencyWrite(previous, upcoming, evaluation.evidence);
    if (!plan) continue;
    evidenceById.set(edge.id, evaluation.evidence);
    const wrote = await applyWrite(session.id, edge.id, plan);
    if (wrote === 'missing') return publishMap(ctx, session.id, {});
    if (wrote === 'wrote') changed.push(edge.id);
  }
  publishMap(ctx, session.id, map, list, evidenceById);
  for (const depId of changed) {
    const state = map[depId];
    if (state) emitChanged(session.trainer_id, session.id, depId, state);
  }
  return map;
}

/** Map for a context that does not already carry one. Null leaves the caller's state alone. */
export async function loadContextDependencyState(
  sessionId: string,
  scenarioId: string,
): Promise<Record<string, DependencyRuntimeState> | null> {
  if (!env.crossTeamDependencies) return null;
  const edges = await loadScenarioDependencyEdges(scenarioId);
  if (edges.length === 0) return null;
  const stored = await loadRows(sessionId);
  if (stored.missing) return {};
  const teams = await loadTeams(scenarioId);
  return projectDependencyStates(edges, stored.rows, teams);
}

function viewOf(
  edge: TeamDependencyEdge,
  state: DependencyRuntimeState | undefined,
  evidence: DependencyEvidence[],
  teams: Awaited<ReturnType<typeof loadTeams>>,
): SessionDependencyView {
  const upstream = resolveTeamRef(edge.upstream, teams);
  const resolved = state ?? emptyDependencyState({ deliverable: edge.deliverable, upstream });
  return {
    id: edge.id,
    kind: edge.kind,
    upstream: edge.upstream,
    downstream: edge.downstream,
    deliverable: edge.deliverable,
    why: edge.why,
    due: edge.due,
    lag_minutes: edge.lag_minutes,
    severity: edge.severity,
    consequence_keys: edge.consequence_keys,
    source: edge.source,
    inert: !upstream && !state,
    state: { ...resolved, evidence },
  };
}

export async function listSessionDependencies(
  session: DependencySession,
): Promise<SessionDependencyView[]> {
  const edges = await loadScenarioDependencyEdges(session.scenario_id);
  const teams = await loadTeams(session.scenario_id);
  const stored =
    env.crossTeamDependencies && !tableMissing ? await loadRows(session.id) : { missing: true, rows: [] };
  const rows = stored.missing ? [] : stored.rows;
  const map = projectDependencyStates(edges, rows, teams);
  const evidenceById = new Map(rows.map((row) => [row.dep_id, row.evidence]));
  return edges.map((edge) => viewOf(edge, map[edge.id], evidenceById.get(edge.id) ?? [], teams));
}

export type DependencyCommandResult =
  | { ok: true; state: DependencyRuntimeState }
  | { ok: false; reason: 'disabled' | 'missing' | 'unavailable' };

async function edgeFor(
  session: DependencySession,
  depId: string,
): Promise<{ edge: TeamDependencyEdge; teams: Awaited<ReturnType<typeof loadTeams>> } | null> {
  const edges = await loadScenarioDependencyEdges(session.scenario_id);
  const edge = edges.find((item) => item.id === depId);
  if (!edge) return null;
  return { edge, teams: await loadTeams(session.scenario_id) };
}

export async function waiveDependency(
  session: DependencySession,
  depId: string,
  trainerId: string,
  elapsed: number,
): Promise<DependencyCommandResult> {
  if (!env.crossTeamDependencies) return { ok: false, reason: 'disabled' };
  const found = await edgeFor(session, depId);
  if (!found) return { ok: false, reason: 'missing' };
  const stored = await loadRows(session.id);
  if (stored.missing) return { ok: false, reason: 'unavailable' };
  const map = projectDependencyStates([found.edge], stored.rows, found.teams);
  const current = map[depId] ?? emptyDependencyState({ deliverable: found.edge.deliverable });
  if (current.status === 'waived') return { ok: true, state: current };
  const upcoming: DependencyRuntimeState = { ...current, status: 'waived' };
  const evidence: DependencyEvidence[] = [
    { key: `dependency_waived:${depId}`, detail: 'The trainer waived this dependency', minute: elapsed },
  ];
  const plan = planDependencyWrite(
    stored.rows.find((row) => row.dep_id === depId)?.status ?? null,
    upcoming,
    evidence,
  );
  if (!plan) return { ok: true, state: upcoming };
  const wrote = await applyWrite(session.id, depId, plan, { waived_by: trainerId });
  if (wrote === 'missing') return { ok: false, reason: 'unavailable' };
  if (wrote === 'error') return { ok: false, reason: 'unavailable' };
  rememberDependencySources(session.id, sourceTeamsFromState({ ...map, [depId]: upcoming }));
  emitChanged(session.trainer_id ?? trainerId, session.id, depId, upcoming);
  return { ok: true, state: upcoming };
}

export async function holdDependency(
  session: DependencySession,
  depId: string,
  elapsed: number,
): Promise<DependencyCommandResult> {
  if (!env.crossTeamDependencies) return { ok: false, reason: 'disabled' };
  const found = await edgeFor(session, depId);
  if (!found) return { ok: false, reason: 'missing' };
  const stored = await loadRows(session.id);
  if (stored.missing) return { ok: false, reason: 'unavailable' };
  const row = stored.rows.find((item) => item.dep_id === depId) ?? null;
  const map = projectDependencyStates([found.edge], stored.rows, found.teams);
  const current = map[depId] ?? emptyDependencyState({ deliverable: found.edge.deliverable });
  const hold_until_minute = nextHoldMinute(current.hold_until_minute, elapsed);
  const upcoming: DependencyRuntimeState = { ...current, hold_until_minute };
  if (tableMissing) return { ok: false, reason: 'unavailable' };
  try {
    if (!row) {
      const { error } = await supabaseAdmin.from('session_dependency_states').insert({
        session_id: session.id,
        dep_id: depId,
        status: current.status,
        upstream_team: current.upstream,
        downstream_teams: current.downstream,
        broken_minute: current.broken_minute,
        met_minute: current.met_minute,
        recovered_minute: current.recovered_minute,
        hold_until_minute,
        updated_at: new Date().toISOString(),
      });
      if (error?.code === '23505') {
        await supabaseAdmin
          .from('session_dependency_states')
          .update({ hold_until_minute, updated_at: new Date().toISOString() })
          .eq('session_id', session.id)
          .eq('dep_id', depId);
      } else if (error) {
        if (dependencyTableMissing(error)) {
          noteTableMissing();
          return { ok: false, reason: 'unavailable' };
        }
        logger.warn({ err: error, sessionId: session.id, depId }, 'dependency hold was not saved');
        return { ok: false, reason: 'unavailable' };
      }
    } else {
      const { error } = await supabaseAdmin
        .from('session_dependency_states')
        .update({ hold_until_minute, updated_at: new Date().toISOString() })
        .eq('session_id', session.id)
        .eq('dep_id', depId);
      if (error) {
        if (dependencyTableMissing(error)) {
          noteTableMissing();
          return { ok: false, reason: 'unavailable' };
        }
        logger.warn({ err: error, sessionId: session.id, depId }, 'dependency hold was not saved');
        return { ok: false, reason: 'unavailable' };
      }
    }
  } catch (err) {
    if (dependencyTableMissing({ code: codeOf(err) ?? undefined, message: messageOf(err) })) {
      noteTableMissing();
      return { ok: false, reason: 'unavailable' };
    }
    logger.warn({ err, sessionId: session.id, depId }, 'dependency hold was not saved');
    return { ok: false, reason: 'unavailable' };
  }
  emitChanged(session.trainer_id, session.id, depId, upcoming);
  return { ok: true, state: upcoming };
}
