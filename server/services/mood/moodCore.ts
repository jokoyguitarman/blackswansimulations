/**
 * Wait profile and mood consequences.
 * Ladder selection, wording and validation live in shared/moodLadder.ts.
 * No database and no network. Persistence lives in moodService.
 */

import { slugifyTeamName } from '../../../shared/conditionKeyGrammar.js';
import { moodScope, waitMinutesExcludingHeld } from '../roles/roleCore.js';
import type { MoodConsequence, MoodRung, WaitProfile } from '../../../shared/moodLadder.js';

export {
  MOOD_RECOVERIES,
  RUNG_ID_RE,
  MAX_RUNGS,
  MAX_SCRIPT_LINES,
  MAX_SCRIPT_CHARS,
  DEFAULT_MOOD_LADDER,
  defaultLadderFor,
  resolveGaveUpAfter,
  activeRungs,
  whenHolds,
  selectRung,
  holdSnapshot,
  waitingWorsened,
  renderMoodPlaceholders,
  buildMoodBlock,
  isBaseRung,
  mergeLadders,
  validateMoodLadder,
  ladderFromUnknown,
  moodLineFor,
  moodPreviewLine,
} from '../../../shared/moodLadder.js';

export type {
  MoodRecovery,
  WaitProfile,
  MoodCond,
  MoodWhen,
  MoodConsequence,
  MoodRung,
  MoodLadder,
  HoldSnapshot,
  CurrentMood,
  MoodSelection,
  MoodIssue,
} from '../../../shared/moodLadder.js';

export interface MoodDeliveryFact {
  delivery_id: string;
  stakeholder_id: string | null;
  /** Set when a chain step was sent by someone other than the delivery's stakeholder. */
  step_stakeholder_id?: string | null;
  channel: string;
  delivered_minute: number;
  call_state?: string | null;
  chain_step?: number | null;
  target_role_id?: string | null;
  line_team?: string | null;
  recipient_teams?: string[];
  missed_reason?: string | null;
  fallback_reason?: string | null;
  responses?: readonly MoodResponseFact[];
}

export interface MoodResponseFact {
  minute: number;
  team: string | null;
  user_id: string | null;
  judgement_status?: string | null;
  judgement?: { tone?: string; passed?: boolean } | null;
  id?: string;
}

export interface HeldInterval {
  start: number;
  end: number;
}

export interface MoodLockState {
  verdict?: 'keep';
  verdict_rung?: string;
  persuadability?: string;
  grievance_append?: string[];
  stop_chains?: boolean;
  pending_recovery_steps?: number;
}

export interface ClaimState {
  fired: string[];
  locks: MoodLockState;
}

const MISSED_CALL_STATES = new Set(['missed', 'declined']);

export function moodScopeForDelivery(delivery: MoodDeliveryFact): string {
  const teams = delivery.recipient_teams ?? [];
  return moodScope({
    roleId: delivery.target_role_id,
    team: delivery.line_team || (teams.length === 1 ? teams[0] : null),
  });
}

function scopesEqual(left: string, right: string): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  if (left.startsWith('role:') || right.startsWith('role:')) return false;
  const a = slugifyTeamName(left);
  const b = slugifyTeamName(right);
  return Boolean(a) && a === b;
}

function fromStakeholder(delivery: MoodDeliveryFact, stakeholderId: string): boolean {
  return delivery.stakeholder_id === stakeholderId || delivery.step_stakeholder_id === stakeholderId;
}

function isMissedAttempt(delivery: MoodDeliveryFact): boolean {
  if (delivery.channel !== 'call') return false;
  const state = delivery.call_state ?? null;
  if (state === 'cancelled' || state === 'scheduled') return false;
  if (state && MISSED_CALL_STATES.has(state)) return true;
  return false;
}

function responseCloses(
  response: MoodResponseFact,
  delivery: MoodDeliveryFact,
  scope: string,
  rolePlayerIds: readonly string[],
): boolean {
  if (scope.startsWith('role:')) {
    const rolePlayer = response.user_id != null && rolePlayerIds.includes(response.user_id);
    const team = delivery.line_team || delivery.recipient_teams?.[0] || '';
    const fallback = Boolean(delivery.fallback_reason) && Boolean(response.team) && scopesEqual(response.team ?? '', team);
    return rolePlayer || fallback;
  }
  if (!scope) return true;
  return Boolean(response.team) && scopesEqual(response.team ?? '', scope);
}

function inEpisode(delivery: MoodDeliveryFact): boolean {
  if (delivery.channel !== 'call') return true;
  return delivery.call_state !== 'cancelled' && delivery.call_state !== 'scheduled';
}

function judgedResponses(
  deliveries: readonly MoodDeliveryFact[],
  stakeholderId: string,
  scope: string,
  rolePlayerIds: readonly string[],
  atMinute: number,
): MoodResponseFact[] {
  const rows: MoodResponseFact[] = [];
  for (const delivery of deliveries) {
    if (delivery.delivered_minute > atMinute) continue;
    if (!fromStakeholder(delivery, stakeholderId) || !scopesEqual(moodScopeForDelivery(delivery), scope)) continue;
    for (const response of delivery.responses ?? []) {
      if (response.minute > atMinute) continue;
      if (!responseCloses(response, delivery, scope, rolePlayerIds)) continue;
      if (response.judgement_status !== 'done' || !response.judgement) continue;
      rows.push(response);
    }
  }
  return rows.sort((a, b) => b.minute - a.minute || (b.id ?? '').localeCompare(a.id ?? ''));
}

export function computeWaitProfile(input: {
  stakeholderId: string;
  scope: string;
  atMinute: number;
  deliveries: readonly MoodDeliveryFact[];
  gaveUpAfter: number;
  rolePlayerIds?: readonly string[];
  heldIntervals?: readonly HeldInterval[];
}): WaitProfile {
  const rolePlayerIds = input.rolePlayerIds ?? [];
  const scoped = input.deliveries
    .filter((delivery) => inEpisode(delivery))
    .filter((delivery) => fromStakeholder(delivery, input.stakeholderId) && scopesEqual(moodScopeForDelivery(delivery), input.scope))
    .filter((delivery) => delivery.delivered_minute <= input.atMinute)
    .sort((a, b) => a.delivered_minute - b.delivered_minute || a.delivery_id.localeCompare(b.delivery_id));

  let open: MoodDeliveryFact[] = [];
  for (const delivery of scoped) {
    const closed = (delivery.responses ?? []).some(
      (response) => response.minute <= input.atMinute && responseCloses(response, delivery, input.scope, rolePlayerIds),
    );
    if (closed) {
      open = [];
      continue;
    }
    open.push(delivery);
  }

  const anchor = open[0]?.delivered_minute ?? null;
  const roleScope = input.scope.startsWith('role:');
  const wait =
    anchor == null
      ? 0
      : roleScope
        ? waitMinutesExcludingHeld({
            elapsedMinutes: input.atMinute,
            firstContactMinute: anchor,
            heldIntervals: input.heldIntervals ?? [],
          })
        : Math.max(0, input.atMinute - anchor);

  const recent = judgedResponses(input.deliveries, input.stakeholderId, input.scope, rolePlayerIds, input.atMinute).slice(0, 3);
  const tones = recent.map((response) => response.judgement?.tone).filter((tone): tone is string => Boolean(tone));
  return {
    at_minute: input.atMinute,
    episode_anchor_minute: anchor,
    wait_minutes: wait,
    missed_calls: open.filter(isMissedAttempt).length,
    unanswered_messages: open.filter((delivery) => delivery.channel !== 'call').length,
    followups_sent: open.filter((delivery) => delivery.chain_step != null).length,
    prior_tones: tones,
    prior_failed: recent.filter((response) => response.judgement?.passed === false).length,
    prior_passed: recent.filter((response) => response.judgement?.passed === true).length,
    gave_up_after: input.gaveUpAfter,
  };
}

/** Append a consequence id only when it is absent, and merge locks instead of replacing them. */
export function commitClaim(state: ClaimState, id: string, patch: MoodLockState): { won: boolean; state: ClaimState } {
  if (state.fired.includes(id)) return { won: false, state };
  return {
    won: true,
    state: {
      fired: [...state.fired, id],
      locks: mergeLocks(state.locks, patch),
    },
  };
}

export function mergeLocks(current: MoodLockState, patch: MoodLockState): MoodLockState {
  const grievance = [...(current.grievance_append ?? [])];
  for (const line of patch.grievance_append ?? []) {
    if (!grievance.includes(line)) grievance.push(line);
  }
  return {
    ...current,
    ...patch,
    grievance_append: grievance.length > 0 ? grievance : current.grievance_append,
    pending_recovery_steps:
      patch.pending_recovery_steps !== undefined ? patch.pending_recovery_steps : current.pending_recovery_steps,
  };
}

/**
 * Claim, then publish. A failed publish releases the claim so the next tick retries.
 * A claim that is already held does not publish again; `inject_publications` is the
 * second guard if a released claim is published twice.
 */
export function applyPublishInject(input: {
  fired: readonly string[];
  id: string;
  publish: () => boolean;
}): { fired: string[]; published: boolean; released: boolean } {
  if (input.fired.includes(input.id)) {
    return { fired: [...input.fired], published: false, released: false };
  }
  let ok = false;
  try {
    ok = input.publish();
  } catch {
    ok = false;
  }
  if (!ok) {
    return {
      fired: input.fired.filter((item) => item !== input.id),
      published: false,
      released: true,
    };
  }
  return { fired: [...input.fired, input.id], published: true, released: false };
}

/** A good reply adds a recovery step and leaves every other lock in place. */
export function addPendingRecovery(locks: MoodLockState, steps = 1): MoodLockState {
  return {
    ...locks,
    pending_recovery_steps: (locks.pending_recovery_steps ?? 0) + steps,
  };
}

export function consequenceId(rungId: string, index: number): string {
  return `${rungId}:${index}`;
}

export function consequencesToFire(
  rung: MoodRung,
  alreadyFired: readonly string[],
): Array<{ id: string; consequence: MoodConsequence }> {
  const fired = new Set(alreadyFired);
  const due: Array<{ id: string; consequence: MoodConsequence }> = [];
  rung.consequences.forEach((consequence, index) => {
    const id = consequenceId(rung.id, index);
    if (!fired.has(id)) due.push({ id, consequence });
  });
  return due;
}

/** Two callers sharing `fired` each take a consequence at most once. */
export function claimConsequences(
  rung: MoodRung,
  fired: readonly string[],
): { ids: string[]; next: string[] } {
  const due = consequencesToFire(rung, fired);
  const ids = due.map((item) => item.id);
  return { ids, next: [...fired, ...ids] };
}

/** While the role is held, the open interval's end is the next minute (the helper treats end as exclusive). */
export function extendHeldIntervals(
  intervals: readonly HeldInterval[],
  heldNow: boolean,
  minute: number,
): HeldInterval[] {
  const next = intervals.map((interval) => ({ ...interval }));
  if (!heldNow) return next;
  const end = minute + 1;
  const last = next[next.length - 1];
  if (last && last.end >= minute) {
    last.end = Math.max(last.end, end);
    return next;
  }
  next.push({ start: minute, end });
  return next;
}

export function moodStopKey(stakeholderId: string, scope: string): string {
  return `${stakeholderId}|${scope}`;
}
