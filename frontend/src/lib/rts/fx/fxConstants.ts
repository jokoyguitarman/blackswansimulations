/**
 * Presentation values for the hazard overlay. All of them are assumed:
 * they are visual or engineering choices, not research results.
 */
export const FX = {
  SMOKE_ALPHA_MIN: 0.15,
  SMOKE_ALPHA_MAX: 0.8,
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
  FIXED_DT: 1 / 60,
  EFFECTS_DT: 0.1,
  MAX_STEPS_PER_FRAME: 240,
  FX_RNG_SEED: 4242,
} as const;

export type FxQuality = 'high' | 'low' | 'classic';
