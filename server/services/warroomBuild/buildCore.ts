import { createHash } from 'node:crypto';
import { canonicalJson } from '../../../shared/canonicalJson.js';
import {
  STAGES,
  STAGE_LABEL,
  type BuildErrorCode,
  type BuildRow,
  type BuildStage,
  type BuildView,
  type StageState,
  type StageStates,
} from './buildTypes.js';

const RESUMABLE_STATUSES = new Set<BuildRow['status']>(['paused', 'failed', 'cancelled']);

/** SHA-256 hex of `canonicalJson(value)`. The client hashes the same way. */
export function canonicalHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

/** The `stage_states` object inserted by `start_warroom_build`. */
export function initialStageStates(): StageStates {
  return {
    characters: { status: 'pending', attempts: 0 },
    storyline: { status: 'pending', attempts: 0 },
    convergence: { status: 'pending', attempts: 0 },
    pages: { status: 'pending', attempts: 0 },
  };
}

/** First stage that is not `done` or `skipped`, in stage order. */
export function nextStage(states: StageStates): BuildStage | null {
  for (const stage of STAGES) {
    const status = states[stage]?.status;
    if (status !== 'done' && status !== 'skipped') return stage;
  }
  return null;
}

function copyStates(states: StageStates): StageStates {
  const out = {} as StageStates;
  for (const stage of STAGES) {
    const current = states[stage];
    out[stage] = current ? { ...current } : { status: 'pending', attempts: 0 };
  }
  return out;
}

function elapsedMs(startedAt: string | undefined, finishedAt: string): number | undefined {
  if (!startedAt) return undefined;
  const started = Date.parse(startedAt);
  const finished = Date.parse(finishedAt);
  if (!Number.isFinite(started) || !Number.isFinite(finished)) return undefined;
  return Math.max(0, finished - started);
}

/** Attempts + 1, status running, `started_at` set. Does not mutate `states`. */
export function markRunning(states: StageStates, stage: BuildStage, now: string): StageStates {
  const prev = copyStates(states);
  prev[stage] = {
    status: 'running',
    attempts: (states[stage]?.attempts ?? 0) + 1,
    started_at: now,
  };
  return prev;
}

export function markDone(states: StageStates, stage: BuildStage, now: string): StageStates {
  const prev = copyStates(states);
  const current = states[stage];
  const ms = elapsedMs(current?.started_at, now);
  const next: StageState = {
    status: 'done',
    attempts: current?.attempts ?? 0,
    ...(current?.started_at ? { started_at: current.started_at } : {}),
    finished_at: now,
    ...(ms !== undefined ? { ms } : {}),
  };
  prev[stage] = next;
  return prev;
}

export function markFailed(
  states: StageStates,
  stage: BuildStage,
  error: string,
  now: string,
): StageStates {
  const prev = copyStates(states);
  const current = states[stage];
  const ms = elapsedMs(current?.started_at, now);
  prev[stage] = {
    status: 'failed',
    attempts: current?.attempts ?? 0,
    ...(current?.started_at ? { started_at: current.started_at } : {}),
    finished_at: now,
    ...(ms !== undefined ? { ms } : {}),
    error,
  };
  return prev;
}

export function markInterrupted(states: StageStates, stage: BuildStage, now: string): StageStates {
  const prev = copyStates(states);
  const current = states[stage];
  const ms = elapsedMs(current?.started_at, now);
  prev[stage] = {
    status: 'interrupted',
    attempts: current?.attempts ?? 0,
    ...(current?.started_at ? { started_at: current.started_at } : {}),
    finished_at: now,
    ...(ms !== undefined ? { ms } : {}),
  };
  return prev;
}

/** Pages failure: the build continues, and the stage keeps the trainer-facing reason. */
export function markSkipped(
  states: StageStates,
  stage: BuildStage,
  error: string,
  now: string,
): StageStates {
  const prev = copyStates(states);
  const current = states[stage];
  const ms = elapsedMs(current?.started_at, now);
  prev[stage] = {
    status: 'skipped',
    attempts: current?.attempts ?? 0,
    ...(current?.started_at ? { started_at: current.started_at } : {}),
    finished_at: now,
    ...(ms !== undefined ? { ms } : {}),
    error,
  };
  return prev;
}

/** Failed and interrupted stages become pending. Done and skipped stay. Attempts stay. */
export function resetForResume(states: StageStates): StageStates {
  const prev = copyStates(states);
  for (const stage of STAGES) {
    const current = states[stage];
    if (!current) continue;
    if (current.status === 'failed' || current.status === 'interrupted') {
      prev[stage] = { status: 'pending', attempts: current.attempts };
    }
  }
  return prev;
}

function viewStage(state: StageState | undefined): BuildView['stages'][BuildStage] {
  const status = state?.status ?? 'pending';
  const attempts = state?.attempts ?? 0;
  const out: BuildView['stages'][BuildStage] = { status, attempts };
  if (state?.ms !== undefined) out.ms = state.ms;
  if (state?.error !== undefined) out.error = state.error;
  return out;
}

export function toView(row: BuildRow): BuildView {
  const resumable = RESUMABLE_STATUSES.has(row.status) && row.cancel_reason !== 'replaced';
  return {
    id: row.id,
    draft_id: row.draft_id,
    status: row.status,
    current_stage: row.current_stage,
    stages: {
      characters: viewStage(row.stage_states.characters),
      storyline: viewStage(row.stage_states.storyline),
      convergence: viewStage(row.stage_states.convergence),
      pages: viewStage(row.stage_states.pages),
    },
    error: row.error,
    error_code: row.error_code,
    cancel_reason: row.cancel_reason,
    interruptions: row.interruptions,
    request_hash: row.request_hash,
    resumable,
    resume_from: resumable ? nextStage(row.stage_states) : null,
    compile: { status: row.compile_status, scenario_id: row.scenario_id },
    created_at: row.created_at,
    updated_at: row.updated_at,
    finished_at: row.finished_at,
  };
}

/**
 * NDJSON progress → one log line (§5.4). Heartbeats and unknown messages are dropped.
 * Returns null when the line should not be stored.
 */
export function formatProgress(msg: Record<string, unknown>): string | null {
  if (msg.type === 'heartbeat') return null;
  if (msg.type === 'progress') return String(msg.message ?? '');
  if (msg.type === 'org_progress') {
    const detail = msg.detail ? ` — ${String(msg.detail)}` : '';
    return `[${String(msg.org_key)}] ${String(msg.stage)} ready${detail}`;
  }
  if (msg.type === 'team_complete') {
    return `${String(msg.team)} storyline ready (${Number(msg.inject_count)} injects)`;
  }
  return null;
}

export function charactersReadyLine(personaCount: number): string {
  return `${personaCount} characters and a fact sheet ready`;
}

export function stakeholdersReadyLine(contactCount: number, withConcern: number): string {
  return `${contactCount} stakeholder contacts created (${withConcern} with a live concern)`;
}

/** "Characters started" / "Storyline started (attempt 2)". */
export function stageStartedLine(stage: BuildStage, attempts: number): string {
  const label = STAGE_LABEL[stage];
  return attempts > 1 ? `${label} started (attempt ${attempts})` : `${label} started`;
}

export const PAGES_SKIP_WARNING =
  'Organisation pages could not be generated — the scenario compiles without them.';

export function restartLine(stage: BuildStage): string {
  return `The server is restarting — the build will continue from the ${STAGE_LABEL[stage]} stage.`;
}

/**
 * Turn a generation error into something the trainer can act on. Generation shares the AI
 * quota and the server with live sessions, so the two common causes are rate limits and
 * timeouts — both are transient and worth naming.
 *
 * The legacy routes call this with their own stage phrases. Durable builds pass `STAGE_LABEL`.
 */
export function describeGenerationFailure(err: unknown, stage: string): string {
  const e = err as { status?: number; message?: string; name?: string } | null;
  const msg = e?.message ?? '';
  if (e?.status === 429 || /rate limit|429/i.test(msg)) {
    return `The AI provider rate-limited the ${stage} stage — the server is busy (a live session shares the same quota). Wait a minute and retry.`;
  }
  if (e?.name === 'TimeoutError' || /timed out|timeout/i.test(msg)) {
    return `The AI took too long answering the ${stage} stage and the call timed out. Retry — it usually completes the second time.`;
  }
  if (/budget exhausted/i.test(msg)) {
    return `The hourly AI budget is exhausted. Retry after the top of the hour.`;
  }
  return `Failed to generate ${stage}${msg ? ` — ${msg.slice(0, 160)}` : ''}. Retry to rebuild this stage.`;
}

export function classifyStageError(
  err: unknown,
  stage: BuildStage,
): { error_code: Extract<BuildErrorCode, 'stage_failed'>; error: string } {
  return {
    error_code: 'stage_failed',
    error: describeGenerationFailure(err, STAGE_LABEL[stage]),
  };
}
