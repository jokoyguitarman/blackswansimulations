/**
 * Pure poll and card state for the War Room wizard (durable builds §9.1, §6).
 * A poll error never becomes a failed build.
 */

export const STAGE_LABEL = {
  characters: 'Characters',
  storyline: 'Storyline',
  convergence: 'Convergence',
  pages: 'Organisation pages',
} as const;

export type BuildStageName = keyof typeof STAGE_LABEL;
export type RunStageName = BuildStageName | 'peace';

export type BuildStatusName =
  'queued' | 'running' | 'paused' | 'succeeded' | 'failed' | 'cancelled';

export interface StageView {
  status: string;
  attempts: number;
  ms?: number;
  error?: string;
}

export interface BuildView {
  id: string;
  draft_id: string;
  status: BuildStatusName;
  current_stage: RunStageName | null;
  stages: Record<BuildStageName, StageView> & { peace?: StageView };
  error: string | null;
  error_code: string | null;
  cancel_reason: 'user' | 'replaced' | 'unwatched' | null;
  interruptions: number;
  request_hash: string;
  resumable: boolean;
  resume_from: RunStageName | null;
  compile: { status: 'running' | 'succeeded' | 'failed' | null; scenario_id: string | null };
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

export interface BuildLogLine {
  seq: number;
  stage: string | null;
  kind?: string;
  message: string;
  at?: string;
}

export interface PollState {
  log: BuildLogLine[];
  nextAfter: number;
  consecutiveErrors: number;
  reconnecting: boolean;
}

export type PollEvent =
  | { type: 'started' }
  | { type: 'reset' }
  | { type: 'poll_error'; transient?: boolean }
  | { type: 'poll_ok'; log: BuildLogLine[]; nextAfter: number };

export const emptyPollState = (): PollState => ({
  log: [],
  nextAfter: 0,
  consecutiveErrors: 0,
  reconnecting: false,
});

/** Log lines accumulate by `seq`. `poll_error` never records a failure. */
export function reducePoll(state: PollState, event: PollEvent): PollState {
  if (event.type === 'started' || event.type === 'reset') return emptyPollState();
  if (event.type === 'poll_error') {
    const consecutiveErrors = state.consecutiveErrors + 1;
    // A deploy blip (502/503, a dropped connection, a timeout) is reconnecting
    // immediately. Any other miss still waits for the second one, and neither
    // path records a failure.
    return {
      ...state,
      consecutiveErrors,
      reconnecting: event.transient === true || consecutiveErrors >= 2,
    };
  }
  const bySeq = new Map(state.log.map((line) => [line.seq, line]));
  for (const line of event.log) bySeq.set(line.seq, line);
  const log = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  const nextAfter = event.nextAfter;
  return { log, nextAfter, consecutiveErrors: 0, reconnecting: false };
}

export type WizardBuildStage = RunStageName | 'done' | null;

/** The stage strip the wizard already renders. */
export function mapToWizardStage(view: BuildView): {
  buildStage: WizardBuildStage;
  buildError: RunStageName | null;
} {
  if (view.status === 'succeeded') return { buildStage: 'done', buildError: null };
  if (view.status === 'failed') {
    const stage = view.current_stage ?? view.resume_from ?? 'characters';
    return { buildStage: stage, buildError: stage };
  }
  if (view.status === 'queued' || view.status === 'running') {
    return { buildStage: view.current_stage, buildError: null };
  }
  return { buildStage: view.resume_from ?? view.current_stage, buildError: null };
}

export type BuildCardAction = 'retry' | 'resume' | 'start_over' | 'build_again' | 'open_review';

export interface BuildCard {
  heading: string;
  body: string;
  /** Primary button, then Start over when the trainer can leave this build. */
  actions: BuildCardAction[];
  primaryLabel: string;
}

const STAGE_ORDER: BuildStageName[] = ['characters', 'storyline', 'convergence', 'pages'];

function stageOf(view: BuildView): RunStageName {
  return view.resume_from ?? view.current_stage ?? 'characters';
}

export function stageLabel(stage: RunStageName): string {
  if (stage === 'peace') return 'Peace feed';
  return STAGE_LABEL[stage];
}

/**
 * The §6 card, or null when the build should not show one (running, succeeded,
 * or replaced). `prevStage` is the last stage that finished, for the unwatched line.
 * `unwatchedMinutes` is the server default of 45 when the view does not carry it.
 */
export function buildCardFor(
  view: BuildView,
  prevStage: RunStageName | null,
  options?: { setupChanged?: boolean; unwatchedMinutes?: number },
): BuildCard | null {
  if (view.cancel_reason === 'replaced') return null;
  if (view.status === 'queued' || view.status === 'running' || view.status === 'succeeded') {
    return null;
  }
  const stage = stageOf(view);
  const label = stageLabel(stage);
  const minutes = options?.unwatchedMinutes ?? 45;

  let card: BuildCard | null = null;
  if (view.status === 'failed' && view.error_code === 'interrupted_too_often') {
    card = {
      heading: `The ${label} stage was interrupted repeatedly`,
      body: `The server restarted ${view.interruptions} times while building. Retry continues from the ${label} stage.`,
      actions: ['retry', 'start_over'],
      primaryLabel: `Retry from ${label}`,
    };
  } else if (view.status === 'failed') {
    const detail = view.stages[stage]?.error || view.error || `The ${label} stage failed.`;
    const detailText = detail.endsWith('.') ? detail : `${detail}.`;
    card = {
      heading: `The ${label} stage failed`,
      body: `${detailText} Retry continues from the ${label} stage; the stages before it are kept.`,
      actions: ['retry', 'start_over'],
      primaryLabel: `Retry from ${label}`,
    };
  } else if (view.status === 'paused' && view.cancel_reason === 'unwatched') {
    const after = prevStage ? `after the ${stageLabel(prevStage)} stage ` : '';
    card = {
      heading: 'Build paused',
      body: `Paused ${after}because this build wasn't open for ${minutes} minutes, to save AI usage. Resume continues from the ${label} stage.`,
      actions: ['resume', 'start_over'],
      primaryLabel: 'Resume',
    };
  } else if (view.status === 'paused') {
    card = {
      heading: 'Build paused',
      body: `Resume continues from the ${label} stage.`,
      actions: ['resume', 'start_over'],
      primaryLabel: 'Resume',
    };
  } else if (view.status === 'cancelled') {
    card = {
      heading: 'Build cancelled',
      body: `Resume continues from the ${label} stage, or start over.`,
      actions: ['resume', 'start_over'],
      primaryLabel: 'Resume',
    };
  }

  if (!card || !options?.setupChanged) return card;
  return {
    ...card,
    body: `${card.body} Setup changed since this build — build again to use the new settings.`,
    actions: ['build_again', 'start_over'],
    primaryLabel: 'Build again',
  };
}

const HEALTHY_VISIBLE_MS = 2000;
const HIDDEN_MS = 15000;
const BACKOFF_CAP_MS = 15000;

/**
 * Healthy polls are 2s while the tab is visible and 15s while it is hidden.
 * After a transient miss the wait doubles (2s, 4s, 8s) and caps at 15s, so a
 * redeploy is not hammered and is not shown as a failed build.
 */
export function nextPollDelayMs(consecutiveErrors: number, hidden: boolean): number {
  if (consecutiveErrors <= 0) return hidden ? HIDDEN_MS : HEALTHY_VISIBLE_MS;
  const backoff = Math.min(BACKOFF_CAP_MS, HEALTHY_VISIBLE_MS * 2 ** (consecutiveErrors - 1));
  return hidden ? Math.max(HIDDEN_MS, backoff) : backoff;
}

/**
 * A Render deploy answers with these while the new process is down or booting.
 * Status 0 is a network error or the client's own timeout. 501 and 403 are not
 * in this set: those are answers, and polling stops on them.
 */
export function isDeployGap(status: number): boolean {
  return status === 0 || status === 408 || status === 502 || status === 503 || status === 504;
}

/** Drop the idempotency key only after the server actually answered. */
export function shouldClearIdempotencyKey(status: number): boolean {
  return status > 0 && !isDeployGap(status);
}

/** Polling stops on these. A deploy gap does not. */
export function classifyPollStop(status: number): 'lost' | 'denied' | 'unavailable' | null {
  if (status === 404) return 'lost';
  if (status === 403) return 'denied';
  if (status === 501) return 'unavailable';
  return null;
}

/**
 * What a reload does with `getLatestBuild` during a gap. `retry` keeps the
 * sessionStorage build id and does not show "the build has not started".
 */
export function classifyLatestFetch(
  status: number,
  hasBuild: boolean,
): 'retry' | 'unavailable' | 'denied' | 'ready' | 'missing' {
  if (isDeployGap(status)) return 'retry';
  if (status === 501) return 'unavailable';
  if (status === 403) return 'denied';
  if (hasBuild && status >= 200 && status < 300) return 'ready';
  return 'missing';
}

/** `startBuild` and `resumeBuild` during a gap retry. Anything else is settled. */
export function classifyMutation(status: number): 'retry' | 'settled' {
  return isDeployGap(status) ? 'retry' : 'settled';
}

/** A failed review fetch retries only for a deploy gap. */
export function classifyReview(status: number, ok: boolean): 'retry' | 'apply' | 'failed' {
  if (ok) return 'apply';
  if (isDeployGap(status)) return 'retry';
  return 'failed';
}

/** A visibility or online event must not start a second poll while one is in flight. */
export function claimPollTick(inFlight: boolean): 'run' | 'queue' {
  return inFlight ? 'queue' : 'run';
}

export type StripMark = 'done' | 'running' | 'continuing' | 'failed' | 'queued';

/**
 * How one stage looks after a restart. Finished stages stay done. The
 * interrupted stage is "continuing" while the build is queued again, then
 * "running" once a worker claims it. It is not shown as a failure.
 */
export function stageMark(view: BuildView, stage: RunStageName): StripMark {
  const status = view.stages[stage]?.status;
  if (status === 'done' || status === 'skipped') return 'done';
  if (status === 'failed') return 'failed';
  const active = view.resume_from ?? view.current_stage;
  const live = view.status === 'queued' || view.status === 'running';
  if (live && active === stage) {
    if (view.status === 'queued' || status === 'interrupted') return 'continuing';
    return 'running';
  }
  if (status === 'running' && live) return 'running';
  return 'queued';
}

/** Last finished stage before `resume_from`, for the unwatched card. */
export function previousFinishedStage(view: BuildView): RunStageName | null {
  const from = view.resume_from;
  if (!from) return null;
  if (from === 'peace') return 'pages';
  const index = STAGE_ORDER.indexOf(from);
  if (index <= 0) return null;
  return STAGE_ORDER[index - 1] ?? null;
}
