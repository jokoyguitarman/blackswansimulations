import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  CONTENTS_HRRPUA_KW_M2,
  FIREBALL_PULSE_S,
  FLASHOVER_MAX_AREA_M2,
  FLASHOVER_ROOM_KW,
  FRYER_POOL_AREA_M2,
  LOCAL_FLASHOVER_RADIUS_M,
  STUD_AREA_M2,
  addIgnitionDose,
  fireballFluxKwM2,
  flashoverAgeSec,
  heatReleaseKw,
  ignitionTimeSec,
  pointSourceFluxKwM2,
  poolFireKw,
  poolFireKwFromDiameter,
  tSquaredKw,
  type FuelCell,
} from '../src/lib/rts/flameFront';
import { FireSimulation } from '../src/lib/rts/fireSimulation';
import { defaultLightFuel, entryById, fuelCellFromEntry } from '../src/lib/rts/materialLibrary';
import type { InteriorWall } from '../src/lib/rts/types';

function close(actual: number, expected: number, label: string) {
  const tol = Math.abs(expected) * 0.01;
  assert.ok(Math.abs(actual - expected) <= tol, `${label}: ${actual} vs ${expected}`);
}

/** Heavy solid. One pan of oil never reaches the 1 MW room floor, so the wall tests use this. */
function heavySolid(): FuelCell {
  return {
    ...defaultLightFuel(),
    category: 'heavy',
    trp: 80,
    alphaKwS2: 0.0469,
    spreadMPerMin: 4,
    fuelLoadKgM2: 30,
    liquidPool: false,
  };
}

function pair(cell: FuelCell = defaultLightFuel()) {
  const sim = new FireSimulation();
  sim.init([
    { id: 'a', simPos: { x: 0, y: 0 }, spatialContext: 'inside_building' },
    { id: 'b', simPos: { x: 3, y: 0 }, spatialContext: 'inside_building' },
  ]);
  sim.setFuelCells(
    new Map([
      ['a', cell],
      ['b', cell],
    ]),
  );
  sim.ignite(['a']);
  return sim;
}

function firstAgeAt(cell: FuelCell, heatKw: number): number {
  for (let age = 1; age <= 5000; age++) {
    if (heatReleaseKw(cell, age) >= heatKw) return age;
  }
  return -1;
}

function wall(material: string, door: boolean): InteriorWall {
  return {
    id: 'w',
    start: { x: 1.5, y: -2 },
    end: { x: 1.5, y: 2 },
    hasDoor: door,
    doorWidth: door ? 4 : 0.8,
    doorPosition: 0.5,
    description: '',
    material,
    photos: [],
  };
}

function firstBurn(sim: FireSimulation, walls: InteriorWall[], limit: number): number {
  for (let step = 1; step <= limit; step++) {
    sim.step(1, walls, []);
    if (sim.states.get('b')?.state === 'burning') return step;
  }
  return -1;
}

describe('flame front formulas', () => {
  test('red oak ignition time, the point source, and t-squared match the worked examples', () => {
    close(ignitionTimeSec(20, 10, 134) ?? 0, 141, 't_ig at 20');
    close(ignitionTimeSec(12.5, 10, 134) ?? 0, 2256, 't_ig at 12.5');
    assert.equal(ignitionTimeSec(9, 10, 134), null);
    close(pointSourceFluxKwM2(2000, 4), 3.482, 'flux at 4 m');
    close(tSquaredKw(0.0469, 120), 675.4, 'fast t-squared');
    close(poolFireKwFromDiameter(3, 0.055, 43700, 2.1), 16958, 'gasoline pool');

    const light = defaultLightFuel();
    const solid = heavySolid();
    const shop = fuelCellFromEntry(entryById('shop_contents')!);
    const oil = fuelCellFromEntry(entryById('cooking_oil')!);
    assert.ok(oil);
    assert.ok(shop);
    assert.equal(heatReleaseKw(light, 2000), CONTENTS_HRRPUA_KW_M2 * STUD_AREA_M2);
    assert.equal(heatReleaseKw(solid, 2000), CONTENTS_HRRPUA_KW_M2 * STUD_AREA_M2);
    assert.equal(heatReleaseKw(shop, 600), CONTENTS_HRRPUA_KW_M2 * STUD_AREA_M2);
    assert.ok(tSquaredKw(light.alphaKwS2, 2000) > CONTENTS_HRRPUA_KW_M2 * STUD_AREA_M2);
    assert.ok(tSquaredKw(shop.alphaKwS2, 600) > CONTENTS_HRRPUA_KW_M2 * STUD_AREA_M2);
    close(heatReleaseKw(oil, 10000), poolFireKw(FRYER_POOL_AREA_M2), 'fryer pan');
    close(LOCAL_FLASHOVER_RADIUS_M, 12.6, '500 m² disc');
    assert.ok(poolFireKw(FRYER_POOL_AREA_M2) < FLASHOVER_ROOM_KW);
    const alone = flashoverAgeSec(light);
    assert.ok(alone != null && alone > 250, `one light stud reaches 1 MW at ${alone}`);
    assert.equal(flashoverAgeSec(oil), null);

    let dose = 0;
    for (let i = 0; i < 141; i++) dose = addIgnitionDose(dose, 20, 10, 134, 1);
    assert.ok(dose >= 0.99 && dose <= 1.02, `dose ${dose}`);
    assert.equal(addIgnitionDose(0.4, 9, 10, 134, 1000), 0.4);

    const edge = fireballFluxKwM2(8, 8);
    const tig = ignitionTimeSec(edge, 10, 134);
    assert.ok(tig != null);
    close(FIREBALL_PULSE_S / tig, 1, 'fireball dose at the radius');
  });
});

describe('flame front movement', () => {
  test('light fuel crosses a door at 0.5 m/min, and an open room flashes first', () => {
    const throughDoor = pair();
    assert.equal(firstBurn(throughDoor, [wall('drywall', true)], 400), 360);

    const open = pair();
    const flash = firstAgeAt(defaultLightFuel(), FLASHOVER_ROOM_KW);
    assert.equal(firstBurn(open, [], 400), flash);
    assert.ok(flash < 360);

    const gapped = new FireSimulation();
    gapped.init([
      { id: 'a', simPos: { x: 0, y: 0 }, spatialContext: 'inside_building' },
      { id: 'tile', simPos: { x: 3, y: 0 }, spatialContext: 'inside_building' },
      { id: 'c', simPos: { x: 6, y: 0 }, spatialContext: 'inside_building' },
    ]);
    const light = defaultLightFuel();
    gapped.setFuelCells(
      new Map([
        ['a', light],
        ['c', light],
      ]),
    );
    gapped.ignite(['a']);
    for (let i = 0; i < 250; i++) gapped.step(1, [], []);
    assert.equal(gapped.states.get('tile')?.state, 'none');
    assert.equal(gapped.states.get('c')?.state, 'none');
    for (let i = 0; i < 150; i++) gapped.step(1, [], []);
    assert.equal(gapped.states.get('tile')?.state, 'none');
    assert.equal(gapped.states.get('c')?.state, 'burning');
  });

  test('a small light fire does not start a drywall timer, and the room then lights its own fuel', () => {
    const light = defaultLightFuel();
    const sim = new FireSimulation();
    sim.init([
      { id: 'a', simPos: { x: 0, y: 0 }, spatialContext: 'inside_building' },
      { id: 'near', simPos: { x: 0, y: 3 }, spatialContext: 'inside_building' },
      { id: 'far', simPos: { x: 3, y: 0 }, spatialContext: 'inside_building' },
    ]);
    sim.setFuelCells(
      new Map([
        ['a', light],
        ['near', light],
        ['far', light],
      ]),
    );
    sim.ignite(['a']);
    const drywall = wall('drywall', false);
    for (let i = 0; i < 250; i++) sim.step(1, [drywall], []);
    assert.equal(sim.wallBreachTimers.size, 0);
    assert.notEqual(sim.states.get('near')?.state, 'burning');
    assert.equal(sim.states.get('far')?.state, 'none');

    const flash = firstAgeAt(light, FLASHOVER_ROOM_KW);
    for (let i = 250; i < flash; i++) sim.step(1, [drywall], []);
    assert.equal(sim.states.get('near')?.state, 'burning');
    assert.equal(sim.states.get('far')?.state, 'none');
    assert.ok((sim.wallBreachTimers.get('a->far') ?? 0) > 0);
    assert.ok((sim.wallBreachTimers.get('a->far') ?? 0) < 5);
  });

  test('heavy fuel crosses a door at 4 m/min, and a wall waits for the room', () => {
    const solid = heavySolid();
    const door = pair(solid);
    assert.equal(firstBurn(door, [wall('glass', true)], 80), 45);

    const concrete = pair(solid);
    assert.equal(firstBurn(concrete, [wall('concrete', false)], 400), -1);

    const glass = pair(solid);
    const flash = firstAgeAt(solid, FLASHOVER_ROOM_KW);
    const opened = firstBurn(glass, [wall('glass', false)], 400);
    assert.equal(opened, flash + 119);

    const oil = fuelCellFromEntry(entryById('cooking_oil')!);
    assert.ok(oil);
    const pan = pair(oil);
    assert.equal(firstBurn(pan, [wall('glass', false)], 400), -1);
    assert.equal(pan.wallBreachTimers.size, 0);
  });

  test('a 2400 m² room does not flash over, and the barrier waits for the local disc', () => {
    const cols = 20;
    const rows = 14;
    const sim = new FireSimulation();
    const studs = [];
    for (let ix = 0; ix < cols; ix++) {
      for (let iy = 0; iy < rows; iy++) {
        studs.push({
          id: `s${ix}_${iy}`,
          simPos: { x: ix * 3, y: iy * 3 },
          spatialContext: 'inside_building' as const,
        });
      }
    }
    studs.push({ id: 'out', simPos: { x: -3, y: 0 }, spatialContext: 'inside_building' as const });
    sim.init(studs);
    const solid = heavySolid();
    assert.ok((cols * rows) * STUD_AREA_M2 > 2400);
    assert.ok((cols * rows) * STUD_AREA_M2 > FLASHOVER_MAX_AREA_M2);
    // Tile fills the floor. Only the source, one far shop stud, and the stud
    // beyond the wall are fuel, so a whole-room flash would light the far stud.
    sim.setFuelCells(new Map([
      ['s0_0', solid],
      ['s19_13', solid],
      ['out', solid],
    ]));
    sim.ignite(['s0_0']);
    const barrier = wall('drywall', false);
    barrier.start = { x: -1.5, y: -6 };
    barrier.end = { x: -1.5, y: 48 };
    const flash = firstAgeAt(solid, FLASHOVER_ROOM_KW);
    for (let i = 0; i < flash - 1; i++) sim.step(1, [barrier], []);
    assert.equal(sim.wallBreachTimers.size, 0);
    sim.step(1, [barrier], []);
    assert.ok((sim.wallBreachTimers.get('s0_0->out') ?? 0) > 0);
    assert.ok((sim.wallBreachTimers.get('s0_0->out') ?? 0) < 5);
    assert.equal(sim.states.get('out')?.state, 'none');
    assert.equal(sim.states.get('s19_13')?.state, 'none');
    assert.equal(sim.states.get('s0_0')?.state, 'burning');
  });

  test('a 9-stud shop flashes over at 1 MW, and the far shop stays dark', () => {
    const sim = new FireSimulation();
    const studs: { id: string; simPos: { x: number; y: number }; spatialContext: 'inside_building' }[] = [];
    const fuel: string[] = [];
    for (let ix = 0; ix < 3; ix++) {
      for (let iy = 0; iy < 3; iy++) {
        const near = `near_${ix}_${iy}`;
        const far = `far_${ix}_${iy}`;
        studs.push({ id: near, simPos: { x: ix * 3, y: iy * 3 }, spatialContext: 'inside_building' });
        studs.push({ id: far, simPos: { x: 21 + ix * 3, y: iy * 3 }, spatialContext: 'inside_building' });
        fuel.push(near, far);
      }
    }
    for (const x of [12, 15]) {
      for (let iy = 0; iy < 3; iy++) {
        studs.push({
          id: `tile_${x}_${iy}`,
          simPos: { x, y: iy * 3 },
          spatialContext: 'inside_building',
        });
      }
    }
    sim.init(studs);
    const solid = heavySolid();
    sim.setFuelCells(new Map(fuel.map((id) => [id, solid])));
    sim.ignite(['near_0_0']);
    const door = wall('drywall', true);
    door.start = { x: 7.5, y: -3 };
    door.end = { x: 7.5, y: 9 };
    const flash = firstAgeAt(solid, FLASHOVER_ROOM_KW);
    for (let i = 0; i < flash; i++) sim.step(1, [door], []);
    for (let ix = 0; ix < 3; ix++) {
      for (let iy = 0; iy < 3; iy++) {
        assert.equal(sim.states.get(`near_${ix}_${iy}`)?.state, 'burning');
        assert.equal(sim.states.get(`far_${ix}_${iy}`)?.state, 'none');
      }
    }
    for (let i = 0; i < 200; i++) sim.step(1, [door], []);
    assert.equal(sim.states.get('far_1_1')?.state, 'none');
    assert.equal(sim.states.get('tile_12_1')?.state, 'none');
  });
});
