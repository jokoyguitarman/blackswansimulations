/**
 * Process-local director bookkeeping. The wake lock and the pending-proposal
 * flag live here so the scheduler tick never waits on a model call, and the
 * countdown sweep queries only when a session might have something due.
 */

/** A hung model call must not hold the per-session lock forever. */
export const DIRECTOR_WAKE_LOCK_MS = 60_000;

/**
 * The scheduler re-reads pending proposals on this interval, outside the
 * per-session tick, so a failed boot discovery or a drifted in-memory count
 * comes back. Five minutes matches the suggestion TTL.
 */
export const DIRECTOR_PENDING_DISCOVERY_INTERVAL_MS = 5 * 60 * 1000;

/** Newest proposals fill the cap so an old backlog cannot crowd out a live session. */
export const DIRECTOR_PENDING_DISCOVERY_LIMIT = 500;

/** True on the first pass and again once the interval has elapsed. */
export function directorDiscoveryDue(lastMs: number, nowMs: number): boolean {
  return lastMs <= 0 || nowMs - lastMs >= DIRECTOR_PENDING_DISCOVERY_INTERVAL_MS;
}

const pendingCount = new Map<string, number>();
const wakes = new Set<string>();
const wakeToken = new Map<string, number>();
const paused = new Set<string>();
const snoozes = new Map<string, Array<{ team: string; untilMs: number }>>();
const publishSlots = new Map<string, number | null>();

export function resetDirectorRuntime(): void {
  pendingCount.clear();
  wakes.clear();
  wakeToken.clear();
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

/** True only when this process has counted a still-pending proposal for the session. */
export function hasPendingProposals(sessionId: string): boolean {
  return (pendingCount.get(sessionId) ?? 0) > 0;
}

/**
 * Fold a discovery read into the in-memory counts.
 * The higher count wins, so a proposal inserted between the read and this
 * merge is not wiped, and a discovery that found more rows raises a low count.
 */
export function replacePendingCounts(counts: ReadonlyMap<string, number>): void {
  const next = new Map<string, number>();
  for (const [sessionId, count] of counts) {
    if (count > 0) next.set(sessionId, count);
  }
  for (const [sessionId, count] of pendingCount) {
    if (count > 0) next.set(sessionId, Math.max(next.get(sessionId) ?? 0, count));
  }
  pendingCount.clear();
  for (const [sessionId, count] of next) pendingCount.set(sessionId, count);
}

export function pendingProposalCount(sessionId: string): number {
  return pendingCount.get(sessionId) ?? 0;
}

/**
 * The sweep queries only while a proposal is known to be pending.
 * Startup discovery, inserts, and approvals maintain that set. A tick with
 * nothing pending does not read the database.
 */
export function sweepThisTick(sessionId: string): boolean {
  return hasPendingProposals(sessionId);
}

/**
 * Start a wake. Returns its token, or null when one is already running.
 * `endWake` retires the token so a late finish does not clear a newer wake.
 */
export function beginWake(sessionId: string): number | null {
  if (wakes.has(sessionId)) return null;
  const token = (wakeToken.get(sessionId) ?? 0) + 1;
  wakeToken.set(sessionId, token);
  wakes.add(sessionId);
  return token;
}

export function endWake(sessionId: string, token?: number): void {
  if (token != null && wakeToken.get(sessionId) !== token) return;
  wakes.delete(sessionId);
  if (token != null) wakeToken.set(sessionId, token + 1);
}

export function wakeOwns(sessionId: string, token: number): boolean {
  return wakes.has(sessionId) && wakeToken.get(sessionId) === token;
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
