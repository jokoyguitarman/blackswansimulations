import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  CONTENTS_HRRPUA_KW_M2,
  FIREBALL_PULSE_S,
  FLASHOVER_ROOM_KW,
  FRYER_POOL_AREA_M2,
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
    const oil = fuelCellFromEntry(entryById('cooking_oil')!);
    assert.ok(oil);
    assert.equal(heatReleaseKw(light, 2000), CONTENTS_HRRPUA_KW_M2 * STUD_AREA_M2);
    assert.ok(tSquaredKw(light.alphaKwS2, 2000) > CONTENTS_HRRPUA_KW_M2 * STUD_AREA_M2);
    close(heatReleaseKw(oil, 10000), poolFireKw(FRYER_POOL_AREA_M2), 'fryer pan');
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
});
