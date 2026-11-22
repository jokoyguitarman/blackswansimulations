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

export const SIM_CLOCK = {
  fixedDt: FX.FIXED_DT,
  effectsDt: FX.EFFECTS_DT,
  maxSteps: FX.MAX_STEPS_PER_FRAME,
} as const;
