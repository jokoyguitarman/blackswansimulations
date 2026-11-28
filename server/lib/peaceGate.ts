import { env } from '../env.js';
import { sessionMinuteAt } from '../services/ledger/injectLedgerCore.js';
import {
  isCrisisPhase,
  isOnOrAfterCrisis,
  sessionValidAt,
  silenceActivityMinute,
} from './sessionPhase.js';

/**
 * Flag-aware peace checks. Each one returns today's result when
 * ENABLE_PEACE_PERIOD is off, before it looks at the clock.
 */

export function skipForPeace(session: object, now = Date.now()): boolean {
  if (!env.enablePeacePeriod) return false;
  const start = (session as { start_time?: string | null }).start_time ?? null;
  return !isCrisisPhase({ start_time: start }, now);
}

/** True when the row still counts. Every row counts while peace is off. */
export function countsOnCrisisClock(
  createdAt: string | null | undefined,
  startTime: string | null | undefined,
): boolean {
  if (!env.enablePeacePeriod) return true;
  return isOnOrAfterCrisis(createdAt, startTime);
}

/**
 * Roster "valid at" instant. With the flag off this is `start_time ?? new Date()`,
 * the value the valid-at callers passed before a peace clock existed.
 */
export function rosterValidAt(session: {
  start_time?: string | null;
  opened_at?: string | null;
}): string | Date {
  if (!env.enablePeacePeriod) return session.start_time ?? new Date();
  return sessionValidAt({
    start_time: session.start_time ?? null,
    opened_at: session.opened_at ?? null,
  });
}

/**
 * Minute of a team action for silence. With the flag off this is sessionMinuteAt,
 * which is never null. During peace, activity before crisis start is dropped.
 */
export function activityMinute(startTime: string | null, atIso: string): number | null {
  if (!env.enablePeacePeriod) return sessionMinuteAt(startTime, atIso);
  return silenceActivityMinute(startTime, atIso);
}
