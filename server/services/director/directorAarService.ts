/**
 * Loads director proposals for the after-action report. Missing migration
 * 279 leaves the section empty and warns once. Reads are capped.
 */

import { supabaseAdmin } from '../../lib/supabaseAdmin.js';
import { isUnappliedSchema } from '../../lib/unappliedSchema.js';
import { logger } from '../../lib/logger.js';
import { env } from '../../env.js';
import { teamsValidAt } from '../../lib/templateRows.js';
import { rosterValidAt } from '../../lib/peaceGate.js';
import { openedAtOf, selectSession, type SessionClockFields } from '../../lib/peaceSchema.js';
import { replayStoredSession } from './directorService.js';
import { publishedCapEvents } from './directorPublish.js';
import type { DirectorTeam } from './directorCore.js';
import {
  buildUnscriptedTable,
  decisionMinuteOf,
  emptyUnscriptedAar,
  fairnessSummary,
  parseStoredFairness,
  replayStatusOf,
  unscriptedNotesFrom,
  type UnscriptedAarSection,
  type UnscriptedEventRow,
  type UnscriptedProposalInput,
} from './directorAarCore.js';

const PROPOSAL_READ_LIMIT = 300;
const NAME_READ_LIMIT = 50;
const TEAM_READ_LIMIT = 500;

const PROPOSAL_COLUMNS =
  'seq, minute, status, proposal, signals, guardrails, fairness, decided_by, decided_at, edit_before, edit_after, veto_reason, inject_id, reason:observation->>decision_reason, model_reason:raw_output->>reason';

interface ProposalRecord {
  seq: number;
  minute: number;
  status: string;
  proposal: unknown;
  signals: unknown;
  guardrails: unknown;
  fairness: unknown;
  decided_by: string | null;
  decided_at: string | null;
  edit_before: unknown;
  edit_after: unknown;
  veto_reason: string | null;
  inject_id: string | null;
  reason: string | null;
}

export interface DirectorAarLoad {
  notes: Record<string, string>;
  section: UnscriptedAarSection;
  withheld: UnscriptedEventRow[];
}

/**
 * One light proposal read for a report. Timeline notes, the public section
 * and the trainer-only rows are filters of these rows. Replay reads
 * `observation` on its own, and only when there is a row to check.
 */
export async function loadDirectorAar(
  sessionId: string,
  startTime: string | null,
  scenarioId: string | null,
): Promise<DirectorAarLoad> {
  const empty = { notes: {}, section: emptyUnscriptedAar(), withheld: [] as UnscriptedEventRow[] };
  try {
    const rows = await readProposals(sessionId);
    if (rows == null) return empty;
    const names = await loadNames(rows);
    const inputs = rows.map((row) => toInput(row, names));
    const table = buildUnscriptedTable(inputs);
    const notes = unscriptedNotesFrom(
      rows.map((row) => ({
        seq: row.seq,
        status: row.status,
        reason: row.reason,
        approver: approverName(row, names),
        edited: row.status === 'edited',
        decisionMinute: decisionMinuteOf(row.decided_at, startTime, row.minute),
      })),
    );
    const replay =
      rows.length === 0
        ? { ok: true as const, mismatches: [] as const }
        : await replayStoredSession(sessionId).catch(() => ({ unavailable: true as const }));
    const context = await loadFairnessContext({ sessionId, scenarioId, startTime, rows });
    return {
      notes,
      withheld: table.withheld,
      section: {
        events: table.events,
        withheld: [],
        fairness: context
          ? fairnessSummary(context.teams, publishedCapEvents(capRows(rows)), {
              tolerance: env.directorFairnessTolerance,
              minute: context.minute,
              duration: context.duration,
            })
          : [],
        replay: replayStatusOf(replay),
      },
    };
  } catch (err) {
    logger.warn({ err, sessionId, event: 'director_aar_failed' }, 'Unscripted events omitted');
    return empty;
  }
}

export async function withTrainerUnscripted(
  sections: Record<string, { data?: unknown; analysis?: string | null }>,
  sessionId: string,
): Promise<Record<string, { data?: unknown; analysis?: string | null }>> {
  const rows = await readProposals(sessionId);
  const names = rows == null ? new Map<string, string>() : await loadNames(rows);
  const withheld = rows == null ? [] : buildUnscriptedTable(rows.map((row) => toInput(row, names))).withheld;
  const current = sections.unscripted_events;
  if (!current && withheld.length === 0) return sections;
  const data =
    current?.data && typeof current.data === 'object' && !Array.isArray(current.data)
      ? { ...(current.data as Record<string, unknown>), withheld }
      : { ...emptyUnscriptedAar(), withheld };
  return {
    ...sections,
    unscripted_events: { analysis: current?.analysis ?? null, data },
  };
}

async function readProposals(sessionId: string): Promise<ProposalRecord[] | null> {
  const { data, error } = await supabaseAdmin
    .from('director_proposals')
    .select(PROPOSAL_COLUMNS)
    .eq('session_id', sessionId)
    .order('seq', { ascending: true })
    .limit(PROPOSAL_READ_LIMIT);
  if (error) {
    if (isUnappliedSchema(error)) {
      warnMissing(error);
      return null;
    }
    logger.warn({ err: error, sessionId }, 'director proposals were not read for the AAR');
    return [];
  }
  return (data ?? []).map(recordOf);
}

async function loadNames(rows: readonly ProposalRecord[]): Promise<Map<string, string>> {
  const ids = [...new Set(rows.map((row) => row.decided_by).filter((id): id is string => Boolean(id)))];
  const names = new Map<string, string>();
  if (ids.length === 0) return names;
  const { data, error } = await supabaseAdmin
    .from('user_profiles')
    .select('id, full_name')
    .in('id', ids.slice(0, NAME_READ_LIMIT));
  if (error) return names;
  for (const row of data ?? []) names.set(String(row.id), String(row.full_name || 'trainer'));
  return names;
}

interface SessionRow extends SessionClockFields {
  scenario_id: string | null;
  start_time: string | null;
}

async function loadFairnessContext(input: {
  sessionId: string;
  scenarioId: string | null;
  startTime: string | null;
  rows: readonly ProposalRecord[];
}): Promise<{ teams: DirectorTeam[]; minute: number; duration: number } | null> {
  let scenarioId = input.scenarioId;
  let startTime = input.startTime;
  if (!scenarioId) {
    const sessionResult = await selectSession<SessionRow>(
      'scenario_id, start_time',
      (query) => query.eq('id', input.sessionId).maybeSingle(),
    );
    const session = sessionResult.data;
    if (!session?.scenario_id) return null;
    scenarioId = session.scenario_id;
    startTime = startTime ?? (typeof session.start_time === 'string' ? session.start_time : null);
  }
  const at = rosterValidAt({
    start_time: startTime,
    opened_at: openedAtOf({ opened_at: null }),
  });
  const [teamsRes, membersRes, scenarioRes] = await Promise.all([
    teamsValidAt(scenarioId, at),
    supabaseAdmin
      .from('session_teams')
      .select('team_name')
      .eq('session_id', input.sessionId)
      .limit(TEAM_READ_LIMIT),
    supabaseAdmin
      .from('scenarios')
      .select('duration_minutes')
      .eq('id', scenarioId)
      .maybeSingle(),
  ]);
  const counts = new Map<string, number>();
  for (const row of membersRes.data ?? []) {
    const name = String(row.team_name);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const teams: DirectorTeam[] = (teamsRes.data ?? []).map((row) => {
    const name = String(row.team_name);
    const size = counts.get(name) ?? 0;
    return { name, size, staffed: size > 0, playable: true, active: true };
  });
  const duration = Number(scenarioRes.data?.duration_minutes ?? 0);
  const lastMinute = input.rows.reduce((max, row) => Math.max(max, row.minute), 0);
  const minute = duration > 0 ? duration : lastMinute;
  return { teams, minute, duration: duration > 0 ? duration : minute };
}

function capRows(rows: readonly ProposalRecord[]) {
  return rows.map((row) => ({
    status: row.status,
    minute: row.minute,
    proposal: capProposal(row.proposal),
  }));
}

function capProposal(value: unknown): {
  kind: string | null;
  severity: string | null;
  target_teams: string[];
} | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as { kind?: unknown; severity?: unknown; target_teams?: unknown };
  return {
    kind: typeof row.kind === 'string' ? row.kind : null,
    severity: typeof row.severity === 'string' ? row.severity : null,
    target_teams: stringList(row.target_teams),
  };
}

function approverName(row: ProposalRecord, names: ReadonlyMap<string, string>): string {
  if (row.status === 'auto_published') return 'auto';
  if (row.decided_by) return names.get(row.decided_by) ?? 'trainer';
  return 'trainer';
}

function recordOf(row: Record<string, unknown>): ProposalRecord {
  const reason = textOf(row.reason) ?? textOf(row.model_reason) ?? null;
  return {
    seq: Number(row.seq),
    minute: Number(row.minute),
    status: String(row.status),
    proposal: row.proposal,
    signals: row.signals,
    guardrails: row.guardrails,
    fairness: row.fairness,
    decided_by: typeof row.decided_by === 'string' ? row.decided_by : null,
    decided_at: textOf(row.decided_at) ?? null,
    edit_before: row.edit_before,
    edit_after: row.edit_after,
    veto_reason: typeof row.veto_reason === 'string' ? row.veto_reason : null,
    inject_id: typeof row.inject_id === 'string' ? row.inject_id : null,
    reason,
  };
}

function toInput(row: ProposalRecord, names: ReadonlyMap<string, string>): UnscriptedProposalInput {
  const proposal = objectOf(row.proposal);
  return {
    seq: row.seq,
    minute: row.minute,
    status: row.status,
    reason: row.reason,
    proposal: proposal
      ? {
          title: textOf(proposal.title),
          content: textOf(proposal.content),
          target_teams: stringList(proposal.target_teams),
          cause: causeOf(proposal.cause),
        }
      : null,
    signals: signalsOf(row.signals),
    guardrails: guardrailsOf(row.guardrails),
    fairness: parseStoredFairness(row.fairness),
    approverName: row.decided_by ? names.get(row.decided_by) ?? null : null,
    editBefore: editOf(row.edit_before),
    editAfter: editOf(row.edit_after),
    vetoReason: row.veto_reason,
    injectId: row.inject_id,
  };
}

function objectOf(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function textOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

function causeOf(value: unknown): { signal_ids: string[]; source_teams: string[] } | undefined {
  const row = objectOf(value);
  if (!row) return undefined;
  return { signal_ids: stringList(row.signal_ids), source_teams: stringList(row.source_teams) };
}

function signalsOf(value: unknown): Array<{ id: string; detail?: string; keys: string[] }> {
  if (!Array.isArray(value)) return [];
  const signals: Array<{ id: string; detail?: string; keys: string[] }> = [];
  for (const item of value) {
    const row = objectOf(item);
    if (!row || typeof row.id !== 'string') continue;
    signals.push({
      id: row.id,
      ...(typeof row.detail === 'string' ? { detail: row.detail } : {}),
      keys: stringList(row.keys),
    });
  }
  return signals;
}

function guardrailsOf(value: unknown): Array<{ id: string; ok: boolean; detail?: string }> {
  if (!Array.isArray(value)) return [];
  const rows: Array<{ id: string; ok: boolean; detail?: string }> = [];
  for (const item of value) {
    const row = objectOf(item);
    if (!row || typeof row.id !== 'string') continue;
    rows.push({
      id: row.id,
      ok: row.ok === true,
      ...(typeof row.detail === 'string' ? { detail: row.detail } : {}),
    });
  }
  return rows;
}

function editOf(value: unknown): { title?: string; content?: string } | null {
  const row = objectOf(value);
  if (!row) return null;
  const title = textOf(row.title);
  const content = textOf(row.content);
  if (title == null && content == null) return null;
  return { ...(title != null ? { title } : {}), ...(content != null ? { content } : {}) };
}

let missingWarned = false;

function warnMissing(err: unknown): void {
  if (missingWarned) return;
  missingWarned = true;
  logger.warn({ err, event: 'director_aar_unapplied' }, 'Director proposals are not available');
}
