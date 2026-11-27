import { supabaseAdmin } from '../../lib/supabaseAdmin.js';
import type { CommsState } from '../ledger/injectLedgerCore.js';
import { logger } from '../../lib/logger.js';
import { getWebSocketService } from '../websocketService.js';
import { parsePlayerRoles, planReroute, rerouteClaim, shouldPromptUnreachable, timedFallbackDue, validateRoleAssignment, type LinkedRedelivery, type PendingContact, type PlayerRoleDef } from './roleCore.js';
import { readFallback, type RoleFallback } from '../calls/lineCore.js';
import { isRolesSchemaMissing, rolesFeatureReady } from './rolesSchema.js';
import { insertSessionEvent } from '../../lib/sessionEvents.js';
import { recordDelivery } from '../ledger/injectLedgerService.js';
import { injectKeyOf } from '../../lib/injectKey.js';
import { handleFor } from '../../lib/identity.js';
import { randomUUID } from 'node:crypto';
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
  const vacated: string[] = [];
  if (await rolesFeatureReady()) {
    const { data, error } = await supabaseAdmin
      .from('session_role_assignments')
      .select('role_id, end_reason')
      .eq('session_id', sessionId)
      .eq('active', false);
    if (!error) {
      for (const role of views) {
        if (role.players.length > 0) continue;
        const ended = (data ?? []).some(
          (row) =>
            row.role_id === role.role_id &&
            (row.end_reason === 'trainer_removed' || row.end_reason === 'left_team' || row.end_reason === 'left_session'),
        );
        if (ended) vacated.push(role.role_id);
      }
    }
  }
  return { players, teams, names, vacated };
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
  const role = (await listRoleAssignments(input.sessionId)).find((row) => row.role_id === input.roleId);
  const plan = planReroute(chosen, {
    teamName: role?.team_name ?? '',
    reason: input.reason ?? 'trainer_reroute',
  });
  let delivered = 0;
  for (const item of plan.deliveries) {
    if (await deliverLinked(input.sessionId, input.roleId, item)) delivered += 1;
  }
  await insertSessionEvent({
    session_id: input.sessionId,
    event_type: 'trainer_alert',
    metadata: {
      kind: 'role_reroute',
      role_id: input.roleId,
      fallback_reason: input.reason ?? plan.fallback_reason,
      items: plan.rerouted.map((item) => item.id),
      delivered,
    },
  });
  await notifyTrainer(input.sessionId, 'role.unassigned_target', {
    role_id: input.roleId,
    fallback: input.reason ?? plan.fallback_reason,
  });
  prompted.delete(promptKey(input.sessionId, input.roleId));
  return { ok: true, rerouted: delivered };
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
    .select('call_group_id, target_role_id, status, inject_id')
    .eq('session_id', sessionId)
    .eq('status', 'scheduled');
  if (!calls.error) {
    for (const row of calls.data ?? []) {
      if (row.target_role_id !== roleId) continue;
      pending.push({
        id: String(row.call_group_id),
        kind: 'call_group',
        channel: 'call',
        inject_id: row.inject_id ? String(row.inject_id) : undefined,
      });
    }
  } else if (!isRolesSchemaMissing(calls.error)) {
    logger.warn({ code: calls.error.code, event: 'role_pending_calls_failed' }, 'pending role calls unread');
  }
  const deliveries = await supabaseAdmin
    .from('inject_deliveries')
    .select('id, target_role_id, first_response_at, channel, inject_id, fallback_reason, chain_root_delivery_id')
    .eq('session_id', sessionId)
    .is('first_response_at', null);
  if (!deliveries.error) {
    for (const row of deliveries.data ?? []) {
      if (row.target_role_id !== roleId) continue;
      const channel = row.channel as PendingContact['channel'];
      pending.push({
        id: String(row.id),
        kind: 'delivery',
        channel,
        inject_id: row.inject_id ? String(row.inject_id) : undefined,
        already_linked: Boolean(row.fallback_reason || row.chain_root_delivery_id),
      });
    }
  }
  return pending;
}

const claimWarned = new Set<string>();

/** Claim the original delivery before copying. A missing marker column skips the copy. */
async function claimOriginal(id: string, reason: string): Promise<'claimed' | 'taken' | 'unwritable'> {
  const child = await supabaseAdmin
    .from('inject_deliveries')
    .select('id')
    .eq('chain_root_delivery_id', id)
    .limit(1);
  if (child.error) {
    if (isRolesSchemaMissing(child.error)) return noteUnwritable(child.error.code);
    noteClaimError(child.error.code, 'child');
    return 'unwritable';
  }
  const childExists = (child.data ?? []).length > 0;
  if (rerouteClaim({ markerWritable: true, originalStamped: false, childExists }) === 'skip_already') {
    await supabaseAdmin.from('inject_deliveries').update({ fallback_reason: reason }).eq('id', id).is('fallback_reason', null);
    return 'taken';
  }
  const claimed = await supabaseAdmin
    .from('inject_deliveries')
    .update({ fallback_reason: reason })
    .eq('id', id)
    .is('fallback_reason', null)
    .select('id');
  if (claimed.error) {
    if (isRolesSchemaMissing(claimed.error)) return noteUnwritable(claimed.error.code);
    noteClaimError(claimed.error.code, 'stamp');
    return 'unwritable';
  }
  if ((claimed.data ?? []).length === 0) return 'taken';
  return 'claimed';
}

function noteUnwritable(code: string | undefined): 'unwritable' {
  const key = `missing:${code ?? 'unknown'}`;
  if (!claimWarned.has(key)) {
    claimWarned.add(key);
    logger.warn(
      { code, event: 'reroute_marker_unavailable' },
      'Role reroute is skipped because the delivery marker column is not applied',
    );
  }
  return 'unwritable';
}

async function cancelScheduledGroup(sessionId: string, groupId: string, reason: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from('sim_calls')
    .update({ status: 'cancelled', end_reason: reason, ended_at: new Date().toISOString() })
    .eq('session_id', sessionId)
    .eq('call_group_id', groupId)
    .eq('status', 'scheduled')
    .select('id');
  if (error) {
    noteClaimError(error.code, 'cancel');
    return false;
  }
  return (data ?? []).length > 0;
}

function noteClaimError(code: string | undefined, where: string): void {
  const key = `${where}:${code ?? 'unknown'}`;
  if (claimWarned.has(key)) return;
  claimWarned.add(key);
  logger.warn({ code, where, event: 'reroute_claim_failed' }, 'Role reroute claim failed');
}

async function deliverLinked(sessionId: string, roleId: string, item: LinkedRedelivery): Promise<boolean> {
  const rootId = item.chain_root_id ?? (item.channel === 'call' ? null : item.source_id);
  if (rootId) {
    const claim = await claimOriginal(rootId, item.fallback_reason);
    if (claim === 'taken' && item.call_group_id) {
      await cancelScheduledGroup(sessionId, item.call_group_id, item.fallback_reason);
    }
    if (claim !== 'claimed') return false;
  } else if (!item.call_group_id || !(await cancelScheduledGroup(sessionId, item.call_group_id, item.fallback_reason))) {
    return false;
  }
  if (rootId && item.call_group_id) {
    await cancelScheduledGroup(sessionId, item.call_group_id, item.fallback_reason);
  }
  const members = await teamUserIds(sessionId, item.team_name);
  if (item.channel === 'call') {
    if (!item.inject_id) return false;
    const { ringFallbackCall } = await import('../calls/callService.js');
    return ringFallbackCall({
      sessionId,
      injectId: item.inject_id,
      teamName: item.team_name,
      chainRootDeliveryId: item.chain_root_id,
      fallbackReason: item.fallback_reason,
      targetRoleId: roleId,
    });
  }
  const original = await supabaseAdmin
    .from('inject_deliveries')
    .select('id, inject_id, inject_key, ref_table, ref_id, channel, stakeholder_id, sender_name')
    .eq('id', item.chain_root_id ?? item.source_id)
    .maybeSingle();
  if (original.error || !original.data) return false;
  const source = original.data;
  const copied = await copySurface({
    sessionId,
    channel: item.channel,
    refTable: String(source.ref_table),
    refId: String(source.ref_id),
    injectId: String(source.inject_id),
    members,
    teamName: item.team_name,
  });
  if (!copied) return false;
  const deliveryId = await recordDelivery({
    sessionId,
    injectId: String(source.inject_id),
    injectKey: String(source.inject_key || injectKeyOf({ id: String(source.inject_id), delivery_config: null })),
    channel: item.channel === 'chat' ? 'chat' : item.channel,
    refTable: copied.refTable,
    refId: copied.refId,
    recipientUserIds: copied.recipientUserIds ?? members,
    recipientTeams: item.team_name ? [item.team_name] : [],
    stakeholderId: (source.stakeholder_id as string | null) ?? null,
    senderName: (source.sender_name as string | null) ?? null,
    chainRootDeliveryId: item.chain_root_id,
    lineTeam: item.team_name || null,
    targetRoleId: roleId,
    fallbackReason: item.fallback_reason,
    chatChannelId: copied.chatChannelId,
    threadId: copied.threadId,
  });
  return Boolean(deliveryId);
}

async function copySurface(input: {
  sessionId: string;
  channel: LinkedRedelivery['channel'];
  refTable: string;
  refId: string;
  injectId: string;
  members: string[];
  teamName: string;
}): Promise<{
  refTable: 'sim_emails' | 'chat_messages' | 'sim_direct_messages';
  refId: string;
  chatChannelId?: string;
  threadId?: string;
  recipientUserIds?: string[];
} | null> {
  if (input.channel === 'email' || input.refTable === 'sim_emails') {
    const { data } = await supabaseAdmin.from('sim_emails').select('*').eq('id', input.refId).maybeSingle();
    if (!data) return null;
    const { data: copy, error } = await supabaseAdmin
      .from('sim_emails')
      .insert({
        session_id: input.sessionId,
        inject_id: input.injectId,
        direction: 'inbound',
        from_address: data.from_address,
        from_name: data.from_name,
        to_addresses: data.to_addresses ?? ['team@crisisresponse.sim'],
        subject: data.subject,
        body_html: data.body_html,
        body_text: data.body_text,
        priority: data.priority ?? 'normal',
        email_category: data.email_category ?? 'general',
        recipient_user_ids: input.members,
        target_teams: input.teamName ? [input.teamName] : [],
      })
      .select('id')
      .maybeSingle();
    if (error || !copy) return null;
    return { refTable: 'sim_emails', refId: String(copy.id), threadId: String(copy.id) };
  }
  if (input.channel === 'messenger_dm' || input.refTable === 'sim_direct_messages') {
    const { data } = await supabaseAdmin.from('sim_direct_messages').select('*').eq('id', input.refId).maybeSingle();
    if (!data || input.members.length === 0) return null;
    const { data: profiles } = await supabaseAdmin
      .from('user_profiles')
      .select('id, full_name')
      .in('id', input.members);
    const names = new Map((profiles ?? []).map((row) => [String(row.id), String(row.full_name ?? 'Player')]));
    const sent: string[] = [];
    let first: { id: string; thread_id?: string | null } | null = null;
    for (const userId of input.members) {
      const sameRecipient = userId === String(data.recipient_user_id ?? '');
      const row = {
        session_id: input.sessionId,
        sender_handle: data.sender_handle,
        sender_display_name: data.sender_display_name,
        sender_type: data.sender_type,
        recipient_handle: handleFor(names.get(userId) ?? 'Player'),
        recipient_user_id: userId,
        content: data.content,
        platform: data.platform ?? 'facebook',
        thread_id: sameRecipient ? data.thread_id : randomUUID(),
      };
      let inserted = await supabaseAdmin.from('sim_direct_messages').insert({ ...row, inject_id: input.injectId }).select('id, thread_id').maybeSingle();
      if (inserted.error && isRolesSchemaMissing(inserted.error)) {
        inserted = await supabaseAdmin.from('sim_direct_messages').insert(row).select('id, thread_id').maybeSingle();
      }
      if (inserted.error || !inserted.data) continue;
      sent.push(userId);
      if (!first) first = inserted.data;
    }
    if (!first) return null;
    return {
      refTable: 'sim_direct_messages',
      refId: String(first.id),
      threadId: String(first.thread_id ?? first.id),
      recipientUserIds: sent,
    };
  }
  const content = await originalChatText(input.refTable, input.refId);
  if (!content || !input.teamName) return null;
  const { data: channel } = await supabaseAdmin
    .from('chat_channels')
    .select('id')
    .eq('session_id', input.sessionId)
    .eq('type', 'team')
    .eq('team_name', input.teamName)
    .limit(1)
    .maybeSingle();
  if (!channel) return null;
  const { data: message, error } = await supabaseAdmin
    .from('chat_messages')
    .insert({
      channel_id: channel.id,
      session_id: input.sessionId,
      sender_id: null,
      content,
      type: 'text',
      inject_id: input.injectId,
    })
    .select('id')
    .maybeSingle();
  if (error || !message) return null;
  return { refTable: 'chat_messages', refId: String(message.id), chatChannelId: String(channel.id) };
}

async function originalChatText(refTable: string, refId: string): Promise<string | null> {
  if (refTable === 'chat_messages') {
    const { data } = await supabaseAdmin.from('chat_messages').select('content').eq('id', refId).maybeSingle();
    return typeof data?.content === 'string' ? data.content : null;
  }
  if (refTable === 'sim_emails') {
    const { data } = await supabaseAdmin.from('sim_emails').select('body_text, subject').eq('id', refId).maybeSingle();
    return typeof data?.body_text === 'string' ? data.body_text : null;
  }
  return null;
}

async function teamUserIds(sessionId: string, teamName: string): Promise<string[]> {
  if (!teamName) return [];
  const { data } = await supabaseAdmin.from('session_teams').select('user_id').eq('session_id', sessionId).eq('team_name', teamName);
  return (data ?? []).map((row) => String(row.user_id));
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
