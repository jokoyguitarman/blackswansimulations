/**
 * Process-local director bookkeeping. The wake lock and the pending-proposal
 * flag live here so the scheduler tick never waits on a model call, and the
 * countdown sweep queries only when a session might have something due.
 */

export const SWEEP_FALLBACK_TICKS = 2;

const pendingCount = new Map<string, number>();
const sweepTick = new Map<string, number>();
const wakes = new Set<string>();
const paused = new Set<string>();
const snoozes = new Map<string, Array<{ team: string; untilMs: number }>>();
const publishSlots = new Map<string, number | null>();

export function resetDirectorRuntime(): void {
  pendingCount.clear();
  sweepTick.clear();
  wakes.clear();
  paused.clear();
  snoozes.clear();
  publishSlots.clear();
}

export function noteProposalPending(sessionId: string): void {
  pendingCount.set(sessionId, (pendingCount.get(sessionId) ?? 0) + 1);
}

export function noteProposalSettled(sessionId: string): void {
  const current = pendingCount.get(sessionId);
  if (current == null) return;
  pendingCount.set(sessionId, Math.max(0, current - 1));
}

/**
 * Query due rows every tick while this process knows a proposal is pending.
 * Otherwise at most once every {@link SWEEP_FALLBACK_TICKS} ticks, so a
 * restart still finds rows that were pending before the process started.
 */
export function sweepThisTick(sessionId: string): boolean {
  const n = (sweepTick.get(sessionId) ?? 0) + 1;
  sweepTick.set(sessionId, n);
  const pending = pendingCount.get(sessionId);
  if (pending != null && pending > 0) return true;
  return n % SWEEP_FALLBACK_TICKS === 1;
}

/** False when a wake is already running for the session. */
export function tryBeginWake(sessionId: string): boolean {
  if (wakes.has(sessionId)) return false;
  wakes.add(sessionId);
  return true;
}

export function endWake(sessionId: string): void {
  wakes.delete(sessionId);
}

export function wakeInFlight(sessionId: string): boolean {
  return wakes.has(sessionId);
}

export function setDirectorPaused(sessionId: string, value: boolean): void {
  if (value) paused.add(sessionId);
  else paused.delete(sessionId);
}

export function directorIsPaused(sessionId: string): boolean {
  return paused.has(sessionId);
}

export function addSnooze(sessionId: string, team: string, minutes: number, nowMs: number): void {
  const untilMs = nowMs + Math.max(1, minutes) * 60_000;
  const rows = (snoozes.get(sessionId) ?? []).filter((row) => row.untilMs > nowMs);
  rows.push({ team, untilMs });
  snoozes.set(sessionId, rows);
}

export function snoozedTeams(sessionId: string, nowMs: number): string[] {
  const rows = (snoozes.get(sessionId) ?? []).filter((row) => row.untilMs > nowMs);
  snoozes.set(sessionId, rows);
  return rows.map((row) => row.team);
}

/** Remaining publishes this tick may still make. Null means the tick has not armed a cap. */
export function armPublishSlots(sessionId: string, remaining: number): void {
  publishSlots.set(sessionId, Math.max(0, remaining));
}

export function takePublishSlot(sessionId: string): boolean {
  const left = publishSlots.get(sessionId);
  if (left == null) return true;
  if (left <= 0) return false;
  publishSlots.set(sessionId, left - 1);
  return true;
}
