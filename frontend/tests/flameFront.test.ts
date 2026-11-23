import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  FIREBALL_PULSE_S,
  addIgnitionDose,
  fireballFluxKwM2,
  flashoverAgeSec,
  ignitionTimeSec,
  pointSourceFluxKwM2,
  poolFireKwFromDiameter,
  tSquaredKw,
} from '../src/lib/rts/flameFront';
import { FireSimulation } from '../src/lib/rts/fireSimulation';
import { defaultLightFuel, entryById, fuelCellFromEntry } from '../src/lib/rts/materialLibrary';
import type { InteriorWall } from '../src/lib/rts/types';

function close(actual: number, expected: number, label: string) {
  const tol = Math.abs(expected) * 0.01;
  assert.ok(Math.abs(actual - expected) <= tol, `${label}: ${actual} vs ${expected}`);
}

function pair(category: 'light' | 'heavy' = 'light') {
  const light = defaultLightFuel();
  const heavy = fuelCellFromEntry(entryById('cooking_oil')!);
  assert.ok(heavy);
  const cell = category === 'heavy' ? heavy : light;
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
  test('light fuel crosses 3 m at 0.5 m/min and does not jump a gap', () => {
    const sim = pair('light');
    assert.equal(firstBurn(sim, [], 400), 360);

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
    for (let i = 0; i < 800; i++) gapped.step(1, [], []);
    assert.equal(gapped.states.get('tile')?.state, 'none');
    assert.equal(gapped.states.get('c')?.state, 'none');
  });

  test('heavy fuel is faster, and a wall holds the front until flashover plus its rating', () => {
    const open = pair('heavy');
    assert.equal(firstBurn(open, [], 80), 45);

    const oil = fuelCellFromEntry(entryById('cooking_oil')!);
    assert.ok(oil);
    const flash = flashoverAgeSec(oil);
    assert.ok(flash != null && flash > 45, `flashover ${flash} should be after the 45 s front`);

    const concrete = pair('heavy');
    assert.equal(firstBurn(concrete, [wall('concrete', false)], 250), -1);

    const glass = pair('heavy');
    const opened = firstBurn(glass, [wall('glass', false)], 400);
    assert.ok(opened > flash + 120 - 1, `glass opened at ${opened}, flashover ${flash}`);
    assert.ok(opened < flash + 120 + 3, `glass opened at ${opened}, flashover ${flash}`);

    const door = pair('heavy');
    assert.equal(firstBurn(door, [wall('glass', true)], 80), 45);
  });
});
