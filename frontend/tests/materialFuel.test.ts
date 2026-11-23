import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { FireSimulation, DEFAULT_FIRE_PARAMS } from '../src/lib/rts/fireSimulation';
import { SpatialEffectsEngine } from '../src/lib/rts/spatialEffects';
import {
  COMMON_PICKS,
  absorbLegacyFuelCircles,
  confirmedFuelStudIds,
  entryById,
  matchMaterials,
  snapObjectsToStuds,
  type PlacedObject,
} from '../src/lib/rts/materialLibrary';
import { blastSmokeStudIds } from '../src/lib/rts/spatialEffects';
import { foodCourtPlacedObjects, foodCourtSample } from '../src/lib/rts/foodCourtSample';
import { generateSceneStuds, projectSceneStuds } from '../src/lib/rts/sceneStuds';

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

  test('plural keywords match, and a bare plural does not invent a material', () => {
    assert.equal(matchMaterials('tiles')[0]?.entryId, 'ceramic_tile');
    assert.equal(matchMaterials('cushions')[0]?.entryId, 'foam');
    assert.equal(matchMaterials('fryers')[0]?.entryId, 'cooking_oil');
    assert.equal(matchMaterials('cables')[0]?.entryId, 'electrical');
    assert.equal(matchMaterials('gas')[0]?.entryId, 'gas_line');
    assert.equal(matchMaterials('gases')[0]?.entryId, 'gas_line');
    assert.deepEqual(matchMaterials('tables'), []);
    assert.equal(matchMaterials('wooden tables')[0]?.entryId, 'wood');
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
    { id: 'next', simPos: { x: 6, y: 0 }, spatialContext: 'inside_building' },
    { id: 'yard', simPos: { x: 1, y: 0 }, spatialContext: 'open_air' },
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

function smokeBlast(fuel: Set<string> | null): Map<string, number> {
  const engine = new SpatialEffectsEngine({ ...DEFAULT_FIRE_PARAMS }, 1);
  engine.init([
    { id: 'tile', simPos: { x: 0, y: 0 }, spatialContext: 'inside_building' },
    { id: 'table', simPos: { x: 30, y: 0 }, spatialContext: 'inside_building' },
  ]);
  if (fuel) engine.setFuelStuds(fuel);
  engine.registerHazard(
    'blast-direct',
    [
      {
        triggerTimeSec: 0,
        eventType: 'explode',
        spreadType: null,
        spreadRadius: 0,
        spreadRate: 0,
        description: 'Direct blast ignition',
        severity: 'critical',
        smokeGeneration: 'heavy',
        affectedStuds: ['tile', 'table'],
      },
    ],
    descriptions,
  );
  engine.step(10, [], []);
  return new Map(
    ['tile', 'table'].map((id) => [id, engine.studStates.get(id)?.smoke ?? 0]),
  );
}

describe('legacy circles become objects', () => {
  test('combustible and ignitable circles are unconfirmed guesses, and other circles stay', () => {
    const absorbed = absorbLegacyFuelCircles([
      {
        id: 'blast-direct',
        pos: { x: 0, y: 0 },
        hazardType: 'ignitable',
        description: 'Direct blast ignition',
      },
      {
        id: 'tables',
        pos: { x: 1, y: 2 },
        hazardType: 'combustible',
        description: 'Wooden table tops, steel frames',
        level: 'G',
      },
      {
        id: 'blank',
        pos: { x: 4, y: 4 },
        hazardType: 'ignitable',
        label: 'Ignitable',
      },
      {
        id: 'power',
        pos: { x: 8, y: 8 },
        hazardType: 'electrical',
        description: 'Socket and cable',
      },
    ]);
    assert.deepEqual(
      absorbed.zones.map((zone) => zone.id),
      ['blast-direct', 'power'],
    );
    assert.equal(absorbed.objects.length, 2);
    assert.equal(absorbed.objects.every((obj) => obj.confirmed), false);
    const table = absorbed.objects.find((obj) => obj.id === 'legacy-tables');
    assert.deepEqual(
      table?.matches.map((match) => match.entryId),
      ['wood', 'steel'],
    );
    assert.equal(absorbed.objects.find((obj) => obj.id === 'legacy-blank')?.matches[0]?.entryId, 'wood');
    assert.equal(confirmedFuelStudIds(absorbed.objects).size, 0);
  });

  test('a converted circle fuels every stud inside its old radius', () => {
    const absorbed = absorbLegacyFuelCircles(
      [
        {
          id: 'tables',
          pos: { x: 0, y: 0 },
          radius: 3,
          hazardType: 'combustible',
          description: 'Wooden table tops',
        },
        {
          id: 'gas',
          pos: { x: 20, y: 0 },
          radius: 5,
          hazardType: 'ignitable',
          description: 'Gas line',
        },
      ],
      [],
      { confirmed: true },
    );
    const studs = [
      { id: 'c', simPos: { x: 0, y: 0 }, level: 'G' },
      { id: 'e', simPos: { x: 3, y: 0 }, level: 'G' },
      { id: 'far', simPos: { x: 6, y: 0 }, level: 'G' },
      { id: 'up', simPos: { x: 0, y: 0 }, level: 'L1' },
      { id: 'gas', simPos: { x: 20, y: 0 }, level: 'G' },
    ];
    const fuel = confirmedFuelStudIds(absorbed.objects, studs);
    assert.equal(fuel.has('c'), true);
    assert.equal(fuel.has('e'), true);
    assert.equal(fuel.has('far'), false);
    assert.equal(fuel.has('up'), false);
    assert.equal(fuel.has('gas'), false);
  });

  test('the food court ships confirmed, and the open tile is not fuel', () => {
    const polygon = foodCourtSample.scene.buildingPolygon.map(
      (pair) => [pair[0], pair[1]] as [number, number],
    );
    const studs = projectSceneStuds(polygon, generateSceneStuds(polygon, 0, ['G']));
    const placed = snapObjectsToStuds(
      foodCourtPlacedObjects(),
      studs.map((stud) => ({ id: stud.id, simPos: stud.simPos, level: stud.floor })),
    );
    assert.equal(placed.length, 7);
    assert.equal(placed.every((obj) => obj.confirmed && obj.studId), true);
    const fuel = confirmedFuelStudIds(
      placed,
      studs.map((stud) => ({ id: stud.id, simPos: stud.simPos, level: stud.floor })),
    );
    const fryer = placed.find((obj) => obj.id === 'legacy-hz-gas-fryer');
    const noodle = placed.find((obj) => obj.id === 'legacy-hz-gas-noodle');
    const table = placed.find((obj) => obj.id === 'legacy-hz-tables-mid');
    assert.ok(fryer && fuel.has(fryer.studId));
    assert.ok(table && table.coverCenter && table.coverRadiusM === 3);
    assert.deepEqual(table.coverCenter, { x: 0.5, y: 0.5 });
    const tableStuds = studs.filter(
      (stud) =>
        (stud.floor || 'G') === (table.level || 'G') &&
        Math.hypot(stud.simPos.x - table.coverCenter.x, stud.simPos.y - table.coverCenter.y) <=
          table.coverRadiusM + 1e-6,
    );
    assert.ok(tableStuds.length >= 1);
    for (const stud of tableStuds) assert.equal(fuel.has(stud.id), true);
    assert.ok(noodle && noodle.coverCenter && noodle.coverRadiusM === 2);
    const noodleStuds = studs.filter(
      (stud) =>
        Math.hypot(stud.simPos.x - noodle.coverCenter.x, stud.simPos.y - noodle.coverCenter.y) <=
        noodle.coverRadiusM + 1e-6,
    );
    for (const stud of noodleStuds) assert.equal(fuel.has(stud.id), false);
    assert.equal(fuel.has(noodle.studId), false);
    assert.deepEqual(
      noodle.matches.map((match) => match.entryId),
      ['gas_line'],
    );
    const tile = studs.find((stud) => stud.id === nearestId(studs, 0.5, 9.5));
    assert.ok(tile);
    assert.equal(fuel.has(tile.id), false);
    assert.equal(tile.spatialContext, 'inside_building');
  });
});

function nearestId(
  studs: readonly { id: string; simPos: { x: number; y: number } }[],
  x: number,
  y: number,
): string {
  let best = studs[0];
  let bestDist = Infinity;
  for (const stud of studs) {
    const dist = Math.hypot(stud.simPos.x - x, stud.simPos.y - y);
    if (dist < bestDist) {
      bestDist = dist;
      best = stud;
    }
  }
  return best?.id ?? '';
}

describe('confirmed fuel gate', () => {
  test('an empty fuel set keeps the tile and the table dark', () => {
    const { engine, zone } = blastEngine(new Set());
    engine.step(0.1, [], [zone]);
    assert.equal(engine.studStates.get('tile')?.fire.state, 'none');
    assert.equal(engine.studStates.get('table')?.fire.state, 'none');
  });

  test('a blast lights a confirmed table and the front then crosses to the next fuel stud', () => {
    const { engine, zone } = blastEngine(new Set(['table', 'next']));
    engine.step(0.1, [], [zone]);
    assert.equal(engine.studStates.get('tile')?.fire.state, 'none');
    assert.equal(engine.studStates.get('yard')?.fire.state, 'none');
    assert.equal(engine.studStates.get('table')?.fire.state, 'burning');
    assert.notEqual(engine.studStates.get('next')?.fire.state, 'burning');

    let seconds = 0.1;
    while (engine.studStates.get('next')?.fire.state !== 'burning' && seconds < 400) {
      engine.step(1, [], [zone]);
      seconds += 1;
    }
    assert.ok(seconds > 350 && seconds < 370, `front arrived in ${seconds}s`);
    assert.equal(engine.studStates.get('tile')?.fire.state, 'none');
    assert.equal(engine.studStates.get('yard')?.fire.state, 'none');
  });

  test('without a fuel set the blast lights indoor studs and leaves the yard dark', () => {
    const { engine, zone } = blastEngine(null);
    engine.step(0.1, [], [zone]);
    assert.equal(engine.studStates.get('tile')?.fire.state, 'burning');
    assert.equal(engine.studStates.get('table')?.fire.state, 'burning');
    assert.equal(engine.studStates.get('yard')?.fire.state, 'none');
  });

  test('blast smoke builds on fuel and stays off open tile', () => {
    const smoked = smokeBlast(new Set(['table']));
    assert.equal(smoked.get('tile'), 0);
    assert.ok((smoked.get('table') ?? 0) > 0.05);

    const legacy = smokeBlast(null);
    assert.ok((legacy.get('tile') ?? 0) > 0.05);

    const empty = smokeBlast(new Set());
    assert.equal(empty.get('tile'), 0);
    assert.equal(empty.get('table'), 0);
    assert.deepEqual(blastSmokeStudIds(['tile', 'table'], new Set()), []);
    assert.deepEqual(blastSmokeStudIds(['tile', 'table'], null), ['tile', 'table']);
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
