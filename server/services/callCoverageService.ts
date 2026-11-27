import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { env } from '../env.js';
import { isBoothJoinToken } from '../lib/boothLink.js';
import {
  computeCallCoverage,
  type CallCoverage,
  type CoverageEnv,
  type CoverageInject,
} from '../../shared/sessionCallCoverage.js';
import { parsePlayerRoles } from './roles/roleCore.js';
import { rolesFeatureReady } from './roles/rolesSchema.js';
import { listLines } from './calls/lineService.js';
import { listRoleAssignments } from './roles/roleService.js';
import { resolveUniversalLine } from './calls/lineCore.js';
import { sessionUserOnline } from './presence/sessionPresenceService.js';

const NOT_APPLICABLE: CallCoverage = {
  applies: false,
  mode: 'warn',
  covered: true,
  items: [],
  load: [],
  warnings: [],
};

export async function getSessionCallCoverage(sessionId: string): Promise<CallCoverage> {
  const { data: session } = await supabaseAdmin
    .from('sessions')
    .select('id, scenario_id, start_time, join_token')
    .eq('id', sessionId)
    .maybeSingle();
  if (!session || !session.scenario_id || session.start_time || isBoothJoinToken(session.join_token as string | null)) {
    return NOT_APPLICABLE;
  }
  if (!(await rolesFeatureReady())) return NOT_APPLICABLE;
  const { data: scenario } = session.scenario_id
    ? await supabaseAdmin.from('scenarios').select('initial_state').eq('id', session.scenario_id).maybeSingle()
    : { data: null };
  const initial = (scenario?.initial_state ?? {}) as Record<string, unknown>;
  const roles = parsePlayerRoles(initial.player_roles);
  const gate = initial.call_coverage_gate === 'enforce' || initial.call_coverage_gate === 'warn'
    ? initial.call_coverage_gate
    : null;
  const { data: injectRows } = await supabaseAdmin
    .from('scenario_injects')
    .select('id, title, trigger_time_minutes, conditions_to_appear, trigger_condition, inject_scope, target_teams, delivery_config')
    .eq('scenario_id', session.scenario_id)
    .is('session_id', null);
  const stakeholders = Array.isArray(initial.stakeholders) ? initial.stakeholders : [];
  const { data: teamRows } = await supabaseAdmin
    .from('session_teams')
    .select('team_name, user_id')
    .eq('session_id', sessionId);
  const userIds = [...new Set((teamRows ?? []).map((row) => String(row.user_id)))];
  const profiles = await profilesFor(userIds);
  const sessionTeams = [...new Set((teamRows ?? []).map((row) => String(row.team_name)))];
  const teams = sessionTeams.map((team) => ({
    team_name: team,
    members: (teamRows ?? [])
      .filter((row) => row.team_name === team)
      .map((row) => {
        const profile = profiles.get(String(row.user_id));
        return {
          user_id: String(row.user_id),
          name: profile?.name ?? 'Player',
          online: sessionUserOnline(sessionId, String(row.user_id)),
          is_bot: profile?.is_bot === true,
        };
      }),
  }));
  const lines = (await listLines(sessionId)).map((line) => ({
    team_name: line.team_name,
    holders: line.holders.map((holder) => ({
      user_id: holder.user_id,
      name: holder.name,
      online: holder.online,
      is_bot: holder.is_bot,
    })),
  }));
  const assignments = (await listRoleAssignments(sessionId)).flatMap((role) =>
    role.players.map((player) => ({
      role_id: role.role_id,
      user_id: player.user_id,
      name: player.name,
      online: player.online,
    })),
  );
  const injects: CoverageInject[] = ((injectRows ?? []) as Array<Record<string, unknown>>).map((row) => {
    const config = (row.delivery_config ?? {}) as Record<string, unknown>;
    const app = typeof config.app === 'string' ? config.app : '';
    const targetTeams = Array.isArray(row.target_teams) ? row.target_teams.map(String) : [];
    const roleId = typeof config.target_role_id === 'string' ? config.target_role_id : null;
    const callTarget = config.call_target as { mode?: unknown } | undefined;
    const mode = callTarget?.mode;
    const owning = owningTeam(stakeholders, config.stakeholder_id);
    let teams = targetTeams.filter((team) => team && team !== 'all' && !team.startsWith('org:'));
    if (app === 'phone_call' && !roleId && teams.length === 0 && mode !== 'ring_all' && mode !== 'player') {
      const resolved = resolveUniversalLine({
        owningTeam: owning,
        stakeholderTeam: typeof config.stakeholder_team === 'string' ? config.stakeholder_team : null,
        sessionTeams,
      });
      if (resolved.team) teams = [resolved.team];
    }
    const role = roles.find((item) => item.role_id === roleId);
    if (role && teams.length === 0) teams = [role.team_name];
    const redial = config.redial as { attempts?: unknown; interval_minutes?: unknown } | undefined;
    return {
      id: String(row.id),
      title: String(row.title ?? 'Inject'),
      app,
      trigger_time_minutes: (row.trigger_time_minutes as number | null) ?? null,
      conditions_to_appear: row.conditions_to_appear,
      trigger_condition: (row.trigger_condition as string | null) ?? null,
      target_role_id: roleId,
      teams,
      call_target_mode:
        mode === 'line' || mode === 'role' || mode === 'player' || mode === 'ring_all' ? mode : null,
      chain_of_timed_root: config.chain_of_timed_root === true,
      redial:
        redial && typeof redial.attempts === 'number'
          ? {
              attempts: redial.attempts,
              interval_minutes: typeof redial.interval_minutes === 'number' ? redial.interval_minutes : 0,
            }
          : null,
    };
  });
  return computeCallCoverage({
    beforeStart: true,
    booth: false,
    envGate: envGate(),
    scenarioGate: gate,
    roles,
    injects,
    roleAssignments: assignments,
    lines,
    teams,
  });
}

function envGate(): CoverageEnv {
  if (env.callCoverageGate === 'warn' || env.callCoverageGate === 'off') return env.callCoverageGate;
  return 'enforce';
}

function owningTeam(stakeholders: unknown[], stakeholderId: unknown): string | null {
  if (typeof stakeholderId !== 'string') return null;
  for (const item of stakeholders) {
    if (!item || typeof item !== 'object') continue;
    const row = item as { id?: unknown; owning_team?: unknown };
    if (row.id === stakeholderId && typeof row.owning_team === 'string') return row.owning_team;
  }
  return null;
}

async function profilesFor(ids: string[]): Promise<Map<string, { name: string; is_bot: boolean }>> {
  const profiles = new Map<string, { name: string; is_bot: boolean }>();
  if (ids.length === 0) return profiles;
  const { data } = await supabaseAdmin.from('user_profiles').select('id, full_name, is_bot').in('id', ids);
  for (const row of data ?? []) {
    profiles.set(String(row.id), { name: String(row.full_name ?? 'Player'), is_bot: row.is_bot === true });
  }
  return profiles;
}
