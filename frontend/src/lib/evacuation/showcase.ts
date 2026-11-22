import { SHOWCASE } from './showcaseConstants';

export type InjuryBand = 'lethal' | 'serious' | 'minor' | 'none';

export function blastInjuryBand(dist: number, radius: number): InjuryBand {
  // hypot() of a point placed on a ring lands a fraction of a millimetre outside the
  // exact radius. 0.1 mm keeps the inclusive boundaries (0.293 R, 0.444 R, R) inclusive.
  const d = dist - 0.0001;
  if (d <= SHOWCASE.LETHAL_RING_FRACTION * radius) return 'lethal';
  if (d <= SHOWCASE.SERIOUS_RING_FRACTION * radius) return 'serious';
  if (d <= SHOWCASE.MINOR_RING_FRACTION * radius) return 'minor';
  return 'none';
}

export function blastEffectsTriggerSec(timeScale: number): number {
  return SHOWCASE.BLAST_AT_GAME_S * timeScale;
}

export function shiftEvents<T extends { triggerTimeSec: number }>(events: T[], offsetSec: number): T[] {
  return events.map((e) => ({ ...e, triggerTimeSec: e.triggerTimeSec + offsetSec }));
}

export function isBlastDue(gameElapsed: number, fired: boolean): boolean {
  return !fired && gameElapsed >= SHOWCASE.BLAST_AT_GAME_S;
}

/** 'Blast in 0:42', or '' once the blast is due. */
export function countdownLabel(gameElapsed: number): string {
  if (gameElapsed >= SHOWCASE.BLAST_AT_GAME_S) return '';
  const total = Math.max(0, Math.ceil(SHOWCASE.BLAST_AT_GAME_S - gameElapsed));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `Blast in ${m}:${String(s).padStart(2, '0')}`;
}

export interface ExplosionFxFrame {
  flashAlpha: number;
  ringRadiusM: number;
  ringAlpha: number;
  fireballRadiusM: number;
  fireballAlpha: number;
  shakePx: number;
}

function easeOutCubic(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return 1 - (1 - c) ** 3;
}

export function explosionFxFrame(ageS: number, radiusM: number, reducedMotion: boolean): ExplosionFxFrame {
  const flashAlpha = reducedMotion
    ? 0
    : ageS < SHOWCASE.FX_FLASH_S
      ? 0.8 * (1 - ageS / SHOWCASE.FX_FLASH_S)
      : 0;
  const ringT = Math.min(1, ageS / SHOWCASE.FX_RING_S);
  return {
    flashAlpha,
    ringRadiusM: 1.6 * radiusM * easeOutCubic(ringT),
    ringAlpha: Math.max(0, 1 - ageS / SHOWCASE.FX_RING_S),
    fireballRadiusM: 0.4 * radiusM * Math.min(1, ageS / 0.4),
    fireballAlpha: Math.max(0, 1 - ageS / SHOWCASE.FX_FIREBALL_S),
    shakePx:
      !reducedMotion && ageS < SHOWCASE.FX_SHAKE_S
        ? SHOWCASE.FX_SHAKE_PX * (1 - ageS / SHOWCASE.FX_SHAKE_S)
        : 0,
  };
}
