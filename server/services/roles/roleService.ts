import { supabaseAdmin } from '../../lib/supabaseAdmin.js';
import type { CommsState } from '../ledger/injectLedgerCore.js';
import { logger } from '../../lib/logger.js';
import { getWebSocketService } from '../websocketService.js';
import { parsePlayerRoles, planReroute, shouldPromptUnreachable, timedFallbackDue, validateRoleAssignment, type PendingContact, type PlayerRoleDef } from './roleCore.js';
import { readFallback, type RoleFallback } from '../calls/lineCore.js';
import { isRolesSchemaMissing, rolesFeatureReady } from './rolesSchema.js';
import { inBootGrace, presenceEnginesOn, sessionUserOnline } from '../presence/sessionPresenceService.js';
import { listLines, loadCallPolicy } from '../calls/lineService.js';

export interface RolePlayerView {
  user_id: string;
  name: string;
  online: boolean;
}

export interface RoleView {
  role_id: string;
  title: string;
  team_name: string;
  players: RolePlayerView[];
}

const prompted = new Set<string>();
const offlineSinceMs = new Map<string, number>();

export async function loadScenarioRoles(scenarioId: string | null): Promise<PlayerRoleDef[]> {
  if (!scenarioId) return [];
  const { data } = await supabaseAdmin.from('scenarios').select('initial_state').eq('id', scenarioId).maybeSingle();
  const initial = (data?.initial_state ?? {}) as Record<string, unknown>;
  return parsePlayerRoles(initial.player_roles);
}

export async function listRoleAssignments(sessionId: string): Promise<RoleView[]> {
  const scenarioId = await scenarioOf(sessionId);
  const roles = await loadScenarioRoles(scenarioId);
  if (!(await rolesFeatureReady())) {
    return roles.map((role) => ({ role_id: role.role_id, title: role.title, team_name: role.team_name, players: [] }));
  }
  const { data, error } = await supabaseAdmin
    .from('session_role_assignments')
    .select('role_id, user_id')
    .eq('session_id', sessionId)
    .eq('active', true);
  if (error && isRolesSchemaMissing(error)) {
    return roles.map((role) => ({ role_id: role.role_id, title: role.title, team_name: role.team_name, players: [] }));
  }
  const ids = (data ?? []).map((row) => String(row.user_id));
  const names = await namesFor(ids);
  return roles.map((role) => ({
    role_id: role.role_id,
    title: role.title,
    team_name: role.team_name,
    players: (data ?? [])
      .filter((row) => row.role_id === role.role_id)
      .map((row) => ({
        user_id: String(row.user_id),
        name: names.get(String(row.user_id)) ?? 'Player',
        online: sessionUserOnline(sessionId, String(row.user_id)),
      })),
  }));
}

export async function rolePlayersById(sessionId: string): Promise<{
  players: Record<string, string[]>;
  teams: Record<string, string>;
  names: Record<string, string>;
  vacated: string[];
}> {
  const views = await listRoleAssignments(sessionId);
  const players: Record<string, string[]> = {};
  const teams: Record<string, string> = {};
  const names: Record<string, string> = {};
  for (const role of views) {
    teams[role.role_id] = role.team_name;
    players[role.role_id] = role.players.map((player) => player.user_id);
    for (const player of role.players) names[player.user_id] = player.name;
  }
  return { players, teams, names, vacated: [] };
}

export async function replaceRolePlayers(input: {
  sessionId: string;
  roleId: string;
  userIds: string[];
  actorId: string;
  source: 'trainer_lobby' | 'trainer_console';
}): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
  if (!(await rolesFeatureReady())) return { ok: false, error: 'roles_unavailable', status: 503 };
  const scenarioId = await scenarioOf(input.sessionId);
  const roles = await loadScenarioRoles(scenarioId);
  const role = roles.find((row) => row.role_id === input.roleId) ?? null;
  const { data: memberRows } = await supabaseAdmin
    .from('session_teams')
    .select('user_id, team_name')
    .eq('session_id', input.sessionId);
  const ids = (memberRows ?? []).map((row) => String(row.user_id));
  const bots = await botSet(ids);
  const decision = validateRoleAssignment({
    role,
    userIds: input.userIds,
    members: (memberRows ?? []).map((row) => ({
      user_id: String(row.user_id),
      team_name: String(row.team_name),
      is_bot: bots.has(String(row.user_id)),
    })),
  });
  if (!decision.ok) return { ok: false, error: decision.error, status: 400 };
  const now = new Date().toISOString();
  const { data: current } = await supabaseAdmin
    .from('session_role_assignments')
    .select('id, user_id')
    .eq('session_id', input.sessionId)
    .eq('role_id', input.roleId)
    .eq('active', true);
  const keep = new Set(input.userIds);
  const hadPlayers = (current ?? []).length > 0;
  for (const row of current ?? []) {
    if (keep.has(String(row.user_id))) continue;
    await supabaseAdmin
      .from('session_role_assignments')
      .update({ active: false, ended_at: now, end_reason: hadPlayers && input.userIds.length === 0 ? 'trainer_removed' : 'trainer_removed' })
      .eq('id', row.id);
  }
  const have = new Set((current ?? []).map((row) => String(row.user_id)));
  for (const userId of input.userIds) {
    if (have.has(userId)) continue;
    const { error } = await supabaseAdmin.from('session_role_assignments').insert({
      session_id: input.sessionId,
      role_id: input.roleId,
      user_id: userId,
      source: input.source,
      assigned_by: input.actorId,
      active: true,
    });
    if (error && isRolesSchemaMissing(error)) return { ok: false, error: 'roles_unavailable', status: 503 };
    if (error && error.code !== '23505') return { ok: false, error: 'Could not assign the role', status: 500 };
  }
  if (hadPlayers && input.userIds.length === 0) {
    await notifyTrainer(input.sessionId, 'role.unassigned_target', {
      role_id: input.roleId,
      fallback: 'role_vacated',
    });
  }
  emitRole(input.sessionId, input.roleId);
  return { ok: true };
}

export async function rerouteRole(input: {
  sessionId: string;
  roleId: string;
  pendingIds?: string[];
  reason?: 'trainer_reroute' | 'role_fallback_after_minutes' | 'role_offline_fallback';
}): Promise<{ ok: true; rerouted: number } | { ok: false; error: string; status: number }> {
  if (!(await rolesFeatureReady())) return { ok: false, error: 'roles_unavailable', status: 503 };
  const pending = await pendingForRole(input.sessionId, input.roleId);
  const chosen = input.pendingIds ? pending.filter((item) => input.pendingIds?.includes(item.id)) : pending;
  const plan = planReroute(chosen);
  const now = new Date().toISOString();
  for (const groupId of plan.cancelCallGroups) {
    await supabaseAdmin
      .from('sim_calls')
      .update({ status: 'cancelled', end_reason: input.reason ?? 'trainer_reroute', ended_at: now })
      .eq('session_id', input.sessionId)
      .eq('call_group_id', groupId)
      .eq('status', 'scheduled');
  }
  await supabaseAdmin.from('session_events').insert({
    session_id: input.sessionId,
    event_type: 'trainer_alert',
    metadata: {
      kind: 'role_reroute',
      role_id: input.roleId,
      fallback_reason: input.reason ?? plan.fallback_reason,
      items: plan.rerouted,
    },
  });
  await notifyTrainer(input.sessionId, 'role.unassigned_target', {
    role_id: input.roleId,
    fallback: input.reason ?? plan.fallback_reason,
  });
  prompted.delete(promptKey(input.sessionId, input.roleId));
  return { ok: true, rerouted: plan.rerouted.length };
}

export async function attachCoverageFacts(sessionId: string, state: CommsState): Promise<CommsState> {
  if (!(await rolesFeatureReady())) return state;
  const [lines, roles] = await Promise.all([listLines(sessionId), listRoleAssignments(sessionId)]);
  const now = Date.now();
  state.line_runtime = lines.map((line) => ({
    team: line.team_name,
    online_holders: line.holders.filter((holder) => holder.online && !holder.is_bot).length,
    unattended_minutes: line.unattended_since
      ? Math.max(0, Math.floor((now - Date.parse(line.unattended_since)) / 60_000))
      : null,
    reassigned: line.holders.some((holder) => holder.source === 'auto_reassign'),
  }));
  state.role_runtime = roles.map((role) => {
    const since = offlineSinceMs.get(promptKey(sessionId, role.role_id));
    const offline = role.players.length > 0 && role.players.every((player) => !player.online);
    return {
      role_id: role.role_id,
      assigned: role.players.length > 0,
      fallback_used: false,
      offline_minutes: offline && since != null ? (now - since) / 60_000 : offline ? 0 : null,
    };
  });
  return state;
}

export async function sweepRoles(sessionId: string): Promise<void> {
  if (!presenceEnginesOn() || inBootGrace() || !(await rolesFeatureReady())) return;
  const policy = await loadCallPolicy(sessionId);
  const roles = await listRoleAssignments(sessionId);
  for (const role of roles) {
    const players = role.players;
    const key = promptKey(sessionId, role.role_id);
    if (players.length === 0) continue;
    const offline = players.every((player) => !player.online);
    if (!offline) {
      prompted.delete(key);
      offlineSinceMs.delete(key);
      continue;
    }
    if (!offlineSinceMs.has(key)) offlineSinceMs.set(key, Date.now());
    const offlineMinutes = (Date.now() - (offlineSinceMs.get(key) ?? Date.now())) / 60_000;
    const pending = await pendingForRole(sessionId, role.role_id);
    const decision = shouldPromptUnreachable({
      enginesOn: true,
      roleOfflinePrompt: policy.role_offline_prompt,
      alreadyPrompted: prompted.has(key),
      offlinePastGrace: true,
      pending,
    });
    if (decision.emit) {
      prompted.add(key);
      await notifyTrainer(sessionId, 'role.player_unreachable', {
        role_id: role.role_id,
        title: role.title,
        user_id: players[0]?.user_id ?? null,
        offline_since: new Date().toISOString(),
        pending: pending.map((item) => ({ id: item.id, kind: item.kind })),
      });
    }
    const injectFallback = await fallbackForPending(pending);
    const due = timedFallbackDue({
      roleFallback: injectFallback.fallback,
      roleFallbackMinutes: injectFallback.minutes,
      policyMinutes: policy.role_offline_auto_fallback_minutes,
      offlineMinutes,
      playerBackOnline: false,
    });
    if (due.due) {
      await rerouteRole({
        sessionId,
        roleId: role.role_id,
        reason: due.reason === 'role_fallback_after_minutes' ? 'role_fallback_after_minutes' : 'role_offline_fallback',
      });
    }
  }
}

export async function releaseRoleMember(sessionId: string, userId: string): Promise<void> {
  if (!(await rolesFeatureReady())) return;
  const now = new Date().toISOString();
  await supabaseAdmin
    .from('session_role_assignments')
    .update({ active: false, ended_at: now, end_reason: 'left_team' })
    .eq('session_id', sessionId)
    .eq('user_id', userId)
    .eq('active', true);
}

export async function endRoles(sessionId: string): Promise<void> {
  if (!(await rolesFeatureReady())) return;
  const now = new Date().toISOString();
  await supabaseAdmin
    .from('session_role_assignments')
    .update({ active: false, ended_at: now, end_reason: 'session_ended' })
    .eq('session_id', sessionId)
    .eq('active', true);
}

async function pendingForRole(sessionId: string, roleId: string): Promise<PendingContact[]> {
  const pending: PendingContact[] = [];
  const calls = await supabaseAdmin
    .from('sim_calls')
    .select('call_group_id, target_role_id, status')
    .eq('session_id', sessionId)
    .eq('status', 'scheduled');
  if (!calls.error) {
    for (const row of calls.data ?? []) {
      if (row.target_role_id !== roleId) continue;
      pending.push({ id: String(row.call_group_id), kind: 'call_group' });
    }
  } else if (!isRolesSchemaMissing(calls.error)) {
    logger.warn({ code: calls.error.code, event: 'role_pending_calls_failed' }, 'pending role calls unread');
  }
  const deliveries = await supabaseAdmin
    .from('inject_deliveries')
    .select('id, target_role_id, first_response_at')
    .eq('session_id', sessionId)
    .is('first_response_at', null);
  if (!deliveries.error) {
    for (const row of deliveries.data ?? []) {
      if (row.target_role_id !== roleId) continue;
      pending.push({ id: String(row.id), kind: 'delivery' });
    }
  }
  return pending;
}

async function fallbackForPending(
  pending: readonly PendingContact[],
): Promise<{ fallback: RoleFallback; minutes: number | null }> {
  const deliveryIds = pending.filter((item) => item.kind === 'delivery').map((item) => item.id);
  if (deliveryIds.length === 0) return { fallback: 'none', minutes: null };
  const deliveries = await supabaseAdmin.from('inject_deliveries').select('inject_id').in('id', deliveryIds);
  if (deliveries.error) return { fallback: 'none', minutes: null };
  const injectIds = [...new Set((deliveries.data ?? []).map((row) => String(row.inject_id)).filter(Boolean))];
  if (injectIds.length === 0) return { fallback: 'none', minutes: null };
  const injects = await supabaseAdmin.from('scenario_injects').select('delivery_config').in('id', injectIds);
  if (injects.error) return { fallback: 'none', minutes: null };
  let chosen: { fallback: RoleFallback; minutes: number | null } = { fallback: 'none', minutes: null };
  for (const row of injects.data ?? []) {
    const config = row.delivery_config;
    if (!config || typeof config !== 'object') continue;
    const read = readFallback(config);
    if (read.fallback === 'line_after_minutes') return read;
    if (read.fallback === 'line') chosen = read;
  }
  return chosen;
}

async function scenarioOf(sessionId: string): Promise<string | null> {
  const { data } = await supabaseAdmin.from('sessions').select('scenario_id').eq('id', sessionId).maybeSingle();
  return (data?.scenario_id as string | null) ?? null;
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

async function notifyTrainer(sessionId: string, type: string, data: Record<string, unknown>): Promise<void> {
  const { data: session } = await supabaseAdmin.from('sessions').select('trainer_id').eq('id', sessionId).maybeSingle();
  const trainer = session?.trainer_id as string | null;
  if (!trainer) return;
  try {
    getWebSocketService().emitToUser(trainer, { type, data, timestamp: new Date().toISOString() });
  } catch {
    /* websocket not initialised */
  }
}

function emitRole(sessionId: string, roleId: string): void {
  void listRoleAssignments(sessionId).then((roles) => {
    const role = roles.find((row) => row.role_id === roleId);
    if (!role) return;
    void notifyTrainer(sessionId, 'role.updated', { role_id: roleId, players: role.players, reason: 'assignment' });
  });
}

function promptKey(sessionId: string, roleId: string): string {
  return `${sessionId}:${roleId}`;
}
