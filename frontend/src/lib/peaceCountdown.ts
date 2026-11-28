import { crisisStartsAt } from './crisisClock';

/** Trainer chip. Null once the crisis has started, and whenever the clock is absent. */
export function peaceCountdownLabel(source: object | null | undefined, now = Date.now()): string | null {
  const crisis = crisisStartsAt(source);
  if (!crisis) return null;
  const at = Date.parse(crisis);
  if (!Number.isFinite(at) || now >= at) return null;
  const remain = Math.ceil((at - now) / 1000);
  const minutes = Math.floor(remain / 60);
  const seconds = remain % 60;
  const padded = seconds < 10 ? `0${seconds}` : String(seconds);
  return `Peace · ${minutes}:${padded} to crisis`;
}
