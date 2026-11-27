import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { WOOD_HEAT_KJ_KG, flashoverAgeSec } from '../src/lib/rts/flameFront';
import { ignitionOxygenY, oxygenAllowsFlame } from '../src/lib/rts/twoZone';
import { FireSimulation, DEFAULT_FIRE_PARAMS } from '../src/lib/rts/fireSimulation';
import { SpatialEffectsEngine } from '../src/lib/rts/spatialEffects';
import {
  COMMON_PICKS,
  MATERIAL_LIBRARY,
  SHOP_STOCK_MIX,
  WALL_MATERIALS,
  absorbLegacyFuelCircles,
  confirmedFuelStudIds,
  defaultLightFuel,
  entryById,
  matchMaterials,
  snapObjectsToStuds,
  layerLiningFor,
  wallMaterialFor,
  type MaterialEntry,
  type MaterialField,
  type PlacedObject,
  type ToxicProduct,
} from '../src/lib/rts/materialLibrary';
import { blastSmokeStudIds } from '../src/lib/rts/spatialEffects';
import { foodCourtPlacedObjects, foodCourtSample } from '../src/lib/rts/foodCourtSample';
import { generateSceneStuds, projectSceneStuds } from '../src/lib/rts/sceneStuds';

function object(
  partial: Partial<PlacedObject> & Pick<PlacedObject, 'matches' | 'confirmed'>,
): PlacedObject {
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
      confirmedFuelStudIds([object({ matches: suggested, confirmed: false, studId: 'stud-b' })])
        .size,
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
    assert.equal(confirmedFuelStudIds([object({ matches, confirmed: true })]).size, 0);
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
    const shop = entryById('shop_contents');
    assert.equal(shop?.fuel, 'heavy');
    assert.equal(shop?.liquidPool, false);
    assert.equal(shop?.spreadMPerMin, 4);
    assert.deepEqual(oil?.toxicProducts, ['acrolein']);
  });

  test('every number on a row carries a source', () => {
    const has = (entry: MaterialEntry, field: MaterialField) => {
      const note = entry.sources[field];
      assert.ok(note && note.ref.trim().length > 0, `${entry.id} ${field} has no source`);
    };
    for (const entry of MATERIAL_LIBRARY) {
      if (entry.heatOfCombustionMjKg != null) has(entry, 'heatOfCombustion');
      if (entry.effectiveHeatOfCombustionMjKg != null) has(entry, 'effectiveHeatOfCombustion');
      if (entry.sootYieldGPerG != null) has(entry, 'sootYield');
      if (entry.sootYieldUnderVentGPerG != null) has(entry, 'sootYieldUnderVent');
      for (const gas of Object.keys(entry.toxicYieldWellVentGPerG) as ToxicProduct[]) {
        has(entry, `wellVent.${gas}`);
      }
      for (const gas of Object.keys(entry.toxicYieldGPerG) as ToxicProduct[]) {
        has(entry, `underVent.${gas}`);
      }
      if (entry.chfKwM2 != null || entry.trp != null) has(entry, 'ignition');
      if (entry.alphaKwS2 != null) has(entry, 'growth');
      if (entry.spreadMPerMin != null) has(entry, 'spread');
      if (entry.fireLoadMjM2 != null) has(entry, 'fireLoad');
      if (entry.fuelLoadKgM2 != null) has(entry, 'fuelLoad');
      if (entry.liquidPool) has(entry, 'pool');
      if (entry.fuel === 'non_combustible') assert.deepEqual(entry.sources, {}, entry.id);
    }
    for (const row of WALL_MATERIALS) {
      for (const field of ['conductivity', 'density', 'specificHeat', 'thickness'] as const) {
        assert.ok(row.sources[field]?.ref.trim(), `${row.id} ${field} has no source`);
      }
      assert.equal(
        row.sources.thickness.status,
        'assumed',
        `${row.id} thickness is the building's`,
      );
    }
  });

  test('a solid releases its cited fire load at the wood heat the front burns', () => {
    const shop = entryById('shop_contents');
    assert.ok(shop?.fuelLoadKgM2 != null && shop.fireLoadMjM2 === 600);
    assert.ok(Math.abs((shop.fuelLoadKgM2 * WOOD_HEAT_KJ_KG) / 1000 - 600) < 1e-9);
    assert.ok(Math.abs(shop.fuelLoadKgM2 - 34.29) < 0.01);
    assert.equal(shop.sources.fireLoad?.status, 'cited');
    assert.equal(entryById('wood')?.sources.fuelLoad?.status, 'assumed');
  });

  test('wall rows match the interior-wall materials, and the seeded rows keep their thermal inertia', () => {
    assert.equal(wallMaterialFor('concrete')?.id, 'concrete');
    assert.equal(wallMaterialFor('Reinforced concrete')?.id, 'concrete');
    assert.equal(wallMaterialFor('aerated concrete')?.id, 'aerated_concrete');
    assert.equal(wallMaterialFor('drywall')?.id, 'gypsum');
    assert.equal(wallMaterialFor('steel')?.id, 'steel');
    assert.equal(wallMaterialFor('window')?.id, 'glass');
    assert.equal(wallMaterialFor(''), null);
    assert.equal(wallMaterialFor('mystery'), null);
    const inertia = (id: string) => {
      const row = WALL_MATERIALS.find((item) => item.id === id);
      assert.ok(row);
      return (row.conductivityWMK * row.densityKgM3 * row.specificHeatJKgK) / 1e6;
    };
    assert.ok(Math.abs(inertia('concrete') - 2.9) < 1e-9);
    assert.ok(Math.abs(inertia('brick_block') - 1.2) < 1e-9);
    assert.ok(Math.abs(inertia('gypsum') - 0.18) < 1e-9);
    assert.ok(Math.abs(inertia('aerated_concrete') - 0.12) < 1e-9);
  });

  test('the smoke layer conducts timber and glass as themselves, and concrete for a finish', () => {
    assert.equal(layerLiningFor('concrete').thicknessM, 0.15);
    assert.equal(layerLiningFor('brick').thicknessM, 0.15);
    assert.equal(layerLiningFor('concrete block').id, 'brick_block');
    assert.equal(layerLiningFor('drywall').thicknessM, 0.016);
    assert.equal(layerLiningFor('plaster').id, 'gypsum');
    assert.equal(layerLiningFor('timber').id, 'timber');
    assert.equal(layerLiningFor('plywood').thicknessM, 0.018);
    assert.equal(layerLiningFor('glass').id, 'glass');
    assert.equal(layerLiningFor('window').thicknessM, 0.006);
    for (const other of ['steel', 'aluminium', 'aerated concrete', '', 'mystery']) {
      assert.equal(layerLiningFor(other).id, 'concrete', other);
    }
  });

  test('runtime yields are measured rows, not the C/VM2 design values', () => {
    const near = (actual: number | undefined, expected: number, label: string) =>
      assert.ok(Math.abs((actual ?? NaN) - expected) < 1e-6, `${label} ${actual} vs ${expected}`);
    for (const id of ['wood', 'paper', 'pvc', 'wet_market']) {
      assert.equal(entryById(id)?.toxicYieldGPerG.CO, 0.2, id);
    }
    const foam = entryById('foam');
    near(foam?.toxicYieldGPerG.CO, 0.28, 'foam under-vent CO');
    near(foam?.toxicYieldGPerG.HCN, 0.009, 'foam under-vent HCN');
    near(foam?.toxicYieldWellVentGPerG.HCN, 0.004, 'foam well-vent HCN');

    const market = entryById('wet_market');
    assert.ok(market);
    near(market.sootYieldGPerG ?? undefined, 0.037, 'market soot');
    near(market.toxicYieldWellVentGPerG.CO, 0.014, 'market CO');
    assert.equal(market.toxicYieldGPerG.HCN, undefined);
    assert.equal(market.sources.sootYield?.status, 'derived');

    const shop = entryById('shop_contents');
    assert.ok(shop);
    assert.equal(
      SHOP_STOCK_MIX.reduce((sum, part) => sum + part.massFraction, 0),
      1,
    );
    near(shop.sootYieldGPerG ?? undefined, 0.06625, 'shop soot');
    near(shop.toxicYieldWellVentGPerG.CO, 0.0175, 'shop well-vent CO');
    near(shop.toxicYieldGPerG.CO, 0.222, 'shop under-vent CO');
    // 20 % foam at 0.009, 10 % nylon at 0.06, 5 % wool at 1.928 × 0.1325 × 0.15.
    near(
      shop.toxicYieldGPerG.HCN,
      0.2 * 0.009 + 0.1 * 0.06 + 0.05 * 1.928 * 0.1325 * 0.15,
      'shop HCN',
    );
    near(
      shop.toxicYieldWellVentGPerG.HCN,
      0.2 * 0.004 + 0.1 * 0.001 + 0.05 * 1.928 * 0.1325 * 0.01,
      'shop well-vent HCN',
    );
    assert.equal(shop.sources['underVent.HCN']?.status, 'derived');
    assert.equal(shop.sources['wellVent.CO']?.status, 'assumed', 'wool CO is a generic figure');
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
  return new Map(['tile', 'table'].map((id) => [id, engine.studStates.get(id)?.smoke ?? 0]));
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
    assert.equal(
      absorbed.objects.every((obj) => obj.confirmed),
      false,
    );
    const table = absorbed.objects.find((obj) => obj.id === 'legacy-tables');
    assert.deepEqual(
      table?.matches.map((match) => match.entryId),
      ['wood', 'steel'],
    );
    assert.equal(
      absorbed.objects.find((obj) => obj.id === 'legacy-blank')?.matches[0]?.entryId,
      'wood',
    );
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
      { id: 'c', simPos: { x: 0, y: 0 }, level: 'G', spatialContext: 'inside_building' as const },
      { id: 'e', simPos: { x: 3, y: 0 }, level: 'G', spatialContext: 'inside_building' as const },
      { id: 'yard', simPos: { x: 0, y: 2 }, level: 'G', spatialContext: 'open_air' as const },
      { id: 'far', simPos: { x: 6, y: 0 }, level: 'G', spatialContext: 'inside_building' as const },
      { id: 'up', simPos: { x: 0, y: 0 }, level: 'L1', spatialContext: 'inside_building' as const },
      {
        id: 'gas',
        simPos: { x: 20, y: 0 },
        level: 'G',
        spatialContext: 'inside_building' as const,
      },
    ];
    const fuel = confirmedFuelStudIds(absorbed.objects, studs);
    assert.equal(fuel.has('c'), true);
    assert.equal(fuel.has('e'), true);
    assert.equal(fuel.has('yard'), false);
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
    assert.equal(placed.length, 19);
    assert.equal(
      placed.every((obj) => obj.confirmed && obj.studId),
      true,
    );
    const fuel = confirmedFuelStudIds(
      placed,
      studs.map((stud) => ({
        id: stud.id,
        simPos: stud.simPos,
        level: stud.floor,
        spatialContext: stud.spatialContext,
      })),
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
    const indoorTable = tableStuds.filter((stud) => stud.spatialContext === 'inside_building');
    assert.ok(indoorTable.length >= 1);
    for (const stud of indoorTable) assert.equal(fuel.has(stud.id), true);
    for (const stud of tableStuds) {
      if (stud.spatialContext !== 'inside_building') assert.equal(fuel.has(stud.id), false);
    }
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
    const drinks = placed.find((obj) => obj.id === 'elec-drinks');
    const stallTable = placed.find((obj) => obj.id === 'noodle-table');
    const pizzaTable = placed.find((obj) => obj.id === 'pizza-table');
    const pizzaGas = placed.find((obj) => obj.id === 'legacy-hz-gas-pizza');
    assert.ok(drinks);
    assert.deepEqual(
      drinks.matches.map((match) => match.entryId),
      ['electrical'],
    );
    assert.equal(fuel.has(drinks.studId), false);
    assert.equal(drinks.description.toLowerCase().includes('gas line'), false);
    assert.ok(stallTable && fuel.has(stallTable.studId));
    assert.ok(noodle);
    const stallGap = Math.hypot(stallTable.pos.x - noodle.pos.x, stallTable.pos.y - noodle.pos.y);
    assert.ok(stallGap > 2.5 && stallGap < 3.5, `noodle table is ${stallGap} m from the gas line`);
    assert.ok(pizzaTable && pizzaGas && fuel.has(pizzaTable.studId));
    const pizzaGap = Math.hypot(
      pizzaTable.pos.x - pizzaGas.pos.x,
      pizzaTable.pos.y - pizzaGas.pos.y,
    );
    assert.ok(pizzaGap > 2.5 && pizzaGap < 3.5, `pizza table is ${pizzaGap} m from the gas line`);
    const pizzaFridge = placed.find((obj) => obj.id === 'elec-pizza');
    assert.ok(pizzaFridge && pizzaFridge.studId !== pizzaTable.studId);
    const hoods = placed.filter((obj) => obj.id.startsWith('hood-'));
    assert.equal(hoods.length, 5);
    const pizzaHood = placed.find((obj) => obj.id === 'hood-pizza');
    const fryerHood = placed.find((obj) => obj.id === 'hood-fryer');
    const fryerGas = placed.find((obj) => obj.id === 'legacy-hz-gas-fryer');
    assert.ok(pizzaHood && pizzaTable && pizzaGas && fryerHood && fryerGas);
    assert.notEqual(pizzaHood.studId, pizzaTable.studId);
    assert.equal(pizzaHood.studId, pizzaGas.studId);
    assert.equal(fuel.has(pizzaHood.studId), false);
    assert.equal(fryerHood.studId, fryerGas.studId);
    assert.equal(fuel.has(fryerHood.studId), true);
    for (const hood of hoods) {
      assert.equal(hood.confirmed, true);
      assert.ok(hood.matches.every((match) => match.behaviour === 'suppression'));
      assert.ok(hood.matches.every((match) => match.fuel === 'non_combustible'));
      if (hood.id !== 'hood-fryer') assert.equal(fuel.has(hood.studId), false);
    }
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

  test('a blast lights a confirmed table, and a starved room does not spread', () => {
    const { engine, zone } = blastEngine(new Set(['table', 'next']));
    engine.step(0.1, [], [zone]);
    assert.equal(engine.studStates.get('tile')?.fire.state, 'none');
    assert.equal(engine.studStates.get('yard')?.fire.state, 'none');
    assert.equal(engine.studStates.get('table')?.fire.state, 'burning');
    assert.notEqual(engine.studStates.get('next')?.fire.state, 'burning');

    // Three indoor studs, no opening. The flame stands in the upper layer
    // and burns that oxygen smoothly. The layer crosses the cutoff while
    // the wood curve is still under 1 MW, so the latch does not fire. The
    // front arrives at 360 s with the oxygen still on the extinguished
    // side of the cutoff, and the next stud stays dark.
    const fuel = defaultLightFuel();
    const flash = flashoverAgeSec(fuel);
    const frontSec =
      fuel.spreadMPerMin != null && fuel.spreadMPerMin > 0 ? (3 / fuel.spreadMPerMin) * 60 : null;
    assert.ok(flash != null && frontSec != null);
    assert.ok(frontSec > flash + 30);
    let seconds = 0.1;
    let burningAtLatch = false;
    while (seconds < frontSec + 30) {
      engine.step(1, [], [zone]);
      seconds += 1;
      if (seconds <= flash + 2 && engine.studStates.get('next')?.fire.state === 'burning')
        burningAtLatch = true;
    }
    assert.equal(burningAtLatch, false);
    assert.notEqual(engine.studStates.get('next')?.fire.state, 'burning');
    assert.equal(engine.studStates.get('tile')?.fire.state, 'none');
    assert.equal(engine.studStates.get('yard')?.fire.state, 'none');
    const layers = (
      engine as unknown as {
        layerState: Map<
          string,
          {
            active: boolean;
            zone: { interfaceM: number; upperO2?: number; lowerO2?: number };
          }
        >;
      }
    ).layerState;
    let starved = false;
    for (const live of layers.values()) {
      if (!live.active) continue;
      const y = ignitionOxygenY(live.zone.interfaceM, live.zone.upperO2, live.zone.lowerO2);
      if (!oxygenAllowsFlame(y)) starved = true;
    }
    assert.equal(starved, true);
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

  test('the front does not light a stud standing past the oxygen cutoff', () => {
    const sim = new FireSimulation({
      ...DEFAULT_FIRE_PARAMS,
      ambientSpread: true,
      ambientHeatSec: 30,
    });
    sim.init([
      { id: 'src', simPos: { x: 0, y: 0 }, spatialContext: 'inside_building' },
      { id: 'next', simPos: { x: 3, y: 0 }, spatialContext: 'inside_building' },
    ]);
    sim.setFuelStuds(new Set(['src', 'next']));
    sim.setIgnitionOxygen(
      new Map([
        ['src', 0.153],
        ['next', 0.153],
      ]),
    );
    sim.ignite(['src']);
    for (let i = 0; i < 400; i++) sim.step(1, [], []);
    assert.notEqual(sim.states.get('next')?.state, 'burning');
    sim.setIgnitionOxygen(
      new Map([
        ['src', 0.2],
        ['next', 0.2],
      ]),
    );
    sim.step(1, [], []);
    assert.equal(sim.states.get('next')?.state, 'burning');
  });

  test('a starved latch stays dark, and the room lights when oxygen returns', () => {
    const sim = new FireSimulation({
      ...DEFAULT_FIRE_PARAMS,
      ambientSpread: true,
      ambientHeatSec: 30,
    });
    sim.init([
      { id: 'src', simPos: { x: 0, y: 0 }, spatialContext: 'inside_building' },
      { id: 'next', simPos: { x: 3, y: 0 }, spatialContext: 'inside_building' },
    ]);
    sim.setFuelStuds(new Set(['src', 'next']));
    const starved = new Map([
      ['src', 0.153],
      ['next', 0.153],
    ]);
    sim.setIgnitionOxygen(starved);
    sim.ignite(['src']);
    let seconds = 0;
    while (!sim.isFlashed('src') && seconds < 400) {
      sim.step(1, [], []);
      seconds += 1;
    }
    assert.ok(sim.isFlashed('src'), 'the room never latched');
    assert.notEqual(sim.states.get('next')?.state, 'burning');
    sim.setIgnitionOxygen(
      new Map([
        ['src', 0.2],
        ['next', 0.2],
      ]),
    );
    sim.step(1, [], []);
    assert.equal(sim.states.get('next')?.state, 'burning');
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
