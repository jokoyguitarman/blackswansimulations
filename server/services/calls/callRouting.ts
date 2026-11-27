import { logger } from '../../lib/logger.js';
import { env } from '../../env.js';
import {
  concreteTeamNames,
  DEFAULT_CALL_POLICY,
  onlineForAssignment,
  readFallback,
  resolveTargetMode,
  resolveUniversalLine,
  type RingSetInput,
} from './lineCore.js';
import { holdersByTeam, loadCallPolicy } from './lineService.js';
import { rolePlayersById } from '../roles/roleService.js';
import { rolesFeatureReady } from '../roles/rolesSchema.js';
import { inBootGrace, sessionUserOnline } from '../presence/sessionPresenceService.js';
import { supabaseAdmin } from '../../lib/supabaseAdmin.js';

export async function buildRingSetInput(args: {
  sessionId: string;
  config: Record<string, unknown>;
  teams: string[];
  members: Record<string, Array<{ user_id: string; is_bot: boolean }>>;
  recipients: string[] | null;
  busy: (userId: string) => boolean;
  attemptNo: number;
  owningTeam?: string | null;
}): Promise<RingSetInput> {
  const legacy = legacyInput(args);
  if (!(await rolesFeatureReady())) return legacy;
  const policy = await loadCallPolicy(args.sessionId);
  const roles = await rolePlayersById(args.sessionId);
  const holders = await holdersByTeam(args.sessionId);
  const target = resolveTargetMode(args.config);
  const fallback = readFallback(args.config);
  let mode = target.mode;
  let teams = concreteTeamNames(args.teams);
  if (mode === 'line' && teams.length === 0 && !args.config.target_role_id) {
    const sessionTeams = Object.keys(args.members);
    const universal = resolveUniversalLine({
      owningTeam: args.owningTeam ?? null,
      stakeholderTeam: typeof args.config.stakeholder_team === 'string' ? args.config.stakeholder_team : null,
      sessionTeams,
    });
    if (universal.warn) {
      logger.warn({ event: 'universal_call_no_line', sessionId: args.sessionId }, 'universal call has no team line');
      mode = 'ring_all';
    } else if (universal.team) {
      teams = [universal.team];
    }
  }
  if (mode === 'ring_all') return { ...legacy, policy, targetTeams: teams.length > 0 ? teams : args.teams };
  const active = new Set<string>();
  for (const ids of Object.values(holders)) for (const id of ids) active.add(id);
  for (const ids of Object.values(roles.players)) for (const id of ids) active.add(id);
  const grace = policy.offline_grace_seconds;
  return {
    mode,
    targetTeams: teams,
    targetRoleId: typeof args.config.target_role_id === 'string' ? args.config.target_role_id : undefined,
    rolePlayers: roles.players,
    roleTeam: roles.teams,
    roleFallback: fallback.fallback,
    vacatedRoleIds: roles.vacated,
    playerUserId: target.playerUserId,
    holdersByTeam: holders,
    teamMembers: args.members,
    recipientsRingAll: args.recipients,
    online: (userId) =>
      onlineForAssignment({
        enginesOn: env.runBackgroundEngines,
        activeAssignee: active.has(userId),
        presenceOnline: sessionUserOnline(args.sessionId, userId, grace),
        bootGrace: inBootGrace(),
      }),
    busy: args.busy,
    heldForRole: (roleId) => {
      if (args.attemptNo < 2 || !env.runBackgroundEngines || inBootGrace()) return false;
      if (fallback.fallback === 'line') return false;
      const players = roles.players[roleId] ?? [];
      if (players.length === 0) return false;
      return players.every((id) => !sessionUserOnline(args.sessionId, id, grace));
    },
    policy,
  };
}

export async function owningTeamFor(sessionId: string, stakeholderId: string | null): Promise<string | null> {
  if (!stakeholderId) return null;
  const { data } = await supabaseAdmin.from('sessions').select('scenario_id').eq('id', sessionId).maybeSingle();
  if (!data?.scenario_id) return null;
  const scenario = await supabaseAdmin
    .from('scenarios')
    .select('initial_state')
    .eq('id', data.scenario_id)
    .maybeSingle();
  const stakeholders = (scenario.data?.initial_state as { stakeholders?: unknown } | null)?.stakeholders;
  if (!Array.isArray(stakeholders)) return null;
  for (const item of stakeholders) {
    if (!item || typeof item !== 'object') continue;
    const row = item as { id?: unknown; owning_team?: unknown };
    if (row.id === stakeholderId && typeof row.owning_team === 'string') return row.owning_team;
  }
  return null;
}

function legacyInput(args: {
  teams: string[];
  members: Record<string, Array<{ user_id: string; is_bot: boolean }>>;
  recipients: string[] | null;
  busy: (userId: string) => boolean;
}): RingSetInput {
  return {
    mode: 'ring_all',
    targetTeams: args.teams,
    rolePlayers: {},
    roleTeam: {},
    roleFallback: 'none',
    holdersByTeam: {},
    teamMembers: args.members,
    recipientsRingAll: args.recipients,
    online: () => true,
    busy: args.busy,
    policy: DEFAULT_CALL_POLICY,
  };
}
