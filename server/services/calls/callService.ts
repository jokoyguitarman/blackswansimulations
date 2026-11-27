/**
 * Phone-call orchestration. Database access goes through CallStore; OpenAI goes
 * through RealtimeClient. Both are replaceable so tests never touch the network.
 */

import { randomUUID } from 'node:crypto';
import { env } from '../../env.js';
import { logger } from '../../lib/logger.js';
import { injectKeyOf } from '../../lib/injectKey.js';
import { phoneCaller } from '../../lib/injectChatMessages.js';
import { missedCallMessage } from '../../lib/injectChatMessages.js';
import { getWebSocketService } from '../websocketService.js';
import {
  findDeliveryByRef,
  recordDelivery,
  recordOpen,
  recordResponse,
  setDeliveryCallState,
  type LedgerCallState,
} from '../ledger/injectLedgerService.js';
import { recordPlayerAction } from '../sopCheckerService.js';
import { getPlayerTeamName } from '../teamCharterService.js';
import { isBotUser } from '../teammates/accounts.js';
import { createNotificationsForUsers } from '../notificationService.js';
import { supabaseCallStore } from './supabaseCallStore.js';
import { createRealtimeClient, WEBRTC_URL, type RealtimeClient, type Sideband } from './realtimeClient.js';
import type { CallStore, SimCall, StoredScript, StoredTurn } from './callTypes.js';
import { callbackAllowed, resolveCallRingSet, type RingGroup } from './lineCore.js';
import { buildRingSetInput, owningTeamFor } from './callRouting.js';
import { holdersByTeam, loadCallPolicy } from './lineService.js';
import { rolePlayersById } from '../roles/roleService.js';
import { rolesFeatureReady } from '../roles/rolesSchema.js';
import {
  ACTIVE_SWEEP_GRACE_SECONDS,
  answerChannel,
  applyDecline,
  buildRealtimeInstructions,
  callbackScript,
  callerMissedCount,
  canTransition,
  CONNECT_TIMEOUT_MS,
  DEFAULT_REALTIME_VOICES,
  deriveCallScript,
  formatTranscript,
  groupMissedCount,
  LINE_DROPPED,
  nextAttempt,
  openingForAttempt,
  openingInstruction,
  parseRedial,
  pickVoice,
  planUserQueue,
  realtimeSessionBody,
  scriptedTurns,
  SILENCE_HANGUP_MS,
  SILENCE_PROMPT_MS,
  sweepTerminal,
  unseenMissedBadge,
  USER_RING_GAP_MS,
  voiceAllowedByBudget,
  type AnswerChannel,
  type CallStatus,
  type CountedAttempt,
  type GroupAttempt,
  type StopReason,
  type StopSignals,
} from './callCore.js';

export interface PhoneInjectInput {
  id: string;
  title: string;
  content: string;
  requires_response?: boolean;
  delivery_config: Record<string, unknown> | null;
}

export interface PhoneTargeting {
  playerIds: string[] | null;
  teamNames: string[];
}

export interface CallActor {
  id: string;
  role?: string;
}

export interface CallSummary {
  id: string;
  session_id: string;
  inject_id: string | null;
  direction: 'inbound' | 'callback';
  caller_name: string;
  caller_number: string | null;
  status: CallStatus;
  mode: 'voice' | 'text' | null;
  ring_deadline_at: string;
  answered_by: string | null;
  answered_by_name?: string;
  started_at: string;
  ended_at: string | null;
  duration_seconds: number | null;
  end_reason: string | null;
  can_callback: boolean;
  call_group_id: string;
  attempt_no: number;
  max_attempts: number;
  group_missed_count: number;
  caller_missed_count: number;
  next_attempt_at?: string;
  line_team: string | null;
  target_mode: 'ring_all' | 'line' | 'role' | 'player';
  missed_reason: string | null;
  opening: string;
}

export interface VoiceAnswer {
  mode: 'voice';
  call_id: string;
  client_secret: string;
  expires_at: string | number | null;
  model: string;
  webrtc_url: string;
  opening_instruction: string;
}

export interface TextAnswer {
  mode: 'text';
  call_id: string;
  opening: string;
  ended?: boolean;
  end_reason?: string;
  reply?: string;
}

export type CallFailure = { ok: false; status: number; error: string };
export type CallSuccess<T> = { ok: true; status: number; body: T };

const TERMINAL: CallStatus[] = ['ended', 'declined', 'missed', 'failed', 'cancelled'];
const sidebands = new Map<string, Sideband>();
const deliveryIds = new Map<string, string>();
const timers = new Map<string, NodeJS.Timeout>();

export interface CallServiceDeps {
  store?: CallStore;
  realtime?: RealtimeClient;
  now?: () => Date;
  scheduleTimers?: boolean;
  aiEnabled?: boolean;
  hasOpenAiKey?: () => boolean;
  voices?: string[];
  model?: string;
  transcribeModel?: string;
  maxConcurrent?: number;
  maxMinutes?: number;
  callbackWindowMinutes?: number;
  emit?: (userId: string, event: { type: string; data: Record<string, unknown>; timestamp: string }) => void;
  remember?: (call: SimCall, turns: StoredTurn[]) => Promise<void>;
  postVoicemail?: (call: SimCall, content: string) => Promise<void>;
  notifyMissed?: (call: SimCall, callerMissed: number) => Promise<void>;
  recordAction?: (call: SimCall, userId: string, action: string, metadata: Record<string, unknown>) => Promise<void>;
  textReply?: (input: {
    instructions: string;
    history: string;
    playerText: string;
  }) => Promise<{ reply: string; end_call: boolean; beats_done: string[] } | null>;
  ledger?: boolean;
  names?: (ids: string[]) => Promise<Record<string, string>>;
}

export interface CallApi {
  startInject(sessionId: string, inject: PhoneInjectInput, targeting: PhoneTargeting | null): Promise<'started' | 'unavailable'>;
  sweep(sessionId: string): Promise<void>;
  settle(sessionId: string): Promise<void>;
  resumeSidebands(): Promise<void>;
  list(sessionId: string, actor: CallActor): Promise<CallSummary[]>;
  get(callId: string, actor: CallActor): Promise<CallSuccess<CallSummary & { turns: StoredTurn[] }> | CallFailure>;
  answer(callId: string, actor: CallActor, capabilities: { webrtc: boolean; mic: boolean }): Promise<CallSuccess<VoiceAnswer | TextAnswer> | CallFailure>;
  decline(callId: string, actor: CallActor): Promise<CallSuccess<null> | CallFailure>;
  attach(callId: string, actor: CallActor, body: { openai_call_id: string; first_audio_ms?: number }): Promise<CallSuccess<null> | CallFailure>;
  transcript(callId: string, actor: CallActor, turns: Array<{ seq?: number; speaker: StoredTurn['speaker']; text: string; at?: string }>): Promise<CallSuccess<null> | CallFailure>;
  textTurn(callId: string, actor: CallActor, text: string): Promise<CallSuccess<{ reply: string; ended: boolean }> | CallFailure>;
  hangup(callId: string, actor: CallActor): Promise<CallSuccess<null> | CallFailure>;
  callback(callId: string, actor: CallActor, capabilities: { webrtc: boolean; mic: boolean }): Promise<CallSuccess<VoiceAnswer | TextAnswer> | CallFailure>;
  badge(sessionId: string, actor: CallActor): Promise<{ missed_unseen: number }>;
  markViewed(sessionId: string, actor: CallActor): Promise<void>;
  reportAudio(callId: string, actor: CallActor, firstAudioMs: number): Promise<CallSuccess<null> | CallFailure>;
}

export function createCallService(deps: CallServiceDeps = {}): CallApi {
  const store = deps.store ?? supabaseCallStore;
  const realtime = deps.realtime ?? createRealtimeClient();
  const now = deps.now ?? (() => new Date());
  const scheduleTimers = deps.scheduleTimers !== false;
  const aiEnabled = deps.aiEnabled ?? env.aiEnabled;
  const hasKey = deps.hasOpenAiKey ?? (() => realtime.hasKey());
  const voices = deps.voices?.length ? deps.voices : env.realtimeVoices.length ? env.realtimeVoices : [...DEFAULT_REALTIME_VOICES];
  const model = deps.model ?? env.realtimeModel;
  const transcribeModel = deps.transcribeModel ?? env.realtimeTranscribeModel;
  const maxConcurrent = deps.maxConcurrent ?? env.realtimeMaxConcurrentCallsPerSession;
  const maxMinutes = deps.maxMinutes ?? env.realtimeMaxMinutesPerSession;
  const callbackWindow = deps.callbackWindowMinutes ?? env.callbackWindowMinutes;
  const useLedger = deps.ledger !== false;

  const api: CallApi = {
    startInject,
    sweep,
    settle,
    resumeSidebands,
    list,
    get,
    answer,
    decline,
    attach,
    transcript,
    textTurn,
    hangup,
    callback,
    badge,
    markViewed,
    reportAudio,
  };
  return api;

  async function startInject(
    sessionId: string,
    inject: PhoneInjectInput,
    targeting: PhoneTargeting | null,
  ): Promise<'started' | 'unavailable'> {
    if (!(await store.ready())) return 'unavailable';
    const session = await store.session(sessionId);
    const config = inject.delivery_config ?? {};
    const caller = phoneCaller(config as Parameters<typeof phoneCaller>[0]);
    const callerName = caller.name ?? 'Unknown caller';
    const script = deriveCallScript(inject.content, (config.call_script as StoredScript | null) ?? null);
    const redial = parseRedial(config.redial);
    const ringSeconds = clamp(config.ring_seconds, 10, 60, 30);
    const maxSeconds = clamp(config.max_call_seconds, 60, 900, 300);
    const voice =
      typeof config.voice === 'string' && config.voice.trim()
        ? config.voice.trim()
        : pickVoice(String(config.stakeholder_id ?? callerName), voices);
    const teams = targeting?.teamNames ?? [];
    const members = await store.teamMembers(sessionId, teams.filter((team) => team !== 'all' && !team.startsWith('org:')));
    let recipients = targeting?.playerIds ?? null;
    if (recipients == null) recipients = await store.participantIds(sessionId);
    if (session?.trainerId) recipients = recipients.filter((id) => id !== session.trainerId);
    const open = await store.listOpen(sessionId);
    const busy = new Set(
      open.filter((call) => call.status === 'connecting' || call.status === 'active').map((call) => call.answeredBy).filter((id): id is string => Boolean(id)),
    );
    const stakeholderId = typeof config.stakeholder_id === 'string' ? config.stakeholder_id : null;
    const groups = resolveCallRingSet(
      await buildRingSetInput({
        sessionId,
        config: config as Record<string, unknown>,
        teams,
        members,
        recipients,
        busy: (id) => busy.has(id),
        attemptNo: 1,
        owningTeam: await owningTeamFor(sessionId, stakeholderId),
      }),
    );
    const at = now();
    let nextFree: Record<string, number> = {};
    for (const call of open) {
      if (call.status !== 'ringing' && call.status !== 'scheduled') continue;
      for (const userId of call.recipientUserIds ?? []) {
        nextFree[userId] = Math.max(nextFree[userId] ?? at.getTime(), at.getTime() + USER_RING_GAP_MS);
      }
    }
    const existing = await store.listSession(sessionId);
    for (const group of groups) {
      const teamKey = group.line_team ?? '';
      const already = existing.find(
        (call) =>
          call.injectId === inject.id &&
          call.direction === 'inbound' &&
          call.attemptNo === 1 &&
          (call.recipientTeams[0] ?? '') === teamKey,
      );
      if (already) continue;
      const queue = planUserQueue({
        userIds: [...group.ring, ...group.call_waiting],
        nowMs: at.getTime(),
        ringWindowMs: ringSeconds * 1000,
        nextFreeMs: nextFree,
      });
      nextFree = queue.nextFreeMs;
      const stored = baseScript(script, redial, inject, ringSeconds, group);
      const id = randomUUID();
      const recipientsForGroup = [...group.ring, ...group.call_waiting];
      const missedNow =
        group.outcome === 'line_unattended' ||
        group.outcome === 'role_offline' ||
        recipientsForGroup.length === 0 ||
        queue.missed;
      const delayed = !missedNow && queue.startMs > at.getTime();
      const reasonNow = missedReasonFor(group.outcome);
      const row = blankCall({
        id,
        sessionId,
        injectId: inject.id,
        stakeholderId: typeof config.stakeholder_id === 'string' ? config.stakeholder_id : null,
        callerName,
        callerNumber: caller.number,
        voice,
        script: { ...stored, fallback_reason: group.fallback_reason, role_title: roleTitle(config) },
        recipientUserIds: recipientsForGroup,
        recipientTeams: group.line_team ? [group.line_team] : [],
        status: missedNow ? 'missed' : delayed ? 'scheduled' : 'ringing',
        callGroupId: id,
        attemptNo: 1,
        maxAttempts: redial.attempts,
        scheduledFor: delayed ? new Date(queue.startMs).toISOString() : null,
        ringStartedAt: at.toISOString(),
        ringDeadlineAt: new Date(at.getTime() + ringSeconds * 1000).toISOString(),
        maxSeconds,
        lineTeam: group.line_team,
        targetMode: group.mode_used,
        targetRoleId: group.target_role_id,
        rungUserIds: recipientsForGroup,
        missedReason: missedNow || group.outcome === 'line_busy' || group.outcome === 'role_busy' ? reasonNow : null,
        endReason: missedNow ? reasonNow : null,
        endedAt: missedNow ? at.toISOString() : null,
      });
      if (delayed) row.script = { ...row.script, queue_hold: true };
      row.script = { ...row.script, call_waiting: group.call_waiting };
      const inserted = await store.insert(row);
      if (!inserted?.created) continue;
      if (group.fallback_reason && session?.trainerId) {
        emit(session.trainerId, 'role.unassigned_target', {
          role_id: group.target_role_id,
          inject_id: inject.id,
          fallback: group.fallback_reason,
        });
      }
      if (row.status === 'ringing') await beginRing(inserted.call, group);
      if (row.status === 'missed') await afterTerminal(inserted.call, row.endReason ?? 'no_answer');
    }
    return 'started';
  }

  async function beginRing(call: SimCall, group?: RingGroup): Promise<void> {
    const waiting = new Set(group?.call_waiting ?? call.script.call_waiting);
    const targets = call.recipientUserIds ?? [];
    for (const userId of targets) {
      emit(userId, 'sim_call.ringing', {
        call_id: call.id,
        inject_id: call.injectId,
        caller_name: call.callerName,
        caller_number: call.callerNumber,
        ring_deadline_at: call.ringDeadlineAt,
        direction: call.direction,
        line_team: call.lineTeam,
        call_waiting: waiting.has(userId),
        role_title: call.script.role_title,
        target_role_id: call.targetRoleId,
      });
    }
    if (useLedger && call.injectId) {
      const deliveryId = await recordDelivery({
        sessionId: call.sessionId,
        injectId: call.injectId,
        injectKey: callKey(call),
        channel: 'call',
        refTable: 'sim_calls',
        refId: call.id,
        recipientUserIds: call.recipientUserIds,
        recipientTeams: call.recipientTeams,
        stakeholderId: call.stakeholderId,
        senderName: call.callerName,
        requiresResponse: call.script.requires_response,
        responseWindowMinutes: call.script.response_window_minutes,
        callState: 'ringing',
        callGroupId: call.callGroupId,
        attemptNo: call.attemptNo,
        deliveredAt: call.ringStartedAt,
        lineTeam: call.lineTeam,
        targetRoleId: call.targetRoleId,
        fallbackReason: call.script.fallback_reason ?? null,
      });
      if (deliveryId) deliveryIds.set(call.id, deliveryId);
    }
    arm(call);
  }

  async function answer(
    callId: string,
    actor: CallActor,
    capabilities: { webrtc: boolean; mic: boolean },
  ): Promise<CallSuccess<VoiceAnswer | TextAnswer> | CallFailure> {
    const call = await store.get(callId);
    if (!call) return fail(404, 'not_found');
    if (!canAccess(call, actor)) return fail(403, 'forbidden');
    if (call.status !== 'ringing') {
      return fail(409, call.status === 'connecting' || call.status === 'active' ? 'call_taken' : 'call_ended');
    }
    if (await store.userBusy(call.sessionId, actor.id, call.id)) return fail(409, 'busy');
    const at = now();
    const claimed = await store.claimAnswer(call.id, actor.id, at.toISOString());
    if (!claimed) {
      const current = await store.get(call.id);
      const taken = current?.status === 'connecting' || current?.status === 'active';
      return fail(409, taken ? 'call_taken' : 'call_ended');
    }
    const others = (claimed.recipientUserIds ?? []).filter((id) => id !== actor.id);
    const session = await store.session(call.sessionId);
    for (const userId of others) {
      emit(userId, 'sim_call.taken', { call_id: call.id, answered_by_name: actor.id });
    }
    const channel = await chooseChannel(call.sessionId, capabilities);
    if (channel === 'voice') {
      const opening = openingForAttempt(claimed.script, claimed.attemptNo, claimed.callerName);
      const instructions = await instructionsFor(claimed, opening);
      const minted = await realtime.mintClientSecret(
        realtimeSessionBody({
          model,
          instructions,
          voice: claimed.voice,
          transcribeModel,
        }),
      );
      if (!minted.ok) {
        logger.warn({ status: minted.status, event: 'realtime_mint_failed' }, 'Realtime client secret mint failed');
        return activateText(claimed, actor, opening, 'mint_failed');
      }
      arm(claimed);
      emitBoth(claimed, session?.trainerId ?? null, 'sim_call.state', { call_id: call.id, status: 'connecting', mode: 'voice' });
      return {
        ok: true,
        status: 200,
        body: {
          mode: 'voice',
          call_id: call.id,
          client_secret: minted.value,
          expires_at: minted.expires_at,
          model,
          webrtc_url: WEBRTC_URL,
          opening_instruction: openingInstruction(opening),
        },
      };
    }
    const opening = openingForAttempt(claimed.script, claimed.attemptNo, claimed.callerName);
    if (channel === 'scripted_only') return playScript(claimed, actor, opening);
    return activateText(claimed, actor, opening, null);
  }

  async function decline(callId: string, actor: CallActor): Promise<CallSuccess<null> | CallFailure> {
    const call = await store.get(callId);
    if (!call) return fail(404, 'not_found');
    if (!canAccess(call, actor)) return fail(403, 'forbidden');
    if (call.status !== 'ringing') return fail(409, 'call_ended');
    const recipients = call.recipientUserIds ?? [];
    const step = applyDecline(recipients, call.declinedUserIds, actor.id);
    const next: SimCall = { ...call, declinedUserIds: step.declinedUserIds, declinedBy: actor.id };
    await store.save(next);
    await action(next, actor.id, 'call_declined', { call_group_id: next.callGroupId, attempt_no: next.attemptNo });
    if (step.status === 'declined') await finish(next, 'declined', 'declined', actor.id);
    return { ok: true, status: 204, body: null };
  }

  async function attach(
    callId: string,
    actor: CallActor,
    body: { openai_call_id: string; first_audio_ms?: number },
  ): Promise<CallSuccess<null> | CallFailure> {
    const call = await store.get(callId);
    if (!call) return fail(404, 'not_found');
    if (call.answeredBy !== actor.id) return fail(409, 'not_answerer');
    if (call.status !== 'connecting') return fail(409, 'call_ended');
    if (body.first_audio_ms != null) logFirstAudio(call.id, body.first_audio_ms);
    const opening = openingForAttempt(call.script, call.attemptNo, call.callerName);
    const active: SimCall = {
      ...call,
      status: 'active',
      mode: 'voice',
      openaiCallId: body.openai_call_id,
      transcriptSource: 'sideband',
    };
    await store.save(active);
    const session = await store.session(call.sessionId);
    const sideband = await realtime.openSideband(body.openai_call_id, (event) => {
      void onSideband(active.id, event);
    });
    if (sideband) {
      sidebands.set(active.id, sideband);
      sideband.send({ type: 'response.create', response: { instructions: openingInstruction(opening) } });
    } else {
      const relay: SimCall = { ...active, transcriptSource: 'client' };
      await store.save(relay);
      emitBoth(relay, session?.trainerId ?? null, 'sim_call.state', {
        call_id: call.id,
        status: 'active',
        mode: 'voice',
        relay: true,
      });
    }
    emitBoth(active, session?.trainerId ?? null, 'sim_call.state', { call_id: call.id, status: 'active', mode: 'voice', relay: !sideband });
    await markAnswered(active, actor.id);
    arm(active);
    return { ok: true, status: 204, body: null };
  }

  async function transcript(
    callId: string,
    actor: CallActor,
    incoming: Array<{ seq?: number; speaker: StoredTurn['speaker']; text: string; at?: string }>,
  ): Promise<CallSuccess<null> | CallFailure> {
    const call = await store.get(callId);
    if (!call) return fail(404, 'not_found');
    if (call.answeredBy !== actor.id) return fail(403, 'forbidden');
    if (sidebands.has(call.id) || call.transcriptSource === 'sideband') return fail(409, 'sideband_attached');
    const existing = await store.turns(call.id);
    const start = existing.reduce((max, turn) => Math.max(max, turn.seq), 0);
    const saved: StoredTurn[] = incoming.slice(0, 20).map((turn, index) => ({
      id: randomUUID(),
      callId: call.id,
      sessionId: call.sessionId,
      seq: turn.seq && !existing.some((row) => row.seq === turn.seq) ? turn.seq : start + index + 1,
      speaker: turn.speaker,
      userId: turn.speaker === 'player' ? actor.id : null,
      text: turn.text.slice(0, 4000),
      source: 'client',
      at: turn.at ?? now().toISOString(),
    }));
    await store.appendTurns(saved);
    if (call.transcriptSource !== 'client') await store.save({ ...call, transcriptSource: 'client' });
    const session = await store.session(call.sessionId);
    for (const turn of saved) emitBoth(call, session?.trainerId ?? null, 'sim_call.turn', { call_id: call.id, turn: publicTurn(turn) });
    return { ok: true, status: 204, body: null };
  }

  async function textTurn(
    callId: string,
    actor: CallActor,
    text: string,
  ): Promise<CallSuccess<{ reply: string; ended: boolean }> | CallFailure> {
    const call = await store.get(callId);
    if (!call) return fail(404, 'not_found');
    if (call.answeredBy !== actor.id) return fail(403, 'forbidden');
    if (call.status !== 'active' && call.status !== 'connecting') return fail(409, 'call_ended');
    if (!text.trim()) {
      const system = await addTurn(call, 'system', LINE_DROPPED, 'text', null);
      const switched: SimCall = { ...call, status: 'active', mode: 'text', transcriptSource: 'text' };
      await store.save(switched);
      const session = await store.session(call.sessionId);
      emitBoth(switched, session?.trainerId ?? null, 'sim_call.state', { call_id: call.id, status: 'active', mode: 'text' });
      emitBoth(switched, session?.trainerId ?? null, 'sim_call.turn', { call_id: call.id, turn: publicTurn(system) });
      return { ok: true, status: 200, body: { reply: LINE_DROPPED, ended: false } };
    }
    await addTurn(call, 'player', text.trim(), 'text', actor.id);
    const opening = openingForAttempt(call.script, call.attemptNo, call.callerName);
    const history = (await store.turns(call.id)).map((turn) => `${turn.speaker}: ${turn.text}`).join('\n');
    const reply = deps.textReply
      ? await deps.textReply({ instructions: await instructionsFor(call, opening), history, playerText: text.trim() })
      : await defaultTextReply(await instructionsFor(call, opening), history, text.trim());
    const spoken = reply?.reply?.trim() || call.script.beats.find((beat) => !call.beatsDone.includes(beat.id))?.say || call.script.closing;
    const npc = await addTurn(call, 'npc', spoken, 'text', null);
    const beats = Array.from(new Set([...call.beatsDone, ...(reply?.beats_done ?? [])]));
    const current: SimCall = { ...call, status: 'active', mode: 'text', transcriptSource: 'text', beatsDone: beats };
    await store.save(current);
    const session = await store.session(call.sessionId);
    emitBoth(current, session?.trainerId ?? null, 'sim_call.turn', { call_id: call.id, turn: publicTurn(npc) });
    if (reply?.end_call) {
      await finish(current, 'ended', 'npc_end', actor.id);
      return { ok: true, status: 200, body: { reply: spoken, ended: true } };
    }
    return { ok: true, status: 200, body: { reply: spoken, ended: false } };
  }

  async function hangup(callId: string, actor: CallActor): Promise<CallSuccess<null> | CallFailure> {
    const call = await store.get(callId);
    if (!call) return fail(404, 'not_found');
    if (call.answeredBy !== actor.id && !canAccess(call, actor)) return fail(403, 'forbidden');
    if (TERMINAL.includes(call.status)) return { ok: true, status: 204, body: null };
    if (call.openaiCallId) await realtime.hangup(call.openaiCallId);
    await finish(call, 'ended', 'player_hangup', actor.id);
    return { ok: true, status: 204, body: null };
  }

  async function callback(
    callId: string,
    actor: CallActor,
    capabilities: { webrtc: boolean; mic: boolean },
  ): Promise<CallSuccess<VoiceAnswer | TextAnswer> | CallFailure> {
    const seed = await store.get(callId);
    if (!seed) return fail(404, 'not_found');
    if (!(await rolesFeatureReady())) {
      if (!canAccess(seed, actor)) return fail(403, 'forbidden');
    } else if (!canAccess(seed, actor)) {
      const permitted = await callbackPermitted(seed, actor.id);
      if (!permitted.allowed) return fail(403, 'forbidden');
    } else {
      const permitted = await callbackPermitted(seed, actor.id);
      if (!permitted.allowed) return fail(403, permitted.code ?? 'callback_not_allowed');
    }
    const sessionCalls = await store.listSession(seed.sessionId);
    const group = sessionCalls.filter((call) => call.callGroupId === seed.callGroupId);
    const summary = toSummary(seed, sessionCalls, {});
    if (!summary.can_callback) return fail(409, 'call_ended');
    const session = await store.session(seed.sessionId);
    if (session && session.status !== 'in_progress') return fail(409, 'call_ended');
    if (await store.userBusy(seed.sessionId, actor.id)) return fail(409, 'busy');
    const latest = [...group].sort((a, b) => b.attemptNo - a.attemptNo)[0] ?? seed;
    const first = group.find((call) => call.attemptNo === 1) ?? seed;
    const waitMinutes = Math.max(0, Math.round((now().getTime() - Date.parse(first.ringStartedAt)) / 60000));
    const missed = group.filter((call) => call.status === 'missed' || call.status === 'declined').length;
    const script = callbackScript(first.script, waitMinutes, callbackWindow);
    const id = randomUUID();
    const at = now().toISOString();
    const row = blankCall({
      id,
      sessionId: seed.sessionId,
      injectId: seed.injectId,
      callerName: seed.callerName,
      callerNumber: seed.callerNumber,
      voice: seed.voice,
      script: { ...script, ...redialFields(first.script), redial: { attempts: 1, interval_minutes: 2, voicemail_each: false, stop_on_contact: true } },
      recipientUserIds: [actor.id],
      recipientTeams: seed.recipientTeams,
      status: 'connecting',
      callGroupId: id,
      attemptNo: 1,
      maxAttempts: 1,
      scheduledFor: null,
      ringStartedAt: at,
      ringDeadlineAt: at,
      maxSeconds: seed.maxSeconds,
      lineTeam: seed.lineTeam,
      rungUserIds: [actor.id],
      missedReason: null,
      endReason: null,
      endedAt: null,
    });
    row.direction = 'callback';
    row.parentCallId = latest.id;
    row.stakeholderId = seed.stakeholderId;
    row.answeredBy = actor.id;
    row.answeredAt = at;
    row.script = { ...row.script, opening: script.opening };
    const inserted = await store.insert(row);
    if (!inserted) return fail(404, 'not_found');
    await cancelGroup(group, 'called_back');
    await recordReturned(first, inserted.call, actor.id);
    await action(inserted.call, actor.id, 'call_returned', { call_group_id: seed.callGroupId, parent_call_id: latest.id });
    const channel = await chooseChannel(seed.sessionId, capabilities);
    if (channel === 'voice') {
      const minted = await realtime.mintClientSecret(
        realtimeSessionBody({
          model,
          instructions: await instructionsFor(inserted.call, script.opening, {
            kind: 'callback',
            attempt_no: 1,
            wait_minutes: waitMinutes,
            missed_calls: missed,
            unanswered_messages: 0,
          }),
          voice: row.voice,
          transcribeModel,
        }),
      );
      if (minted.ok) {
        await store.save(inserted.call);
        return {
          ok: true,
          status: 200,
          body: {
            mode: 'voice',
            call_id: inserted.call.id,
            client_secret: minted.value,
            expires_at: minted.expires_at,
            model,
            webrtc_url: WEBRTC_URL,
            opening_instruction: openingInstruction(script.opening),
          },
        };
      }
    }
    if (channel === 'scripted_only' || !aiEnabled) return playScript(inserted.call, actor, script.opening);
    return activateText(inserted.call, actor, script.opening, null);
  }

  async function list(sessionId: string, actor: CallActor): Promise<CallSummary[]> {
    const calls = await store.listSession(sessionId);
    const session = await store.session(sessionId);
    const names = await lookupNames(calls.map((call) => call.answeredBy).filter((id): id is string => Boolean(id)));
    return calls
      .filter((call) => canAccess(call, actor, session?.trainerId))
      .map((call) => toSummary(call, calls, names));
  }

  async function get(
    callId: string,
    actor: CallActor,
  ): Promise<CallSuccess<CallSummary & { turns: StoredTurn[] }> | CallFailure> {
    const call = await store.get(callId);
    if (!call) return fail(404, 'not_found');
    const session = await store.session(call.sessionId);
    if (!canAccess(call, actor, session?.trainerId)) return fail(403, 'forbidden');
    const calls = await store.listSession(call.sessionId);
    const names = call.answeredBy ? await lookupNames([call.answeredBy]) : {};
    const turns = await store.turns(call.id);
    return { ok: true, status: 200, body: { ...toSummary(call, calls, names), turns } };
  }

  async function badge(sessionId: string, actor: CallActor): Promise<{ missed_unseen: number }> {
    const calls = await store.listSession(sessionId);
    const viewed = await store.recentsViewedAt(sessionId, actor.id);
    return { missed_unseen: unseenMissedBadge(counted(calls), actor.id, viewed) };
  }

  async function markViewed(sessionId: string, actor: CallActor): Promise<void> {
    await store.setRecentsViewed(sessionId, actor.id, now().toISOString());
  }

  async function reportAudio(
    callId: string,
    actor: CallActor,
    firstAudioMs: number,
  ): Promise<CallSuccess<null> | CallFailure> {
    const call = await store.get(callId);
    if (!call) return fail(404, 'not_found');
    if (call.answeredBy !== actor.id) return fail(403, 'forbidden');
    logFirstAudio(call.id, firstAudioMs);
    return { ok: true, status: 204, body: null };
  }

  async function sweep(sessionId: string): Promise<void> {
    if (!(await store.ready())) return;
    const session = await store.session(sessionId);
    if (session && session.status !== 'in_progress') {
      await settle(sessionId);
      return;
    }
    const open = await store.listOpen(sessionId);
    const rung = new Set<string>();
    for (const call of open) {
      const at = now();
      const terminal = sweepTerminal({
        status: call.status,
        ringDeadlineAt: call.ringDeadlineAt,
        statusSince: call.answeredAt ?? call.ringStartedAt,
        maxSeconds: call.maxSeconds,
        nowMs: at.getTime(),
      });
      if (terminal === 'missed') {
        await finish(call, 'missed', 'no_answer', null);
        continue;
      }
      if (terminal === 'failed') {
        await finish(call, 'failed', 'connect_timeout', call.answeredBy);
        continue;
      }
      if (terminal === 'ended_timeout') {
        await finish(call, 'ended', 'timeout', call.answeredBy);
        continue;
      }
      if (call.status === 'active') await checkSilence(call, at);
      if (call.status !== 'scheduled') continue;
      if (rung.has(call.callGroupId)) continue;
      rung.add(call.callGroupId);
      await promoteScheduled(call, session?.status ?? 'in_progress');
    }
  }

  async function settle(sessionId: string): Promise<void> {
    if (!(await store.ready())) return;
    const open = await store.listOpen(sessionId);
    for (const call of open) {
      if (call.status === 'ringing') await finish(call, 'missed', 'session_ended', null);
      else if (call.status === 'scheduled') await finish({ ...call, status: 'scheduled' }, 'cancelled', 'session_ended', null);
      else if (call.status === 'connecting') await finish(call, 'failed', 'session_ended', call.answeredBy);
      else if (call.status === 'active') {
        if (call.openaiCallId) await realtime.hangup(call.openaiCallId);
        await finish(call, 'ended', 'session_ended', call.answeredBy);
      }
    }
  }

  async function resumeSidebands(): Promise<void> {
    if (!(await store.ready())) return;
    const active = await store.listActiveSideband();
    for (const call of active) {
      if (!call.openaiCallId || sidebands.has(call.id)) continue;
      const sideband = await realtime.openSideband(call.openaiCallId, (event) => {
        void onSideband(call.id, event);
      });
      if (sideband) {
        sidebands.set(call.id, sideband);
        continue;
      }
      const relay: SimCall = { ...call, transcriptSource: 'client' };
      await store.save(relay);
      const session = await store.session(call.sessionId);
      emitBoth(relay, session?.trainerId ?? null, 'sim_call.state', {
        call_id: call.id,
        status: 'active',
        mode: call.mode,
        relay: true,
      });
    }
  }

  async function promoteScheduled(call: SimCall, sessionStatus: string): Promise<void> {
    const at = now();
    if (call.script.queue_hold && at.getTime() > Date.parse(call.ringDeadlineAt)) {
      await finish(call, 'missed', 'no_answer', null);
      return;
    }
    if (call.scheduledFor && Date.parse(call.scheduledFor) > at.getTime()) return;
    const signals = await signalsFor(call);
    if (sessionStatus !== 'in_progress' || signals.session_ended) {
      await finish(call, 'cancelled', 'session_ended', null);
      return;
    }
    const plan = nextAttempt(await groupView(call), await minute(call.sessionId, at), signals);
    if (plan.action === 'cancel') {
      await finish(call, 'cancelled', plan.reason, null);
      return;
    }
    if (plan.action !== 'ring') return;
    const members = await store.teamMembers(call.sessionId, call.lineTeam ? [call.lineTeam] : call.recipientTeams);
    const open = await store.listOpen(call.sessionId);
    const busyIds = new Set(
      open.filter((row) => row.status === 'connecting' || row.status === 'active').map((row) => row.answeredBy).filter((id): id is string => Boolean(id)),
    );
    const groups = resolveCallRingSet(
      await buildRingSetInput({
        sessionId: call.sessionId,
        config: {
          target_role_id: call.targetRoleId,
          call_target: { mode: call.targetMode, user_id: call.recipientUserIds?.[0] },
          role_fallback: call.script.fallback_reason === 'role_offline_fallback' ? 'line' : 'none',
          stakeholder_team: call.lineTeam,
        },
        teams: call.lineTeam ? [call.lineTeam] : call.recipientTeams,
        members,
        recipients: call.recipientUserIds,
        busy: (id) => busyIds.has(id),
        attemptNo: call.attemptNo,
        owningTeam: call.lineTeam,
      }),
    );
    const group = groups[0];
    if (group?.outcome === 'held') {
      const later = new Date(at.getTime() + 60_000).toISOString();
      await store.save({ ...call, status: 'scheduled', scheduledFor: later });
      return;
    }
    if (!group || group.outcome === 'line_unattended' || group.outcome === 'role_offline') {
      const reason = group?.outcome === 'role_offline' ? 'role_offline' : 'line_unattended';
      await finish({ ...call, missedReason: reason, targetRoleId: group?.target_role_id ?? call.targetRoleId }, 'missed', reason, null);
      return;
    }
    const ringing: SimCall = {
      ...call,
      status: 'ringing',
      ringStartedAt: at.toISOString(),
      ringDeadlineAt: new Date(at.getTime() + call.script.ring_seconds * 1000).toISOString(),
      recipientUserIds: [...group.ring, ...group.call_waiting],
      rungUserIds: [...group.ring, ...group.call_waiting],
      lineTeam: group.line_team ?? call.lineTeam,
      targetMode: group.mode_used,
      targetRoleId: group.target_role_id ?? call.targetRoleId,
      script: { ...call.script, queue_hold: false, call_waiting: group.call_waiting, fallback_reason: group.fallback_reason ?? call.script.fallback_reason },
      missedReason: group.outcome === 'line_busy' || group.outcome === 'role_busy' ? group.outcome : null,
    };
    await store.save(ringing);
    await beginRing(ringing, group);
  }

  async function finish(call: SimCall, status: CallStatus, reason: string, actorId: string | null): Promise<void> {
    if (!canTransition(call.status, status) && call.status !== status) return;
    const at = now();
    const duration =
      status === 'ended' && call.answeredAt
        ? Math.max(0, Math.round((at.getTime() - Date.parse(call.answeredAt)) / 1000))
        : call.durationSeconds;
    const next: SimCall = {
      ...call,
      status,
      endedAt: at.toISOString(),
      endReason: reason,
      durationSeconds: duration,
      missedReason:
        status === 'missed'
          ? call.missedReason ?? (reason === 'line_unattended' ? 'line_unattended' : reason === 'line_busy' ? 'line_busy' : 'no_answer')
          : status === 'declined'
            ? 'declined'
            : call.missedReason,
    };
    await store.save(next);
    clearTimer(call.id);
    const sideband = sidebands.get(call.id);
    if (sideband) {
      sideband.close();
      sidebands.delete(call.id);
    }
    if (status === 'missed' || status === 'declined' || status === 'ended' || status === 'failed') {
      await setState(next, status === 'ended' ? 'ended' : status === 'failed' ? 'failed' : status);
    }
    const session = await store.session(call.sessionId);
    const recipients = next.recipientUserIds ?? [];
    if (status === 'missed' || status === 'declined') {
      const all = await store.listSession(call.sessionId);
      const counts = counted(all.map((row) => (row.id === next.id ? next : row)));
      const callerMissed = callerMissedCount(counts, callerKey(next));
      const groupMissed = groupMissedCount(counts, next.callGroupId);
      const upcoming = all.find((row) => row.callGroupId === next.callGroupId && row.status === 'scheduled');
      for (const userId of recipients) {
        emit(userId, 'sim_call.missed', {
          call_id: next.id,
          call_group_id: next.callGroupId,
          attempt_no: next.attemptNo,
          max_attempts: next.maxAttempts,
          caller_name: next.callerName,
          group_missed_count: groupMissed,
          caller_missed_count: callerMissed,
          next_attempt_at: upcoming?.scheduledFor ?? undefined,
          line_team: next.lineTeam,
          target_role_id: next.targetRoleId,
        });
      }
      await notify(next, callerMissed);
      const player = recipients[0];
      if (status === 'missed' && player) {
        await action(next, player, 'call_missed', {
          call_group_id: next.callGroupId,
          attempt_no: next.attemptNo,
          max_attempts: next.maxAttempts,
          recipients,
        });
      }
    }
    emitBoth(next, session?.trainerId ?? null, 'sim_call.ended', {
      call_id: next.id,
      status,
      end_reason: reason,
      duration_seconds: duration,
    });
    if (status === 'ended') await writeTranscript(next, actorId);
    if (reason === 'session_ended') {
      const group = (await store.listSession(call.sessionId)).filter((row) => row.callGroupId === call.callGroupId);
      await cancelGroup(group, 'session_ended');
      return;
    }
    await afterTerminal(next, reason);
  }

  async function afterTerminal(call: SimCall, reason: string): Promise<void> {
    if (reason === 'session_ended') return;
    const at = now();
    const signals = await signalsFor(call);
    const plan = nextAttempt(await groupView(call), await minute(call.sessionId, at), signals);
    if (plan.action === 'schedule') {
      await insertAttempt(call, plan.attempt_no, plan.at_minute, at);
    } else if (plan.action === 'cancel') {
      const group = (await store.listSession(call.sessionId)).filter((row) => row.callGroupId === call.callGroupId);
      await cancelGroup(group, plan.reason);
    }
    await maybeVoicemail(call);
  }

  async function insertAttempt(previous: SimCall, attemptNo: number, atMinute: number, at: Date): Promise<void> {
    const session = await store.session(previous.sessionId);
    const start = session?.startTime ? Date.parse(session.startTime) : at.getTime();
    const when = new Date(start + atMinute * 60000);
    const scheduledFor = when.getTime() < at.getTime() ? at.toISOString() : when.toISOString();
    const id = randomUUID();
    const row = blankCall({
      ...previous,
      id,
      status: 'scheduled',
      mode: null,
      callGroupId: previous.callGroupId,
      attemptNo,
      scheduledFor,
      ringStartedAt: scheduledFor,
      ringDeadlineAt: new Date(Date.parse(scheduledFor) + previous.script.ring_seconds * 1000).toISOString(),
      answeredBy: null,
      answeredAt: null,
      declinedBy: null,
      declinedUserIds: [],
      endedAt: null,
      endReason: null,
      durationSeconds: null,
      openaiCallId: null,
      transcriptSource: null,
      beatsDone: [],
      missedReason: null,
      createdAt: at.toISOString(),
    });
    row.script = { ...previous.script, queue_hold: false, silence_prompted: false, voicemail_posted_attempts: previous.script.voicemail_posted_attempts };
    row.parentCallId = null;
    row.direction = 'inbound';
    await store.insert(row);
  }

  async function cancelGroup(group: SimCall[], reason: StopReason): Promise<void> {
    const session = group[0] ? await store.session(group[0].sessionId) : null;
    for (const call of group) {
      if (call.status !== 'scheduled') continue;
      if (!canTransition(call.status, 'cancelled')) continue;
      await store.save({ ...call, status: 'cancelled', endReason: reason, endedAt: now().toISOString() });
    }
    if (!group[0]) return;
    const recipients = group[0].recipientUserIds ?? [];
    for (const userId of recipients) {
      emit(userId, 'sim_call.redial_cancelled', { call_group_id: group[0].callGroupId, reason });
    }
    if (session?.trainerId) {
      emit(session.trainerId, 'sim_call.redial_cancelled', { call_group_id: group[0].callGroupId, reason });
    }
  }

  async function maybeVoicemail(call: SimCall): Promise<void> {
    const group = (await store.listSession(call.sessionId)).filter((row) => row.callGroupId === call.callGroupId);
    const finished = group.every((row) => TERMINAL.includes(row.status)) && !group.some((row) => row.status === 'ended');
    const lines = voicemailLines(call, group, finished);
    if (lines.length === 0) return;
    const root = group.find((row) => row.attemptNo === 1) ?? call;
    const posted = new Set(root.script.voicemail_posted_attempts);
    const fresh = lines.filter((line) => !posted.has(line.attemptNo));
    if (fresh.length === 0) return;
    for (const line of fresh) {
      await postMail(root, line.content);
      posted.add(line.attemptNo);
    }
    await store.save({ ...root, script: { ...root.script, voicemail_posted_attempts: Array.from(posted) } });
  }

  async function playScript(call: SimCall, actor: CallActor, opening: string): Promise<CallSuccess<TextAnswer>> {
    const turns = scriptedTurns({ ...call.script, opening });
    for (const turn of turns) await addTurn(call, turn.speaker, turn.text, 'text', null);
    const active: SimCall = { ...call, status: 'active', mode: 'text', transcriptSource: 'text' };
    await store.save(active);
    await markAnswered(active, actor.id);
    await finish(active, 'ended', 'scripted_only', actor.id);
    return { ok: true, status: 200, body: { mode: 'text', call_id: call.id, opening, ended: true, end_reason: 'scripted_only' } };
  }

  async function activateText(call: SimCall, actor: CallActor, opening: string, _why: string | null): Promise<CallSuccess<TextAnswer>> {
    const active: SimCall = { ...call, status: 'active', mode: 'text', transcriptSource: 'text' };
    await store.save(active);
    await addTurn(active, 'npc', opening, 'text', null);
    await markAnswered(active, actor.id);
    const session = await store.session(call.sessionId);
    emitBoth(active, session?.trainerId ?? null, 'sim_call.state', { call_id: call.id, status: 'active', mode: 'text' });
    arm(active);
    return { ok: true, status: 200, body: { mode: 'text', call_id: call.id, opening } };
  }

  async function chooseChannel(sessionId: string, capabilities: { webrtc: boolean; mic: boolean }): Promise<AnswerChannel> {
    const budget = voiceAllowedByBudget({
      activeCalls: Math.max(0, (await store.activeCount(sessionId)) - 1),
      maxConcurrent,
      usedSeconds: await store.durationSeconds(sessionId),
      maxMinutes,
    });
    return answerChannel({
      webrtc: capabilities.webrtc,
      mic: capabilities.mic,
      openAiKeyPresent: hasKey(),
      aiEnabled,
      budgetAllowsVoice: budget,
    });
  }

  async function instructionsFor(
    call: SimCall,
    opening: string,
    context?: Parameters<typeof buildRealtimeInstructions>[0]['context'],
  ): Promise<string> {
    const character = await loadCharacter(call);
    return buildRealtimeInstructions({
      character,
      injectContent: call.script.inject_content || opening,
      script: { ...call.script, opening },
      maxMinutes: Math.max(1, Math.round(call.maxSeconds / 60)),
      context: context ?? (call.attemptNo > 1
        ? {
            kind: 'redial',
            attempt_no: call.attemptNo,
            wait_minutes: 0,
            missed_calls: call.attemptNo - 1,
            unanswered_messages: 0,
            voicemails: call.script.voicemail_posted_attempts.length,
          }
        : null),
    });
  }

  async function loadCharacter(call: SimCall) {
    const name = call.callerName;
    if (!call.stakeholderId) return { name };
    try {
      const session = await store.session(call.sessionId);
      if (!session?.scenarioId) return { name };
      const { findById } = await import('../stakeholderService.js');
      const stakeholder = await findById(session.scenarioId, call.stakeholderId);
      if (!stakeholder) return { name };
      return {
        name: stakeholder.name || name,
        title: stakeholder.title,
        organisation: stakeholder.organisation,
        personality: stakeholder.personality,
        stance: stakeholder.stance,
        knowledge: stakeholder.knowledge,
        willNotDisclose: stakeholder.will_not_disclose,
        hardConstraints: stakeholder.hard_constraints,
      };
    } catch {
      return { name };
    }
  }

  async function onSideband(callId: string, event: Record<string, unknown>): Promise<void> {
    const type = String(event.type ?? '');
    const call = await store.get(callId);
    if (!call) return;
    if (type === 'conversation.item.input_audio_transcription.completed') {
      const text = String(event.transcript ?? '').trim();
      if (text) await addTurn(call, 'player', text, 'sideband', call.answeredBy);
    } else if (type === 'response.output_audio_transcript.done') {
      const text = String(event.transcript ?? '').trim();
      if (text) await addTurn(call, 'npc', text, 'sideband', null);
    } else if (type === 'response.function_call_arguments.done') {
      const name = String(event.name ?? '');
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(String(event.arguments ?? '{}')) as Record<string, unknown>;
      } catch {
        args = {};
      }
      if (name === 'beat_done' && typeof args.beat_id === 'string') {
        const beats = Array.from(new Set([...call.beatsDone, args.beat_id]));
        await store.save({ ...call, beatsDone: beats });
      }
      if (name === 'end_call') {
        const sideband = sidebands.get(callId);
        sideband?.send({
          type: 'response.create',
          response: { instructions: 'Say your closing now and end the call.' },
        });
        const timer = setTimeout(() => {
          void finish(call, 'ended', 'npc_end', call.answeredBy);
        }, 15_000);
        timer.unref?.();
      }
    } else if (type === 'error') {
      logger.warn({ event: 'realtime_sideband_error', callId }, 'Realtime sideband error');
    }
  }

  async function checkSilence(call: SimCall, at: Date): Promise<void> {
    const turns = await store.turns(call.id);
    const last = turns.length ? Date.parse(turns[turns.length - 1].at) : Date.parse(call.answeredAt ?? call.ringStartedAt);
    const quiet = at.getTime() - last;
    if (quiet >= SILENCE_HANGUP_MS && call.script.silence_prompted) {
      await finish(call, 'ended', 'silence', call.answeredBy);
      return;
    }
    if (quiet >= SILENCE_PROMPT_MS && !call.script.silence_prompted) {
      await store.save({ ...call, script: { ...call.script, silence_prompted: true } });
      const sideband = sidebands.get(call.id);
      if (sideband) {
        sideband.send({ type: 'response.create', response: { instructions: 'Are you still there?' } });
      } else {
        await addTurn(call, 'npc', 'Are you still there?', call.mode === 'text' ? 'text' : 'sideband', null);
      }
    }
  }

  async function addTurn(
    call: SimCall,
    speaker: StoredTurn['speaker'],
    text: string,
    source: StoredTurn['source'],
    userId: string | null,
  ): Promise<StoredTurn> {
    const existing = await store.turns(call.id);
    const seq = existing.reduce((max, turn) => Math.max(max, turn.seq), 0) + 1;
    const turn: StoredTurn = {
      id: randomUUID(),
      callId: call.id,
      sessionId: call.sessionId,
      seq,
      speaker,
      userId,
      text,
      source,
      at: now().toISOString(),
    };
    await store.appendTurns([turn]);
    const session = await store.session(call.sessionId);
    emitBoth(call, session?.trainerId ?? null, 'sim_call.turn', { call_id: call.id, turn: publicTurn(turn) });
    return turn;
  }

  async function writeTranscript(call: SimCall, actorId: string | null): Promise<void> {
    const turns = await store.turns(call.id);
    const excerpt = formatTranscript(turns);
    if (useLedger && call.injectId && excerpt) {
      const deliveryId = await deliveryFor(call);
      if (deliveryId) {
        const at = now();
        await recordResponse({
          sessionId: call.sessionId,
          deliveryId,
          injectId: call.injectId,
          injectKey: callKey(call),
          channel: 'call',
          refTable: 'sim_call_turns',
          refId: call.id,
          userId: actorId,
          teamName: actorId ? await getPlayerTeamName(call.sessionId, actorId) : null,
          isBot: actorId ? await isBotUser(actorId) : false,
          attribution: 'call_transcript',
          contentExcerpt: excerpt,
          respondedAt: at.toISOString(),
          responseMinute: await minute(call.sessionId, at),
          meta: { end_reason: call.endReason, attempt_no: call.attemptNo },
        }).catch(() => null);
      }
    }
    if (actorId) await action(call, actorId, 'call_ended', { duration_seconds: call.durationSeconds });
    if (deps.remember) await deps.remember(call, turns);
    else {
      const { rememberEndedCall } = await import('./callMemory.js');
      await rememberEndedCall(call, turns);
    }
  }

  async function markAnswered(call: SimCall, userId: string): Promise<void> {
    await setState(call, 'answered');
    if (!useLedger || !call.injectId) {
      await action(call, userId, 'call_answered', { attempt_no: call.attemptNo });
      return;
    }
    const deliveryId = await deliveryFor(call);
    const at = now();
    if (deliveryId) {
      await recordOpen({ sessionId: call.sessionId, userId, refTable: 'sim_calls', refId: call.id, at: at.toISOString() });
      const first = (await store.listSession(call.sessionId)).find(
        (row) => row.callGroupId === call.callGroupId && row.attemptNo === 1,
      );
      const wait = first ? Math.max(0, Math.round((at.getTime() - Date.parse(first.ringStartedAt)) / 60000)) : 0;
      const answerSeconds = call.ringStartedAt ? Math.max(0, Math.round((at.getTime() - Date.parse(call.ringStartedAt)) / 1000)) : 0;
      await recordResponse({
        sessionId: call.sessionId,
        deliveryId,
        injectId: call.injectId,
        injectKey: callKey(call),
        channel: 'call',
        refTable: 'sim_calls',
        refId: call.id,
        userId,
        teamName: await getPlayerTeamName(call.sessionId, userId),
        isBot: await isBotUser(userId),
        attribution: 'call_answered',
        respondedAt: at.toISOString(),
        responseMinute: await minute(call.sessionId, at),
        waitMinutes: wait,
        meta: { answer_seconds: answerSeconds, attempt_no: call.attemptNo },
      });
    }
    await action(call, userId, 'call_answered', { attempt_no: call.attemptNo, answer_seconds: call.ringStartedAt ? Math.round((at.getTime() - Date.parse(call.ringStartedAt)) / 1000) : 0 });
  }

  async function recordReturned(original: SimCall, callbackCall: SimCall, userId: string): Promise<void> {
    if (!useLedger || !original.injectId) return;
    const deliveryId = await deliveryFor(original);
    if (!deliveryId) return;
    const at = now();
    await recordResponse({
      sessionId: original.sessionId,
      deliveryId,
      injectId: original.injectId,
      injectKey: callKey(original),
      channel: 'call',
      refTable: 'sim_calls',
      refId: callbackCall.id,
      userId,
      teamName: await getPlayerTeamName(original.sessionId, userId),
      isBot: await isBotUser(userId),
      attribution: 'call_returned',
      respondedAt: at.toISOString(),
      responseMinute: await minute(original.sessionId, at),
      meta: { callback_call_id: callbackCall.id },
    });
  }

  async function deliveryFor(call: SimCall): Promise<string | null> {
    const cached = deliveryIds.get(call.id);
    if (cached) return cached;
    const found = await findDeliveryByRef('sim_calls', call.id);
    if (found) deliveryIds.set(call.id, found.id);
    return found?.id ?? null;
  }

  async function setState(call: SimCall, state: LedgerCallState): Promise<void> {
    if (!useLedger) return;
    await setDeliveryCallState({ refTable: 'sim_calls', refId: call.id, callState: state });
  }

  async function action(call: SimCall, userId: string, name: string, metadata: Record<string, unknown>): Promise<void> {
    if (deps.recordAction) {
      await deps.recordAction(call, userId, name, metadata);
      return;
    }
    try {
      await recordPlayerAction(call.sessionId, userId, name, call.id, null, metadata);
    } catch (err) {
      logger.warn({ err, callId: call.id, action: name }, 'call player action failed');
    }
  }

  async function notify(call: SimCall, callerMissed: number): Promise<void> {
    if (deps.notifyMissed) {
      await deps.notifyMissed(call, callerMissed);
      return;
    }
    const users = call.recipientUserIds ?? [];
    if (users.length === 0) return;
    const title =
      callerMissed > 1 ? `Missed call from ${call.callerName} (${callerMissed})` : `Missed call from ${call.callerName}`;
    await createNotificationsForUsers(users, {
      sessionId: call.sessionId,
      type: 'missed_call',
      title,
      message: call.script.opening.slice(0, 180),
      priority: call.attemptNo >= 2 ? 'high' : 'medium',
      metadata: { call_id: call.id, call_group_id: call.callGroupId, attempt_no: call.attemptNo },
      actionUrl: `/sim/${call.sessionId}/device/phone?tab=missed`,
    });
  }

  async function postMail(call: SimCall, content: string): Promise<void> {
    if (deps.postVoicemail) {
      await deps.postVoicemail(call, content);
      return;
    }
    if (!call.injectId) return;
    if (call.recipientUserIds && call.recipientUserIds.length === 0) return;
    const { deliverMissedCallLine } = await import('../feedEngineService.js');
    const message = missedCallMessage(
      { id: call.injectId, title: call.script.inject_title, content: call.script.inject_content },
      {
        from_name: call.callerName,
        from_number: call.callerNumber ?? undefined,
        stakeholder_id: call.stakeholderId ?? undefined,
      },
      { opening: call.script.opening, count: 1 },
    );
    message.content = content;
    await deliverMissedCallLine({
      sessionId: call.sessionId,
      injectId: call.injectId,
      inject: { id: call.injectId, title: call.script.inject_title, content: call.script.inject_content, requires_response: call.script.requires_response },
      config: {
        app: 'phone_call',
        from_name: call.callerName,
        stakeholder_id: call.stakeholderId ?? undefined,
        channel_type: call.script.channel_type,
        response_window_minutes: call.script.response_window_minutes ?? undefined,
      },
      targeting: {
        playerIds: call.recipientUserIds,
        teamNames: call.recipientTeams,
      },
      message,
    });
  }

  async function signalsFor(call: SimCall): Promise<StopSignals> {
    const session = await store.session(call.sessionId);
    const group = (await store.listSession(call.sessionId)).filter((row) => row.callGroupId === call.callGroupId);
    const first = group.find((row) => row.attemptNo === 1) ?? call;
    const calledBack = (await store.listSession(call.sessionId)).some(
      (row) => row.direction === 'callback' && group.some((item) => item.id === row.parentCallId),
    );
    let contact: number | null = null;
    if (call.script.redial.stop_on_contact && call.stakeholderId) {
      const hit = await store.playerContactedStakeholder(call.sessionId, call.stakeholderId, first.ringStartedAt);
      if (hit) contact = await minute(call.sessionId, now());
    }
    return {
      called_back: calledBack,
      contacted_elsewhere_at_minute: contact,
      chain_stopped: false,
      session_ended: session != null && session.status !== 'in_progress',
    };
  }

  async function groupView(call: SimCall) {
    const group = (await store.listSession(call.sessionId)).filter((row) => row.callGroupId === call.callGroupId);
    const attempts: GroupAttempt[] = [];
    for (const row of group) {
      attempts.push({
        attempt_no: row.attemptNo,
        status: row.status,
        ended_minute: row.endedAt ? await minute(call.sessionId, new Date(row.endedAt)) : null,
        scheduled_for_minute: row.scheduledFor ? await minute(call.sessionId, new Date(row.scheduledFor)) : null,
        answered: row.status === 'ended' || Boolean(row.answeredBy && (row.status === 'active' || row.status === 'connecting')),
      });
    }
    return {
      max_attempts: call.maxAttempts,
      interval_minutes: call.script.redial.interval_minutes,
      stop_on_contact: call.script.redial.stop_on_contact,
      attempts,
    };
  }

  async function minute(sessionId: string, at: Date): Promise<number> {
    return sessionMinute(sessionId, at);
  }

  const starts = new Map<string, string | null>();
  async function sessionMinute(sessionId: string, at: Date): Promise<number> {
    if (!starts.has(sessionId)) {
      const session = await store.session(sessionId);
      starts.set(sessionId, session?.startTime ?? null);
    }
    const start = starts.get(sessionId);
    if (!start) return 0;
    return Math.max(0, Math.floor((at.getTime() - Date.parse(start)) / 60000));
  }

  function arm(call: SimCall): void {
    if (!scheduleTimers) return;
    clearTimer(call.id);
    const at = now().getTime();
    let delay = 0;
    if (call.status === 'ringing') delay = Date.parse(call.ringDeadlineAt) - at;
    else if (call.status === 'connecting') delay = CONNECT_TIMEOUT_MS;
    else if (call.status === 'active') delay = (call.maxSeconds + ACTIVE_SWEEP_GRACE_SECONDS) * 1000;
    else return;
    const timer = setTimeout(() => {
      void sweep(call.sessionId);
    }, Math.max(0, delay));
    timer.unref?.();
    timers.set(call.id, timer);
  }

  async function lookupNames(ids: string[]): Promise<Record<string, string>> {
    if (deps.names) return deps.names(ids);
    return displayNames(ids);
  }

  function emit(userId: string, type: string, data: Record<string, unknown>): void {
    const event = { type, data, timestamp: now().toISOString() };
    if (deps.emit) deps.emit(userId, event);
    else {
      try {
        getWebSocketService().emitToUser(userId, event);
      } catch {
        /* websocket not initialised */
      }
    }
  }

  function emitBoth(call: SimCall, trainerId: string | null, type: string, data: Record<string, unknown>): void {
    if (call.answeredBy) emit(call.answeredBy, type, data);
    if (trainerId && trainerId !== call.answeredBy) emit(trainerId, type, data);
  }
}

function callKey(call: SimCall): string {
  return injectKeyOf({ id: call.injectId ?? call.id, delivery_config: { inject_key: call.script.inject_key } });
}

function fail(status: number, error: string): CallFailure {
  return { ok: false, status, error };
}

function clearTimer(callId: string): void {
  const timer = timers.get(callId);
  if (timer) clearTimeout(timer);
  timers.delete(callId);
}

function logFirstAudio(callId: string, ms: number): void {
  if (!Number.isFinite(ms) || ms < 0) return;
  logger.info({ event: 'call_answer_to_first_audio_ms', callId, ms: Math.round(ms) }, 'call first audio');
}

function canAccess(call: SimCall, actor: CallActor, trainerId?: string | null): boolean {
  if (actor.role === 'admin' || actor.role === 'trainer' || (trainerId && trainerId === actor.id)) return true;
  if (call.answeredBy === actor.id) return true;
  if (call.recipientUserIds == null) return true;
  if (call.recipientUserIds.includes(actor.id)) return true;
  return call.rungUserIds.includes(actor.id);
}

function callerKey(call: SimCall): string {
  return call.stakeholderId || call.callerNumber || call.callerName;
}

function counted(calls: SimCall[]): CountedAttempt[] {
  const answeredGroups = new Set(calls.filter((call) => call.status === 'ended').map((call) => call.callGroupId));
  const callbackParents = new Set(
    calls.filter((call) => call.direction === 'callback' && call.parentCallId).map((call) => call.parentCallId as string),
  );
  const calledBackGroups = new Set(
    calls.filter((call) => callbackParents.has(call.id)).map((call) => call.callGroupId),
  );
  return calls.map((call) => ({
    call_group_id: call.callGroupId,
    caller_key: callerKey(call),
    status: call.status,
    ring_started_at: call.ringStartedAt,
    addressed_to: call.recipientUserIds ?? [],
    group_answered: answeredGroups.has(call.callGroupId),
    group_called_back: calledBackGroups.has(call.callGroupId),
  }));
}

function toSummary(call: SimCall, all: SimCall[], names: Record<string, string>): CallSummary {
  const counts = counted(all);
  const group = all.filter((row) => row.callGroupId === call.callGroupId);
  const scheduled = group.find((row) => row.status === 'scheduled');
  const open = group.some((row) => row.status === 'ringing' || row.status === 'connecting' || row.status === 'active');
  const answered = group.some((row) => row.status === 'ended');
  const returnable = group.some((row) => row.status === 'missed' || row.status === 'declined' || row.status === 'cancelled');
  return {
    id: call.id,
    session_id: call.sessionId,
    inject_id: call.injectId,
    direction: call.direction,
    caller_name: call.callerName,
    caller_number: call.callerNumber,
    status: call.status,
    mode: call.mode,
    ring_deadline_at: call.ringDeadlineAt,
    answered_by: call.answeredBy,
    answered_by_name: call.answeredBy ? names[call.answeredBy] : undefined,
    started_at: call.ringStartedAt,
    ended_at: call.endedAt,
    duration_seconds: call.durationSeconds,
    end_reason: call.endReason,
    can_callback: !open && !answered && returnable && call.direction === 'inbound',
    call_group_id: call.callGroupId,
    attempt_no: call.attemptNo,
    max_attempts: call.maxAttempts,
    group_missed_count: groupMissedCount(counts, call.callGroupId),
    caller_missed_count: callerMissedCount(counts, callerKey(call)),
    next_attempt_at: scheduled?.scheduledFor ?? undefined,
    line_team: call.lineTeam,
    target_mode: call.targetMode,
    missed_reason: call.missedReason,
    opening: call.script.opening,
  };
}

function publicTurn(turn: StoredTurn) {
  return { seq: turn.seq, speaker: turn.speaker, text: turn.text, at: turn.at };
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function baseScript(script: ReturnType<typeof deriveCallScript>, redial: ReturnType<typeof parseRedial>, inject: PhoneInjectInput, ringSeconds: number, group: RingGroup): StoredScript {
  const config = inject.delivery_config ?? {};
  return {
    ...script,
    redial,
    inject_title: inject.title,
    inject_content: inject.content,
    requires_response: inject.requires_response === true,
    ring_seconds: ringSeconds,
    channel_type: typeof config.channel_type === 'string' ? config.channel_type : undefined,
    voicemail_posted_attempts: [],
    call_waiting: group.call_waiting,
        response_window_minutes:
      typeof config.response_window_minutes === 'number' ? config.response_window_minutes : null,
    inject_key: typeof config.inject_key === 'string' ? config.inject_key : undefined,
  };
}

function redialFields(script: StoredScript): Pick<StoredScript, 'inject_title' | 'inject_content' | 'requires_response' | 'ring_seconds' | 'channel_type' | 'voicemail_posted_attempts' | 'call_waiting' | 'response_window_minutes'> {
  return {
    inject_title: script.inject_title,
    inject_content: script.inject_content,
    requires_response: script.requires_response,
    ring_seconds: script.ring_seconds,
    channel_type: script.channel_type,
    voicemail_posted_attempts: [],
    call_waiting: [],
    response_window_minutes: script.response_window_minutes,
  };
}

function voicemailLines(call: SimCall, group: SimCall[], finished: boolean): Array<{ attemptNo: number; content: string }> {
  const missed = group.filter((row) => row.status === 'missed' || row.status === 'declined' || row.status === 'failed');
  if (missed.length === 0) return [];
  const opening = call.script.opening;
  const render = (count: number) =>
    missedCallMessage(
      { title: call.script.inject_title, content: call.script.inject_content, id: call.injectId },
      { from_name: call.callerName, from_number: call.callerNumber ?? undefined, stakeholder_id: call.stakeholderId ?? undefined },
      { count, opening },
    ).content;
  if (call.script.redial.voicemail_each) {
    return missed.map((row) => ({ attemptNo: row.attemptNo, content: render(1) }));
  }
  if (!finished) return [];
  return [{ attemptNo: missed[missed.length - 1].attemptNo, content: render(missed.length) }];
}

async function callbackPermitted(
  call: SimCall,
  userId: string,
): Promise<{ allowed: boolean; code?: string }> {
  if (!(await rolesFeatureReady())) return { allowed: true };
  const policy = await loadCallPolicy(call.sessionId);
  const roles = await rolePlayersById(call.sessionId);
  const holders = await holdersByTeam(call.sessionId);
  const team = call.lineTeam ?? call.recipientTeams[0] ?? '';
  const { supabaseAdmin } = await import('../../lib/supabaseAdmin.js');
  const { data } = team
    ? await supabaseAdmin
        .from('session_teams')
        .select('user_id')
        .eq('session_id', call.sessionId)
        .eq('team_name', team)
        .eq('user_id', userId)
        .limit(1)
    : { data: [] };
  const isRoleCall = call.targetMode === 'role' && Boolean(call.targetRoleId);
  return callbackAllowed({
    callbackBy: policy.callback_by,
    isTeamMember: (data ?? []).length > 0,
    isHolder: (holders[team] ?? []).includes(userId),
    isRoleCall,
    isRolePlayer: (roles.players[call.targetRoleId ?? ''] ?? []).includes(userId),
  });
}

function missedReasonFor(outcome: RingGroup['outcome']): string {
  if (outcome === 'line_busy' || outcome === 'line_unattended' || outcome === 'role_busy' || outcome === 'role_offline') {
    return outcome;
  }
  return 'no_answer';
}

function roleTitle(config: { target_role_id?: unknown }): string | undefined {
  return typeof config.target_role_id === 'string' ? config.target_role_id : undefined;
}

function blankCall(input: Omit<SimCall, 'direction' | 'stakeholderId' | 'mode' | 'declinedUserIds' | 'answeredBy' | 'answeredAt' | 'declinedBy' | 'openaiCallId' | 'transcriptSource' | 'beatsDone' | 'durationSeconds' | 'createdAt' | 'targetMode' | 'targetRoleId' | 'parentCallId'> & Partial<SimCall>): SimCall {
  return {
    direction: 'inbound',
    stakeholderId: null,
    parentCallId: null,
    mode: null,
    declinedUserIds: [],
    answeredBy: null,
    answeredAt: null,
    declinedBy: null,
    openaiCallId: null,
    transcriptSource: null,
    beatsDone: [],
    durationSeconds: null,
    createdAt: input.ringStartedAt,
    targetMode: 'ring_all',
    targetRoleId: null,
    ...input,
  };
}

async function defaultTextReply(instructions: string, history: string, playerText: string) {
  if (!env.aiEnabled) return null;
  const { chatJson } = await import('../ai/chatClient.js');
  const parsed = await chatJson<{ reply?: string; end_call?: boolean; beats_done?: string[] }>({
    tier: 'standard',
    label: 'sim_call_text',
    json: true,
    maxTokens: 400,
    messages: [
      { role: 'system', content: `${instructions}\nReply as JSON {"reply":"","end_call":false,"beats_done":[]}.` },
      { role: 'user', content: `${history}\nPLAYER: ${playerText}` },
    ],
  });
  if (!parsed || typeof parsed.reply !== 'string') return null;
  return { reply: parsed.reply, end_call: parsed.end_call === true, beats_done: parsed.beats_done ?? [] };
}

async function displayNames(ids: string[]): Promise<Record<string, string>> {
  if (ids.length === 0) return {};
  try {
    const { supabaseAdmin } = await import('../../lib/supabaseAdmin.js');
    const { data } = await supabaseAdmin.from('user_profiles').select('id, full_name').in('id', ids);
    const names: Record<string, string> = {};
    for (const row of data ?? []) {
      if (row.full_name) names[String(row.id)] = String(row.full_name);
    }
    return names;
  } catch {
    return {};
  }
}

export const callService = createCallService();

export async function startInjectCall(
  sessionId: string,
  inject: PhoneInjectInput,
  targeting: PhoneTargeting | null,
): Promise<'started' | 'unavailable'> {
  return callService.startInject(sessionId, inject, targeting);
}

export async function sweepCalls(sessionId: string): Promise<void> {
  if (env.simPhoneApp === 'off') return;
  await callService.sweep(sessionId);
}

export async function settleCallsForSession(sessionId: string): Promise<void> {
  await callService.settle(sessionId);
}

export async function resumeCallSidebands(): Promise<void> {
  if (env.simPhoneApp === 'off') return;
  await callService.resumeSidebands();
}
