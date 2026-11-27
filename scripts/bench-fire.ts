/**
 * Harbour House fire bench.
 *
 * Effects run in 0.1 s slices and the crowd at 1/60 s, which is the loop the
 * published 23–28 ms slice was measured on. The Decision 9 goldens stay on
 * the 1/60 s effects frame; this script only changes the timed loop.
 *
 *   npm run bench:fire
 *   END=180 PEDS=120 npm run bench:fire
 *
 * The root tsconfig leaves this file out. It imports the frontend with .ts
 * extensions, which that program cannot resolve.
 */
import { writeSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { HarbourRun } from '../frontend/tests/scenes/harbourHarness.ts';
import { confirmedFuelCells } from '../frontend/src/lib/rts/materialLibrary.ts';
import { harbourHouseFuelObjects } from '../frontend/src/lib/rts/harbourHouseShowcase.ts';

function say(line: string) {
  writeSync(1, `${line}\n`);
}

const peds = Number(process.env.PEDS ?? 120);
const end = Number(process.env.END ?? 300);
const run = new HarbourRun({
  peds,
  afterExit: 'zone',
  zones: [{ pos: { x: -30, y: -10 }, kind: 'assembly' }],
});
run.start();
run.effects.setFuelCells(confirmedFuelCells(harbourHouseFuelObjects(run.studs), run.studs));

const effects = run.effects;
const origFx = effects.step.bind(effects);
const origEv = run.evac.step.bind(run.evac);

let acc = 0;
let fxT = 0;
let fxN = 0;
let fxMax = 0;
const sliceMs: number[] = [];
effects.step = ((dt: number, walls: unknown, hazards: unknown) => {
  acc += dt;
  while (acc >= 0.1 - 1e-12) {
    const t0 = performance.now();
    origFx(0.1, walls as never, hazards as never);
    const d = performance.now() - t0;
    fxT += d;
    fxN += 1;
    if (d > fxMax) fxMax = d;
    sliceMs.push(d);
    acc -= 0.1;
  }
}) as typeof effects.step;

let evT = 0;
let evN = 0;
let evMax = 0;
run.evac.step = (() => {
  const t0 = performance.now();
  origEv();
  const d = performance.now() - t0;
  evT += d;
  evN += 1;
  if (d > evMax) evMax = d;
}) as typeof run.evac.step;

const DT = 1 / 60;
const worldMs: number[] = [];
let secondFx = 0;
let secondEv = 0;
let secondStart = 0;
let prevSmoke = new Map<string, number>();
let deltaMax = 0;
let deltaAt = 0;
const wall0 = performance.now();
let lastMark = 0;

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i] ?? 0;
}

function noteSecond(t: number) {
  while (t - secondStart >= 1 - 1e-9) {
    worldMs.push(secondFx + secondEv);
    secondFx = 0;
    secondEv = 0;
    secondStart += 1;
  }
}

say(
  `Harbour bench. Node ${process.version}. ${peds} people, ${run.studs.length} studs, effects 0.1 s, crowd 1/60 s.`,
);

while (run.rts.state.clock.elapsed < end) {
  const fxBefore = fxT;
  const evBefore = evT;
  run.frame(DT);
  secondFx += fxT - fxBefore;
  secondEv += evT - evBefore;
  const t = run.rts.state.clock.elapsed;
  noteSecond(t);
  if (t - deltaAt >= 2 - 1e-9) {
    let bytes = 2;
    let changed = 0;
    const next = new Map<string, number>();
    for (const [id, state] of effects.studStates) {
      const smoke = state.smoke;
      next.set(id, smoke);
      if (smoke !== (prevSmoke.get(id) ?? 0)) {
        changed += 1;
        bytes += id.length + 12;
      }
    }
    if (bytes > deltaMax) deltaMax = bytes;
    prevSmoke = next;
    deltaAt = t;
  }
  if (t - lastMark >= 60 - 1e-9) {
    lastMark = t;
    const heap = Math.round(process.memoryUsage().heapUsed / (1024 * 1024));
    say(
      `T+${Math.round(t)} fx mean ${(fxT / Math.max(1, fxN)).toFixed(2)} ms max ${fxMax.toFixed(1)} (n ${fxN}) | evac mean ${(evT / Math.max(1, evN)).toFixed(2)} ms max ${evMax.toFixed(1)} (n ${evN}) | world p50 ${percentile(worldMs, 50).toFixed(1)} p95 ${percentile(worldMs, 95).toFixed(1)} max ${percentile(worldMs, 100).toFixed(1)} ms/s | heap ${heap} MB | smoke delta max ${deltaMax} B | burning ${effects.getStats().fire.burning} | heat passes ${effects.heatSolvePasses} peak ${effects.heatSolvePeak} | jump unbacked ${(effects.jumpUnbackedKj / 1000).toFixed(2)} MJ`,
    );
    fxT = 0;
    fxN = 0;
    fxMax = 0;
    evT = 0;
    evN = 0;
    evMax = 0;
    worldMs.length = 0;
    deltaMax = 0;
  }
}

const burning = sliceMs.slice(-600);
const burnMean = burning.reduce((sum, v) => sum + v, 0) / Math.max(1, burning.length);
say(
  `studs ${run.studs.length}, peds ${peds}, wall ${((performance.now() - wall0) / 1000).toFixed(2)} s for ${end} s game`,
);
say(
  `last minute effects mean ${burnMean.toFixed(2)} ms, p95 ${percentile(burning, 95).toFixed(2)} ms, max ${percentile(burning, 100).toFixed(2)} ms`,
);
say(
  `oxygen heat solve passes ${effects.heatSolvePasses}, peak ${effects.heatSolvePeak} per slice, jump unbacked ${(effects.jumpUnbackedKj / 1000).toFixed(2)} MJ`,
);
