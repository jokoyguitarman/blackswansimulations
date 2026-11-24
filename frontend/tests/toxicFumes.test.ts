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
  fedPerMin,
  fumesFromSmoke,
  sootProductionGPerS,
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
    const well = speciesProductionGPerS(WOOD, WOOD_HEAT_KJ_KG, false);
    assert.ok(Math.abs((well.CO ?? 0) - 4) < 1e-9, `well-vent CO ${well.CO}`);
    const flashed = speciesProductionGPerS(WOOD, WOOD_HEAT_KJ_KG, true);
    assert.ok(Math.abs((flashed.CO ?? 0) - 100) < 1e-9, `post-flashover CO ${flashed.CO}`);
    assert.equal(flashed.HCN, undefined);
    assert.equal(flashed.acrolein, undefined);
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
    assert.deepEqual(wood.toxicYieldGPerG, { CO: 0.1 });
    assert.equal(foam.sootYieldGPerG, 0.188);
    assert.deepEqual(foam.toxicYieldWellVentGPerG, { CO: 0.01, HCN: 0.01 });
    assert.deepEqual(foam.toxicYieldGPerG, { CO: 0.1, HCN: 0.01 });
    assert.equal(pvc.sootYieldGPerG, 0.172);
    assert.deepEqual(pvc.toxicYieldWellVentGPerG, { HCl: 0.2, CO: 0.06 });
    assert.deepEqual(pvc.toxicYieldGPerG, { HCl: 0.2, CO: 0.1 });
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
    for (let i = 0; i < 400; i++) engine.step(0.1, [], []);
    const state = engine.studStates.get('a');
    const far = engine.studStates.get('far');
    const source = engine.fumeSources()[0];
    assert.ok(state && far && source);
    assert.equal(source.gramsPerS.acrolein, undefined);
    const expected = fumesFromSmoke(state.smoke ?? 0, source.gramsPerS, source.sootGPerS);
    assert.ok(Math.abs((state.fumes?.CO ?? 0) - (expected.CO ?? 0)) < 1e-6);
    assert.ok((state.fumes?.CO ?? 0) < 250, `source CO ${state.fumes?.CO}`);
    const farExpected = fumesFromSmoke(far.smoke ?? 0, source.gramsPerS, source.sootGPerS);
    assert.ok(Math.abs((far.fumes?.CO ?? 0) - (farExpected.CO ?? 0)) < 1e-6);
    if ((far.smoke ?? 0) < (state.smoke ?? 0)) {
      assert.ok((far.fumes?.CO ?? 0) < (state.fumes?.CO ?? 0));
    }
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

  test('the concentration a person breathes falls after a hood opens', () => {
    const hooded = effects(new Map([['a', OIL]]), [], [head('c', 0, 0, 'wet_chemical')]);
    const bare = effects(new Map([['a', OIL]]));
    let t = 0;
    while (hooded.suppressionState('c')?.open !== true && t < 180) {
      hooded.step(1, [], []);
      bare.step(1, [], []);
      t += 1;
    }
    assert.ok(t < 180, 'hood did not open');
    const opened = hooded.studStates.get('a')?.fumes?.acrolein ?? 0;
    assert.ok(opened > 0, 'no acrolein when the hood opened');
    let later = opened;
    let fellAt = -1;
    for (let i = 0; i < 1600; i++) {
      hooded.step(1, [], []);
      bare.step(1, [], []);
      later = hooded.studStates.get('a')?.fumes?.acrolein ?? 0;
      if (later < opened * 0.8) {
        fellAt = i + 1;
        break;
      }
    }
    const bareLater = bare.studStates.get('a')?.fumes?.acrolein ?? 0;
    assert.ok(fellAt > 0, `ppm stayed ${later} from ${opened}`);
    assert.ok(bareLater > later, `bare ${bareLater}, hood ${later}`);
    assert.ok((bare.studStates.get('a')?.smoke ?? 0) > (hooded.studStates.get('a')?.smoke ?? 0));
  });

  test('a fryer fire reaches an irritant fraction of 1 in its own smoke, and the gas stays bounded', () => {
    const engine = new SpatialEffectsEngine(undefined, 1);
    engine.init([stud('pan', 0, 0), stud('next', 3, 0)]);
    engine.setFuelCells(new Map([['pan', OIL]]));
    (engine as unknown as { fireSim: FireSimulation }).fireSim.ignite(['pan']);
    let t = 0;
    while (fecOf(engine.studStates.get('pan')?.fumes) < 1 && t < 120) {
      engine.step(0.1, [], []);
      t += 0.1;
    }
    assert.ok(t < 90, `pan FEC reached 1 at ${t}`);
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

  test('flashover switches the gas yield, and the dose does not depend on the frame size', () => {
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
    const expected = (0.1 * 1000) / WOOD_HEAT_KJ_KG;
    assert.ok(Math.abs(perKw - expected) / expected < 0.01, `post-flashover ${perKw}`);

    const fine = doseOver(0.1, 300);
    const coarse = doseOver(1, 30);
    assert.ok(Math.abs(fine.fed - coarse.fed) < 1e-9, `FED ${fine.fed} vs ${coarse.fed}`);
    assert.ok(Math.abs(fine.ppm - coarse.ppm) < 1e-9, `ppm ${fine.ppm} vs ${coarse.ppm}`);
    assert.ok(fine.fed > 0);
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
    const resumed = walk([
      { fumes: { acrolein: 30 }, steps: 30 },
      { steps: 180 },
    ]);
    assert.equal(resumed.state, 'evacuating');
    assert.notEqual(resumed.fumeHeld, true);
    assert.equal(resumed.posture, 'stand');
    assert.ok(resumed.moved > stayed.moved, `did not speed up (${resumed.moved} vs ${stayed.moved})`);

    const down = walk([
      { fumes: { CO: 200_000_000 }, steps: 5 },
      { steps: 60 },
    ]);
    assert.equal(down.state, 'down');
    assert.equal(down.fumeDown, true);
    assert.equal(down.injury, 'serious');
    assert.equal(down.fumeDownCount, 1);
    assert.ok(down.moved < 0.05, `a downed person walked (${down.moved})`);
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
  return walk([{ fumes, steps: 180 }]).moved;
}

function doseOver(frameDt: number, frames: number): { fed: number; ppm: number } {
  const engine = effects(new Map([['a', WOOD]]));
  const acc = createAccumulator();
  let fed = 0;
  for (let i = 0; i < frames; i++) {
    stepEffectsFixed(engine, acc, frameDt, 1, [], [], () => {
      fed = advanceFed(fed, engine.studStates.get('a')?.fumes, FX.EFFECTS_DT);
    });
  }
  return { fed, ppm: engine.studStates.get('a')?.fumes?.CO ?? 0 };
}

function walk(
  phases: Array<{ fumes?: { CO?: number; acrolein?: number }; steps: number }>,
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
    states.set(id, { smoke: 0, fire: { state: 'none' } });
  }
  const hazard = new HazardField(studs);
  hazard.setStates(states);
  eng.setHazardField(hazard);
  const body = (eng as unknown as { pedestrians: Matter.Body[] }).pedestrians[0];
  Matter.Body.setPosition(body, { x: 8, y: 10 });
  Matter.Body.setVelocity(body, { x: 0, y: 0 });
  const ped = (body as Matter.Body & {
    __ped: {
      state: string;
      targetExitId: string;
      nextCheckAt: number;
      posture: Posture;
      fumeHeld?: boolean;
      fumeDown?: boolean;
      injury?: string;
    };
  }).__ped;
  ped.state = 'evacuating';
  ped.targetExitId = 'east';
  ped.nextCheckAt = 1e9;
  ped.posture = 'stand';
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
