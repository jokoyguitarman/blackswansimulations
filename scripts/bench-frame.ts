/**
 * RTS page frame cost bench, on the three-storey office fire.
 *
 * Plays the scene the way the page does in showcase mode and times each
 * frame's simulation work: the crowd steps, door leaves and effects slices
 * that advanceSharedFrame runs, plus the per-frame setters and snapshot.
 *
 * FRAME=live feeds each frame's measured time, plus RENDER_MS for drawing,
 * back in as the next frame's dt, the way requestAnimationFrame does. A
 * number gives every frame that many seconds (a loaded page). BUDGET_MS caps
 * the steps a frame runs at the measured step cost.
 *
 *   npm run bench:frame
 *   SPEED=10 FRAME=live RENDER_MS=8 BUDGET_MS=33 COUNTS=150,300,300 npm run bench:frame
 *
 * The root tsconfig leaves this file out. It imports the frontend with .ts
 * extensions, which that program cannot resolve.
 */
import { writeSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { PolygonEvacuationEngine } from '../frontend/src/lib/evacuation/engine.ts';
import { SpatialEffectsEngine } from '../frontend/src/lib/rts/spatialEffects.ts';
import { runOfficeFrames } from '../frontend/tests/scenes/officeTowerFrames.ts';

function say(line: string) {
  writeSync(1, `${line}\n`);
}

const speed = Number(process.env.SPEED ?? 10);
const live = (process.env.FRAME ?? 'live') === 'live';
const fixedFrame = live ? 0 : Number(process.env.FRAME);
const renderMs = Number(process.env.RENDER_MS ?? 8);
const end = Number(process.env.END ?? 210);
const counts = process.env.COUNTS?.split(',').map(Number);
const budgetMs = process.env.BUDGET_MS ? Number(process.env.BUDGET_MS) : undefined;

let crowdMs = 0;
let effectsMs = 0;
const crowdStep = PolygonEvacuationEngine.prototype.step;
PolygonEvacuationEngine.prototype.step = function (this: PolygonEvacuationEngine) {
  const t = performance.now();
  crowdStep.call(this);
  crowdMs += performance.now() - t;
};
const effectsStep = SpatialEffectsEngine.prototype.step;
SpatialEffectsEngine.prototype.step = function (
  this: SpatialEffectsEngine,
  ...args: Parameters<SpatialEffectsEngine['step']>
) {
  const t = performance.now();
  effectsStep.apply(this, args);
  effectsMs += performance.now() - t;
};

const frames: Array<{ ms: number; steps: number }> = [];
let last = performance.now();
let lastFrameS = 1 / 60;
const result = runOfficeFrames(speed, live ? () => lastFrameS : fixedFrame, end, {
  counts,
  budget: budgetMs ? { budgetMs, now: () => performance.now() } : undefined,
  onFrame: (steps) => {
    const now = performance.now();
    frames.push({ ms: now - last, steps });
    lastFrameS = Math.max(1 / 60, (now - last + renderMs) / 1000);
    last = now;
  },
});

const sorted = frames.map((f) => f.ms).sort((a, b) => a - b);
const pick = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
const simMs = sorted.reduce((sum, ms) => sum + ms, 0);
const steps = frames.reduce((sum, f) => sum + f.steps, 0);
const wallS = frames.reduce((sum, f) => sum + Math.max(1000 / 60, f.ms + renderMs), 0) / 1000;
say(
  `speed ${speed}x, ${live ? `live frames (+${renderMs} ms render)` : `${fixedFrame} s frames`}, ` +
    `T+${end} s, people ${counts?.join('/') ?? 'sample'}, ` +
    (budgetMs ? `budget ${budgetMs} ms` : 'no budget'),
);
say(
  `  per step ${(simMs / steps).toFixed(2)} ms (crowd ${(crowdMs / steps).toFixed(2)}, ` +
    `effects ${(effectsMs / steps).toFixed(2)} per crowd step)`,
);
say(
  `  sim per frame p50 ${pick(0.5).toFixed(1)} ms, p95 ${pick(0.95).toFixed(1)} ms, ` +
    `max ${pick(1).toFixed(1)} ms; ${(steps / frames.length).toFixed(1)} steps/frame`,
);
say(
  `  ${(frames.length / wallS).toFixed(1)} fps, sim runs at ${(result.clockS / wallS).toFixed(2)}x ` +
    `real time over ${wallS.toFixed(0)} s`,
);
say(
  `  end: clock ${result.clockS.toFixed(1)} s, out ${result.out}, down ${result.down}, ` +
    `sheltering ${result.sheltering}, burning ${result.burning}`,
);
