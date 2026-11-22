import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { headSmoke } from '../src/lib/evacuation/hazardSensing';
import { EmberPool } from '../src/lib/rts/fx/embers';
import { FX } from '../src/lib/rts/fx/fxConstants';
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
