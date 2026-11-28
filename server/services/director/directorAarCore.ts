/**
 * After-action view of the consequence director. No database access.
 * Origin labels reuse the cross-team panel. Fairness reuses fairnessState.
 * Replay status is the result of replayDirectorSession.
 */

import { AAR_STORED_CAP } from '../../../shared/crossTeamAar.js';
import {
  isDirectorInjectKey,
  type FairnessSummaryRow,
  type ReplayStatus,
  type UnscriptedAarSection,
  type UnscriptedEventRow,
} from '../../../shared/directorAar.js';
import { referencedInjectKeys } from '../conditions/crossTeamCore.js';
import { fairnessState, type DirectorTeam, type ExposureEvent, type FairnessState } from './directorCore.js';
import { sameTeamName } from './directorSignals.js';

export type { FairnessSummaryRow, ReplayStatus, UnscriptedAarSection, UnscriptedEventRow };

export const EVENT_STATUSES = ['approved', 'edited', 'auto_published'] as const;
export const WITHHELD_STATUSES = ['vetoed', 'expired', 'rejected_guardrail'] as const;

const EVENT = new Set<string>(EVENT_STATUSES);
const WITHHELD = new Set<string>(WITHHELD_STATUSES);

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
 * Catalogue keys from the causing signals. A key is kept only when it parses
 * and every inject it names is a template inject. Director `dir_*` keys are
 * dropped: they do not exist in the next session. When nothing remains, the
 * promoted inject is timed at the same minute.
 */
export function promotionConditions(
  signals: ReadonlyArray<{ id: string; keys?: readonly string[] }>,
  signalIds: readonly string[],
  minute: number,
  known: (key: string) => boolean,
  templateKeys: ReadonlySet<string>,
): PromotionSchedule {
  const byId = new Map(signals.map((signal) => [signal.id, signal]));
  const keys: string[] = [];
  const seen = new Set<string>();
  const add = (key: string) => {
    const trimmed = key.trim();
    if (!trimmed || seen.has(trimmed) || !known(trimmed)) return;
    if (!promotableKey(trimmed, templateKeys)) return;
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

function promotableKey(key: string, templateKeys: ReadonlySet<string>): boolean {
  const refs = referencedInjectKeys(key);
  return refs.every((ref) => !isDirectorInjectKey(ref) && templateKeys.has(ref));
}

/** Stored fairness JSON. A row that is not the fairness shape is ignored. */
export function parseStoredFairness(value: unknown): FairnessState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (!Array.isArray(row.teams)) return null;
  const teams: FairnessState['teams'] = [];
  for (const item of row.teams) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const team = item as Record<string, unknown>;
    if (typeof team.team !== 'string') return null;
    if (typeof team.negative_load !== 'number' || typeof team.positive_load !== 'number') return null;
    teams.push({
      team: team.team,
      size: typeof team.size === 'number' ? team.size : 1,
      staffed: team.staffed !== false,
      negative_load: team.negative_load,
      positive_load: team.positive_load,
      fair_share: typeof team.fair_share === 'number' ? team.fair_share : 0,
      size_scale: typeof team.size_scale === 'number' ? team.size_scale : 1,
      relief_owed: team.relief_owed === true,
      over_cap: team.over_cap === true,
    });
  }
  return {
    teams,
    tolerance: typeof row.tolerance === 'number' ? row.tolerance : 0,
    last_third: row.last_third === true,
    mean_negative: typeof row.mean_negative === 'number' ? row.mean_negative : 0,
    minute: typeof row.minute === 'number' ? row.minute : 0,
    duration: typeof row.duration === 'number' ? row.duration : 0,
  };
}

/** Session minute of the trainer decision, or the proposal minute when it was not stored. */
export function decisionMinuteOf(
  decidedAt: string | null,
  startIso: string | null,
  proposalMinute: number,
): number {
  if (!decidedAt || !startIso) return proposalMinute;
  const at = Date.parse(decidedAt);
  const start = Date.parse(startIso);
  if (!Number.isFinite(at) || !Number.isFinite(start)) return proposalMinute;
  return Math.max(0, Math.floor((at - start) / 60000));
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

export function unscriptedNotesFrom(
  rows: ReadonlyArray<{
    seq: number;
    status: string;
    reason: string | null;
    approver: string;
    edited: boolean;
    decisionMinute: number;
  }>,
): Record<string, string> {
  const notes: Record<string, string> = {};
  for (const row of rows) {
    if (!EVENT.has(row.status)) continue;
    notes[`dir_${row.seq}`] = unscriptedSentence({
      reason: row.reason ?? '',
      minute: row.decisionMinute,
      approver: row.status === 'auto_published' ? 'auto' : row.approver || 'trainer',
      edited: row.edited,
    });
  }
  return notes;
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
