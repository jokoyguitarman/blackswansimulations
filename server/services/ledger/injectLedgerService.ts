/**
 * Database side of the inject response ledger. Every call degrades to a no-op when
 * migration 268 is not applied (42P01 / 42703 / PGRST204 / PGRST205), and none of
 * them throw: a route or scheduler tick must keep working with the ledger off.
 *
 * Chain, attempt and mood columns exist for WP5, WP10 and WP11. This module accepts
 * them on the input objects and otherwise leaves the database defaults.
 */

import { supabaseAdmin } from '../../lib/supabaseAdmin.js';
import { env } from '../../env.js';
import { getWebSocketService } from '../websocketService.js';
import { getPlayerTeamName } from '../teamCharterService.js';
import { logger } from '../../lib/logger.js';
import {
  attributeChatResponse,
  attributeDmResponses,
  buildCommsState,
  emptyCommsState,
  matchEmailDelivery,
  resolveEmailRootId,
  responseTeamKey,
  actorRoleSkipsResponse,
  sessionMinuteAt,
  COMMS_DELIVERY_CAP,
  COMMS_RESPONSE_CAP,
  type CommsState,
  type EmailLink,
  type LedgerDeliveryRow,
  type LedgerResponseRow,
} from './injectLedgerCore.js';
import { failLedger, isLedgerSchemaMissing, ledgerTablesMissing } from './ledgerSchema.js';
import { enqueueJudgement } from '../judging/judgeService.js';
import { slugifyTeamName } from '../conditions/conditionCatalog.js';
import { loadTeamSignalFacts } from '../conditions/teamSignalService.js';
import {
  firstEmailMinuteByStakeholder,
  summariseActionCounts,
  summariseStakeholderContacts,
  type PlayerActionFact,
  type StakeholderContactRow,
} from '../conditions/commsConditionsCore.js';
import type { ActionCountBucket } from './injectLedgerCore.js';
import type { EscalationConfig } from '../escalation/escalationCore.js';

const UNIQUE_VIOLATION = '23505';
let deliveryRoleColumns = true;

export type LedgerChannel =
  'email' | 'chat' | 'npc_dm' | 'messenger_dm' | 'call' | 'social' | 'news';

export type LedgerRefTable =
  | 'sim_emails'
  | 'chat_messages'
  | 'sim_direct_messages'
  | 'sim_calls'
  | 'social_posts'
  | 'sim_news_articles';

export type LedgerAttribution =
  | 'email_reply'
  | 'email_forward'
  | 'chat_reply_to'
  | 'chat_heuristic'
  | 'dm_thread'
  | 'call_answered'
  | 'call_transcript'
  | 'call_returned'
  | 'social_reply';

export type LedgerUrgency = 'reminder' | 'follow_up' | 'urgent' | 'final' | 'escalated';

export type LedgerCallState = 'ringing' | 'answered' | 'declined' | 'missed' | 'ended' | 'failed';

/** Option object so later work packages can add fields without changing call sites. */
export interface RecordDeliveryInput {
  sessionId: string;
  injectId: string;
  injectKey: string;
  channel: LedgerChannel;
  refTable: LedgerRefTable;
  refId: string;
  chatChannelId?: string | null;
  threadId?: string | null;
  recipientUserIds?: string[] | null;
  recipientTeams?: string[];
  stakeholderId?: string | null;
  senderName?: string | null;
  requiresResponse?: boolean;
  responseWindowMinutes?: number | null;
  deliveredAt?: string;
  deliveredMinute?: number;
  callState?: LedgerCallState | null;
  callGroupId?: string | null;
  attemptNo?: number | null;
  chainRootDeliveryId?: string | null;
  chainRootKey?: string | null;
  chainStep?: number | null;
  urgency?: LedgerUrgency | null;
  moodRung?: string | null;
  lineTeam?: string | null;
  targetRoleId?: string | null;
  fallbackReason?: string | null;
  /** Set on a root delivery whose inject carries delivery_config.escalation. */
  escalation?: EscalationConfig | null;
}

export interface RecordOpenInput {
  sessionId: string;
  userId: string;
  at?: string;
  refTable?: string;
  refId?: string;
  chatChannelId?: string;
}

export interface RecordResponseInput {
  sessionId: string;
  deliveryId: string;
  injectId: string;
  injectKey: string;
  channel: string;
  refTable: string;
  refId: string;
  userId: string | null;
  teamName: string | null;
  isBot: boolean;
  attribution: LedgerAttribution;
  contentExcerpt?: string | null;
  respondedAt: string;
  responseMinute: number;
  meta?: Record<string, unknown>;
  waitMinutes?: number | null;
  moodRung?: string | null;
}

interface SessionClock {
  startTime: string | null;
  trainerId: string | null;
}

const DELIVERY_COLUMNS =
  'id, inject_id, inject_key, channel, delivered_minute, delivered_at, recipient_teams, recipient_user_ids, stakeholder_id, call_state, call_group_id, attempt_no, chain_root_delivery_id, chain_root_key, chain_step, urgency, mood_rung, first_opened_at, first_response_minute, first_response_team, ref_id, chat_channel_id, thread_id, response_window_minutes, first_response_at';

export async function recordDelivery(input: RecordDeliveryInput): Promise<string | null> {
  if (ledgerTablesMissing()) return null;
  try {
    const clock = await loadSessionClock(input.sessionId);
    const deliveredAt = input.deliveredAt ?? new Date().toISOString();
    const deliveredMinute = input.deliveredMinute ?? sessionMinuteAt(clock.startTime, deliveredAt);
    const stamped = await stampDeliveryMood(input, deliveredMinute);
    const row: Record<string, unknown> = {
      session_id: input.sessionId,
      inject_id: input.injectId,
      inject_key: input.injectKey,
      channel: input.channel,
      ref_table: input.refTable,
      ref_id: input.refId,
      chat_channel_id: input.chatChannelId ?? null,
      thread_id: input.threadId ?? null,
      recipient_user_ids: input.recipientUserIds ?? null,
      recipient_teams: input.recipientTeams ?? [],
      stakeholder_id: input.stakeholderId ?? null,
      sender_name: input.senderName ?? null,
      requires_response: input.requiresResponse === true,
      response_window_minutes: input.responseWindowMinutes ?? null,
      delivered_at: deliveredAt,
      delivered_minute: deliveredMinute,
    };
    assignIfSet(row, 'call_state', input.callState);
    assignIfSet(row, 'call_group_id', input.callGroupId);
    assignIfSet(row, 'attempt_no', input.attemptNo);
    assignIfSet(row, 'chain_root_delivery_id', input.chainRootDeliveryId);
    assignIfSet(row, 'chain_root_key', input.chainRootKey);
    assignIfSet(row, 'chain_step', input.chainStep);
    assignIfSet(row, 'urgency', input.urgency);
    assignIfSet(row, 'mood_rung', stamped.moodRung);
    if (deliveryRoleColumns) {
      assignIfSet(row, 'line_team', input.lineTeam);
      assignIfSet(row, 'target_role_id', input.targetRoleId);
      assignIfSet(row, 'fallback_reason', input.fallbackReason);
    }

    const { data, error } = await supabaseAdmin
      .from('inject_deliveries')
      .insert(row)
      .select('id')
      .maybeSingle();
    if (error && deliveryRoleColumns && (error.code === '42703' || error.code === 'PGRST204')) {
      deliveryRoleColumns = false;
      logger.warn(
        { event: 'delivery_role_columns_unavailable' },
        'Role and line columns on inject_deliveries are off because migration 271 is not applied',
      );
      return recordDelivery(input);
    }
    if (error?.code === UNIQUE_VIOLATION) {
      const { data: existing, error: readError } = await supabaseAdmin
        .from('inject_deliveries')
        .select('id')
        .eq('ref_table', input.refTable)
        .eq('ref_id', input.refId)
        .maybeSingle();
      if (failLedger(readError, 'recordDelivery.existing')) return null;
      return (existing?.id as string | undefined) ?? null;
    }
    if (failLedger(error, 'recordDelivery')) return null;
    const id = (data?.id as string | undefined) ?? null;
    if (id) {
      emitLedger(clock.trainerId, {
        delivery_id: id,
        inject_id: input.injectId,
        inject_key: input.injectKey,
        kind: 'delivered',
        channel: input.channel,
        team: input.recipientTeams?.length === 1 ? input.recipientTeams[0] : undefined,
        at: deliveredAt,
      });
      if (
        input.escalation &&
        input.chainStep == null &&
        (input.attemptNo == null || input.attemptNo <= 1)
      ) {
        try {
          const { startChainForDelivery } = await import('../escalation/escalationService.js');
          await startChainForDelivery({
            sessionId: input.sessionId,
            deliveryId: id,
            injectId: input.injectId,
            injectKey: input.injectKey,
            deliveredMinute,
            recipientTeams: input.recipientTeams ?? [],
            stakeholderId: input.stakeholderId ?? null,
            targetRoleId: input.targetRoleId ?? null,
            lineTeam: input.lineTeam ?? null,
            escalation: input.escalation,
          });
        } catch (chainErr) {
          logger.warn({ err: chainErr, deliveryId: id }, 'escalation chain was not started');
        }
      }
    }
    return id;
  } catch (err) {
    failLedger(err, 'recordDelivery');
    return null;
  }
}

export async function recordOpen(input: RecordOpenInput): Promise<void> {
  if (ledgerTablesMissing()) return;
  if (!input.refId && !input.chatChannelId) return;
  try {
    const at = input.at ?? new Date().toISOString();
    let query = supabaseAdmin
      .from('inject_deliveries')
      .update({ first_opened_at: at, first_opened_by: input.userId })
      .eq('session_id', input.sessionId)
      .is('first_opened_at', null);
    if (input.refId) query = query.eq('ref_id', input.refId);
    if (input.refTable) query = query.eq('ref_table', input.refTable);
    if (input.chatChannelId) {
      query = query.eq('chat_channel_id', input.chatChannelId).lte('delivered_at', at);
    }
    const { data, error } = await query.select('id, inject_id, inject_key, channel');
    if (failLedger(error, 'recordOpen')) return;
    const clock = await loadSessionClock(input.sessionId);
    for (const row of data ?? []) {
      emitLedger(clock.trainerId, {
        delivery_id: String(row.id),
        inject_id: String(row.inject_id),
        inject_key: String(row.inject_key),
        kind: 'opened',
        channel: String(row.channel),
        at,
      });
    }
  } catch (err) {
    failLedger(err, 'recordOpen');
  }
}

/**
 * Inserts one response. A retry of the same `(delivery, ref)` is a no-op: the count
 * is not incremented twice. The first response sets `first_response_*` only while
 * that column is still null.
 */
export async function recordResponse(input: RecordResponseInput): Promise<string | null> {
  if (ledgerTablesMissing()) return null;
  try {
    const withMood = await stampResponseMood(input);
    input = withMood;
    const judging = env.aiEnabled;
    const meta = { ...(input.meta ?? {}) };
    if (!judging) meta.skip_reason = 'ai_disabled';
    const row: Record<string, unknown> = {
      session_id: input.sessionId,
      delivery_id: input.deliveryId,
      inject_id: input.injectId,
      inject_key: input.injectKey,
      channel: input.channel,
      ref_table: input.refTable,
      ref_id: input.refId,
      user_id: input.userId,
      team_name: input.teamName,
      is_bot: input.isBot,
      attribution: input.attribution,
      content_excerpt: excerpt(input.contentExcerpt),
      responded_at: input.respondedAt,
      response_minute: input.responseMinute,
      judgement_status: judging ? 'queued' : 'skipped',
      meta,
    };
    assignIfSet(row, 'wait_minutes', input.waitMinutes);
    assignIfSet(row, 'mood_rung', input.moodRung);

    const { data, error } = await supabaseAdmin
      .from('inject_responses')
      .insert(row)
      .select('id')
      .maybeSingle();
    if (error?.code === UNIQUE_VIOLATION) {
      const { data: existing, error: readError } = await supabaseAdmin
        .from('inject_responses')
        .select('id')
        .eq('delivery_id', input.deliveryId)
        .eq('ref_table', input.refTable)
        .eq('ref_id', input.refId)
        .maybeSingle();
      if (failLedger(readError, 'recordResponse.existing')) return null;
      return (existing?.id as string | undefined) ?? null;
    }
    if (failLedger(error, 'recordResponse')) return null;
    const id = (data?.id as string | undefined) ?? null;
    if (!id) return null;

    await bumpDeliveryResponse(input);
    const clock = await loadSessionClock(input.sessionId);
    emitLedger(clock.trainerId, {
      delivery_id: input.deliveryId,
      inject_id: input.injectId,
      inject_key: input.injectKey,
      kind: 'responded',
      channel: input.channel,
      team: input.teamName ?? undefined,
      at: input.respondedAt,
    });
    if (judging) enqueueJudgement(id);
    return id;
  } catch (err) {
    failLedger(err, 'recordResponse');
    return null;
  }
}

export async function findDeliveryByRef(
  refTable: string,
  refId: string,
): Promise<{ id: string; injectId: string; injectKey: string } | null> {
  if (ledgerTablesMissing()) return null;
  try {
    const { data, error } = await supabaseAdmin
      .from('inject_deliveries')
      .select('id, inject_id, inject_key')
      .eq('ref_table', refTable)
      .eq('ref_id', refId)
      .maybeSingle();
    if (failLedger(error, 'findDeliveryByRef') || !data) return null;
    return {
      id: String(data.id),
      injectId: String(data.inject_id),
      injectKey: String(data.inject_key),
    };
  } catch (err) {
    failLedger(err, 'findDeliveryByRef');
    return null;
  }
}

export async function setDeliveryCallState(input: {
  refTable: string;
  refId: string;
  callState: LedgerCallState;
}): Promise<void> {
  if (ledgerTablesMissing()) return;
  try {
    const { error } = await supabaseAdmin
      .from('inject_deliveries')
      .update({ call_state: input.callState })
      .eq('ref_table', input.refTable)
      .eq('ref_id', input.refId);
    failLedger(error, 'setDeliveryCallState');
  } catch (err) {
    failLedger(err, 'setDeliveryCallState');
  }
}

export async function loadCommsState(
  sessionId: string,
  elapsedMinutes: number,
  options?: { teamSignals?: boolean },
): Promise<CommsState> {
  const teamSignals = options?.teamSignals !== false;
  if (ledgerTablesMissing()) {
    return attachCommsFacts(
      sessionId,
      elapsedMinutes,
      null,
      emptyCommsState(elapsedMinutes),
      teamSignals,
    );
  }
  try {
    const [deliveriesResult, responsesResult, clock] = await Promise.all([
      supabaseAdmin
        .from('inject_deliveries')
        .select(DELIVERY_COLUMNS)
        .eq('session_id', sessionId)
        .order('delivered_at', { ascending: false })
        .limit(COMMS_DELIVERY_CAP + 1),
      supabaseAdmin
        .from('inject_responses')
        .select(
          'id, delivery_id, response_minute, team_name, user_id, is_bot, attribution, judgement_status, judgement, responded_at, created_at, meta, wait_minutes, mood_rung',
        )
        .eq('session_id', sessionId)
        .order('responded_at', { ascending: false })
        .limit(COMMS_RESPONSE_CAP + 1),
      loadSessionClock(sessionId),
    ]);
    if (failLedger(deliveriesResult.error, 'loadCommsState.deliveries')) {
      return attachCommsFacts(
        sessionId,
        elapsedMinutes,
        clock.startTime,
        emptyCommsState(elapsedMinutes),
        teamSignals,
      );
    }
    if (failLedger(responsesResult.error, 'loadCommsState.responses')) {
      return attachCommsFacts(
        sessionId,
        elapsedMinutes,
        clock.startTime,
        emptyCommsState(elapsedMinutes),
        teamSignals,
      );
    }
    const built = buildCommsState({
      deliveries: (deliveriesResult.data ?? []) as LedgerDeliveryRow[],
      responses: (responsesResult.data ?? []) as LedgerResponseRow[],
      elapsedMinutes,
      sessionStartedAt: clock.startTime,
      countBots: env.injectLedgerCountBots,
    });
    await enrichRoleDeliveryColumns(built);
    return attachCommsFacts(sessionId, elapsedMinutes, clock.startTime, built, teamSignals);
  } catch (err) {
    failLedger(err, 'loadCommsState');
    return attachCommsFacts(
      sessionId,
      elapsedMinutes,
      null,
      emptyCommsState(elapsedMinutes),
      teamSignals,
    );
  }
}

let roleColumnWarn = false;

/** Migration 271 columns. A missing column is skipped for the rest of the process. */
async function enrichRoleDeliveryColumns(state: CommsState): Promise<void> {
  if (!deliveryRoleColumns) return;
  const deliveries = Object.values(state.by_key).flat();
  const ids = [...new Set(deliveries.map((row) => row.delivery_id))];
  if (ids.length === 0) return;
  const { data, error } = await supabaseAdmin
    .from('inject_deliveries')
    .select('id, ref_id, target_role_id, line_team, fallback_reason')
    .in('id', ids);
  if (error && (error.code === '42703' || error.code === 'PGRST204')) {
    deliveryRoleColumns = false;
    if (!roleColumnWarn) {
      roleColumnWarn = true;
      logger.warn(
        { event: 'delivery_role_columns_unavailable' },
        'Role and line columns on inject_deliveries are off because migration 271 is not applied',
      );
    }
    return;
  }
  if (error || !data) return;
  const byId = new Map(data.map((row) => [String(row.id), row]));
  const callRefs: string[] = [];
  for (const delivery of deliveries) {
    const extra = byId.get(delivery.delivery_id);
    if (!extra) continue;
    delivery.target_role_id = (extra.target_role_id as string | null) ?? null;
    delivery.line_team = (extra.line_team as string | null) ?? null;
    delivery.fallback_reason = (extra.fallback_reason as string | null) ?? null;
    if (delivery.channel === 'call' && extra.ref_id) callRefs.push(String(extra.ref_id));
  }
  if (callRefs.length === 0) return;
  const calls = await supabaseAdmin
    .from('sim_calls')
    .select('id, missed_reason')
    .in('id', callRefs);
  if (calls.error && (calls.error.code === '42703' || calls.error.code === 'PGRST204')) return;
  if (calls.error || !calls.data) return;
  const reasons = new Map(
    calls.data.map((row) => [String(row.id), (row.missed_reason as string | null) ?? null]),
  );
  for (const delivery of deliveries) {
    const extra = byId.get(delivery.delivery_id);
    const refId = extra?.ref_id ? String(extra.ref_id) : '';
    if (refId && reasons.has(refId)) delivery.missed_reason = reasons.get(refId) ?? null;
  }
}

const ACTION_FACT_CAP = 8000;
const CONTACT_FACT_CAP = 5000;
const factWarned = new Set<string>();

function warnFactOnce(key: string, err: unknown, message: string): void {
  if (factWarned.has(key)) return;
  factWarned.add(key);
  logger.warn({ err, event: key }, message);
}

let simCallsKnown: boolean | null = null;

async function simCallsAvailable(): Promise<boolean> {
  if (simCallsKnown != null) return simCallsKnown;
  try {
    const { error } = await supabaseAdmin.from('sim_calls').select('id').limit(1);
    if (!error) {
      simCallsKnown = true;
      return true;
    }
    if (isLedgerSchemaMissing(error)) {
      simCallsKnown = false;
      warnFactOnce(
        'sim_calls_unavailable',
        error,
        'Call condition keys stay false until sim_calls exists',
      );
      return false;
    }
    warnFactOnce(
      'sim_calls_probe_failed',
      error,
      'Call condition keys stay false; sim_calls could not be read',
    );
    return false;
  } catch (err) {
    warnFactOnce(
      'sim_calls_probe_failed',
      err,
      'Call condition keys stay false; sim_calls could not be read',
    );
    return false;
  }
}

async function loadMoodIndexSafe(
  sessionId: string,
): Promise<Pick<CommsState, 'moods' | 'mood_stops'>> {
  try {
    const { loadMoodIndex } = await import('../mood/moodService.js');
    return await loadMoodIndex(sessionId);
  } catch (err) {
    warnFactOnce('stakeholder_moods_unavailable', err, 'Stakeholder moods could not be loaded');
    return {};
  }
}

async function stampDeliveryMood(
  input: RecordDeliveryInput,
  minute: number,
): Promise<RecordDeliveryInput> {
  if (!input.stakeholderId || input.moodRung) return input;
  try {
    const { rungForDelivery } = await import('../mood/moodService.js');
    const rung = await rungForDelivery({
      sessionId: input.sessionId,
      stakeholderId: input.stakeholderId,
      targetRoleId: input.targetRoleId,
      lineTeam: input.lineTeam,
      recipientTeams: input.recipientTeams,
      minute,
    });
    return rung ? { ...input, moodRung: rung } : input;
  } catch {
    return input;
  }
}

async function stampResponseMood(input: RecordResponseInput): Promise<RecordResponseInput> {
  if (input.moodRung && input.waitMinutes != null) return input;
  try {
    const { moodForResponse } = await import('../mood/moodService.js');
    const snap = await moodForResponse(input.sessionId, input.deliveryId, input.responseMinute);
    if (!snap) return input;
    return {
      ...input,
      moodRung: input.moodRung ?? snap.rungId,
      waitMinutes: snap.episodeAnchorMinute != null ? snap.waitMinutes : input.waitMinutes,
    };
  } catch {
    return input;
  }
}

async function loadChainIndexSafe(sessionId: string): Promise<CommsState['chains']> {
  try {
    const { loadChainIndex } = await import('../escalation/escalationService.js');
    return await loadChainIndex(sessionId);
  } catch (err) {
    warnFactOnce('escalation_chains_unavailable', err, 'Escalation chains could not be loaded');
    return {};
  }
}

async function attachCommsFacts(
  sessionId: string,
  elapsedMinutes: number,
  startTime: string | null,
  state: CommsState,
  teamSignals = true,
): Promise<CommsState> {
  try {
    const clockStart = startTime ?? (await loadSessionClock(sessionId)).startTime;
    const [contacts, verdicts, actions, stakeholders, callsAvailable, signals] = await Promise.all([
      loadPlayerContacts(sessionId),
      loadLatestVerdicts(sessionId),
      loadActionCounts(sessionId, clockStart),
      loadScenarioStakeholders(sessionId),
      simCallsAvailable(),
      teamSignals
        ? loadTeamSignalFacts(sessionId, clockStart)
        : Promise.resolve(null),
    ]);
    const email = actions.email ?? (await loadEmailSentFacts(sessionId));
    const emailKnown = email.known && stakeholders.known && actions.known;
    const chains = await loadChainIndexSafe(sessionId);
    const moods = await loadMoodIndexSafe(sessionId);
    return {
      ...state,
      calls_available: callsAvailable,
      stakeholder_contacts: contacts.known
        ? summariseStakeholderContacts(contacts.rows, clockStart)
        : {},
      contact_facts_known: contacts.known,
      contact_facts_truncated: contacts.truncated,
      stakeholder_verdicts: verdicts,
      email_sent_minutes: emailKnown
        ? firstEmailMinuteByStakeholder(email.rows, stakeholders.stakeholders, clockStart)
        : {},
      email_facts_known: emailKnown,
      email_facts_truncated: emailKnown && email.truncated,
      action_counts: actions.known ? actions.counts : [],
      action_facts_known: actions.known,
      action_counts_truncated: actions.known && actions.truncated,
      chains,
      ...moods,
      ...(signals ?? {}),
    };
  } catch (err) {
    warnFactOnce('comms_facts_failed', err, 'Extra condition facts could not be loaded');
    return {
      ...state,
      calls_available: false,
      action_facts_known: false,
      email_facts_known: false,
      contact_facts_known: false,
    };
  }
}

async function loadPlayerContacts(sessionId: string): Promise<{
  rows: StakeholderContactRow[];
  known: boolean;
  truncated: boolean;
}> {
  try {
    const { data, error } = await supabaseAdmin
      .from('stakeholder_conversations')
      .select('stakeholder_id, channel, created_at')
      .eq('session_id', sessionId)
      .eq('direction', 'player')
      .order('created_at', { ascending: true })
      .limit(CONTACT_FACT_CAP + 1);
    if (error) {
      warnFactOnce(
        'stakeholder_contacts_unavailable',
        error,
        'Stakeholder contact conditions are off for this process',
      );
      return { rows: [], known: false, truncated: false };
    }
    const rows = (data ?? []) as StakeholderContactRow[];
    if (rows.length > CONTACT_FACT_CAP) {
      warnFactOnce(
        'stakeholder_contacts_truncated',
        null,
        'Stakeholder contact history exceeded the condition-key cap; absence keys stay false',
      );
      return { rows: rows.slice(0, CONTACT_FACT_CAP), known: true, truncated: true };
    }
    return { rows, known: true, truncated: false };
  } catch (err) {
    warnFactOnce(
      'stakeholder_contacts_unavailable',
      err,
      'Stakeholder contact conditions are off for this process',
    );
    return { rows: [], known: false, truncated: false };
  }
}

async function loadLatestVerdicts(sessionId: string): Promise<Record<string, string>> {
  try {
    const { data, error } = await supabaseAdmin
      .from('inject_verdicts')
      .select('stakeholder_id, verdict, created_at')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: false })
      .limit(2000);
    if (error) {
      warnFactOnce(
        'stakeholder_verdicts_unavailable',
        error,
        'Stakeholder verdict conditions are off for this process',
      );
      return {};
    }
    const verdicts: Record<string, string> = {};
    for (const row of data ?? []) {
      const id = typeof row.stakeholder_id === 'string' ? row.stakeholder_id : '';
      if (!id || verdicts[id]) continue;
      verdicts[id] = typeof row.verdict === 'string' ? row.verdict : '';
    }
    return verdicts;
  } catch (err) {
    warnFactOnce(
      'stakeholder_verdicts_unavailable',
      err,
      'Stakeholder verdict conditions are off for this process',
    );
    return {};
  }
}

interface ActionCountLoad {
  counts: ActionCountBucket[];
  known: boolean;
  truncated: boolean;
  /** Set when the grouped query was unavailable and the row scan already loaded email rows. */
  email?: { rows: PlayerActionFact[]; known: boolean; truncated: boolean };
}

async function loadActionCounts(
  sessionId: string,
  startTime: string | null,
): Promise<ActionCountLoad> {
  try {
    const { data, error } = await supabaseAdmin
      .from('player_actions')
      .select('action_type, team_at_action, count:id.count(), first_at:created_at.min()')
      .eq('session_id', sessionId);
    if (!error) {
      return {
        counts: bucketsFromActionAggregate(
          (data ?? []) as Array<Record<string, unknown>>,
          startTime,
        ),
        known: true,
        truncated: false,
      };
    }
    if (isLedgerSchemaMissing(error)) {
      warnFactOnce(
        'action_counts_unavailable',
        error,
        'Action-count conditions are off for this process',
      );
      return {
        counts: [],
        known: false,
        truncated: false,
        email: { rows: [], known: false, truncated: false },
      };
    }
    warnFactOnce(
      'action_count_aggregate_failed',
      error,
      'Grouped action counts failed; scanning player_actions instead',
    );
  } catch (err) {
    warnFactOnce(
      'action_count_aggregate_failed',
      err,
      'Grouped action counts failed; scanning player_actions instead',
    );
  }
  return scanActionRows(sessionId, startTime);
}

function bucketsFromActionAggregate(
  rows: readonly Record<string, unknown>[],
  startTime: string | null,
): ActionCountBucket[] {
  const buckets: ActionCountBucket[] = [];
  for (const row of rows) {
    const actionType = typeof row.action_type === 'string' ? row.action_type : '';
    if (!actionType) continue;
    const teamRaw = typeof row.team_at_action === 'string' ? row.team_at_action : '';
    const count = Number(row.count);
    const firstAt = typeof row.first_at === 'string' ? row.first_at : '';
    buckets.push({
      action_type: actionType,
      team_slug: teamRaw ? slugifyTeamName(teamRaw) || null : null,
      count: Number.isFinite(count) ? count : 0,
      first_minute: firstAt ? sessionMinuteAt(startTime, firstAt) : 0,
    });
  }
  return buckets;
}

async function scanActionRows(
  sessionId: string,
  startTime: string | null,
): Promise<ActionCountLoad> {
  try {
    const { data, error } = await supabaseAdmin
      .from('player_actions')
      .select('action_type, team_at_action, created_at, metadata')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: true })
      .limit(ACTION_FACT_CAP + 1);
    if (error) {
      warnFactOnce(
        'action_counts_unavailable',
        error,
        'Action-count conditions are off for this process',
      );
      return {
        counts: [],
        known: false,
        truncated: false,
        email: { rows: [], known: false, truncated: false },
      };
    }
    const rows = (data ?? []) as PlayerActionFact[];
    const truncated = rows.length > ACTION_FACT_CAP;
    const kept = truncated ? rows.slice(0, ACTION_FACT_CAP) : rows;
    if (truncated) {
      warnFactOnce(
        'action_counts_truncated',
        null,
        'Action history exceeded the condition-key cap; absence keys stay false',
      );
    }
    return {
      counts: summariseActionCounts(kept, startTime),
      known: true,
      truncated,
      email: {
        rows: kept.filter((row) => row.action_type === 'email_sent'),
        known: true,
        truncated,
      },
    };
  } catch (err) {
    warnFactOnce(
      'action_counts_unavailable',
      err,
      'Action-count conditions are off for this process',
    );
    return {
      counts: [],
      known: false,
      truncated: false,
      email: { rows: [], known: false, truncated: false },
    };
  }
}

async function loadEmailSentFacts(
  sessionId: string,
): Promise<{ rows: PlayerActionFact[]; known: boolean; truncated: boolean }> {
  try {
    const { data, error } = await supabaseAdmin
      .from('player_actions')
      .select('action_type, team_at_action, created_at, metadata')
      .eq('session_id', sessionId)
      .eq('action_type', 'email_sent')
      .order('created_at', { ascending: true })
      .limit(ACTION_FACT_CAP + 1);
    if (error) {
      warnFactOnce(
        'email_facts_unavailable',
        error,
        'Email condition keys are off for this process',
      );
      return { rows: [], known: false, truncated: false };
    }
    const rows = (data ?? []) as PlayerActionFact[];
    if (rows.length > ACTION_FACT_CAP) {
      warnFactOnce(
        'email_facts_truncated',
        null,
        'Email history exceeded the condition-key cap; absence keys stay false',
      );
      return { rows: rows.slice(0, ACTION_FACT_CAP), known: true, truncated: true };
    }
    return { rows, known: true, truncated: false };
  } catch (err) {
    warnFactOnce('email_facts_unavailable', err, 'Email condition keys are off for this process');
    return { rows: [], known: false, truncated: false };
  }
}

async function loadScenarioStakeholders(sessionId: string): Promise<{
  stakeholders: Array<{ id: string; email?: string | null }>;
  known: boolean;
}> {
  try {
    const { data: session, error } = await supabaseAdmin
      .from('sessions')
      .select('scenario_id')
      .eq('id', sessionId)
      .maybeSingle();
    if (error) return { stakeholders: [], known: false };
    if (!session?.scenario_id) return { stakeholders: [], known: true };
    const { data: scenario, error: scenarioError } = await supabaseAdmin
      .from('scenarios')
      .select('initial_state')
      .eq('id', session.scenario_id as string)
      .maybeSingle();
    if (scenarioError) return { stakeholders: [], known: false };
    if (!scenario) return { stakeholders: [], known: true };
    const initial = scenario.initial_state as { stakeholders?: unknown } | null;
    if (!Array.isArray(initial?.stakeholders)) return { stakeholders: [], known: true };
    const stakeholders: Array<{ id: string; email?: string | null }> = [];
    for (const raw of initial.stakeholders) {
      if (!raw || typeof raw !== 'object') continue;
      const row = raw as { id?: unknown; email?: unknown };
      if (typeof row.id !== 'string') continue;
      stakeholders.push({ id: row.id, email: typeof row.email === 'string' ? row.email : null });
    }
    return { stakeholders, known: true };
  } catch (err) {
    warnFactOnce(
      'stakeholder_roster_unavailable',
      err,
      'Email-to-stakeholder conditions are off for this process',
    );
    return { stakeholders: [], known: false };
  }
}

export async function attributeChatMessage(input: {
  sessionId: string | null;
  channelId: string;
  channelType: string;
  messageId: string;
  senderId: string;
  content: string;
  replyTo: string | null;
  createdAt: string;
  actorRole?: string | null;
}): Promise<void> {
  if (!input.sessionId || ledgerTablesMissing()) return;
  try {
    const actor = await loadActor(
      input.sessionId,
      input.senderId,
      input.createdAt,
      input.actorRole,
    );
    if (!actor || actor.isTrainer) return;

    const { data, error } = await supabaseAdmin
      .from('inject_deliveries')
      .select(DELIVERY_COLUMNS)
      .eq('session_id', input.sessionId)
      .eq('chat_channel_id', input.channelId);
    if (failLedger(error, 'attributeChatMessage')) return;
    const rows = (data ?? []) as DeliveryRecord[];
    const responded = await respondedTeamKeys(rows.map((row) => row.id));
    if (input.channelType === 'npc_direct') {
      const attributions = attributeDmResponses({
        message: {
          id: input.messageId,
          sender_id: input.senderId,
          created_at: input.createdAt,
          sender_team: actor.teamName,
          is_trainer: false,
        },
        deliveries: rows
          .filter((row) => row.channel === 'npc_dm')
          .map((row) => toDmDelivery(row, responded.get(row.id) ?? [])),
        messageMinute: actor.minute,
        chatChannelId: input.channelId,
      });
      await recordAttributed(
        {
          sessionId: input.sessionId,
          senderId: input.senderId,
          messageId: input.messageId,
          content: input.content,
          createdAt: input.createdAt,
        },
        actor,
        rows,
        attributions,
        'chat_messages',
      );
      return;
    }
    const attributions = attributeChatResponse({
      message: {
        id: input.messageId,
        channel_id: input.channelId,
        sender_id: input.senderId,
        reply_to: input.replyTo,
        created_at: input.createdAt,
        sender_team: actor.teamName,
        is_trainer: false,
      },
      openDeliveries: rows
        .filter((row) => row.channel === 'chat')
        .map((row) => ({
          id: row.id,
          ref_id: row.ref_id,
          chat_channel_id: row.chat_channel_id ?? input.channelId,
          delivered_at: row.delivered_at ?? input.createdAt,
          delivered_minute: row.delivered_minute,
          recipient_teams: row.recipient_teams ?? [],
          recipient_user_ids: row.recipient_user_ids ?? null,
          response_window_minutes: row.response_window_minutes ?? null,
          first_response_at: row.first_response_at ?? null,
          responded_teams: responded.get(row.id) ?? [],
        })),
      messageMinute: actor.minute,
      defaultWindowMinutes: env.injectChatResponseWindowMinutes,
    });
    await recordAttributed(
      {
        sessionId: input.sessionId,
        senderId: input.senderId,
        messageId: input.messageId,
        content: input.content,
        createdAt: input.createdAt,
      },
      actor,
      rows,
      attributions,
      'chat_messages',
    );
  } catch (err) {
    failLedger(err, 'attributeChatMessage');
  }
}

export async function attributeMessengerReply(input: {
  sessionId: string;
  userId: string;
  messageId: string;
  threadId: string;
  content: string;
  createdAt: string;
  actorRole?: string | null;
}): Promise<void> {
  if (ledgerTablesMissing() || !isUuid(input.threadId)) return;
  try {
    const actor = await loadActor(input.sessionId, input.userId, input.createdAt, input.actorRole);
    if (!actor || actor.isTrainer) return;
    const { data, error } = await supabaseAdmin
      .from('inject_deliveries')
      .select(DELIVERY_COLUMNS)
      .eq('session_id', input.sessionId)
      .eq('thread_id', input.threadId)
      .eq('channel', 'messenger_dm');
    if (failLedger(error, 'attributeMessengerReply')) return;
    const rows = (data ?? []) as DeliveryRecord[];
    const responded = await respondedTeamKeys(rows.map((row) => row.id));
    const attributions = attributeDmResponses({
      message: {
        id: input.messageId,
        sender_id: input.userId,
        created_at: input.createdAt,
        sender_team: actor.teamName,
        is_trainer: false,
      },
      deliveries: rows.map((row) => toDmDelivery(row, responded.get(row.id) ?? [])),
      messageMinute: actor.minute,
      threadId: input.threadId,
    });
    await recordAttributed(
      {
        sessionId: input.sessionId,
        senderId: input.userId,
        messageId: input.messageId,
        content: input.content,
        createdAt: input.createdAt,
      },
      actor,
      rows,
      attributions,
      'sim_direct_messages',
    );
  } catch (err) {
    failLedger(err, 'attributeMessengerReply');
  }
}

export async function attributeEmailHandling(input: {
  sessionId: string;
  userId: string;
  emailId: string;
  bodyText: string;
  repliedToId: string | null;
  forwardedEmailId: string | null;
  createdAt: string;
  actorRole?: string | null;
  forwardRecipientTeams?: string[] | null;
}): Promise<void> {
  if (ledgerTablesMissing()) return;
  if (!input.repliedToId && !input.forwardedEmailId) return;
  try {
    const actor = await loadActor(input.sessionId, input.userId, input.createdAt, input.actorRole);
    if (!actor || actor.isTrainer) return;
    const starts = [input.repliedToId, input.forwardedEmailId].filter(
      (id): id is string => !!id && isUuid(id),
    );
    if (starts.length === 0) return;
    const emails = await loadEmailLinks(input.sessionId, starts);
    const lookupIds = new Set<string>(starts);
    for (const startId of starts) lookupIds.add(resolveEmailRootId(emails, startId));
    const deliveries = await loadEmailDeliveries(input.sessionId, [...lookupIds]);
    const resolved: Array<{
      deliveryId: string;
      attribution: 'email_reply' | 'email_forward';
      meta?: Record<string, unknown>;
    }> = [];
    const seen = new Set<string>();
    if (input.repliedToId) {
      const root = resolveEmailRootId(emails, input.repliedToId);
      const deliveryId = matchEmailDelivery(deliveries, root, input.repliedToId);
      if (deliveryId) {
        seen.add(deliveryId);
        resolved.push({ deliveryId, attribution: 'email_reply' });
      }
    }
    if (input.forwardedEmailId) {
      const root = resolveEmailRootId(emails, input.forwardedEmailId);
      const deliveryId = matchEmailDelivery(deliveries, root, input.forwardedEmailId);
      if (deliveryId && !seen.has(deliveryId)) {
        resolved.push({
          deliveryId,
          attribution: 'email_forward',
          meta: { recipient_teams: input.forwardRecipientTeams ?? [] },
        });
      }
    }
    const rows = await loadDeliveriesById(
      input.sessionId,
      resolved.map((item) => item.deliveryId),
    );
    await recordAttributed(
      {
        sessionId: input.sessionId,
        senderId: input.userId,
        messageId: input.emailId,
        content: input.bodyText,
        createdAt: input.createdAt,
      },
      actor,
      rows,
      resolved,
      'sim_emails',
    );
  } catch (err) {
    failLedger(err, 'attributeEmailHandling');
  }
}

export async function attributeSocialReply(input: {
  sessionId: string;
  userId: string;
  replyPostId: string;
  parentPostId: string;
  content: string;
  createdAt: string;
  actorRole?: string | null;
}): Promise<void> {
  if (ledgerTablesMissing()) return;
  try {
    const actor = await loadActor(input.sessionId, input.userId, input.createdAt, input.actorRole);
    if (!actor || actor.isTrainer) return;
    const { data, error } = await supabaseAdmin
      .from('inject_deliveries')
      .select(DELIVERY_COLUMNS)
      .eq('session_id', input.sessionId)
      .eq('ref_table', 'social_posts')
      .eq('ref_id', input.parentPostId)
      .maybeSingle();
    if (failLedger(error, 'attributeSocialReply')) return;
    if (!data) return;
    const row = data as DeliveryRecord;
    await recordResponse({
      sessionId: input.sessionId,
      deliveryId: row.id,
      injectId: row.inject_id,
      injectKey: row.inject_key,
      channel: row.channel,
      refTable: 'social_posts',
      refId: input.replyPostId,
      userId: input.userId,
      teamName: actor.teamName,
      isBot: actor.isBot,
      attribution: 'social_reply',
      contentExcerpt: input.content,
      respondedAt: input.createdAt,
      responseMinute: actor.minute,
    });
  } catch (err) {
    failLedger(err, 'attributeSocialReply');
  }
}

interface DeliveryRecord {
  id: string;
  inject_id: string;
  inject_key: string;
  channel: string;
  ref_id: string;
  chat_channel_id: string | null;
  thread_id: string | null;
  delivered_at: string | null;
  delivered_minute: number;
  recipient_teams: string[] | null;
  recipient_user_ids: string[] | null;
  response_window_minutes: number | null;
  first_response_at: string | null;
}

interface Actor {
  teamName: string | null;
  isBot: boolean;
  isTrainer: boolean;
  minute: number;
}

async function recordAttributed(
  input: {
    sessionId: string;
    senderId: string;
    messageId: string;
    content: string;
    createdAt: string;
  },
  actor: Actor,
  rows: DeliveryRecord[],
  attributions: Array<{
    deliveryId: string;
    attribution: LedgerAttribution;
    meta?: Record<string, unknown>;
  }>,
  refTable: string,
): Promise<void> {
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const attribution of attributions) {
    const row = byId.get(attribution.deliveryId);
    if (!row) continue;
    await recordResponse({
      sessionId: input.sessionId,
      deliveryId: row.id,
      injectId: row.inject_id,
      injectKey: row.inject_key,
      channel: row.channel,
      refTable,
      refId: input.messageId,
      userId: input.senderId,
      teamName: actor.teamName,
      isBot: actor.isBot,
      attribution: attribution.attribution,
      meta: attribution.meta,
      contentExcerpt: input.content,
      respondedAt: input.createdAt,
      responseMinute: actor.minute,
    });
  }
}

function toDmDelivery(row: DeliveryRecord, respondedTeams: string[]) {
  return {
    id: row.id,
    delivered_at: row.delivered_at ?? new Date(0).toISOString(),
    delivered_minute: row.delivered_minute,
    response_window_minutes: row.response_window_minutes,
    recipient_teams: row.recipient_teams ?? [],
    recipient_user_ids: row.recipient_user_ids,
    responded_teams: respondedTeams,
    chat_channel_id: row.chat_channel_id,
    thread_id: row.thread_id,
  };
}

async function bumpDeliveryResponse(input: RecordResponseInput): Promise<void> {
  const { data: current, error: readError } = await supabaseAdmin
    .from('inject_deliveries')
    .select('response_count, first_response_at')
    .eq('id', input.deliveryId)
    .maybeSingle();
  if (failLedger(readError, 'bumpDeliveryResponse.read')) return;
  const nextCount = ((current?.response_count as number | null) ?? 0) + 1;
  const { error: countError } = await supabaseAdmin
    .from('inject_deliveries')
    .update({ response_count: nextCount })
    .eq('id', input.deliveryId);
  if (failLedger(countError, 'bumpDeliveryResponse.count')) return;
  if (current?.first_response_at) return;
  const { error: firstError } = await supabaseAdmin
    .from('inject_deliveries')
    .update({
      first_response_at: input.respondedAt,
      first_response_minute: input.responseMinute,
      first_response_by: input.userId,
      first_response_team: input.teamName,
    })
    .eq('id', input.deliveryId)
    .is('first_response_at', null);
  failLedger(firstError, 'bumpDeliveryResponse.first');
}

async function respondedTeamKeys(deliveryIds: string[]): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (deliveryIds.length === 0 || ledgerTablesMissing()) return map;
  const { data, error } = await supabaseAdmin
    .from('inject_responses')
    .select('delivery_id, team_name, user_id')
    .in('delivery_id', deliveryIds);
  if (failLedger(error, 'respondedTeamKeys')) return map;
  for (const row of data ?? []) {
    const key = responseTeamKey(row.team_name as string | null, row.user_id as string | null);
    if (!key) continue;
    const deliveryId = String(row.delivery_id);
    const list = map.get(deliveryId) ?? [];
    if (!list.includes(key)) list.push(key);
    map.set(deliveryId, list);
  }
  return map;
}

async function loadEmailLinks(sessionId: string, startIds: string[]): Promise<EmailLink[]> {
  const links: EmailLink[] = [];
  const seen = new Set<string>();
  let frontier = startIds.filter((id) => isUuid(id));
  for (let hop = 0; hop < 8 && frontier.length > 0; hop++) {
    const ids = frontier.filter((id) => !seen.has(id));
    if (ids.length === 0) break;
    for (const id of ids) seen.add(id);
    const { data, error } = await supabaseAdmin
      .from('sim_emails')
      .select('id, thread_id, replied_to_id')
      .eq('session_id', sessionId)
      .in('id', ids);
    if (failLedger(error, 'loadEmailLinks')) return links;
    const next: string[] = [];
    for (const row of data ?? []) {
      links.push({
        id: String(row.id),
        thread_id: (row.thread_id as string | null) ?? null,
        replied_to_id: (row.replied_to_id as string | null) ?? null,
      });
      if (row.thread_id && !seen.has(String(row.thread_id))) next.push(String(row.thread_id));
      if (row.replied_to_id && !seen.has(String(row.replied_to_id)))
        next.push(String(row.replied_to_id));
    }
    frontier = next;
  }
  return links;
}

async function loadEmailDeliveries(
  sessionId: string,
  ids: string[],
): Promise<Array<{ id: string; thread_id: string | null; ref_id: string }>> {
  const unique = [...new Set(ids.filter(isUuid))];
  if (unique.length === 0) return [];
  const clauses = unique.flatMap((id) => [`thread_id.eq.${id}`, `ref_id.eq.${id}`]);
  const { data, error } = await supabaseAdmin
    .from('inject_deliveries')
    .select('id, thread_id, ref_id')
    .eq('session_id', sessionId)
    .eq('channel', 'email')
    .or(clauses.join(','));
  if (failLedger(error, 'loadEmailDeliveries')) return [];
  return (data ?? []).map((row) => ({
    id: String(row.id),
    thread_id: (row.thread_id as string | null) ?? null,
    ref_id: String(row.ref_id),
  }));
}

async function loadDeliveriesById(sessionId: string, ids: string[]): Promise<DeliveryRecord[]> {
  const unique = [...new Set(ids.filter(isUuid))];
  if (unique.length === 0) return [];
  const { data, error } = await supabaseAdmin
    .from('inject_deliveries')
    .select(DELIVERY_COLUMNS)
    .eq('session_id', sessionId)
    .in('id', unique);
  if (failLedger(error, 'loadDeliveriesById')) return [];
  return (data ?? []) as DeliveryRecord[];
}

async function loadActor(
  sessionId: string,
  userId: string,
  at: string,
  role?: string | null,
): Promise<Actor | null> {
  const clock = await loadSessionClock(sessionId);
  const minute = sessionMinuteAt(clock.startTime, at);
  if ((clock.trainerId && clock.trainerId === userId) || actorRoleSkipsResponse(role)) {
    return { teamName: null, isBot: false, isTrainer: true, minute };
  }
  const [teamName, isBot] = await Promise.all([
    getPlayerTeamName(sessionId, userId),
    profileIsBot(userId),
  ]);
  return { teamName, isBot, isTrainer: false, minute };
}

/**
 * `user_profiles.is_bot` is the flag the pool writes. `isBotUser()` loads that pool
 * and can create auth users, which a player message must not do.
 */
async function profileIsBot(userId: string): Promise<boolean> {
  try {
    const { data, error } = await supabaseAdmin
      .from('user_profiles')
      .select('is_bot')
      .eq('id', userId)
      .maybeSingle();
    if (error) return false;
    return (data as { is_bot?: boolean } | null)?.is_bot === true;
  } catch {
    return false;
  }
}

async function loadSessionClock(sessionId: string): Promise<SessionClock> {
  try {
    const { data, error } = await supabaseAdmin
      .from('sessions')
      .select('start_time, trainer_id')
      .eq('id', sessionId)
      .maybeSingle();
    if (error || !data) return { startTime: null, trainerId: null };
    return {
      startTime: (data.start_time as string | null) ?? null,
      trainerId: (data.trainer_id as string | null) ?? null,
    };
  } catch {
    return { startTime: null, trainerId: null };
  }
}

function emitLedger(
  trainerId: string | null,
  payload: {
    delivery_id: string;
    inject_id: string;
    inject_key: string;
    kind: 'delivered' | 'opened' | 'responded';
    channel: string;
    team?: string;
    at: string;
  },
): void {
  if (!trainerId) return;
  try {
    getWebSocketService().emitToUser(trainerId, {
      type: 'inject_ledger.updated',
      data: payload,
      timestamp: payload.at,
    });
  } catch (err) {
    logger.debug({ err, deliveryId: payload.delivery_id }, 'inject_ledger.updated was not emitted');
  }
}

function assignIfSet(row: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined && value !== null) row[key] = value;
}

function excerpt(content: string | null | undefined): string | null {
  if (!content) return null;
  return content.slice(0, 2000);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
