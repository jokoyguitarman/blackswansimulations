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
 * Euler step, so a 1 s call is not ten calls of 0.1 s. Both the showcase and
 * the plain loop use this, and the dose is taken after each slice.
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
}

export function createSharedClock(): SharedSimClock {
  return { acc: 0, dropped: 0, crowdSteps: 0, effectSteps: 0 };
}

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

/**
 * Run this frame's share of simulated time on every subsystem: at most
 * MAX_FRAME_SIM_S, with the rest dropped and counted in `dropped` steps.
 */
export function advanceSharedFrame(
  clock: SharedSimClock,
  frameDt: number,
  speed: number,
  hooks: SharedFrameHooks,
): { crowdSteps: number; effectSteps: number } {
  const n = takeSteps(clock, frameDt, speed, FX.FIXED_DT, FX.MAX_STEPS_PER_FRAME);
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
  return { crowdSteps: n, effectSteps };
}

export const SIM_CLOCK = {
  fixedDt: FX.FIXED_DT,
  effectsDt: FX.EFFECTS_DT,
  maxSteps: FX.MAX_STEPS_PER_FRAME,
} as const;
