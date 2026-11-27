// Pure lobby coverage gate for roles, team lines and team membership.
// Shared by the session start route and the lobby checklist.

export const CALL_COVERAGE_INCOMPLETE = 'CALL_COVERAGE_INCOMPLETE';

export type CoverageMode = 'enforce' | 'warn';
export type CoverageEnv = 'enforce' | 'warn' | 'off';
export type CoverageKind = 'role' | 'line' | 'team';
export type CoverageReason = 'no_player' | 'no_member' | 'no_line_holder' | 'too_many_players';
export type LoadLevel = 'ok' | 'high' | 'overloaded';

const ROLE_APPS = new Set(['phone_call', 'email', 'npc_dm', 'messenger_dm', 'group_chat']);
const MESSAGE_APPS = new Set(['email', 'npc_dm', 'messenger_dm', 'group_chat']);

export interface CoverageAssignee {
  user_id: string;
  name: string;
  online: boolean;
}

export interface CoverageNeededBy {
  inject_id: string;
  title: string;
  app: string;
  minute: number | null;
  branch_only: boolean;
}

export interface CoverageItem {
  kind: CoverageKind;
  key: string;
  label: string;
  team_name: string;
  required: boolean;
  satisfied: boolean;
  assignees: CoverageAssignee[];
  reason?: CoverageReason;
  needed_by: CoverageNeededBy[];
}

export interface CoverageLoad {
  user_id: string;
  name: string;
  roles: string[];
  lines: string[];
  scheduled_contacts: number;
  max_overlap: number;
  level: LoadLevel;
}

export interface CallCoverage {
  applies: boolean;
  mode: CoverageMode;
  covered: boolean;
  items: CoverageItem[];
  load: CoverageLoad[];
  warnings: string[];
}

export interface CoverageRoleDef {
  role_id: string;
  title: string;
  team_name: string;
  max_per_session?: number;
}

export interface CoveragePerson {
  user_id: string;
  name: string;
  online: boolean;
  is_bot?: boolean;
}

export interface CoverageInject {
  id: string;
  title: string;
  app: string;
  trigger_time_minutes?: number | null;
  conditions_to_appear?: unknown;
  trigger_condition?: string | null;
  target_role_id?: string | null;
  /** Concrete teams this inject addresses. Universal calls are already resolved. */
  teams?: string[];
  call_target_mode?: 'line' | 'role' | 'player' | 'ring_all' | null;
  chain_of_timed_root?: boolean;
  redial_of_timed_root?: boolean;
  redial?: { attempts?: number; interval_minutes?: number } | null;
}

export interface CallCoverageInput {
  beforeStart: boolean;
  booth: boolean;
  envGate: CoverageEnv;
  /** null when the scenario has not opted in. */
  scenarioGate: 'enforce' | 'warn' | null;
  roles: readonly CoverageRoleDef[];
  injects: readonly CoverageInject[];
  roleAssignments: ReadonlyArray<{ role_id: string; user_id: string; name: string; online: boolean; is_bot?: boolean }>;
  lines: ReadonlyArray<{ team_name: string; holders: readonly CoveragePerson[] }>;
  teams: ReadonlyArray<{ team_name: string; members: readonly CoveragePerson[] }>;
}

export interface StartOverrideRecord {
  by: string;
  at: string;
  warnings: string[];
}

interface Gap {
  kind: CoverageKind;
  key: string;
  label: string;
}

export function computeCallCoverage(input: CallCoverageInput): CallCoverage {
  const mode = gateMode(input.envGate, input.scenarioGate);
  const relevant = input.injects.filter(isRelevant);
  const applies =
    input.beforeStart && !input.booth && input.envGate !== 'off' && relevant.length > 0;
  if (!applies) {
    return { applies: false, mode, covered: true, items: [], load: [], warnings: [] };
  }

  const roles = new Map(input.roles.map((role) => [role.role_id, role]));
  const membersByTeam = new Map(input.teams.map((team) => [team.team_name, humans(team.members)]));
  const holdersByTeam = new Map(input.lines.map((line) => [line.team_name, humans(line.holders)]));
  const assignments = input.roleAssignments.filter((row) => row.is_bot !== true);

  const roleNeeds = new Map<string, CoverageNeededBy[]>();
  const lineNeeds = new Map<string, CoverageNeededBy[]>();
  const teamNeeds = new Map<string, CoverageNeededBy[]>();

  for (const inject of relevant) {
    const branchOnly = !isUnconditional(inject);
    const needed = needOf(inject, branchOnly);
    const roleId = inject.target_role_id ?? null;
    if (roleId && (inject.call_target_mode == null || inject.call_target_mode === 'role' || inject.app !== 'phone_call')) {
      pushNeed(roleNeeds, roleId, needed);
    }
    const modeUsed = phoneMode(inject);
    if (inject.app === 'phone_call' && modeUsed === 'line') {
      for (const team of inject.teams ?? []) pushNeed(lineNeeds, team, needed);
    }
    if (MESSAGE_APPS.has(inject.app) && !roleId) {
      for (const team of inject.teams ?? []) pushNeed(teamNeeds, team, needed);
    }
  }

  const items: CoverageItem[] = [];
  for (const [roleId, needed] of roleNeeds) {
    const role = roles.get(roleId);
    const required = needed.some((row) => !row.branch_only);
    const players = assignments.filter((row) => row.role_id === roleId);
    const max = role?.max_per_session ?? 1;
    let reason: CoverageReason | undefined;
    if (players.length === 0) reason = 'no_player';
    else if (players.length > max) reason = 'too_many_players';
    items.push({
      kind: 'role',
      key: roleId,
      label: role?.title || roleId,
      team_name: role?.team_name ?? '',
      required,
      satisfied: !reason,
      assignees: players.map(asAssignee),
      ...(reason ? { reason } : {}),
      needed_by: needed,
    });
  }
  for (const [team, needed] of lineNeeds) {
    const members = membersByTeam.get(team) ?? [];
    const holders = holdersByTeam.get(team) ?? [];
    const required = needed.some((row) => !row.branch_only);
    const reason: CoverageReason | undefined =
      members.length === 0 ? 'no_member' : holders.length === 0 ? 'no_line_holder' : undefined;
    items.push({
      kind: 'line',
      key: team,
      label: team,
      team_name: team,
      required,
      satisfied: !reason,
      assignees: holders.map(asAssignee),
      ...(reason ? { reason } : {}),
      needed_by: needed,
    });
  }
  for (const [team, needed] of teamNeeds) {
    const members = membersByTeam.get(team) ?? [];
    const required = needed.some((row) => !row.branch_only);
    const reason: CoverageReason | undefined = members.length === 0 ? 'no_member' : undefined;
    items.push({
      kind: 'team',
      key: team,
      label: team,
      team_name: team,
      required,
      satisfied: !reason,
      assignees: members.map(asAssignee),
      ...(reason ? { reason } : {}),
      needed_by: needed,
    });
  }

  const load = buildLoad(input, assignments, holdersByTeam, relevant);
  const warnings = buildWarnings(items, load);
  const covered = items.filter((item) => item.required).every((item) => item.satisfied);
  return { applies: true, mode, covered, items, load, warnings };
}

/** Gaps block only in enforce mode. Warn mode and a turned-off gate never block. */
export function coverageBlocksStart(coverage: CallCoverage): boolean {
  return coverage.applies && coverage.mode === 'enforce' && !coverage.covered;
}

/** An acknowledged override starts an enforce-mode session that still has gaps. */
export function mayStart(coverage: CallCoverage, acknowledge: boolean): boolean {
  if (!coverageBlocksStart(coverage)) return true;
  return acknowledge;
}

export function buildStartOverride(
  by: string,
  at: string,
  coverage: CallCoverage,
): StartOverrideRecord {
  return { by, at, warnings: gapLabels(coverage) };
}

export function startWithUnfilledPayload(coverage: CallCoverage): {
  event_type: 'start_with_unfilled';
  metadata: { items: Gap[] };
} {
  return {
    event_type: 'start_with_unfilled',
    metadata: {
      items: coverage.items
        .filter((item) => item.required && !item.satisfied)
        .map((item) => ({ kind: item.kind, key: item.key, label: item.label })),
    },
  };
}

export function coverageError(coverage: CallCoverage): string {
  const gaps = coverage.items.filter((item) => item.required && !item.satisfied);
  const n = gaps.length;
  if (n === 0) return '';
  const names = gaps
    .slice(0, 3)
    .map((item) => item.label)
    .join(', ');
  return `Can't start yet: ${n} call or message assignment${n === 1 ? '' : 's'} still open (${names}).`;
}

function gateMode(envGate: CoverageEnv, scenarioGate: 'enforce' | 'warn' | null): CoverageMode {
  if (envGate === 'warn' || envGate === 'off') return 'warn';
  return scenarioGate === 'enforce' ? 'enforce' : 'warn';
}

function isRelevant(inject: CoverageInject): boolean {
  if (!ROLE_APPS.has(inject.app)) return false;
  if (inject.target_role_id) return true;
  if ((inject.teams ?? []).length === 0) return false;
  if (inject.app === 'phone_call' && (inject.call_target_mode === 'ring_all' || inject.call_target_mode === 'player')) {
    return false;
  }
  return true;
}

function isUnconditional(inject: CoverageInject): boolean {
  if (inject.chain_of_timed_root || inject.redial_of_timed_root) return true;
  if (hasConditions(inject.conditions_to_appear) || (inject.trigger_condition ?? '').trim()) return false;
  return inject.trigger_time_minutes != null;
}

function hasConditions(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (!value || typeof value !== 'object') return false;
  const record = value as { all?: unknown; conditions?: unknown };
  if (Array.isArray(record.all)) return record.all.length > 0;
  if (Array.isArray(record.conditions)) return record.conditions.length > 0;
  return false;
}

function phoneMode(inject: CoverageInject): 'line' | 'role' | 'player' | 'ring_all' | null {
  if (inject.app !== 'phone_call') return null;
  if (inject.call_target_mode) return inject.call_target_mode;
  if (inject.target_role_id) return 'role';
  return 'line';
}

function needOf(inject: CoverageInject, branchOnly: boolean): CoverageNeededBy {
  return {
    inject_id: inject.id,
    title: inject.title,
    app: inject.app,
    minute: inject.trigger_time_minutes ?? null,
    branch_only: branchOnly,
  };
}

function pushNeed(map: Map<string, CoverageNeededBy[]>, key: string, needed: CoverageNeededBy): void {
  const list = map.get(key) ?? [];
  list.push(needed);
  map.set(key, list);
}

function humans(people: readonly CoveragePerson[]): CoveragePerson[] {
  return people.filter((person) => person.is_bot !== true);
}

function asAssignee(person: { user_id: string; name: string; online: boolean }): CoverageAssignee {
  return { user_id: person.user_id, name: person.name, online: person.online };
}

function buildLoad(
  input: CallCoverageInput,
  assignments: CallCoverageInput['roleAssignments'],
  holdersByTeam: Map<string, CoveragePerson[]>,
  injects: CoverageInject[],
): CoverageLoad[] {
  const people = new Map<string, { name: string; roles: string[]; lines: string[]; teams: string[] }>();
  const touch = (userId: string, name: string) => {
    const row = people.get(userId) ?? { name, roles: [], lines: [], teams: [] };
    if (name) row.name = name;
    people.set(userId, row);
    return row;
  };
  for (const row of assignments) {
    const person = touch(row.user_id, row.name);
    if (!person.roles.includes(row.role_id)) person.roles.push(row.role_id);
  }
  for (const [team, holders] of holdersByTeam) {
    for (const holder of holders) {
      const person = touch(holder.user_id, holder.name);
      if (!person.lines.includes(team)) person.lines.push(team);
    }
  }
  for (const team of input.teams) {
    for (const member of humans(team.members)) {
      const person = touch(member.user_id, member.name);
      if (!person.teams.includes(team.team_name)) person.teams.push(team.team_name);
    }
  }

  return [...people.entries()]
    .map(([userId, person]) => {
      const minutes: number[] = [];
      let scheduled = 0;
      for (const inject of injects) {
        if (!isUnconditional(inject)) continue;
        if (!addressedTo(inject, userId, person, holdersByTeam)) continue;
        scheduled += 1;
        minutes.push(...callMinutes(inject));
      }
      const rolesAndLines = person.roles.length + person.lines.length;
      const maxOverlap = maxInWindow(minutes, 5);
      return {
        user_id: userId,
        name: person.name,
        roles: person.roles,
        lines: person.lines,
        scheduled_contacts: scheduled,
        max_overlap: maxOverlap,
        level: loadLevel(rolesAndLines, maxOverlap),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function addressedTo(
  inject: CoverageInject,
  userId: string,
  person: { roles: string[]; lines: string[]; teams: string[] },
  holdersByTeam: Map<string, CoveragePerson[]>,
): boolean {
  if (inject.target_role_id && person.roles.includes(inject.target_role_id)) return true;
  if (inject.app === 'phone_call' && phoneMode(inject) === 'line') {
    return (inject.teams ?? []).some(
      (team) => person.lines.includes(team) || holds(holdersByTeam, team, userId),
    );
  }
  if (MESSAGE_APPS.has(inject.app) && !inject.target_role_id) {
    return (inject.teams ?? []).some((team) => person.teams.includes(team));
  }
  return false;
}

function holds(holdersByTeam: Map<string, CoveragePerson[]>, team: string, userId: string): boolean {
  return (holdersByTeam.get(team) ?? []).some((holder) => holder.user_id === userId);
}

function callMinutes(inject: CoverageInject): number[] {
  if (inject.app !== 'phone_call' || inject.trigger_time_minutes == null) return [];
  const start = inject.trigger_time_minutes;
  const attempts = Math.max(1, inject.redial?.attempts ?? 1);
  const interval = inject.redial?.interval_minutes ?? 0;
  const minutes = [start];
  for (let i = 1; i < attempts; i++) minutes.push(start + i * interval);
  return minutes;
}

function maxInWindow(minutes: number[], window: number): number {
  if (minutes.length === 0) return 0;
  const sorted = [...minutes].sort((a, b) => a - b);
  let best = 1;
  for (let i = 0; i < sorted.length; i++) {
    let count = 1;
    for (let j = i + 1; j < sorted.length; j++) {
      if (sorted[j] - sorted[i] <= window) count += 1;
      else break;
    }
    if (count > best) best = count;
  }
  return best;
}

function loadLevel(assignments: number, overlap: number): LoadLevel {
  if (assignments >= 5 || overlap >= 3) return 'overloaded';
  if (assignments >= 3 || overlap >= 2) return 'high';
  return 'ok';
}

function buildWarnings(items: CoverageItem[], load: CoverageLoad[]): string[] {
  const warnings: string[] = [];
  for (const item of items) {
    if (!item.required) {
      const title = item.needed_by.find((row) => row.branch_only)?.title;
      warnings.push(
        `${item.label} is only needed if a branch fires${title ? ` (${title})` : ''}`,
      );
    }
    for (const assignee of item.assignees) {
      if (!assignee.online) warnings.push(`${assignee.name} is offline in the lobby`);
    }
  }
  const idle = load.find((row) => row.roles.length + row.lines.length === 0);
  for (const row of load) {
    if (row.level === 'ok') continue;
    const move = idle ? ` Consider moving a role to ${idle.name}: they hold nothing.` : '';
    warnings.push(
      `${row.name}: ${row.roles.length} roles + ${row.lines.length} lines · ${row.scheduled_contacts} contacts · overlap ${row.max_overlap} · ${row.level}.${move}`,
    );
  }
  return warnings;
}

function gapLabels(coverage: CallCoverage): string[] {
  return coverage.items
    .filter((item) => item.required && !item.satisfied)
    .map((item) => `${item.kind}:${item.key}`);
}
