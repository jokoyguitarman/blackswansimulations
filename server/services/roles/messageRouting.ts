import { supabaseAdmin } from '../../lib/supabaseAdmin.js';
import { logger } from '../../lib/logger.js';
import { insertSessionEvent } from '../../lib/sessionEvents.js';
import { getWebSocketService } from '../websocketService.js';
import { resolveMessageRecipients, resolveTargetMode, type MessageRecipients } from '../calls/lineCore.js';
import { rolePlayersById } from './roleService.js';
import { rolesFeatureReady } from './rolesSchema.js';
import { inBootGrace, sessionUserOnline } from '../presence/sessionPresenceService.js';
import { env } from '../../env.js';

export interface RoutedTargeting {
  playerIds: string[] | null;
  teamNames: string[];
  mention: string;
  targetRoleId: string | null;
  lineTeam: string | null;
  fallbackReason?: MessageRecipients['fallback_reason'];
}

/** Narrow email, DM and chat recipients when a role is set. No-op until migration 271 is applied. */
export async function routeRoleMessage(input: {
  sessionId: string;
  app: string;
  config: Record<string, unknown>;
  teamNames: string[];
  resolvedUserIds: string[] | null;
}): Promise<RoutedTargeting | null> {
  const apps = new Set(['email', 'npc_dm', 'messenger_dm', 'group_chat']);
  if (!apps.has(input.app)) return null;
  if (!(await rolesFeatureReady())) return null;
  const target = resolveTargetMode(input.config);
  if (target.mode !== 'role' && target.mode !== 'player') return null;
  const roles = await rolePlayersById(input.sessionId);
  const members = await membersByTeam(input.sessionId);
  const players = roles.players[typeof input.config.target_role_id === 'string' ? input.config.target_role_id : ''] ?? [];
  const offline =
    players.length > 0 &&
    players.every((id) => !sessionUserOnline(input.sessionId, id)) &&
    env.runBackgroundEngines &&
    !inBootGrace();
  const routed = resolveMessageRecipients({
    app: input.app as 'email' | 'npc_dm' | 'messenger_dm' | 'group_chat',
    mode: target.mode,
    targetRoleId: typeof input.config.target_role_id === 'string' ? input.config.target_role_id : undefined,
    rolePlayers: roles.players,
    roleTeam: roles.teams,
    roleNames: roles.names,
    vacatedRoleIds: roles.vacated,
    roleFallback: target.roleFallback,
    rolePlayersOffline: offline,
    playerUserId: target.playerUserId,
    targetTeams: input.teamNames,
    teamMembers: members,
    resolvedUserIds: input.resolvedUserIds,
  });
  if (!routed.changed) return null;
  if (routed.fallback_reason) {
    logger.warn(
      { event: 'role_fallback_used', sessionId: input.sessionId, role: routed.target_role_id, reason: routed.fallback_reason },
      'role-targeted message fell back',
    );
    if (
      routed.fallback_reason === 'role_unassigned' ||
      routed.fallback_reason === 'role_vacated' ||
      routed.fallback_reason === 'unknown_role'
    ) {
      await insertSessionEvent({
        session_id: input.sessionId,
        event_type: 'trainer_alert',
        metadata: {
          kind: 'role_unassigned_target',
          role_id: routed.target_role_id,
          fallback: routed.fallback_reason,
        },
      });
      const { data: session } = await supabaseAdmin
        .from('sessions')
        .select('trainer_id')
        .eq('id', input.sessionId)
        .maybeSingle();
      const trainer = session?.trainer_id as string | null;
      if (trainer) {
        try {
          getWebSocketService().emitToUser(trainer, {
            type: 'role.unassigned_target',
            data: { role_id: routed.target_role_id, fallback: routed.fallback_reason },
            timestamp: new Date().toISOString(),
          });
        } catch {
          /* websocket not initialised */
        }
      }
    }
  }
  return {
    playerIds: routed.undeliverable ? [] : routed.userIds,
    teamNames: routed.teamNames,
    mention: routed.mention,
    targetRoleId: routed.target_role_id,
    lineTeam: routed.line_team,
    ...(routed.fallback_reason ? { fallbackReason: routed.fallback_reason } : {}),
  };
}

async function membersByTeam(
  sessionId: string,
): Promise<Record<string, Array<{ user_id: string; is_bot: boolean; name?: string }>>> {
  const { data } = await supabaseAdmin.from('session_teams').select('team_name, user_id').eq('session_id', sessionId);
  const ids = [...new Set((data ?? []).map((row) => String(row.user_id)))];
  const bots = new Set<string>();
  const names = new Map<string, string>();
  if (ids.length > 0) {
    const profiles = await supabaseAdmin.from('user_profiles').select('id, full_name, is_bot').in('id', ids);
    for (const row of profiles.data ?? []) {
      if (row.is_bot) bots.add(String(row.id));
      names.set(String(row.id), String(row.full_name ?? ''));
    }
  }
  const out: Record<string, Array<{ user_id: string; is_bot: boolean; name?: string }>> = {};
  for (const row of data ?? []) {
    const team = String(row.team_name);
    const userId = String(row.user_id);
    (out[team] ??= []).push({ user_id: userId, is_bot: bots.has(userId), name: names.get(userId) });
  }
  return out;
}
