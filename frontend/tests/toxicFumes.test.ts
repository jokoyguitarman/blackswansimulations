import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import Matter from 'matter-js';
import { PolygonEvacuationEngine } from '../src/lib/evacuation/engine';
import { HazardField, type Posture } from '../src/lib/evacuation/hazardSensing';
import type { ExitDef, Vec2 } from '../src/lib/evacuation/types';
import { GAS_JET_KW, WOOD_HEAT_KJ_KG } from '../src/lib/rts/flameFront';
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
import { SpatialEffectsEngine } from '../src/lib/rts/spatialEffects';
import {
  BREATH_LAYER_M,
  FEC_F_PPM,
  FED_CO_PPM_MIN,
  FED_HCN_DIVISOR,
  FED_HCN_PER_MIN,
  INCAP_DOSE,
  MOLAR_VOLUME_L,
  STUD_TURNOVER_S,
  advanceFed,
  doseIncapacitates,
  fecOf,
  fedPerMin,
  fumesPpm,
  speciesProductionGPerS,
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
    assert.equal(doseIncapacitates(0.99, 0), false);
    assert.equal(doseIncapacitates(1, 0), true);
    assert.equal(INCAP_DOSE, 1);
  });

  test('clean air adds no dose, and hydrogen cyanide uses the fire-gas term only while it is present', () => {
    assert.equal(advanceFed(0.2, {}, 300), 0.2);
    assert.equal(advanceFed(0.2, undefined, 300), 0.2);
    assert.equal(fedPerMin({ HCN: 0 }), 0);
    const perMin = Math.exp(FED_HCN_DIVISOR / FED_HCN_DIVISOR) / FED_HCN_PER_MIN;
    assert.ok(Math.abs(fedPerMin({ HCN: FED_HCN_DIVISOR }) - perMin) < 1e-12);
    assert.ok(Math.abs(advanceFed(0, { HCN: FED_HCN_DIVISOR }, 60) - perMin) < 1e-12);
  });

  test('irritants use the ISO F values and do not accumulate', () => {
    assert.equal(FEC_F_PPM.HCl, 1000);
    assert.equal(FEC_F_PPM.acrolein, 30);
    assert.ok(Math.abs(fecOf({ HCl: 1000 }) - 1) < 1e-12);
    assert.ok(Math.abs(fecOf({ acrolein: 30 }) - 1) < 1e-12);
    assert.ok(Math.abs(fecOf({ HCl: 500, acrolein: 15 }) - 1) < 1e-12);
    assert.equal(doseIncapacitates(0, 0.99), false);
    assert.equal(doseIncapacitates(0, 1), true);
    assert.equal(fecOf({}), 0);
  });

  test('production is yield times mass-loss rate, and a cell with no yield emits nothing', () => {
    const grams = speciesProductionGPerS(WOOD, WOOD_HEAT_KJ_KG);
    assert.ok(Math.abs((grams.CO ?? 0) - 100) < 1e-9, `CO ${grams.CO}`);
    assert.equal(grams.HCN, undefined);
    assert.equal(grams.acrolein, undefined);
    assert.deepEqual(speciesProductionGPerS(WOOD, 0), {});
    const bare = { ...WOOD };
    delete bare.toxicYieldGPerG;
    assert.deepEqual(speciesProductionGPerS(bare, 1000), {});
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
    assert.deepEqual(wood.toxicYieldGPerG, { CO: 0.1 });
    assert.deepEqual(foam.toxicYieldGPerG, { CO: 0.1, HCN: 0.01 });
    assert.deepEqual(pvc.toxicYieldGPerG, { HCl: 0.2, CO: 0.1 });
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
  test('the stud ppm is the production diluted by the smoke that is already there', () => {
    const engine = effects(new Map([['a', WOOD]]));
    engine.step(40, [], []);
    const state = engine.studStates.get('a');
    const source = engine.fumeSources()[0];
    assert.ok(state && source);
    assert.ok((state.smoke ?? 0) > 0.9, `smoke ${state.smoke}`);
    const expected = fumesPpm(source.gramsPerS, state.smoke);
    assert.ok(Math.abs((state.fumes?.CO ?? 0) - (expected.CO ?? 0)) < 1e-6);
    assert.equal(state.fumes?.acrolein, undefined);
    assert.equal(BREATH_LAYER_M, 2);
    assert.equal(STUD_TURNOVER_S, 300);
    assert.ok(MOLAR_VOLUME_L > 24 && MOLAR_VOLUME_L < 24.1);
  });

  test('a wall stops the gases and a door gap does not', () => {
    const blocked = new SpatialEffectsEngine(undefined, 1);
    blocked.init([stud('a', 0, 0), stud('far', 3, 0)]);
    blocked.setFuelCells(new Map([['a', WOOD]]));
    (blocked as unknown as { fireSim: FireSimulation }).fireSim.ignite(['a']);
    const barrier = wall(1.5, -5, 1.5, 5);
    for (let t = 0; t < 60; t++) blocked.step(1, [barrier], []);
    assert.ok((blocked.studStates.get('a')?.fumes?.CO ?? 0) > 0);
    assert.equal(blocked.studStates.get('far')?.fumes, undefined);

    const open = new SpatialEffectsEngine(undefined, 1);
    open.init([stud('a', 0, 0), stud('far', 3, 0)]);
    open.setFuelCells(new Map([['a', WOOD]]));
    (open as unknown as { fireSim: FireSimulation }).fireSim.ignite(['a']);
    for (let t = 0; t < 60; t++) open.step(1, [wall(1.5, -5, 1.5, 5, true)], []);
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
    const bareG = bare.fumeSources()[0]?.gramsPerS.CO ?? 0;
    const sprayG = sprayed.fumeSources()[0]?.gramsPerS.CO ?? 0;
    const bareQ = bare.fuelReleaseKw('a') ?? 0;
    const sprayQ = sprayed.fuelReleaseKw('a') ?? 0;
    assert.ok(sprayG < bareG * 0.95, `suppressed ${sprayG}, bare ${bareG}`);
    assert.ok(Math.abs(sprayG / sprayQ - bareG / bareQ) / (bareG / bareQ) < 0.01);

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

  test('a fryer fire puts an incapacitating dose in its own smoke', () => {
    const engine = new SpatialEffectsEngine(undefined, 1);
    engine.init([stud('pan', 0, 0), stud('next', 3, 0)]);
    engine.setFuelCells(new Map([['pan', OIL]]));
    (engine as unknown as { fireSim: FireSimulation }).fireSim.ignite(['pan']);
    let t = 0;
    while (fecOf(engine.studStates.get('pan')?.fumes) < 1 && t < 120) {
      engine.step(1, [], []);
      t += 1;
    }
    assert.ok(t < 90, `pan FEC reached 1 at ${t}`);
    while (fecOf(engine.studStates.get('next')?.fumes) < 1 && t < 120) {
      engine.step(1, [], []);
      t += 1;
    }
    assert.ok(t < 120, `neighbour still under 1 at ${t}`);
    assert.equal(engine.studStates.get('pan')?.fumes?.CO, undefined);
  });
});

describe('people', () => {
  test('an irritant fraction of 1 puts them down, and a small dose does not change their pace', () => {
    const clean = distance(undefined);
    const dosing = distance({ CO: 200 });
    assert.ok(clean > 0.3, `did not walk (${clean})`);
    assert.ok(Math.abs(dosing - clean) / clean < 0.02, `pace ${dosing} vs ${clean}`);

    const dropped = walk({ acrolein: 30 }, 5);
    assert.equal(dropped.state, 'down');
    assert.equal(dropped.fumeDown, true);
    assert.equal(dropped.injury, 'serious');
    assert.ok(dropped.moved < 0.05, `still walking (${dropped.moved})`);
    assert.equal(dropped.fumeDownCount, 1);
  });
});

describe('food court with no fire', () => {
  test('five minutes of the food court produces no fumes and no dose', () => {
    const polygon = foodCourtSample.scene.buildingPolygon.map((pair) => [pair[0], pair[1]] as [number, number]);
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
  return walk(fumes, 180).moved;
}

function walk(
  fumes: { CO?: number; acrolein?: number } | undefined,
  steps: number,
): { moved: number; state: string; fumeDown?: boolean; injury?: string; fumeDownCount: number } {
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
    { vertices: verts, pedestrianCount: 1, pedestrianRadius: 0.25, desiredSpeed: 1.4, panicFactor: 0, dt: 1 / 60 },
    [exit],
    [],
    [],
    { afterExit: 'disperse', zones: [], seed: 1 },
  );
  const studs = [];
  const states = new Map<string, { smoke: number; fire: { state: string }; fumes?: { CO?: number; acrolein?: number } }>();
  for (let x = 0; x <= 40; x += 3) {
    const id = `s${x}`;
    studs.push({ id, simPos: { x, y: 10 }, indoor: true });
    states.set(id, { smoke: 0, fire: { state: 'none' }, ...(fumes ? { fumes } : {}) });
  }
  const hazard = new HazardField(studs);
  hazard.setStates(states);
  eng.setHazardField(hazard);
  const body = (eng as unknown as { pedestrians: Matter.Body[] }).pedestrians[0];
  Matter.Body.setPosition(body, { x: 8, y: 10 });
  Matter.Body.setVelocity(body, { x: 0, y: 0 });
  const ped = (body as Matter.Body & {
    __ped: { state: string; targetExitId: string; nextCheckAt: number; posture: Posture; fumeDown?: boolean; injury?: string };
  }).__ped;
  ped.state = 'evacuating';
  ped.targetExitId = 'east';
  ped.nextCheckAt = 1e9;
  ped.posture = 'stand';
  const start = body.position.x;
  for (let i = 0; i < steps; i++) eng.step();
  const metrics = eng.getMetrics().showcase;
  const result = {
    moved: body.position.x - start,
    state: ped.state,
    fumeDown: ped.fumeDown,
    injury: ped.injury,
    fumeDownCount: metrics?.fumeDown ?? 0,
  };
  eng.destroy();
  return result;
}
