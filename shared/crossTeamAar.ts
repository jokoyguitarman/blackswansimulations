/**
 * After-action cause chains. Built from inject_triggers (parent keys and
 * dep_id). A session with no trigger rows uses the static parent links and
 * is marked inferred. No database access.
 */

import type { DependencyDue } from './teamDependencies.js';
import {
  countPressure,
  originLabel,
  pressureKind,
  sameTeamName,
  teamKey,
  teamsDiffer,
  type PressureEvent,
  type TeamPressure,
} from './crossTeamPanel.js';

export const CROSS_TEAM_STORED_CAP = 200;

export type CrossTeamProvenance = 'recorded' | 'inferred';

export type CrossTeamOutcome = 'pending' | 'broken' | 'met' | 'late' | 'waived';

export interface CrossTeamTriggerInput {
  inject_key: string;
  title: string;
  minute: number | null;
  origin: string;
  source_teams: string[];
  target_teams: string[];
  dep_id: string | null;
  cause_depth: number;
  parent_inject_keys: string[];
}

export interface CrossTeamReplyInput {
  inject_key: string;
  team: string;
  minute: number;
  tone?: string | null;
  criteria_met?: number | null;
  criteria_total?: number | null;
}

export interface CrossTeamEdgeInput {
  id: string;
  upstream: string;
  downstream: string[];
  deliverable: string;
  due: DependencyDue;
  consequence_keys: string[];
  status: 'pending' | 'met' | 'broken' | 'recovered' | 'waived';
  broken_minute: number | null;
  met_minute: number | null;
  recovered_minute: number | null;
  evidence?: Array<{ detail: string }>;
}

export interface CrossTeamConsequence {
  inject_key: string;
  title: string;
  minute: number | null;
  teams: string[];
  depth: number;
  origin_label: string;
  response: string | null;
}

export interface CrossTeamEdgeRow {
  dep_id: string;
  upstream: string;
  downstream: string[];
  deliverable: string;
  due: string;
  outcome: CrossTeamOutcome;
  broken_minute: number | null;
  met_minute: number | null;
  recovered_minute: number | null;
  consequences: CrossTeamConsequence[];
}

export interface CauseChain {
  id: string;
  minute: number | null;
  depth: number;
  text: string;
  missing_parents: string[];
  provenance: CrossTeamProvenance;
}

export interface TeamCrossTeamCount {
  team: string;
  caused: number;
  received: number;
  pressure: { authored: number; cross_team: number; unscripted: number };
  share: { authored: number; cross_team: number; unscripted: number };
}

export interface CrossTeamSection {
  provenance: CrossTeamProvenance;
  edges: CrossTeamEdgeRow[];
  chains: CauseChain[];
  teams: TeamCrossTeamCount[];
}

export interface CrossTeamSectionInput {
  /** Null or empty: the session has no trigger rows, so chains are inferred. */
  triggers: readonly CrossTeamTriggerInput[] | null;
  edges: readonly CrossTeamEdgeInput[];
  replies: readonly CrossTeamReplyInput[];
  /** Static parent links used only when `triggers` is null or empty. */
  inferred?: readonly CrossTeamTriggerInput[];
}

interface Segment {
  id: string;
  minute: number | null;
  depth: number;
  opening: string;
  receives: string[];
  keys: string[];
  parents: string[];
  missing: string[];
  parentId: string | null;
}

export function buildCrossTeamSection(input: CrossTeamSectionInput): CrossTeamSection {
  const recorded = input.triggers ?? [];
  const provenance: CrossTeamProvenance = recorded.length > 0 ? 'recorded' : 'inferred';
  const triggers = provenance === 'recorded' ? recorded : [...(input.inferred ?? [])];
  const replies = repliesByKey(input.replies);
  const edges = edgeRows(input.edges, triggers, replies);
  const chains = buildChains(triggers, input.edges, replies, provenance);
  const teams = teamCounts(triggers);
  return {
    provenance,
    edges: edges.slice(0, CROSS_TEAM_STORED_CAP),
    chains: chains.slice(0, CROSS_TEAM_STORED_CAP),
    teams,
  };
}

function edgeRows(
  edges: readonly CrossTeamEdgeInput[],
  triggers: readonly CrossTeamTriggerInput[],
  replies: ReadonlyMap<string, CrossTeamReplyInput[]>,
): CrossTeamEdgeRow[] {
  return edges.map((edge) => {
    const fired = triggers.filter((trigger) => trigger.dep_id === edge.id).sort(byMinute);
    return {
      dep_id: edge.id,
      upstream: edge.upstream,
      downstream: edge.downstream,
      deliverable: edge.deliverable,
      due: dueLabel(edge.due),
      outcome: edge.status === 'recovered' ? 'late' : edge.status,
      broken_minute: edge.broken_minute,
      met_minute: edge.met_minute,
      recovered_minute: edge.recovered_minute,
      consequences: fired.map((trigger) => consequenceOf(trigger, replies)),
    };
  });
}

function consequenceOf(
  trigger: CrossTeamTriggerInput,
  replies: ReadonlyMap<string, CrossTeamReplyInput[]>,
): CrossTeamConsequence {
  const response = replyClause(replies.get(trigger.inject_key) ?? []);
  return {
    inject_key: trigger.inject_key,
    title: trigger.title || trigger.inject_key,
    minute: trigger.minute,
    teams: trigger.target_teams,
    depth: trigger.cause_depth,
    origin_label: originLabel(
      trigger.origin,
      teamsDiffer(trigger.source_teams, trigger.target_teams),
    ),
    response,
  };
}

function buildChains(
  triggers: readonly CrossTeamTriggerInput[],
  edges: readonly CrossTeamEdgeInput[],
  replies: ReadonlyMap<string, CrossTeamReplyInput[]>,
  provenance: CrossTeamProvenance,
): CauseChain[] {
  const edgeById = new Map(edges.map((edge) => [edge.id, edge]));
  const known = new Set(triggers.map((trigger) => trigger.inject_key));
  const segments = segmentsOf(
    triggers.filter((trigger) => isChainTrigger(trigger)),
    edgeById,
    replies,
  );
  linkSegments(segments, known);
  const visited = new Set<string>();
  const chains: CauseChain[] = [];
  const roots = segments
    .filter((segment) => segment.parentId == null)
    .sort(
      (left, right) => compareMinute(left.minute, right.minute) || left.id.localeCompare(right.id),
    );
  for (const root of roots) chains.push(stitch(root, segments, visited, provenance));
  for (const segment of segments) {
    if (!visited.has(segment.id)) chains.push(stitch(segment, segments, visited, provenance));
  }
  return chains.sort(
    (left, right) => compareMinute(left.minute, right.minute) || left.id.localeCompare(right.id),
  );
}

function segmentsOf(
  triggers: readonly CrossTeamTriggerInput[],
  edges: ReadonlyMap<string, CrossTeamEdgeInput>,
  replies: ReadonlyMap<string, CrossTeamReplyInput[]>,
): Segment[] {
  const groups = new Map<string, CrossTeamTriggerInput[]>();
  for (const trigger of triggers) {
    const id = trigger.dep_id ? `dep:${trigger.dep_id}` : `key:${trigger.inject_key}`;
    const list = groups.get(id);
    if (list) list.push(trigger);
    else groups.set(id, [trigger]);
  }
  const segments: Segment[] = [];
  for (const [id, group] of groups) {
    const ordered = [...group].sort(byMinute);
    const depId = ordered.find((trigger) => trigger.dep_id)?.dep_id ?? null;
    const edge = depId ? edges.get(depId) : undefined;
    const keys = ordered.map((trigger) => trigger.inject_key);
    const parents = unique(
      ordered.flatMap((trigger) => trigger.parent_inject_keys).filter((key) => !keys.includes(key)),
    );
    const depth = ordered.reduce((max, trigger) => Math.max(max, trigger.cause_depth), 0);
    segments.push({
      id,
      minute: segmentMinute(ordered, edge),
      depth,
      opening: openingOf(edge),
      receives: ordered.flatMap((trigger) => receiveClauses(trigger, replies)),
      keys,
      parents,
      missing: [],
      parentId: null,
    });
  }
  return segments;
}

function linkSegments(segments: readonly Segment[], known: ReadonlySet<string>): void {
  const owner = new Map<string, Segment>();
  for (const segment of segments) {
    for (const key of segment.keys) {
      const current = owner.get(key);
      if (!current || compareMinute(segment.minute, current.minute) < 0) owner.set(key, segment);
    }
  }
  for (const segment of segments) {
    for (const parent of segment.parents) {
      const found = owner.get(parent);
      if (found && found.id !== segment.id) {
        if (segment.parentId == null && !wouldCycle(segments, found.id, segment.id)) {
          segment.parentId = found.id;
        }
      } else if (!known.has(parent) && !segment.missing.includes(parent)) {
        segment.missing.push(parent);
      }
    }
  }
}

function wouldCycle(segments: readonly Segment[], parentId: string, childId: string): boolean {
  const byId = new Map(segments.map((segment) => [segment.id, segment]));
  let cursor: string | null = parentId;
  const seen = new Set<string>();
  while (cursor) {
    if (cursor === childId) return true;
    if (seen.has(cursor)) return true;
    seen.add(cursor);
    cursor = byId.get(cursor)?.parentId ?? null;
  }
  return false;
}

function stitch(
  root: Segment,
  segments: readonly Segment[],
  visited: Set<string>,
  provenance: CrossTeamProvenance,
): CauseChain {
  const ordered = collect(root, segments, visited);
  const parts = [root.opening];
  const missing: string[] = [];
  let depth = 0;
  for (const segment of ordered) {
    parts.push(...segment.receives);
    depth = Math.max(depth, segment.depth);
    for (const key of segment.missing) {
      if (!missing.includes(key)) missing.push(key);
    }
  }
  return {
    id: ordered.map((segment) => segment.id).join('+'),
    minute: root.minute,
    depth,
    text: chainText(parts, missing, provenance),
    missing_parents: missing,
    provenance,
  };
}

function collect(root: Segment, segments: readonly Segment[], visited: Set<string>): Segment[] {
  const out: Segment[] = [];
  const walk = (segment: Segment) => {
    if (visited.has(segment.id)) return;
    visited.add(segment.id);
    out.push(segment);
    const children = segments
      .filter((item) => item.parentId === segment.id)
      .sort(
        (left, right) =>
          compareMinute(left.minute, right.minute) || left.id.localeCompare(right.id),
      );
    for (const child of children) walk(child);
  };
  walk(root);
  return out;
}

function chainText(
  parts: string[],
  missing: readonly string[],
  provenance: CrossTeamProvenance,
): string {
  const body = parts.map((part) => part.trim()).filter(Boolean);
  if (missing.length > 0) {
    body.push(`parent ${missing.map((key) => `'${key}'`).join(', ')} was not recorded`);
  }
  if (provenance === 'inferred') body.push('inferred');
  return body.join(' → ');
}

function isChainTrigger(trigger: CrossTeamTriggerInput): boolean {
  if (trigger.origin === 'dependency' || trigger.origin === 'director') return true;
  if (trigger.dep_id) return true;
  if (trigger.cause_depth > 0) return true;
  return (
    teamsDiffer(trigger.source_teams, trigger.target_teams) &&
    trigger.origin !== 'timed' &&
    trigger.origin !== 'trainer'
  );
}

function openingOf(edge: CrossTeamEdgeInput | undefined): string {
  if (!edge) return '';
  const detail =
    edge.evidence?.map((item) => item.detail.trim()).find((item) => item !== '') ??
    `missed "${edge.deliverable}"`;
  if (edge.broken_minute != null) {
    return `T+${edge.broken_minute} ${edge.upstream} ${detail} → dependency broken`;
  }
  if (edge.met_minute != null && edge.status === 'met') {
    return `T+${edge.met_minute} ${edge.upstream} delivered "${edge.deliverable}" on time → dependency met`;
  }
  if (edge.recovered_minute != null) {
    return `T+${edge.recovered_minute} ${edge.upstream} delivered "${edge.deliverable}" late → dependency recovered`;
  }
  return '';
}

function receiveClauses(
  trigger: CrossTeamTriggerInput,
  replies: ReadonlyMap<string, CrossTeamReplyInput[]>,
): string[] {
  const title = trigger.title || trigger.inject_key;
  const who = trigger.target_teams.filter((team) => team.trim() !== '').join(' and ') || 'a team';
  const stamp = trigger.minute == null ? '' : `T+${trigger.minute} `;
  let line = `${stamp}${who} receives "${title}"`;
  if (trigger.cause_depth > 1) line += ` (depth ${trigger.cause_depth})`;
  if (trigger.origin === 'director') line += ' · Unscripted (AI director)';
  const clauses = [line];
  const reply = replyClause(replies.get(trigger.inject_key) ?? []);
  if (reply) clauses.push(reply);
  return clauses;
}

function replyClause(replies: readonly CrossTeamReplyInput[]): string | null {
  if (replies.length === 0) return null;
  const ordered = [...replies].sort((left, right) => left.minute - right.minute);
  return ordered
    .map((reply) => {
      const bits: string[] = [];
      if (reply.tone) bits.push(reply.tone);
      if (reply.criteria_met != null && reply.criteria_total != null && reply.criteria_total > 0) {
        bits.push(`${reply.criteria_met}/${reply.criteria_total}`);
      }
      const tail = bits.length > 0 ? ` (${bits.join(', ')})` : '';
      const team = reply.team.trim() || 'The team';
      return `${team} replied T+${reply.minute}${tail}`;
    })
    .join('; ');
}

function teamCounts(triggers: readonly CrossTeamTriggerInput[]): TeamCrossTeamCount[] {
  const names = new Map<string, string>();
  const caused = new Map<string, number>();
  const received = new Map<string, number>();
  const remember = (name: string) => {
    const label = name.trim();
    if (!label) return null;
    const key = teamKey(label);
    if (!names.has(key)) names.set(key, label);
    return key;
  };
  const events: PressureEvent[] = [];
  for (const trigger of triggers) {
    const kind = pressureKind(trigger.origin, trigger.source_teams, trigger.target_teams);
    events.push({
      minute: trigger.minute ?? 0,
      origin: trigger.origin,
      source_teams: trigger.source_teams,
      target_teams: trigger.target_teams,
    });
    for (const name of trigger.source_teams) remember(name);
    for (const name of trigger.target_teams) remember(name);
    if (kind === 'cross_team') {
      for (const name of trigger.source_teams) {
        const key = remember(name);
        if (!key) continue;
        const hitsSomeoneElse = trigger.target_teams.some((target) => !sameTeamName(target, name));
        if (hitsSomeoneElse) caused.set(key, (caused.get(key) ?? 0) + 1);
      }
    }
    if (kind === 'cross_team' || kind === 'unscripted') {
      for (const name of trigger.target_teams) {
        const key = remember(name);
        if (!key) continue;
        received.set(key, (received.get(key) ?? 0) + 1);
      }
    }
  }
  const pressure = new Map<string, TeamPressure>();
  for (const row of countPressure(events)) pressure.set(teamKey(row.team), row);
  return [...names.entries()]
    .map(([key, team]) => {
      const row = pressure.get(key) ?? { team, authored: 0, cross_team: 0, unscripted: 0 };
      const total = row.authored + row.cross_team + row.unscripted;
      return {
        team,
        caused: caused.get(key) ?? 0,
        received: received.get(key) ?? 0,
        pressure: {
          authored: row.authored,
          cross_team: row.cross_team,
          unscripted: row.unscripted,
        },
        share: {
          authored: percent(row.authored, total),
          cross_team: percent(row.cross_team, total),
          unscripted: percent(row.unscripted, total),
        },
      };
    })
    .sort((left, right) => left.team.localeCompare(right.team));
}

function repliesByKey(replies: readonly CrossTeamReplyInput[]): Map<string, CrossTeamReplyInput[]> {
  const map = new Map<string, CrossTeamReplyInput[]>();
  for (const reply of replies) {
    const list = map.get(reply.inject_key);
    if (list) list.push(reply);
    else map.set(reply.inject_key, [reply]);
  }
  return map;
}

function dueLabel(due: DependencyDue): string {
  if ('by_minute' in due) return `by T+${due.by_minute}`;
  return `within ${due.within_minutes} min of ${due.after_inject_key}`;
}

function segmentMinute(
  triggers: readonly CrossTeamTriggerInput[],
  edge: CrossTeamEdgeInput | undefined,
): number | null {
  if (edge?.broken_minute != null) return edge.broken_minute;
  if (edge?.met_minute != null) return edge.met_minute;
  const known = triggers
    .map((trigger) => trigger.minute)
    .filter((minute): minute is number => minute != null);
  if (known.length === 0) return null;
  return Math.min(...known);
}

function byMinute(left: CrossTeamTriggerInput, right: CrossTeamTriggerInput): number {
  return (
    compareMinute(left.minute, right.minute) || left.inject_key.localeCompare(right.inject_key)
  );
}

function compareMinute(left: number | null, right: number | null): number {
  const a = left == null ? Number.MAX_SAFE_INTEGER : left;
  const b = right == null ? Number.MAX_SAFE_INTEGER : right;
  return a - b;
}

function percent(count: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((count / total) * 100);
}

function unique(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}
