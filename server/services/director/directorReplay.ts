/**
 * Replays stored director wakes through the pure decision path.
 * The model's text is taken from the log; everything else is recomputed.
 */

import type {
  ConsistencyRecord,
  DirectorDraft,
  DirectorTurnInput,
  ModelOutcome,
} from './directorCore.js';
import {
  consistencyRequired,
  finalizeDirectorWake,
  prepareDirectorWake,
  type GuardrailResult,
} from './directorCore.js';
import type { FairnessState } from './directorCore.js';
import type { Signal } from './directorSignals.js';
import type { DirectorObservation } from './directorCore.js';

export interface ReplayRow {
  seq: number;
  minute: number;
  wake_reason: 'signals' | 'periodic' | 'trainer_request' | null;
  status: string | null;
  reason: string | null;
  signals: Signal[];
  observation: DirectorObservation | null;
  focus_id: string | null;
  guardrails: GuardrailResult[];
  fairness: FairnessState | null;
  raw_output: unknown;
  consistency: ConsistencyRecord | null;
}

export interface ReplayFacts {
  wakes: Record<number, DirectorTurnInput>;
}

export interface ReplayMismatch {
  seq: number;
  field: string;
  stored: unknown;
  recomputed: unknown;
}

export function replayDirectorSession(
  rows: readonly ReplayRow[],
  facts: ReplayFacts,
): { ok: boolean; mismatches: ReplayMismatch[] } {
  const mismatches: ReplayMismatch[] = [];
  const ordered = [...rows].sort((a, b) => a.seq - b.seq);
  for (const row of ordered) {
    const input = facts.wakes[row.seq];
    if (!input) {
      mismatches.push({ seq: row.seq, field: 'facts', stored: row.seq, recomputed: null });
      continue;
    }
    const recomputed = recompute(input, row);
    diffValue(row.seq, '', viewOf(row), viewOfDraft(recomputed), mismatches);
  }
  return { ok: mismatches.length === 0, mismatches };
}

function recompute(input: DirectorTurnInput, row: ReplayRow): DirectorDraft {
  const prepared = prepareDirectorWake(input);
  if (!prepared.call || !prepared.guard) return prepared.draft;
  const model = modelOf(row);
  const proposal =
    row.raw_output && typeof row.raw_output === 'object'
      ? (row.raw_output as { proposal?: unknown }).proposal
      : null;
  const required = proposal != null && consistencyRequired(prepared.guard, proposal);
  const consistency = required
    ? (row.consistency ?? { status: 'unverified' as const, reason: 'missing' })
    : null;
  return finalizeDirectorWake(prepared, model, consistency);
}

function modelOf(row: ReplayRow): ModelOutcome {
  if (row.status === 'budget_denied') return { kind: 'budget_denied', raw: row.raw_output };
  if (row.status === 'failed') return { kind: 'failed', raw: row.raw_output };
  return { kind: 'output', raw: row.raw_output };
}

function viewOf(row: ReplayRow): unknown {
  return {
    wake_reason: row.wake_reason,
    status: row.status,
    reason: row.reason,
    focus_id: row.focus_id,
    signals: row.signals,
    observation: row.observation,
    fairness: row.fairness,
    guardrails: row.guardrails,
  };
}

function viewOfDraft(draft: DirectorDraft): unknown {
  return {
    wake_reason: draft.wake_reason,
    status: draft.status,
    reason: draft.reason,
    focus_id: draft.focus_id,
    signals: draft.signals,
    observation: draft.observation,
    fairness: draft.fairness,
    guardrails: draft.guardrails,
  };
}

function diffValue(
  seq: number,
  path: string,
  stored: unknown,
  recomputed: unknown,
  out: ReplayMismatch[],
): void {
  const left = normalize(stored);
  const right = normalize(recomputed);
  if (same(left, right)) return;
  if (isRecord(left) && isRecord(right)) {
    const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
    for (const key of keys) {
      diffValue(seq, path ? `${path}.${key}` : key, left[key], right[key], out);
    }
    return;
  }
  if (Array.isArray(left) && Array.isArray(right) && left.length === right.length) {
    left.forEach((item, index) => diffValue(seq, `${path}[${index}]`, item, right[index], out));
    return;
  }
  out.push({ seq, field: path || 'value', stored: left, recomputed: right });
}

function normalize(value: unknown): unknown {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function same(left: unknown, right: unknown): boolean {
  return Object.is(left, right);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}
