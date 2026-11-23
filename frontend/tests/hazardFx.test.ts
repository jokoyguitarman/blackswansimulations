import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { PolygonEvacuationEngine } from '../src/lib/evacuation/engine';
import { isInsidePolygon } from '../src/lib/evacuation/geometry';
import { HazardField, headSmoke } from '../src/lib/evacuation/hazardSensing';
import { blastEffectsTriggerSec } from '../src/lib/evacuation/showcase';
import { SHOWCASE } from '../src/lib/evacuation/showcaseConstants';
import type { ExitDef, Vec2 } from '../src/lib/evacuation/types';
import { RTSEngine } from '../src/lib/rts/engine';
import { DEFAULT_FIRE_PARAMS } from '../src/lib/rts/fireSimulation';
import { EmberPool } from '../src/lib/rts/fx/embers';
import { FX, noteDowngradeFrom, shouldAutoDowngrade } from '../src/lib/rts/fx/fxConstants';
import { SpatialEffectsEngine } from '../src/lib/rts/spatialEffects';
import type { HazardZone } from '../src/lib/rts/types';
import {
  buildRasterLayout,
  dilateEmpty,
  frontCells,
  pulseCells,
  writeFireRGBA,
  writeSmokeRGBA,
  type RasterLayout,
} from '../src/lib/rts/fx/hazardRaster';
import { makeValueNoiseTexture } from '../src/lib/rts/fx/noise';
import { createAccumulator, takeSteps } from '../src/lib/rts/fx/simClock';

function grid(cols: number, rows: number, cell = 3) {
  const studs: { id: string; simPos: { x: number; y: number } }[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      studs.push({ id: `${c},${r}`, simPos: { x: c * cell, y: r * cell } });
    }
  }
  return { studs, layout: buildRasterLayout(studs, cell) };
}

function stateMap(
  layout: RasterLayout,
  fire: string,
  smoke = 0,
): Map<string, { smoke: number; fire: { state: string } }> {
  const map = new Map<string, { smoke: number; fire: { state: string } }>();
  for (const id of layout.studIds) map.set(id, { smoke, fire: { state: fire } });
  return map;
}

function exitDef(partial: {
  id: string;
  center: Vec2;
  edgeIndex: number;
  status?: ExitDef['status'];
}): ExitDef {
  return {
    id: partial.id,
    center: partial.center,
    width: 2,
    edgeIndex: partial.edgeIndex,
    description: partial.id,
    status: partial.status ?? 'open',
    photos: [],
  };
}

/**
 * The page loop: one batch of evacuation steps, the blast on its step, then
 * the effects steps for that frame. The last frame is shortened so the run
 * stops on `target` evacuation steps rather than the next clock boundary.
 */
function pageLoopUntil(frameMs: number, target: number) {
  const verts: Vec2[] = [
    { x: 0, y: 0 },
    { x: 60, y: 0 },
    { x: 60, y: 40 },
    { x: 0, y: 40 },
  ];
  const exits: ExitDef[] = [
    exitDef({ id: 'E1-west', center: { x: 0, y: 20 }, edgeIndex: 3 }),
    exitDef({ id: 'E2-east', center: { x: 60, y: 12 }, edgeIndex: 1 }),
    exitDef({ id: 'E3-north', center: { x: 30, y: 40 }, edgeIndex: 2, status: 'congested' }),
  ];
  const walls = [
    { startX: 22, startY: 0, endX: 22, endY: 34, hasDoor: true, doorWidth: 1.6, doorPosition: 0.5 },
    { startX: 40, startY: 6, endX: 40, endY: 40, hasDoor: true, doorWidth: 1.6, doorPosition: 0.4 },
  ];
  const evac = new PolygonEvacuationEngine(
    {
      vertices: verts,
      pedestrianCount: 48,
      pedestrianRadius: 0.25,
      desiredSpeed: 1.4,
      panicFactor: 0,
      dt: FX.FIXED_DT,
    },
    exits,
    walls,
    [],
    { afterExit: 'disperse', zones: [], seed: SHOWCASE.RNG_SEED },
  );
  const studs: { id: string; simPos: Vec2; spatialContext: 'inside_building' }[] = [];
  for (let y = 1.5; y < 40; y += 3) {
    for (let x = 1.5; x < 60; x += 3) {
      const simPos = { x, y };
      if (isInsidePolygon(x, y, verts)) {
        studs.push({ id: `${x},${y}`, simPos, spatialContext: 'inside_building' });
      }
    }
  }
  const effects = new SpatialEffectsEngine({
    ...DEFAULT_FIRE_PARAMS,
    ambientSpread: true,
    ambientHeatSec: SHOWCASE.AMBIENT_HEAT_S,
  });
  effects.init(studs);
  const blastSite = { x: 30, y: 20 };
  const blastR = 12;
  const affected = studs
    .filter((s) => Math.hypot(s.simPos.x - blastSite.x, s.simPos.y - blastSite.y) <= blastR)
    .map((s) => s.id);
  const t0 = blastEffectsTriggerSec(effects.timeScale);
  effects.registerHazard(
    'blast-direct',
    [
      {
        triggerTimeSec: t0,
        eventType: 'explode',
        spreadType: 'fire',
        spreadRadius: blastR,
        spreadRate: 10,
        description: 'Direct blast ignition',
        severity: 'critical',
        smokeGeneration: 'heavy',
        affectedStuds: affected,
      },
    ],
    {
      initial: 'Pre-detonation',
      triggered: 'Blast wave',
      worsening: 'Fire spreading',
      critical: 'Engulfed',
    },
  );
  const blastZone: HazardZone = {
    id: 'blast-direct',
    pos: blastSite,
    radius: blastR,
    hazardType: 'ignitable',
    severity: 'high',
    label: 'Blast',
    description: '',
    photos: [],
  };
  const field = new HazardField(
    studs.map((s) => ({ id: s.id, simPos: s.simPos, indoor: true })),
    3,
  );
  evac.setHazardField(field);
  const rts = new RTSEngine();
  rts.setBuildingVertices(verts);
  rts.startDetonation();
  const evacAcc = createAccumulator();
  const effectsAcc = createAccumulator();
  const blastStep = Math.round(SHOWCASE.BLAST_AT_GAME_S / FX.FIXED_DT);
  let evacDone = 0;
  let effectDone = 0;
  let fired = false;
  let spins = 0;
  while (evacDone < target && spins++ < target + 5) {
    const room = target - evacDone;
    const need = room * FX.FIXED_DT - evacAcc.acc;
    const speed = rts.state.clock.speed;
    const dt = Math.min(frameMs / 1000, need > 0 ? need / speed : 0);
    rts.tick(dt);
    if (rts.state.clock.paused || rts.state.clock.phase === 'setup') continue;
    field.setStates(effects.studStates);
    evac.syncExits(exits);
    evac.setZones([]);
    let n = dt > 0 ? takeSteps(evacAcc, dt, speed, FX.FIXED_DT, FX.MAX_STEPS_PER_FRAME) : 0;
    if (n > room) {
      evacAcc.acc += (n - room) * FX.FIXED_DT;
      n = room;
    }
    const cursorStart = evacDone;
    let cursor = 0;
    if (!fired && cursorStart + n >= blastStep) {
      const pre = Math.max(0, Math.min(n, blastStep - cursorStart));
      for (; cursor < pre; cursor++) evac.step();
      fired = true;
      evac.triggerBlast(blastSite, blastR);
    }
    for (; cursor < n; cursor++) evac.step();
    evacDone += n;
    const m =
      dt > 0 ? takeSteps(effectsAcc, dt, speed, FX.EFFECTS_DT, FX.MAX_STEPS_PER_FRAME) : 0;
    for (let i = 0; i < m; i++) effects.step(FX.EFFECTS_DT, [], [blastZone]);
    effectDone += m;
    if (n === 0 && m === 0) break;
  }
  const metrics = evac.getMetrics().showcase!;
  const arrived = Object.values(metrics.arrived).reduce((a, b) => a + b, 0);
  let smoke = 0;
  for (const s of effects.studStates.values()) smoke += s.smoke;
  const counters = {
    evacuated: metrics.outside + arrived + metrics.leftMap,
    crawling: metrics.crawling,
    arrived,
    down: `${metrics.down.lethal}/${metrics.down.serious}`,
    reroutes: metrics.reroutes,
    burning: effects.getStats().fire.burning,
    smoke: Math.round((smoke / effects.studStates.size) * 1e4) / 1e4,
  };
  evac.destroy();
  return { evacSteps: evacDone, effectSteps: effectDone, counters };
}

describe('hazard fx', () => {
  test('layout is one pixel per stud and ignores sub-cell jitter', () => {
    const { studs, layout } = grid(5, 4, 3);
    assert.equal(layout.cols, 5);
    assert.equal(layout.rows, 4);
    assert.equal(layout.collisions, 0);
    assert.equal(layout.index.length, 20);
    for (let i = 0; i < layout.index.length; i++) assert.equal(layout.index[i], i);

    const jittered = studs.map((s, i) => ({
      id: s.id,
      simPos: {
        x: s.simPos.x + (i % 2 === 0 ? 0.4 : -0.4),
        y: s.simPos.y + (i % 3 === 0 ? -0.4 : 0.4),
      },
    }));
    const moved = buildRasterLayout(jittered, 3);
    assert.equal(moved.cols, 5);
    assert.equal(moved.rows, 4);
    for (let i = 0; i < layout.index.length; i++) {
      assert.equal(moved.index[i], layout.index[i]);
    }

    const clash = buildRasterLayout(
      [
        { id: 'a', simPos: { x: 1, y: 1 } },
        { id: 'b', simPos: { x: 1.2, y: 0.8 } },
      ],
      3,
    );
    assert.equal(clash.collisions, 1);
    assert.ok(clash.index[0] >= 0);
    assert.equal(clash.index[1], -1);
  });

  test('smoke alpha follows the head-height curve', () => {
    const layout = buildRasterLayout([{ id: 'a', simPos: { x: 0, y: 0 } }], 3);
    const out = new Uint8ClampedArray(4);
    for (const d of [0, 0.04, 0.05, 0.2, 0.6, 1]) {
      out.fill(0);
      const states = new Map([['a', { smoke: d }]]);
      writeSmokeRGBA(layout, states, out, headSmoke);
      const expected =
        d >= 0.05 ? Math.round(255 * (0.15 + 0.65 * headSmoke(d))) : 0;
      assert.equal(out[3], expected, `d=${d}`);
    }
    const again = writeSmokeRGBA(layout, new Map([['a', { smoke: 1 }]]), out, headSmoke);
    const third = writeSmokeRGBA(layout, new Map([['a', { smoke: 1 }]]), out, headSmoke);
    assert.ok(again >= 0);
    assert.equal(third, 0);
  });

  test('writers leave frozen state untouched and repeat exactly', () => {
    const { layout } = grid(3, 3, 3);
    const fire = Object.freeze({ state: 'burning' });
    const entry = Object.freeze({ smoke: 0.55, fire });
    const states = new Map<string, { smoke: number; fire: { state: string } }>();
    for (const id of layout.studIds) states.set(id, entry);
    Object.freeze(states);
    const smoke = new Uint8ClampedArray(layout.cols * layout.rows * 4);
    const flames = new Uint8ClampedArray(smoke.length);
    const edges = new Int32Array(layout.cols * layout.rows * 4);
    const pulses = new Int32Array(layout.cols * layout.rows);
    writeSmokeRGBA(layout, states, smoke, headSmoke);
    writeFireRGBA(layout, states, flames);
    dilateEmpty(smoke, layout.cols, layout.rows, layout.occupied);
    const edgeCount = frontCells(layout, states, edges);
    const pulseCount = pulseCells(layout, states, pulses);
    const smokeCopy = Uint8ClampedArray.from(smoke);
    const fireCopy = Uint8ClampedArray.from(flames);
    const edgeCopy = Int32Array.from(edges.subarray(0, edgeCount));
    writeSmokeRGBA(layout, states, smoke, headSmoke);
    writeFireRGBA(layout, states, flames);
    dilateEmpty(smoke, layout.cols, layout.rows, layout.occupied);
    const edgeCount2 = frontCells(layout, states, edges);
    assert.equal(edgeCount2, edgeCount);
    assert.deepEqual(smoke, smokeCopy);
    assert.deepEqual(flames, fireCopy);
    assert.deepEqual(Int32Array.from(edges.subarray(0, edgeCount2)), edgeCopy);
    assert.equal(pulseCount, 0);
    assert.equal(states.get(layout.studIds[0])?.smoke, 0.55);
    assert.equal(states.get(layout.studIds[0])?.fire.state, 'burning');
  });

  test('burning cells on the fire edge are listed, heating cells are the pulse list', () => {
    const { layout } = grid(3, 3, 3);
    const surrounded = stateMap(layout, 'burning');
    const none = frontCells(layout, surrounded, new Int32Array(64));
    assert.equal(none, 0);

    const pair = buildRasterLayout(
      [
        { id: 'burn', simPos: { x: 0, y: 0 } },
        { id: 'cold', simPos: { x: 3, y: 0 } },
      ],
      3,
    );
    const states = new Map([
      ['burn', { smoke: 0, fire: { state: 'burning' } }],
      ['cold', { smoke: 0, fire: { state: 'none' } }],
    ]);
    const edges = new Int32Array(8);
    const count = frontCells(pair, states, edges);
    assert.ok(count >= 1);
    const pixel = pair.index[0];
    let foundEast = false;
    for (let i = 0; i < count; i++) {
      if (edges[i] >> 2 === pixel && (edges[i] & 3) === 0) foundEast = true;
    }
    assert.equal(foundEast, true);

    const heating = new Map([
      ['burn', { smoke: 0, fire: { state: 'heating' } }],
      ['cold', { smoke: 0, fire: { state: 'none' } }],
    ]);
    const pulse = new Int32Array(4);
    assert.equal(frontCells(pair, heating, edges), 0);
    assert.equal(pulseCells(pair, heating, pulse), 1);
    assert.equal(pulse[0], pair.index[0]);
  });

  test('empty cells take half the average neighbour alpha', () => {
    const layout = buildRasterLayout(
      [
        { id: 'l', simPos: { x: 0, y: 0 } },
        { id: 'm', simPos: { x: 3, y: 0 } },
        { id: 'r', simPos: { x: 6, y: 0 } },
      ],
      3,
    );
    const out = new Uint8ClampedArray(layout.cols * layout.rows * 4);
    const left = layout.index[0] * 4;
    const mid = layout.index[1] * 4;
    const right = layout.index[2] * 4;
    out[left] = 10;
    out[left + 1] = 20;
    out[left + 2] = 30;
    out[left + 3] = 200;
    out[right] = 40;
    out[right + 1] = 50;
    out[right + 2] = 60;
    out[right + 3] = 100;
    const occupied = layout.occupied.slice();
    occupied[layout.index[1]] = 0;
    dilateEmpty(out, layout.cols, layout.rows, occupied);
    assert.equal(out[left + 3], 200);
    assert.equal(out[right + 3], 100);
    assert.equal(out[mid + 3], Math.round((200 + 100) / 2 / 2));
    assert.equal(out[mid], Math.round((10 + 40) / 2));
    assert.equal(out[mid + 1], Math.round((20 + 50) / 2));
    assert.equal(out[mid + 2], Math.round((30 + 60) / 2));
  });

  test('ember pool caps, replaces the oldest, and clamps a long frame', () => {
    const pool = new EmberPool(4);
    const rng = () => 0.5;
    for (let i = 0; i < 6; i++) pool.spawn(i, 0, rng);
    assert.equal(pool.aliveCount, 4);
    const xs: number[] = [];
    pool.forEachAlive((slot) => xs.push(pool.x[slot]));
    xs.sort((a, b) => a - b);
    assert.deepEqual(xs, [2, 3, 4, 5]);

    pool.update(5);
    let aged = false;
    pool.forEachAlive((slot) => {
      aged = true;
      assert.ok(Math.abs(pool.age[slot] - 0.1) < 1e-5);
    });
    assert.equal(aged, true);

    const Orig = globalThis.Float32Array;
    let created = 0;
    const Wrapped = new Proxy(Orig, {
      construct(_target, args) {
        created++;
        return Reflect.construct(Orig, args, Orig);
      },
    });
    globalThis.Float32Array = Wrapped as unknown as Float32ArrayConstructor;
    try {
      pool.update(0.016);
      pool.spawn(9, 9, rng);
    } finally {
      globalThis.Float32Array = Orig;
    }
    assert.equal(created, 0);
  });

  test('fixed steps match across frame sizes and drop the overflow', () => {
    const over = (frameMs: number, speed: number) => {
      const acc = createAccumulator();
      let t = 0;
      let steps = 0;
      const frameDt = frameMs / 1000;
      while (t < 1 - 1e-12) {
        const dt = Math.min(frameDt, 1 - t);
        steps += takeSteps(acc, dt, speed, FX.FIXED_DT, FX.MAX_STEPS_PER_FRAME);
        t += dt;
      }
      return steps;
    };
    const slow16 = over(16, 1);
    const slow33 = over(33, 1);
    const fast16 = over(16, 4);
    const fast33 = over(33, 4);
    assert.ok(Math.abs(slow16 - 60) <= 1, `16ms speed 1 → ${slow16}`);
    assert.ok(Math.abs(slow33 - 60) <= 1, `33ms speed 1 → ${slow33}`);
    assert.equal(slow16, slow33);
    assert.ok(Math.abs(fast16 - 240) <= 1, `16ms speed 4 → ${fast16}`);
    assert.ok(Math.abs(fast33 - 240) <= 1, `33ms speed 4 → ${fast33}`);
    assert.equal(fast16, fast33);

    const burst = createAccumulator();
    const taken = takeSteps(burst, 10, 1, FX.FIXED_DT, FX.MAX_STEPS_PER_FRAME);
    assert.equal(taken, FX.MAX_STEPS_PER_FRAME);
    assert.ok(burst.dropped > 0);
    assert.ok(burst.acc < FX.FIXED_DT);
  });

  test('auto-downgrade also trips when the frame interval is slow', () => {
    assert.equal(FX.FRAME_DOWNGRADE_MS, 20);
    assert.equal(shouldAutoDowngrade(FX.AUTO_DOWNGRADE_MS + 0.1, 16), true);
    assert.equal(shouldAutoDowngrade(3.7, FX.FRAME_DOWNGRADE_MS + 0.1, true), true);
    assert.equal(shouldAutoDowngrade(3.7, 30, false), false);
    assert.equal(shouldAutoDowngrade(FX.AUTO_DOWNGRADE_MS, FX.FRAME_DOWNGRADE_MS, true), false);
    assert.equal(shouldAutoDowngrade(3.7, 19.6, true), false);
    let remembered: 'high' | 'low' | 'classic' | null = null;
    remembered = noteDowngradeFrom(remembered, 'high');
    remembered = noteDowngradeFrom(remembered, 'low');
    assert.equal(remembered, 'high');
  });

  test('two frame sizes stop at exactly 180s of evacuation steps', () => {
    const target = Math.round(180 / FX.FIXED_DT);
    assert.equal(target, 10800);
    for (const frameMs of [1000 / 60, 64]) {
      const acc = createAccumulator();
      let done = 0;
      let integrated = 0;
      let spins = 0;
      while (done < target) {
        const room = target - done;
        const need = room * FX.FIXED_DT - acc.acc;
        const dt = Math.min(frameMs / 1000, need > 0 ? need : 0);
        let n = dt > 0 ? takeSteps(acc, dt, 1, FX.FIXED_DT, FX.MAX_STEPS_PER_FRAME) : 0;
        if (n > room) {
          acc.acc += (n - room) * FX.FIXED_DT;
          n = room;
        }
        if (n === 0) break;
        done += n;
        integrated += dt;
        if (++spins > target + 5) break;
      }
      assert.equal(done, target, `${frameMs} ms took ${done}`);
      assert.ok(
        Math.abs(integrated - 180) < FX.FIXED_DT,
        `${frameMs} ms integrated ${integrated}`,
      );
    }
  });

  test('page loop at 16.7ms and 64ms matches when it stops at 10800 steps', () => {
    const target = Math.round(180 / FX.FIXED_DT);
    const run = (frameMs: number) => pageLoopUntil(frameMs, target);
    const fine = run(1000 / 60);
    const coarse = run(64);
    assert.equal(fine.evacSteps, target);
    assert.equal(coarse.evacSteps, target);
    assert.equal(fine.effectSteps, coarse.effectSteps);
    assert.deepEqual(coarse.counters, fine.counters);
  });

  test('noise is deterministic and tiles within one pixel', () => {
    const size = 128;
    const a = makeValueNoiseTexture(size, 7);
    const b = makeValueNoiseTexture(size, 7);
    assert.equal(a.width, size);
    assert.equal(a.height, size);
    assert.deepEqual(a.data, b.data);
    const alpha = (x: number, y: number) => a.data[(y * size + x) * 4 + 3];
    for (let y = 0; y < size; y++) {
      assert.ok(Math.abs(alpha(0, y) - alpha(size - 1, y)) <= 40, `row ${y}`);
    }
    for (let x = 0; x < size; x++) {
      assert.ok(Math.abs(alpha(x, 0) - alpha(x, size - 1)) <= 40, `col ${x}`);
    }
  });
});
