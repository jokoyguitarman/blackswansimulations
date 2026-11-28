/**
 * Crisis clock and peace phase. No database access.
 *
 * `crisisElapsedMinutes` is floor, clamped at 0. It matches
 * `Math.floor((now - start) / 60000)` for every non-negative elapsed value,
 * and `Math.max(0, Math.floor(...))` for every finite value.
 * Sites that round or keep a fraction use the sibling helpers so a non-negative
 * elapsed value stays exactly what that site computed before.
 */

export type SessionPhase = 'not_started' | 'peace' | 'crisis';

export interface SessionClockInput {
  start_time: string | null;
  opened_at?: string | null;
}

const MINUTE_MS = 60_000;
/** sessions.peace_seconds CHECK, copied from migration 281. */
const PEACE_SECONDS_COLUMN_MAX = 3600;

function instantMs(value: string | number | null | undefined): number | null {
  if (value == null || value === '') return null;
  const ms = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export function sessionPhase(session: SessionClockInput, now = Date.now()): SessionPhase {
  const start = instantMs(session.start_time);
  if (start == null) return 'not_started';
  if (now < start) return 'peace';
  return 'crisis';
}

export function isCrisisPhase(session: SessionClockInput, now = Date.now()): boolean {
  return sessionPhase(session, now) === 'crisis';
}

/** Whole crisis minutes. Floor, never negative. Missing or unparseable start is 0. */
export function crisisElapsedMinutes(
  startTime: string | number | null | undefined,
  now = Date.now(),
): number {
  const start = instantMs(startTime);
  if (start == null || !Number.isFinite(now)) return 0;
  return Math.max(0, Math.floor((now - start) / MINUTE_MS));
}

/**
 * Fractional crisis minutes, never negative. Missing or unparseable start is null
 * so callers that distinguish "no clock" keep that.
 */
export function crisisElapsedFractionalMinutes(
  startTime: string | number | null | undefined,
  now = Date.now(),
): number | null {
  const start = instantMs(startTime);
  if (start == null || !Number.isFinite(now)) return null;
  return Math.max(0, (now - start) / MINUTE_MS);
}

/** Rounded whole minutes, never negative. Missing or unparseable start is 0. */
export function crisisElapsedRoundedMinutes(
  startTime: string | number | null | undefined,
  now = Date.now(),
): number {
  const start = instantMs(startTime);
  if (start == null || !Number.isFinite(now)) return 0;
  return Math.max(0, Math.round((now - start) / MINUTE_MS));
}

/** When a re-edit counts as valid for the session: the room opened, not crisis start. */
export function sessionValidAt(session: SessionClockInput, now = new Date()): string {
  if (session.opened_at) return session.opened_at;
  if (session.start_time) return session.start_time;
  return now.toISOString();
}

export interface PeaceSecondsInput {
  requested: unknown;
  initialState: unknown;
  /** Social session (`sim_mode`) or social-crisis scenario (`category`). */
  social: boolean;
  enabled: boolean;
  defaultSeconds: number;
  maxSeconds: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * Peace length for a start claim. 0 means `start_time = now` and no new columns.
 * The column CHECK rejects values above 3600, so the cap never exceeds that.
 */
export function resolvePeaceSeconds(input: PeaceSecondsInput): number {
  if (!input.enabled || !input.social) return 0;
  const peace = asRecord(asRecord(input.initialState)?.peace_period);
  const posts = peace?.posts;
  if (!Array.isArray(posts) || posts.length === 0) return 0;
  // The editor's off switch keeps the posts but starts with no peace.
  if (peace?.enabled === false) return 0;
  const raw = input.requested != null && input.requested !== '' ? input.requested : peace?.seconds;
  const parsed = raw == null || raw === '' ? input.defaultSeconds : Number(raw);
  const seconds = Number.isFinite(parsed) ? parsed : input.defaultSeconds;
  const cap = Math.min(PEACE_SECONDS_COLUMN_MAX, Math.max(0, Math.floor(input.maxSeconds)));
  return Math.min(cap, Math.max(0, Math.floor(seconds)));
}

/** Columns for the first start. Peace of 0 writes only `start_time`, as today. */
export function startClaimFields(input: { now: Date; peaceSeconds: number }): {
  start_time: string;
  opened_at?: string;
  peace_seconds?: number;
} {
  const openedAt = input.now.toISOString();
  if (input.peaceSeconds > 0) {
    return {
      opened_at: openedAt,
      peace_seconds: input.peaceSeconds,
      start_time: new Date(input.now.getTime() + input.peaceSeconds * 1000).toISOString(),
    };
  }
  return { start_time: openedAt };
}

/**
 * Minute of a team action for `team_silent`. Activity before crisis start is not
 * activity: it must not move `last_minute` forward. A finite timestamp at or after
 * start matches `crisisElapsedMinutes` (and today's `sessionMinuteAt`).
 */
export function silenceActivityMinute(
  startTime: string | null | undefined,
  atIso: string,
): number | null {
  const at = Date.parse(atIso);
  if (!Number.isFinite(at)) return null;
  const start = instantMs(startTime);
  if (start != null && at < start) return null;
  return crisisElapsedMinutes(startTime, at);
}

/** True when a row counts on the crisis clock. Missing times are kept. */
export function isOnOrAfterCrisis(
  createdAt: string | null | undefined,
  startTime: string | null | undefined,
): boolean {
  const start = instantMs(startTime);
  if (start == null) return true;
  const at = instantMs(createdAt);
  if (at == null) return true;
  return at >= start;
}
