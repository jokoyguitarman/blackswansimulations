/**
 * Team-dependency document stored on scenarios.initial_state.
 * Shared by the scenario API, the generator and the editor. No database access.
 * The zod schema lives in the server module so the editor build does not depend on zod.
 */

import { slugifyTeamName } from './conditionKeyGrammar.js';

export const DEPENDENCY_KINDS = [
  'information',
  'decision',
  'approval',
  'resource',
  'action',
  'coverage',
  'restraint',
] as const;

export const DEPENDENCY_SEVERITIES = ['low', 'medium', 'high'] as const;

export const DEPENDENCY_SOURCES = ['war_room', 'trainer', 'intel'] as const;

export const DEPENDENCY_ID = /^dep_[a-z0-9_]{1,56}$/;

export type DependencyKind = (typeof DEPENDENCY_KINDS)[number];
export type DependencySeverity = (typeof DEPENDENCY_SEVERITIES)[number];
export type DependencySource = (typeof DEPENDENCY_SOURCES)[number];

export interface TeamRef {
  team_uid: string | null;
  team_name: string;
}

/** A team the resolver can see. `playable: false` is an AI-operated organisation. */
export interface ActiveTeam {
  team_uid?: string | null;
  team_name: string;
  playable?: boolean;
}

export type NormalizedConditions = { all: string[] } | { threshold: number; conditions: string[] };

export type DependencyDue =
  { by_minute: number } | { after_inject_key: string; within_minutes: number };

export interface TeamDependencyEdge {
  id: string;
  kind: DependencyKind;
  upstream: TeamRef;
  downstream: TeamRef[];
  deliverable: string;
  why: string;
  due: DependencyDue;
  broken_when: NormalizedConditions;
  met_when: NormalizedConditions | null;
  lag_minutes: number;
  severity: DependencySeverity;
  consequence_keys: string[];
  source: DependencySource;
}

export interface TeamDependencies {
  v: 1;
  edges: TeamDependencyEdge[];
}

/**
 * `{ any: [...] }` is threshold 1. A group that already uses `all` or `conditions`
 * is left unchanged for the schema to accept or reject.
 */
export function applyAnySugar(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as { all?: unknown; any?: unknown; conditions?: unknown };
  if (
    Array.isArray(record.any) &&
    !Array.isArray(record.all) &&
    !Array.isArray(record.conditions)
  ) {
    return { threshold: 1, conditions: record.any };
  }
  return value;
}

/**
 * Match `team_uid` when it is set, and do not fall through to the name:
 * a removed team's uid must not attach to whoever reused the display name.
 * A null uid matches the exact name, then a unique slug.
 */
export function matchTeamRef(ref: TeamRef, teams: readonly ActiveTeam[]): ActiveTeam | null {
  const uid = typeof ref.team_uid === 'string' && ref.team_uid.trim() ? ref.team_uid.trim() : null;
  if (uid) return teams.find((team) => team.team_uid === uid) ?? null;
  const name = ref.team_name.trim();
  const exact = teams.find((team) => team.team_name === name);
  if (exact) return exact;
  const slug = slugifyTeamName(name);
  if (!slug) return null;
  const matches = teams.filter((team) => slugifyTeamName(team.team_name) === slug);
  return matches.length === 1 ? matches[0] : null;
}

/** Current display name, or null when the team was removed or retired. */
export function resolveTeamRef(ref: TeamRef, teams: readonly ActiveTeam[]): string | null {
  return matchTeamRef(ref, teams)?.team_name ?? null;
}

/** Replace `|team=@upstream` / `|team=@downstream` with the team's slug. */
export function expandPlaceholders(
  key: string,
  refs: { upstream?: string | null; downstream?: string | null },
): string {
  return key.replace(/\|team=@(upstream|downstream)\b/g, (match, which: string) => {
    const name = which === 'upstream' ? refs.upstream : refs.downstream;
    if (typeof name !== 'string' || !name.trim()) return match;
    const slug = slugifyTeamName(name);
    return slug ? `|team=${slug}` : match;
  });
}

export function crossTeamTeamsOf(edge: { upstream: TeamRef; downstream: readonly TeamRef[] }): {
  upstream: string;
  downstream: string[];
} {
  return {
    upstream: edge.upstream.team_name,
    downstream: edge.downstream.map((team) => team.team_name),
  };
}

export interface DependencyCatalogEntry {
  id: string;
  label: string;
  upstream: string;
  downstream: string[];
  state_keys: string[];
}

export function dependencyStateKeys(edge: { id: string; lag_minutes: number }): string[] {
  return [
    `dependency_broken:${edge.id}`,
    `dependency_broken_for:${edge.id}:${edge.lag_minutes}`,
    `dependency_met:${edge.id}`,
    `dependency_recovered:${edge.id}`,
    `dependency_resolved:${edge.id}`,
    `dependency_waived:${edge.id}`,
  ];
}

/** Keys inside an appear group, including `{ any }` sugar. Unreadable groups yield none. */
export function appearKeysFrom(value: unknown): string[] {
  const group = readConditionGroup(value);
  if (!group || 'error' in group) return [];
  return conditionGroupKeys(group);
}

export function conditionGroupKeys(group: NormalizedConditions | null | undefined): string[] {
  if (!group) return [];
  if ('all' in group && Array.isArray(group.all)) return [...group.all];
  if ('conditions' in group && Array.isArray(group.conditions)) return [...group.conditions];
  return [];
}

/** Appear key for a consequence of this edge, and the two cancel keys. */
export function consequenceAppearKey(edge: { id: string; lag_minutes: number }): string {
  return `dependency_broken_for:${edge.id}:${edge.lag_minutes}`;
}

export function consequenceCancelKeys(depId: string): string[] {
  return [`dependency_resolved:${depId}`, `dependency_waived:${depId}`];
}

export interface DependencyEditorQuantifier {
  quantifier: 'all' | 'any' | 'at_least';
  threshold: number;
  keys: string[];
}

/**
 * Form state for one edge. `{ any }` in stored JSON is `quantifier: 'any'`
 * here and is written back as threshold 1.
 */
export interface DependencyEditorModel {
  id: string;
  kind: DependencyKind;
  upstream: TeamRef;
  downstream: TeamRef[];
  deliverable: string;
  why: string;
  dueMode: 'by_minute' | 'after_inject';
  byMinute: number;
  afterInjectKey: string;
  withinMinutes: number;
  broken: DependencyEditorQuantifier;
  /** Absent when the edge can only be broken or pending. */
  met: DependencyEditorQuantifier | null;
  lagMinutes: number;
  severity: DependencySeverity;
  consequenceKeys: string[];
  source: DependencySource;
}

export interface DependencyCauseRef {
  kind: 'dependency';
  dep_id: string;
}

function isDependencyKind(value: string): value is DependencyKind {
  return (DEPENDENCY_KINDS as readonly string[]).includes(value);
}

function isDependencySeverity(value: string): value is DependencySeverity {
  return (DEPENDENCY_SEVERITIES as readonly string[]).includes(value);
}

function isDependencySource(value: string): value is DependencySource {
  return (DEPENDENCY_SOURCES as readonly string[]).includes(value);
}

function readStrings(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const keys: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim()) return null;
    keys.push(item.trim());
  }
  return keys;
}

function readConditionGroup(value: unknown): NormalizedConditions | null | { error: string } {
  if (value == null) return null;
  const sugared = applyAnySugar(value);
  if (!sugared || typeof sugared !== 'object' || Array.isArray(sugared)) {
    return { error: 'a condition group must be an object' };
  }
  const record = sugared as { all?: unknown; conditions?: unknown; threshold?: unknown };
  if (Array.isArray(record.all)) {
    const keys = readStrings(record.all);
    if (!keys) return { error: 'condition keys must be non-empty strings' };
    return { all: keys };
  }
  if (Array.isArray(record.conditions)) {
    const keys = readStrings(record.conditions);
    if (!keys) return { error: 'condition keys must be non-empty strings' };
    const threshold = typeof record.threshold === 'number' ? record.threshold : 1;
    if (!Number.isInteger(threshold) || threshold < 1) {
      return { error: 'threshold must be a whole number of at least 1' };
    }
    return { threshold, conditions: keys };
  }
  return { error: 'a condition group must use all, any, or threshold' };
}

function readTeamRef(value: unknown, label: string): TeamRef | { error: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { error: `${label} must be a team` };
  }
  const record = value as { team_uid?: unknown; team_name?: unknown };
  const teamName = typeof record.team_name === 'string' ? record.team_name.trim() : '';
  if (!teamName) return { error: `${label} is missing team_name` };
  const uid =
    typeof record.team_uid === 'string' && record.team_uid.trim() ? record.team_uid.trim() : null;
  return { team_uid: uid, team_name: teamName };
}

function readDue(value: unknown): DependencyDue | { error: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { error: 'due must be an object' };
  }
  const record = value as {
    by_minute?: unknown;
    after_inject_key?: unknown;
    within_minutes?: unknown;
  };
  if (typeof record.by_minute === 'number') {
    if (!Number.isInteger(record.by_minute) || record.by_minute < 0) {
      return { error: 'by_minute must be a whole number of minutes' };
    }
    return { by_minute: record.by_minute };
  }
  if (typeof record.after_inject_key === 'string' && typeof record.within_minutes === 'number') {
    if (!Number.isInteger(record.within_minutes) || record.within_minutes < 0) {
      return { error: 'within_minutes must be a whole number of minutes' };
    }
    return {
      after_inject_key: record.after_inject_key.trim(),
      within_minutes: record.within_minutes,
    };
  }
  return { error: 'due must be by_minute or after_inject_key plus within_minutes' };
}

/** One stored edge, with `{ any }` normalised to threshold 1. */
export function readDependencyEdge(
  value: unknown,
): { edge: TeamDependencyEdge } | { error: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { error: 'an edge must be an object' };
  }
  const record = value as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id.trim() : '';
  if (!DEPENDENCY_ID.test(id)) return { error: `id "${id}" must match ^dep_[a-z0-9_]{1,56}$` };
  if (typeof record.kind !== 'string' || !isDependencyKind(record.kind)) {
    return { error: 'kind is not a dependency kind' };
  }
  const upstream = readTeamRef(record.upstream, 'upstream');
  if ('error' in upstream) return upstream;
  if (!Array.isArray(record.downstream) || record.downstream.length < 1) {
    return { error: 'downstream needs at least one team' };
  }
  const downstream: TeamRef[] = [];
  for (const item of record.downstream) {
    const ref = readTeamRef(item, 'downstream');
    if ('error' in ref) return ref;
    downstream.push(ref);
  }
  const deliverable = typeof record.deliverable === 'string' ? record.deliverable.trim() : '';
  if (!deliverable) return { error: 'deliverable is empty' };
  const why = typeof record.why === 'string' ? record.why.trim() : '';
  const due = readDue(record.due);
  if ('error' in due) return due;
  const broken = readConditionGroup(record.broken_when);
  if (!broken || 'error' in broken) {
    return {
      error:
        'error' in (broken ?? {}) ? (broken as { error: string }).error : 'broken_when is missing',
    };
  }
  if (conditionGroupKeys(broken).length === 0)
    return { error: 'broken_when needs at least one condition' };
  const met = readConditionGroup(record.met_when);
  if (met && 'error' in met) return met;
  const lag = record.lag_minutes;
  if (typeof lag !== 'number' || !Number.isInteger(lag) || lag < 0 || lag > 30) {
    return { error: 'lag_minutes must be a whole number from 0 to 30' };
  }
  if (typeof record.severity !== 'string' || !isDependencySeverity(record.severity)) {
    return { error: 'severity must be low, medium, or high' };
  }
  const consequenceKeys =
    record.consequence_keys == null ? [] : readStrings(record.consequence_keys);
  if (!consequenceKeys) return { error: 'consequence_keys must be a list of inject keys' };
  if (typeof record.source !== 'string' || !isDependencySource(record.source)) {
    return { error: 'source must be war_room, trainer, or intel' };
  }
  return {
    edge: {
      id,
      kind: record.kind,
      upstream,
      downstream,
      deliverable,
      why,
      due,
      broken_when: broken,
      met_when: met && conditionGroupKeys(met).length > 0 ? met : null,
      lag_minutes: lag,
      severity: record.severity,
      consequence_keys: consequenceKeys,
      source: record.source,
    },
  };
}

/** `null` is an empty document. Anything else must be version 1. */
export function readTeamDependencies(
  value: unknown,
): { dependencies: TeamDependencies } | { error: string } {
  if (value == null) return { dependencies: { v: 1, edges: [] } };
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { error: 'team_dependencies must be an object' };
  }
  const record = value as { v?: unknown; edges?: unknown };
  if (record.v !== 1) return { error: 'team_dependencies.v must be 1' };
  if (!Array.isArray(record.edges)) return { error: 'team_dependencies.edges must be an array' };
  const edges: TeamDependencyEdge[] = [];
  for (let index = 0; index < record.edges.length; index += 1) {
    const read = readDependencyEdge(record.edges[index]);
    if ('error' in read) return { error: `edges[${index}]: ${read.error}` };
    edges.push(read.edge);
  }
  return { dependencies: { v: 1, edges } };
}

function quantifierOf(group: NormalizedConditions): DependencyEditorQuantifier {
  if ('all' in group) return { quantifier: 'all', threshold: 1, keys: [...group.all] };
  if (group.threshold <= 1) {
    return { quantifier: 'any', threshold: 1, keys: [...group.conditions] };
  }
  return {
    quantifier: 'at_least',
    threshold: group.threshold,
    keys: [...group.conditions],
  };
}

function groupFromQuantifier(group: DependencyEditorQuantifier): NormalizedConditions {
  if (group.quantifier === 'all') return { all: [...group.keys] };
  const threshold = group.quantifier === 'any' ? 1 : Math.max(2, Math.floor(group.threshold));
  return { threshold, conditions: [...group.keys] };
}

export function toEditorModel(edge: TeamDependencyEdge): DependencyEditorModel {
  const due = edge.due;
  const base = {
    id: edge.id,
    kind: edge.kind,
    upstream: { ...edge.upstream },
    downstream: edge.downstream.map((team) => ({ ...team })),
    deliverable: edge.deliverable,
    why: edge.why,
    broken: quantifierOf(edge.broken_when),
    met: edge.met_when ? quantifierOf(edge.met_when) : null,
    lagMinutes: edge.lag_minutes,
    severity: edge.severity,
    consequenceKeys: [...edge.consequence_keys],
    source: edge.source,
  };
  if ('by_minute' in due) {
    return {
      ...base,
      dueMode: 'by_minute',
      byMinute: due.by_minute,
      afterInjectKey: '',
      withinMinutes: 10,
    };
  }
  return {
    ...base,
    dueMode: 'after_inject',
    byMinute: 0,
    afterInjectKey: due.after_inject_key,
    withinMinutes: due.within_minutes,
  };
}

export function fromEditorModel(model: DependencyEditorModel): TeamDependencyEdge {
  const due: DependencyDue =
    model.dueMode === 'by_minute'
      ? { by_minute: model.byMinute }
      : { after_inject_key: model.afterInjectKey, within_minutes: model.withinMinutes };
  const met = model.met && model.met.keys.length > 0 ? groupFromQuantifier(model.met) : null;
  return {
    id: model.id,
    kind: model.kind,
    upstream: { ...model.upstream },
    downstream: model.downstream.map((team) => ({ ...team })),
    deliverable: model.deliverable,
    why: model.why,
    due,
    broken_when: groupFromQuantifier(model.broken),
    met_when: met,
    lag_minutes: model.lagMinutes,
    severity: model.severity,
    consequence_keys: [...model.consequenceKeys],
    source: model.source,
  };
}

function addDependencyId(taken: Set<string>, value: string): void {
  if (DEPENDENCY_ID.test(value)) taken.add(value);
}

function addDependencyIdsInText(taken: Set<string>, text: string): void {
  addDependencyId(taken, text);
  const keys =
    /dependency_(?:broken_for|broken|met|recovered|resolved|waived):(dep_[a-z0-9_]{1,56})(?::|$)/g;
  for (const match of text.matchAll(keys)) {
    const id = match[1];
    if (id) addDependencyId(taken, id);
  }
}

function addDependencyIds(taken: Set<string>, value: unknown): void {
  if (typeof value === 'string') {
    addDependencyIdsInText(taken, value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) addDependencyIds(taken, item);
    return;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) addDependencyIds(taken, item);
  }
}

export interface DependencyIdSource {
  conditions_to_appear?: unknown;
  conditions_to_cancel?: unknown;
  delivery_config?: unknown;
}

function causeOf(config: unknown): unknown {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return undefined;
  return (config as { cause?: unknown }).cause;
}

/**
 * Ids that must not be issued again. A retired edge's id stays taken while any
 * inject still names it in appear or cancel conditions, or in `cause.dep_id`.
 * Current edges are taken too.
 */
export function takenDependencyIds(
  edges: readonly { id: string }[],
  injects: readonly DependencyIdSource[],
): Set<string> {
  const taken = new Set<string>();
  for (const edge of edges) addDependencyId(taken, edge.id);
  for (const inject of injects) {
    addDependencyIds(taken, inject.conditions_to_appear);
    addDependencyIds(taken, inject.conditions_to_cancel);
    addDependencyIds(taken, causeOf(inject.delivery_config));
  }
  return taken;
}

/** First free `dep_` id. The slug is the deliverable, capped at 56 characters. */
export function uniqueDependencyId(label: string, taken: ReadonlySet<string>): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 56)
    .replace(/_+$/g, '');
  const stem = slug || 'edge';
  const base = `dep_${stem}`;
  if (DEPENDENCY_ID.test(base) && !taken.has(base)) return base;
  for (let n = 2; n < 1000; n += 1) {
    const suffix = `_${n}`;
    const cut = stem.slice(0, 56 - suffix.length).replace(/_+$/g, '') || 'edge';
    const candidate = `dep_${cut}${suffix}`;
    if (DEPENDENCY_ID.test(candidate) && !taken.has(candidate)) return candidate;
  }
  return 'dep_edge';
}

/**
 * The dependency the "fails this" action writes: no reply to this inject,
 * met by a relevant reply, one downstream consequence key.
 */
export function quickDependencyEdge(input: {
  id: string;
  injectKey: string;
  injectTitle: string;
  upstream: TeamRef;
  downstream: TeamRef;
  withinMinutes: number;
  lagMinutes: number;
  consequenceKey: string;
}): TeamDependencyEdge {
  const minutes = Math.max(0, Math.floor(input.withinMinutes));
  const lag = Math.min(30, Math.max(0, Math.floor(input.lagMinutes)));
  return {
    id: input.id,
    kind: 'information',
    upstream: { ...input.upstream },
    downstream: [{ ...input.downstream }],
    deliverable: input.injectTitle.trim(),
    why: '',
    due: { after_inject_key: input.injectKey, within_minutes: minutes },
    broken_when: {
      threshold: 1,
      conditions: [`unresponded:${input.injectKey}:${minutes}|team=@upstream`],
    },
    met_when: {
      threshold: 1,
      conditions: [`responded_relevant:${input.injectKey}|team=@upstream`],
    },
    lag_minutes: lag,
    severity: 'medium',
    consequence_keys: [input.consequenceKey],
    source: 'trainer',
  };
}

/** Current name, and whether the team is gone. A rename is not a removal. */
export function displayRef(
  ref: TeamRef,
  teams: readonly ActiveTeam[],
): { name: string; removed: boolean } {
  const current = resolveTeamRef(ref, teams);
  if (current) return { name: current, removed: false };
  return { name: ref.team_name, removed: true };
}

/** Rewrite cached names from the teams that still resolve. Uids already set stay. */
export function refreshEdgeTeamNames(
  edge: TeamDependencyEdge,
  teams: readonly ActiveTeam[],
): TeamDependencyEdge {
  const refresh = (ref: TeamRef): TeamRef => {
    const team = matchTeamRef(ref, teams);
    if (!team) return { team_uid: ref.team_uid, team_name: ref.team_name };
    const uid = ref.team_uid ?? (typeof team.team_uid === 'string' ? team.team_uid : null);
    return { team_uid: uid, team_name: team.team_name };
  };
  return {
    ...edge,
    upstream: refresh(edge.upstream),
    downstream: edge.downstream.map(refresh),
  };
}

function pushTeam(names: string[], name: string): void {
  const slug = slugifyTeamName(name);
  if (!slug) return;
  if (names.some((existing) => slugifyTeamName(existing) === slug)) return;
  names.push(name);
}

function dependencyIdInKey(key: string): string | null {
  const body = key.split('|')[0] ?? '';
  const match =
    /^dependency_(?:broken_for|broken|met|recovered|resolved|waived):(dep_[a-z0-9_]{1,56})(?::|$)/.exec(
      body,
    );
  return match?.[1] ?? null;
}

function sameTeamName(left: string, right: string): boolean {
  const a = slugifyTeamName(left);
  const b = slugifyTeamName(right);
  return a !== '' && a === b;
}

/**
 * Editor stand-in for the server `crossTeamProfile`. Dependency keys contribute
 * the edge's upstream team. A `|team=` slug contributes that team. The inject
 * is cross-team when a target team is not one of those source teams.
 */
export function editorCrossTeamProfile(input: {
  appearKeys: readonly string[];
  targetTeams: readonly string[];
  edges: readonly Pick<TeamDependencyEdge, 'id' | 'upstream'>[];
  teams: readonly ActiveTeam[];
}): { source_teams: string[]; target_teams: string[]; is_cross_team: boolean } {
  const source: string[] = [];
  for (const key of input.appearKeys) {
    const depId = dependencyIdInKey(key);
    if (depId) {
      const edge = input.edges.find((item) => item.id === depId);
      if (edge) {
        pushTeam(source, resolveTeamRef(edge.upstream, input.teams) ?? edge.upstream.team_name);
      }
      continue;
    }
    const scope = /\|team=([a-z0-9_]+)/.exec(key)?.[1];
    if (!scope) continue;
    const team = input.teams.find((item) => slugifyTeamName(item.team_name) === scope);
    pushTeam(source, team?.team_name ?? scope);
  }
  const target = input.targetTeams.map((team) => team.trim()).filter(Boolean);
  const isCrossTeam =
    source.length > 0 &&
    target.length > 0 &&
    target.some((team) => !source.some((item) => sameTeamName(item, team)));
  return { source_teams: source, target_teams: target, is_cross_team: isCrossTeam };
}

/** `cause: { kind: 'dependency', dep_id }` on an inject, or null. */
export function readDependencyCause(config: unknown): string | null {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return null;
  const cause = (config as { cause?: unknown }).cause;
  if (!cause || typeof cause !== 'object' || Array.isArray(cause)) return null;
  const record = cause as { kind?: unknown; dep_id?: unknown };
  if (record.kind !== 'dependency' || typeof record.dep_id !== 'string') return null;
  return DEPENDENCY_ID.test(record.dep_id) ? record.dep_id : null;
}

/** Picker rows for edges that have already been parsed. */
export function dependencyCatalogEntries(
  edges: readonly {
    id: string;
    deliverable: string;
    lag_minutes: number;
    upstream: TeamRef;
    downstream: readonly TeamRef[];
  }[],
): DependencyCatalogEntry[] {
  return edges.map((edge) => {
    const teams = crossTeamTeamsOf(edge);
    return {
      id: edge.id,
      label: `${edge.deliverable} (${teams.upstream} → ${teams.downstream.join(', ')})`,
      upstream: teams.upstream,
      downstream: [...teams.downstream],
      state_keys: dependencyStateKeys(edge),
    };
  });
}
