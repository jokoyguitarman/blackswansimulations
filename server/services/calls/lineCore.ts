/**
 * Who a call attempt rings, and who a role-targeted message is delivered to.
 * `ring_all` keeps the pre-WP12 behaviour: one group per targeted team, drawn
 * from the resolved recipients. Role and line modes are resolved here.
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

/** Defaults from the team-line policy. A session override replaces these field by field. */
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

export const BOOT_GRACE_SECONDS = 120;

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
  /** Roles whose last player was removed. Empty players without this flag are unassigned. */
  vacatedRoleIds?: string[];
  playerUserId?: string;
  holdersByTeam: Record<string, string[]>;
  teamMembers: Record<string, Array<{ user_id: string; is_bot: boolean }>>;
  /** Null means session-wide: every non-bot member of each targeted team. */
  recipientsRingAll: string[] | null;
  online: (userId: string) => boolean;
  busy: (userId: string) => boolean;
  /** A role redial stays scheduled while every role player is offline. */
  heldForRole?: (roleId: string) => boolean;
  policy: CallPolicy;
}

export interface MessageRecipientInput {
  app: 'email' | 'npc_dm' | 'messenger_dm' | 'group_chat' | 'phone_call';
  mode: TargetMode;
  targetRoleId?: string;
  rolePlayers: Record<string, string[]>;
  roleTeam: Record<string, string>;
  roleNames?: Record<string, string>;
  vacatedRoleIds?: string[];
  roleFallback: RoleFallback;
  /** Every assigned role player is offline past the grace. Messages ignore this unless fallback is `line`. */
  rolePlayersOffline?: boolean;
  playerUserId?: string;
  targetTeams: string[];
  teamMembers: Record<string, Array<{ user_id: string; is_bot: boolean; name?: string }>>;
  resolvedUserIds: string[] | null;
}

export interface MessageRecipients {
  changed: boolean;
  userIds: string[] | null;
  teamNames: string[];
  mention: string;
  target_role_id: string | null;
  line_team: string | null;
  fallback_reason?: FallbackReason;
  undeliverable: boolean;
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

export function resolveTargetMode(config: {
  target_role_id?: unknown;
  call_target?: { mode?: unknown; user_id?: unknown } | null;
}): { mode: TargetMode; playerUserId?: string; roleFallback: RoleFallback; roleFallbackMinutes: number | null } {
  const explicit = config.call_target?.mode;
  const playerUserId =
    typeof config.call_target?.user_id === 'string' ? config.call_target.user_id : undefined;
  let mode: TargetMode;
  if (explicit === 'player' || explicit === 'ring_all' || explicit === 'line' || explicit === 'role') {
    mode = explicit;
  } else if (typeof config.target_role_id === 'string' && config.target_role_id) {
    mode = 'role';
  } else {
    mode = 'line';
  }
  return {
    mode,
    playerUserId,
    roleFallback: readFallback(config).fallback,
    roleFallbackMinutes: readFallback(config).minutes,
  };
}

export function readFallback(config: object): { fallback: RoleFallback; minutes: number | null } {
  const raw = config as { role_fallback?: unknown; role_fallback_minutes?: unknown };
  const fallback: RoleFallback =
    raw.role_fallback === 'line' || raw.role_fallback === 'line_after_minutes' ? raw.role_fallback : 'none';
  const minutes =
    typeof raw.role_fallback_minutes === 'number' && raw.role_fallback_minutes >= 1 && raw.role_fallback_minutes <= 60
      ? Math.floor(raw.role_fallback_minutes)
      : null;
  return { fallback, minutes };
}

/**
 * One group per call to create. `ring_all` is the legacy path and does not consult holders.
 */
export function resolveCallRingSet(input: RingSetInput): RingGroup[] {
  if (input.mode === 'ring_all') return resolveRingAll(input);
  if (input.mode === 'player') return [resolvePlayer(input)];
  if (input.mode === 'role') return [resolveRole(input)];
  const teams = concreteTeamNames(input.targetTeams);
  if (teams.length === 0) {
    return [emptyGroup(null, null, 'line_unattended', 'line')];
  }
  return teams.map((team) => resolveLine(input, team));
}

/** Owning team, then the stakeholder team, otherwise the legacy ring-all warning. */
export function resolveUniversalLine(input: {
  owningTeam?: string | null;
  stakeholderTeam?: string | null;
  sessionTeams: readonly string[];
}): { team: string | null; warn: boolean } {
  const known = new Set(input.sessionTeams);
  if (input.owningTeam && known.has(input.owningTeam)) return { team: input.owningTeam, warn: false };
  if (input.stakeholderTeam && input.stakeholderTeam.trim()) {
    return { team: input.stakeholderTeam, warn: false };
  }
  return { team: null, warn: true };
}

export function resolveMessageRecipients(input: MessageRecipientInput): MessageRecipients {
  const teams = concreteTeamNames(input.targetTeams);
  const unchanged: MessageRecipients = {
    changed: false,
    userIds: input.resolvedUserIds,
    teamNames: teams,
    mention: '',
    target_role_id: null,
    line_team: null,
    undeliverable: false,
  };
  if (input.mode === 'ring_all' || input.mode === 'line') return unchanged;
  if (input.mode === 'player') {
    if (!input.playerUserId) return { ...unchanged, changed: true, userIds: [], undeliverable: true };
    return { ...unchanged, changed: true, userIds: [input.playerUserId] };
  }
  return resolveRoleMessage(input, teams);
}

export interface AutofillTeam {
  team_name: string;
  holders: readonly string[];
  members: ReadonlyArray<{ user_id: string; is_bot: boolean; online: boolean }>;
}

export function pickAutofill(input: {
  teams: readonly AutofillTeam[];
  teamNames?: readonly string[];
  randomInt: (exclusiveMax: number) => number;
  presenceEnabled: boolean;
}): { ok: true; picks: Array<{ team_name: string; user_id: string }> } | { ok: false; code: 'presence_unavailable' } {
  if (!input.presenceEnabled) return { ok: false, code: 'presence_unavailable' };
  const limit = input.teamNames ? new Set(input.teamNames) : null;
  const picks: Array<{ team_name: string; user_id: string }> = [];
  for (const team of input.teams) {
    if (limit && !limit.has(team.team_name)) continue;
    if (team.holders.length > 0) continue;
    const eligible = team.members.filter((member) => !member.is_bot && member.online);
    if (eligible.length === 0) continue;
    const index = input.randomInt(eligible.length);
    const chosen = eligible[Math.min(Math.max(index, 0), eligible.length - 1)];
    if (chosen) picks.push({ team_name: team.team_name, user_id: chosen.user_id });
  }
  return { ok: true, picks };
}

export type ReassignPlan =
  | { action: 'none' }
  | { action: 'skip_engines' }
  | { action: 'skip_boot_grace' }
  | { action: 'unattended' }
  | { action: 'reassign'; deactivate: string[]; assign: string };

export function planOfflineReassignment(input: {
  holders: ReadonlyArray<{ user_id: string; online: boolean }>;
  members: ReadonlyArray<{ user_id: string; is_bot: boolean; online: boolean }>;
  enginesOn: boolean;
  bootGrace: boolean;
  reassignOnOffline: boolean;
  randomInt: (exclusiveMax: number) => number;
}): ReassignPlan {
  if (!input.enginesOn) return { action: 'skip_engines' };
  if (input.bootGrace) return { action: 'skip_boot_grace' };
  const onlineHolders = input.holders.filter((holder) => holder.online);
  if (onlineHolders.length > 0) return { action: 'none' };
  if (!input.reassignOnOffline) return { action: 'unattended' };
  const dropping = new Set(input.holders.map((holder) => holder.user_id));
  const eligible = input.members.filter(
    (member) => !member.is_bot && member.online && !dropping.has(member.user_id),
  );
  if (eligible.length === 0) return { action: 'unattended' };
  const chosen = eligible[Math.min(Math.max(input.randomInt(eligible.length), 0), eligible.length - 1)];
  if (!chosen) return { action: 'unattended' };
  return {
    action: 'reassign',
    deactivate: input.holders.filter((holder) => !holder.online).map((holder) => holder.user_id),
    assign: chosen.user_id,
  };
}

/** Two writers that observed the same version: only the one that still matches succeeds. */
export function claimLineVersion(current: number, expected: number): { ok: boolean; next: number } {
  if (current !== expected) return { ok: false, next: current };
  return { ok: true, next: current + 1 };
}

export function midRingHolderDelta(input: {
  previousHolders: readonly string[];
  nextHolders: readonly string[];
  ringNewHolders: boolean;
}): { ring: string[]; withdraw: string[] } {
  const previous = new Set(input.previousHolders);
  const next = new Set(input.nextHolders);
  return {
    withdraw: input.previousHolders.filter((id) => !next.has(id)),
    ring: input.ringNewHolders ? input.nextHolders.filter((id) => !previous.has(id)) : [],
  };
}

export function callbackAllowed(input: {
  callbackBy: CallPolicy['callback_by'];
  isTeamMember: boolean;
  isHolder: boolean;
  isRoleCall: boolean;
  isRolePlayer: boolean;
}): { allowed: boolean; code?: 'callback_not_allowed' } {
  if (input.isRoleCall && input.isRolePlayer) return { allowed: true };
  if (input.callbackBy === 'any_team_member' && input.isTeamMember) return { allowed: true };
  if (!input.isRoleCall && input.callbackBy === 'line_holders' && input.isHolder) return { allowed: true };
  if (input.isRoleCall && input.callbackBy === 'line_holders' && input.isRolePlayer) return { allowed: true };
  return { allowed: false, code: 'callback_not_allowed' };
}

/**
 * Engines-off processes have an empty socket map. Active assignees stay "online"
 * so a ring is not rewritten, and boot grace does the same for reassignment and fallback.
 */
export function onlineForAssignment(input: {
  enginesOn: boolean;
  activeAssignee: boolean;
  presenceOnline: boolean;
  bootGrace: boolean;
}): boolean {
  if (input.bootGrace) return true;
  if (!input.enginesOn && input.activeAssignee) return true;
  return input.presenceOnline;
}

export function mergeCallPolicy(override: Partial<CallPolicy> | null | undefined): CallPolicy {
  return { ...DEFAULT_CALL_POLICY, ...(override ?? {}) };
}

/** Who a missed attempt is recorded against when nobody was actually rung. */
export function audienceForAttempt(input: {
  outcome: RingOutcome;
  ring: readonly string[];
  callWaiting: readonly string[];
  rolePlayers: readonly string[];
  holders: readonly string[];
  teamMembers: readonly string[];
}): string[] {
  if (input.outcome === 'role_offline') return dedupe(input.rolePlayers);
  if (input.outcome === 'line_unattended') {
    const holders = dedupe(input.holders);
    return holders.length > 0 ? holders : dedupe(input.teamMembers);
  }
  return dedupe([...input.ring, ...input.callWaiting]);
}

/** Team Recents. Addressed users and role players always see their own calls. */
export function recentsVisible(input: {
  lineLog: CallPolicy['line_log_visible_to'];
  isStaff: boolean;
  isAnswerer: boolean;
  isAddressed: boolean;
  isTeamMember: boolean;
  isHolder: boolean;
  isRolePlayer: boolean;
}): boolean {
  if (input.isStaff || input.isAnswerer || input.isAddressed || input.isRolePlayer) return true;
  if (input.lineLog === 'team' && input.isTeamMember) return true;
  if (input.lineLog === 'line_holders' && input.isHolder) return true;
  return false;
}

/**
 * A later attempt keeps the inject's fallback. An attempt that already fell
 * back stays on the line.
 */
export function redialRingConfig(input: {
  injectTargetMode?: string | null;
  roleFallback?: string | null;
  fallbackReason?: string | null;
  targetRoleId?: string | null;
  lineTeam?: string | null;
  playerUserId?: string | null;
}): {
  mode: TargetMode;
  target_role_id?: string;
  role_fallback: RoleFallback;
  stakeholder_team?: string;
  playerUserId?: string;
} {
  const fallback: RoleFallback =
    input.roleFallback === 'line' || input.roleFallback === 'line_after_minutes' ? input.roleFallback : 'none';
  if (input.fallbackReason) {
    return {
      mode: 'line',
      role_fallback: fallback,
      ...(input.lineTeam ? { stakeholder_team: input.lineTeam } : {}),
    };
  }
  const mode: TargetMode =
    input.injectTargetMode === 'role' ||
    input.injectTargetMode === 'line' ||
    input.injectTargetMode === 'player' ||
    input.injectTargetMode === 'ring_all'
      ? input.injectTargetMode
      : input.targetRoleId
        ? 'role'
        : 'line';
  return {
    mode,
    ...(mode === 'role' && input.targetRoleId ? { target_role_id: input.targetRoleId } : {}),
    role_fallback: fallback,
    ...(input.lineTeam ? { stakeholder_team: input.lineTeam } : {}),
    ...(mode === 'player' && input.playerUserId ? { playerUserId: input.playerUserId } : {}),
  };
}

function resolveRingAll(input: RingSetInput): RingGroup[] {
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
  const members = humans(input, team);
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

function resolvePlayer(input: RingSetInput): RingGroup {
  const userId = input.playerUserId;
  if (!userId) return emptyGroup(null, null, 'line_unattended', 'player');
  if (!input.online(userId)) return emptyGroup(null, null, 'line_unattended', 'player');
  if (input.busy(userId)) {
    return {
      line_team: null,
      target_role_id: null,
      ring: [],
      call_waiting: [userId],
      outcome: 'line_busy',
      mode_used: 'player',
    };
  }
  return {
    line_team: null,
    target_role_id: null,
    ring: [userId],
    call_waiting: [],
    outcome: 'ring',
    mode_used: 'player',
  };
}

function resolveRole(input: RingSetInput): RingGroup {
  const roleId = input.targetRoleId ?? '';
  const known = roleId in input.roleTeam || roleId in input.rolePlayers;
  const team = input.roleTeam[roleId] ?? concreteTeamNames(input.targetTeams)[0] ?? null;
  if (!roleId || !known) {
    if (!team) return { ...emptyGroup(null, roleId || null, 'line_unattended', 'role'), fallback_reason: 'unknown_role' };
    return withFallback(resolveLine(input, team), roleId, 'unknown_role');
  }
  const players = dedupe(input.rolePlayers[roleId] ?? []);
  if (players.length === 0) {
    const reason: FallbackReason = (input.vacatedRoleIds ?? []).includes(roleId) ? 'role_vacated' : 'role_unassigned';
    if (!team) return { ...emptyGroup(null, roleId, 'line_unattended', 'role'), fallback_reason: reason };
    return withFallback(resolveLine(input, team), roleId, reason);
  }
  const online = players.filter((id) => input.online(id));
  if (online.length === 0 && input.roleFallback === 'line') {
    if (!team) return { ...emptyGroup(null, roleId, 'role_offline', 'role'), fallback_reason: 'role_offline_fallback' };
    return withFallback(resolveLine(input, team), roleId, 'role_offline_fallback');
  }
  if (input.heldForRole?.(roleId)) {
    return {
      line_team: team,
      target_role_id: roleId,
      ring: [],
      call_waiting: [],
      outcome: 'held',
      mode_used: 'role',
    };
  }
  const ring = online.filter((id) => !input.busy(id));
  const waiting = online.filter((id) => input.busy(id));
  if (ring.length > 0) {
    return { line_team: team, target_role_id: roleId, ring, call_waiting: [], outcome: 'ring', mode_used: 'role' };
  }
  if (waiting.length > 0) {
    return {
      line_team: team,
      target_role_id: roleId,
      ring: [],
      call_waiting: waiting,
      outcome: 'role_busy',
      mode_used: 'role',
    };
  }
  return {
    line_team: team,
    target_role_id: roleId,
    ring: [],
    call_waiting: [],
    outcome: 'role_offline',
    mode_used: 'role',
  };
}

function resolveLine(input: RingSetInput, team: string): RingGroup {
  const memberIds = new Set(humans(input, team));
  const humanHolders = dedupe(input.holdersByTeam[team] ?? []).filter(
    (id) => !isBot(input, team, id) && (memberIds.size === 0 || memberIds.has(id)),
  );
  const online = humanHolders.filter((id) => input.online(id));
  const ring = online.filter((id) => !input.busy(id));
  const waiting = online.filter((id) => input.busy(id));
  if (ring.length > 0) {
    return { line_team: team, target_role_id: null, ring, call_waiting: [], outcome: 'ring', mode_used: 'line' };
  }
  if (waiting.length > 0 && input.policy.overflow_when_busy) {
    const holderSet = new Set(humanHolders);
    const overflow = humans(input, team).filter((id) => !holderSet.has(id) && input.online(id) && !input.busy(id));
    if (overflow.length > 0) {
      return { line_team: team, target_role_id: null, ring: overflow, call_waiting: [], outcome: 'ring', mode_used: 'line' };
    }
  }
  if (waiting.length > 0) {
    return {
      line_team: team,
      target_role_id: null,
      ring: [],
      call_waiting: waiting,
      outcome: 'line_busy',
      mode_used: 'line',
    };
  }
  return emptyGroup(team, null, 'line_unattended', 'line');
}

function resolveRoleMessage(input: MessageRecipientInput, teams: string[]): MessageRecipients {
  const roleId = input.targetRoleId ?? '';
  const known = roleId in input.roleTeam || roleId in input.rolePlayers;
  const team = input.roleTeam[roleId] ?? teams[0] ?? null;
  const base = {
    changed: true,
    mention: '',
    target_role_id: roleId || null,
    line_team: team,
    undeliverable: false,
  };
  if (!roleId || !known) {
    if (!team) return { ...base, userIds: [], teamNames: [], undeliverable: true, fallback_reason: 'unknown_role' };
    return { ...base, ...teamDelivery(input, team), fallback_reason: 'unknown_role' };
  }
  const players = dedupe(input.rolePlayers[roleId] ?? []);
  if (players.length === 0) {
    const reason: FallbackReason = (input.vacatedRoleIds ?? []).includes(roleId) ? 'role_vacated' : 'role_unassigned';
    if (!team) return { ...base, userIds: [], teamNames: [], undeliverable: true, fallback_reason: reason };
    return { ...base, ...teamDelivery(input, team), fallback_reason: reason };
  }
  if (input.roleFallback === 'line' && input.rolePlayersOffline) {
    if (!team) {
      return { ...base, userIds: players, teamNames: teams, fallback_reason: 'role_offline_fallback' };
    }
    return { ...base, ...teamDelivery(input, team), fallback_reason: 'role_offline_fallback' };
  }
  const names = players.map((id) => input.roleNames?.[id]).filter((name): name is string => Boolean(name));
  const mention = input.app === 'group_chat' && names.length > 0 ? `${names.map((name) => `@${name}`).join(' ')} ` : '';
  return {
    ...base,
    userIds: players,
    teamNames: team ? [team] : teams,
    mention,
    line_team: team,
  };
}

function teamDelivery(input: MessageRecipientInput, team: string): { userIds: string[]; teamNames: string[] } {
  const members = (input.teamMembers[team] ?? []).filter((member) => !member.is_bot).map((member) => member.user_id);
  return { userIds: dedupe(members), teamNames: [team] };
}

function humans(input: RingSetInput, team: string | null): string[] {
  if (!team) return [];
  return (input.teamMembers[team] ?? []).filter((member) => !member.is_bot).map((member) => member.user_id);
}

function isBot(input: RingSetInput, team: string, userId: string): boolean {
  return (input.teamMembers[team] ?? []).some((member) => member.user_id === userId && member.is_bot);
}

function emptyGroup(
  team: string | null,
  roleId: string | null,
  outcome: RingOutcome,
  mode: TargetMode,
): RingGroup {
  return {
    line_team: team,
    target_role_id: roleId,
    ring: [],
    call_waiting: [],
    outcome,
    mode_used: mode,
  };
}

function withFallback(group: RingGroup, roleId: string, reason: FallbackReason): RingGroup {
  return { ...group, target_role_id: roleId, fallback_reason: reason, mode_used: 'line' };
}
