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

export type NormalizedConditions =
  | { all: string[] }
  | { threshold: number; conditions: string[] };

export type DependencyDue =
  | { by_minute: number }
  | { after_inject_key: string; within_minutes: number };

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
  if (Array.isArray(record.any) && !Array.isArray(record.all) && !Array.isArray(record.conditions)) {
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

export function crossTeamTeamsOf(edge: {
  upstream: TeamRef;
  downstream: readonly TeamRef[];
}): { upstream: string; downstream: string[] } {
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
