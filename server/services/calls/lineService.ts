import { randomInt } from 'node:crypto';
import { supabaseAdmin } from '../../lib/supabaseAdmin.js';
import { logger } from '../../lib/logger.js';
import { getWebSocketService } from '../websocketService.js';
import {
  claimLineVersion,
  mergeCallPolicy,
  pickAutofill,
  planOfflineReassignment,
  type CallPolicy,
} from './lineCore.js';
import { isRolesSchemaMissing, markRolesTablesMissing, rolesFeatureReady } from '../roles/rolesSchema.js';
import { inBootGrace, presenceEnginesOn, sessionUserOnline } from '../presence/sessionPresenceService.js';
import { insertSessionEvent } from '../../lib/sessionEvents.js';

export interface LineHolderRow {
  user_id: string;
  name: string;
  online: boolean;
  busy: boolean;
  source: string;
  assigned_at: string;
  is_bot: boolean;
}

export interface LineView {
  team_name: string;
  holders: LineHolderRow[];
  unattended_since: string | null;
  version: number;
}

const busyStatuses = new Set(['connecting', 'active']);

export async function loadCallPolicy(sessionId: string): Promise<CallPolicy> {
  if (!(await rolesFeatureReady())) return mergeCallPolicy(null);
  const { data, error } = await supabaseAdmin.from('sessions').select('call_policy').eq('id', sessionId).maybeSingle();
  if (error) {
    if (!isRolesSchemaMissing(error)) logger.warn({ code: error.code, event: 'call_policy_read_failed' }, 'call policy unread');
    return mergeCallPolicy(null);
  }
  const raw = data?.call_policy;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return mergeCallPolicy(null);
  return mergeCallPolicy(raw as Partial<CallPolicy>);
}

export async function saveCallPolicy(sessionId: string, patch: Partial<CallPolicy>): Promise<CallPolicy | null> {
  if (!(await rolesFeatureReady())) return null;
  const next = mergeCallPolicy({ ...(await loadCallPolicy(sessionId)), ...patch });
  const { error } = await supabaseAdmin.from('sessions').update({ call_policy: next }).eq('id', sessionId);
  if (error && isRolesSchemaMissing(error)) return null;
  if (error) {
    logger.warn({ code: error.code, event: 'call_policy_write_failed' }, 'call policy not saved');
    return null;
  }
  return next;
}

export async function listLines(sessionId: string): Promise<LineView[]> {
  if (!(await rolesFeatureReady())) return [];
  const [{ data: lines, error: lineError }, { data: takers, error: takerError }, { data: teams }] =
    await Promise.all([
      supabaseAdmin.from('session_call_lines').select('team_name, version, unattended_since').eq('session_id', sessionId),
      supabaseAdmin
        .from('session_call_takers')
        .select('team_name, user_id, source, assigned_at')
        .eq('session_id', sessionId)
        .eq('active', true),
      supabaseAdmin.from('session_teams').select('team_name, user_id').eq('session_id', sessionId),
    ]);
  if (lineError && isRolesSchemaMissing(lineError)) {
    markRolesTablesMissing(lineError);
    return [];
  }
  if (takerError && isRolesSchemaMissing(takerError)) return [];
  const names = await namesFor((takers ?? []).map((row) => String(row.user_id)));
  const bots = await botSet((takers ?? []).map((row) => String(row.user_id)));
  const busy = await busyUsers(sessionId);
  const byTeam = new Map<string, LineView>();
  const teamNames = new Set<string>();
  for (const row of teams ?? []) teamNames.add(String(row.team_name));
  for (const row of lines ?? []) teamNames.add(String(row.team_name));
  for (const team of teamNames) {
    byTeam.set(team, {
      team_name: team,
      holders: [],
      unattended_since: null,
      version: 0,
    });
  }
  for (const row of lines ?? []) {
    const view = byTeam.get(String(row.team_name));
    if (!view) continue;
    view.version = Number(row.version ?? 0);
    view.unattended_since = (row.unattended_since as string | null) ?? null;
  }
  for (const row of takers ?? []) {
    const team = String(row.team_name);
    const view = byTeam.get(team) ?? { team_name: team, holders: [], unattended_since: null, version: 0 };
    const userId = String(row.user_id);
    view.holders.push({
      user_id: userId,
      name: names.get(userId) ?? 'Player',
      online: sessionUserOnline(sessionId, userId),
      busy: busy.has(userId),
      source: String(row.source ?? 'trainer_lobby'),
      assigned_at: String(row.assigned_at ?? new Date().toISOString()),
      is_bot: bots.has(userId),
    });
    byTeam.set(team, view);
  }
  return [...byTeam.values()].sort((a, b) => a.team_name.localeCompare(b.team_name));
}

export async function holdersByTeam(sessionId: string): Promise<Record<string, string[]>> {
  const lines = await listLines(sessionId);
  const out: Record<string, string[]> = {};
  for (const line of lines) out[line.team_name] = line.holders.map((holder) => holder.user_id);
  return out;
}

export async function replaceLineHolders(input: {
  sessionId: string;
  teamName: string;
  userIds: string[];
  actorId: string;
  source: 'trainer_lobby' | 'trainer_console' | 'lobby_autofill';
}): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
  if (!(await rolesFeatureReady())) return { ok: false, error: 'roles_unavailable', status: 503 };
  const members = await teamMembers(input.sessionId, input.teamName);
  if (members.length === 0 && input.userIds.length > 0) {
    return { ok: false, error: 'Unknown team', status: 400 };
  }
  for (const userId of input.userIds) {
    const member = members.find((row) => row.user_id === userId);
    if (!member) return { ok: false, error: 'That player is not on this team', status: 400 };
    if (member.is_bot) return { ok: false, error: 'A bot cannot hold a line', status: 400 };
  }
  await ensureLine(input.sessionId, input.teamName);
  const now = new Date().toISOString();
  const { data: current } = await supabaseAdmin
    .from('session_call_takers')
    .select('id, user_id')
    .eq('session_id', input.sessionId)
    .eq('team_name', input.teamName)
    .eq('active', true);
  const keep = new Set(input.userIds);
  for (const row of current ?? []) {
    if (keep.has(String(row.user_id))) continue;
    await supabaseAdmin
      .from('session_call_takers')
      .update({ active: false, ended_at: now, end_reason: 'trainer_removed' })
      .eq('id', row.id);
  }
  const have = new Set((current ?? []).map((row) => String(row.user_id)));
  for (const userId of input.userIds) {
    if (have.has(userId)) continue;
    const { error } = await supabaseAdmin.from('session_call_takers').insert({
      session_id: input.sessionId,
      team_name: input.teamName,
      user_id: userId,
      source: input.source,
      assigned_by: input.actorId,
      active: true,
    });
    if (error && isRolesSchemaMissing(error)) return { ok: false, error: 'roles_unavailable', status: 503 };
    if (error && error.code !== '23505') {
      logger.warn({ code: error.code, event: 'call_taker_insert_failed' }, 'line holder not saved');
      return { ok: false, error: 'Could not assign the line', status: 500 };
    }
  }
  emitLine(input.sessionId, input.teamName);
  return { ok: true };
}

export async function autofillLines(input: {
  sessionId: string;
  teamNames?: string[];
  actorId: string;
  gateTeams?: string[];
}): Promise<{ ok: true; picks: Array<{ team_name: string; user_id: string }> } | { ok: false; error: string; status: number }> {
  if (!(await rolesFeatureReady())) return { ok: false, error: 'roles_unavailable', status: 503 };
  if (!presenceEnginesOn()) return { ok: false, error: 'presence_unavailable', status: 409 };
  const lines = await listLines(input.sessionId);
  const wanted = new Set(input.teamNames ?? input.gateTeams ?? lines.map((line) => line.team_name));
  const teams = [];
  for (const line of lines) {
    if (!wanted.has(line.team_name)) continue;
    const members = await teamMembers(input.sessionId, line.team_name);
    teams.push({
      team_name: line.team_name,
      holders: line.holders.map((holder) => holder.user_id),
      members: members.map((member) => ({
        user_id: member.user_id,
        is_bot: member.is_bot,
        online: sessionUserOnline(input.sessionId, member.user_id),
      })),
    });
  }
  const picked = pickAutofill({
    teams,
    teamNames: input.teamNames,
    presenceEnabled: true,
    randomInt: (max) => randomInt(0, Math.max(max, 1)),
  });
  if (!picked.ok) return { ok: false, error: picked.code, status: 409 };
  for (const pick of picked.picks) {
    await replaceLineHolders({
      sessionId: input.sessionId,
      teamName: pick.team_name,
      userIds: [pick.user_id],
      actorId: input.actorId,
      source: 'lobby_autofill',
    });
  }
  return { ok: true, picks: picked.picks };
}

export async function ensureCallLines(sessionId: string): Promise<void> {
  if (!(await rolesFeatureReady())) return;
  const { data: teams } = await supabaseAdmin.from('session_teams').select('team_name').eq('session_id', sessionId);
  const names = new Set((teams ?? []).map((row) => String(row.team_name)));
  for (const team of names) await ensureLine(sessionId, team);
  if (!presenceEnginesOn()) return;
  const lines = await listLines(sessionId);
  const now = new Date().toISOString();
  for (const line of lines) {
    const online = line.holders.some((holder) => holder.online && !holder.is_bot);
    if (online || line.unattended_since) continue;
    await supabaseAdmin
      .from('session_call_lines')
      .update({ unattended_since: now, updated_at: now })
      .eq('session_id', sessionId)
      .eq('team_name', line.team_name);
  }
}

export async function sweepLines(sessionId: string): Promise<void> {
  if (!presenceEnginesOn() || !(await rolesFeatureReady())) return;
  const policy = await loadCallPolicy(sessionId);
  const lines = await listLines(sessionId);
  for (const line of lines) {
    const members = await teamMembers(sessionId, line.team_name);
    const plan = planOfflineReassignment({
      holders: line.holders.map((holder) => ({ user_id: holder.user_id, online: holder.online && !inBootGrace() })),
      members: members.map((member) => ({
        user_id: member.user_id,
        is_bot: member.is_bot,
        online: sessionUserOnline(sessionId, member.user_id),
      })),
      enginesOn: true,
      bootGrace: inBootGrace(),
      reassignOnOffline: policy.reassign_on_offline,
      randomInt: (max) => randomInt(0, Math.max(max, 1)),
    });
    if (plan.action === 'reassign') {
      const claimed = claimLineVersion(line.version, line.version);
      if (!claimed.ok) continue;
      const { data: updated } = await supabaseAdmin
        .from('session_call_lines')
        .update({ version: claimed.next, unattended_since: null, updated_at: new Date().toISOString() })
        .eq('session_id', sessionId)
        .eq('team_name', line.team_name)
        .eq('version', line.version)
        .select('version');
      if (!updated || updated.length === 0) continue;
      const now = new Date().toISOString();
      for (const userId of plan.deactivate) {
        await supabaseAdmin
          .from('session_call_takers')
          .update({ active: false, ended_at: now, end_reason: 'offline_reassigned' })
          .eq('session_id', sessionId)
          .eq('team_name', line.team_name)
          .eq('user_id', userId)
          .eq('active', true);
      }
      await supabaseAdmin.from('session_call_takers').insert({
        session_id: sessionId,
        team_name: line.team_name,
        user_id: plan.assign,
        source: 'auto_reassign',
        active: true,
      });
      await insertSessionEvent({
        session_id: sessionId,
        event_type: 'call_taker_changed',
        metadata: { team_name: line.team_name, reason: 'offline', user_id: plan.assign },
      });
      emitLine(sessionId, line.team_name);
    } else if (plan.action === 'unattended' && !line.unattended_since) {
      const since = new Date().toISOString();
      await supabaseAdmin
        .from('session_call_lines')
        .update({ unattended_since: since, updated_at: since })
        .eq('session_id', sessionId)
        .eq('team_name', line.team_name);
      const trainer = await trainerId(sessionId);
      if (trainer) emitUser(trainer, 'call_line.unattended', { team_name: line.team_name, since });
    }
  }
}

export async function releaseLineMember(sessionId: string, userId: string): Promise<void> {
  if (!(await rolesFeatureReady())) return;
  const now = new Date().toISOString();
  await supabaseAdmin
    .from('session_call_takers')
    .update({ active: false, ended_at: now, end_reason: 'left_team' })
    .eq('session_id', sessionId)
    .eq('user_id', userId)
    .eq('active', true);
  if (presenceEnginesOn()) await sweepLines(sessionId);
}

export async function endLines(sessionId: string): Promise<void> {
  if (!(await rolesFeatureReady())) return;
  const now = new Date().toISOString();
  await supabaseAdmin
    .from('session_call_takers')
    .update({ active: false, ended_at: now, end_reason: 'session_ended' })
    .eq('session_id', sessionId)
    .eq('active', true);
}

async function ensureLine(sessionId: string, teamName: string): Promise<void> {
  const { error } = await supabaseAdmin.from('session_call_lines').insert({
    session_id: sessionId,
    team_name: teamName,
  });
  if (error && error.code !== '23505' && isRolesSchemaMissing(error)) markRolesTablesMissing(error);
}

async function teamMembers(sessionId: string, teamName: string): Promise<Array<{ user_id: string; is_bot: boolean }>> {
  const { data } = await supabaseAdmin
    .from('session_teams')
    .select('user_id')
    .eq('session_id', sessionId)
    .eq('team_name', teamName);
  const ids = (data ?? []).map((row) => String(row.user_id));
  const bots = await botSet(ids);
  return ids.map((userId) => ({ user_id: userId, is_bot: bots.has(userId) }));
}

async function namesFor(ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  const names = new Map<string, string>();
  if (unique.length === 0) return names;
  const { data } = await supabaseAdmin.from('user_profiles').select('id, full_name').in('id', unique);
  for (const row of data ?? []) names.set(String(row.id), String(row.full_name ?? 'Player'));
  return names;
}

async function botSet(ids: string[]): Promise<Set<string>> {
  const unique = [...new Set(ids)];
  const bots = new Set<string>();
  if (unique.length === 0) return bots;
  const { data } = await supabaseAdmin.from('user_profiles').select('id, is_bot').in('id', unique);
  for (const row of data ?? []) if (row.is_bot) bots.add(String(row.id));
  return bots;
}

async function busyUsers(sessionId: string): Promise<Set<string>> {
  const { data, error } = await supabaseAdmin
    .from('sim_calls')
    .select('answered_by, status')
    .eq('session_id', sessionId)
    .in('status', [...busyStatuses]);
  if (error) return new Set();
  return new Set((data ?? []).map((row) => String(row.answered_by ?? '')).filter(Boolean));
}

async function trainerId(sessionId: string): Promise<string | null> {
  const { data } = await supabaseAdmin.from('sessions').select('trainer_id').eq('id', sessionId).maybeSingle();
  return (data?.trainer_id as string | null) ?? null;
}

function emitLine(sessionId: string, teamName: string): void {
  void listLines(sessionId).then((lines) => {
    const line = lines.find((row) => row.team_name === teamName);
    void trainerId(sessionId).then((trainer) => {
      if (!trainer || !line) return;
      emitUser(trainer, 'call_line.updated', { team_name: teamName, holders: line.holders });
    });
  });
}

function emitUser(userId: string, type: string, data: Record<string, unknown>): void {
  try {
    getWebSocketService().emitToUser(userId, { type, data, timestamp: new Date().toISOString() });
  } catch {
    /* websocket not initialised */
  }
}
