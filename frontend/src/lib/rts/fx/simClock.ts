import type { HazardZone, InteriorWall } from '../types';
import { FX } from './fxConstants';

export interface StepAccumulator {
  acc: number;
  dropped: number;
}

export function createAccumulator(): StepAccumulator {
  return { acc: 0, dropped: 0 };
}

/**
 * How many fixed steps fit in this frame. Mutates only the accumulator.
 * Steps beyond `maxSteps` are dropped and counted.
 */
export function takeSteps(
  a: StepAccumulator,
  frameDt: number,
  speed: number,
  fixedDt: number,
  maxSteps: number,
): number {
  if (!(frameDt > 0) || !(speed > 0) || !(fixedDt > 0) || maxSteps <= 0) return 0;
  a.acc += frameDt * speed;
  const available = Math.floor(a.acc / fixedDt + 1e-9);
  if (available <= 0) return 0;
  const n = available > maxSteps ? maxSteps : available;
  a.acc -= n * fixedDt;
  const extra = available - n;
  if (extra > 0) {
    a.dropped += extra;
    a.acc -= extra * fixedDt;
  }
  return n;
}

/**
 * Step the effects field in fixed EFFECTS_DT slices. The smoke spread is an
 * Euler step, so a 1 s call is not ten calls of 0.1 s. The headless scenes use
 * this; the RTS page steps the effects field through advanceSharedFrame.
 */
export function stepEffectsFixed(
  engine: { step(dt: number, walls: InteriorWall[], hazards: HazardZone[]): void },
  acc: StepAccumulator,
  frameDt: number,
  speed: number,
  walls: InteriorWall[],
  hazards: HazardZone[],
  afterStep?: () => void,
): number {
  const n = takeSteps(acc, frameDt, speed, FX.EFFECTS_DT, FX.MAX_STEPS_PER_FRAME);
  for (let i = 0; i < n; i++) {
    engine.step(FX.EFFECTS_DT, walls, hazards);
    afterStep?.();
  }
  return n;
}

/**
 * Simulated seconds one frame may run, shared by the crowd, the effects field
 * and the game clock. A slower frame than this slows the clock instead of
 * letting one subsystem run ahead of the others.
 */
export const MAX_FRAME_SIM_S = FX.MAX_STEPS_PER_FRAME * FX.FIXED_DT;

/** Crowd steps per effects slice. EFFECTS_DT must be a whole number of FIXED_DT. */
export const CROWD_STEPS_PER_EFFECTS_STEP = Math.round(FX.EFFECTS_DT / FX.FIXED_DT);

/**
 * One clock for the crowd and the effects field. The crowd takes FIXED_DT
 * steps from `acc`, and the effects field steps once every
 * CROWD_STEPS_PER_EFFECTS_STEP crowd steps, so both have always lived the
 * same simulated time, whatever the speed or frame rate.
 */
export interface SharedSimClock extends StepAccumulator {
  crowdSteps: number;
  effectSteps: number;
  /**
   * Smoothed wall time of one crowd step with its share of effects, ms.
   * Starts at SIM_STEP_SEED_MS; the first measurement replaces the seed.
   */
  msPerStep: number;
  costMeasured: boolean;
}

export function createSharedClock(): SharedSimClock {
  return {
    acc: 0,
    dropped: 0,
    crowdSteps: 0,
    effectSteps: 0,
    msPerStep: FX.SIM_STEP_SEED_MS,
    costMeasured: false,
  };
}

/** Start a new run. The measured step cost carries over, so its first frame is budgeted. */
export function resetSharedClock(clock: SharedSimClock): void {
  clock.acc = 0;
  clock.dropped = 0;
  clock.crowdSteps = 0;
  clock.effectSteps = 0;
}

/** Real seconds of this frame the game clock may count at `speed`. */
export function cappedFrameDt(frameDt: number, speed: number): number {
  if (!(speed > 0)) return frameDt;
  return Math.min(frameDt, MAX_FRAME_SIM_S / speed);
}

export interface SharedFrameHooks {
  /** Once per frame, before any step, with the simulated seconds the frame will run. */
  beforeSteps?(simS: number): void;
  /** One crowd step. `stepNo` counts from 1 since the clock was reset. */
  crowdStep?(stepNo: number): void;
  /** One EFFECTS_DT slice, taken right after the crowd step that reaches it. */
  effectsStep?(): void;
}

export interface SharedFrameBudget {
  /** Wall time the frame's steps may take, ms. */
  budgetMs: number;
  now: () => number;
}

/** Weight of the newest frame in `msPerStep`. */
const STEP_COST_SMOOTHING = 0.2;

/**
 * Run this frame's share of simulated time on every subsystem: at most
 * MAX_FRAME_SIM_S, and with a budget at most the steps that fit in it at the
 * measured step cost (never fewer than one). The rest is dropped and counted
 * in `dropped` steps, so a slow machine slows the clock instead of falling
 * further behind every frame.
 */
export function advanceSharedFrame(
  clock: SharedSimClock,
  frameDt: number,
  speed: number,
  hooks: SharedFrameHooks,
  budget?: SharedFrameBudget,
): { crowdSteps: number; effectSteps: number } {
  let maxSteps: number = FX.MAX_STEPS_PER_FRAME;
  if (budget && clock.msPerStep > 0) {
    maxSteps = Math.max(1, Math.min(maxSteps, Math.floor(budget.budgetMs / clock.msPerStep)));
  }
  const n = takeSteps(clock, frameDt, speed, FX.FIXED_DT, maxSteps);
  const startMs = budget && n > 0 ? budget.now() : 0;
  hooks.beforeSteps?.(n * FX.FIXED_DT);
  let effectSteps = 0;
  for (let i = 0; i < n; i++) {
    clock.crowdSteps++;
    hooks.crowdStep?.(clock.crowdSteps);
    const due = Math.floor(clock.crowdSteps / CROWD_STEPS_PER_EFFECTS_STEP);
    while (clock.effectSteps < due) {
      clock.effectSteps++;
      effectSteps++;
      hooks.effectsStep?.();
    }
  }
  if (budget && n > 0) {
    const perStep = (budget.now() - startMs) / n;
    clock.msPerStep = clock.costMeasured
      ? clock.msPerStep + STEP_COST_SMOOTHING * (perStep - clock.msPerStep)
      : perStep;
    clock.costMeasured = true;
  }
  return { crowdSteps: n, effectSteps };
}

/**
 * advanceSharedFrame, then move the game by the simulated time the frame
 * actually ran: responder units tick on it, and the clock is set to the
 * crowd's step count, so units, crowd, effects and clock stay in step.
 */
export function advanceGameFrame(
  game: { tick(dtReal: number): void; syncElapsed(seconds: number): void },
  clock: SharedSimClock,
  frameDt: number,
  speed: number,
  hooks: SharedFrameHooks,
  budget?: SharedFrameBudget,
): { crowdSteps: number; effectSteps: number } {
  const ran = advanceSharedFrame(clock, frameDt, speed, hooks, budget);
  if (ran.crowdSteps > 0) game.tick((ran.crowdSteps * FX.FIXED_DT) / speed);
  game.syncElapsed(clock.crowdSteps * FX.FIXED_DT);
  return ran;
}

/**
 * Simulated seconds per real second over the last SPEED_WINDOW_S of running
 * frames. The window restarts when the chosen speed changes.
 */
export interface SpeedMeter {
  speed: number;
  realS: number;
  simS: number;
  effective: number | null;
}

export function createSpeedMeter(): SpeedMeter {
  return { speed: 0, realS: 0, simS: 0, effective: null };
}

/** Count one running frame. Returns true when `effective` has a new reading. */
export function noteFrameSpeed(
  meter: SpeedMeter,
  speed: number,
  frameDt: number,
  simDt: number,
): boolean {
  if (meter.speed !== speed) {
    meter.speed = speed;
    meter.realS = 0;
    meter.simS = 0;
    meter.effective = null;
  }
  if (!(frameDt > 0)) return false;
  meter.realS += frameDt;
  meter.simS += simDt;
  if (meter.realS < FX.SPEED_WINDOW_S) return false;
  meter.effective = meter.simS / meter.realS;
  meter.realS = 0;
  meter.simS = 0;
  return true;
}

/** Below this share of the chosen speed, the HUD shows the effective speed. */
const SLOWED_FRACTION = 0.9;

/** '10x', or '10x (running 3.1x)' when the budget or the frame cap is slowing the clock. */
export function speedLabel(speed: number, effective: number | null): string {
  const chosen = `${speed}x`;
  if (effective == null || effective >= speed * SLOWED_FRACTION) return chosen;
  return `${chosen} (running ${effective.toFixed(1)}x)`;
}

export const SIM_CLOCK = {
  fixedDt: FX.FIXED_DT,
  effectsDt: FX.EFFECTS_DT,
  maxSteps: FX.MAX_STEPS_PER_FRAME,
} as const;
