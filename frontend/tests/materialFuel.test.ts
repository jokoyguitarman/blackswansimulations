import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { FireSimulation, DEFAULT_FIRE_PARAMS } from '../src/lib/rts/fireSimulation';
import { SpatialEffectsEngine } from '../src/lib/rts/spatialEffects';
import {
  COMMON_PICKS,
  confirmedFuelStudIds,
  entryById,
  matchMaterials,
  type PlacedObject,
} from '../src/lib/rts/materialLibrary';

function object(partial: Partial<PlacedObject> & Pick<PlacedObject, 'matches' | 'confirmed'>): PlacedObject {
  return {
    id: 'obj-1',
    studId: 'stud-a',
    pos: { x: 0, y: 0 },
    level: 'G',
    description: '',
    ...partial,
  };
}

describe('material library', () => {
  test('wooden table with steel legs matches wood and steel, and the wood burns', () => {
    let suggestions = 0;
    const matches = matchMaterials('wooden table, steel legs', {
      suggest: () => {
        suggestions += 1;
        return 'cooking_oil';
      },
    });
    assert.deepEqual(
      matches.map((match) => match.entryId),
      ['wood', 'steel'],
    );
    assert.equal(suggestions, 0);
    assert.equal(matches[0]?.fuel, 'light');
    assert.equal(matches[1]?.fuel, 'non_combustible');

    const placed = object({
      description: 'wooden table, steel legs',
      matches,
      confirmed: true,
    });
    assert.deepEqual([...confirmedFuelStudIds([placed])], ['stud-a']);
  });

  test('a common pick is a library entry and still needs confirm', () => {
    const pick = COMMON_PICKS.find((item) => item.label === 'Wooden table');
    assert.ok(pick);
    const entry = entryById(pick.entryId);
    assert.equal(entry?.label, 'Wood');
    const matches = matchMaterials(pick.label);
    assert.equal(matches[0]?.entryId, 'wood');
    const placed = object({ description: pick.label, matches, confirmed: false });
    assert.equal(confirmedFuelStudIds([placed]).size, 0);
  });

  test('keywords miss, an AI suggestion is only a match to confirm', () => {
    const silent = matchMaterials('mystery sculpture');
    assert.deepEqual(silent, []);

    const suggested = matchMaterials('mystery sculpture', { suggest: () => 'foam' });
    assert.equal(suggested.length, 1);
    assert.equal(suggested[0]?.source, 'ai');
    assert.equal(suggested[0]?.entryId, 'foam');
    assert.equal(
      confirmedFuelStudIds([
        object({ matches: suggested, confirmed: false, studId: 'stud-b' }),
      ]).size,
      0,
    );
  });

  test('confirmed tile does not fuel the stud', () => {
    const matches = matchMaterials('ceramic tile');
    assert.equal(matches[0]?.entryId, 'ceramic_tile');
    assert.equal(matches[0]?.fuel, 'non_combustible');
    assert.equal(
      confirmedFuelStudIds([object({ matches, confirmed: true })]).size,
      0,
    );
  });

  test('stored light and heavy numbers stay on the row', () => {
    const wood = entryById('wood');
    const oil = entryById('cooking_oil');
    assert.equal(wood?.chfKwM2, 10);
    assert.equal(wood?.trp, 134);
    assert.equal(wood?.alphaKwS2, 0.01172);
    assert.equal(wood?.spreadMPerMin, 0.5);
    assert.equal(wood?.fuelLoadKgM2, 10);
    assert.deepEqual(wood?.toxicProducts, ['CO']);
    assert.equal(oil?.fuel, 'heavy');
    assert.equal(oil?.alphaKwS2, 0.0469);
    assert.equal(oil?.spreadMPerMin, 4);
    assert.equal(oil?.liquidPool, true);
    assert.deepEqual(oil?.toxicProducts, ['acrolein']);
  });
});

const descriptions = {
  initial: '',
  triggered: '',
  worsening: '',
  critical: '',
};

function blastEngine(fuel: Set<string> | null) {
  const engine = new SpatialEffectsEngine(
    { ...DEFAULT_FIRE_PARAMS, ambientSpread: true, ambientHeatSec: 30 },
    1,
  );
  engine.init([
    { id: 'tile', simPos: { x: 0, y: 0 }, spatialContext: 'inside_building' },
    { id: 'table', simPos: { x: 3, y: 0 }, spatialContext: 'inside_building' },
    { id: 'next', simPos: { x: 3, y: 6 }, spatialContext: 'inside_building' },
  ]);
  if (fuel) engine.setFuelStuds(fuel);
  engine.registerHazard(
    'blast-direct',
    [
      {
        triggerTimeSec: 0,
        eventType: 'explode',
        spreadType: 'fire',
        spreadRadius: 4,
        spreadRate: 10,
        description: 'Direct blast ignition',
        severity: 'critical',
      },
    ],
    descriptions,
  );
  const zone = {
    id: 'blast-direct',
    pos: { x: 0, y: 0 },
    radius: 4,
    hazardType: 'ignitable' as const,
    severity: 'critical' as const,
    label: 'Blast',
    description: '',
    photos: [] as string[],
  };
  return { engine, zone };
}

describe('confirmed fuel gate', () => {
  test('an empty fuel set keeps the tile and the table dark', () => {
    const { engine, zone } = blastEngine(new Set());
    engine.step(0.1, [], [zone]);
    assert.equal(engine.studStates.get('tile')?.fire.state, 'none');
    assert.equal(engine.studStates.get('table')?.fire.state, 'none');
  });

  test('a blast lights a confirmed table and leaves the bare tile dark', () => {
    const { engine, zone } = blastEngine(new Set(['table', 'next']));
    engine.step(0.1, [], [zone]);
    assert.equal(engine.studStates.get('tile')?.fire.state, 'none');
    assert.equal(engine.studStates.get('table')?.fire.state, 'burning');
    assert.equal(engine.studStates.get('next')?.fire.state, 'heating');

    engine.step(30, [], [zone]);
    assert.equal(engine.studStates.get('tile')?.fire.state, 'none');
    assert.equal(engine.studStates.get('next')?.fire.state, 'burning');
  });

  test('without a fuel set the old blast still lights every stud in the radius', () => {
    const { engine, zone } = blastEngine(null);
    engine.step(0.1, [], [zone]);
    assert.equal(engine.studStates.get('tile')?.fire.state, 'burning');
    assert.equal(engine.studStates.get('table')?.fire.state, 'burning');
  });

  test('igniteRadius on the fire sim refuses a stud that is not confirmed fuel', () => {
    const sim = new FireSimulation({
      ...DEFAULT_FIRE_PARAMS,
      ambientSpread: true,
      ambientHeatSec: 30,
    });
    sim.init([
      { id: 'open', simPos: { x: 0, y: 0 }, spatialContext: 'inside_building' },
      { id: 'wood', simPos: { x: 3, y: 0 }, spatialContext: 'inside_building' },
    ]);
    sim.setFuelStuds(new Set(['wood']));
    sim.igniteRadius({ x: 0, y: 0 }, 8);
    assert.equal(sim.states.get('open')?.state, 'none');
    assert.equal(sim.states.get('wood')?.state, 'burning');
    sim.step(5, [], []);
    assert.equal(sim.states.get('open')?.state, 'none');
  });
});
