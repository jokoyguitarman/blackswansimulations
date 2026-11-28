/**
 * dependency_* keys and the in-memory state the scheduler and the trainer
 * panel both read. No database access.
 *
 * The director reads `dependency_state` for status, the three minutes, and
 * the team names (§6.3 step 4). `hold_until_minute` and `deliverable` sit
 * beside those fields so lag holds and labels work; readers ignore them.
 */

import {
  applyAnySugar,
  DEPENDENCY_ID,
  dependencyIdInKey,
  resolveTeamRef,
} from '../../../shared/teamDependencies.js';
import { parseConditionKey } from '../conditions/conditionCatalog.js';
import type { ActiveTeam, TeamDependencyEdge } from '../../../shared/teamDependencies.js';

export const DEPENDENCY_STATUSES = ['pending', 'met', 'broken', 'recovered', 'waived'] as const;
export type DependencyStatus = (typeof DEPENDENCY_STATUSES)[number];

/** Minutes a trainer hold pushes consequence eligibility out by. */
export const DEPENDENCY_HOLD_MINUTES = 5;

export interface DependencyEvidence {
  key: string;
  detail: string;
  minute: number;
}

export interface DependencyRuntimeState {
  status: DependencyStatus;
  broken_minute: number | null;
  met_minute: number | null;
  recovered_minute: number | null;
  upstream: string | null;
  downstream: string[];
  hold_until_minute: number | null;
  deliverable: string;
}

export interface StoredDependencyRow {
  dep_id: string;
  status: DependencyStatus;
  upstream_team: string | null;
  downstream_teams: string[];
  broken_minute: number | null;
  met_minute: number | null;
  recovered_minute: number | null;
  hold_until_minute: number | null;
  evidence: DependencyEvidence[];
}

export interface DependencyWritePlan {
  op: 'insert' | 'update';
  /** Update only while the row still has this status, so two ticks cannot both transition it. */
  whereStatus: DependencyStatus | null;
  row: {
    status: DependencyStatus;
    broken_minute: number | null;
    met_minute: number | null;
    recovered_minute: number | null;
    hold_until_minute: number | null;
    evidence: DependencyEvidence[];
    upstream_team?: string | null;
    downstream_teams?: string[];
  };
}

const DEPENDENCY_KEY_IDS = new Set([
  'dependency_broken',
  'dependency_broken_for',
  'dependency_met',
  'dependency_recovered',
  'dependency_resolved',
  'dependency_waived',
]);

export function isDependencyStatus(value: unknown): value is DependencyStatus {
  return typeof value === 'string' && (DEPENDENCY_STATUSES as readonly string[]).includes(value);
}

export function dependencyIdFromKey(key: string): string | null {
  return dependencyIdInKey(key);
}

export function emptyDependencyState(
  partial: Partial<DependencyRuntimeState> = {},
): DependencyRuntimeState {
  return {
    status: 'pending',
    broken_minute: null,
    met_minute: null,
    recovered_minute: null,
    upstream: null,
    downstream: [],
    hold_until_minute: null,
    deliverable: '',
    ...partial,
  };
}

export function dependencyStateMap(
  value: unknown,
): Record<string, DependencyRuntimeState> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, DependencyRuntimeState>;
}

function resolvedDownstream(edge: TeamDependencyEdge, teams: readonly ActiveTeam[]): string[] {
  const names: string[] = [];
  for (const ref of edge.downstream) {
    const name = resolveTeamRef(ref, teams);
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

/** One entry per edge that still has an upstream team. Stored names win over a later rename. */
export function projectDependencyStates(
  edges: readonly TeamDependencyEdge[],
  rows: readonly StoredDependencyRow[],
  teams: readonly ActiveTeam[],
): Record<string, DependencyRuntimeState> {
  const byId = new Map(rows.map((row) => [row.dep_id, row]));
  const map: Record<string, DependencyRuntimeState> = {};
  for (const edge of edges) {
    const row = byId.get(edge.id);
    const upstream = row?.upstream_team ?? resolveTeamRef(edge.upstream, teams);
    if (!upstream) continue;
    const downstream =
      row && row.downstream_teams.length > 0
        ? [...row.downstream_teams]
        : resolvedDownstream(edge, teams);
    map[edge.id] = {
      status: row?.status ?? 'pending',
      broken_minute: row?.broken_minute ?? null,
      met_minute: row?.met_minute ?? null,
      recovered_minute: row?.recovered_minute ?? null,
      upstream,
      downstream,
      hold_until_minute: row?.hold_until_minute ?? null,
      deliverable: edge.deliverable,
    };
  }
  return map;
}

export function sourceTeamsFromState(
  state: Record<string, DependencyRuntimeState> | null | undefined,
): Map<string, readonly string[]> {
  const map = new Map<string, readonly string[]>();
  if (!state) return map;
  for (const [depId, entry] of Object.entries(state)) {
    if (entry?.upstream) map.set(depId, [entry.upstream]);
  }
  return map;
}

/**
 * No write when nothing changed. An insert records the resolved names once.
 * An update leaves those columns alone.
 */
export function planDependencyWrite(
  previousStatus: DependencyStatus | null,
  next: DependencyRuntimeState,
  evidence: readonly DependencyEvidence[],
): DependencyWritePlan | null {
  if (previousStatus === next.status) return null;
  if (previousStatus == null && next.status === 'pending') return null;
  const row = {
    status: next.status,
    broken_minute: next.broken_minute,
    met_minute: next.met_minute,
    recovered_minute: next.recovered_minute,
    hold_until_minute: next.hold_until_minute,
    evidence: evidence.map((item) => ({ ...item })),
  };
  if (previousStatus == null) {
    return {
      op: 'insert',
      whereStatus: null,
      row: {
        ...row,
        upstream_team: next.upstream,
        downstream_teams: [...next.downstream],
      },
    };
  }
  return { op: 'update', whereStatus: previousStatus, row };
}

export function nextHoldMinute(current: number | null | undefined, elapsed: number): number {
  const until = elapsed + DEPENDENCY_HOLD_MINUTES;
  if (current == null) return until;
  return Math.max(current, until);
}

export function dependencyTriggerCause(
  config: { cause?: { kind?: unknown; dep_id?: unknown } | null } | null | undefined,
): { cause_kind: string | null; dep_id: string | null } {
  const cause = config?.cause;
  const cause_kind = cause && typeof cause.kind === 'string' ? cause.kind : null;
  const dep_id =
    cause_kind === 'dependency' && cause && typeof cause.dep_id === 'string' ? cause.dep_id : null;
  return { cause_kind, dep_id };
}

interface DependencyKeyExplanation {
  met: boolean;
  label: string;
  detail: string;
}

function entryOf(
  currentState: Record<string, unknown> | null | undefined,
  depId: string,
): DependencyRuntimeState | null {
  const map = dependencyStateMap(currentState?.dependency_state);
  const entry = map?.[depId];
  if (!entry || typeof entry !== 'object') return null;
  if (!isDependencyStatus(entry.status)) return null;
  return entry;
}

function joinTeams(names: readonly string[]): string {
  if (names.length === 0) return 'the downstream team';
  if (names.length === 1) return names[0] ?? 'the downstream team';
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function quoteDeliverable(deliverable: string): string {
  const text = deliverable.trim();
  return text ? `\u2018${text}\u2019` : 'the deliverable';
}

function ageMinutes(entry: DependencyRuntimeState, elapsed: number, fallback: number): number {
  if (entry.broken_minute == null) return fallback;
  return Math.max(0, elapsed - entry.broken_minute);
}

function richLabel(
  id: string,
  entry: DependencyRuntimeState,
  elapsed: number,
  lag: number,
): string {
  const upstream = entry.upstream ?? 'The upstream team';
  const downstream = joinTeams(entry.downstream);
  const deliverable = quoteDeliverable(entry.deliverable);
  const failed = `${upstream} didn't deliver ${deliverable} to ${downstream}`;
  if (id === 'dependency_broken') return failed;
  if (id === 'dependency_broken_for') {
    return `${failed} (${ageMinutes(entry, elapsed, lag)} min ago)`;
  }
  if (id === 'dependency_met') return `${upstream} delivered ${deliverable} to ${downstream} on time`;
  if (id === 'dependency_recovered') {
    return `${upstream} delivered ${deliverable} to ${downstream} late`;
  }
  if (id === 'dependency_resolved') return `${upstream} resolved ${deliverable} for ${downstream}`;
  return `The trainer waived ${deliverable} (${upstream} \u2192 ${downstream})`;
}

function heldBack(entry: DependencyRuntimeState, elapsed: number): boolean {
  return entry.hold_until_minute != null && elapsed < entry.hold_until_minute;
}

function keyMet(id: string, entry: DependencyRuntimeState | null, elapsed: number, lag: number): boolean {
  if (!entry) return false;
  const status = entry.status;
  if (id === 'dependency_broken') return status === 'broken' || status === 'recovered';
  if (id === 'dependency_broken_for') {
    if (status !== 'broken' || entry.broken_minute == null) return false;
    if (elapsed - entry.broken_minute < lag) return false;
    return !heldBack(entry, elapsed);
  }
  if (id === 'dependency_met') return status === 'met';
  if (id === 'dependency_recovered') return status === 'recovered';
  if (id === 'dependency_resolved') return status === 'met' || status === 'recovered';
  if (id === 'dependency_waived') return status === 'waived';
  return false;
}

function keyDetail(
  id: string,
  entry: DependencyRuntimeState | null,
  met: boolean,
  elapsed: number,
): string {
  if (!entry) return 'No dependency state';
  if (id === 'dependency_broken_for' && entry.status === 'broken' && heldBack(entry, elapsed)) {
    return `Held until T+${entry.hold_until_minute}`;
  }
  if (!met) {
    if (entry.status === 'pending') return 'Still pending';
    return `Status is ${entry.status}`;
  }
  if (entry.status === 'broken' && entry.broken_minute != null) return `Broken at T+${entry.broken_minute}`;
  if (entry.status === 'met' && entry.met_minute != null) return `Met at T+${entry.met_minute}`;
  if (entry.status === 'recovered' && entry.recovered_minute != null) {
    return `Recovered at T+${entry.recovered_minute}`;
  }
  if (entry.status === 'waived') return 'Waived by the trainer';
  return `Status is ${entry.status}`;
}

export function explainDependencyKey(
  parsed: { def: { id: string; label: string }; args: string[] },
  currentState: Record<string, unknown> | null | undefined,
  elapsedMinutes: number,
  catalogueLabel: string,
): DependencyKeyExplanation | undefined {
  if (!DEPENDENCY_KEY_IDS.has(parsed.def.id)) return undefined;
  const depId = parsed.args[0] ?? '';
  const lag = parsed.def.id === 'dependency_broken_for' ? Number(parsed.args[1] ?? '0') : 0;
  const entry = DEPENDENCY_ID.test(depId) ? entryOf(currentState, depId) : null;
  const met = keyMet(parsed.def.id, entry, elapsedMinutes, Number.isFinite(lag) ? lag : 0);
  const label =
    entry && entry.upstream && entry.deliverable
      ? richLabel(parsed.def.id, entry, elapsedMinutes, Number.isFinite(lag) ? lag : 0)
      : catalogueLabel;
  return { met, label, detail: keyDetail(parsed.def.id, entry, met, elapsedMinutes) };
}

export function evaluateDependencyKey(
  parsed: { def: { id: string; label: string }; args: string[] },
  currentState: Record<string, unknown> | null | undefined,
  elapsedMinutes: number,
): boolean | undefined {
  const explained = explainDependencyKey(parsed, currentState, elapsedMinutes, parsed.def.label);
  return explained?.met;
}

/** Condition keys inside a `broken_when` / `met_when` group, after `{ any }` sugar. */
export function conditionKeysOf(group: unknown): string[] {
  const normalized = applyAnySugar(group);
  if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) return [];
  const record = normalized as { all?: unknown; conditions?: unknown };
  if (Array.isArray(record.all)) return record.all.filter((item): item is string => typeof item === 'string');
  if (Array.isArray(record.conditions)) {
    return record.conditions.filter((item): item is string => typeof item === 'string');
  }
  return [];
}

function injectKeysNamedBy(key: string): string[] {
  const parsed = parseConditionKey(key, { allowPlaceholders: true });
  if ('error' in parsed) return [];
  const refs: string[] = [];
  (parsed.def.params ?? []).forEach((param, index) => {
    const value = parsed.args[index];
    if (param.type === 'inject_key' && value) refs.push(value);
  });
  return refs;
}

/**
 * Inject keys named by the conditions that broke an edge.
 * A condition that names none (a duty, silence, a decision) is returned itself,
 * so the loop guard can see it is not a reply to the opposing consequence.
 */
export function dependencyReferencedKeys(conditionKeys: readonly string[]): string[] {
  const out: string[] = [];
  const push = (value: string) => {
    if (value && !out.includes(value)) out.push(value);
  };
  for (const key of conditionKeys) {
    const refs = injectKeysNamedBy(key);
    if (refs.length === 0) push(key);
    else for (const ref of refs) push(ref);
  }
  return out;
}

/**
 * Held evidence wins. With none stored, every `broken_when` key is the fallback.
 */
export function guardKeysForDependency(
  brokenWhen: unknown,
  evidence: readonly { key: string }[] | null | undefined,
): string[] {
  const held = (evidence ?? []).map((item) => item.key).filter((key) => key.trim() !== '');
  return dependencyReferencedKeys(held.length > 0 ? held : conditionKeysOf(brokenWhen));
}
