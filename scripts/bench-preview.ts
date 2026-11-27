/**
 * Setup preview cost bench, on the three-storey office fire.
 *
 * Runs the Preview Hazard Effects button's engine to SECONDS after the blast
 * (the page's default is 300) and times it. Then replays the steps the run
 * kept on a fresh engine, checks it lands on the same state, and prints
 * what the preview shows at fixed marks beside live 0.1 s stepping.
 *
 *   npm run bench:preview
 *   SECONDS=120 LIVE=0 npm run bench:preview
 *
 * The root tsconfig leaves this file out. It imports the frontend with .ts
 * extensions, which that program cannot resolve.
 */
import { writeSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { FX } from '../frontend/src/lib/rts/fx/fxConstants.ts';
import { PreviewRun, buildPreviewEngine } from '../frontend/src/lib/rts/effectsPreview.ts';
import type { SpatialEffectsEngine } from '../frontend/src/lib/rts/spatialEffects.ts';
import { sceneHash } from '../frontend/tests/scenes/hash.ts';
import { officePreviewInput } from '../frontend/tests/scenes/officePreview.ts';
import { effectsState } from '../frontend/tests/scenes/stateHash.ts';

function say(line: string) {
  writeSync(1, `${line}\n`);
}

const seconds = Number(process.env.SECONDS ?? 300);
const live = (process.env.LIVE ?? '1') !== '0';
const marks = [5, 10, 30, 60, 120, 300, 600, 1200, 3600].filter((m) => m <= seconds);
const { input, walls } = officePreviewInput();

const start = performance.now();
const run = new PreviewRun(input, seconds, walls);
while (run.advance());
const ms = performance.now() - start;
say(
  `preview: ${(ms / 1000).toFixed(2)} s, ${run.steps} steps (${run.schedule().length} kept, ${run.rollbacks} rollbacks)`,
);

interface Row {
  peakG: number;
  total: number;
  burning: number;
}

function sample(engine: SpatialEffectsEngine): Row {
  const row = { peakG: 0, total: 0, burning: 0 };
  for (const stud of input.studs) {
    const st = engine.studStates.get(stud.id);
    if (!st) continue;
    if (stud.level === 'G') row.peakG = Math.max(row.peakG, st.smoke);
    row.total += st.smoke;
    if (st.fire.state === 'burning') row.burning++;
  }
  return row;
}

/** Step a fresh engine through `steps` and read it at each mark. */
function replay(steps: (t0: number) => Iterable<number>) {
  const { engine, t0, hazards } = buildPreviewEngine(input);
  const rows: Row[] = [];
  let t = 0;
  let k = 0;
  const list = [...steps(t0)];
  for (const mark of marks) {
    while (k < list.length && t < t0 + mark - 1e-9) {
      engine.step(list[k]!, walls, hazards);
      t += list[k]!;
      k++;
    }
    rows.push(sample(engine));
  }
  while (k < list.length) engine.step(list[k++]!, walls, hazards);
  return { rows, engine };
}

const kept = replay(() => run.schedule());
const same = sceneHash(effectsState(kept.engine)) === sceneHash(effectsState(run.engine));
say(`replay of the kept steps matches the run: ${same}`);
const liveRows = live
  ? replay((t0) => Array(Math.round((t0 + seconds) / FX.EFFECTS_DT)).fill(FX.EFFECTS_DT)).rows
  : null;
const fmt = (r: Row) =>
  `peakG ${r.peakG.toFixed(4)} total ${r.total.toFixed(2)} burning ${r.burning}`;
marks.forEach((mark, i) => {
  const p = kept.rows[i]!;
  const l = liveRows?.[i];
  say(`T+${mark}: preview ${fmt(p)}${l ? ` | live ${fmt(l)}` : ''}`);
});
