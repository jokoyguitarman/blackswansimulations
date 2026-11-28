/**
 * Shapes roster, activity, grade and decision rows into condition facts.
 * No database access.
 */

import { slugifyTeamName } from '../../../shared/conditionKeyGrammar.js';
import { resolveDirectorMode, type DirectorMode } from '../../../shared/directorModes.js';
import { DECISION_CATEGORIES } from '../decisions/decisionTypes.js';

const DECISION_CATEGORY_SET = new Set<string>(DECISION_CATEGORIES);

const TEAM_SIGNAL_PREFIXES = [
  'duty_missed:',
  'duty_done:',
  'duty_late:',
  'team_silent:',
  'content_failed:',
  'decision_made:',
] as const;

/** True when any condition key needs the team-signal reads. */
export function needsTeamSignalFacts(keys: Iterable<string>): boolean {
  for (const key of keys) {
    const body = key.trim();
    if (TEAM_SIGNAL_PREFIXES.some((prefix) => body.startsWith(prefix))) return true;
  }
  return false;
}

export interface KeyedInject {
  id: string;
  keys: readonly string[];
}

/**
 * Team-signal reads stay off unless something still in play needs them:
 * an inject that has not fired or been cancelled, a dependency edge's
 * broken_when or met_when, or a director whose resolved mode is not off.
 */
export function teamSignalReadsNeeded(
  injects: readonly KeyedInject[],
  publishedIds: ReadonlySet<string>,
  cancelledIds: ReadonlySet<string>,
  options?: { extraKeys?: Iterable<string>; directorOn?: boolean },
): boolean {
  if (options?.directorOn) return true;
  const keys: string[] = [];
  for (const inject of injects) {
    if (publishedIds.has(inject.id) || cancelledIds.has(inject.id)) continue;
    for (const key of inject.keys) keys.push(key);
  }
  if (options?.extraKeys) {
    for (const key of options.extraKeys) keys.push(key);
  }
  return needsTeamSignalFacts(keys);
}

/** Condition keys on dependency edges. Groups are `{ all }`, `{ any }`, or `{ conditions }`. */
export function dependencySignalKeys(
  edges: readonly { broken_when?: unknown; met_when?: unknown }[],
): string[] {
  const keys: string[] = [];
  for (const edge of edges) {
    keys.push(...groupKeys(edge.broken_when), ...groupKeys(edge.met_when));
  }
  return keys;
}

function groupKeys(group: unknown): string[] {
  if (!group || typeof group !== 'object') return [];
  const record = group as { all?: unknown; any?: unknown; conditions?: unknown };
  const keys: string[] = [];
  for (const list of [record.all, record.any, record.conditions]) {
    if (!Array.isArray(list)) continue;
    for (const key of list) {
      if (typeof key === 'string' && key.trim()) keys.push(key.trim());
    }
  }
  return keys;
}

/**
 * True when this session's resolved director mode is not off.
 * An unknown scenario (initial state not loaded, no session override) does not
 * assume the default, so a tick that has not read the scenario stays quiet.
 */
export function directorNeedsTeamSignals(input: {
  enabled: boolean;
  modeMax: DirectorMode;
  defaultMode: DirectorMode;
  sessionMode?: string | null;
  /** From `scenarioDirectorMode` (`readDirectorSettings`). Null when the scenario was not loaded. */
  scenarioMode?: string | null;
  initialStateKnown: boolean;
}): boolean {
  if (!input.enabled) return false;
  if (!input.initialStateKnown && (input.sessionMode == null || input.sessionMode === '')) {
    return false;
  }
  return (
    resolveDirectorMode(
      { enabled: true, modeMax: input.modeMax, defaultMode: input.defaultMode },
      { mode: input.sessionMode },
      { mode: input.scenarioMode },
    ) !== 'off'
  );
}

export interface ActivityHit {
  team_slug: string;
  minute: number;
}

export interface GradeHit {
  team_slug: string;
  score: number;
}

export interface DecisionHit {
  team_name: string | null;
  category: string | null;
  minute: number;
  status?: string | null;
}

export interface DecisionFact {
  team_slug: string;
  category: string;
  minute: number;
}

export function latestActivity(
  hits: readonly ActivityHit[],
): Record<string, { last_minute: number | null }> {
  const out: Record<string, { last_minute: number | null }> = {};
  for (const hit of hits) {
    if (!hit.team_slug || !Number.isFinite(hit.minute)) continue;
    const prev = out[hit.team_slug];
    if (!prev || prev.last_minute == null || hit.minute > prev.last_minute) {
      out[hit.team_slug] = { last_minute: hit.minute };
    }
  }
  return out;
}

export function gradesByTeam(hits: readonly GradeHit[]): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const hit of hits) {
    if (!hit.team_slug || !Number.isFinite(hit.score)) continue;
    (out[hit.team_slug] ??= []).push(hit.score);
  }
  return out;
}

/** `sop_compliance_score.overall`. A missing overall is not a grade. */
export function overallGrade(score: unknown): number | null {
  if (!score || typeof score !== 'object') return null;
  const overall = (score as { overall?: unknown }).overall;
  if (overall == null || overall === '') return null;
  const n = typeof overall === 'number' ? overall : Number(overall);
  return Number.isFinite(n) ? n : null;
}

/** Dismissed detections are not decisions. Unknown categories are ignored. */
export function decisionFacts(rows: readonly DecisionHit[]): DecisionFact[] {
  const out: DecisionFact[] = [];
  for (const row of rows) {
    if (row.status === 'dismissed') continue;
    const category = row.category ?? '';
    if (!DECISION_CATEGORY_SET.has(category)) continue;
    const slug = row.team_name ? slugifyTeamName(row.team_name) : '';
    if (!slug || !Number.isFinite(row.minute)) continue;
    out.push({ team_slug: slug, category, minute: row.minute });
  }
  return out;
}

export function roleTeamSlugs(
  roles: readonly { role_id: string; team_name: string }[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const role of roles) {
    const slug = slugifyTeamName(role.team_name);
    if (role.role_id && slug) out[role.role_id] = slug;
  }
  return out;
}

export function teamLabelMap(names: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of names) {
    const slug = slugifyTeamName(name);
    if (slug && !out[slug]) out[slug] = name;
  }
  return out;
}
