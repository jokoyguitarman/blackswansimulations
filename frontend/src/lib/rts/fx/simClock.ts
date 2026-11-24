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

export const SIM_CLOCK = {
  fixedDt: FX.FIXED_DT,
  effectsDt: FX.EFFECTS_DT,
  maxSteps: FX.MAX_STEPS_PER_FRAME,
} as const;
