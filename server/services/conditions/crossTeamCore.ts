/**
 * Cross-team profile, cascade depth and the §6.4 guards. No database access.
 * WP2 supplies dependency source teams by registering a resolver; until then a
 * `dependency_*` key contributes no source team.
 */

import { slugifyTeamName } from '../../../shared/conditionKeyGrammar.js';
import { parseConditionKey } from './conditionCatalog.js';

export interface CrossTeamTeam {
  /** Display name stored on the trigger row. */
  name: string;
  /** Defaults to the slug of `name`. */
  slug?: string;
  /** Scenario role ids that belong to this team (`|role=`). */
  role_ids?: readonly string[];
}

export interface CrossTeamInjectRef {
  target_teams?: readonly string[] | null;
}

export interface CrossTeamProfile {
  source_teams: string[];
  target_teams: string[];
  is_cross_team: boolean;
}

/** Full condition key in, team names or slugs out. */
export type SourceTeamResolver = (key: string) => readonly string[] | string | null | undefined;

export interface DepthTrigger {
  cause_depth?: number;
  source_teams?: readonly string[];
  target_teams?: readonly string[];
  origin?: string;
  is_cross_team?: boolean;
}

export interface CrossTeamCandidate {
  id?: string;
  inject_key?: string;
  severity?: string | null;
  /**
   * Minutes the cause has already been waiting. Among cross-team candidates of
   * equal severity, the older one takes the throttle slot. The publish list
   * itself stays in the order the scheduler handed in.
   */
  dependency_age?: number | null;
  minute: number;
  source_teams?: readonly string[];
  target_teams?: readonly string[];
  is_cross_team?: boolean;
  /** Authored clock inject. The guards never defer, hold or cancel it. */
  timed?: boolean;
  origin?: string;
  cause_depth?: number;
  met_keys?: readonly string[];
}

export interface RecentCrossTeamTrigger {
  inject_key: string;
  minute: number;
  source_teams?: readonly string[];
  target_teams?: readonly string[];
  origin?: string;
  is_cross_team?: boolean;
  cause_depth?: number;
}

export interface TeamDelivery {
  team: string;
  minute: number;
  timed?: boolean;
}

export interface CrossTeamGuardEnv {
  maxPerTeamWindow: number;
  windowMinutes: number;
  pressureMaxDeliveries10Min: number;
  loopWindowMinutes: number;
  maxCascadeDepth: number;
}

export type CrossTeamDeferReason = 'throttle' | 'pressure';

export interface CrossTeamGuardResult<T> {
  publish: T[];
  defer: Array<{ candidate: T; reason: CrossTeamDeferReason }>;
  hold: T[];
  cancel: Array<{ candidate: T; reason: 'cascade_cap' }>;
}

/** Non-timed deliveries inside this many minutes count toward the pressure ceiling. */
export const PRESSURE_WINDOW_MINUTES = 10;

const SEVERITY_RANK: Record<string, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

const resolvers = new Map<string, SourceTeamResolver>();

/**
 * `prefix` matches the key body (the text before `|`) with startsWith.
 * A trailing `*` is stripped first, so `dependency_*` matches dependency keys.
 * Returns a function that removes this registration.
 */
export function registerSourceTeamResolver(prefix: string, fn: SourceTeamResolver): () => void {
  const previous = resolvers.get(prefix);
  resolvers.set(prefix, fn);
  return () => {
    if (resolvers.get(prefix) !== fn) return;
    if (previous) resolvers.set(prefix, previous);
    else resolvers.delete(prefix);
  };
}

export function crossTeamProfile(
  inject: CrossTeamInjectRef,
  metKeys: readonly string[],
  teams: readonly CrossTeamTeam[],
): CrossTeamProfile {
  const source: string[] = [];
  for (const key of metKeys) {
    const scope = scopeOf(key);
    if (scope.team) pushTeam(source, canonicalTeamName(scope.team, teams));
    if (scope.role) {
      const roleTeam = teamNameForRole(scope.role, teams);
      if (roleTeam) pushTeam(source, roleTeam);
    }
    for (const name of resolverTeams(key, scope.body, teams)) pushTeam(source, name);
  }
  const target = (inject.target_teams ?? []).map((team) => team.trim()).filter(Boolean);
  return {
    source_teams: source,
    target_teams: target,
    is_cross_team: isCrossTeam(source, target),
  };
}

/** A recipient team that the firing keys are not about. */
export function isCrossTeam(
  sourceTeams: readonly string[],
  targetTeams: readonly string[],
): boolean {
  if (sourceTeams.length === 0 || targetTeams.length === 0) return false;
  return targetTeams.some((target) => !sourceTeams.some((source) => sameTeam(source, target)));
}

/** Inject keys named by a condition. Unknown keys, including unregistered `dependency_*`, name none. */
export function referencedInjectKeys(key: string): string[] {
  const parsed = parseConditionKey(key);
  if ('error' in parsed) return [];
  const params = parsed.def.params ?? [];
  const refs: string[] = [];
  params.forEach((param, index) => {
    const value = parsed.args[index];
    if (param.type === 'inject_key' && value) refs.push(value);
  });
  return refs;
}

/**
 * A hop is a referenced inject that was itself cross-team: its source and
 * target teams differ, or its origin is a dependency or director event.
 */
export function isCrossTeamHop(trigger: DepthTrigger | undefined): boolean {
  if (!trigger) return false;
  if (trigger.origin === 'dependency' || trigger.origin === 'director') return true;
  if (trigger.is_cross_team === true) return true;
  return isCrossTeam(trigger.source_teams ?? [], trigger.target_teams ?? []);
}

/**
 * Cross-team hops a stored row passes to the next inject.
 * A same-team row stores inherited hops + 1, so the extra 1 is not a hop.
 */
export function passedOnHops(trigger: DepthTrigger | undefined): number {
  if (!trigger) return 0;
  const depth = trigger.cause_depth ?? 0;
  if (isCrossTeamHop(trigger)) return depth;
  return Math.max(0, depth - 1);
}

/**
 * Depth written on this inject's trigger row: hops inherited from the met
 * keys, plus 1. For a cross-team, dependency, or director inject that extra 1
 * is its own hop and is what the cascade cap compares. A same-team row stores
 * the same shape (inherited hops + 1) so the next inject can recover the hops;
 * the cap does not apply to it.
 */
export function causeDepth(
  metKeys: readonly string[],
  triggersByKey: Readonly<Record<string, DepthTrigger | undefined>>,
): number {
  let inherited = 0;
  for (const key of metKeys) {
    for (const ref of referencedInjectKeys(key)) {
      const passed = passedOnHops(triggersByKey[ref]);
      if (passed > inherited) inherited = passed;
    }
  }
  return inherited + 1;
}

export function applyCrossTeamGuards<T extends CrossTeamCandidate>(
  candidates: readonly T[],
  recentTriggers: readonly RecentCrossTeamTrigger[],
  deliveriesByTeam: readonly TeamDelivery[],
  env: CrossTeamGuardEnv,
): CrossTeamGuardResult<T> {
  const ranked = candidates.map((candidate, index) => ({ candidate, index }));
  // Slot choice only. The lists returned below follow the input order so a
  // same-team inject keeps the place orderPublishCandidates gave it.
  ranked.sort((a, b) => {
    const severity = severityRank(b.candidate.severity) - severityRank(a.candidate.severity);
    if (severity !== 0) return severity;
    const age = (b.candidate.dependency_age ?? 0) - (a.candidate.dependency_age ?? 0);
    if (age !== 0) return age;
    return a.index - b.index;
  });

  const chosen: GuardChoice[] = candidates.map(() => ({ kind: 'publish' }));
  const pendingThrottle = new Map<string, number>();
  const pendingPressure = new Map<string, number>();

  for (const { candidate, index } of ranked) {
    if (isTimed(candidate)) continue;
    const capped = subjectToTeamCaps(candidate);
    const depth = candidate.cause_depth ?? 1;
    if (capped && depth > env.maxCascadeDepth) {
      chosen[index] = { kind: 'cancel' };
      continue;
    }
    if (loopHolds(candidate, recentTriggers, env)) {
      chosen[index] = { kind: 'hold' };
      continue;
    }
    const targets = candidate.target_teams ?? [];
    if (capped && targets.length > 0) {
      const throttled = targets.some(
        (team) =>
          throttleCount(team, candidate.minute, recentTriggers, pendingThrottle, env) >=
          env.maxPerTeamWindow,
      );
      if (throttled) {
        chosen[index] = { kind: 'defer', reason: 'throttle' };
        continue;
      }
      const pressured = targets.some(
        (team) =>
          pressureCount(team, candidate.minute, deliveriesByTeam, pendingPressure) >=
          env.pressureMaxDeliveries10Min,
      );
      if (pressured) {
        chosen[index] = { kind: 'defer', reason: 'pressure' };
        continue;
      }
    }
    for (const team of targets) {
      const key = teamKey(team);
      pendingPressure.set(key, (pendingPressure.get(key) ?? 0) + 1);
      if (capped) pendingThrottle.set(key, (pendingThrottle.get(key) ?? 0) + 1);
    }
  }

  const publish: T[] = [];
  const defer: Array<{ candidate: T; reason: CrossTeamDeferReason }> = [];
  const hold: T[] = [];
  const cancel: Array<{ candidate: T; reason: 'cascade_cap' }> = [];
  candidates.forEach((candidate, index) => {
    const choice = chosen[index] ?? { kind: 'publish' };
    if (choice.kind === 'defer') defer.push({ candidate, reason: choice.reason });
    else if (choice.kind === 'hold') hold.push(candidate);
    else if (choice.kind === 'cancel') cancel.push({ candidate, reason: 'cascade_cap' });
    else publish.push(candidate);
  });

  return { publish, defer, hold, cancel };
}

type GuardChoice =
  | { kind: 'publish' }
  | { kind: 'defer'; reason: CrossTeamDeferReason }
  | { kind: 'hold' }
  | { kind: 'cancel' };

function isTimed(candidate: CrossTeamCandidate): boolean {
  return candidate.timed === true || candidate.origin === 'timed';
}

function subjectToTeamCaps(candidate: CrossTeamCandidate): boolean {
  return candidateIsCrossTeam(candidate) || candidate.origin === 'director';
}

function candidateIsCrossTeam(candidate: CrossTeamCandidate): boolean {
  if (candidate.is_cross_team != null) return candidate.is_cross_team;
  return isCrossTeam(candidate.source_teams ?? [], candidate.target_teams ?? []);
}

function loopHolds(
  candidate: CrossTeamCandidate,
  recent: readonly RecentCrossTeamTrigger[],
  env: CrossTeamGuardEnv,
): boolean {
  if (!candidateIsCrossTeam(candidate)) return false;
  const sources = candidate.source_teams ?? [];
  const targets = candidate.target_teams ?? [];
  if (sources.length === 0 || targets.length === 0) return false;
  const opposingKeys = new Set<string>();
  for (const trigger of recent) {
    if (!withinWindow(candidate.minute, trigger.minute, env.loopWindowMinutes)) continue;
    if (!isOpposing(trigger, sources, targets)) continue;
    opposingKeys.add(trigger.inject_key);
  }
  if (opposingKeys.size === 0) return false;
  const met = candidate.met_keys ?? [];
  if (met.length === 0) return false;
  return met.every((key) => {
    const refs = referencedInjectKeys(key);
    return refs.length > 0 && refs.every((ref) => opposingKeys.has(ref));
  });
}

function overlaps(left: readonly string[], right: readonly string[]): boolean {
  return left.some((a) => right.some((b) => sameTeam(a, b)));
}

function isOpposing(
  trigger: RecentCrossTeamTrigger,
  candidateSources: readonly string[],
  candidateTargets: readonly string[],
): boolean {
  if (trigger.origin === 'timed' || trigger.origin === 'trainer') return false;
  const source = trigger.source_teams ?? [];
  const target = trigger.target_teams ?? [];
  const cross = trigger.is_cross_team ?? isCrossTeam(source, target);
  if (!cross) return false;
  return overlaps(target, candidateSources) && overlaps(source, candidateTargets);
}

function countsTowardThrottle(trigger: RecentCrossTeamTrigger): boolean {
  if (trigger.origin === 'director') return true;
  if (trigger.origin === 'timed' || trigger.origin === 'trainer') return false;
  if (trigger.is_cross_team != null) return trigger.is_cross_team;
  return isCrossTeam(trigger.source_teams ?? [], trigger.target_teams ?? []);
}

function throttleCount(
  team: string,
  minute: number,
  recent: readonly RecentCrossTeamTrigger[],
  pending: ReadonlyMap<string, number>,
  env: CrossTeamGuardEnv,
): number {
  let count = pending.get(teamKey(team)) ?? 0;
  for (const trigger of recent) {
    if (!withinWindow(minute, trigger.minute, env.windowMinutes)) continue;
    if (!countsTowardThrottle(trigger)) continue;
    if ((trigger.target_teams ?? []).some((target) => sameTeam(target, team))) count += 1;
  }
  return count;
}

function pressureCount(
  team: string,
  minute: number,
  deliveries: readonly TeamDelivery[],
  pending: ReadonlyMap<string, number>,
): number {
  let count = pending.get(teamKey(team)) ?? 0;
  for (const delivery of deliveries) {
    if (delivery.timed) continue;
    if (!withinWindow(minute, delivery.minute, PRESSURE_WINDOW_MINUTES)) continue;
    if (sameTeam(delivery.team, team)) count += 1;
  }
  return count;
}

function withinWindow(now: number, then: number, windowMinutes: number): boolean {
  const age = now - then;
  return age >= 0 && age <= windowMinutes;
}

function severityRank(value: string | null | undefined): number {
  if (!value) return 0;
  return SEVERITY_RANK[value.toLowerCase()] ?? 0;
}

function scopeOf(key: string): { body: string; team?: string; role?: string } {
  const pipe = key.indexOf('|');
  const body = (pipe >= 0 ? key.slice(0, pipe) : key).trim();
  if (pipe < 0) return { body };
  const raw = key.slice(pipe + 1);
  const eq = raw.indexOf('=');
  if (eq <= 0) return { body };
  const name = raw.slice(0, eq).trim();
  const value = raw.slice(eq + 1).trim();
  if (name === 'team') {
    const slug = slugifyTeamName(value);
    return slug ? { body, team: slug } : { body };
  }
  if (name === 'role' && value) return { body, role: value };
  return { body };
}

function resolverTeams(key: string, body: string, teams: readonly CrossTeamTeam[]): string[] {
  const found: string[] = [];
  for (const [prefix, resolve] of resolvers) {
    if (!prefixMatches(prefix, body)) continue;
    const raw = resolve(key);
    const list = raw == null ? [] : typeof raw === 'string' ? [raw] : raw;
    for (const name of list) {
      if (!name || !name.trim()) continue;
      found.push(canonicalTeamName(name, teams));
    }
  }
  return found;
}

function prefixMatches(prefix: string, body: string): boolean {
  const stem = prefix.endsWith('*') ? prefix.slice(0, -1) : prefix;
  if (!stem) return false;
  return body.startsWith(stem);
}

function teamNameForRole(roleId: string, teams: readonly CrossTeamTeam[]): string | null {
  const hit = teams.find((team) => (team.role_ids ?? []).includes(roleId));
  return hit?.name ?? null;
}

function canonicalTeamName(token: string, teams: readonly CrossTeamTeam[]): string {
  const hit = teams.find(
    (team) => sameTeam(team.name, token) || (team.slug != null && sameTeam(team.slug, token)),
  );
  return hit?.name ?? token.trim();
}

function pushTeam(out: string[], name: string): void {
  if (!name) return;
  if (out.some((existing) => sameTeam(existing, name))) return;
  out.push(name);
}

function sameTeam(a: string, b: string): boolean {
  if (a === b) return true;
  const left = slugifyTeamName(a);
  const right = slugifyTeamName(b);
  return left !== '' && left === right;
}

function teamKey(name: string): string {
  return slugifyTeamName(name) || name.trim().toLowerCase();
}
