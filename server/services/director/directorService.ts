/**
 * One director wake per scheduler tick. Proposals are stored and shown to the
 * trainer. Publishing is a later step. Migration 279 missing, or AI disabled,
 * turns the director off.
 */

import { env } from '../../env.js';
import { logger } from '../../lib/logger.js';
import { supabaseAdmin } from '../../lib/supabaseAdmin.js';
import { activeTeams, activeTemplateInjects } from '../../lib/templateRows.js';
import { slugifyTeamName } from '../../../shared/conditionKeyGrammar.js';
import { AiCallError, chat, systemUser } from '../ai/chatClient.js';
import { parseJsonLoose } from '../ai/chatCore.js';
import { isCrossTeam, type DepthTrigger } from '../conditions/crossTeamCore.js';
import type { CommsState } from '../ledger/injectLedgerCore.js';
import { inBootGrace, sessionUserOnline } from '../presence/sessionPresenceService.js';
import { parsePlayerRoles } from '../roles/roleCore.js';
import { getWebSocketService } from '../websocketService.js';
import {
  capsFor,
  directorSeed,
  runDirectorTurn,
  type DirectorClient,
  type DirectorDraft,
  type DirectorLimits,
  type DirectorMode,
  type DirectorModelReply,
  type DirectorTeam,
  type DirectorTurnInput,
  type ExposureEvent,
  type UpcomingInject,
} from './directorCore.js';
import { replayDirectorSession, type ReplayRow } from './directorReplay.js';
import { type DependencySnapshot, type Signal, type SignalComms } from './directorSignals.js';

const SCHEMA_CODES = new Set(['42P01', '42703', 'PGRST204', 'PGRST205']);
const APPS = ['email', 'group_chat', 'phone_call', 'npc_dm', 'messenger_dm', 'social_feed', 'news'];
const LIVE_STATUSES = new Set(['proposed', 'approved', 'edited', 'auto_published']);
const RECEIVED_STATUSES = new Set(['approved', 'edited', 'auto_published']);

let directorUnavailable = false;
let directorWarned = false;
const insertWarned = new Set<string>();

export interface DirectorTickInput {
  sessionId: string;
  scenarioId: string;
  trainerId: string;
  status: string;
  elapsedMinutes: number;
  comms: CommsState | null;
  /** Omitted when the tick has no dependency state. Present (even empty) once WP2 is merged. */
  dependencyState?: Record<string, DependencySnapshot> | null;
}

export async function runDirector(input: DirectorTickInput): Promise<void> {
  if (!env.directorEnabled || !env.aiEnabled || directorUnavailable) return;
  if (!(await proposalsReady(input.sessionId))) return;

  const session = await loadSession(input.sessionId);
  if (!session) return;
  const scenario = await loadScenario(input.scenarioId);
  if (!scenario || scenario.category !== 'social_media_crisis') return;

  const settings = readDirectorSettings(scenario.initial);
  const mode = resolveMode(session.director_mode, settings.mode);
  if (mode === 'off') return;
  const seed = await ensureSeed(input.sessionId, input.scenarioId, session.director_seed);
  if (seed == null) return;

  const [proposals, triggers, deliveryRows, decisions, teams, memberships, upcoming] =
    await Promise.all([
      loadProposals(input.sessionId),
      loadTriggers(input.sessionId),
      loadDeliveries(input.sessionId, input.elapsedMinutes),
      loadActivePlans(input.sessionId),
      loadTeams(input.scenarioId),
      loadMemberships(input.sessionId),
      loadUpcoming(input.scenarioId, input.elapsedMinutes),
    ]);

  const turn = buildTurn({
    input,
    scenario,
    settings,
    mode,
    seed,
    proposals,
    triggers,
    deliveryRows,
    decisions,
    teams,
    memberships,
    upcoming,
  });
  const draft = await runDirectorTurn(turn, defaultClient);
  if (!draft.log || !draft.status || !draft.wake_reason || !draft.mode) return;
  const seq = nextSeq(proposals);
  const stored = await insertProposal(input.sessionId, seq, turn, draft);
  if (!stored) return;
  emitProposal(input.trainerId, input.sessionId, seq, draft);
  void recordDirectorEvent(input.sessionId, seq, draft);
}

export async function replayStoredSession(
  sessionId: string,
): Promise<
  | {
      ok: boolean;
      mismatches: Array<{ seq: number; field: string; stored: unknown; recomputed: unknown }>;
    }
  | { unavailable: true }
> {
  if (directorUnavailable) return { unavailable: true };
  const rows = await loadReplayRows(sessionId);
  if (rows == null) return { unavailable: true };
  const wakes: Record<number, DirectorTurnInput> = {};
  const comparable: ReplayRow[] = [];
  for (const row of rows) {
    const restored = restoreTurn(row.replay);
    if (restored) wakes[row.seq] = restored;
    comparable.push(row.view);
  }
  return replayDirectorSession(comparable, { wakes });
}

const defaultClient: DirectorClient = {
  propose(request) {
    return directorChat({
      ...request,
      tier: 'standard',
      maxTokens: 900,
      label: 'director.propose',
      seed: request.seed,
    });
  },
  consistency(request) {
    return directorChat({
      ...request,
      tier: 'fast',
      maxTokens: 200,
      temperature: 0,
      label: 'director.consistency',
    });
  },
};

async function directorChat(request: {
  system: string;
  user: string;
  temperature: number;
  budgetKey: string;
  budgetLimit: number;
  tier: 'standard' | 'fast';
  maxTokens: number;
  label: string;
  seed?: number;
}): Promise<DirectorModelReply> {
  try {
    const result = await chat({
      tier: request.tier,
      messages: systemUser(request.system, request.user),
      json: true,
      maxTokens: request.maxTokens,
      temperature: request.temperature,
      timeoutMs: 20_000,
      retry: { attempts: 1 },
      seed: request.seed,
      budgetKey: request.budgetKey,
      budgetLimit: request.budgetLimit,
      label: request.label,
      throwOnError: true,
    });
    if (!result) return { failed: true };
    const parsed = parseJsonLoose(result.content);
    if (parsed == null) return { failed: true, model: result.model };
    return {
      parsed,
      model: result.model,
      providerSeedApplied: result.provider === 'openai' && request.seed != null,
      tokensIn: result.usage?.prompt_tokens ?? null,
      tokensOut: result.usage?.completion_tokens ?? null,
    };
  } catch (err) {
    if (
      err instanceof AiCallError &&
      err.status === 429 &&
      err.message === 'hourly AI budget exhausted'
    ) {
      return { budgetDenied: true };
    }
    return { failed: true };
  }
}

function buildTurn(parts: {
  input: DirectorTickInput;
  scenario: ScenarioRow;
  settings: DirectorSettings;
  mode: 'suggest' | 'auto';
  seed: bigint;
  proposals: ProposalHistory[];
  triggers: TriggerRow[];
  deliveryRows: DeliveryFact[];
  decisions: Array<{ team_slug: string; category: string }>;
  teams: Array<{ name: string }>;
  memberships: Array<{ user_id: string; team_name: string }>;
  upcoming: UpcomingInject[];
}): DirectorTurnInput {
  const { input, scenario, settings } = parts;
  const roster = rosterOf(parts.teams, scenario.initial, parts.memberships);
  const triggersByKey = triggersByKeyOf(parts.triggers);
  const signalState = {
    minute: input.elapsedMinutes,
    teams: roster,
    comms: (input.comms ?? undefined) as SignalComms | undefined,
    triggers_by_key: triggersByKey,
    active_plans: parts.decisions,
    ...(input.dependencyState != null ? { dependency_state: input.dependencyState } : {}),
  };
  const limits = limitsFor(settings);
  const scaled = capsFor(limits.intensity, { per15: limits.per15, perTeam30: limits.perTeam30 });
  const loadEvents = exposureFrom(parts.proposals, RECEIVED_STATUSES);
  const capEvents = exposureFrom(parts.proposals, LIVE_STATUSES);
  const deliveries = parts.deliveryRows.flatMap((row) =>
    row.teams.map((team) => ({ team, minute: row.minute, timed: row.timed })),
  );
  const seen = parts.proposals.flatMap((row) => row.signals.map((signal) => signal.id));
  const last = parts.proposals[parts.proposals.length - 1];
  const onlineByTeam = onlineCounts(input.sessionId, parts.memberships);
  return {
    clock: {
      minute: input.elapsedMinutes,
      duration: scenario.duration,
      paused: input.status === 'paused',
      mode: parts.mode,
      lastWakeMinute: last ? last.minute : null,
      startMinute: env.directorStartMinute,
      tickMinutes: env.directorTickMinutes,
      minGapMinutes: env.directorMinGapMinutes,
    },
    signalState,
    previousWake: last ? { minute: last.minute, signal_ids: seen } : null,
    teams: roster,
    loadEvents,
    deliveries,
    pendingByTeam: unansweredByTeam(parts.deliveryRows),
    observation: observationOf(input, scenario, roster, parts),
    guard: {
      intensity: limits.intensity,
      per15: scaled.per15,
      perTeam30: scaled.perTeam30,
      maxSeverity: limits.maxSeverity,
      pressureMax: limits.pressureMax,
      teams: roster,
      protectedTeams: settings.protected,
      allowedApps: settings.apps,
      roleIds: parsePlayerRoles(scenario.initial.player_roles).map((role) => role.role_id),
      stakeholders: readPeople(scenario.initial),
      npcs: readNpcs(scenario.initial),
      orgs: readOrgs(scenario.initial).map((org) => org.name),
      brief: readBrief(scenario),
      facts: readFacts(scenario.initial),
      recentTexts: parts.deliveryRows
        .filter((row) => input.elapsedMinutes - row.minute <= 30)
        .flatMap((row) =>
          row.teams.map((team) => ({
            team,
            minute: row.minute,
            title: row.title,
            content: row.content,
          })),
        ),
      upcoming: parts.upcoming,
      deliveries,
      capEvents,
      unansweredByTeam: unansweredByTeam(parts.deliveryRows),
      ...(onlineByTeam ? { onlineByTeam } : {}),
      priorLowMediumTeams: priorLightTeams(loadEvents),
      authoredKeysByTeam: authoredKeys(parts.deliveryRows),
    },
    limits,
    seed: parts.seed,
    wakeSeq: nextSeq(parts.proposals),
    budgetKey: `director:${input.sessionId}`,
    lastQuiet:
      last && last.status === 'no_action'
        ? { minute: last.minute, reason: last.reason ?? '' }
        : null,
  };
}

function observationOf(
  input: DirectorTickInput,
  scenario: ScenarioRow,
  roster: DirectorTeam[],
  parts: {
    proposals: ProposalHistory[];
    triggers: TriggerRow[];
    deliveryRows: DeliveryFact[];
    upcoming: UpcomingInject[];
    settings: DirectorSettings;
  },
): DirectorTurnInput['observation'] {
  const facts = readFacts(scenario.initial);
  const claims = readClaims(scenario.initial);
  const comms = input.comms;
  return {
    title: scenario.title,
    crisisType: readCrisis(scenario),
    minute: input.elapsedMinutes,
    duration: scenario.duration,
    brief: readBrief(scenario),
    facts,
    falseClaims: claims,
    teams: roster,
    dependencies: dependencyLines(input.dependencyState),
    recentByTeam: recentLines(roster, comms, input.elapsedMinutes),
    moods: (comms?.moods ?? [])
      .filter((mood) => mood.rung_id !== 'calm')
      .map((mood) => ({
        stakeholder: mood.stakeholder_id,
        scope: mood.scope_team,
        rung: mood.rung_id,
      })),
    upcoming: parts.upcoming,
    recentUnscripted: parts.proposals
      .filter((row) => RECEIVED_STATUSES.has(row.status) && row.title)
      .slice(-5)
      .map((row) => ({ minute: row.minute, target: row.teams.join(', '), title: row.title ?? '' })),
    exposure: roster.map((team) => ({
      team: team.name,
      director: parts.proposals.filter(
        (row) =>
          RECEIVED_STATUSES.has(row.status) && row.teams.some((name) => same(name, team.name)),
      ).length,
      crossTeam: parts.triggers.filter(
        (row) =>
          row.origin !== 'director' &&
          isCrossTeam(row.source_teams, row.target_teams) &&
          row.target_teams.some((name) => same(name, team.name)),
      ).length,
    })),
    signals: [],
    cast: readPeople(scenario.initial),
    npcs: readNpcs(scenario.initial).map((npc) => ({ handle: npc.handle })),
    protectedTeams: parts.settings.protected,
    busyTeams: roster
      .filter(
        (team) => (unansweredByTeam(parts.deliveryRows)[slugifyTeamName(team.name)] ?? 0) >= 3,
      )
      .map((team) => team.name),
  };
}

function rosterOf(
  teams: Array<{ name: string }>,
  initial: Record<string, unknown>,
  memberships: Array<{ user_id: string; team_name: string }>,
): DirectorTeam[] {
  const orgs = readOrgs(initial);
  const names = teams.map((team) => team.name).filter(Boolean);
  const source = names.length > 0 ? names : orgs.flatMap((org) => org.teams);
  const unique = [...new Set(source.map((name) => name.trim()).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b),
  );
  return unique.map((name) => {
    const members = memberships.filter((row) => same(row.team_name, name));
    const org = orgs.find(
      (row) => row.teams.some((team) => same(team, name)) || same(row.name, name),
    );
    return {
      name,
      org: org?.name ?? '',
      functionName: '',
      members: [],
      size: Math.max(1, members.length),
      staffed: memberships.length === 0 ? true : members.length > 0,
      playable: org ? org.operation !== 'ai' : true,
      active: true,
    };
  });
}

function onlineCounts(
  sessionId: string,
  memberships: Array<{ user_id: string; team_name: string }>,
): Record<string, number> | undefined {
  if (inBootGrace() || memberships.length === 0) return undefined;
  const counts: Record<string, number> = {};
  for (const row of memberships) {
    const slug = slugifyTeamName(row.team_name);
    if (!slug) continue;
    const online = sessionUserOnline(sessionId, row.user_id) ? 1 : 0;
    counts[slug] = (counts[slug] ?? 0) + online;
  }
  return counts;
}

function limitsFor(settings: DirectorSettings): DirectorLimits {
  const scenarioCap = settings.maxSeverity;
  const envCap = env.directorMaxSeverity;
  const maxSeverity = rank(scenarioCap) < rank(envCap) ? scenarioCap : envCap;
  return {
    temperature: env.directorTemperature,
    per15: env.directorMaxPer15Min,
    perTeam30: env.directorMaxPerTeam30Min,
    maxSeverity,
    tolerance: env.directorFairnessTolerance,
    consistencyEnabled: env.directorConsistencyCheck,
    pressureMax: env.teamPressureMaxDeliveries10Min,
    intensity: settings.intensity,
    budget: env.directorAiBudgetPerSessionHour,
  };
}

function resolveMode(sessionMode: string | null, scenarioMode: string | null): DirectorMode {
  const raw = sessionMode || scenarioMode || 'auto';
  if (raw === 'off' || raw === 'suggest' || raw === 'auto') return raw;
  return 'auto';
}

function exposureFrom(rows: ProposalHistory[], statuses: Set<string>): ExposureEvent[] {
  const events: ExposureEvent[] = [];
  for (const row of rows) {
    if (!statuses.has(row.status) || !row.kind || !row.severity) continue;
    for (const team of row.teams) {
      events.push({ minute: row.minute, team, kind: row.kind, severity: row.severity });
    }
  }
  return events;
}

function priorLightTeams(events: ExposureEvent[]): string[] {
  return events
    .filter((event) => event.severity === 'low' || event.severity === 'medium')
    .map((event) => event.team);
}

function unansweredByTeam(rows: DeliveryFact[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    if (!row.requiresResponse || !row.unanswered) continue;
    for (const team of row.teams) {
      const slug = slugifyTeamName(team);
      counts[slug] = (counts[slug] ?? 0) + 1;
    }
  }
  return counts;
}

function authoredKeys(rows: DeliveryFact[]): Record<string, string[]> {
  const map: Record<string, string[]> = {};
  for (const row of rows) {
    if (!row.injectKey || row.generationSource === 'ai_director') continue;
    for (const team of row.teams) {
      const slug = slugifyTeamName(team);
      const list = map[slug] ?? [];
      if (!list.includes(row.injectKey)) list.push(row.injectKey);
      map[slug] = list;
    }
  }
  return map;
}

function triggersByKeyOf(rows: TriggerRow[]): Record<string, DepthTrigger> {
  const map: Record<string, DepthTrigger> = {};
  for (const row of rows) {
    const next: DepthTrigger = {
      cause_depth: row.cause_depth,
      source_teams: row.source_teams,
      target_teams: row.target_teams,
      origin: row.origin,
      is_cross_team: row.origin === 'director' || isCrossTeam(row.source_teams, row.target_teams),
    };
    const current = map[row.inject_key];
    if (!current || (next.cause_depth ?? 0) > (current.cause_depth ?? 0))
      map[row.inject_key] = next;
  }
  return map;
}

function dependencyLines(state: Record<string, DependencySnapshot> | null | undefined) {
  if (!state) return [];
  return Object.keys(state)
    .sort()
    .map((id) => {
      const edge = state[id];
      return {
        id,
        upstream: edge?.upstream ?? '',
        downstream: edge?.downstream ?? [],
        deliverable: edge?.deliverable ?? id,
        status: edge?.status ?? 'pending',
        since: edge?.broken_minute ?? edge?.met_minute ?? null,
      };
    });
}

function recentLines(teams: DirectorTeam[], comms: CommsState | null, minute: number) {
  return teams.map((team) => {
    const slug = slugifyTeamName(team.name);
    const deliveries = comms ? deliveriesFor(comms, team.name, minute) : [];
    const recent = deliveries.filter(
      (row) => minute - row.delivered_minute <= 15 && minute - row.delivered_minute >= 0,
    );
    const replies = recent.flatMap((row) => row.responses);
    const passed = replies.filter((response) => response.judgement?.passed === true).length;
    const failed = replies.filter((response) => response.judgement?.passed === false).length;
    const tones = replies
      .map((response) => response.judgement?.tone)
      .filter((tone): tone is string => Boolean(tone));
    const duties = (comms?.duties?.[slug] ?? []).filter(
      (duty) =>
        duty.benchmark_minute != null &&
        minute > duty.benchmark_minute &&
        (duty.completed_minute == null || duty.completed_minute > duty.benchmark_minute),
    ).length;
    const last = comms?.team_activity?.[slug]?.last_minute ?? null;
    const quiet = last == null ? minute : minute - last;
    const decisions = (comms?.decisions ?? []).filter(
      (row) => row.team_slug === slug && minute - row.minute <= 15 && minute - row.minute >= 0,
    ).length;
    return {
      team: team.name,
      deliveries: recent.length,
      unanswered: recent.filter((row) => row.responses.length === 0).length,
      replies: `${passed} passed, ${failed} failed${tones.length ? `, ${tones.slice(0, 3).join('/')}` : ''}`,
      dutiesMissed: duties,
      silence: comms?.team_activity_known !== false && minute >= 10 && quiet >= 10,
      decisions,
    };
  });
}

function deliveriesFor(comms: CommsState, team: string, _minute: number) {
  const rows = Object.values(comms.by_key ?? {}).flat();
  return rows.filter(
    (row) =>
      row.recipient_teams.length === 0 || row.recipient_teams.some((name) => same(name, team)),
  );
}

async function proposalsReady(sessionId: string): Promise<boolean> {
  if (directorUnavailable) return false;
  try {
    const { error } = await supabaseAdmin
      .from('director_proposals')
      .select('id')
      .eq('session_id', sessionId)
      .limit(1);
    if (!error) return true;
    if (SCHEMA_CODES.has(error.code ?? '')) {
      noteUnavailable(error);
      return false;
    }
    logger.warn({ err: error, sessionId }, 'director history was not read');
    return false;
  } catch (err) {
    if (schemaError(err)) noteUnavailable(err);
    else logger.warn({ err, sessionId }, 'director history was not read');
    return false;
  }
}

async function loadSession(
  sessionId: string,
): Promise<{ director_mode: string | null; director_seed: string | null } | null> {
  const { data, error } = await supabaseAdmin
    .from('sessions')
    .select('director_mode, director_seed')
    .eq('id', sessionId)
    .maybeSingle();
  if (error) {
    if (SCHEMA_CODES.has(error.code ?? '')) noteUnavailable(error);
    else logger.warn({ err: error, sessionId }, 'director session settings were not read');
    return null;
  }
  return {
    director_mode: (data?.director_mode as string | null) ?? null,
    director_seed: data?.director_seed == null ? null : String(data.director_seed),
  };
}

async function ensureSeed(
  sessionId: string,
  scenarioId: string,
  existing: string | null,
): Promise<bigint | null> {
  if (existing != null && existing !== '') {
    try {
      return BigInt(existing);
    } catch {
      return directorSeed(sessionId, scenarioId, env.directorSeedSalt);
    }
  }
  const seed = directorSeed(sessionId, scenarioId, env.directorSeedSalt);
  const { error } = await supabaseAdmin
    .from('sessions')
    .update({ director_seed: seed.toString() })
    .eq('id', sessionId)
    .is('director_seed', null);
  if (error && SCHEMA_CODES.has(error.code ?? '')) {
    noteUnavailable(error);
    return null;
  }
  if (error) logger.warn({ err: error, sessionId }, 'director seed was not stored');
  return seed;
}

interface ScenarioRow {
  title: string;
  category: string | null;
  description: string;
  briefing: string;
  duration: number;
  initial: Record<string, unknown>;
}

async function loadScenario(scenarioId: string): Promise<ScenarioRow | null> {
  const { data, error } = await supabaseAdmin
    .from('scenarios')
    .select('title, category, description, briefing, duration_minutes, initial_state')
    .eq('id', scenarioId)
    .maybeSingle();
  if (error || !data) {
    if (error) logger.warn({ err: error, scenarioId }, 'director scenario was not read');
    return null;
  }
  const duration = Number(data.duration_minutes);
  return {
    title: String(data.title ?? 'Exercise'),
    category: (data.category as string | null) ?? null,
    description: String(data.description ?? ''),
    briefing: String(data.briefing ?? ''),
    duration: Number.isFinite(duration) && duration > 0 ? duration : 60,
    initial: (data.initial_state as Record<string, unknown> | null) ?? {},
  };
}

interface ProposalHistory {
  seq: number;
  minute: number;
  status: string;
  reason: string | null;
  signals: Signal[];
  teams: string[];
  kind: ExposureEvent['kind'] | null;
  severity: ExposureEvent['severity'] | null;
  title: string | null;
}

async function loadProposals(sessionId: string): Promise<ProposalHistory[]> {
  const { data, error } = await supabaseAdmin
    .from('director_proposals')
    .select('seq, minute, status, signals, proposal, raw_output')
    .eq('session_id', sessionId)
    .order('seq', { ascending: true })
    .limit(300);
  if (error || !data) return [];
  return data.map((row) => {
    const proposal = (row.proposal ?? null) as {
      kind?: string;
      severity?: string;
      target_teams?: string[];
      title?: string;
    } | null;
    const raw = (row.raw_output ?? null) as { reason?: string } | null;
    const kind = proposal?.kind;
    const severity = proposal?.severity;
    return {
      seq: Number(row.seq),
      minute: Number(row.minute),
      status: String(row.status),
      reason: typeof raw?.reason === 'string' ? raw.reason : null,
      signals: Array.isArray(row.signals) ? (row.signals as Signal[]) : [],
      teams: Array.isArray(proposal?.target_teams) ? proposal.target_teams.map(String) : [],
      kind:
        kind === 'consequence' ||
        kind === 'escalation' ||
        kind === 'opportunity' ||
        kind === 'relief'
          ? kind
          : null,
      severity:
        severity === 'low' || severity === 'medium' || severity === 'high' ? severity : null,
      title: proposal?.title ?? null,
    };
  });
}

interface TriggerRow {
  inject_key: string;
  cause_depth: number;
  source_teams: string[];
  target_teams: string[];
  origin: string;
}

async function loadTriggers(sessionId: string): Promise<TriggerRow[]> {
  const { data, error } = await supabaseAdmin
    .from('inject_triggers')
    .select('inject_key, cause_depth, source_teams, target_teams, origin')
    .eq('session_id', sessionId)
    .limit(500);
  if (error || !data) return [];
  return data.map((row) => ({
    inject_key: String(row.inject_key),
    cause_depth: Number(row.cause_depth ?? 0),
    source_teams: asStrings(row.source_teams),
    target_teams: asStrings(row.target_teams),
    origin: String(row.origin ?? ''),
  }));
}

interface DeliveryFact {
  minute: number;
  teams: string[];
  timed: boolean;
  title: string;
  content: string;
  requiresResponse: boolean;
  unanswered: boolean;
  injectKey: string | null;
  generationSource: string | null;
}

async function loadDeliveries(sessionId: string, minute: number): Promise<DeliveryFact[]> {
  const since = Math.max(0, minute - 30);
  const { data, error } = await supabaseAdmin
    .from('inject_deliveries')
    .select('inject_id, recipient_teams, delivered_minute, first_response_minute')
    .eq('session_id', sessionId)
    .gte('delivered_minute', since)
    .limit(200);
  if (error || !data || data.length === 0) return [];
  const ids = [...new Set(data.map((row) => String(row.inject_id)))];
  const { data: injects } = await supabaseAdmin
    .from('scenario_injects')
    .select(
      'id, title, content, trigger_time_minutes, requires_response, generation_source, delivery_config',
    )
    .in('id', ids);
  const byId = new Map((injects ?? []).map((row) => [String(row.id), row]));
  return data.map((row) => {
    const inject = byId.get(String(row.inject_id));
    const config = (inject?.delivery_config ?? null) as { inject_key?: string } | null;
    const teams = asStrings(row.recipient_teams);
    return {
      minute: Number(row.delivered_minute),
      teams,
      timed: inject?.trigger_time_minutes != null,
      title: String(inject?.title ?? ''),
      content: String(inject?.content ?? ''),
      requiresResponse: inject?.requires_response === true,
      unanswered: row.first_response_minute == null,
      injectKey: config?.inject_key ?? null,
      generationSource: (inject?.generation_source as string | null) ?? null,
    };
  });
}

async function loadActivePlans(
  sessionId: string,
): Promise<Array<{ team_slug: string; category: string }>> {
  const { data, error } = await supabaseAdmin
    .from('session_decisions')
    .select('team_name, status, detail')
    .eq('session_id', sessionId)
    .eq('status', 'active')
    .limit(100);
  if (error || !data) return [];
  const plans: Array<{ team_slug: string; category: string }> = [];
  for (const row of data) {
    const detail = (row.detail ?? null) as {
      category?: string;
      plan?: { nodes?: unknown[] };
    } | null;
    const nodes = detail?.plan?.nodes;
    if (!Array.isArray(nodes) || nodes.length === 0) continue;
    const team = String(row.team_name ?? '');
    const category = detail?.category ?? '';
    if (!team || !category) continue;
    plans.push({ team_slug: slugifyTeamName(team), category });
  }
  return plans;
}

async function loadTeams(scenarioId: string): Promise<Array<{ name: string }>> {
  const { data, error } = await activeTeams(
    supabaseAdmin.from('scenario_teams').select('team_name').eq('scenario_id', scenarioId),
  );
  if (error || !data) return [];
  return data
    .map((row) => ({ name: String((row as { team_name?: string }).team_name ?? '').trim() }))
    .filter((row) => row.name);
}

async function loadMemberships(
  sessionId: string,
): Promise<Array<{ user_id: string; team_name: string }>> {
  const { data, error } = await supabaseAdmin
    .from('session_teams')
    .select('user_id, team_name')
    .eq('session_id', sessionId);
  if (error || !data) return [];
  return data.map((row) => ({
    user_id: String(row.user_id),
    team_name: String(row.team_name ?? ''),
  }));
}

async function loadUpcoming(scenarioId: string, minute: number): Promise<UpcomingInject[]> {
  const { data, error } = await activeTemplateInjects(
    supabaseAdmin
      .from('scenario_injects')
      .select('title, content, target_teams, trigger_time_minutes, delivery_config')
      .eq('scenario_id', scenarioId)
      .is('session_id', null)
      .gte('trigger_time_minutes', minute)
      .lte('trigger_time_minutes', minute + 20)
      .limit(20),
  );
  if (error || !data) return [];
  return data.map((row) => {
    const config = (row.delivery_config ?? null) as { inject_key?: string } | null;
    return {
      key: config?.inject_key || slugifyTeamName(String(row.title ?? 'inject')) || 'inject',
      title: String(row.title ?? ''),
      content: String(row.content ?? ''),
      minute: Number(row.trigger_time_minutes ?? minute),
      target_teams: asStrings(row.target_teams),
    };
  });
}

async function insertProposal(
  sessionId: string,
  seq: number,
  turn: DirectorTurnInput,
  draft: DirectorDraft,
): Promise<boolean> {
  const observation = {
    ...(draft.observation ?? {}),
    replay: serializeTurn(turn),
    focus_id: draft.focus_id,
    decision_reason: draft.reason,
  };
  const { error } = await supabaseAdmin.from('director_proposals').insert({
    session_id: sessionId,
    seq,
    minute: draft.minute,
    wake_reason: draft.wake_reason,
    seed: draft.seed.toString(),
    signals: draft.signals,
    observation,
    observation_sha256: draft.observation?.sha256 ?? null,
    prompt_version: draft.promptVersion,
    prompt_text: draft.promptText,
    model: draft.model,
    temperature: draft.temperature,
    provider_seed_applied: draft.provider_seed_applied,
    raw_output: draft.raw_output,
    proposal: draft.proposal,
    guardrails: draft.guardrails,
    consistency: draft.consistency,
    fairness: draft.fairness,
    status: draft.status,
    mode: draft.mode,
    fairness_override: false,
    inject_id: null,
    tokens_in: draft.tokens_in,
    tokens_out: draft.tokens_out,
  });
  if (!error) return true;
  if (SCHEMA_CODES.has(error.code ?? '')) {
    noteUnavailable(error);
    return false;
  }
  const key = error.code ?? 'insert';
  if (!insertWarned.has(key)) {
    insertWarned.add(key);
    logger.warn({ err: error, sessionId, seq }, 'director proposal was not stored');
  }
  return false;
}

async function loadReplayRows(
  sessionId: string,
): Promise<Array<{ seq: number; replay: unknown; view: ReplayRow }> | null> {
  const { data, error } = await supabaseAdmin
    .from('director_proposals')
    .select(
      'seq, minute, wake_reason, status, signals, observation, proposal, guardrails, consistency, fairness, raw_output',
    )
    .eq('session_id', sessionId)
    .order('seq', { ascending: true })
    .limit(300);
  if (error) {
    if (SCHEMA_CODES.has(error.code ?? '')) {
      noteUnavailable(error);
      return null;
    }
    logger.warn({ err: error, sessionId }, 'director replay was not loaded');
    return [];
  }
  return (data ?? []).map((row) => {
    const observation = (row.observation ?? null) as
      | (ReplayRow['observation'] & {
          replay?: unknown;
          focus_id?: string | null;
          decision_reason?: string | null;
        })
      | null;
    const {
      replay: _replay,
      focus_id: focusId,
      decision_reason: decisionReason,
      ...rest
    } = observation ?? {};
    const viewObservation =
      rest && typeof rest === 'object' && 'text' in rest
        ? (rest as ReplayRow['observation'])
        : null;
    return {
      seq: Number(row.seq),
      replay: observation?.replay,
      view: {
        seq: Number(row.seq),
        minute: Number(row.minute),
        wake_reason: row.wake_reason as ReplayRow['wake_reason'],
        status: String(row.status),
        reason: typeof decisionReason === 'string' ? decisionReason : null,
        signals: Array.isArray(row.signals) ? (row.signals as Signal[]) : [],
        observation: viewObservation,
        focus_id: typeof focusId === 'string' ? focusId : null,
        guardrails: Array.isArray(row.guardrails)
          ? (row.guardrails as ReplayRow['guardrails'])
          : [],
        fairness: (row.fairness as ReplayRow['fairness']) ?? null,
        raw_output: row.raw_output,
        consistency: (row.consistency as ReplayRow['consistency']) ?? null,
      },
    };
  });
}

function serializeTurn(input: DirectorTurnInput): unknown {
  return { ...input, seed: input.seed.toString() };
}

function restoreTurn(value: unknown): DirectorTurnInput | null {
  if (!value || typeof value !== 'object') return null;
  const seed = (value as { seed?: unknown }).seed;
  if (typeof seed !== 'string' && typeof seed !== 'number') return null;
  try {
    return { ...(value as DirectorTurnInput), seed: BigInt(seed) };
  } catch {
    return null;
  }
}

function emitProposal(
  trainerId: string,
  sessionId: string,
  seq: number,
  draft: DirectorDraft,
): void {
  if (!trainerId) return;
  try {
    getWebSocketService().emitToUser(trainerId, {
      type: 'director.proposal',
      data: {
        session_id: sessionId,
        seq,
        minute: draft.minute,
        status: draft.status,
        mode: draft.mode,
        wake_reason: draft.wake_reason,
        reason: draft.reason,
        proposal: draft.proposal,
        guardrails: draft.guardrails,
        fairness: draft.fairness,
      },
      timestamp: new Date().toISOString(),
    });
  } catch {
    /* websocket is optional when the scheduler runs without a socket server */
  }
}

async function recordDirectorEvent(
  sessionId: string,
  seq: number,
  draft: DirectorDraft,
): Promise<void> {
  const { error } = await supabaseAdmin.from('session_events').insert({
    session_id: sessionId,
    event_type: 'director_action',
    description: draft.proposal?.title || draft.reason || 'Director wake',
    metadata: { kind: 'consequence_proposal', seq, status: draft.status },
  });
  if (error && !insertWarned.has(`event:${error.code ?? ''}`)) {
    insertWarned.add(`event:${error.code ?? ''}`);
    logger.warn({ err: error, sessionId }, 'director session event was not stored');
  }
}

function noteUnavailable(err: unknown): void {
  directorUnavailable = true;
  if (directorWarned) return;
  directorWarned = true;
  logger.warn(
    { err, event: 'director_unavailable' },
    'AI director is off because migration 279 is not applied',
  );
}

function schemaError(err: unknown): boolean {
  return SCHEMA_CODES.has(codeOf(err) ?? '');
}

function codeOf(err: unknown): string | null {
  if (!err || typeof err !== 'object') return null;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

function nextSeq(rows: ProposalHistory[]): number {
  return rows.reduce((max, row) => Math.max(max, row.seq), 0) + 1;
}

interface DirectorSettings {
  mode: string | null;
  intensity: 'low' | 'medium' | 'high';
  protected: string[];
  apps: string[];
  maxSeverity: 'low' | 'medium' | 'high';
}

function readDirectorSettings(initial: Record<string, unknown>): DirectorSettings {
  const director = (initial.director ?? null) as {
    mode?: string;
    intensity?: string;
    protected_teams?: unknown;
    allowed_apps?: unknown;
    max_severity?: string;
  } | null;
  const intensity = director?.intensity;
  const severity = director?.max_severity;
  return {
    mode: director?.mode ?? null,
    intensity: intensity === 'low' || intensity === 'high' ? intensity : 'medium',
    protected: teamRefs(director?.protected_teams),
    apps: asStrings(director?.allowed_apps).filter((app) => APPS.includes(app)).length
      ? asStrings(director?.allowed_apps).filter((app) => APPS.includes(app))
      : APPS,
    maxSeverity:
      severity === 'low' || severity === 'medium' || severity === 'high' ? severity : 'high',
  };
}

function teamRefs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const item of value) {
    if (typeof item === 'string' && item.trim()) names.push(item.trim());
    else if (
      item &&
      typeof item === 'object' &&
      typeof (item as { team_name?: string }).team_name === 'string'
    ) {
      names.push((item as { team_name: string }).team_name);
    }
  }
  return names;
}

function readBrief(scenario: ScenarioRow): string {
  const narrative = scenario.initial.narrative as { description?: string } | undefined;
  return String(
    narrative?.description ||
      scenario.initial.brief ||
      scenario.briefing ||
      scenario.description ||
      '',
  );
}

function readCrisis(scenario: ScenarioRow): string {
  const value = scenario.initial.crisis_type ?? scenario.initial.crisisType ?? scenario.category;
  return typeof value === 'string' && value.trim() ? value : 'crisis';
}

function readFacts(initial: Record<string, unknown>): string[] {
  const sheet = (initial.fact_sheet ?? initial.factSheet ?? null) as {
    confirmed_facts?: unknown;
  } | null;
  const direct = sheet?.confirmed_facts ?? initial.confirmed_facts;
  return asStrings(direct).slice(0, 8);
}

function readClaims(initial: Record<string, unknown>): string[] {
  const sheet = (initial.fact_sheet ?? initial.factSheet ?? null) as {
    unconfirmed_claims?: unknown;
  } | null;
  const raw = sheet?.unconfirmed_claims ?? initial.false_claims;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => (typeof item === 'string' ? item : ((item as { claim?: string })?.claim ?? '')))
    .filter(Boolean)
    .slice(0, 5);
}

function readPeople(initial: Record<string, unknown>): Array<{ id: string; name: string }> {
  const rows = Array.isArray(initial.stakeholders) ? initial.stakeholders : [];
  const people: Array<{ id: string; name: string }> = [];
  for (const item of rows) {
    if (!item || typeof item !== 'object') continue;
    const row = item as { id?: string; name?: string };
    if (row.id && row.name) people.push({ id: row.id, name: row.name });
  }
  return people;
}

function readNpcs(initial: Record<string, unknown>): Array<{ handle: string; name?: string }> {
  const raw = initial.personas ?? initial.npc_personas ?? initial.social_personas;
  if (!Array.isArray(raw)) return [];
  const npcs: Array<{ handle: string; name?: string }> = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const row = item as { handle?: string; id?: string; name?: string };
    const handle = row.handle || row.id;
    if (!handle) continue;
    npcs.push({ handle, ...(row.name ? { name: row.name } : {}) });
  }
  return npcs;
}

function readOrgs(
  initial: Record<string, unknown>,
): Array<{ name: string; operation: string; teams: string[] }> {
  const raw = initial.organisations ?? initial.organizations ?? initial.orgs;
  if (!Array.isArray(raw)) return [];
  const orgs: Array<{ name: string; operation: string; teams: string[] }> = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const row = item as { name?: string; operation?: string; teams?: unknown };
    if (!row.name) continue;
    orgs.push({
      name: row.name,
      operation: row.operation ?? 'players',
      teams: teamNames(row.teams),
    });
  }
  return orgs;
}

function asStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item ?? '').trim()).filter(Boolean);
}

function teamNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const item of value) {
    if (typeof item === 'string' && item.trim()) names.push(item.trim());
    else if (
      item &&
      typeof item === 'object' &&
      typeof (item as { name?: unknown }).name === 'string'
    ) {
      const name = (item as { name: string }).name.trim();
      if (name) names.push(name);
    }
  }
  return names;
}

function same(a: string, b: string): boolean {
  return slugifyTeamName(a) !== '' && slugifyTeamName(a) === slugifyTeamName(b);
}

function rank(severity: 'low' | 'medium' | 'high'): number {
  return severity === 'high' ? 3 : severity === 'medium' ? 2 : 1;
}
