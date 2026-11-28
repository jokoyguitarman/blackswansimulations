/**
 * Persists mood rows and fires each consequence at most once.
 * A missing `stakeholder_moods` table leaves wording on the computed ladder and fires nothing.
 */

import type { Server as SocketServer } from 'socket.io';
import { supabaseAdmin } from '../../lib/supabaseAdmin.js';
import { activeTemplateInjects } from '../../lib/templateRows.js';
import { logger } from '../../lib/logger.js';
import { env } from '../../env.js';
import { sessionMinuteAt, type CommsDelivery, type CommsState } from '../ledger/injectLedgerCore.js';
import { loadCommsState } from '../ledger/injectLedgerService.js';
import { getSessionScenarioId } from '../../lib/scenarioCache.js';
import { inBootGrace, sessionUserOnline } from '../presence/sessionPresenceService.js';
import { rolePlayersById } from '../roles/roleService.js';
import { createNotificationsForUsers } from '../notificationService.js';
import { getWebSocketService } from '../websocketService.js';
import {
  activeRungs,
  buildMoodBlock,
  computeWaitProfile,
  consequencesToFire,
  defaultLadderFor,
  extendHeldIntervals,
  holdSnapshot,
  isBaseRung,
  type HoldSnapshot,
  ladderFromUnknown,
  mergeLadders,
  moodLineFor,
  moodScopeForDelivery,
  moodStopKey,
  renderMoodPlaceholders,
  resolveGaveUpAfter,
  selectRung,
  validateMoodLadder,
  type HeldInterval,
  type MoodConsequence,
  type MoodDeliveryFact,
  type MoodIssue,
  type MoodLadder,
  type MoodRung,
  type WaitProfile,
} from './moodCore.js';

const SCHEMA_CODES = new Set(['42P01', '42703', 'PGRST204', 'PGRST205']);
const PERSUASION_RANK = ['none', 'low', 'medium', 'high'];

let tablesMissing = false;
let warned = false;
let inMoodWrite = false;

export interface MoodLocks {
  verdict?: 'keep';
  verdict_rung?: string;
  persuadability?: string;
  grievance_append?: string[];
  stop_chains?: boolean;
  pending_recovery_steps?: number;
}

interface MoodRow {
  rung_id: string;
  episode_anchor_minute: number | null;
  entered_minute: number;
  profile: WaitProfile & {
    held_intervals?: HeldInterval[];
    terminal?: boolean;
    ladder_ids?: string[];
    hold_profile?: HoldSnapshot | null;
  };
  history: Array<{ rung: string; minute: number; reason: string }>;
  consequences_fired: string[];
  locks: MoodLocks;
}

export interface MoodSnapshot {
  stakeholder_id: string;
  scope_team: string;
  rung_id: string;
  rung_index: number;
  ladder_ids: string[];
  history: Array<{ rung: string; minute?: number; reason?: string }>;
  terminal: boolean;
  locks: MoodLocks;
}

export interface MoodNow {
  rung: MoodRung;
  ladder: MoodLadder;
  profile: WaitProfile;
  scope: string;
  isBase: boolean;
  opening: string | null;
  block: string | null;
}

export function moodTablesMissing(): boolean {
  return tablesMissing;
}

function errorCode(err: unknown): string | null {
  if (!err || typeof err !== 'object') return null;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

function schemaMissing(err: unknown): boolean {
  const code = errorCode(err);
  return code != null && (SCHEMA_CODES.has(code) || code === 'PGRST202' || code === '42883');
}

function noteUnavailable(): void {
  tablesMissing = true;
  if (warned) return;
  warned = true;
  logger.warn(
    { event: 'stakeholder_moods_unavailable' },
    'Stakeholder moods are off because migration 273 is not applied',
  );
}

function deliveriesOf(state: CommsState | null): MoodDeliveryFact[] {
  const seen = new Set<string>();
  const rows: MoodDeliveryFact[] = [];
  for (const list of Object.values(state?.by_key ?? {})) {
    for (const delivery of list) {
      if (seen.has(delivery.delivery_id)) continue;
      seen.add(delivery.delivery_id);
      rows.push(toFact(delivery));
    }
  }
  return rows;
}

function toFact(delivery: CommsDelivery): MoodDeliveryFact {
  return {
    delivery_id: delivery.delivery_id,
    stakeholder_id: delivery.stakeholder_id,
    channel: delivery.channel,
    delivered_minute: delivery.delivered_minute,
    call_state: delivery.call_state,
    chain_step: delivery.chain_step,
    target_role_id: delivery.target_role_id,
    line_team: delivery.line_team,
    recipient_teams: delivery.recipient_teams,
    missed_reason: delivery.missed_reason,
    fallback_reason: delivery.fallback_reason,
    responses: delivery.responses.map((response) => ({
      minute: response.minute,
      team: response.team,
      user_id: response.user_id,
      judgement_status: response.judgement_status,
      judgement: response.judgement,
      id: response.id,
    })),
  };
}

function scopeFromParts(input: {
  targetRoleId?: string | null;
  lineTeam?: string | null;
  recipientTeams?: string[] | null;
}): string {
  return moodScopeForDelivery({
    delivery_id: '',
    stakeholder_id: null,
    channel: 'email',
    delivered_minute: 0,
    target_role_id: input.targetRoleId,
    line_team: input.lineTeam,
    recipient_teams: input.recipientTeams ?? [],
  });
}

async function sessionFacts(sessionId: string): Promise<{
  startTime: string | null;
  scenarioId: string | null;
  trainerId: string | null;
}> {
  const { data } = await supabaseAdmin
    .from('sessions')
    .select('start_time, scenario_id, trainer_id')
    .eq('id', sessionId)
    .maybeSingle();
  return {
    startTime: (data?.start_time as string | null) ?? null,
    scenarioId: (data?.scenario_id as string | null) ?? null,
    trainerId: (data?.trainer_id as string | null) ?? null,
  };
}

async function loadStakeholderLadder(
  scenarioId: string | null,
  stakeholderId: string,
  injectLadder: unknown,
): Promise<{ ladder: MoodLadder; name: string }> {
  if (!scenarioId) {
    const base = defaultLadderFor(null);
    return { ladder: injectLadder ? mergeLadders(base, injectLadder) : base, name: stakeholderId };
  }
  try {
    const { findById } = await import('../stakeholderService.js');
    const stakeholder = await findById(scenarioId, stakeholderId);
    const authored = (stakeholder as { mood_ladder?: unknown } | null)?.mood_ladder;
    const base = ladderFromUnknown(authored, stakeholder?.persuadability);
    return {
      ladder: injectLadder ? mergeLadders(base, injectLadder) : base,
      name: stakeholder?.name || stakeholderId,
    };
  } catch {
    const base = defaultLadderFor(null);
    return { ladder: injectLadder ? mergeLadders(base, injectLadder) : base, name: stakeholderId };
  }
}

async function readRow(sessionId: string, stakeholderId: string, scope: string): Promise<MoodRow | null> {
  if (tablesMissing) return null;
  const { data, error } = await supabaseAdmin
    .from('stakeholder_moods')
    .select('rung_id, episode_anchor_minute, entered_minute, profile, history, consequences_fired, locks')
    .eq('session_id', sessionId)
    .eq('stakeholder_id', stakeholderId)
    .eq('scope_team', scope)
    .maybeSingle();
  if (error) {
    if (schemaMissing(error)) noteUnavailable();
    else logger.warn({ err: error, sessionId, stakeholderId }, 'mood row was not read');
    return null;
  }
  if (!data) return null;
  return {
    rung_id: String(data.rung_id),
    episode_anchor_minute: (data.episode_anchor_minute as number | null) ?? null,
    entered_minute: Number(data.entered_minute ?? 0),
    profile: (data.profile ?? {}) as MoodRow['profile'],
    history: Array.isArray(data.history) ? (data.history as MoodRow['history']) : [],
    consequences_fired: Array.isArray(data.consequences_fired) ? (data.consequences_fired as string[]) : [],
    locks: (data.locks ?? {}) as MoodLocks,
  };
}

async function heldForRole(sessionId: string, scope: string, minute: number, stored: HeldInterval[]): Promise<HeldInterval[]> {
  if (!scope.startsWith('role:')) return stored;
  if (!env.runBackgroundEngines || inBootGrace()) return stored;
  try {
    const roleId = scope.slice('role:'.length);
    const roles = await rolePlayersById(sessionId);
    const players = roles.players[roleId] ?? [];
    if (players.length === 0) return stored;
    const offline = players.every((userId) => !sessionUserOnline(sessionId, userId));
    return extendHeldIntervals(stored, offline, minute);
  } catch {
    return stored;
  }
}

function snapshotOf(ladder: MoodLadder, rung: MoodRung, profile: WaitProfile, name: string): MoodNow {
  const base = isBaseRung(ladder, rung.id);
  const opening = rung.script.opening ? renderMoodPlaceholders(rung.script.opening, profile) : null;
  const block = base
    ? null
    : buildMoodBlock(rung, profile, { name }, { includeScript: true, recovery: ladder.recovery, channel: 'call' });
  return { rung, ladder, profile, scope: '', isBase: base, opening: base ? null : opening, block };
}

export async function getMoodNow(input: {
  sessionId: string;
  stakeholderId: string;
  scope: string;
  atMinute?: number;
  injectLadder?: unknown;
  rolePlayerIds?: readonly string[];
  comms?: CommsState | null;
  persist?: boolean;
}): Promise<MoodNow | null> {
  if (!input.stakeholderId) return null;
  try {
    const session = await sessionFacts(input.sessionId);
    const atMinute =
      input.atMinute ??
      sessionMinuteAt(session.startTime, new Date().toISOString());
    const scenarioId = session.scenarioId ?? (await getSessionScenarioId(input.sessionId));
    const { ladder, name } = await loadStakeholderLadder(scenarioId, input.stakeholderId, input.injectLadder);
    const comms = input.comms === undefined ? await loadCommsState(input.sessionId, atMinute) : input.comms;
    const stored = await readRow(input.sessionId, input.stakeholderId, input.scope);
    const held = await heldForRole(
      input.sessionId,
      input.scope,
      atMinute,
      stored?.profile.held_intervals ?? [],
    );
    const profile = computeWaitProfile({
      stakeholderId: input.stakeholderId,
      scope: input.scope,
      atMinute,
      deliveries: deliveriesOf(comms),
      gaveUpAfter: resolveGaveUpAfter(ladder, env.callbackWindowMinutes),
      rolePlayerIds: input.rolePlayerIds,
      heldIntervals: held,
    });
    const selection = selectRung(ladder, profile, {
      rungId: stored?.rung_id ?? null,
      pendingRecoverySteps: stored?.locks.pending_recovery_steps ?? 0,
      baseline: stored?.profile.hold_profile ?? null,
    });
    const now = snapshotOf(ladder, selection.rung, profile, name);
    now.scope = input.scope;
    if (input.persist !== false) {
      await persistSelection({
        sessionId: input.sessionId,
        scenarioId,
        trainerId: session.trainerId,
        stakeholderId: input.stakeholderId,
        stakeholderName: name,
        scope: input.scope,
        ladder,
        selectionRung: selection.rung,
        selectionReason: selection.reason,
        selectionHold: selection.hold,
        selectionClearHold: selection.clearHold,
        profile,
        held,
        stored,
        atMinute,
      });
    }
    return now;
  } catch (err) {
    if (schemaMissing(err)) noteUnavailable();
    else logger.warn({ err, sessionId: input.sessionId }, 'mood was not computed');
    return null;
  }
}

async function persistSelection(input: {
  sessionId: string;
  scenarioId: string | null;
  trainerId: string | null;
  stakeholderId: string;
  stakeholderName: string;
  scope: string;
  ladder: MoodLadder;
  selectionRung: MoodRung;
  selectionReason: string;
  selectionHold: boolean;
  selectionClearHold: boolean;
  profile: WaitProfile;
  held: HeldInterval[];
  stored: MoodRow | null;
  atMinute: number;
}): Promise<void> {
  if (tablesMissing || inMoodWrite) return;
  const entered = !input.stored || input.stored.rung_id !== input.selectionRung.id;
  const pending = input.stored?.locks.pending_recovery_steps ?? 0;
  const history = [...(input.stored?.history ?? [])];
  if (entered) {
    history.push({
      rung: input.selectionRung.id,
      minute: input.atMinute,
      reason: input.selectionReason,
    });
  }
  const due = consequencesToFire(input.selectionRung, input.stored?.consequences_fired ?? []);
  const heldChanged =
    JSON.stringify(input.held) !== JSON.stringify(input.stored?.profile.held_intervals ?? []);
  const holdProfile = input.selectionHold
    ? holdSnapshot(input.profile)
    : input.selectionClearHold
      ? null
      : (input.stored?.profile.hold_profile ?? null);
  if (!entered && due.length === 0 && !heldChanged && pending === 0 && !input.selectionHold && !input.selectionClearHold) return;

  inMoodWrite = true;
  try {
    const saved = await saveMoodFacts({
      sessionId: input.sessionId,
      stakeholderId: input.stakeholderId,
      scope: input.scope,
      rungId: input.selectionRung.id,
      episodeAnchor: input.profile.episode_anchor_minute,
      enteredMinute: entered ? input.atMinute : (input.stored?.entered_minute ?? input.atMinute),
      profile: {
        ...input.profile,
        held_intervals: input.held,
        terminal: input.selectionRung.terminal === true,
        ladder_ids: activeRungs(input.ladder).map((item) => item.id),
        hold_profile: holdProfile,
      },
      history,
    });
    if (!saved) return;
    if (pending > 0) await consumeRecovery(input.sessionId, input.stakeholderId, input.scope);
    if (entered) {
      emitTrainer(input.trainerId, 'stakeholder_mood.changed', {
        stakeholder_id: input.stakeholderId,
        scope_team: input.scope,
        from: input.stored?.rung_id ?? null,
        to: input.selectionRung.id,
        label: input.selectionRung.label,
        minute: input.atMinute,
        profile: input.profile,
      });
    }
    for (const item of due) {
      await fireConsequence(input, item.id, item.consequence);
    }
  } finally {
    inMoodWrite = false;
  }
}

async function fireConsequence(
  input: {
    sessionId: string;
    scenarioId: string | null;
    trainerId: string | null;
    stakeholderId: string;
    stakeholderName: string;
    scope: string;
    selectionRung: MoodRung;
    profile: WaitProfile;
    atMinute: number;
  },
  id: string,
  consequence: MoodConsequence,
): Promise<void> {
  const patch = consequence.type === 'publish_inject' ? {} : lockPatch(consequence, input.selectionRung.id);
  const claimed = await claim(input, id, patch);
  if (!claimed) return;
  if (consequence.type === 'publish_inject') {
    const published = await publishConditional(input, consequence.inject_key);
    if (!published) await releaseClaim(input, id);
    return;
  }
  if (consequence.type === 'stop_chains') {
    const { stopChainsForMood } = await import('../escalation/escalationService.js');
    await stopChainsForMood({
      sessionId: input.sessionId,
      stakeholderId: input.stakeholderId,
      scope: input.scope,
      minute: input.atMinute,
      trainerId: input.trainerId,
    });
  }
  if (consequence.type === 'notify_trainer') {
    const message =
      consequence.message?.trim() ||
      `${input.stakeholderName} is now ${input.selectionRung.label} (waited ${input.profile.wait_minutes} min, ${input.profile.missed_calls} missed calls)`;
    await notifyTrainer(input.trainerId, input.sessionId, input.stakeholderName, message);
  }
}

function lockPatch(consequence: MoodConsequence, rungId: string): MoodLocks {
  if (consequence.type === 'verdict_lock') return { verdict: 'keep', verdict_rung: rungId };
  if (consequence.type === 'persuadability') return { persuadability: consequence.value };
  if (consequence.type === 'grievance_append') return { grievance_append: [consequence.text] };
  if (consequence.type === 'stop_chains') return { stop_chains: true };
  return {};
}

async function saveMoodFacts(input: {
  sessionId: string;
  stakeholderId: string;
  scope: string;
  rungId: string;
  episodeAnchor: number | null;
  enteredMinute: number;
  profile: MoodRow['profile'];
  history: MoodRow['history'];
}): Promise<boolean> {
  const facts = {
    rung_id: input.rungId,
    episode_anchor_minute: input.episodeAnchor,
    entered_minute: input.enteredMinute,
    profile: input.profile,
    history: input.history,
    updated_at: new Date().toISOString(),
  };
  const updated = await supabaseAdmin
    .from('stakeholder_moods')
    .update(facts)
    .eq('session_id', input.sessionId)
    .eq('stakeholder_id', input.stakeholderId)
    .eq('scope_team', input.scope)
    .select('stakeholder_id');
  if (updated.error) {
    if (schemaMissing(updated.error)) noteUnavailable();
    else logger.warn({ err: updated.error, sessionId: input.sessionId }, 'mood row was not saved');
    return false;
  }
  if ((updated.data?.length ?? 0) > 0) return true;
  const inserted = await supabaseAdmin.from('stakeholder_moods').insert({
    session_id: input.sessionId,
    stakeholder_id: input.stakeholderId,
    scope_team: input.scope,
    ...facts,
    consequences_fired: [],
    locks: {},
  });
  if (inserted.error?.code === '23505') {
    const retry = await supabaseAdmin
      .from('stakeholder_moods')
      .update(facts)
      .eq('session_id', input.sessionId)
      .eq('stakeholder_id', input.stakeholderId)
      .eq('scope_team', input.scope);
    if (retry.error && schemaMissing(retry.error)) noteUnavailable();
    return !retry.error;
  }
  if (inserted.error) {
    if (schemaMissing(inserted.error)) noteUnavailable();
    else logger.warn({ err: inserted.error, sessionId: input.sessionId }, 'mood row was not saved');
    return false;
  }
  return true;
}

async function claim(
  input: { sessionId: string; stakeholderId: string; scope: string },
  id: string,
  patch: MoodLocks,
): Promise<boolean> {
  if (tablesMissing) return false;
  const { data, error } = await supabaseAdmin.rpc('claim_mood_consequence', {
    p_session_id: input.sessionId,
    p_stakeholder_id: input.stakeholderId,
    p_scope_team: input.scope,
    p_consequence_id: id,
    p_patch: patch,
  });
  if (error) {
    if (schemaMissing(error)) noteUnavailable();
    else logger.warn({ err: error, id }, 'mood consequence was not claimed');
    return false;
  }
  return data === true;
}

async function releaseClaim(
  input: { sessionId: string; stakeholderId: string; scope: string },
  id: string,
): Promise<void> {
  const { error } = await supabaseAdmin.rpc('release_mood_consequence', {
    p_session_id: input.sessionId,
    p_stakeholder_id: input.stakeholderId,
    p_scope_team: input.scope,
    p_consequence_id: id,
  });
  if (error && schemaMissing(error)) noteUnavailable();
  else if (error) logger.warn({ err: error, id }, 'mood publish claim was not released');
}

async function consumeRecovery(sessionId: string, stakeholderId: string, scope: string): Promise<void> {
  const { error } = await supabaseAdmin.rpc('consume_mood_recovery', {
    p_session_id: sessionId,
    p_stakeholder_id: stakeholderId,
    p_scope_team: scope,
  });
  if (error && schemaMissing(error)) noteUnavailable();
}

async function publishConditional(
  input: { sessionId: string; scenarioId: string | null; trainerId: string | null },
  key: string,
): Promise<boolean> {
  if (!input.scenarioId) return false;
  const { data, error } = await activeTemplateInjects(
    supabaseAdmin
      .from('scenario_injects')
      .select('id, trigger_time_minutes')
      .eq('scenario_id', input.scenarioId)
      .is('session_id', null)
      .eq('delivery_config->>inject_key', key)
      .limit(1)
      .maybeSingle(),
  );
  if (error || !data || data.trigger_time_minutes != null) return false;
  try {
    const { publishInjectToSession } = await import('../../routes/injects.js');
    const { io } = await import('../../index.js');
    await publishInjectToSession(
      String(data.id),
      input.sessionId,
      input.trainerId ?? String(data.id),
      io as SocketServer,
    );
    return true;
  } catch (err) {
    logger.warn({ err, sessionId: input.sessionId, key }, 'mood publish_inject failed');
    return false;
  }
}

async function notifyTrainer(
  trainerId: string | null,
  sessionId: string,
  name: string,
  message: string,
): Promise<void> {
  emitTrainer(trainerId, 'stakeholder_mood.notice', { message });
  if (!trainerId) return;
  await createNotificationsForUsers([trainerId], {
    sessionId,
    type: 'system_alert',
    title: `${name} changed mood`,
    message,
    priority: 'high',
    metadata: { source: 'stakeholder_mood' },
  }).catch(() => undefined);
}

function emitTrainer(trainerId: string | null, type: string, data: Record<string, unknown>): void {
  if (!trainerId) return;
  try {
    getWebSocketService().emitToUser(trainerId, { type, data, timestamp: new Date().toISOString() });
  } catch {
    /* websocket is optional in tests */
  }
}

export async function updateMoods(input: {
  sessionId: string;
  elapsedMinutes: number;
  comms: CommsState | null;
}): Promise<void> {
  if (tablesMissing) return;
  try {
    const probe = await supabaseAdmin.from('stakeholder_moods').select('stakeholder_id').limit(1);
    if (probe.error) {
      if (schemaMissing(probe.error)) noteUnavailable();
      return;
    }
    const scopes = new Map<string, { stakeholderId: string; scope: string }>();
    for (const fact of deliveriesOf(input.comms)) {
      const stakeholderId = fact.stakeholder_id || fact.step_stakeholder_id;
      if (!stakeholderId) continue;
      const scope = moodScopeForDelivery(fact);
      scopes.set(`${stakeholderId}|${scope}`, { stakeholderId, scope });
    }
    const { data: existing } = await supabaseAdmin
      .from('stakeholder_moods')
      .select('stakeholder_id, scope_team')
      .eq('session_id', input.sessionId);
    for (const row of existing ?? []) {
      const stakeholderId = String(row.stakeholder_id);
      const scope = String(row.scope_team ?? '');
      scopes.set(`${stakeholderId}|${scope}`, { stakeholderId, scope });
    }
    for (const item of scopes.values()) {
      await getMoodNow({
        sessionId: input.sessionId,
        stakeholderId: item.stakeholderId,
        scope: item.scope,
        atMinute: input.elapsedMinutes,
        comms: input.comms,
        persist: true,
      });
    }
  } catch (err) {
    if (schemaMissing(err)) noteUnavailable();
    else logger.warn({ err, sessionId: input.sessionId }, 'mood tick failed');
  }
}

export async function loadMoodIndex(sessionId: string): Promise<{
  moods?: MoodSnapshot[];
  mood_stops?: Record<string, { stop_chains?: boolean }>;
}> {
  if (tablesMissing) return {};
  const { data, error } = await supabaseAdmin
    .from('stakeholder_moods')
    .select('stakeholder_id, scope_team, rung_id, history, locks, profile')
    .eq('session_id', sessionId);
  if (error) {
    if (schemaMissing(error)) noteUnavailable();
    return {};
  }
  const moods: MoodSnapshot[] = [];
  const mood_stops: Record<string, { stop_chains?: boolean }> = {};
  for (const row of data ?? []) {
    const locks = (row.locks ?? {}) as MoodLocks;
    const stakeholderId = String(row.stakeholder_id);
    const scope = String(row.scope_team ?? '');
    const history = Array.isArray(row.history) ? (row.history as Array<{ rung?: string }>) : [];
    const profile = (row.profile ?? {}) as { terminal?: boolean; ladder_ids?: string[] };
    const ladderIds =
      Array.isArray(profile.ladder_ids) && profile.ladder_ids.length > 0
        ? profile.ladder_ids.map((item) => String(item))
        : activeRungs(defaultLadderFor(null)).map((item) => item.id);
    const rungId = String(row.rung_id);
    const historyRungs = history.map((item) => ({ rung: String(item.rung ?? '') })).filter((item) => item.rung);
    moods.push({
      stakeholder_id: stakeholderId,
      scope_team: scope,
      rung_id: rungId,
      rung_index: Math.max(0, ladderIds.indexOf(rungId)),
      ladder_ids: ladderIds,
      history: historyRungs,
      terminal: profile.terminal === true || rungId === 'gave_up',
      locks,
    });
    if (locks.stop_chains) mood_stops[moodStopKey(stakeholderId, scope)] = { stop_chains: true };
  }
  return { moods, mood_stops };
}

export async function locksForStakeholder(sessionId: string, stakeholderId: string): Promise<MoodLocks | null> {
  if (tablesMissing) return null;
  const { data, error } = await supabaseAdmin
    .from('stakeholder_moods')
    .select('rung_id, locks')
    .eq('session_id', sessionId)
    .eq('stakeholder_id', stakeholderId);
  if (error) {
    if (schemaMissing(error)) noteUnavailable();
    return null;
  }
  const merged: MoodLocks = {};
  for (const row of data ?? []) {
    const locks = (row.locks ?? {}) as MoodLocks;
    if (locks.verdict === 'keep') {
      merged.verdict = 'keep';
      merged.verdict_rung = locks.verdict_rung || String(row.rung_id);
    }
    if (locks.persuadability && stricter(locks.persuadability, merged.persuadability)) {
      merged.persuadability = locks.persuadability;
    }
    if (locks.grievance_append?.length) {
      merged.grievance_append = [...(merged.grievance_append ?? []), ...locks.grievance_append];
    }
    if (locks.stop_chains) merged.stop_chains = true;
  }
  if (!merged.verdict && !merged.persuadability && !merged.grievance_append?.length) return null;
  return merged;
}

function stricter(candidate: string, current: string | undefined): boolean {
  const next = PERSUASION_RANK.indexOf(candidate);
  if (next < 0) return false;
  if (!current) return true;
  const prev = PERSUASION_RANK.indexOf(current);
  return prev < 0 || next < prev;
}

export async function noteGoodReply(sessionId: string, deliveryId: string): Promise<void> {
  if (tablesMissing) return;
  try {
    const delivery = await deliveryScope(deliveryId);
    if (!delivery?.stakeholderId) return;
    const session = await sessionFacts(sessionId);
    const { ladder } = await loadStakeholderLadder(session.scenarioId, delivery.stakeholderId, null);
    if (ladder.recovery === 'none') return;
    const stored = await readRow(sessionId, delivery.stakeholderId, delivery.scope);
    if (!stored) return;
    const rung = activeRungs(ladder).find((item) => item.id === stored.rung_id);
    if (rung?.terminal) return;
    const { error } = await supabaseAdmin.rpc('bump_mood_recovery', {
      p_session_id: sessionId,
      p_stakeholder_id: delivery.stakeholderId,
      p_scope_team: delivery.scope,
    });
    if (error && schemaMissing(error)) noteUnavailable();
  } catch (err) {
    if (schemaMissing(err)) noteUnavailable();
  }
}

async function deliveryScope(deliveryId: string): Promise<{ stakeholderId: string | null; scope: string } | null> {
  const { data, error } = await supabaseAdmin
    .from('inject_deliveries')
    .select('stakeholder_id, target_role_id, line_team, recipient_teams')
    .eq('id', deliveryId)
    .maybeSingle();
  if (error || !data) return null;
  return {
    stakeholderId: (data.stakeholder_id as string | null) ?? null,
    scope: scopeFromParts({
      targetRoleId: data.target_role_id as string | null,
      lineTeam: data.line_team as string | null,
      recipientTeams: (data.recipient_teams as string[] | null) ?? [],
    }),
  };
}

export async function rungForDelivery(input: {
  sessionId: string;
  stakeholderId: string;
  targetRoleId?: string | null;
  lineTeam?: string | null;
  recipientTeams?: string[] | null;
  minute?: number;
}): Promise<string | null> {
  const mood = await getMoodNow({
    sessionId: input.sessionId,
    stakeholderId: input.stakeholderId,
    scope: scopeFromParts(input),
    atMinute: input.minute,
    persist: false,
  });
  return mood?.rung.id ?? null;
}

export async function moodForResponse(
  sessionId: string,
  deliveryId: string,
  minute: number,
): Promise<{ rungId: string; waitMinutes: number; episodeAnchorMinute: number | null } | null> {
  const delivery = await deliveryScope(deliveryId);
  if (!delivery?.stakeholderId) return null;
  const mood = await getMoodNow({
    sessionId,
    stakeholderId: delivery.stakeholderId,
    scope: delivery.scope,
    atMinute: minute,
    persist: false,
  });
  if (!mood) return null;
  return {
    rungId: mood.rung.id,
    waitMinutes: mood.profile.wait_minutes,
    episodeAnchorMinute: mood.profile.episode_anchor_minute,
  };
}

export async function moodBlockForReply(input: {
  sessionId: string;
  stakeholderId: string;
  team: string;
  userId?: string | null;
}): Promise<string | null> {
  const mood = await getMoodNow({
    sessionId: input.sessionId,
    stakeholderId: input.stakeholderId,
    scope: await replyScope(input.sessionId, input.stakeholderId, input.team, input.userId ?? null),
    persist: true,
  });
  if (!mood || mood.isBase) return null;
  return buildMoodBlock(mood.rung, mood.profile, { name: input.stakeholderId }, {
    includeScript: false,
    recovery: mood.ladder.recovery,
    channel: 'message',
  });
}

async function replyScope(
  sessionId: string,
  stakeholderId: string,
  team: string,
  userId: string | null,
): Promise<string> {
  if (!userId) return team;
  try {
    const roles = await rolePlayersById(sessionId);
    const held = Object.entries(roles.players)
      .filter(([, ids]) => ids.includes(userId))
      .map(([roleId]) => roleId);
    if (held.length === 0) return team;
    const comms = await loadCommsState(sessionId, 0);
    const open = deliveriesOf(comms).filter(
      (delivery) =>
        (delivery.stakeholder_id === stakeholderId || delivery.step_stakeholder_id === stakeholderId) &&
        !(delivery.responses ?? []).some((response) => response.user_id === userId),
    );
    const roleId = held.find((id) => open.some((delivery) => delivery.target_role_id === id));
    if (roleId) return `role:${roleId}`;
  } catch {
    return team;
  }
  return team;
}

export async function moodForChain(input: {
  sessionId: string;
  stakeholderId: string | null;
  scope: string;
  atMinute: number;
  injectLadder?: unknown;
}): Promise<{ line: string; block: string | null } | null> {
  if (!input.stakeholderId) return null;
  const mood = await getMoodNow({
    sessionId: input.sessionId,
    stakeholderId: input.stakeholderId,
    scope: input.scope,
    atMinute: input.atMinute,
    injectLadder: input.injectLadder,
    persist: true,
  });
  if (!mood) return null;
  return {
    line: moodLineFor(mood.ladder, mood.rung, mood.profile),
    block: mood.isBase
      ? null
      : buildMoodBlock(mood.rung, mood.profile, { name: input.stakeholderId }, {
          includeScript: false,
          recovery: mood.ladder.recovery,
          channel: 'followup',
        }),
  };
}

export async function moodForCall(input: {
  sessionId: string;
  stakeholderId: string | null;
  targetRoleId?: string | null;
  lineTeam?: string | null;
  recipientTeams?: string[] | null;
  atMinute: number;
  injectLadder?: unknown;
}): Promise<MoodNow | null> {
  if (!input.stakeholderId) return null;
  return getMoodNow({
    sessionId: input.sessionId,
    stakeholderId: input.stakeholderId,
    scope: scopeFromParts(input),
    atMinute: input.atMinute,
    injectLadder: input.injectLadder,
    persist: true,
  });
}

export async function inspectMoodLadder(input: {
  scenarioId: string;
  ladder: unknown;
}): Promise<MoodIssue[]> {
  const structural = validateMoodLadder({ ladder: input.ladder });
  if (structural.length > 0) return structural;
  const { data, error } = await activeTemplateInjects(
    supabaseAdmin
      .from('scenario_injects')
      .select('delivery_config, trigger_time_minutes')
      .eq('scenario_id', input.scenarioId)
      .is('session_id', null),
  );
  if (error || !data) return [];
  const known = (data ?? [])
    .map((row) => {
      const config = row.delivery_config as { inject_key?: unknown } | null;
      const key = typeof config?.inject_key === 'string' ? config.inject_key : '';
      return key ? { key, conditional: row.trigger_time_minutes == null } : null;
    })
    .filter((item): item is { key: string; conditional: boolean } => Boolean(item));
  return validateMoodLadder({ ladder: input.ladder, knownInjects: known });
}

export function moodLadderError(config: unknown): string | null {
  if (!config || typeof config !== 'object') return null;
  const ladder = (config as { mood_ladder?: unknown }).mood_ladder;
  if (ladder == null) return null;
  return validateMoodLadder({ ladder }).find((issue) => issue.level === 'error')?.message ?? null;
}
