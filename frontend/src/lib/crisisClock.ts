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

function clockString(source: object | null | undefined, key: string): string | null {
  if (!source) return null;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function crisisStartsAt(source: object | null | undefined): string | null {
  return clockString(source, 'crisis_starts_at');
}

/** True only when the server sent a crisis start that is still ahead. */
export function playerClockHidden(source: object | null | undefined, now = Date.now()): boolean {
  const crisis = crisisStartsAt(source);
  if (!crisis) return false;
  const at = Date.parse(crisis);
  return Number.isFinite(at) && now < at;
}

/**
 * Trainer header clock. Prefers `crisis_starts_at` when present, otherwise the
 * same `started_at ?? start_time` fallback the console already used.
 */
export function trainerClockStart(source: object | null | undefined): string | null {
  return (
    crisisStartsAt(source) ?? clockString(source, 'started_at') ?? clockString(source, 'start_time')
  );
}
