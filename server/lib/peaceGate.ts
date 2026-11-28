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

/** Scoring and the AAR apply the crisis-activity filter when either feature is on. */
export function crisisFiltersActive(): boolean {
  return env.enablePeacePeriod || env.enableTopicAwareReplies;
}

/**
 * After-action minute from crisis start.
 * Flag off, `round`: master's `tPlus` (including a NaN for an unparseable instant).
 * Flag off, `floor`: master's comms `minuteAt`.
 * Flag on: null before crisis start, otherwise the same clamp.
 */
export function crisisMinute(
  iso: string | null | undefined,
  startMs: number | null,
  round: 'floor' | 'round' = 'floor',
): number | null {
  if (round === 'round') {
    if (!startMs || !iso) return null;
    const deltaMs = new Date(iso).getTime() - startMs;
    if (env.enablePeacePeriod && deltaMs < 0) return null;
    return Math.max(0, Math.round(deltaMs / 60000));
  }
  if (typeof iso !== 'string' || startMs == null) return null;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  if (env.enablePeacePeriod && at < startMs) return null;
  return Math.max(0, Math.floor((at - startMs) / 60000));
}
