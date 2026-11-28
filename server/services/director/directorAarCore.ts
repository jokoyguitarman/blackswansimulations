/**
 * After-action view of the consequence director. No database access.
 * Origin labels reuse the cross-team panel. Fairness reuses fairnessState.
 * Replay status is the result of replayDirectorSession.
 */

import { AAR_STORED_CAP } from '../../../shared/crossTeamAar.js';
import { originLabel, teamsDiffer } from '../../../shared/crossTeamPanel.js';
import { fairnessState, type DirectorTeam, type ExposureEvent, type FairnessState } from './directorCore.js';
import { sameTeamName } from './directorSignals.js';

export const EVENT_STATUSES = ['approved', 'edited', 'auto_published'] as const;
export const WITHHELD_STATUSES = ['vetoed', 'expired', 'rejected_guardrail'] as const;

const EVENT = new Set<string>(EVENT_STATUSES);
const WITHHELD = new Set<string>(WITHHELD_STATUSES);

export interface TimelineTrigger {
  origin: string;
  source_teams: readonly string[];
  target_teams: readonly string[];
}

export interface PromotionSchedule {
  conditions_to_appear: { all: string[] } | null;
  trigger_time_minutes: number | null;
}

export interface UnscriptedProposalInput {
  seq: number;
  minute: number;
  status: string;
  reason: string | null;
  proposal: {
    title?: string;
    content?: string;
    target_teams?: readonly string[];
    cause?: { signal_ids?: readonly string[]; source_teams?: readonly string[] };
  } | null;
  signals: ReadonlyArray<{ id: string; detail?: string; keys?: readonly string[] }>;
  guardrails: ReadonlyArray<{ id: string; ok: boolean; detail?: string }>;
  fairness: FairnessState | null;
  approverName: string | null;
  editBefore: { title?: string; content?: string } | null;
  editAfter: { title?: string; content?: string } | null;
  vetoReason: string | null;
  injectId: string | null;
}

export interface UnscriptedEventRow {
  minute: number;
  target: string;
  cause: string;
  text: string;
  guardrails: string;
  fairness: string;
  decision: string;
  approver: string;
  edits: string;
  outcome: string;
}

export interface FairnessSummaryRow {
  team: string;
  negative_load: number;
  positive_load: number;
  unscripted_events: number;
}

export interface ReplayStatus {
  available: boolean;
  ok: boolean;
  mismatches: number;
}

export interface UnscriptedAarSection {
  events: UnscriptedEventRow[];
  withheld: UnscriptedEventRow[];
  fairness: FairnessSummaryRow[];
  replay: ReplayStatus;
}

export const UNSCRIPTED_EXPORT_COLUMNS = [
  'minute',
  'target',
  'cause',
  'text',
  'guardrails',
  'fairness',
  'decision',
  'approver',
  'edits',
  'outcome',
] as const;

const DECISION_LABEL: Record<string, string> = {
  approved: 'Approved',
  edited: 'Edited',
  auto_published: 'Auto-published',
  vetoed: 'Vetoed',
  expired: 'Expired',
  rejected_guardrail: 'Rejected',
};

export function emptyUnscriptedAar(): UnscriptedAarSection {
  return {
    events: [],
    withheld: [],
    fairness: [],
    replay: { available: false, ok: false, mismatches: 0 },
  };
}

/**
 * Catalogue keys from the causing signals. Anything that does not parse is
 * dropped. When none remain, the promoted inject is timed at the same minute.
 */
export function promotionConditions(
  signals: ReadonlyArray<{ id: string; keys?: readonly string[] }>,
  signalIds: readonly string[],
  minute: number,
  known: (key: string) => boolean,
): PromotionSchedule {
  const byId = new Map(signals.map((signal) => [signal.id, signal]));
  const keys: string[] = [];
  const seen = new Set<string>();
  const add = (key: string) => {
    const trimmed = key.trim();
    if (!trimmed || seen.has(trimmed) || !known(trimmed)) return;
    seen.add(trimmed);
    keys.push(trimmed);
  };
  for (const id of signalIds) {
    const signal = byId.get(id);
    if (signal) {
      for (const key of signal.keys ?? []) add(key);
    } else {
      add(id);
    }
  }
  keys.sort((a, b) => a.localeCompare(b));
  if (keys.length === 0) {
    return { conditions_to_appear: null, trigger_time_minutes: minute };
  }
  return { conditions_to_appear: { all: keys }, trigger_time_minutes: null };
}

/** §5.9 label. Branch rows keep the label WP7 already set. */
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

export function unscriptedSentence(input: {
  reason: string;
  minute: number;
  approver: string;
  edited: boolean;
}): string {
  const because = input.reason.trim() || 'the session state';
  const decision =
    input.approver === 'auto'
      ? 'auto-published'
      : `approved by ${input.approver} at T+${input.minute}`;
  const edited = input.edited ? ' (edited)' : '';
  return `proposed by the AI director because ${because}; ${decision}${edited}`;
}

export function buildUnscriptedTable(rows: readonly UnscriptedProposalInput[]): {
  events: UnscriptedEventRow[];
  withheld: UnscriptedEventRow[];
} {
  const ordered = [...rows].sort((a, b) => a.minute - b.minute || a.seq - b.seq);
  const events: UnscriptedEventRow[] = [];
  const withheld: UnscriptedEventRow[] = [];
  for (const row of ordered) {
    if (EVENT.has(row.status)) events.push(eventRow(row));
    else if (WITHHELD.has(row.status)) withheld.push(eventRow(row));
  }
  return {
    events: events.slice(0, AAR_STORED_CAP),
    withheld: withheld.slice(0, AAR_STORED_CAP),
  };
}

export function fairnessSummary(
  teams: readonly DirectorTeam[],
  events: readonly ExposureEvent[],
  options: { tolerance: number; minute: number; duration: number },
): FairnessSummaryRow[] {
  const state = fairnessState(teams, events, options);
  return state.teams.map((team) => ({
    team: team.team,
    negative_load: team.negative_load,
    positive_load: team.positive_load,
    unscripted_events: events.filter((event) => sameTeamName(event.team, team.team)).length,
  }));
}

export function replayStatusOf(
  report: { ok: boolean; mismatches: readonly unknown[] } | { unavailable: true } | null,
): ReplayStatus {
  if (!report || 'unavailable' in report) {
    return { available: false, ok: false, mismatches: 0 };
  }
  return { available: true, ok: report.ok, mismatches: report.mismatches.length };
}

export function unscriptedExportRows(
  rows: readonly UnscriptedEventRow[],
): Array<Record<(typeof UNSCRIPTED_EXPORT_COLUMNS)[number], string>> {
  return rows.map((row) => ({
    minute: String(row.minute),
    target: row.target,
    cause: row.cause,
    text: row.text,
    guardrails: row.guardrails,
    fairness: row.fairness,
    decision: row.decision,
    approver: row.approver,
    edits: row.edits,
    outcome: row.outcome,
  }));
}

function eventRow(row: UnscriptedProposalInput): UnscriptedEventRow {
  const targets = [...(row.proposal?.target_teams ?? [])];
  const approver = approverOf(row);
  return {
    minute: row.minute,
    target: targets.join(', ') || '—',
    cause: causeOf(row),
    text: textOf(row),
    guardrails: guardrailText(row.guardrails),
    fairness: fairnessText(row.fairness, targets),
    decision: DECISION_LABEL[row.status] ?? row.status,
    approver,
    edits: editsText(row.editBefore, row.editAfter),
    outcome: outcomeOf(row),
  };
}

function approverOf(row: UnscriptedProposalInput): string {
  if (row.status === 'auto_published') return 'auto';
  if (row.approverName) return row.approverName;
  if (row.status === 'approved' || row.status === 'edited' || row.status === 'vetoed') return 'trainer';
  return '—';
}

function causeOf(row: UnscriptedProposalInput): string {
  const ids = row.proposal?.cause?.signal_ids ?? [];
  const details = ids
    .map((id) => row.signals.find((signal) => signal.id === id)?.detail?.trim())
    .filter((detail): detail is string => Boolean(detail));
  if (details.length > 0) return details.join('; ');
  const teams = (row.proposal?.cause?.source_teams ?? []).filter(Boolean);
  if (teams.length > 0 && ids.length > 0) return `${teams.join(', ')} · ${ids.join(', ')}`;
  if (row.reason?.trim()) return row.reason.trim();
  return '—';
}

function textOf(row: UnscriptedProposalInput): string {
  const title = row.proposal?.title?.trim() ?? '';
  const content = row.proposal?.content?.trim() ?? '';
  if (title && content) return `${title} — ${content}`;
  return title || content || '—';
}

function guardrailText(rows: ReadonlyArray<{ id: string; ok: boolean; detail?: string }>): string {
  if (rows.length === 0) return '—';
  if (rows.every((row) => row.ok)) return 'all passed';
  return rows
    .filter((row) => !row.ok)
    .map((row) => `${row.id}: ${row.detail?.trim() || 'failed'}`)
    .join('; ');
}

function fairnessText(fairness: FairnessState | null, targets: readonly string[]): string {
  if (!fairness) return '—';
  if (targets.length === 0) return '—';
  return targets
    .map((target) => {
      const team = fairness.teams.find((row) => sameTeamName(row.team, target));
      if (!team) return target;
      return `${team.team} neg ${team.negative_load} pos ${team.positive_load}`;
    })
    .join('; ');
}

function editsText(
  before: { title?: string; content?: string } | null,
  after: { title?: string; content?: string } | null,
): string {
  if (!before || !after) return '—';
  const parts: string[] = [];
  if ((before.title ?? '') !== (after.title ?? '')) {
    parts.push(`title: ${before.title ?? ''} → ${after.title ?? ''}`);
  }
  if ((before.content ?? '') !== (after.content ?? '')) {
    parts.push(`content: ${before.content ?? ''} → ${after.content ?? ''}`);
  }
  return parts.join(' | ') || '—';
}

function outcomeOf(row: UnscriptedProposalInput): string {
  if (EVENT.has(row.status) && row.injectId) return 'published';
  if (row.status === 'vetoed') return row.vetoReason?.trim() || 'vetoed';
  if (row.status === 'expired') return 'expired';
  if (row.status === 'rejected_guardrail') {
    const failed = row.guardrails.find((item) => !item.ok);
    return failed ? `rejected: ${failed.id}` : 'rejected';
  }
  if (EVENT.has(row.status)) return 'approved';
  return row.status;
}
