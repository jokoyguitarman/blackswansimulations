/**
 * Presentation values for the hazard overlay. All of them are assumed:
 * they are visual or engineering choices, not research results.
 */
export const FX = {
  SMOKE_ALPHA_MIN: 0.15,
  SMOKE_ALPHA_MAX: 0.8,
  /**
   * Faintest tint of a room that has a layer at all. A display floor so a
   * forming layer is visible: it is not soot density, and a nearly clean
   * layer reads the same as one with a little soot.
   */
  LAYER_ALPHA_MIN: 0.18,
  LAYER_ALPHA_MAX: 0.85,
  /** Share of the layer tint a thin layer keeps before the room fills. */
  LAYER_FILL_FLOOR: 0.6,
  /** Upper-layer rise above ambient that reads fully hot. */
  LAYER_HOT_RISE_K: 600,
  /**
   * Smoke within this of a burning stud is fully dark: one stud spacing.
   * Distance to fire is a display cue, not layer state. A clean hot layer
   * beside a fire reads dark, and a sooty layer far from one reads pale.
   */
  LAYER_NEAR_FIRE_CORE_M: 3,
  /** Past the core, darkening falls to 1/e over this distance. */
  LAYER_NEAR_FIRE_M: 4,
  /** Burning studs sampled for the darkening. */
  LAYER_FIRE_SAMPLES: 96,
  /** Extra darkening once the layer reaches head height, at full head smoke. */
  LAYER_HEAD_DARKEN: 0.15,
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
  /**
   * Assumed. Wall time the RTS page gives one frame's crowd and effects steps,
   * which holds about 30 fps under load. The office fire costs about 4 ms a
   * crowd step, so an unbudgeted loaded 10x frame ran 240 steps in about 1 s.
   */
  SIM_BUDGET_MS: 33,
  /**
   * Assumed. Step cost the budget uses before it has measured one, so the
   * first frame after a fresh start is budgeted too. About an office fire step.
   */
  SIM_STEP_SEED_MS: 4,
  /** Real seconds of frames the HUD's effective-speed reading averages over. */
  SPEED_WINDOW_S: 1,
  FX_RNG_SEED: 4242,
} as const;

export type FxQuality = 'high' | 'low' | 'classic';

/**
 * The Effects menu. Auto keeps the High → Low → Classic governor.
 * High, Low, and Classic stay where the user put them.
 */
export type FxQualityChoice = 'auto' | FxQuality;

/**
 * Written only when the user picks a tier. The older `rtsFxQuality` key was
 * also written by the governor, so a stored High, Low, or Classic there is
 * not an explicit choice and is ignored.
 */
export const FX_QUALITY_CHOICE_KEY = 'rtsFxQualityChoice';

const FX_QUALITY_CHOICES: readonly FxQualityChoice[] = ['auto', 'high', 'low', 'classic'];

export function isFxQualityChoice(value: string | null): value is FxQualityChoice {
  return value !== null && (FX_QUALITY_CHOICES as readonly string[]).includes(value);
}

/**
 * Missing, legacy, or unknown values read as Auto. An old `rtsFxQuality`
 * entry cannot be told apart from an automatic drop, so it is not a choice.
 */
export function readFxQualityChoice(stored: string | null): FxQualityChoice {
  return isFxQualityChoice(stored) ? stored : 'auto';
}

/**
 * Reads the effects menu. `read` may also see the old `rtsFxQuality` key.
 * That key is not consulted: the governor wrote it as well as the menu.
 */
export function readStoredFxQualityChoice(read: (key: string) => string | null): FxQualityChoice {
  return readFxQualityChoice(read(FX_QUALITY_CHOICE_KEY));
}

/** Auto starts at the top of the ladder. A fixed choice is that tier. */
export function startingFxQuality(choice: FxQualityChoice): FxQuality {
  return choice === 'auto' ? 'high' : choice;
}

/** Next step of an automatic run. Classic has nowhere left to go. */
export function downgradeFxQuality(current: FxQuality): FxQuality | null {
  if (current === 'high') return 'low';
  if (current === 'low') return 'classic';
  return null;
}

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

export interface FxQualityStep {
  /** Quality the overlay should draw. */
  quality: FxQuality;
  /** Auto actually stepped down on this check. */
  downgraded: boolean;
  /**
   * Fixed tier, frames are slow, and a lower tier exists.
   * A hint only: the tier itself does not change.
   */
  hint: boolean;
  /** Quality Undo restores. Unchanged when this check did not step down. */
  remembered: FxQuality | null;
}

/**
 * One check of the effects governor.
 * Auto steps High → Low → Classic. That step is not persisted.
 * A fixed choice never changes. When its frames are slow and a lower tier
 * exists, the result asks for a hint instead.
 * `suppressed` is Undo: Auto stops stepping for the rest of the visit.
 */
export function stepFxQuality(args: {
  choice: FxQualityChoice;
  quality: FxQuality;
  slow: boolean;
  suppressed: boolean;
  remembered: FxQuality | null;
}): FxQualityStep {
  const { choice, quality, slow, suppressed, remembered } = args;
  if (choice !== 'auto') {
    return {
      quality: choice,
      downgraded: false,
      hint: slow && downgradeFxQuality(choice) !== null,
      remembered: null,
    };
  }
  if (!slow || suppressed) {
    return { quality, downgraded: false, hint: false, remembered };
  }
  const next = downgradeFxQuality(quality);
  if (!next) {
    return { quality, downgraded: false, hint: false, remembered };
  }
  return {
    quality: next,
    downgraded: true,
    hint: false,
    remembered: noteDowngradeFrom(remembered, quality),
  };
}
