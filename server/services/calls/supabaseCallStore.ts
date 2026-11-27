import { supabaseAdmin } from '../../lib/supabaseAdmin.js';
import { logger } from '../../lib/logger.js';
import {
  callErrorCode,
  isCallSchemaMissing,
  markCallTablesMissing,
  callTablesMissing,
} from './callSchema.js';
import type { CallStore, SimCall, StoredTurn } from './callTypes.js';
import type { CallScript, CallStatus } from './callCore.js';
import type { TargetMode } from './lineCore.js';

let extraColumns = true;
const otherWarned = new Set<string>();

function noteOther(err: unknown, where: string): void {
  if (isCallSchemaMissing(err)) {
    markCallTablesMissing();
    return;
  }
  const code = callErrorCode(err) ?? 'unknown';
  const key = `${where}:${code}`;
  if (otherWarned.has(key)) return;
  otherWarned.add(key);
  logger.warn({ err, code, where, event: 'sim_calls_error' }, 'Phone call query failed');
}

function unavailable(err: unknown, where: string): boolean {
  if (!err) return false;
  noteOther(err, where);
  return true;
}

export const supabaseCallStore: CallStore = {
  async ready() {
    if (callTablesMissing()) return false;
    const { error } = await supabaseAdmin.from('sim_calls').select('id').limit(1);
    if (!error) return true;
    unavailable(error, 'ready');
    return false;
  },
  async insert(call) {
    if (callTablesMissing()) return null;
    const payload = toRow(call);
    const first = await supabaseAdmin.from('sim_calls').insert(payload).select('*').maybeSingle();
    if (first.error?.code === '23505') {
      const existing = await findClash(call);
      return existing ? { call: existing, created: false } : null;
    }
    if (first.error && extraColumns && isMissingColumn(first.error)) {
      extraColumns = false;
      return supabaseCallStore.insert(call);
    }
    if (unavailable(first.error, 'insert') || !first.data) return null;
    return { call: fromRow(first.data as Record<string, unknown>, call), created: true };
  },
  async get(id) {
    if (callTablesMissing()) return null;
    const { data, error } = await supabaseAdmin.from('sim_calls').select('*').eq('id', id).maybeSingle();
    if (unavailable(error, 'get') || !data) return null;
    return fromRow(data as Record<string, unknown>);
  },
  async claimAnswer(id, userId, at) {
    if (callTablesMissing()) return null;
    const { data, error } = await supabaseAdmin
      .from('sim_calls')
      .update({ status: 'connecting', answered_by: userId, answered_at: at })
      .eq('id', id)
      .eq('status', 'ringing')
      .select('*')
      .maybeSingle();
    if (unavailable(error, 'claimAnswer')) return null;
    return data ? fromRow(data as Record<string, unknown>) : null;
  },
  async save(call) {
    if (callTablesMissing()) return;
    const payload = toRow(call);
    delete payload.id;
    delete payload.created_at;
    const first = await supabaseAdmin.from('sim_calls').update(payload).eq('id', call.id);
    if (first.error && extraColumns && isMissingColumn(first.error)) {
      extraColumns = false;
      await supabaseCallStore.save(call);
      return;
    }
    unavailable(first.error, 'save');
  },
  async listSession(sessionId) {
    if (callTablesMissing()) return [];
    const { data, error } = await supabaseAdmin
      .from('sim_calls')
      .select('*')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: false })
      .limit(500);
    if (unavailable(error, 'listSession')) return [];
    return (data ?? []).map((row) => fromRow(row as Record<string, unknown>));
  },
  async listOpen(sessionId) {
    if (callTablesMissing()) return [];
    const { data, error } = await supabaseAdmin
      .from('sim_calls')
      .select('*')
      .eq('session_id', sessionId)
      .in('status', ['scheduled', 'ringing', 'connecting', 'active']);
    if (unavailable(error, 'listOpen')) return [];
    return (data ?? []).map((row) => fromRow(row as Record<string, unknown>));
  },
  async listActiveSideband() {
    if (callTablesMissing()) return [];
    const { data, error } = await supabaseAdmin
      .from('sim_calls')
      .select('*')
      .eq('status', 'active')
      .eq('transcript_source', 'sideband');
    if (unavailable(error, 'listActiveSideband')) return [];
    return (data ?? []).map((row) => fromRow(row as Record<string, unknown>));
  },
  async activeCount(sessionId) {
    const open = await supabaseCallStore.listOpen(sessionId);
    return open.filter((call) => call.status === 'connecting' || call.status === 'active').length;
  },
  async durationSeconds(sessionId) {
    if (callTablesMissing()) return 0;
    const { data, error } = await supabaseAdmin
      .from('sim_calls')
      .select('duration_seconds')
      .eq('session_id', sessionId);
    if (unavailable(error, 'durationSeconds')) return 0;
    return (data ?? []).reduce((sum, row) => sum + (Number(row.duration_seconds) || 0), 0);
  },
  async userBusy(sessionId, userId, exceptCallId) {
    if (callTablesMissing()) return false;
    let query = supabaseAdmin
      .from('sim_calls')
      .select('id')
      .eq('session_id', sessionId)
      .eq('answered_by', userId)
      .in('status', ['connecting', 'active']);
    if (exceptCallId) query = query.neq('id', exceptCallId);
    const { data, error } = await query.limit(1);
    if (unavailable(error, 'userBusy')) return false;
    return (data ?? []).length > 0;
  },
  async appendTurns(next) {
    if (callTablesMissing() || next.length === 0) return;
    const rows = next.map((turn) => ({
      id: turn.id,
      call_id: turn.callId,
      session_id: turn.sessionId,
      seq: turn.seq,
      speaker: turn.speaker,
      user_id: turn.userId,
      text: turn.text,
      source: turn.source,
      at: turn.at,
    }));
    const { error } = await supabaseAdmin.from('sim_call_turns').upsert(rows, {
      onConflict: 'call_id,seq',
      ignoreDuplicates: true,
    });
    unavailable(error, 'appendTurns');
  },
  async turns(callId) {
    if (callTablesMissing()) return [];
    const { data, error } = await supabaseAdmin
      .from('sim_call_turns')
      .select('*')
      .eq('call_id', callId)
      .order('seq', { ascending: true });
    if (unavailable(error, 'turns')) return [];
    return (data ?? []).map((row) => fromTurn(row as Record<string, unknown>));
  },
  async recentsViewedAt(sessionId, userId) {
    if (callTablesMissing()) return null;
    const { data, error } = await supabaseAdmin
      .from('sim_call_recents_views')
      .select('last_viewed_at')
      .eq('session_id', sessionId)
      .eq('user_id', userId)
      .maybeSingle();
    if (unavailable(error, 'recentsViewedAt')) return null;
    return (data?.last_viewed_at as string | undefined) ?? null;
  },
  async setRecentsViewed(sessionId, userId, at) {
    if (callTablesMissing()) return;
    const { error } = await supabaseAdmin.from('sim_call_recents_views').upsert(
      { session_id: sessionId, user_id: userId, last_viewed_at: at },
      { onConflict: 'session_id,user_id' },
    );
    unavailable(error, 'setRecentsViewed');
  },
  async playerContactedStakeholder(sessionId, stakeholderId, afterIso) {
    const { data, error } = await supabaseAdmin
      .from('stakeholder_conversations')
      .select('id')
      .eq('session_id', sessionId)
      .eq('stakeholder_id', stakeholderId)
      .eq('direction', 'player')
      .gt('created_at', afterIso)
      .limit(1);
    if (error) return false;
    return (data ?? []).length > 0;
  },
  async session(sessionId) {
    const { data, error } = await supabaseAdmin
      .from('sessions')
      .select('status, trainer_id, start_time, scenario_id')
      .eq('id', sessionId)
      .maybeSingle();
    if (error || !data) return null;
    return {
      status: String(data.status),
      trainerId: (data.trainer_id as string | null) ?? null,
      startTime: (data.start_time as string | null) ?? null,
      scenarioId: (data.scenario_id as string | null) ?? null,
    };
  },
  async teamMembers(sessionId, teamNames) {
    if (teamNames.length === 0) return {};
    const { data, error } = await supabaseAdmin
      .from('session_teams')
      .select('team_name, user_id')
      .eq('session_id', sessionId)
      .in('team_name', teamNames);
    if (error || !data) return {};
    const userIds = Array.from(new Set(data.map((row) => String(row.user_id)).filter(Boolean)));
    const bots = new Set<string>();
    if (userIds.length > 0) {
      const { data: profiles } = await supabaseAdmin
        .from('user_profiles')
        .select('id, is_bot')
        .in('id', userIds);
      for (const profile of profiles ?? []) {
        if (profile.is_bot === true) bots.add(String(profile.id));
      }
    }
    const grouped: Record<string, Array<{ user_id: string; is_bot: boolean }>> = {};
    for (const row of data) {
      const userId = String(row.user_id);
      const team = String(row.team_name);
      (grouped[team] ??= []).push({ user_id: userId, is_bot: bots.has(userId) });
    }
    return grouped;
  },
  async participantIds(sessionId) {
    const { data, error } = await supabaseAdmin
      .from('session_participants')
      .select('user_id')
      .eq('session_id', sessionId);
    if (error || !data) return [];
    return data.map((row) => String(row.user_id)).filter(Boolean);
  },
};

function isMissingColumn(err: { code?: string }): boolean {
  return err.code === '42703' || err.code === 'PGRST204';
}

async function findClash(call: SimCall): Promise<SimCall | null> {
  const { data, error } = await supabaseAdmin
    .from('sim_calls')
    .select('*')
    .eq('session_id', call.sessionId)
    .eq('call_group_id', call.callGroupId)
    .eq('attempt_no', call.attemptNo)
    .maybeSingle();
  if (!error && data) return fromRow(data as Record<string, unknown>, call);
  if (call.injectId && call.attemptNo === 1 && call.direction === 'inbound') {
    const team = call.recipientTeams[0] ?? '';
    const { data: rows } = await supabaseAdmin
      .from('sim_calls')
      .select('*')
      .eq('session_id', call.sessionId)
      .eq('inject_id', call.injectId)
      .eq('attempt_no', 1)
      .eq('direction', 'inbound');
    const match = (rows ?? []).find(
      (row) => ((row.recipient_teams as string[] | null)?.[0] ?? '') === team,
    );
    if (match) return fromRow(match as Record<string, unknown>, call);
  }
  return null;
}

function toRow(call: SimCall): Record<string, unknown> {
  const row: Record<string, unknown> = {
    id: call.id,
    session_id: call.sessionId,
    inject_id: call.injectId,
    parent_call_id: call.parentCallId,
    direction: call.direction,
    stakeholder_id: call.stakeholderId,
    caller_name: call.callerName,
    caller_number: call.callerNumber,
    voice: call.voice,
    script: call.script,
    recipient_user_ids: call.recipientUserIds,
    recipient_teams: call.recipientTeams,
    status: call.status,
    mode: call.mode,
    call_group_id: call.callGroupId,
    attempt_no: call.attemptNo,
    max_attempts: call.maxAttempts,
    scheduled_for: call.scheduledFor,
    declined_user_ids: call.declinedUserIds,
    ring_started_at: call.ringStartedAt,
    ring_deadline_at: call.ringDeadlineAt,
    answered_by: call.answeredBy,
    answered_at: call.answeredAt,
    declined_by: call.declinedBy,
    ended_at: call.endedAt,
    end_reason: call.endReason,
    max_seconds: call.maxSeconds,
    openai_call_id: call.openaiCallId,
    transcript_source: call.transcriptSource,
    beats_done: call.beatsDone,
    duration_seconds: call.durationSeconds,
    created_at: call.createdAt,
  };
  if (extraColumns) {
    row.line_team = call.lineTeam;
    row.target_mode = call.targetMode;
    row.target_role_id = call.targetRoleId;
    row.rung_user_ids = call.rungUserIds;
    row.missed_reason = call.missedReason;
  }
  return row;
}

function fromRow(row: Record<string, unknown>, fallback?: SimCall): SimCall {
  const script = (row.script as CallScript | null) ?? fallback?.script;
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    injectId: (row.inject_id as string | null) ?? null,
    parentCallId: (row.parent_call_id as string | null) ?? null,
    direction: row.direction === 'callback' ? 'callback' : 'inbound',
    stakeholderId: (row.stakeholder_id as string | null) ?? null,
    callerName: String(row.caller_name ?? 'Unknown caller'),
    callerNumber: (row.caller_number as string | null) ?? null,
    voice: String(row.voice ?? 'marin'),
    script: normalizeScript(script, fallback),
    recipientUserIds: (row.recipient_user_ids as string[] | null) ?? null,
    recipientTeams: (row.recipient_teams as string[] | null) ?? [],
    status: String(row.status) as CallStatus,
    mode: row.mode === 'voice' || row.mode === 'text' ? row.mode : null,
    callGroupId: String(row.call_group_id),
    attemptNo: Number(row.attempt_no ?? 1),
    maxAttempts: Number(row.max_attempts ?? 1),
    scheduledFor: (row.scheduled_for as string | null) ?? null,
    declinedUserIds: (row.declined_user_ids as string[] | null) ?? [],
    ringStartedAt: String(row.ring_started_at),
    ringDeadlineAt: String(row.ring_deadline_at),
    answeredBy: (row.answered_by as string | null) ?? null,
    answeredAt: (row.answered_at as string | null) ?? null,
    declinedBy: (row.declined_by as string | null) ?? null,
    endedAt: (row.ended_at as string | null) ?? null,
    endReason: (row.end_reason as string | null) ?? null,
    maxSeconds: Number(row.max_seconds ?? 300),
    openaiCallId: (row.openai_call_id as string | null) ?? null,
    transcriptSource:
      row.transcript_source === 'sideband' ||
      row.transcript_source === 'client' ||
      row.transcript_source === 'text'
        ? row.transcript_source
        : null,
    beatsDone: (row.beats_done as string[] | null) ?? [],
    durationSeconds: row.duration_seconds == null ? null : Number(row.duration_seconds),
    createdAt: String(row.created_at),
    lineTeam: (row.line_team as string | null) ?? fallback?.lineTeam ?? null,
    targetMode: (row.target_mode as TargetMode | undefined) ?? fallback?.targetMode ?? 'ring_all',
    targetRoleId: (row.target_role_id as string | null) ?? fallback?.targetRoleId ?? null,
    rungUserIds: (row.rung_user_ids as string[] | null) ?? fallback?.rungUserIds ?? [],
    missedReason: (row.missed_reason as string | null) ?? fallback?.missedReason ?? null,
  };
}

function normalizeScript(script: CallScript | null | undefined, fallback?: SimCall): SimCall['script'] {
  const base = (script ?? fallback?.script) as SimCall['script'] | undefined;
  return {
    opening: base?.opening ?? '',
    beats: base?.beats ?? [],
    closing: base?.closing ?? 'Please call me back when you can.',
    language: base?.language ?? 'en',
    redial_openings: base?.redial_openings,
    redial: base?.redial ?? { attempts: 1, interval_minutes: 2, voicemail_each: false, stop_on_contact: true },
    inject_title: base?.inject_title ?? '',
    inject_content: base?.inject_content ?? '',
    requires_response: base?.requires_response === true,
    ring_seconds: base?.ring_seconds ?? 30,
    channel_type: base?.channel_type,
    voicemail_posted_attempts: base?.voicemail_posted_attempts ?? [],
    queue_hold: base?.queue_hold,
    call_waiting: base?.call_waiting ?? [],
    silence_prompted: base?.silence_prompted,
    response_window_minutes: base?.response_window_minutes ?? null,
  };
}

function fromTurn(row: Record<string, unknown>): StoredTurn {
  return {
    id: String(row.id),
    callId: String(row.call_id),
    sessionId: String(row.session_id),
    seq: Number(row.seq),
    speaker: row.speaker === 'player' || row.speaker === 'system' ? row.speaker : 'npc',
    userId: (row.user_id as string | null) ?? null,
    text: String(row.text ?? ''),
    source: row.source === 'client' || row.source === 'text' ? row.source : 'sideband',
    at: String(row.at),
  };
}
