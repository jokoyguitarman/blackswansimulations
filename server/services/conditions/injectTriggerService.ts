/**
 * Writes inject_triggers and the cross-team guard events.
 * Migration 278 missing (42P01 / 42703 / PGRST204 / PGRST205) turns recording off
 * for the rest of the process. A missing widened event check skips the new event
 * types only. Neither failure throws, so a publish still completes.
 */

import { supabaseAdmin } from '../../lib/supabaseAdmin.js';
import { logger } from '../../lib/logger.js';
import { env } from '../../env.js';
import { injectKeyOf } from '../../lib/injectKey.js';
import { parsePlayerRoles } from '../roles/roleCore.js';
import {
  isLedgerSchemaMissing,
  ledgerTablesMissing,
  markLedgerTablesMissing,
} from '../ledger/ledgerSchema.js';
import { describeConditionKey, type EvaluationContext } from '../conditionEvaluatorService.js';
import {
  applyCrossTeamGuards,
  causeDepth,
  crossTeamProfile,
  isCrossTeam,
  PRESSURE_WINDOW_MINUTES,
  referencedInjectKeys,
  type CrossTeamGuardEnv,
  type CrossTeamTeam,
  type RecentCrossTeamTrigger,
  type CrossTeamGuardResult,
  type TeamDelivery,
} from './crossTeamCore.js';

const SCHEMA_CODES = new Set(['42P01', '42703', 'PGRST204', 'PGRST205']);
const GUARD_EVENT_TYPES = new Set(['cross_team_deferred', 'cross_team_held', 'dependency_changed']);

export type TriggerOrigin =
  'timed' | 'conditional' | 'dependency' | 'chain' | 'mood' | 'decision' | 'director' | 'trainer';

export interface TriggerKeyDetail {
  key: string;
  label: string;
  detail: string;
  teams: string[];
}

export interface TriggerRecordInput {
  sessionId: string;
  injectId: string;
  origin: TriggerOrigin;
  minute?: number;
  injectKey?: string;
  metKeys?: readonly string[];
  keyDetails?: readonly TriggerKeyDetail[];
  sourceTeams?: readonly string[];
  /** Undefined loads the inject. Null is a universal (no team) target list. */
  targetTeams?: readonly string[] | null;
  depId?: string | null;
  causeDepth?: number;
  parentInjectKeys?: readonly string[];
}

export interface ConditionalGuardItem {
  id: string;
  inject_key: string;
  severity?: string | null;
  eligible_after_minutes?: number | null;
  target_teams?: readonly string[] | null;
  met_keys: readonly string[];
  generation_source?: string | null;
  cause_kind?: string | null;
  dep_id?: string | null;
}

interface PreparedConditional<T> extends ConditionalGuardItem {
  minute: number;
  source_teams: string[];
  target_teams: string[];
  is_cross_team: boolean;
  origin: TriggerOrigin;
  cause_depth: number;
  dependency_age: number;
  met_keys: string[];
  trigger: TriggerRecordInput;
  item: T;
}

let triggersMissing = false;
let triggersWarned = false;
let guardEventsMissing = false;
let guardEventsWarned = false;
const eventWarned = new Set<string>();

function noteTriggersMissing(): void {
  triggersMissing = true;
  if (triggersWarned) return;
  triggersWarned = true;
  logger.warn(
    { event: 'inject_triggers_unavailable' },
    'Inject triggers are off because migration 278 is not applied',
  );
}

function noteGuardEventsMissing(): void {
  guardEventsMissing = true;
  if (guardEventsWarned) return;
  guardEventsWarned = true;
  logger.warn(
    { event: 'cross_team_events_unavailable' },
    'Cross-team guard events are off because session_events.event_type has not been widened (migration 278)',
  );
}

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

function isTriggerSchemaMissing(err: unknown): boolean {
  const code = codeOf(err);
  if (code && SCHEMA_CODES.has(code)) return true;
  const message = messageOf(err);
  return (
    /inject_triggers/i.test(message) && /does not exist|schema cache|could not find/i.test(message)
  );
}

/** Insert one trigger row. Never throws. A duplicate (session, inject) is success. */
export async function recordInjectTrigger(input: TriggerRecordInput): Promise<void> {
  if (triggersMissing) return;
  try {
    const row = await triggerRow(input);
    if (!row) return;
    const { error } = await supabaseAdmin.from('inject_triggers').insert(row);
    if (!error || error.code === '23505') return;
    if (isTriggerSchemaMissing(error)) {
      noteTriggersMissing();
      return;
    }
    logger.warn(
      { err: error, sessionId: input.sessionId, injectId: input.injectId },
      'inject trigger was not recorded',
    );
  } catch (err) {
    if (isTriggerSchemaMissing(err)) noteTriggersMissing();
    else {
      logger.warn(
        { err, sessionId: input.sessionId, injectId: input.injectId },
        'inject trigger was not recorded',
      );
    }
  }
}

/**
 * Order is already `orderPublishCandidates`. Guards run before the per-tick cap.
 * History that cannot be loaded leaves the guards with nothing to count, so
 * publishes continue. Cascade cancel writes `inject_cancelled` and returns those ids.
 */
export async function applySessionCrossTeamGuards<T extends ConditionalGuardItem>(input: {
  sessionId: string;
  scenarioId: string;
  elapsedMinutes: number;
  ordered: readonly T[];
  context: EvaluationContext;
}): Promise<{ publish: Array<T & { trigger: TriggerRecordInput }>; cancelledIds: string[] }> {
  if (input.ordered.length === 0) return { publish: [], cancelledIds: [] };
  const facts = await loadGuardFacts(input).catch((err: unknown) => {
    logger.warn({ err, sessionId: input.sessionId }, 'cross-team guard history skipped');
    return emptyFacts();
  });
  const prepared = input.ordered.map((item) =>
    prepareCandidate(item, facts, input.sessionId, input.elapsedMinutes, input.context),
  );
  let decision: CrossTeamGuardResult<PreparedConditional<T>>;
  try {
    decision = applyCrossTeamGuards(prepared, facts.recent, facts.deliveries, guardEnv());
  } catch (err) {
    logger.warn({ err, sessionId: input.sessionId }, 'cross-team guards skipped');
    return { publish: prepared.map(publishable), cancelledIds: [] };
  }

  const cancelledIds: string[] = [];
  for (const row of decision.defer) {
    logger.info(
      {
        event: 'cross_team_deferred',
        sessionId: input.sessionId,
        injectId: row.candidate.id,
        injectKey: row.candidate.inject_key,
        reason: row.reason,
        minute: input.elapsedMinutes,
      },
      'Cross-team consequence deferred',
    );
    await recordGuardEvent(input.sessionId, 'cross_team_deferred', {
      inject_id: row.candidate.id,
      inject_key: row.candidate.inject_key,
      reason: row.reason,
      minute: input.elapsedMinutes,
    });
  }
  for (const row of decision.hold) {
    logger.info(
      {
        event: 'cross_team_loop_held',
        sessionId: input.sessionId,
        injectId: row.id,
        injectKey: row.inject_key,
        minute: input.elapsedMinutes,
      },
      'Cross-team loop held a consequence',
    );
    await recordGuardEvent(input.sessionId, 'cross_team_held', {
      inject_id: row.id,
      inject_key: row.inject_key,
      reason: 'cross_team_loop_held',
      minute: input.elapsedMinutes,
    });
  }
  for (const row of decision.cancel) {
    const wrote = await recordGuardEvent(input.sessionId, 'inject_cancelled', {
      inject_id: row.candidate.id,
      reason: 'cascade_cap',
    });
    if (wrote) cancelledIds.push(row.candidate.id);
  }
  return { publish: decision.publish.map(publishable), cancelledIds };
}

function publishable<T extends ConditionalGuardItem>(
  candidate: PreparedConditional<T>,
): T & { trigger: TriggerRecordInput } {
  return { ...candidate.item, trigger: candidate.trigger };
}

function guardEnv(): CrossTeamGuardEnv {
  return {
    maxPerTeamWindow: env.crossTeamMaxPerTeamWindow,
    windowMinutes: env.crossTeamWindowMinutes,
    pressureMaxDeliveries10Min: env.teamPressureMaxDeliveries10Min,
    loopWindowMinutes: env.crossTeamLoopWindowMinutes,
    maxCascadeDepth: env.crossTeamMaxCascadeDepth,
  };
}

function originFor(item: ConditionalGuardItem): TriggerOrigin {
  if (item.generation_source === 'decision_response') return 'decision';
  if (item.cause_kind === 'dependency') return 'dependency';
  return 'conditional';
}

function prepareCandidate<T extends ConditionalGuardItem>(
  item: T,
  facts: GuardFacts,
  sessionId: string,
  elapsedMinutes: number,
  context: EvaluationContext,
): PreparedConditional<T> {
  const metKeys = [...item.met_keys];
  const profile = crossTeamProfile(
    { target_teams: item.target_teams ?? [] },
    metKeys,
    facts.roster,
  );
  const origin = originFor(item);
  const depth = causeDepth(metKeys, facts.triggersByKey);
  const eligible = item.eligible_after_minutes;
  const dependencyAge = eligible == null ? 0 : Math.max(0, elapsedMinutes - eligible);
  const parents = parentKeysOf(metKeys);
  const trigger: TriggerRecordInput = {
    sessionId,
    injectId: item.id,
    injectKey: item.inject_key,
    origin,
    minute: elapsedMinutes,
    metKeys,
    keyDetails: keyDetails(metKeys, context, facts.roster),
    sourceTeams: profile.source_teams,
    targetTeams: profile.target_teams,
    depId: origin === 'dependency' ? (item.dep_id ?? null) : null,
    causeDepth: depth,
    parentInjectKeys: parents,
  };
  return {
    ...item,
    minute: elapsedMinutes,
    source_teams: profile.source_teams,
    target_teams: profile.target_teams,
    is_cross_team: profile.is_cross_team,
    origin,
    cause_depth: depth,
    dependency_age: dependencyAge,
    met_keys: metKeys,
    trigger,
    item,
  };
}

function keyDetails(
  metKeys: readonly string[],
  context: EvaluationContext,
  roster: readonly CrossTeamTeam[],
): TriggerKeyDetail[] {
  return metKeys.map((key) => {
    const described = describeConditionKey(key, context);
    const teams = crossTeamProfile({ target_teams: [] }, [key], roster).source_teams;
    return { key, label: described.label, detail: described.detail, teams };
  });
}

function parentKeysOf(metKeys: readonly string[]): string[] {
  const out: string[] = [];
  for (const key of metKeys) {
    for (const ref of referencedInjectKeys(key)) {
      if (!out.includes(ref)) out.push(ref);
    }
  }
  return out;
}

interface GuardFacts {
  roster: CrossTeamTeam[];
  recent: RecentCrossTeamTrigger[];
  triggersByKey: Record<string, { cause_depth: number }>;
  deliveries: TeamDelivery[];
}

function emptyFacts(): GuardFacts {
  return { roster: [], recent: [], triggersByKey: {}, deliveries: [] };
}

async function loadGuardFacts(input: {
  sessionId: string;
  scenarioId: string;
  elapsedMinutes: number;
  ordered: readonly ConditionalGuardItem[];
}): Promise<GuardFacts> {
  const needsRoles = input.ordered.some((item) =>
    item.met_keys.some((key) => key.includes('|role=')),
  );
  const roster = await loadRoster(input.scenarioId, needsRoles);
  const triggers = await loadTriggers(input.sessionId);
  const triggersByKey: Record<string, { cause_depth: number }> = {};
  const recent: RecentCrossTeamTrigger[] = [];
  for (const row of triggers) {
    const depth = row.cause_depth ?? 0;
    const current = triggersByKey[row.inject_key];
    if (!current || depth > current.cause_depth)
      triggersByKey[row.inject_key] = { cause_depth: depth };
    const source = row.source_teams ?? [];
    const target = row.target_teams ?? [];
    recent.push({
      inject_key: row.inject_key,
      minute: row.minute,
      source_teams: source,
      target_teams: target,
      origin: row.origin,
      cause_depth: depth,
      is_cross_team: row.origin === 'director' ? false : isCrossTeam(source, target),
    });
  }
  const deliveries = await loadDeliveries(input.sessionId, input.elapsedMinutes, roster);
  return { roster, recent, triggersByKey, deliveries };
}

async function loadRoster(scenarioId: string, needsRoles: boolean): Promise<CrossTeamTeam[]> {
  const { data, error } = await supabaseAdmin
    .from('scenario_teams')
    .select('team_name')
    .eq('scenario_id', scenarioId);
  if (error || !data) return [];
  const teams: CrossTeamTeam[] = [];
  for (const row of data) {
    const name = String(row.team_name ?? '').trim();
    if (name) teams.push({ name });
  }
  if (!needsRoles) return teams;
  const { data: scenario, error: scenarioError } = await supabaseAdmin
    .from('scenarios')
    .select('initial_state')
    .eq('id', scenarioId)
    .maybeSingle();
  if (scenarioError || !scenario) return teams;
  const initial = scenario.initial_state as { player_roles?: unknown } | null;
  for (const role of parsePlayerRoles(initial?.player_roles)) {
    const team = teams.find((item) => item.name === role.team_name);
    if (!team) {
      teams.push({ name: role.team_name, role_ids: [role.role_id] });
      continue;
    }
    team.role_ids = [...(team.role_ids ?? []), role.role_id];
  }
  return teams;
}

interface TriggerHistoryRow {
  inject_key: string;
  minute: number;
  origin: string;
  source_teams: string[] | null;
  target_teams: string[] | null;
  cause_depth: number | null;
}

async function loadTriggers(sessionId: string): Promise<TriggerHistoryRow[]> {
  if (triggersMissing) return [];
  try {
    const { data, error } = await supabaseAdmin
      .from('inject_triggers')
      .select('inject_key, minute, origin, source_teams, target_teams, cause_depth')
      .eq('session_id', sessionId);
    if (error) {
      if (isTriggerSchemaMissing(error)) noteTriggersMissing();
      else logger.warn({ err: error, sessionId }, 'inject trigger history was not loaded');
      return [];
    }
    return (data ?? []) as TriggerHistoryRow[];
  } catch (err) {
    if (isTriggerSchemaMissing(err)) noteTriggersMissing();
    else logger.warn({ err, sessionId }, 'inject trigger history was not loaded');
    return [];
  }
}

async function loadDeliveries(
  sessionId: string,
  elapsedMinutes: number,
  roster: readonly CrossTeamTeam[],
): Promise<TeamDelivery[]> {
  if (ledgerTablesMissing()) return [];
  const since = Math.max(0, elapsedMinutes - PRESSURE_WINDOW_MINUTES);
  try {
    const { data, error } = await supabaseAdmin
      .from('inject_deliveries')
      .select('inject_id, recipient_teams, delivered_minute')
      .eq('session_id', sessionId)
      .gte('delivered_minute', since);
    if (error) {
      if (isLedgerSchemaMissing(error)) markLedgerTablesMissing();
      else logger.warn({ err: error, sessionId }, 'team pressure deliveries were not loaded');
      return [];
    }
    const rows = data ?? [];
    const ids = [...new Set(rows.map((row) => String(row.inject_id)))];
    const timed = await timedInjectIds(ids);
    const deliveries: TeamDelivery[] = [];
    for (const row of rows) {
      const minute = Number(row.delivered_minute);
      if (!Number.isFinite(minute)) continue;
      const listed = Array.isArray(row.recipient_teams)
        ? row.recipient_teams.map((team) => String(team)).filter(Boolean)
        : [];
      const names = listed.length > 0 ? listed : roster.map((team) => team.name);
      const isTimed = timed.has(String(row.inject_id));
      for (const team of names) deliveries.push({ team, minute, timed: isTimed });
    }
    return deliveries;
  } catch (err) {
    if (isLedgerSchemaMissing(err)) markLedgerTablesMissing();
    else logger.warn({ err, sessionId }, 'team pressure deliveries were not loaded');
    return [];
  }
}

async function timedInjectIds(ids: readonly string[]): Promise<Set<string>> {
  const timed = new Set<string>();
  if (ids.length === 0) return timed;
  const { data, error } = await supabaseAdmin
    .from('scenario_injects')
    .select('id, trigger_time_minutes')
    .in('id', [...ids]);
  if (error || !data) return timed;
  for (const row of data) {
    if (row.trigger_time_minutes != null) timed.add(String(row.id));
  }
  return timed;
}

async function recordGuardEvent(
  sessionId: string,
  eventType: string,
  metadata: Record<string, unknown>,
): Promise<boolean> {
  if (eventType !== 'inject_cancelled' && guardEventsMissing) return false;
  try {
    const { error } = await supabaseAdmin.from('session_events').insert({
      session_id: sessionId,
      event_type: eventType,
      description: guardDescription(eventType),
      metadata,
    });
    if (!error) return true;
    noteEventFailure(eventType, error.code ?? 'unknown', error);
    return false;
  } catch (err) {
    noteEventFailure(eventType, codeOf(err) ?? 'unknown', err);
    return false;
  }
}

function guardDescription(eventType: string): string {
  if (eventType === 'inject_cancelled') return 'Inject cancelled: cascade cap';
  if (eventType === 'cross_team_held') return 'Cross-team consequence held';
  return 'Cross-team consequence deferred';
}

function noteEventFailure(eventType: string, code: string, err: unknown): void {
  if (GUARD_EVENT_TYPES.has(eventType) && (code === '23514' || SCHEMA_CODES.has(code))) {
    noteGuardEventsMissing();
    return;
  }
  const key = `${eventType}:${code}`;
  if (eventWarned.has(key)) return;
  eventWarned.add(key);
  logger.warn({ err, eventType }, 'cross-team guard event was not recorded');
}

async function triggerRow(input: TriggerRecordInput): Promise<Record<string, unknown> | null> {
  let injectKey = input.injectKey;
  let targetTeams = input.targetTeams === undefined ? undefined : [...(input.targetTeams ?? [])];
  let parents = input.parentInjectKeys ? [...input.parentInjectKeys] : undefined;
  let minute = input.minute;
  if (injectKey == null || targetTeams === undefined || parents === undefined) {
    const loaded = await loadInjectBits(input.injectId);
    if (!loaded) return null;
    injectKey = injectKey ?? loaded.injectKey;
    if (targetTeams === undefined) targetTeams = loaded.targetTeams;
    if (parents === undefined && loaded.rootKey) parents = [loaded.rootKey];
  }
  if (minute == null) minute = await sessionMinute(input.sessionId);
  if (!injectKey) {
    logger.warn({ injectId: input.injectId }, 'inject trigger skipped; inject key is unknown');
    return null;
  }
  const causeDepthValue =
    input.causeDepth ?? (input.origin === 'timed' || input.origin === 'trainer' ? 0 : 1);
  return {
    session_id: input.sessionId,
    inject_id: input.injectId,
    inject_key: injectKey,
    minute,
    origin: input.origin,
    met_keys: [...(input.metKeys ?? [])],
    key_details: [...(input.keyDetails ?? [])],
    source_teams: [...(input.sourceTeams ?? [])],
    target_teams: targetTeams ?? [],
    dep_id: input.depId ?? null,
    cause_depth: causeDepthValue,
    parent_inject_keys: parents ?? [],
  };
}

async function loadInjectBits(
  injectId: string,
): Promise<{ injectKey: string; targetTeams: string[]; rootKey: string | null } | null> {
  const { data, error } = await supabaseAdmin
    .from('scenario_injects')
    .select('id, target_teams, delivery_config')
    .eq('id', injectId)
    .maybeSingle();
  if (error || !data) {
    if (error) logger.warn({ err: error, injectId }, 'inject trigger could not load the inject');
    return null;
  }
  const config = (data.delivery_config ?? null) as {
    inject_key?: unknown;
    chain?: { root_key?: unknown };
  } | null;
  const root = config?.chain?.root_key;
  const targets = Array.isArray(data.target_teams)
    ? data.target_teams.map((team) => String(team)).filter(Boolean)
    : [];
  return {
    injectKey: injectKeyOf({ id: String(data.id), delivery_config: config }),
    targetTeams: targets,
    rootKey: typeof root === 'string' ? root : null,
  };
}

async function sessionMinute(sessionId: string): Promise<number> {
  const { data, error } = await supabaseAdmin
    .from('sessions')
    .select('start_time')
    .eq('id', sessionId)
    .maybeSingle();
  if (error || !data?.start_time) return 0;
  const started = Date.parse(String(data.start_time));
  if (!Number.isFinite(started)) return 0;
  return Math.max(0, Math.floor((Date.now() - started) / 60000));
}
