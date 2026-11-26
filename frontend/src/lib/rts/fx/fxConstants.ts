/**
 * Presentation values for the hazard overlay. All of them are assumed:
 * they are visual or engineering choices, not research results.
 */
export const FX = {
  SMOKE_ALPHA_MIN: 0.15,
  SMOKE_ALPHA_MAX: 0.8,
  /** Faintest tint of a room that has a layer at all. */
  LAYER_ALPHA_MIN: 0.18,
  LAYER_ALPHA_MAX: 0.85,
  /** Share of the layer tint a thin layer keeps before the room fills. */
  LAYER_FILL_FLOOR: 0.6,
  /** Upper-layer rise above ambient that reads fully hot. */
  LAYER_HOT_RISE_K: 600,
  /** Darkening falls to 1/e this far from a burning stud. */
  LAYER_NEAR_FIRE_M: 6,
  /** Burning studs sampled per room for the darkening. */
  LAYER_FIRE_SAMPLES: 48,
  NOISE_SIZE: 128,
  NOISE_SCALE_M: 12,
  NOISE_STRENGTH: 0.35,
  DRIFT_DIR: 45,
  DRIFT_SPEED_PX_S: 10,
  FLICKER_AMP: 0.18,
  EMBER_RATE_PER_STUD_S: 0.6,
  EMBER_LIFE_S: [1.0, 2.5] as const,
  EMBER_DRIFT_M_S: 1.2,
  EMBER_CAP_HIGH: 400,
  EMBER_CAP_LOW: 120,
  FRONT_PULSE_HZ: 1.5,
  AUTO_DOWNGRADE_MS: 6,
  /**
   * Assumed. A frame interval above this (about 50 fps) also steps the quality
   * down. The draw-time meter misses present-time work such as scaling and
   * compositing, so a slow frame can hide behind a small draw sample.
   */
  FRAME_DOWNGRADE_MS: 20,
  FIXED_DT: 1 / 60,
  EFFECTS_DT: 0.1,
  MAX_STEPS_PER_FRAME: 240,
  FX_RNG_SEED: 4242,
} as const;

export type FxQuality = 'high' | 'low' | 'classic';

/**
 * Draw time over 6 ms always steps the quality down.
 * A slow frame steps it down only when the overlay was actually drawing
 * smoke, fire, or embers (`effectsActive`). An idle field is not the cause.
 */
export function shouldAutoDowngrade(
  drawAvgMs: number,
  frameAvgMs: number,
  effectsActive = false,
): boolean {
  if (drawAvgMs > FX.AUTO_DOWNGRADE_MS) return true;
  return effectsActive && frameAvgMs > FX.FRAME_DOWNGRADE_MS;
}

/**
 * Quality at the start of an automatic High → Low → Classic run.
 * A second step keeps the first quality, so Undo restores both.
 */
export function noteDowngradeFrom(remembered: FxQuality | null, current: FxQuality): FxQuality {
  return remembered ?? current;
}
