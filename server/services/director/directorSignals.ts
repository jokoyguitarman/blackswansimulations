/**
 * Notable events the consequence director can wake on. No database access.
 * Cascade depth uses WP4 `causeDepth` (inherited hops + 1), so a later trigger
 * row can chain from the signal's condition keys.
 */

import { slugifyTeamName } from '../../../shared/conditionKeyGrammar.js';
import { causeDepth, type DepthTrigger } from '../conditions/crossTeamCore.js';

export type SignalKind =
  | 'dependency_broken'
  | 'dependency_recovered'
  | 'dependency_met'
  | 'reply_failed'
  | 'reply_tone'
  | 'reply_risky_admission'
  | 'mood'
  | 'chain_exhausted'
  | 'team_silent'
  | 'duty_missed'
  | 'duty_done'
  | 'content_failed'
  | 'decision'
  | 'relief';

export interface Signal {
  id: string;
  kind: SignalKind;
  team: string;
  minute: number;
  detail: string;
  /** Inherited hops + 1, from `causeDepth` on `keys`. */
  depth: number;
  /** Condition keys `causeDepth` read. Empty when the signal names no inject. */
  keys: string[];
  /** False for qualifying positives that must not wake the director on their own. */
  notable: boolean;
}

export interface PreviousWake {
  minute: number;
  signal_ids: readonly string[];
}

export interface DependencySnapshot {
  status: string;
  broken_minute?: number | null;
  met_minute?: number | null;
  recovered_minute?: number | null;
  upstream?: string;
  downstream?: string[];
  deliverable?: string;
  evidence?: Array<{ key?: string; detail?: string; minute?: number }>;
}

export interface SignalTeam {
  name: string;
  slug?: string;
}

interface SignalJudgement {
  passed?: boolean;
  tone?: string;
  relevance?: number;
  scores?: Record<string, number>;
  risky_admissions?: string[];
}

interface SignalResponse {
  minute: number;
  team: string | null;
  id?: string;
  judgement: SignalJudgement | null;
}

interface SignalDelivery {
  inject_key: string;
  delivered_minute: number;
  recipient_teams: string[];
  first_response_team: string | null;
  responses: SignalResponse[];
}

export interface SignalComms {
  by_key?: Record<string, SignalDelivery[]>;
  chains?: Record<
    string,
    Array<{
      chain_id: string;
      scope_team: string | null;
      status: string;
      stopped_minute: number | null;
    }>
  >;
  moods?: Array<{ stakeholder_id: string; scope_team: string; rung_id: string }>;
  duties?: Record<
    string,
    Array<{ action_id: string; benchmark_minute: number | null; completed_minute: number | null }>
  >;
  duties_known?: boolean;
  duties_truncated?: boolean;
  team_activity?: Record<string, { last_minute: number | null }>;
  team_activity_known?: boolean;
  team_activity_truncated?: boolean;
  content_grades?: Record<string, number[]>;
  content_grades_known?: boolean;
  decisions?: Array<{ team_slug: string; category: string; minute: number }>;
  decisions_enabled?: boolean;
  decisions_known?: boolean;
  team_labels?: Record<string, string>;
}

export interface DirectorSignalState {
  minute: number;
  teams?: readonly SignalTeam[];
  comms?: SignalComms;
  /** Read only when the property is present. WP2 adds it; until then there are no dependency signals. */
  dependency_state?: Record<string, DependencySnapshot>;
  triggers_by_key?: Readonly<Record<string, DepthTrigger | undefined>>;
  active_plans?: ReadonlyArray<{ team_slug: string; category: string }>;
  silence_minutes?: number;
  content_failed?: { count: number; below: number };
}

const BAD_TONES = new Set(['hostile', 'dismissive', 'defensive']);
const BAD_MOODS = new Set(['angry', 'disappointed', 'gave_up']);
const HIGH_SCORE = 70;

export function sameTeamName(a: string, b: string): boolean {
  if (a === b) return true;
  const left = slugifyTeamName(a);
  const right = slugifyTeamName(b);
  return left !== '' && left === right;
}

export function collectSignals(
  state: DirectorSignalState,
  previousWake: PreviousWake | null,
): Signal[] {
  const triggers = state.triggers_by_key ?? {};
  const signals: Signal[] = [];
  const seen = new Set<string>();

  const push = (signal: Signal) => {
    if (seen.has(signal.id)) return;
    seen.add(signal.id);
    signals.push(signal);
  };

  if (state.dependency_state) {
    for (const id of Object.keys(state.dependency_state).sort()) {
      const edge = state.dependency_state[id];
      if (!edge) continue;
      pushDependency(push, id, edge, state.minute, triggers);
    }
  }

  const comms = state.comms;
  if (comms) {
    collectReplies(push, comms, state, triggers);
    collectDuties(push, comms, state.minute, triggers);
    collectSilence(push, comms, state, triggers);
    collectContent(push, comms, state, triggers);
    collectDecisions(push, comms, state, triggers);
    collectChains(push, comms, state.minute, triggers);
    collectMoods(push, comms, state.minute, triggers);
  }

  const previous = new Set(previousWake?.signal_ids ?? []);
  return signals
    .filter((signal) => !previous.has(signal.id))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function pushDependency(
  push: (signal: Signal) => void,
  id: string,
  edge: DependencySnapshot,
  minute: number,
  triggers: Readonly<Record<string, DepthTrigger | undefined>>,
): void {
  const evidence = (edge.evidence ?? [])
    .map((item) => item.key)
    .filter((key): key is string => Boolean(key));
  const keys = evidence.length > 0 ? evidence : [`dependency_broken:${id}`];
  const depth = causeDepth(keys, triggers);
  const team = edge.upstream?.trim() || 'upstream';
  const downstream = (edge.downstream ?? []).filter(Boolean).join(', ');
  const deliverable = edge.deliverable?.trim() || id;
  const who = downstream ? `${team} → ${downstream}` : team;
  if (edge.status === 'broken') {
    push({
      id: `dependency_broken:${id}`,
      kind: 'dependency_broken',
      team,
      minute: edge.broken_minute ?? minute,
      detail: `${who}: ${deliverable} is broken`,
      depth,
      keys,
      notable: true,
    });
  } else if (edge.status === 'recovered') {
    push({
      id: `dependency_recovered:${id}`,
      kind: 'dependency_recovered',
      team,
      minute: edge.recovered_minute ?? edge.broken_minute ?? minute,
      detail: `${who}: ${deliverable} was delivered late`,
      depth,
      keys,
      notable: true,
    });
  } else if (edge.status === 'met') {
    push({
      id: `dependency_met:${id}`,
      kind: 'dependency_met',
      team,
      minute: edge.met_minute ?? minute,
      detail: `${who}: ${deliverable} was delivered on time`,
      depth: causeDepth(keys, triggers),
      keys,
      notable: false,
    });
  }
}

function collectReplies(
  push: (signal: Signal) => void,
  comms: SignalComms,
  state: DirectorSignalState,
  triggers: Readonly<Record<string, DepthTrigger | undefined>>,
): void {
  const keys = Object.keys(comms.by_key ?? {}).sort();
  for (const injectKey of keys) {
    const deliveries = [...(comms.by_key?.[injectKey] ?? [])].sort(
      (a, b) => a.delivered_minute - b.delivered_minute,
    );
    for (const delivery of deliveries) {
      const responses = [...delivery.responses].sort(
        (a, b) => a.minute - b.minute || (a.id ?? '').localeCompare(b.id ?? ''),
      );
      for (const response of responses) {
        const judgement = response.judgement;
        if (!judgement) continue;
        const team = teamLabel(
          response.team || delivery.first_response_team || delivery.recipient_teams[0] || '',
          state,
          comms,
        );
        if (!team) continue;
        const slug = slugifyTeamName(team);
        const scope = `|team=${slug}`;
        const replyKey = (prefix: string) => `${prefix}:${delivery.inject_key}${scope}`;
        if (judgement.passed === false) {
          const keysFor = [replyKey('reply_failed')];
          push({
            id: `reply_failed:${delivery.inject_key}:${slug}:${response.minute}`,
            kind: 'reply_failed',
            team,
            minute: response.minute,
            detail: `${team} failed the reply to ${delivery.inject_key}`,
            depth: causeDepth(keysFor, triggers),
            keys: keysFor,
            notable: true,
          });
        }
        const tone = (judgement.tone ?? '').toLowerCase();
        if (BAD_TONES.has(tone)) {
          const keysFor = [replyKey('reply_tone')];
          push({
            id: `reply_tone:${delivery.inject_key}:${slug}:${tone}:${response.minute}`,
            kind: 'reply_tone',
            team,
            minute: response.minute,
            detail: `${team} replied ${tone} to ${delivery.inject_key}`,
            depth: causeDepth(keysFor, triggers),
            keys: keysFor,
            notable: true,
          });
        }
        if ((judgement.risky_admissions?.length ?? 0) > 0) {
          const keysFor = [replyKey('reply_risky_admission')];
          push({
            id: `reply_risky:${delivery.inject_key}:${slug}:${response.minute}`,
            kind: 'reply_risky_admission',
            team,
            minute: response.minute,
            detail: `${team} made a risky admission in ${delivery.inject_key}`,
            depth: causeDepth(keysFor, triggers),
            keys: keysFor,
            notable: true,
          });
        }
        if (highScore(judgement) && brokenDependencyTouches(state.dependency_state, team)) {
          const keysFor = [replyKey('reply_passed')];
          push({
            id: `relief:${delivery.inject_key}:${slug}:${response.minute}`,
            kind: 'relief',
            team,
            minute: response.minute,
            detail: `${team} passed ${delivery.inject_key} with a high mark after a broken dependency`,
            depth: causeDepth(keysFor, triggers),
            keys: keysFor,
            notable: true,
          });
        }
      }
    }
  }
}

function collectDuties(
  push: (signal: Signal) => void,
  comms: SignalComms,
  minute: number,
  triggers: Readonly<Record<string, DepthTrigger | undefined>>,
): void {
  if (comms.duties_known === false || comms.duties == null) return;
  for (const slug of Object.keys(comms.duties).sort()) {
    const label = comms.team_labels?.[slug] ?? titleFromSlug(slug);
    for (const duty of comms.duties[slug] ?? []) {
      const completed = duty.completed_minute;
      const benchmark = duty.benchmark_minute;
      if (
        completed != null &&
        completed <= minute &&
        (benchmark == null || completed <= benchmark)
      ) {
        const keys = [`duty_done:${duty.action_id}|team=${slug}`];
        push({
          id: `duty_done:${slug}:${duty.action_id}`,
          kind: 'duty_done',
          team: label,
          minute: completed,
          detail: `${label} completed ${duty.action_id} at T+${completed}`,
          depth: causeDepth(keys, triggers),
          keys,
          notable: false,
        });
      }
      if (comms.duties_truncated) continue;
      if (benchmark == null) continue;
      const missed = minute > benchmark && (completed == null || completed > benchmark);
      if (!missed) continue;
      const keys = [`duty_missed:${duty.action_id}|team=${slug}`];
      push({
        id: `duty_missed:${slug}:${duty.action_id}`,
        kind: 'duty_missed',
        team: label,
        minute: benchmark,
        detail: `${label} missed ${duty.action_id} (due T+${benchmark})`,
        depth: causeDepth(keys, triggers),
        keys,
        notable: true,
      });
    }
  }
}

function collectSilence(
  push: (signal: Signal) => void,
  comms: SignalComms,
  state: DirectorSignalState,
  triggers: Readonly<Record<string, DepthTrigger | undefined>>,
): void {
  if (comms.team_activity_known === false || comms.team_activity == null) return;
  if (comms.team_activity_truncated) return;
  const quietFor = state.silence_minutes ?? 10;
  for (const slug of Object.keys(comms.team_activity).sort()) {
    const last = comms.team_activity[slug]?.last_minute ?? null;
    const quiet = last == null ? state.minute : state.minute - last;
    if (state.minute < quietFor || quiet < quietFor) continue;
    const label = comms.team_labels?.[slug] ?? titleFromSlug(slug);
    const keys = [`team_silent:${quietFor}|team=${slug}`];
    push({
      id: `team_silent:${slug}`,
      kind: 'team_silent',
      team: label,
      minute: (last ?? 0) + quietFor,
      detail: `${label}: no action since ${last == null ? 'the start' : `T+${last}`} (${quiet} min)`,
      depth: causeDepth(keys, triggers),
      keys,
      notable: true,
    });
  }
}

function collectContent(
  push: (signal: Signal) => void,
  comms: SignalComms,
  state: DirectorSignalState,
  triggers: Readonly<Record<string, DepthTrigger | undefined>>,
): void {
  if (comms.content_grades_known === false || comms.content_grades == null) return;
  const count = state.content_failed?.count ?? 1;
  const below = state.content_failed?.below ?? 50;
  for (const slug of Object.keys(comms.content_grades).sort()) {
    const grades = comms.content_grades[slug] ?? [];
    const failed = grades.filter((grade) => grade < below).length;
    if (failed < count) continue;
    const label = comms.team_labels?.[slug] ?? titleFromSlug(slug);
    const keys = [`content_failed:${count}:${below}|team=${slug}`];
    push({
      id: `content_failed:${slug}`,
      kind: 'content_failed',
      team: label,
      minute: state.minute,
      detail: `${label}: ${failed} graded items fell below ${below}`,
      depth: causeDepth(keys, triggers),
      keys,
      notable: true,
    });
  }
}

function collectDecisions(
  push: (signal: Signal) => void,
  comms: SignalComms,
  state: DirectorSignalState,
  triggers: Readonly<Record<string, DepthTrigger | undefined>>,
): void {
  if (comms.decisions_enabled === false || comms.decisions_known === false) return;
  const plans = state.active_plans ?? [];
  const rows = [...(comms.decisions ?? [])].sort(
    (a, b) =>
      a.minute - b.minute ||
      a.team_slug.localeCompare(b.team_slug) ||
      a.category.localeCompare(b.category),
  );
  for (const row of rows) {
    if (row.minute > state.minute) continue;
    const planned = plans.some(
      (plan) => plan.team_slug === row.team_slug && plan.category === row.category,
    );
    if (planned) continue;
    const label = comms.team_labels?.[row.team_slug] ?? titleFromSlug(row.team_slug);
    const keys = [`decision_made:${row.category}|team=${row.team_slug}`];
    push({
      id: `decision:${row.team_slug}:${row.category}:${row.minute}`,
      kind: 'decision',
      team: label,
      minute: row.minute,
      detail: `${label}: ${row.category.replace(/_/g, ' ')} decision at T+${row.minute}`,
      depth: causeDepth(keys, triggers),
      keys,
      notable: true,
    });
  }
}

function collectChains(
  push: (signal: Signal) => void,
  comms: SignalComms,
  minute: number,
  triggers: Readonly<Record<string, DepthTrigger | undefined>>,
): void {
  if (!comms.chains) return;
  for (const root of Object.keys(comms.chains).sort()) {
    for (const chain of comms.chains[root] ?? []) {
      if (chain.status !== 'exhausted') continue;
      const team = chain.scope_team?.trim() || root;
      push({
        id: `chain_exhausted:${chain.chain_id}`,
        kind: 'chain_exhausted',
        team,
        minute: chain.stopped_minute ?? minute,
        detail: `${team}: escalation on ${root} ran out of steps`,
        depth: causeDepth([], triggers),
        keys: [],
        notable: true,
      });
    }
  }
}

function collectMoods(
  push: (signal: Signal) => void,
  comms: SignalComms,
  minute: number,
  triggers: Readonly<Record<string, DepthTrigger | undefined>>,
): void {
  const moods = [...(comms.moods ?? [])].sort((a, b) =>
    `${a.stakeholder_id}:${a.scope_team}`.localeCompare(`${b.stakeholder_id}:${b.scope_team}`),
  );
  for (const mood of moods) {
    if (!BAD_MOODS.has(mood.rung_id)) continue;
    const team = mood.scope_team.trim() || mood.stakeholder_id;
    push({
      id: `mood:${mood.stakeholder_id}:${mood.scope_team}:${mood.rung_id}`,
      kind: 'mood',
      team,
      minute,
      detail: `${mood.stakeholder_id} is ${mood.rung_id}${mood.scope_team ? ` toward ${mood.scope_team}` : ''}`,
      depth: causeDepth([], triggers),
      keys: [],
      notable: true,
    });
  }
}

function brokenDependencyTouches(
  dependencies: Record<string, DependencySnapshot> | undefined,
  team: string,
): boolean {
  if (!dependencies) return false;
  return Object.values(dependencies).some((edge) => {
    if (edge.status !== 'broken' && edge.status !== 'recovered') return false;
    if (edge.upstream && sameTeamName(edge.upstream, team)) return true;
    return (edge.downstream ?? []).some((name) => sameTeamName(name, team));
  });
}

function highScore(judgement: SignalJudgement): boolean {
  if (judgement.passed !== true) return false;
  const values = Object.values(judgement.scores ?? {}).filter((value) => typeof value === 'number');
  if (values.length > 0) {
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    return mean >= HIGH_SCORE;
  }
  return (judgement.relevance ?? 0) >= HIGH_SCORE;
}

function teamLabel(name: string, state: DirectorSignalState, comms: SignalComms): string {
  const trimmed = name.trim();
  if (!trimmed) return '';
  const slug = slugifyTeamName(trimmed);
  const fromLabel = slug ? comms.team_labels?.[slug] : undefined;
  if (fromLabel) return fromLabel;
  const known = (state.teams ?? []).find(
    (team) =>
      sameTeamName(team.name, trimmed) || (team.slug != null && sameTeamName(team.slug, trimmed)),
  );
  return known?.name ?? trimmed;
}

function titleFromSlug(slug: string): string {
  return slug
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}
