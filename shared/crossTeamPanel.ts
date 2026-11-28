/**
 * Trainer dependency panel: state chips, the lag countdown, and the
 * pressure strip. No database access. The dashboard and the tests share it.
 */

import { slugifyTeamName } from './conditionKeyGrammar.js';
import type { DependencyDue } from './teamDependencies.js';

export const AT_RISK_WITHIN_MINUTES = 5;
export const PRESSURE_STRIP_MINUTES = 15;

export const PANEL_STATUSES = ['pending', 'met', 'broken', 'recovered', 'waived'] as const;
export type PanelStatus = (typeof PANEL_STATUSES)[number];

export type PanelChip = 'pending' | 'at_risk' | 'broken' | 'met' | 'late' | 'waived';

export type PressureBucket = 'authored' | 'cross_team' | 'unscripted';

export interface PanelEdgeInput {
  id: string;
  upstream_name: string;
  downstream_names: string[];
  deliverable: string;
  why: string;
  due: DependencyDue;
  lag_minutes: number;
  status: PanelStatus;
  broken_minute: number | null;
  met_minute: number | null;
  recovered_minute: number | null;
  hold_until_minute: number | null;
  inert?: boolean;
}

export interface PanelEdgeView extends PanelEdgeInput {
  chip: PanelChip;
  countdown_minutes: number | null;
  due_minute: number | null;
}

export interface PressureEvent {
  minute: number;
  origin: string;
  source_teams: readonly string[];
  target_teams: readonly string[];
}

export interface TeamPressure {
  team: string;
  authored: number;
  cross_team: number;
  unscripted: number;
}

export interface HeldItem {
  inject_key: string;
  reason: string;
  minute: number;
}

export interface PanelView {
  groups: Array<{ team: string; edges: PanelEdgeView[] }>;
  pressure: TeamPressure[];
  held: Array<HeldItem & { reason_label: string }>;
}

export function teamKey(name: string): string {
  const slug = slugifyTeamName(name);
  return slug || name.trim().toLowerCase();
}

export function sameTeamName(left: string, right: string): boolean {
  if (left.trim() === right.trim()) return true;
  const a = teamKey(left);
  const b = teamKey(right);
  return a !== '' && a === b;
}

/** A recipient the firing keys are not about. Empty sides are not cross-team. */
export function teamsDiffer(source: readonly string[], target: readonly string[]): boolean {
  if (source.length === 0 || target.length === 0) return false;
  return target.some((item) => !source.some((from) => sameTeamName(from, item)));
}

export interface TimelineTrigger {
  origin: string;
  source_teams: readonly string[];
  target_teams: readonly string[];
}

/**
 * Origin label for one response-timeline row. Branch rows keep the label
 * already stored on the row. Chain and mood rows name themselves when no
 * trigger was recorded.
 */
export function timelineOriginFor(input: {
  event: string;
  existing?: string;
  trigger?: TimelineTrigger | null;
}): string {
  if (input.existing) return input.existing;
  if (input.trigger) {
    return originLabel(
      input.trigger.origin,
      teamsDiffer(input.trigger.source_teams, input.trigger.target_teams),
    );
  }
  if (input.event === 'chain' || input.event === 'chain_step') return originLabel('chain');
  if (input.event === 'mood' || input.event === 'consequence') return originLabel('mood');
  return 'inferred';
}

/**
 * Origin label for a timeline row (§5.9). `director` is included so a later
 * package only adds its own tables. An unknown origin stays "inferred".
 */
export function originLabel(origin: string, crossTeam = false): string {
  if (origin === 'director') return 'Unscripted (AI director)';
  if (origin === 'dependency') return 'Cross-team consequence';
  if (origin === 'conditional' && crossTeam) return 'Cross-team consequence';
  switch (origin) {
    case 'timed':
      return 'Authored (timed)';
    case 'conditional':
      return 'Authored (conditional)';
    case 'chain':
      return 'Escalation step';
    case 'mood':
      return 'Mood consequence';
    case 'decision':
      return 'Decision reaction';
    case 'trainer':
      return 'Trainer';
    default:
      return 'inferred';
  }
}

export function pressureKind(
  origin: string,
  sourceTeams: readonly string[],
  targetTeams: readonly string[],
): PressureBucket {
  if (origin === 'director') return 'unscripted';
  if (origin === 'dependency') return 'cross_team';
  if (
    (origin === 'conditional' || origin === 'decision') &&
    teamsDiffer(sourceTeams, targetTeams)
  ) {
    return 'cross_team';
  }
  return 'authored';
}

export function dueMinuteOf(
  due: DependencyDue,
  anchors: Readonly<Record<string, number>>,
): number | null {
  if ('by_minute' in due) return due.by_minute;
  const anchor = anchors[due.after_inject_key];
  if (anchor == null || !Number.isFinite(anchor)) return null;
  return anchor + due.within_minutes;
}

/** Pending, and the due minute is 5 minutes away or already past. */
export function panelChip(
  status: PanelStatus,
  dueMinute: number | null,
  elapsed: number,
): PanelChip {
  if (status === 'waived') return 'waived';
  if (status === 'met') return 'met';
  if (status === 'recovered') return 'late';
  if (status === 'broken') return 'broken';
  if (dueMinute != null && dueMinute - elapsed <= AT_RISK_WITHIN_MINUTES) return 'at_risk';
  return 'pending';
}

/**
 * Minutes until the consequence can fire. Lag and a trainer hold both apply;
 * the later of the two is the eligibility minute. Null once it is eligible,
 * or when the dependency is not broken.
 */
export function lagCountdown(input: {
  status: PanelStatus;
  brokenMinute: number | null;
  lagMinutes: number;
  holdUntilMinute: number | null;
  elapsed: number;
}): number | null {
  if (input.status !== 'broken' || input.brokenMinute == null) return null;
  const lagLeft = input.brokenMinute + input.lagMinutes - input.elapsed;
  const holdLeft = input.holdUntilMinute == null ? 0 : input.holdUntilMinute - input.elapsed;
  const remaining = Math.max(lagLeft, holdLeft);
  return remaining > 0 ? remaining : null;
}

export function canWaive(status: PanelStatus): boolean {
  return status !== 'waived';
}

export function canHold(status: PanelStatus): boolean {
  return status === 'pending' || status === 'broken';
}

export function heldReasonLabel(reason: string): string {
  if (reason === 'throttle')
    return 'Throttled: this team is at its cross-team limit for the window';
  if (reason === 'pressure') return 'Held: this team is at its pressure ceiling';
  if (reason === 'cross_team_loop_held') {
    return 'Held: the other team is only failing at answering this consequence';
  }
  if (reason === 'cascade_cap') return 'Cancelled: cascade cap';
  return reason;
}

export function groupByDownstream<T extends { downstream_names: readonly string[] }>(
  edges: readonly T[],
): Array<{ team: string; edges: T[] }> {
  const order: string[] = [];
  const groups = new Map<string, { label: string; edges: T[] }>();
  for (const edge of edges) {
    const names = edge.downstream_names.filter((name) => name.trim() !== '');
    const listed = names.length > 0 ? names : ['Unassigned'];
    for (const name of listed) {
      const key = teamKey(name);
      const current = groups.get(key);
      if (!current) {
        groups.set(key, { label: name.trim(), edges: [edge] });
        order.push(key);
      } else {
        current.edges.push(edge);
      }
    }
  }
  return order.map((key) => {
    const group = groups.get(key)!;
    return { team: group.label, edges: group.edges };
  });
}

export function countPressure(events: readonly PressureEvent[]): TeamPressure[] {
  const order: string[] = [];
  const totals = new Map<string, TeamPressure>();
  for (const event of events) {
    const kind = pressureKind(event.origin, event.source_teams, event.target_teams);
    for (const name of event.target_teams) {
      const label = name.trim();
      if (!label) continue;
      const key = teamKey(label);
      let row = totals.get(key);
      if (!row) {
        row = { team: label, authored: 0, cross_team: 0, unscripted: 0 };
        totals.set(key, row);
        order.push(key);
      }
      row[kind] += 1;
    }
  }
  return order.map((key) => totals.get(key)!);
}

export function pressureStrip(
  events: readonly PressureEvent[],
  elapsed: number,
  windowMinutes = PRESSURE_STRIP_MINUTES,
): TeamPressure[] {
  const start = elapsed - windowMinutes;
  return countPressure(events.filter((event) => event.minute >= start && event.minute <= elapsed));
}

/**
 * Due-minute anchors and "this held inject later published" use every fire,
 * including ones older than the pressure window. The pressure strip does not.
 */
export function applyFiredMinutes(input: {
  fired: readonly { inject_key: string; minute: number }[];
  held: readonly HeldItem[];
}): { anchors: Record<string, number>; held: HeldItem[] } {
  const anchors: Record<string, number> = {};
  const published = new Set<string>();
  const ordered = [...input.fired].sort(
    (left, right) => left.minute - right.minute || left.inject_key.localeCompare(right.inject_key),
  );
  for (const row of ordered) {
    if (!row.inject_key) continue;
    published.add(row.inject_key);
    if (anchors[row.inject_key] == null) anchors[row.inject_key] = row.minute;
  }
  return {
    anchors,
    held: input.held.filter((item) => !published.has(item.inject_key)),
  };
}

export function buildPanelView(input: {
  edges: readonly PanelEdgeInput[];
  elapsed: number;
  anchors: Readonly<Record<string, number>>;
  events: readonly PressureEvent[];
  held: readonly HeldItem[];
  windowMinutes?: number;
}): PanelView {
  const viewed: PanelEdgeView[] = input.edges.map((edge) => {
    const dueMinute = dueMinuteOf(edge.due, input.anchors);
    return {
      ...edge,
      due_minute: dueMinute,
      chip: panelChip(edge.status, dueMinute, input.elapsed),
      countdown_minutes: lagCountdown({
        status: edge.status,
        brokenMinute: edge.broken_minute,
        lagMinutes: edge.lag_minutes,
        holdUntilMinute: edge.hold_until_minute,
        elapsed: input.elapsed,
      }),
    };
  });
  const seen = new Set<string>();
  const held = input.held
    .filter((item) => item.inject_key.trim() !== '')
    .sort((left, right) => right.minute - left.minute)
    .filter((item) => {
      if (seen.has(item.inject_key)) return false;
      seen.add(item.inject_key);
      return true;
    })
    .map((item) => ({ ...item, reason_label: heldReasonLabel(item.reason) }));
  return {
    groups: groupByDownstream(viewed),
    pressure: pressureStrip(input.events, input.elapsed, input.windowMinutes),
    held,
  };
}
