/**
 * Who a call attempt rings. WP12 replaces the body of `resolveCallRingSet` with line
 * holders, roles and the `held` outcome. Until then every call uses `ring_all`: the
 * resolved recipients, one group per targeted team, so the call flow does not change
 * when that body is swapped.
 */

export type TargetMode = 'line' | 'role' | 'player' | 'ring_all';

export type RingOutcome =
  | 'ring'
  | 'line_busy'
  | 'line_unattended'
  | 'role_busy'
  | 'role_offline'
  | 'held';

export type RoleFallback = 'none' | 'line' | 'line_after_minutes';

export type FallbackReason =
  | 'role_unassigned'
  | 'role_vacated'
  | 'role_offline_fallback'
  | 'role_fallback_after_minutes'
  | 'trainer_reroute'
  | 'unknown_role';

/** Defaults from the team-line policy. WP12 reads the session override; WP5 only needs the shape. */
export interface CallPolicy {
  reassign_on_offline: boolean;
  offline_grace_seconds: number;
  role_offline_prompt: boolean;
  role_offline_auto_fallback_minutes: number | null;
  callback_by: 'any_team_member' | 'line_holders';
  show_line_holders: boolean;
  line_log_visible_to: 'team' | 'line_holders';
  missed_badge_for: 'line_holders' | 'team';
  overflow_when_busy: boolean;
  ring_new_holders_mid_ring: boolean;
}

export const DEFAULT_CALL_POLICY: CallPolicy = {
  reassign_on_offline: true,
  offline_grace_seconds: 60,
  role_offline_prompt: true,
  role_offline_auto_fallback_minutes: null,
  callback_by: 'any_team_member',
  show_line_holders: true,
  line_log_visible_to: 'team',
  missed_badge_for: 'line_holders',
  overflow_when_busy: false,
  ring_new_holders_mid_ring: true,
};

export interface RingGroup {
  line_team: string | null;
  target_role_id: string | null;
  ring: string[];
  call_waiting: string[];
  outcome: RingOutcome;
  mode_used: TargetMode;
  fallback_reason?: FallbackReason;
}

export interface RingSetInput {
  mode: TargetMode;
  targetTeams: string[];
  targetRoleId?: string;
  rolePlayers: Record<string, string[]>;
  roleTeam: Record<string, string>;
  roleFallback: RoleFallback;
  playerUserId?: string;
  holdersByTeam: Record<string, string[]>;
  teamMembers: Record<string, Array<{ user_id: string; is_bot: boolean }>>;
  /** Null means session-wide: every non-bot member of each targeted team. */
  recipientsRingAll: string[] | null;
  online: (userId: string) => boolean;
  busy: (userId: string) => boolean;
  /** WP12: a role redial stays scheduled while every role player is offline. */
  heldForRole?: (roleId: string) => boolean;
  policy: CallPolicy;
}

export function concreteTeamNames(teams: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const team of teams) {
    if (!team || team === 'all' || team.startsWith('org:') || seen.has(team)) continue;
    seen.add(team);
    out.push(team);
  }
  return out;
}

function dedupe(ids: readonly string[]): string[] {
  return Array.from(new Set(ids.filter(Boolean)));
}

/**
 * WP5 ring set. `mode`, holders, role players and `heldForRole` are accepted so WP12
 * can fill them in without changing `startInjectCall` or `ringScheduledAttempt`.
 * They do not change who rings yet: that is always the resolved recipients.
 */
export function resolveCallRingSet(input: RingSetInput): RingGroup[] {
  const teams = concreteTeamNames(input.targetTeams);
  const teamKeys: Array<string | null> = teams.length > 0 ? teams : [null];
  const groups = teamKeys.map((team) =>
    groupFor(input, team, teams.length === 1 ? input.recipientsRingAll : null),
  );
  const anyRecipient = groups.some((group) => group.ring.length > 0 || group.call_waiting.length > 0);
  if (!anyRecipient && input.recipientsRingAll && input.recipientsRingAll.length > 0) {
    return [partition(input, teams[0] ?? null, dedupe(input.recipientsRingAll))];
  }
  return groups;
}

function groupFor(
  input: RingSetInput,
  team: string | null,
  soleTeamRecipients: string[] | null,
): RingGroup {
  const members = team
    ? (input.teamMembers[team] ?? []).filter((member) => !member.is_bot).map((member) => member.user_id)
    : [];
  let pool: string[];
  if (input.recipientsRingAll == null) {
    pool = members;
  } else if (members.length > 0) {
    const allow = new Set(input.recipientsRingAll);
    pool = members.filter((id) => allow.has(id));
  } else if (soleTeamRecipients) {
    pool = soleTeamRecipients;
  } else if (team == null) {
    pool = input.recipientsRingAll;
  } else {
    pool = [];
  }
  return partition(input, team, dedupe(pool));
}

function partition(input: RingSetInput, team: string | null, pool: string[]): RingGroup {
  const online = pool.filter((id) => input.online(id));
  const ring = online.filter((id) => !input.busy(id));
  const callWaiting = online.filter((id) => input.busy(id));
  let outcome: RingOutcome = 'ring';
  if (ring.length === 0 && callWaiting.length > 0) outcome = 'line_busy';
  else if (ring.length === 0) outcome = 'line_unattended';
  return {
    line_team: team,
    target_role_id: null,
    ring,
    call_waiting: callWaiting,
    outcome,
    mode_used: 'ring_all',
  };
}
