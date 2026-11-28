/**
 * Shapes roster, activity, grade and decision rows into condition facts.
 * No database access.
 */

import { slugifyTeamName } from '../../../shared/conditionKeyGrammar.js';
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
 * Team-signal reads stay off unless an inject that can still fire uses one of
 * the keys. Published and cancelled injects do not count.
 */
export function teamSignalReadsNeeded(
  injects: readonly KeyedInject[],
  publishedIds: ReadonlySet<string>,
  cancelledIds: ReadonlySet<string>,
): boolean {
  const keys: string[] = [];
  for (const inject of injects) {
    if (publishedIds.has(inject.id) || cancelledIds.has(inject.id)) continue;
    for (const key of inject.keys) keys.push(key);
  }
  return needsTeamSignalFacts(keys);
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
