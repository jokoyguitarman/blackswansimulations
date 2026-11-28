/**
 * Pure decisions for resuming a setup-edit draft.
 * New-scenario drafts stay on the existing resume path.
 */

import { nextPollDelayMs } from './buildStatus';

/** A setup edit saved on Review reattaches the latest durable build instead of opening an empty review. */
export function resumeAttachesLatestBuild(input: {
  validStep: number;
  isSetupEdit: boolean;
}): boolean {
  return input.isSetupEdit && input.validStep === 7;
}

/** Entering Building with no live build looks the draft's build up. A build that is starting does not. */
export function attachOnBuildingStep(input: {
  isSetupEdit: boolean;
  step: number;
  activeBuildId: string | null;
  starting: boolean;
}): boolean {
  return input.isSetupEdit && input.step === 2 && input.activeBuildId == null && !input.starting;
}

/**
 * A succeeded build opened from Review stays on Building.
 * A resume (and every new-scenario attach) still opens the review.
 */
export function succeededAttachAction(
  requested: 'review' | 'stay' | undefined,
  isSetupEdit: boolean,
): 'review' | 'stay' {
  if (requested === 'stay' && isSetupEdit) return 'stay';
  return 'review';
}

/**
 * Latest-build lookup missed. A setup edit that still remembers a build id
 * opens that review (a swept build comes back as 404). Anything else falls
 * through to the Building card.
 */
export function latestBuildMissAction(input: {
  isSetupEdit: boolean;
  lastBuildId: string | null;
  outcome: 'missing' | 'unavailable';
}): 'open_remembered_review' | 'fallback' {
  if (input.isSetupEdit && input.outcome === 'missing' && input.lastBuildId) {
    return 'open_remembered_review';
  }
  return 'fallback';
}

export type EditBuildLookup = 'idle' | 'checking' | 'missing' | 'unavailable' | 'ready';

export const EDIT_BUILD_NOT_STARTED = {
  heading: 'The build has not started',
  body: 'Start the build. It runs on the server from the setup saved on this draft.',
  button: 'Start the build',
} as const;

/**
 * The idle Building card. Setup edits never use the in-browser copy.
 * The start card is only for a confirmed miss or a 501. A remembered build
 * shows the finished card, including while a lookup is still in flight.
 */
export function buildingFallbackKind(input: {
  isSetupEdit: boolean;
  lookup: EditBuildLookup;
  lastBuildId: string | null;
  starting: boolean;
}): 'browser' | 'start' | 'finished' | 'checking' {
  if (!input.isSetupEdit) return 'browser';
  if (input.lookup === 'missing' || input.lookup === 'unavailable') return 'start';
  if (input.lastBuildId && !input.starting) return 'finished';
  return 'checking';
}

/** Setup edits persist step 2 before every start, so a mid-build resume reattaches. */
export function alwaysSaveBuildingStep(isSetupEdit: boolean): boolean {
  return isSetupEdit;
}

export const PLAN_FETCH_ATTEMPTS = 3;

export const PLAN_SERVER_UNREACHABLE = "Couldn't reach the server.";

export const REVIEW_LOADING = 'Loading the review…';

export const REVIEW_BUILD_FIRST = 'Nothing to review yet. Build the edit first.';

function statusOf(err: unknown): number | null {
  if (typeof err !== 'object' || err === null || !('status' in err)) return null;
  const status = (err as { status: unknown }).status;
  return typeof status === 'number' ? status : null;
}

/** Network drops (TypeError / "Failed to fetch") and 5xx answers are worth another try. */
export function isTransientPlanError(err: unknown): boolean {
  if (err instanceof TypeError) return true;
  const status = statusOf(err);
  if (status === 0 || (status != null && status >= 500 && status <= 599)) return true;
  return err instanceof Error && err.message === 'Failed to fetch';
}

/** Delay before the next plan attempt, or null when the attempts are used up. */
export function planRetryDelayMs(failuresSoFar: number, hidden: boolean): number | null {
  if (!isFiniteFailure(failuresSoFar) || failuresSoFar >= PLAN_FETCH_ATTEMPTS) return null;
  return nextPollDelayMs(failuresSoFar, hidden);
}

function isFiniteFailure(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

export function planFailureText(err: unknown): string {
  if (isTransientPlanError(err)) return PLAN_SERVER_UNREACHABLE;
  if (err instanceof Error && err.message.trim()) return err.message;
  return 'Could not load the plan.';
}

export type ReviewPlaceholder = 'loading' | 'retry' | 'build_first';

/**
 * Empty review copy. A build that exists is loading or retrying, never
 * "Build the edit first".
 */
export function reviewPlaceholder(input: {
  sectionCount: number;
  planning: boolean;
  hasBuild: boolean;
  planLoaded: boolean;
  outputsLoaded: boolean;
  unreachable: boolean;
}): ReviewPlaceholder | null {
  if (input.sectionCount > 0) return null;
  if (input.unreachable) return 'retry';
  if (input.planning || (input.hasBuild && (!input.planLoaded || !input.outputsLoaded))) {
    return 'loading';
  }
  if (input.hasBuild) return null;
  return 'build_first';
}
