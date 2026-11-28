/**
 * After-action timeline for response-requiring injects.
 * Each source is optional: a missing table (migrations 268–273) leaves that
 * part empty and warns once. The section itself always comes back.
 */

import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { templateInjectsValidAt } from '../lib/templateRows.js';
import { logger } from '../lib/logger.js';
import {
  openedAtOf,
  selectSession as selectSessionClock,
  type SessionClockFields,
} from '../lib/peaceSchema.js';
import { playerTopicLabels, type PlayerTopicLabel } from './scoring/crisisActivityCore.js';
import { loadPlayerTopicSources } from './scoring/crisisActivityLookup.js';
import {
  countsOnCrisisClock,
  crisisFiltersActive,
  crisisMinute,
  rosterValidAt,
} from '../lib/peaceGate.js';
import { injectKeyOf } from '../lib/injectKey.js';
import { collectConditionKeys, parseConditionKey } from './conditions/conditionCatalog.js';
import type { JudgementV1 } from './ledger/injectLedgerCore.js';
import { AAR_STORED_CAP } from '../../shared/crossTeamAar.js';
import { originLabel, teamsDiffer, timelineOriginFor } from '../../shared/crossTeamPanel.js';
import { errorCode, isUnappliedSchema } from '../lib/unappliedSchema.js';
import {
  CROSS_TEAM_READ_LIMITS,
  readInjectTriggers,
  type TriggerHistoryRow,
} from './crossTeam/crossTeamReads.js';

export { isUnappliedSchema };

const warned = new Set<string>();

function isMissingColumn(err: unknown): boolean {
  const code = errorCode(err);
  return code === '42703' || code === 'PGRST204';
}

function isMissingTable(err: unknown): boolean {
  const code = errorCode(err);
  return code === '42P01' || code === 'PGRST205';
}

/** One warning per process. A second session does not repeat it. */
function warnUnapplied(migration: string, message: string): void {
  if (warned.has(migration)) return;
  warned.add(migration);
  logger.warn({ event: 'aar_comms_unapplied', migration }, message);
}

function warnRead(where: string, err: unknown): void {
  const key = `read:${where}:${errorCode(err) ?? 'unknown'}`;
  if (warned.has(key)) return;
  warned.add(key);
  logger.warn({ err, event: 'aar_comms_read_failed', where }, 'Comms timeline read failed');
}

export interface CommsTimelineRow {
  minute: number | '';
  parent: string;
  event: string;
  inject: string;
  channel: string;
  who: string;
  detail: string;
  /** §5.9 label, or "inferred" when this session has no trigger row for the inject. */
  origin?: string;
  /** Director cause and decision, when this row is an unscripted event. */
  origin_note?: string;
}

export interface AarTriggerAttribution {
  inject_id?: string;
  inject_key: string;
  origin: string;
  source_teams: string[];
  target_teams: string[];
}

export interface CommsMoodRow {
  stakeholder: string;
  scope: string;
  rung: string;
  history: string;
  consequences: string;
}

export interface CommsResponsesSection {
  response_injects: number;
  timeline: CommsTimelineRow[];
  moods: CommsMoodRow[];
  /** Present only when a player comment, DM or email carries a topic label. */
  player_topics?: PlayerTopicLabel[];
}

export function emptyCommsResponses(): CommsResponsesSection {
  return { response_injects: 0, timeline: [], moods: [] };
}

export interface AarDelivery {
  id: string;
  inject_id: string;
  inject_key: string;
  channel: string;
  delivered_minute: number;
  recipient_teams?: string[];
  sender_name?: string | null;
  requires_response?: boolean;
  first_opened_minute?: number | null;
  first_opened_by?: string | null;
  call_state?: string | null;
  call_group_id?: string | null;
  attempt_no?: number | null;
  chain_root_key?: string | null;
  chain_step?: number | null;
  urgency?: string | null;
  mood_rung?: string | null;
  ref_id?: string | null;
}

export interface AarResponse {
  id?: string;
  delivery_id: string;
  inject_key: string;
  channel: string;
  user_id?: string | null;
  team_name?: string | null;
  response_minute: number;
  judgement_status?: string | null;
  judgement?: JudgementV1 | null;
  wait_minutes?: number | null;
  mood_rung?: string | null;
}

export interface AarCall {
  id: string;
  inject_id?: string | null;
  call_group_id: string;
  attempt_no: number;
  max_attempts: number;
  status: string;
  minute: number | null;
  answered_by?: string | null;
  declined_by?: string | null;
}

export interface AarChain {
  id: string;
  root_key: string;
  status: string;
  steps_sent: number;
  max_steps: number;
  stopped_reason?: string | null;
  stopped_minute?: number | null;
}

export interface AarChainStep {
  chain_id: string;
  step_no: number;
  urgency: string;
  app: string;
  delivered_minute: number | null;
  inject_id?: string | null;
}

export interface AarMood {
  stakeholder_id: string;
  scope_team: string;
  rung_id: string;
  history: Array<{ rung?: string; minute?: number; reason?: string }>;
  consequences_fired?: string[];
}

export interface AarInject {
  id: string;
  title?: string | null;
  inject_key?: string | null;
  requires_response?: boolean | null;
  conditions_to_appear?: unknown;
  conditions_to_cancel?: unknown;
  app?: string | null;
  target_teams?: string[];
  trigger_time_minutes?: number | null;
}

export interface AarBranchEvent {
  event_type: 'inject' | 'inject_cancelled';
  minute: number | null;
  inject_id: string;
}

export interface AarDirectMessage {
  id: string;
  inject_id: string;
  minute: number | null;
  sender_id?: string | null;
}

export interface CommsResponsesInput {
  deliveries?: readonly AarDelivery[];
  responses?: readonly AarResponse[];
  calls?: readonly AarCall[] | null;
  chains?: readonly AarChain[] | null;
  steps?: readonly AarChainStep[] | null;
  moods?: readonly AarMood[] | null;
  injects?: readonly AarInject[];
  events?: readonly AarBranchEvent[];
  directMessages?: readonly AarDirectMessage[] | null;
  names?: Readonly<Record<string, string>>;
  /** Null or omitted: no trigger rows, so branch attribution is inferred. */
  triggers?: readonly AarTriggerAttribution[] | null;
  /** inject_key → §5.9 sentence for a director delivery. */
  unscriptedNotes?: Readonly<Record<string, string>>;
  playerTopics?: readonly PlayerTopicLabel[];
}

const EVENT_ORDER = [
  'delivered',
  'opened',
  'chain_step',
  'call_attempt',
  'responded',
  'branch',
  'branch_cancelled',
  'chain',
  'mood',
  'consequence',
];

const TIMELINE_CAP = AAR_STORED_CAP;

export function buildCommsResponsesSection(input: CommsResponsesInput): CommsResponsesSection {
  const names = input.names ?? {};
  const injects = input.injects ?? [];
  const deliveries = input.deliveries ?? [];
  const responses = input.responses ?? [];
  const calls = input.calls ?? [];
  const chains = input.chains ?? [];
  const steps = input.steps ?? [];
  const moods = input.moods ?? [];
  const events = input.events ?? [];
  const messages = input.directMessages ?? [];
  const triggerById = new Map<string, AarTriggerAttribution>();
  const triggerByKey = new Map<string, AarTriggerAttribution>();
  for (const trigger of input.triggers ?? []) {
    if (trigger.inject_id) triggerById.set(trigger.inject_id, trigger);
    if (trigger.inject_key) triggerByKey.set(trigger.inject_key, trigger);
  }

  const injectById = new Map(injects.map((inject) => [inject.id, inject]));
  const refIds = new Set(
    deliveries.map((delivery) => delivery.ref_id).filter((id): id is string => !!id),
  );
  const allDeliveries: AarDelivery[] = [...deliveries];
  for (const message of messages) {
    if (refIds.has(message.id)) continue;
    const inject = injectById.get(message.inject_id);
    if (!inject?.requires_response) continue;
    allDeliveries.push({
      id: `dm:${message.id}`,
      inject_id: message.inject_id,
      inject_key: inject.inject_key || injectKeyOf({ id: inject.id, delivery_config: null }),
      channel: 'messenger_dm',
      delivered_minute: message.minute ?? 0,
      requires_response: true,
      ref_id: message.id,
    });
  }

  const responsesByDelivery = new Map<string, AarResponse[]>();
  for (const response of responses) {
    const list = responsesByDelivery.get(response.delivery_id) ?? [];
    list.push(response);
    responsesByDelivery.set(response.delivery_id, list);
  }

  const knownKeys = new Set<string>();
  for (const inject of injects) {
    if (inject.inject_key) knownKeys.add(inject.inject_key);
  }
  for (const delivery of allDeliveries) knownKeys.add(delivery.inject_key);

  const roots = new Set<string>();
  for (const delivery of allDeliveries) {
    if (delivery.chain_step != null) continue;
    const inject = injectById.get(delivery.inject_id);
    if (delivery.requires_response || inject?.requires_response) roots.add(delivery.inject_key);
  }

  const chainById = new Map(chains.map((chain) => [chain.id, chain]));
  const rows: CommsTimelineRow[] = [];

  for (const delivery of allDeliveries) {
    const parent =
      delivery.chain_step != null && delivery.chain_root_key
        ? delivery.chain_root_key
        : delivery.inject_key;
    if (!roots.has(parent)) continue;
    if (delivery.chain_step == null) {
      rows.push(
        timelineRow({
          minute: delivery.delivered_minute,
          parent,
          event: 'delivered',
          inject: delivery.inject_key,
          channel: delivery.channel,
          who: delivery.recipient_teams?.join(', ') ?? '',
          detail: deliveryDetail(delivery),
        }),
      );
      if (delivery.first_opened_minute != null) {
        rows.push(
          timelineRow({
            minute: delivery.first_opened_minute,
            parent,
            event: 'opened',
            inject: delivery.inject_key,
            channel: delivery.channel,
            who: person(delivery.first_opened_by, null, names),
            detail: 'opened',
          }),
        );
      }
    }
    for (const response of responsesByDelivery.get(delivery.id) ?? []) {
      rows.push(
        timelineRow({
          minute: response.response_minute,
          parent,
          event: 'responded',
          inject: response.inject_key || delivery.inject_key,
          channel: response.channel || delivery.channel,
          who: person(response.user_id, response.team_name, names),
          detail: responseDetail(response),
        }),
      );
    }
  }

  const coveredSteps = new Set<string>();
  for (const step of steps) {
    const chain = chainById.get(step.chain_id);
    if (!chain || !roots.has(chain.root_key)) continue;
    coveredSteps.add(`${chain.root_key}:${step.step_no}`);
    const inject = step.inject_id ? injectById.get(step.inject_id) : undefined;
    rows.push(
      timelineRow({
        minute: step.delivered_minute ?? '',
        parent: chain.root_key,
        event: 'chain_step',
        inject: inject?.inject_key || inject?.title || '',
        channel: channelOfApp(step.app),
        who: '',
        detail: `step ${step.step_no} of ${chain.max_steps} · ${step.urgency} · ${step.app}`,
      }),
    );
  }
  for (const delivery of allDeliveries) {
    if (delivery.chain_step == null || !delivery.chain_root_key) continue;
    if (!roots.has(delivery.chain_root_key)) continue;
    const key = `${delivery.chain_root_key}:${delivery.chain_step}`;
    if (coveredSteps.has(key)) continue;
    const chain = chains.find((item) => item.root_key === delivery.chain_root_key);
    rows.push(
      timelineRow({
        minute: delivery.delivered_minute,
        parent: delivery.chain_root_key,
        event: 'chain_step',
        inject: delivery.inject_key,
        channel: delivery.channel,
        who: '',
        detail: `step ${delivery.chain_step}${chain ? ` of ${chain.max_steps}` : ''} · ${delivery.urgency ?? 'follow-up'} · ${delivery.channel}`,
      }),
    );
  }

  for (const chain of chains) {
    if (!roots.has(chain.root_key)) continue;
    if (chain.status !== 'stopped' && chain.status !== 'exhausted') continue;
    const reason = chain.status === 'stopped' ? chain.stopped_reason || 'stopped' : 'exhausted';
    rows.push(
      timelineRow({
        minute: chain.stopped_minute ?? '',
        parent: chain.root_key,
        event: 'chain',
        inject: chain.root_key,
        channel: '',
        who: '',
        detail: `${reason} after step ${chain.steps_sent}`,
      }),
    );
  }

  for (const call of calls) {
    const located = locateCall(call, allDeliveries, injectById);
    if (!located || !roots.has(located.parent)) continue;
    const whoId = call.answered_by || call.declined_by;
    rows.push(
      timelineRow({
        minute: call.minute ?? '',
        parent: located.parent,
        event: 'call_attempt',
        inject: located.inject,
        channel: 'call',
        who: person(whoId, null, names),
        detail: `${call.status} · attempt ${call.attempt_no} of ${call.max_attempts}`,
      }),
    );
  }

  for (const event of events) {
    const inject = injectById.get(event.inject_id);
    if (!inject) continue;
    const label = inject.inject_key || inject.title || inject.id;
    const parents = referencedParents(inject, knownKeys).filter(
      (key) => roots.has(key) && key !== label,
    );
    const verb = event.event_type === 'inject_cancelled' ? 'cancelled' : 'published';
    const trigger = triggerById.get(event.inject_id) ?? triggerByKey.get(label);
    const who = trigger && trigger.source_teams.length > 0 ? trigger.source_teams.join(', ') : '';
    const origin = trigger
      ? originLabel(trigger.origin, teamsDiffer(trigger.source_teams, trigger.target_teams))
      : 'inferred';
    for (const parent of parents) {
      rows.push(
        timelineRow({
          minute: event.minute ?? '',
          parent,
          event: event.event_type === 'inject_cancelled' ? 'branch_cancelled' : 'branch',
          inject: label,
          channel: inject.app ?? '',
          who,
          origin,
          detail: `${verb}: ${inject.title || label}`,
        }),
      );
    }
  }

  const moodRows: CommsMoodRow[] = [];
  for (const mood of moods) {
    const history = mood.history
      .map((item) => {
        const rung = item.rung || '';
        if (!rung) return '';
        return item.minute != null ? `${rung} at T+${item.minute}` : rung;
      })
      .filter(Boolean)
      .join(' → ');
    const consequences = (mood.consequences_fired ?? []).join(', ');
    moodRows.push({
      stakeholder: mood.stakeholder_id,
      scope: mood.scope_team,
      rung: mood.rung_id,
      history,
      consequences,
    });
    for (const item of mood.history) {
      if (!item.rung) continue;
      rows.push(
        timelineRow({
          minute: item.minute ?? '',
          parent: mood.stakeholder_id,
          event: 'mood',
          inject: '',
          channel: '',
          who: mood.stakeholder_id,
          detail: item.reason ? `${item.rung} · ${item.reason}` : item.rung,
        }),
      );
    }
    for (const id of mood.consequences_fired ?? []) {
      rows.push(
        timelineRow({
          minute: '',
          parent: mood.stakeholder_id,
          event: 'consequence',
          inject: '',
          channel: '',
          who: mood.stakeholder_id,
          detail: id,
        }),
      );
    }
  }

  rows.sort((left, right) => {
    const leftMinute = typeof left.minute === 'number' ? left.minute : Number.MAX_SAFE_INTEGER;
    const rightMinute = typeof right.minute === 'number' ? right.minute : Number.MAX_SAFE_INTEGER;
    if (leftMinute !== rightMinute) return leftMinute - rightMinute;
    return EVENT_ORDER.indexOf(left.event) - EVENT_ORDER.indexOf(right.event);
  });

  const notes = input.unscriptedNotes ?? {};
  const labelled = rows.map((row) => labelTimelineRow(row, triggerByKey, notes));

  const section: CommsResponsesSection = {
    response_injects: roots.size,
    timeline: labelled.slice(0, TIMELINE_CAP),
    moods: moodRows,
  };
  if (input.playerTopics && input.playerTopics.length > 0) {
    section.player_topics = [...input.playerTopics];
  }
  return section;
}

function labelTimelineRow(
  row: CommsTimelineRow,
  triggerByKey: ReadonlyMap<string, AarTriggerAttribution>,
  notes: Readonly<Record<string, string>>,
): CommsTimelineRow {
  const trigger = triggerByKey.get(row.inject) ?? null;
  const origin = timelineOriginFor({ event: row.event, existing: row.origin, trigger });
  const note = notes[row.inject];
  if (origin === row.origin && !note) return row;
  return timelineRow({ ...row, origin, ...(note ? { origin_note: note } : {}) });
}

function timelineRow(row: CommsTimelineRow): CommsTimelineRow {
  const next: CommsTimelineRow = {
    ...row,
    parent: clip(row.parent, 80),
    inject: clip(row.inject, 80),
    channel: clip(row.channel, 40),
    who: clip(row.who, 120),
    detail: clip(row.detail, 240),
  };
  if (row.origin) next.origin = clip(row.origin, 80);
  if (row.origin_note) next.origin_note = clip(row.origin_note, 240);
  return next;
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function person(
  userId: string | null | undefined,
  team: string | null | undefined,
  names: Readonly<Record<string, string>>,
): string {
  const name = userId ? names[userId] : '';
  if (name && team) return `${name} · ${team}`;
  if (name) return name;
  if (team) return team;
  return userId ?? '';
}

function deliveryDetail(delivery: AarDelivery): string {
  const parts: string[] = [];
  if (delivery.sender_name) parts.push(delivery.sender_name);
  if (delivery.call_state) parts.push(delivery.call_state);
  if (delivery.urgency) parts.push(delivery.urgency);
  if (delivery.mood_rung) parts.push(`mood ${delivery.mood_rung}`);
  return parts.join(' · ');
}

function responseDetail(response: AarResponse): string {
  const parts: string[] = [];
  const judgement = response.judgement;
  if (response.judgement_status && response.judgement_status !== 'done') {
    parts.push(response.judgement_status);
  } else if (judgement) {
    if (judgement.tone) parts.push(`tone ${judgement.tone}`);
    if (judgement.passed === true) parts.push('passed');
    else if (judgement.passed === false) parts.push('failed');
    if (judgement.summary) parts.push(judgement.summary);
  }
  if (response.wait_minutes != null) parts.push(`waited ${response.wait_minutes} min`);
  if (response.mood_rung) parts.push(`mood ${response.mood_rung}`);
  return parts.join('; ');
}

function channelOfApp(app: string): string {
  if (app === 'phone_call') return 'call';
  if (app === 'group_chat') return 'chat';
  if (app === 'social_feed') return 'social';
  return app;
}

function referencedParents(inject: AarInject, known: ReadonlySet<string>): string[] {
  const parents = new Set<string>();
  for (const key of collectConditionKeys(
    inject.conditions_to_appear,
    inject.conditions_to_cancel,
  )) {
    const parsed = parseConditionKey(key);
    if ('error' in parsed) continue;
    for (const arg of parsed.args) {
      if (known.has(arg)) parents.add(arg);
    }
  }
  return [...parents];
}

function locateCall(
  call: AarCall,
  deliveries: readonly AarDelivery[],
  injectById: ReadonlyMap<string, AarInject>,
): { parent: string; inject: string } | null {
  const delivery = deliveries.find(
    (item) =>
      item.ref_id === call.id ||
      (item.call_group_id === call.call_group_id &&
        item.attempt_no === call.attempt_no &&
        item.channel === 'call'),
  );
  if (delivery) {
    return {
      parent:
        delivery.chain_root_key && delivery.chain_step != null
          ? delivery.chain_root_key
          : delivery.inject_key,
      inject: delivery.inject_key,
    };
  }
  const inject = call.inject_id ? injectById.get(call.inject_id) : undefined;
  if (!inject) return null;
  const key = inject.inject_key || injectKeyOf({ id: inject.id, delivery_config: null });
  return { parent: key, inject: key };
}

type QueryResult = { data: unknown; error: { code?: string; message?: string } | null };

async function selectSession(
  table: string,
  columns: string,
  sessionId: string,
  limit: number,
): Promise<QueryResult> {
  const result = await supabaseAdmin
    .from(table)
    .select(columns)
    .eq('session_id', sessionId)
    .limit(limit);
  return result as QueryResult;
}

function asRecords(data: unknown): Record<string, unknown>[] {
  if (!Array.isArray(data)) return [];
  return data.filter((row): row is Record<string, unknown> => !!row && typeof row === 'object');
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function minuteAt(iso: unknown, startMs: number | null): number | null {
  return crisisMinute(typeof iso === 'string' ? iso : null, startMs, 'floor');
}

export interface AarSessionParts {
  sessionId: string;
  scenarioId: string | null;
  startTime: string | null;
  validAt: string;
  deliveries: AarDelivery[];
  responses: AarResponse[];
  calls: AarCall[];
  chains: AarChain[];
  steps: AarChainStep[];
  moods: AarMood[];
  injects: AarInject[];
  events: AarBranchEvent[];
  directMessages: AarDirectMessage[];
  names: Record<string, string>;
  triggers: AarTriggerAttribution[] | null;
  unscriptedNotes?: Readonly<Record<string, string>>;
  triggerRows: TriggerHistoryRow[] | null;
  /** Claims from before the response ledger, when a delivery row does not exist. */
  publications: Array<{ inject_id: string; claimed_at: string | null }>;
  playerTopics?: PlayerTopicLabel[];
}

const DELIVERY_BASE =
  'id, inject_id, inject_key, channel, ref_id, recipient_teams, sender_name, requires_response, delivered_minute, first_opened_at, first_opened_by, call_state, call_group_id, attempt_no, chain_root_key, chain_step, urgency, mood_rung';
const DELIVERY_ROLE = `${DELIVERY_BASE}, line_team, target_role_id, fallback_reason`;

const CALL_BASE =
  'id, inject_id, call_group_id, attempt_no, max_attempts, status, ring_started_at, answered_by, declined_by, stakeholder_id';
const CALL_ROLE = `${CALL_BASE}, line_team, target_role_id, missed_reason`;

interface AarSessionClock extends SessionClockFields {
  start_time?: string | null;
  created_at?: string | null;
  scenario_id?: string | null;
}

async function loadParts(sessionId: string): Promise<AarSessionParts> {
  const parts: AarSessionParts = {
    sessionId,
    scenarioId: null,
    startTime: null,
    validAt: new Date().toISOString(),
    deliveries: [],
    responses: [],
    calls: [],
    chains: [],
    steps: [],
    moods: [],
    injects: [],
    events: [],
    directMessages: [],
    names: {},
    triggers: null,
    unscriptedNotes: {},
    triggerRows: null,
    publications: [],
  };

  const sessionResult = await selectSessionClock<AarSessionClock>(
    'start_time, created_at, scenario_id',
    (query) => query.eq('id', sessionId).maybeSingle(),
  );
  const session = sessionResult.data;
  const startIso = session?.start_time || session?.created_at || null;
  const startMs = startIso ? Date.parse(startIso) : null;
  const started = startMs != null && Number.isFinite(startMs) ? startMs : null;

  parts.deliveries = await loadDeliveries(sessionId, started);
  parts.responses = await loadResponses(sessionId);
  parts.calls = await loadCalls(sessionId, started);
  const chains = await loadChains(sessionId);
  parts.chains = chains.chains;
  parts.steps = chains.steps;
  parts.moods = await loadMoods(sessionId);
  parts.directMessages = await loadDirectMessages(sessionId, started);
  parts.scenarioId = session?.scenario_id ?? null;
  parts.startTime = typeof session?.start_time === 'string' ? session.start_time : null;
  const validAtRaw = rosterValidAt({
    start_time: session?.start_time ?? null,
    opened_at: openedAtOf(session),
  });
  parts.validAt = validAtRaw instanceof Date ? validAtRaw.toISOString() : validAtRaw;
  parts.injects = await loadInjects(parts.scenarioId, sessionId, parts.validAt);
  parts.publications = await loadPublications(sessionId);
  parts.events = await loadBranchEvents(sessionId, started);
  parts.names = await loadNames(collectUserIds(parts));
  if (crisisFiltersActive()) {
    const startIso = typeof session?.start_time === 'string' ? session.start_time : null;
    const topics = playerTopicLabels(
      (await loadPlayerTopicSources(sessionId)).filter((row) =>
        countsOnCrisisClock(row.at, startIso),
      ),
      started,
    );
    if (topics.length > 0) parts.playerTopics = topics;
  }
  const triggers = await readInjectTriggers(sessionId);
  parts.triggerRows = triggers.missing ? null : triggers.rows;
  parts.triggers = parts.triggerRows
    ? parts.triggerRows.map((row) => ({
        inject_id: row.inject_id,
        inject_key: row.inject_key,
        origin: row.origin,
        source_teams: row.source_teams,
        target_teams: row.target_teams,
      }))
    : null;
  return parts;
}

// prettier-ignore
async function loadPublications(
  sessionId: string,
): Promise<AarSessionParts['publications']> {
  // prettier-ignore
  const result = await selectSession('inject_publications', 'inject_id, claimed_at', sessionId, 2000);
  if (result.error) {
    if (!isUnappliedSchema(result.error)) warnRead('inject_publications', result.error);
    return [];
  }
  const claims: AarSessionParts['publications'] = [];
  for (const row of asRecords(result.data)) {
    const id = text(row.inject_id);
    if (!id) continue;
    claims.push({ inject_id: id, claimed_at: text(row.claimed_at) });
  }
  return claims;
}

export async function loadAarSessionParts(sessionId: string): Promise<AarSessionParts | null> {
  try {
    return await loadParts(sessionId);
  } catch (err) {
    logger.warn(
      { err, event: 'aar_parts_failed', sessionId },
      'After-action session parts omitted',
    );
    return null;
  }
}

async function loadDeliveries(sessionId: string, startMs: number | null): Promise<AarDelivery[]> {
  let result = await selectSession('inject_deliveries', DELIVERY_ROLE, sessionId, 2000);
  if (result.error && isMissingColumn(result.error)) {
    warnUnapplied('271', 'Role and line columns are off because migration 271 is not applied');
    result = await selectSession('inject_deliveries', DELIVERY_BASE, sessionId, 2000);
  }
  if (result.error) {
    if (isMissingTable(result.error) || isUnappliedSchema(result.error)) {
      warnUnapplied('268', 'Response ledger is off because migration 268 is not applied');
    } else {
      warnRead('inject_deliveries', result.error);
    }
    return [];
  }
  return asRecords(result.data).map((row) => ({
    id: String(row.id ?? ''),
    inject_id: String(row.inject_id ?? ''),
    inject_key: String(row.inject_key ?? ''),
    channel: String(row.channel ?? ''),
    delivered_minute: num(row.delivered_minute) ?? 0,
    recipient_teams: Array.isArray(row.recipient_teams)
      ? row.recipient_teams.filter((team): team is string => typeof team === 'string')
      : [],
    sender_name: text(row.sender_name),
    requires_response: row.requires_response === true,
    first_opened_minute: minuteAt(row.first_opened_at, startMs),
    first_opened_by: text(row.first_opened_by),
    call_state: text(row.call_state),
    call_group_id: text(row.call_group_id),
    attempt_no: num(row.attempt_no),
    chain_root_key: text(row.chain_root_key),
    chain_step: num(row.chain_step),
    urgency: text(row.urgency),
    mood_rung: text(row.mood_rung),
    ref_id: text(row.ref_id),
  }));
}

async function loadResponses(sessionId: string): Promise<AarResponse[]> {
  const result = await selectSession(
    'inject_responses',
    'id, delivery_id, inject_key, channel, user_id, team_name, response_minute, judgement_status, judgement, wait_minutes, mood_rung',
    sessionId,
    5000,
  );
  if (result.error) {
    if (isUnappliedSchema(result.error)) {
      warnUnapplied('268', 'Response ledger is off because migration 268 is not applied');
    } else {
      warnRead('inject_responses', result.error);
    }
    return [];
  }
  return asRecords(result.data).map((row) => ({
    id: text(row.id) ?? undefined,
    delivery_id: String(row.delivery_id ?? ''),
    inject_key: String(row.inject_key ?? ''),
    channel: String(row.channel ?? ''),
    user_id: text(row.user_id),
    team_name: text(row.team_name),
    response_minute: num(row.response_minute) ?? 0,
    judgement_status: text(row.judgement_status),
    judgement: judgementOf(row.judgement),
    wait_minutes: num(row.wait_minutes),
    mood_rung: text(row.mood_rung),
  }));
}

function judgementOf(value: unknown): JudgementV1 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as JudgementV1;
}

async function loadCalls(sessionId: string, startMs: number | null): Promise<AarCall[]> {
  let result = await selectSession('sim_calls', CALL_ROLE, sessionId, 2000);
  if (result.error && isMissingColumn(result.error)) {
    warnUnapplied('271', 'Role and line columns are off because migration 271 is not applied');
    result = await selectSession('sim_calls', CALL_BASE, sessionId, 2000);
  }
  if (result.error) {
    if (isMissingTable(result.error) || isUnappliedSchema(result.error)) {
      warnUnapplied(
        '269',
        'Phone calls are off because migration 269 is not applied; call attempts are omitted',
      );
    } else {
      warnRead('sim_calls', result.error);
    }
    return [];
  }
  return asRecords(result.data).map((row) => ({
    id: String(row.id ?? ''),
    inject_id: text(row.inject_id),
    call_group_id: String(row.call_group_id ?? row.id ?? ''),
    attempt_no: num(row.attempt_no) ?? 1,
    max_attempts: num(row.max_attempts) ?? 1,
    status: String(row.status ?? ''),
    minute: minuteAt(row.ring_started_at, startMs),
    answered_by: text(row.answered_by),
    declined_by: text(row.declined_by),
  }));
}

async function loadChains(
  sessionId: string,
): Promise<{ chains: AarChain[]; steps: AarChainStep[] }> {
  const result = await selectSession(
    'escalation_chains',
    'id, root_key, status, steps_sent, max_steps, stopped_reason, stopped_minute',
    sessionId,
    500,
  );
  if (result.error) {
    if (isUnappliedSchema(result.error)) {
      warnUnapplied('272', 'Escalation chains are off because migration 272 is not applied');
    } else {
      warnRead('escalation_chains', result.error);
    }
    return { chains: [], steps: [] };
  }
  const chains = asRecords(result.data).map((row) => ({
    id: String(row.id ?? ''),
    root_key: String(row.root_key ?? ''),
    status: String(row.status ?? ''),
    steps_sent: num(row.steps_sent) ?? 0,
    max_steps: num(row.max_steps) ?? 0,
    stopped_reason: text(row.stopped_reason),
    stopped_minute: num(row.stopped_minute),
  }));
  const ids = chains.map((chain) => chain.id).filter(Boolean);
  if (ids.length === 0) return { chains, steps: [] };
  const stepsResult = (await supabaseAdmin
    .from('escalation_chain_steps')
    .select('chain_id, step_no, urgency, app, delivered_minute, inject_id')
    .in('chain_id', ids)
    .limit(CROSS_TEAM_READ_LIMITS.chainSteps)) as QueryResult;
  if (stepsResult.error) {
    if (isUnappliedSchema(stepsResult.error)) {
      warnUnapplied('272', 'Escalation chains are off because migration 272 is not applied');
    } else {
      warnRead('escalation_chain_steps', stepsResult.error);
    }
    return { chains, steps: [] };
  }
  const steps = asRecords(stepsResult.data).map((row) => ({
    chain_id: String(row.chain_id ?? ''),
    step_no: num(row.step_no) ?? 0,
    urgency: String(row.urgency ?? ''),
    app: String(row.app ?? ''),
    delivered_minute: num(row.delivered_minute),
    inject_id: text(row.inject_id),
  }));
  return { chains, steps };
}

async function loadMoods(sessionId: string): Promise<AarMood[]> {
  const result = await selectSession(
    'stakeholder_moods',
    'stakeholder_id, scope_team, rung_id, history, consequences_fired',
    sessionId,
    500,
  );
  if (result.error) {
    if (isUnappliedSchema(result.error)) {
      warnUnapplied('273', 'Stakeholder moods are off because migration 273 is not applied');
    } else {
      warnRead('stakeholder_moods', result.error);
    }
    return [];
  }
  return asRecords(result.data).map((row) => ({
    stakeholder_id: String(row.stakeholder_id ?? ''),
    scope_team: String(row.scope_team ?? ''),
    rung_id: String(row.rung_id ?? ''),
    history: historyOf(row.history),
    consequences_fired: Array.isArray(row.consequences_fired)
      ? row.consequences_fired.filter((id): id is string => typeof id === 'string')
      : [],
  }));
}

function historyOf(value: unknown): AarMood['history'] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
    .map((item) => ({
      rung: text(item.rung) ?? undefined,
      minute: num(item.minute) ?? undefined,
      reason: text(item.reason) ?? undefined,
    }));
}

async function loadDirectMessages(
  sessionId: string,
  startMs: number | null,
): Promise<AarDirectMessage[]> {
  const result = await selectSession(
    'sim_direct_messages',
    'id, inject_id, created_at, sender_id',
    sessionId,
    2000,
  );
  if (result.error) {
    if (isMissingColumn(result.error) || isMissingTable(result.error)) {
      warnUnapplied('270', 'Messenger inject links are off because migration 270 is not applied');
    } else {
      warnRead('sim_direct_messages', result.error);
    }
    return [];
  }
  return asRecords(result.data)
    .filter((row) => text(row.inject_id))
    .map((row) => ({
      id: String(row.id ?? ''),
      inject_id: String(row.inject_id),
      minute: minuteAt(row.created_at, startMs),
      sender_id: text(row.sender_id),
    }));
}

async function loadInjects(
  scenarioId: string | null,
  sessionId: string,
  validAt: string,
): Promise<AarInject[]> {
  if (!scenarioId) return [];
  const result = (await templateInjectsValidAt(scenarioId, sessionId, validAt, {
    select:
      'id, title, target_teams, trigger_time_minutes, requires_response, conditions_to_appear, conditions_to_cancel, delivery_config',
    limit: 2000,
  })) as QueryResult;
  if (result.error) {
    warnRead('scenario_injects', result.error);
    return [];
  }
  return asRecords(result.data).map((row) => {
    const config =
      row.delivery_config && typeof row.delivery_config === 'object'
        ? (row.delivery_config as { inject_key?: unknown; app?: unknown })
        : null;
    return {
      id: String(row.id ?? ''),
      title: text(row.title),
      inject_key: injectKeyOf({ id: String(row.id ?? ''), delivery_config: config }),
      requires_response: row.requires_response === true,
      conditions_to_appear: row.conditions_to_appear,
      conditions_to_cancel: row.conditions_to_cancel,
      app: text(config?.app),
      target_teams: Array.isArray(row.target_teams)
        ? row.target_teams.filter((team): team is string => typeof team === 'string')
        : [],
      trigger_time_minutes: num(row.trigger_time_minutes),
    };
  });
}

async function loadBranchEvents(
  sessionId: string,
  startMs: number | null,
): Promise<AarBranchEvent[]> {
  const result = (await supabaseAdmin
    .from('session_events')
    .select('event_type, metadata, created_at')
    .eq('session_id', sessionId)
    .in('event_type', ['inject', 'inject_cancelled'])
    .order('created_at', { ascending: true })
    .limit(2000)) as QueryResult;
  if (result.error) {
    warnRead('session_events', result.error);
    return [];
  }
  const events: AarBranchEvent[] = [];
  for (const row of asRecords(result.data)) {
    const type =
      row.event_type === 'inject_cancelled'
        ? 'inject_cancelled'
        : row.event_type === 'inject'
          ? 'inject'
          : null;
    const metadata =
      row.metadata && typeof row.metadata === 'object'
        ? (row.metadata as { inject_id?: unknown })
        : null;
    const injectId = text(metadata?.inject_id);
    if (!type || !injectId) continue;
    events.push({
      event_type: type,
      minute: minuteAt(row.created_at, startMs),
      inject_id: injectId,
    });
  }
  return events;
}

function collectUserIds(parts: AarSessionParts): string[] {
  const ids = new Set<string>();
  for (const delivery of parts.deliveries) {
    if (delivery.first_opened_by) ids.add(delivery.first_opened_by);
  }
  for (const response of parts.responses) {
    if (response.user_id) ids.add(response.user_id);
  }
  for (const call of parts.calls) {
    if (call.answered_by) ids.add(call.answered_by);
    if (call.declined_by) ids.add(call.declined_by);
  }
  for (const message of parts.directMessages) {
    if (message.sender_id) ids.add(message.sender_id);
  }
  return [...ids];
}

async function loadNames(ids: string[]): Promise<Record<string, string>> {
  if (ids.length === 0) return {};
  const limited = ids.slice(0, CROSS_TEAM_READ_LIMITS.names);
  const result = (await supabaseAdmin
    .from('user_profiles')
    .select('id, full_name')
    .in('id', limited)
    .limit(CROSS_TEAM_READ_LIMITS.names)) as QueryResult;
  if (result.error) {
    warnRead('user_profiles', result.error);
    return {};
  }
  const names: Record<string, string> = {};
  for (const row of asRecords(result.data)) {
    const id = text(row.id);
    const name = text(row.full_name);
    if (id && name) names[id] = name;
  }
  return names;
}

export async function loadCommsResponsesSection(sessionId: string): Promise<CommsResponsesSection> {
  try {
    const parts = await loadAarSessionParts(sessionId);
    return buildCommsResponsesSection(parts ?? {});
  } catch (err) {
    logger.warn(
      { err, event: 'aar_comms_responses_failed', sessionId },
      'Comms response timeline omitted',
    );
    return emptyCommsResponses();
  }
}
