import { crisisStartsAt, playerClockHidden } from './crisisClock';

/** True only when the server sent a crisis start that is still ahead. */
export function crisisBriefLocked(source: object | null | undefined, now = Date.now()): boolean {
  return playerClockHidden(source, now);
}

/**
 * The crisis section is added only when the peace clock was sent.
 * Without that field the briefing stays as it is today.
 */
export function showCrisisBriefSection(source: object | null | undefined): boolean {
  return crisisStartsAt(source) != null;
}
