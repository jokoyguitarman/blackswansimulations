import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import Matter from 'matter-js';
import { PolygonEvacuationEngine } from '../src/lib/evacuation/engine';
import { HazardField, type Posture } from '../src/lib/evacuation/hazardSensing';
import type { ExitDef, Vec2 } from '../src/lib/evacuation/types';
import { projectPolygon } from '../src/lib/evacuation/geometry';
import {
  GAS_JET_KW,
  STUD_AREA_M2,
  WET_FLOOR_SPEED,
  WOOD_HEAT_KJ_KG,
  burnoutSec,
  fuelEnergyKj,
  releaseEnergyKj,
} from '../src/lib/rts/flameFront';
import { LEVEL } from '../src/lib/evacuation/levelConstants';
import { SHOWCASE } from '../src/lib/evacuation/showcaseConstants';
import { stairTravelS } from '../src/lib/rts/levels';
import type { LevelDef, Stairwell } from '../src/lib/rts/types';
import { FireSimulation, type FireSimStud } from '../src/lib/rts/fireSimulation';
import {
  confirmedFuelCells,
  confirmedGasLines,
  confirmedSuppression,
  defaultLightFuel,
  snapObjectsToStuds,
  entryById,
  fuelCellFromEntry,
  type PlacedObject,
  type SuppressionPlacement,
} from '../src/lib/rts/materialLibrary';
import { foodCourtPlacedObjects, foodCourtSample } from '../src/lib/rts/foodCourtSample';
import { generateSceneStuds, projectSceneStuds } from '../src/lib/rts/sceneStuds';
import {
  SMOKE_LEAK_PER_S,
  SpatialEffectsEngine,
  advanceSootK,
} from '../src/lib/rts/spatialEffects';
import { HEAD_HEIGHT_M } from '../src/lib/rts/twoZone';
import { FX } from '../src/lib/rts/fx/fxConstants';
import { createAccumulator, stepEffectsFixed } from '../src/lib/rts/fx/simClock';
import { extinctionK } from '../src/lib/evacuation/hazardSensing';
import {
  FEC_F_PPM,
  FED_CO_PPM_MIN,
  FED_HCN_DIVISOR,
  FED_HCN_PER_MIN,
  INCAP_DOSE,
  MOLAR_VOLUME_L,
  SOOT_EXTINCTION_M2_PER_G,
  advanceFed,
  fecImpairs,
  fecOf,
  fedIncapacitates,
  co2Hyperventilation,
  fedPerMin,
  fumesFromSmoke,
  O2_AMBIENT_VOLUME_PERCENT,
  oxygenFedPerMin,
  sootProductionGPerS,
  speciesProductionGPerS,
  ventilationBlend,
} from '../src/lib/rts/toxicDose';
import type { ChargeSpec } from '../src/lib/rts/blast/blastModel';
import type { InteriorWall } from '../src/lib/rts/types';

const WOOD = defaultLightFuel();
const OIL = fuelCellFromEntry(entryById('cooking_oil')!)!;
const TNT10: ChargeSpec = { presetKey: 'tnt', amountKg: 10, burst: 'surface', heightM: 1.5 };

function stud(id: string, x: number, y: number, level = 'G'): FireSimStud {
  return { id, simPos: { x, y }, spatialContext: 'inside_building', level };
}

function wall(x1: number, y1: number, x2: number, y2: number, door = false): InteriorWall {
  return {
    id: door ? 'door' : 'wall',
    start: { x: x1, y: y1 },
    end: { x: x2, y: y2 },
    hasDoor: door,
    doorWidth: 1.5,
    doorPosition: 0.5,
    description: '',
    material: 'concrete',
    photos: [],
    level: 'G',
  };
}

function head(
  id: string,
  x: number,
  y: number,
  kind: SuppressionPlacement['kind'] = 'sprinkler',
): SuppressionPlacement {
  return { id, pos: { x, y }, level: 'G', kind, ceilingM: 4 };
}

function fireSim(cells: Map<string, typeof WOOD>, heads: SuppressionPlacement[] = []) {
  const sim = new FireSimulation();
  sim.init([...cells.keys()].map((id) => stud(id, 0, 0)));
  sim.setFuelCells(cells);
  sim.setSuppression(heads);
  sim.ignite([...cells.keys()]);
  return sim;
}

function runSim(sim: FireSimulation, seconds: number, dt = 1, walls: InteriorWall[] = []) {
  let t = 0;
  while (t + 1e-9 < seconds) {
    const step = Math.min(dt, seconds - t);
    sim.step(step, walls, []);
    t += step;
  }
}

function effects(
  cells: Map<string, typeof WOOD>,
  extra: FireSimStud[] = [],
  heads: SuppressionPlacement[] = [],
) {
  const engine = new SpatialEffectsEngine(undefined, 1);
  const studs = [...cells.keys()].map((id) => stud(id, id === 'far' ? 3 : 0, 0));
  engine.init([...studs, ...extra]);
  engine.setFuelCells(cells);
  engine.setSuppression(heads);
  const sim = (engine as unknown as { fireSim: FireSimulation }).fireSim;
  sim.ignite([...cells.keys()]);
  return engine;
}

describe('ISO 13571 dose', () => {
  test('carbon monoxide at 35 000 ppm for one minute is a dose of 1, at any step size', () => {
    const fumes = { CO: FED_CO_PPM_MIN };
    const once = advanceFed(0, fumes, 60);
    let stepped = 0;
    for (let i = 0; i < 600; i++) stepped = advanceFed(stepped, fumes, 0.1);
    assert.ok(Math.abs(once - 1) < 1e-9);
    assert.ok(Math.abs(stepped - once) < 1e-9);
    assert.equal(fedIncapacitates(0.99), false);
    assert.equal(fedIncapacitates(1), true);
    assert.equal(INCAP_DOSE, 1);
  });

  test('the hydrogen cyanide term is zero at zero concentration', () => {
    assert.equal(advanceFed(0.2, {}, 300), 0.2);
    assert.equal(advanceFed(0.2, undefined, 300), 0.2);
    assert.equal(fedPerMin({ HCN: 0 }), 0);
    const trace = fedPerMin({ HCN: 1e-4 });
    assert.ok(trace < 1e-6, `trace still accrues the baseline (${trace})`);
    const perMin = (Math.exp(FED_HCN_DIVISOR / FED_HCN_DIVISOR) - 1) / FED_HCN_PER_MIN;
    assert.ok(Math.abs(fedPerMin({ HCN: FED_HCN_DIVISOR }) - perMin) < 1e-12);
    assert.ok(Math.abs(advanceFed(0, { HCN: FED_HCN_DIVISOR }, 60) - perMin) < 1e-12);
  });

  test('irritants use the ISO F values, and only the asphyxiant dose latches', () => {
    assert.equal(FEC_F_PPM.HCl, 1000);
    assert.equal(FEC_F_PPM.acrolein, 30);
    assert.ok(Math.abs(fecOf({ HCl: 1000 }) - 1) < 1e-12);
    assert.ok(Math.abs(fecOf({ acrolein: 30 }) - 1) < 1e-12);
    assert.ok(Math.abs(fecOf({ HCl: 500, acrolein: 15 }) - 1) < 1e-12);
    assert.equal(fecImpairs(0.99), false);
    assert.equal(fecImpairs(1), true);
    assert.equal(fedIncapacitates(0), false);
    assert.equal(fecOf({}), 0);
  });

  test('production is yield times mass-loss rate, and a cell with no yield emits nothing', () => {
    const well = speciesProductionGPerS(WOOD, WOOD_HEAT_KJ_KG, 0);
    assert.ok(Math.abs((well.CO ?? 0) - 4) < 1e-9, `well-vent CO ${well.CO}`);
    const rich = speciesProductionGPerS(WOOD, WOOD_HEAT_KJ_KG, 2);
    assert.ok(Math.abs((rich.CO ?? 0) - 200) < 1e-9, `rich CO ${rich.CO}`);
    assert.equal(ventilationBlend(0.75), 0);
    assert.equal(ventilationBlend(1.5), 1);
    const mid = speciesProductionGPerS(WOOD, WOOD_HEAT_KJ_KG, 1.125);
    assert.ok(Math.abs((mid.CO ?? 0) - 102) < 1e-6, `mid CO ${mid.CO}`);
    assert.equal(rich.HCN, undefined);
    assert.equal(rich.acrolein, undefined);
    assert.ok(Math.abs(sootProductionGPerS(WOOD, WOOD_HEAT_KJ_KG) - 15) < 1e-9);
    assert.deepEqual(speciesProductionGPerS(WOOD, 0), {});
    const bare = { ...WOOD };
    delete bare.toxicYieldGPerG;
    delete bare.toxicYieldWellVentGPerG;
    delete bare.sootYieldGPerG;
    assert.deepEqual(speciesProductionGPerS(bare, 1000), {});
    assert.equal(sootProductionGPerS(bare, 1000), 0);
    const oilGrams = speciesProductionGPerS(OIL, 464);
    assert.ok(Math.abs((oilGrams.acrolein ?? 0) - 0.1) < 1e-9, `acrolein ${oilGrams.acrolein}`);
    assert.equal(oilGrams.CO, undefined);
  });
});

describe('fumes follow the confirmed material', () => {
  test('the trainer does not pick a gas; the matched entry does', () => {
    const wood = fuelCellFromEntry(entryById('wood')!)!;
    const foam = fuelCellFromEntry(entryById('foam')!)!;
    const pvc = fuelCellFromEntry(entryById('pvc')!)!;
    assert.equal(wood.sootYieldGPerG, 0.015);
    assert.deepEqual(wood.toxicYieldWellVentGPerG, { CO: 0.004 });
    assert.deepEqual(wood.toxicYieldGPerG, { CO: 0.2 });
    assert.equal(foam.sootYieldGPerG, 0.188);
    assert.deepEqual(foam.toxicYieldWellVentGPerG, { CO: 0.028, HCN: 0.004 });
    assert.deepEqual(foam.toxicYieldGPerG, { CO: 0.28, HCN: 0.009 });
    assert.equal(pvc.sootYieldGPerG, 0.172);
    assert.deepEqual(pvc.toxicYieldWellVentGPerG, { HCl: 0.2, CO: 0.063 });
    assert.deepEqual(pvc.toxicYieldGPerG, { HCl: 0.2, CO: 0.2 });
    assert.equal(OIL.sootYieldGPerG, 0.02);
    assert.deepEqual(OIL.toxicYieldWellVentGPerG, { acrolein: 0.01 });
    assert.deepEqual(OIL.toxicYieldGPerG, { acrolein: 0.01 });
    assert.equal(fuelCellFromEntry(entryById('steel')!), null);
    assert.equal(fuelCellFromEntry(entryById('gas_line')!), null);

    const hidden: PlacedObject = {
      id: 'loose',
      studId: 'a',
      pos: { x: 0, y: 0 },
      level: 'G',
      description: 'wooden table',
      confirmed: false,
      matches: [
        { entryId: 'wood', label: 'Wood', fuel: 'light', behaviour: 'none', source: 'keyword' },
      ],
    };
    assert.equal(confirmedFuelCells([hidden], [stud('a', 0, 0)]).size, 0);
  });

  test('only a burning cell feeds the smoke, and a jet does not', () => {
    const quiet = new SpatialEffectsEngine(undefined, 1);
    quiet.init([stud('a', 0, 0)]);
    quiet.setFuelCells(new Map([['a', WOOD]]));
    quiet.step(30, [], []);
    assert.equal(quiet.studStates.get('a')?.fire.state, 'none');
    assert.equal(quiet.studStates.get('a')?.fumes, undefined);
    assert.equal(quiet.fumeSources().length, 0);

    const jet = new SpatialEffectsEngine(undefined, 1);
    jet.init([stud('pipe', 0, 0)]);
    jet.setFuelCells(new Map());
    jet.setBlastCharge(TNT10);
    jet.setGasLines([{ id: 'pipe', pos: { x: 0, y: 0 }, level: 'G', autoShutoffSec: null }]);
    const jetSim = (jet as unknown as { fireSim: FireSimulation }).fireSim;
    jetSim.applyBlast({ x: 0, y: 0 }, 3, 'G', []);
    assert.equal(jet.gasLineState('pipe')?.heatKw, GAS_JET_KW);
    jet.step(10, [], []);
    assert.equal(jet.gasJets().length, 1);
    assert.equal(jet.fumeSources().length, 0);
    assert.equal(jet.studStates.get('pipe')?.fumes, undefined);

    const plain = new FireSimulation();
    plain.init([stud('wood', 0, 0), stud('pipe', 9, 0)]);
    plain.setFuelCells(new Map([['wood', WOOD]]));
    plain.ignite(['wood']);
    const withJet = new FireSimulation();
    withJet.init([stud('wood', 0, 0), stud('pipe', 9, 0)]);
    withJet.setFuelCells(new Map([['wood', WOOD]]));
    withJet.setBlastCharge(TNT10);
    withJet.setGasLines([{ id: 'pipe', pos: { x: 9, y: 0 }, level: 'G', autoShutoffSec: null }]);
    withJet.applyBlast({ x: 9, y: 0 }, 3, 'G', []);
    withJet.ignite(['wood']);
    runSim(plain, 20);
    runSim(withJet, 20);
    assert.equal(withJet.gasLineState('pipe')?.heatKw, GAS_JET_KW);
    const plainCo = plain.fumeSources()[0]?.gramsPerS.CO ?? 0;
    const jetCo = withJet.fumeSources()[0]?.gramsPerS.CO ?? 0;
    assert.ok(plainCo > 0);
    assert.ok(Math.abs(jetCo - plainCo) / plainCo < 0.01, `jet ${jetCo}, wood ${plainCo}`);
    assert.equal(withJet.fumeSources()[0]?.gramsPerS.HCN, undefined);
  });
});

describe('smoke carries the gases', () => {
  test('ppm follows the local smoke, not a copy of the whole production', () => {
    const full = fumesFromSmoke(1, { CO: 0.004 }, 0.015);
    assert.ok((full.CO ?? 0) > 100 && (full.CO ?? 0) < 250, `wood at K max is ${full.CO} ppm`);
    const thick = fumesFromSmoke(0.4, { CO: 0.004 }, 0.015);
    const ratio = (thick.CO ?? 0) / (full.CO ?? 1);
    assert.ok(Math.abs(ratio - extinctionK(0.4) / extinctionK(1)) < 1e-9);
    assert.equal(SOOT_EXTINCTION_M2_PER_G, 8.7);
    assert.ok(MOLAR_VOLUME_L > 24 && MOLAR_VOLUME_L < 24.1);
    const doubled = fumesFromSmoke(1, { CO: 0.008 }, 0.03);
    assert.ok(Math.abs((doubled.CO ?? 0) - (full.CO ?? 0)) < 1e-6);

    const engine = new SpatialEffectsEngine(undefined, 1);
    engine.init([stud('a', 0, 0), stud('far', 3, 0)]);
    engine.setFuelCells(new Map([['a', WOOD]]));
    (engine as unknown as { fireSim: FireSimulation }).fireSim.ignite(['a']);
    let t = 0;
    while ((engine.studStates.get('far')?.smoke ?? 0) <= 0.02 && t < 300) {
      engine.step(0.1, [], []);
      t += 0.1;
    }
    const state = engine.studStates.get('a');
    const far = engine.studStates.get('far');
    const source = engine.fumeSources()[0];
    assert.ok(state && far && source);
    assert.equal(source.gramsPerS.acrolein, undefined);
    const expected = fumesFromSmoke(state.smoke ?? 0, source.gramsPerS, source.sootGPerS);
    assert.ok(Math.abs((state.fumes?.CO ?? 0) - (expected.CO ?? 0)) < 1e-6);
    assert.ok((state.fumes?.CO ?? 0) < 250, `source CO ${state.fumes?.CO}`);
    assert.ok(t < 300, 'smoke did not reach the far stud');
    assert.ok((far.smoke ?? 0) > 0.02);
    const farExpected = fumesFromSmoke(far.smoke ?? 0, source.gramsPerS, source.sootGPerS);
    assert.ok(Math.abs((far.fumes?.CO ?? 0) - (farExpected.CO ?? 0)) < 1e-6);
    assert.ok((far.fumes?.CO ?? 0) > 0);
    assert.ok((far.fumes?.CO ?? 0) < (state.fumes?.CO ?? 0));
  });

  test('a sustained fire fills its room and reaches a stud 10 m away', () => {
    const studs: FireSimStud[] = [];
    for (let x = 0; x <= 12; x += 3) {
      for (let y = 0; y <= 12; y += 3) {
        studs.push(stud(`s_${x}_${y}`, x, y));
      }
    }
    const engine = new SpatialEffectsEngine(undefined, 1);
    engine.init(studs);
    engine.setFuelCells(new Map([['s_0_0', WOOD]]));
    (engine as unknown as { fireSim: FireSimulation }).fireSim.ignite(['s_0_0']);
    for (let i = 0; i < 3000; i++) engine.step(0.1, [], []);
    let sum = 0;
    for (const state of engine.studStates.values()) sum += extinctionK(state.smoke ?? 0);
    const mean = sum / engine.studStates.size;
    const farK = extinctionK(engine.studStates.get('s_12_0')?.smoke ?? 0);
    assert.ok(mean > 0.3, `mean K ${mean}`);
    assert.ok(farK >= 0.15, `K at 12 m is ${farK}`);
  });

  test('a taller saved storey holds the same soot at a lower extinction', () => {
    const run = (height: number | null) => {
      const engine = new SpatialEffectsEngine(undefined, 1);
      engine.init([stud('a', 0, 0)]);
      if (height != null) engine.setStoreyHeights({ G: height });
      engine.setFuelCells(new Map([['a', WOOD]]));
      (engine as unknown as { fireSim: FireSimulation }).fireSim.ignite(['a']);
      for (let i = 0; i < 300; i++) engine.step(0.1, [], []);
      return extinctionK(engine.studStates.get('a')?.smoke ?? 0);
    };
    const base = run(null);
    const tall = run(LEVEL.DEFAULT_STOREY_HEIGHT_M * 2);
    assert.ok(base > 0, 'the fire made no smoke');
    assert.ok(Math.abs(tall / base - 0.5) < 1e-6, `tall ${tall}, storey ${base}`);
  });

  test('smoke leaves through an exit and not through the outside wall', () => {
    const verts: Vec2[] = [
      { x: 0, y: 0 },
      { x: 9, y: 0 },
      { x: 9, y: 9 },
      { x: 0, y: 9 },
    ];
    const opening: ExitDef = {
      id: 'west',
      center: { x: 0, y: 4.5 },
      width: 3,
      edgeIndex: 3,
      description: '',
      status: 'open',
      photos: [],
      level: 'G',
    };
    const run = (exits: ExitDef[]) => {
      const engine = new SpatialEffectsEngine(undefined, 1);
      engine.init([
        { id: 'in', simPos: { x: 1.5, y: 4.5 }, spatialContext: 'inside_building', level: 'G' },
        { id: 'out', simPos: { x: -1.5, y: 4.5 }, spatialContext: 'open_air', level: 'G' },
      ]);
      engine.setFuelCells(new Map([['in', WOOD]]));
      engine.setBuildingEnvelope(verts, exits);
      (engine as unknown as { fireSim: FireSimulation }).fireSim.ignite(['in']);
      for (let i = 0; i < 1200; i++) engine.step(0.1, [], []);
      return extinctionK(engine.studStates.get('out')?.smoke ?? 0);
    };
    const open = run([opening]);
    const shut = run([{ ...opening, status: 'blocked' }]);
    const unset = run([]);
    assert.ok(open > 0.05, `exit K ${open}`);
    assert.ok(open > shut * 5, `exit ${open}, wall ${shut}`);
    assert.ok(open > unset * 5, `exit ${open}, no exits ${unset}`);
  });

  test(
    'a closed food court keeps most of a 1 MW fire indoors',
    { skip: !process.env.RUN_SLOW_TESTS && 'slow scene run: nightly, or npm run test:slow' },
    () => {
      const polygon = foodCourtSample.scene.buildingPolygon.map(
        (pair) => [pair[0], pair[1]] as [number, number],
      );
      const verts = projectPolygon(polygon);
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const vertex of verts) {
        minX = Math.min(minX, vertex.x);
        minY = Math.min(minY, vertex.y);
        maxX = Math.max(maxX, vertex.x);
        maxY = Math.max(maxY, vertex.y);
      }
      const pad = 12;
      const studs: FireSimStud[] = [];
      for (const stud of projectSceneStuds(polygon, generateSceneStuds(polygon, 0, ['G']))) {
        if (stud.simPos.x < minX - pad || stud.simPos.x > maxX + pad) continue;
        if (stud.simPos.y < minY - pad || stud.simPos.y > maxY + pad) continue;
        studs.push({
          id: stud.id,
          simPos: stud.simPos,
          spatialContext: stud.spatialContext,
          level: stud.floor ?? 'G',
        });
      }
      const indoor = studs.filter((stud) => stud.spatialContext === 'inside_building');
      let cx = 0;
      let cy = 0;
      for (const stud of indoor) {
        cx += stud.simPos.x;
        cy += stud.simPos.y;
      }
      cx /= indoor.length;
      cy /= indoor.length;
      let fire = indoor[0];
      let best = Infinity;
      for (const stud of indoor) {
        const d = Math.hypot(stud.simPos.x - cx, stud.simPos.y - cy);
        if (d < best) {
          best = d;
          fire = stud;
        }
      }
      const height = foodCourtSample.scene.levels[0].heightM;
      const walls = foodCourtSample.scene.interiorWalls as InteriorWall[];
      const exits = (foodCourtSample.scene.exits as ExitDef[]).map((exit) => ({
        ...exit,
        status: 'blocked' as const,
      }));
      const engine = new SpatialEffectsEngine(undefined, 1);
      engine.init(studs);
      engine.setStoreyHeights({ G: height });
      engine.setBuildingEnvelope(verts, exits);
      engine.setFuelCells(new Map([[fire.id, WOOD]]));
      const sim = (engine as unknown as { fireSim: FireSimulation }).fireSim;
      sim.ignite([fire.id]);
      const dt = 0.1;
      const horizon = 300;
      let made = 0;
      let expected = 0;
      for (let t = 0; t < horizon - 1e-9; t += dt) {
        let soot = 0;
        for (const source of sim.burningSoot()) soot += source.sootGPerS;
        made += soot * dt;
        expected = advanceSootK(expected, soot, SMOKE_LEAK_PER_S, dt);
        engine.step(dt, walls, []);
      }
      const volume = STUD_AREA_M2 * height;
      let indoorG = 0;
      let outdoorG = 0;
      let sumK = 0;
      for (const cell of studs) {
        const k = extinctionK(engine.studStates.get(cell.id)?.smoke ?? 0);
        const grams = (k * volume) / SOOT_EXTINCTION_M2_PER_G;
        if (cell.spatialContext === 'inside_building') {
          indoorG += grams;
          sumK += k;
        } else outdoorG += grams;
      }
      const meanK = sumK / indoor.length;
      const balancedK = (expected * SOOT_EXTINCTION_M2_PER_G) / (indoor.length * volume);
      const release = engine.fuelReleaseKw(fire.id) ?? 0;
      // A layer holds its soot above the head, so the column K is clear air.
      // That mass is still indoors. It is not a leak through the wall.
      const layers = (
        engine as unknown as {
          layerState: Map<string, { active: boolean; zone: { sootG: number; interfaceM: number } }>;
        }
      ).layerState;
      let layerG = 0;
      let aboveHead = false;
      for (const row of layers.values()) {
        if (!row.active) continue;
        layerG += row.zone.sootG;
        if (row.zone.interfaceM > HEAD_HEIGHT_M) aboveHead = true;
      }
      assert.ok(indoor.length > 50, `indoor studs ${indoor.length}`);
      assert.ok(release > 800, `release ${release} kW`);
      assert.ok(
        (indoorG + layerG) / made >= 0.6,
        `indoors ${indoorG + layerG} g of ${made} g, outdoors ${outdoorG} g`,
      );
      if (!aboveHead) {
        assert.ok(meanK > balancedK * 0.5, `mean K ${meanK}, leak-only well mixed ${balancedK}`);
      }
    },
  );

  test('a wall stops the gases and a door gap does not', () => {
    const blocked = new SpatialEffectsEngine(undefined, 1);
    blocked.init([stud('a', 0, 0), stud('far', 3, 0)]);
    blocked.setFuelCells(new Map([['a', WOOD]]));
    (blocked as unknown as { fireSim: FireSimulation }).fireSim.ignite(['a']);
    const barrier = wall(1.5, -5, 1.5, 5);
    // One minute of this wood fire is still small in a storey-height column.
    // Two minutes is long enough for the door to carry CO, and the wall still blocks it.
    for (let t = 0; t < 120; t++) blocked.step(1, [barrier], []);
    assert.ok((blocked.studStates.get('a')?.fumes?.CO ?? 0) > 0);
    assert.equal(blocked.studStates.get('far')?.fumes, undefined);

    const open = new SpatialEffectsEngine(undefined, 1);
    open.init([stud('a', 0, 0), stud('far', 3, 0)]);
    open.setFuelCells(new Map([['a', WOOD]]));
    (open as unknown as { fireSim: FireSimulation }).fireSim.ignite(['a']);
    for (let t = 0; t < 120; t++) open.step(1, [wall(1.5, -5, 1.5, 5, true)], []);
    assert.ok((open.studStates.get('far')?.fumes?.CO ?? 0) > 0, 'door did not pass CO');
  });

  test('another storey stays clear until smoke rises up a shaft', () => {
    const sealed = new SpatialEffectsEngine(undefined, 1);
    sealed.init([stud('g', 0, 0, 'G'), stud('up', 0, 0, 'L1')]);
    sealed.setFuelCells(new Map([['g', WOOD]]));
    (sealed as unknown as { fireSim: FireSimulation }).fireSim.ignite(['g']);
    for (let t = 0; t < 40; t++) sealed.step(1, [], []);
    assert.equal(sealed.studStates.get('up')?.fumes, undefined);

    const shaft = new SpatialEffectsEngine(undefined, 1);
    shaft.init([stud('g', 0, 0, 'G'), stud('up', 0, 0, 'L1')]);
    shaft.setFuelCells(new Map([['g', WOOD]]));
    shaft.setVerticalLinks([
      { id: 'stair', pos: { x: 0, y: 0 }, levels: ['G', 'L1'], kind: 'stair', blocked: false },
    ]);
    (shaft as unknown as { fireSim: FireSimulation }).fireSim.ignite(['g']);
    let t = 0;
    while ((shaft.studStates.get('up')?.smoke ?? 0) <= 0.02 && t < 120) {
      shaft.step(1, [], []);
      t += 1;
    }
    assert.ok(t < 120, 'smoke did not rise');
    assert.ok((shaft.studStates.get('up')?.fumes?.CO ?? 0) > 0);
  });

  test('a spray that decays the fire decays the fumes by the same ratio', () => {
    const bare = fireSim(new Map([['a', WOOD]]));
    const sprayed = fireSim(new Map([['a', WOOD]]), [head('h', 0, 0)]);
    let t = 0;
    while (sprayed.suppressionState('h')?.open !== true && t < 300) {
      bare.step(1, [], []);
      sprayed.step(1, [], []);
      t += 1;
    }
    assert.ok(t < 300, 'sprinkler did not open');
    runSim(bare, 60);
    runSim(sprayed, 60);
    const yieldOf = (sim: FireSimulation) => (sim.isFlashed('a') ? 0.1 : 0.004);
    const bareG = bare.fumeSources()[0]?.gramsPerS.CO ?? 0;
    const sprayG = sprayed.fumeSources()[0]?.gramsPerS.CO ?? 0;
    const bareQ = bare.fuelReleaseKw('a') ?? 0;
    const sprayQ = sprayed.fuelReleaseKw('a') ?? 0;
    assert.ok(sprayQ < bareQ * 0.95, `suppressed Q ${sprayQ}, bare ${bareQ}`);
    const barePer = bareG / bareQ / yieldOf(bare);
    const sprayPer = sprayG / sprayQ / yieldOf(sprayed);
    assert.ok(Math.abs(sprayPer - barePer) / barePer < 0.01, `per yield ${sprayPer} vs ${barePer}`);
    if (bare.isFlashed('a') === sprayed.isFlashed('a')) {
      assert.ok(sprayG < bareG * 0.95, `suppressed ${sprayG}, bare ${bareG}`);
    }

    const oilBare = fireSim(new Map([['a', OIL]]));
    const oilWater = fireSim(new Map([['a', OIL]]), [head('w', 0, 0, 'sprinkler')]);
    t = 0;
    while (oilWater.suppressionState('w')?.open !== true && t < 240) {
      oilBare.step(1, [], []);
      oilWater.step(1, [], []);
      t += 1;
    }
    assert.ok(t < 240, 'sprinkler over oil did not open');
    runSim(oilBare, 30);
    runSim(oilWater, 30);
    const bareOil = oilBare.fumeSources()[0]?.gramsPerS.acrolein ?? 0;
    const wetOil = oilWater.fumeSources()[0]?.gramsPerS.acrolein ?? 0;
    assert.ok(bareOil > 0 && wetOil > 0);
    assert.ok(Math.abs(wetOil - bareOil) / bareOil < 0.01, `water ${wetOil}, bare ${bareOil}`);

    const chemBare = fireSim(new Map([['a', OIL]]));
    const chem = fireSim(new Map([['a', OIL]]), [head('c', 0, 0, 'wet_chemical')]);
    t = 0;
    while (chem.suppressionState('c')?.open !== true && t < 180) {
      chemBare.step(1, [], []);
      chem.step(1, [], []);
      t += 1;
    }
    assert.ok(t < 180, 'hood did not open');
    runSim(chemBare, 60);
    runSim(chem, 60);
    const free = chemBare.fumeSources()[0]?.gramsPerS.acrolein ?? 0;
    const held = chem.fumeSources()[0]?.gramsPerS.acrolein ?? 0;
    assert.ok(held < free * 0.8, `hood ${held}, bare ${free}`);
  });

  test('a discharging hood is a fan on the layer, not a hole in one stud', () => {
    // Two studs, a door, and the stud outside that door. The intake is the
    // canopy, about 2 m above the floor. While the layer is below that, the
    // fan takes smoke and holds the interface up.
    const walls = [
      wall(-1.5, 1.5, 4.5, 1.5),
      wall(-1.5, -1.5, 4.5, -1.5),
      wall(-1.5, -1.5, -1.5, 1.5),
      wall(4.5, -1.5, 4.5, 1.5, true),
    ];
    // The NUREG worked-example door, 0.9 m.
    walls[3]!.doorWidth = 0.9;
    const outside: FireSimStud = {
      id: 'out',
      simPos: { x: 6, y: 0 },
      spatialContext: 'open_air',
      level: 'G',
    };
    const hooded = effects(
      new Map([['a', OIL]]),
      [stud('b', 3, 0), outside],
      [head('c', 0, 0, 'wet_chemical')],
    );
    const bare = effects(new Map([['a', OIL]]), [stud('b', 3, 0), outside]);
    let t = 0;
    while (hooded.suppressionState('c')?.open !== true && t < 180) {
      hooded.step(1, walls, []);
      bare.step(1, walls, []);
      t += 1;
    }
    assert.ok(t < 180, 'hood did not open');
    for (let i = 0; i < 150; i++) {
      hooded.step(1, walls, []);
      bare.step(1, walls, []);
    }
    const layerOf = (engine: SpatialEffectsEngine) =>
      [
        ...(
          engine as unknown as {
            layerState: Map<
              string,
              { active: boolean; zone: { interfaceM: number; sootG: number } }
            >;
          }
        ).layerState.values(),
      ].find((row) => row.active);
    const held = layerOf(hooded);
    const free = layerOf(bare);
    assert.ok(held, 'the hood removed the layer');
    assert.ok(free, 'the bare room did not layer');
    // The canopy lip is 2.03 m. This decaying pan and its door hold the
    // interface above 1.5 m, short of that lip.
    assert.ok((held?.zone.interfaceM ?? 0) > 1.5, `hood interface ${held?.zone.interfaceM}`);
    assert.ok(
      (free?.zone.interfaceM ?? 0) < (held?.zone.interfaceM ?? 0),
      `bare ${free?.zone.interfaceM}, hood ${held?.zone.interfaceM}`,
    );
    const hoodSmoke = hooded.studStates.get('a')?.smoke ?? 0;
    const bareSmoke = bare.studStates.get('a')?.smoke ?? 0;
    assert.ok(hoodSmoke > 0 && hoodSmoke < bareSmoke, `smoke hood ${hoodSmoke}, bare ${bareSmoke}`);
    const hoodPpm = hooded.studStates.get('a')?.fumes?.acrolein ?? 0;
    const barePpm = bare.studStates.get('a')?.fumes?.acrolein ?? 0;
    assert.ok(hoodPpm > 0 && hoodPpm < barePpm, `ppm hood ${hoodPpm}, bare ${barePpm}`);
  });

  test('a hood with no layer still extracts, and only a discharging one does by default', () => {
    // One stud and no walls, so no enclosure and no layer. The IMC flow
    // comes off that column. The default waits for the discharge. The
    // appliances setting is already drawing before the link opens.
    const hooded = effects(new Map([['a', OIL]]), [], [head('c', 0, 0, 'wet_chemical')]);
    const bare = effects(new Map([['a', OIL]]));
    const cooking = effects(new Map([['a', OIL]]), [], [head('c', 0, 0, 'wet_chemical')]);
    cooking.setHoodFanWhen('appliances');
    let t = 0;
    while (hooded.suppressionState('c')?.open !== true && t < 180) {
      hooded.step(1, [], []);
      bare.step(1, [], []);
      cooking.step(1, [], []);
      t += 1;
    }
    assert.ok(t < 180, 'hood did not open');
    const atOpen = hooded.studStates.get('a')?.fumes?.acrolein ?? 0;
    const cookingAtOpen = cooking.studStates.get('a')?.fumes?.acrolein ?? 0;
    assert.ok(cookingAtOpen < atOpen, `appliances ${cookingAtOpen}, discharge ${atOpen}`);
    for (let i = 0; i < 180; i++) {
      hooded.step(1, [], []);
      bare.step(1, [], []);
    }
    const later = hooded.studStates.get('a')?.fumes?.acrolein ?? 0;
    const bareLater = bare.studStates.get('a')?.fumes?.acrolein ?? 0;
    assert.ok(later > 0 && later < bareLater, `hood ${later}, bare ${bareLater}`);
    assert.ok((hooded.studStates.get('a')?.smoke ?? 1) < (bare.studStates.get('a')?.smoke ?? 0));
  });

  test('a fryer fire reaches an irritant fraction of 1 in its own smoke, and the gas stays bounded', () => {
    const engine = new SpatialEffectsEngine(undefined, 1);
    engine.init([stud('pan', 0, 0), stud('next', 3, 0)]);
    engine.setFuelCells(new Map([['pan', OIL]]));
    (engine as unknown as { fireSim: FireSimulation }).fireSim.ignite(['pan']);
    let t = 0;
    // A 0.2 MW pan mixed through a 36 m³ column reaches an irritant fraction
    // of 1 in about three minutes. Four minutes is the bound.
    while (fecOf(engine.studStates.get('pan')?.fumes) < 1 && t < 300) {
      engine.step(0.1, [], []);
      t += 0.1;
    }
    assert.ok(t < 240, `pan FEC reached 1 at ${t}`);
    const pan = engine.studStates.get('pan');
    assert.ok((pan?.fumes?.acrolein ?? 0) < 250, `acrolein ${pan?.fumes?.acrolein}`);
    assert.equal(pan?.fumes?.CO, undefined);
    const source = engine.fumeSources()[0];
    const next = engine.studStates.get('next');
    assert.ok(source && next);
    if ((next.smoke ?? 0) > 0.02) {
      const expected = fumesFromSmoke(next.smoke ?? 0, source.gramsPerS, source.sootGPerS);
      assert.ok(Math.abs((next.fumes?.acrolein ?? 0) - (expected.acrolein ?? 0)) < 1e-6);
      assert.ok((next.fumes?.acrolein ?? 0) <= (pan?.fumes?.acrolein ?? 0));
    } else {
      assert.equal(next.fumes, undefined);
    }
  });

  test('the flashover latch does not switch the gas yield, and the dose does not depend on the frame size', () => {
    const sim = fireSim(new Map([['a', WOOD]]));
    let t = 0;
    while (!sim.isFlashed('a') && t < 400) {
      sim.step(1, [], []);
      t += 1;
    }
    assert.ok(sim.isFlashed('a'), 'wood stud did not flash');
    assert.ok(t > 30, 'flashed before the fire had grown');
    const after = sim.fumeSources()[0];
    const q = sim.fuelReleaseKw('a') ?? 0;
    const perKw = (after?.gramsPerS.CO ?? 0) / q;
    // One stud and no walls is not a layer, so the yield stays well ventilated.
    const expected = (0.004 * 1000) / WOOD_HEAT_KJ_KG;
    assert.ok(Math.abs(perKw - expected) / expected < 0.01, `well-vent after the latch ${perKw}`);
    assert.equal(oxygenFedPerMin(20.9), 0);
    assert.equal(oxygenFedPerMin(O2_AMBIENT_VOLUME_PERCENT), 0);
    const limited = fireSim(new Map([['rich', WOOD]]));
    limited.step(1, [], []);
    limited.setBurnLimit(['rich'], 0.35, 2);
    const pyrolysis = limited.fuelReleaseKw('rich') ?? 0;
    const fumes = limited.fumeSources()[0];
    const full = speciesProductionGPerS(WOOD, pyrolysis, 2);
    assert.ok(
      Math.abs((fumes?.gramsPerS.CO ?? 0) - (full.CO ?? 0)) < 1e-6,
      'CO follows the fuel mass lost',
    );
    assert.ok(Math.abs((fumes?.sootGPerS ?? 0) - sootProductionGPerS(WOOD, pyrolysis)) < 1e-6);
    const burnedOnly = speciesProductionGPerS(WOOD, pyrolysis * 0.35, 2);
    assert.ok((fumes?.gramsPerS.CO ?? 0) > (burnedOnly.CO ?? 0) * 2);
    assert.ok(oxygenFedPerMin(12) > 0.03, `12% oxygen ${oxygenFedPerMin(12)}`);
    assert.equal(co2Hyperventilation(0), 1);
    assert.ok(Math.abs(co2Hyperventilation(5) - Math.exp(1)) < 1e-12);
    const plain = fedPerMin({ CO: 35000 });
    assert.ok(Math.abs(fedPerMin({ CO: 35000 }, 20.9, 5) - plain * Math.exp(1)) < 1e-9);
    const o2 = oxygenFedPerMin(12);
    assert.ok(Math.abs(fedPerMin({}, 12, 5) - o2) < 1e-12, 'CO2 does not multiply the oxygen term');

    const fine = doseOver(0.1, 300);
    const coarse = doseOver(1, 30);
    assert.ok(Math.abs(fine.fed - coarse.fed) < 1e-9, `FED ${fine.fed} vs ${coarse.fed}`);
    assert.ok(Math.abs(fine.ppm - coarse.ppm) < 1e-9, `ppm ${fine.ppm} vs ${coarse.ppm}`);
    assert.ok(Math.abs(fine.smoke - coarse.smoke) < 1e-9, `smoke ${fine.smoke} vs ${coarse.smoke}`);
    assert.ok(fine.fed > 0);
  });

  test('smoke is the soot the fire is making, and spreading it does not create more', () => {
    const quietCell = { ...WOOD, sootYieldGPerG: 0 };
    const quiet = effects(new Map([['a', quietCell]]));
    const burning = effects(new Map([['a', WOOD]]));
    const shared = effects(new Map([['a', WOOD]]), [stud('nbr', 3, 0)]);
    for (let i = 0; i < 600; i++) {
      quiet.step(0.1, [], []);
      burning.step(0.1, [], []);
      shared.step(0.1, [], []);
    }
    assert.ok(
      (quiet.studStates.get('a')?.smoke ?? 0) < 1e-6,
      'a cell with no soot yield made smoke',
    );
    assert.ok(
      (burning.studStates.get('a')?.smoke ?? 0) > 0.02,
      'wood smoke did not follow the soot',
    );
    const alone = burning.studStates.get('a')?.smoke ?? 0;
    const source = shared.studStates.get('a')?.smoke ?? 0;
    const neighbour = shared.studStates.get('nbr')?.smoke ?? 0;
    assert.ok(neighbour > 0, 'smoke did not spread');
    assert.ok(source < alone, `source kept smoke it had given away (${source} vs ${alone})`);

    const engine = new SpatialEffectsEngine(undefined, 1);
    engine.init([stud('src', 0, 0), stud('nbr', 3, 0)]);
    const src = engine.studStates.get('src');
    const nbr = engine.studStates.get('nbr');
    assert.ok(src && nbr);
    src.smoke = 1;
    engine.step(0.1, [], []);
    assert.ok(nbr.smoke > 0, 'neighbour gained no smoke');
    assert.ok(src.smoke < 1, 'source did not lose the smoke it gave away');
    assert.ok(src.smoke + nbr.smoke <= 1 + 1e-6, 'spread created smoke');
  });
});

describe('people', () => {
  test('an irritant fraction of 1 makes them crawl until the air clears, and only FED puts them down', () => {
    const clean = distance(undefined);
    const dosing = distance({ CO: 200 });
    assert.ok(clean > 0.3, `did not walk (${clean})`);
    assert.ok(Math.abs(dosing - clean) / clean < 0.02, `pace ${dosing} vs ${clean}`);

    const crawling = walk([{ fumes: { acrolein: 30 }, steps: 180 }]);
    assert.equal(crawling.state, 'evacuating');
    assert.equal(crawling.fumeHeld, true);
    assert.equal(crawling.posture, 'crawl');
    assert.notEqual(crawling.fumeDown, true);
    assert.ok(crawling.moved > 0.25, `did not crawl (${crawling.moved})`);
    assert.ok(crawling.moved < clean * 0.8, `crawl ${crawling.moved} vs walk ${clean}`);
    assert.equal(crawling.fumeHeldCount, 1);
    assert.equal(crawling.fumeDownCount, 0);

    const stayed = walk([{ fumes: { acrolein: 30 }, steps: 210 }]);
    const resumed = walk([{ fumes: { acrolein: 30 }, steps: 30 }, { steps: 180 }]);
    assert.equal(resumed.state, 'evacuating');
    assert.notEqual(resumed.fumeHeld, true);
    assert.equal(resumed.posture, 'stand');
    assert.ok(
      resumed.moved > stayed.moved,
      `did not speed up (${resumed.moved} vs ${stayed.moved})`,
    );

    const down = walk([{ fumes: { CO: 200_000_000 }, steps: 5 }, { steps: 60 }]);
    assert.equal(down.state, 'down');
    assert.equal(down.fumeDown, true);
    assert.equal(down.injury, 'serious');
    assert.equal(down.fumeDownCount, 1);
    assert.ok(down.moved < 0.05, `a downed person walked (${down.moved})`);

    const dry = walk([{ fumes: { acrolein: 30 }, steps: 180 }]);
    const hurt = walk([{ fumes: { acrolein: 30 }, steps: 180 }], { injury: 'minor', wet: true });
    assert.ok(hurt.moved > 0.05, `injured crawl did not move (${hurt.moved})`);
    assert.ok(
      hurt.moved < dry.moved * 0.85,
      `injury and wet floor did not slow the crawl (${hurt.moved} vs ${dry.moved})`,
    );
    assert.equal(hurt.posture, 'crawl');

    const plain = walk([{ fumes: { acrolein: 30 }, steps: 180 }], { showcase: false });
    const plainHurt = walk([{ fumes: { acrolein: 30 }, steps: 180 }], {
      showcase: false,
      injury: 'minor',
      wet: true,
    });
    assert.equal(plain.posture, 'crawl');
    assert.ok(plain.moved > 0.05, `plain crawl did not move (${plain.moved})`);
    assert.ok(
      plainHurt.moved < plain.moved * 0.85,
      `plain crawl skipped injury and wet floor (${plainHurt.moved} vs ${plain.moved})`,
    );
  });

  test('an irritant crawl on a stair applies injury and a wet floor', () => {
    const verts: Vec2[] = [
      { x: 0, y: 0 },
      { x: 40, y: 0 },
      { x: 40, y: 20 },
      { x: 0, y: 20 },
    ];
    const ground: LevelDef = {
      id: 'G',
      name: 'G',
      index: 0,
      heightM: 4,
      designed: true,
      pedestrianCount: 0,
    };
    const stair: Stairwell = {
      id: 's',
      pos: { x: 10, y: 10 },
      connectsFloors: [0, 1],
      blocked: false,
      label: 'S',
      kind: 'stair',
      widthM: 1.2,
      levels: { from: 'G', to: 'L1' },
    };
    const duration = (injury?: 'minor', wet?: boolean) => {
      const eng = new PolygonEvacuationEngine(
        {
          vertices: verts,
          pedestrianCount: 0,
          pedestrianRadius: 0.25,
          desiredSpeed: 1.4,
          panicFactor: 0,
          dt: 1 / 60,
        },
        [],
        [],
        [],
        undefined,
        {
          ids: ['G', 'L1'],
          exitsByLevel: { G: [], L1: [] },
          wallsByLevel: { G: [], L1: [] },
          stairs: [stair],
          counts: { G: 0, L1: 0 },
          heights: { G: 4, L1: 4 },
        },
      );
      if (wet) {
        const hazard = new HazardField([{ id: 'wet', simPos: { x: 10, y: 10 }, indoor: true }]);
        hazard.setStates(new Map([['wet', { smoke: 0, fire: { state: 'none' }, wet: true }]]));
        eng.setHazardField(hazard);
      }
      const occ = {
        label: {
          kind: 'pedestrian' as const,
          pedId: 1,
          evacuated: false,
          targetExitId: '',
          fumeHeld: true,
          posture: 'stand' as const,
          injury,
          level: 'G',
        },
        stairId: 's',
        dir: 'up' as const,
        fromLevel: 'G',
        toLevel: 'L1',
        phase: 'queue' as const,
        enqueuedAt: 0,
        travelStart: 0,
        travelDuration: 0,
      };
      (eng as unknown as { beginTravel(person: typeof occ): void }).beginTravel(occ);
      const travelled = occ.travelDuration;
      eng.destroy();
      return travelled;
    };
    const base = stairTravelS(ground, 'up');
    const dry = duration();
    const hurt = duration('minor', true);
    const dryExpected = base / LEVEL.STAIR_CRAWL_FACTOR;
    const hurtExpected =
      base / (LEVEL.STAIR_CRAWL_FACTOR * SHOWCASE.MINOR_INJURY_SPEED_FACTOR * WET_FLOOR_SPEED);
    assert.ok(Math.abs(dry - dryExpected) < 1e-6, `dry stair ${dry} vs ${dryExpected}`);
    assert.ok(Math.abs(hurt - hurtExpected) < 1e-6, `hurt stair ${hurt} vs ${hurtExpected}`);
    assert.ok(hurt > dry * 2, `stair crawl did not slow (${hurt} vs ${dry})`);
  });
});

/** Steps of 1 s until the capped integral reaches the fuel load. */
function stepsUntilLoad(cell: Parameters<typeof fuelEnergyKj>[0], fraction: number): number {
  const load = fuelEnergyKj(cell);
  let spent = 0;
  let t = 0;
  while (spent < load && t < 100000) {
    t += 1;
    spent += releaseEnergyKj(cell, t - 1, t) * fraction;
  }
  return t;
}

describe('capped pyrolysis for soot, gas, and burnout', () => {
  test('φ above 2 scales the soot and the gas, and φ of 2 does not', () => {
    const cell = { ...WOOD, alphaKwS2: 1, spreadMPerMin: 0 };
    const rich = fireSim(new Map([['rich', cell]]));
    // The oxygen share is 0.1 and φ is 7, so a test that scales by the
    // burned fraction instead of 2/φ fails this on purpose.
    rich.setBurnLimit(['rich'], 0.1, 7);
    rich.step(2, [], []);
    const release = rich.fuelReleaseKw('rich') ?? 0;
    assert.ok(release > 1, `release ${release}`);
    const soot = rich.burningSoot()[0]?.sootGPerS ?? 0;
    const co = rich.fumeSources()[0]?.gramsPerS.CO ?? 0;
    const capped = release * (2 / 7);
    const expectedSoot = sootProductionGPerS(cell, capped);
    const expectedCo = speciesProductionGPerS(cell, capped, 7).CO ?? 0;
    assert.ok(
      Math.abs(soot - expectedSoot) / expectedSoot < 1e-6,
      `soot ${soot} vs ${expectedSoot}`,
    );
    assert.ok(Math.abs(co - expectedCo) / expectedCo < 1e-6, `CO ${co} vs ${expectedCo}`);
    const full = sootProductionGPerS(cell, release);
    const burned = sootProductionGPerS(cell, release * 0.1);
    assert.ok(soot < full * 0.5, `soot stayed on the free-burn release (${soot} vs ${full})`);
    assert.ok(soot > burned * 2, `soot followed the burned fraction (${soot} vs ${burned})`);

    const atCap = fireSim(new Map([['cap', cell]]));
    atCap.setBurnLimit(['cap'], 0.5, 2);
    atCap.step(2, [], []);
    const capRelease = atCap.fuelReleaseKw('cap') ?? 0;
    const capSoot = atCap.burningSoot()[0]?.sootGPerS ?? 0;
    assert.ok(
      Math.abs(capSoot - sootProductionGPerS(cell, capRelease)) < 1e-6,
      'φ = 2 reduced the mass',
    );

    const mild = fireSim(new Map([['mild', cell]]));
    mild.setBurnLimit(['mild'], 0.9, 1.2);
    mild.step(2, [], []);
    const mildRelease = mild.fuelReleaseKw('mild') ?? 0;
    const mildSoot = mild.burningSoot()[0]?.sootGPerS ?? 0;
    assert.ok(
      Math.abs(mildSoot - sootProductionGPerS(cell, mildRelease)) < 1e-6,
      'φ under 2 reduced the mass',
    );
  });

  test('no fresh air pyrolyses nothing, and the fuel timer waits', () => {
    const cell = { ...WOOD, alphaKwS2: 1, spreadMPerMin: 0 };
    const sim = fireSim(new Map([['a', cell]]));
    sim.setBurnLimit(['a'], 0, Number.POSITIVE_INFINITY);
    const timer = sim.states.get('a')?.timer ?? 0;
    sim.step(5, [], []);
    assert.equal(sim.states.get('a')?.state, 'burning');
    assert.equal(sim.states.get('a')?.timer, timer);
    assert.equal(sim.burningSoot().length, 0);
    assert.equal(sim.fumeSources().length, 0);
  });

  test('a starved stud burns out when the capped kilojoules reach the load', () => {
    const cell = { ...WOOD, alphaKwS2: 0.05, fuelLoadKgM2: 0.02, spreadMPerMin: 0 };
    const life = burnoutSec(cell);
    const fraction = 2 / 4;
    const at = stepsUntilLoad(cell, fraction);
    const schedule = Math.ceil(life / fraction);
    assert.ok(life > 5 && life < 120, `burnout ${life}`);
    assert.ok(at + 5 < schedule, `energy ${at}s is not inside the schedule ${schedule}s`);
    const free = fireSim(new Map([['free', cell]]));
    const rich = fireSim(new Map([['rich', cell]]));
    // The oxygen share is 0.1, not 2/φ, so a burned-fraction clock fails too.
    rich.setBurnLimit(['rich'], 0.1, 4);
    runSim(free, Math.ceil(life));
    assert.equal(free.states.get('free')?.state, 'burnt_out');
    runSim(rich, at - 1);
    assert.equal(rich.states.get('rich')?.state, 'burning', `out at ${at - 1}s`);
    rich.step(1, [], []);
    assert.equal(
      rich.states.get('rich')?.state,
      'burnt_out',
      `still burning at ${at}s; the schedule would reach ${schedule}s`,
    );
  });

  test('a light stud held at φ 7 on the rise pyrolyses its load, not the stretched schedule', () => {
    const cell = { ...WOOD, spreadMPerMin: 0 };
    const fraction = 2 / 7;
    const life = burnoutSec(cell);
    const load = fuelEnergyKj(cell);
    const schedule = life / fraction;
    const over = (releaseEnergyKj(cell, 0, schedule) * fraction) / load;
    assert.ok(over > 1.2, `schedule spends ${over} of the load; this is not the rise gap`);
    const at = stepsUntilLoad(cell, fraction);
    assert.ok(at < schedule * 0.9, `energy ${at}s vs schedule ${schedule.toFixed(0)}s`);
    const sim = fireSim(new Map([['a', cell]]));
    sim.setBurnLimit(['a'], 0.1, 7);
    runSim(sim, at - 1);
    assert.equal(sim.states.get('a')?.state, 'burning', `out at ${at - 1}s`);
    sim.step(1, [], []);
    assert.equal(sim.states.get('a')?.state, 'burnt_out', `still burning at ${at}s`);
    const spent = releaseEnergyKj(cell, 0, at) * fraction;
    const step = releaseEnergyKj(cell, at - 1, at) * fraction;
    assert.ok(spent + 1e-2 >= load, `spent ${spent} under the load ${load}`);
    assert.ok(
      spent - load <= step + 1e-2,
      `spent ${spent} overshoots the load ${load} by more than one step`,
    );
  });

  test('the layer soot is the capped pyrolysis after the limit is cleared', () => {
    const cell = {
      ...WOOD,
      alphaKwS2: 2,
      sootYieldGPerG: 0.2,
      spreadMPerMin: 0,
      fuelLoadKgM2: 40,
    };
    const engine = new SpatialEffectsEngine(undefined, 1);
    engine.init([stud('a', 0, 0), stud('b', 3, 0), stud('out', 6, 0)]);
    engine.setStoreyHeights({ G: 2.6 });
    engine.setFuelCells(new Map([['a', cell]]));
    const walls = [
      wall(-1.5, 1.5, 4.5, 1.5),
      wall(-1.5, -1.5, 4.5, -1.5),
      wall(-1.5, -1.5, -1.5, 1.5),
      wall(4.5, -1.5, 4.5, 1.5, true),
    ];
    const fire = (
      engine as unknown as {
        fireSim: {
          ignite: (ids: string[]) => void;
          setBurnLimit: (ids: string[], fraction: number, phi: number) => void;
          fuelReleaseKw: (id: string) => number | null;
        };
      }
    ).fireSim;
    fire.ignite(['a']);
    const layerOf = () =>
      [
        ...(
          engine as unknown as {
            layerState: Map<string, { active: boolean; zone: { sootG: number } }>;
          }
        ).layerState.values(),
      ].find((row) => row.active);
    let formed = false;
    for (let t = 0; t < 40 && !formed; t++) {
      engine.step(1, walls, []);
      formed = layerOf() != null;
    }
    assert.ok(formed, 'the room did not form a layer');
    const live = layerOf();
    assert.ok(live);
    live.zone.sootG = 0;
    fire.setBurnLimit(['a'], 0.1, 8);
    engine.step(1, walls, []);
    const release = fire.fuelReleaseKw('a') ?? 0;
    const capped = sootProductionGPerS(cell, release * (2 / 8));
    const full = sootProductionGPerS(cell, release);
    const gained = layerOf()?.zone.sootG ?? 0;
    assert.ok(full > capped * 2, `uncapped ${full} is not above the cap ${capped}`);
    assert.ok(
      Math.abs(gained - capped) / capped < 0.08,
      `layer soot ${gained}, capped ${capped}, free-burn ${full}`,
    );
  });
});

describe('food court with no fire', () => {
  test('five minutes of the food court produces no fumes and no dose', () => {
    const polygon = foodCourtSample.scene.buildingPolygon.map(
      (pair) => [pair[0], pair[1]] as [number, number],
    );
    const studs = projectSceneStuds(polygon, generateSceneStuds(polygon, 0, ['G']));
    const placed = snapObjects(studs);
    const asFire = studs.map((item) => ({
      id: item.id,
      simPos: item.simPos,
      spatialContext: item.spatialContext,
      level: item.floor === 'Ground' ? 'G' : item.floor,
    }));
    const fuel = confirmedFuelCells(placed, asFire);
    const walls = foodCourtSample.scene.interiorWalls as unknown as InteriorWall[];
    const engine = new SpatialEffectsEngine(undefined, 1);
    engine.init(asFire);
    engine.setFuelCells(fuel);
    engine.setGasLines(confirmedGasLines(placed));
    engine.setSuppression(confirmedSuppression(placed, { G: 4 }));
    for (let t = 0; t < 300; t++) engine.step(1, walls, []);
    assert.equal(engine.fumeSources().length, 0);
    for (const state of engine.studStates.values()) {
      assert.equal(state.fire.state, 'none');
      assert.equal(state.fumes, undefined);
    }
    assert.equal(advanceFed(0, undefined, 300), 0);
  });
});

function snapObjects(
  studs: Array<{ id: string; simPos: { x: number; y: number }; floor: string }>,
): PlacedObject[] {
  return snapObjectsToStuds(
    foodCourtPlacedObjects(),
    studs.map((item) => ({ id: item.id, simPos: item.simPos, level: item.floor })),
  );
}

function distance(fumes: { CO?: number; acrolein?: number } | undefined): number {
  return walk([{ fumes, steps: 180 }]).moved;
}

function doseOver(frameDt: number, frames: number): { fed: number; ppm: number; smoke: number } {
  const engine = effects(new Map([['a', WOOD]]));
  const acc = createAccumulator();
  let fed = 0;
  for (let i = 0; i < frames; i++) {
    stepEffectsFixed(engine, acc, frameDt, 1, [], [], () => {
      fed = advanceFed(fed, engine.studStates.get('a')?.fumes, FX.EFFECTS_DT);
    });
  }
  return {
    fed,
    ppm: engine.studStates.get('a')?.fumes?.CO ?? 0,
    smoke: engine.studStates.get('a')?.smoke ?? 0,
  };
}

function walk(
  phases: Array<{ fumes?: { CO?: number; acrolein?: number }; steps: number }>,
  opts: { injury?: 'minor'; wet?: boolean; showcase?: boolean } = {},
): {
  moved: number;
  state: string;
  fumeHeld?: boolean;
  fumeDown?: boolean;
  injury?: string;
  posture?: Posture;
  fumeHeldCount: number;
  fumeDownCount: number;
} {
  const verts: Vec2[] = [
    { x: 0, y: 0 },
    { x: 40, y: 0 },
    { x: 40, y: 20 },
    { x: 0, y: 20 },
  ];
  const exit: ExitDef = {
    id: 'east',
    edgeIndex: 1,
    position: 0.5,
    width: 4,
    center: { x: 40, y: 10 },
  };
  const eng = new PolygonEvacuationEngine(
    {
      vertices: verts,
      pedestrianCount: 1,
      pedestrianRadius: 0.25,
      desiredSpeed: 1.4,
      panicFactor: 0,
      dt: 1 / 60,
    },
    [exit],
    [],
    [],
    opts.showcase === false ? undefined : { afterExit: 'disperse', zones: [], seed: 1 },
  );
  const studs = [];
  const states = new Map<
    string,
    { smoke: number; fire: { state: string }; fumes?: { CO?: number; acrolein?: number } }
  >();
  for (let x = 0; x <= 40; x += 3) {
    const id = `s${x}`;
    studs.push({ id, simPos: { x, y: 10 }, indoor: true });
    states.set(id, { smoke: 0, fire: { state: 'none' }, wet: opts.wet === true });
  }
  const hazard = new HazardField(studs);
  hazard.setStates(states);
  eng.setHazardField(hazard);
  eng.setHazardFields(new Map([['G', hazard]]));
  const body = (eng as unknown as { pedestrians: Matter.Body[] }).pedestrians[0];
  Matter.Body.setPosition(body, { x: 8, y: 10 });
  Matter.Body.setVelocity(body, { x: 0, y: 0 });
  const ped = (
    body as Matter.Body & {
      __ped: {
        state: string;
        targetExitId: string;
        nextCheckAt: number;
        posture: Posture;
        fumeHeld?: boolean;
        fumeDown?: boolean;
        injury?: 'none' | 'minor' | 'serious' | 'lethal';
        level?: string;
      };
    }
  ).__ped;
  ped.state = 'evacuating';
  ped.targetExitId = 'east';
  ped.nextCheckAt = 1e9;
  ped.posture = 'stand';
  ped.level = 'G';
  if (opts.injury) ped.injury = opts.injury;
  const start = body.position.x;
  for (const phase of phases) {
    for (const state of states.values()) {
      if (phase.fumes) state.fumes = phase.fumes;
      else delete state.fumes;
    }
    for (let i = 0; i < phase.steps; i++) eng.step();
  }
  const metrics = eng.getMetrics().showcase;
  const result = {
    moved: body.position.x - start,
    state: ped.state,
    fumeHeld: ped.fumeHeld,
    fumeDown: ped.fumeDown,
    injury: ped.injury,
    posture: ped.posture,
    fumeHeldCount: metrics?.fumeHeld ?? 0,
    fumeDownCount: metrics?.fumeDown ?? 0,
  };
  eng.destroy();
  return result;
}
