/**
 * Player-visible session clock. `crisis_starts_at` is sent only when the peace
 * flag is on; without it the clock is `start_time`, as today.
 * A future crisis start hides the player clock. The trainer countdown is WP3.
 */

export interface CrisisClockSource {
  start_time?: string | null;
  started_at?: string | null;
  crisis_starts_at?: string | null;
}

export function crisisStartsAt(source: CrisisClockSource | null | undefined): string | null {
  const crisis = source?.crisis_starts_at;
  if (typeof crisis === 'string' && crisis.length > 0) return crisis;
  return null;
}

/** True only when the server sent a crisis start that is still ahead. */
export function playerClockHidden(
  source: CrisisClockSource | null | undefined,
  now = Date.now(),
): boolean {
  const crisis = crisisStartsAt(source);
  if (!crisis) return false;
  const at = Date.parse(crisis);
  return Number.isFinite(at) && now < at;
}

/**
 * Trainer header clock. Prefers `crisis_starts_at` when present, otherwise the
 * same `started_at ?? start_time` fallback the console already used.
 */
export function trainerClockStart(source: CrisisClockSource | null | undefined): string | null {
  const crisis = crisisStartsAt(source);
  if (crisis) return crisis;
  const started = source?.started_at;
  if (typeof started === 'string' && started.length > 0) return started;
  const start = source?.start_time;
  if (typeof start === 'string' && start.length > 0) return start;
  return null;
}
