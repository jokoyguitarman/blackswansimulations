import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { blastPressureAt, type ChargeSpec } from '../src/lib/rts/blast/blastModel';
import {
  ELECTRICAL_ARC_FLUX_KW_M2,
  ELECTRICAL_IGNITE_M,
  FLAME_STANDOFF_M,
  GAS_JET_KW,
  GAS_RUPTURE_KPA,
  electricalHeatReleaseKw,
  pointSourceFluxKwM2,
} from '../src/lib/rts/flameFront';
import { FireSimulation, type FireSimStud } from '../src/lib/rts/fireSimulation';
import {
  confirmedElectricalSources,
  confirmedGasLines,
  defaultLightFuel,
  matchMaterials,
  snapObjectsToStuds,
  type PlacedObject,
} from '../src/lib/rts/materialLibrary';
import { foodCourtPlacedObjects, foodCourtSample } from '../src/lib/rts/foodCourtSample';
import { generateSceneStuds, projectSceneStuds } from '../src/lib/rts/sceneStuds';
import { SpatialEffectsEngine } from '../src/lib/rts/spatialEffects';
import type { HazardZone, InteriorWall } from '../src/lib/rts/types';

/**
 * 10 kg TNT, surface burst. Unknown in the editor is the same TNT factor.
 * The rupture test picks distances from blastPressureAt, not from a guessed range.
 */
const TNT10: ChargeSpec = { presetKey: 'tnt', amountKg: 10, burst: 'surface', heightM: 1.5 };

function stud(id: string, x: number, y: number, level = 'G', indoor = true): FireSimStud {
  return {
    id,
    simPos: { x, y },
    spatialContext: indoor ? 'inside_building' : 'open_air',
    level,
  };
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

function line(id: string, x: number, y: number, valve: number | null = null, level = 'G') {
  return { id, pos: { x, y }, level, autoShutoffSec: valve };
}

/** A pipe at the origin, wood one stud east, and a stud two steps further. */
function scene(valve: number | null = null) {
  const sim = new FireSimulation();
  sim.init([stud('pipe-stud', 0, 0), stud('wood', 3, 0), stud('far', 9, 0), stud('other', 6, 0)]);
  sim.setFuelCells(
    new Map([
      ['wood', defaultLightFuel()],
      ['far', defaultLightFuel()],
      ['other', defaultLightFuel()],
    ]),
  );
  sim.setBlastCharge(TNT10);
  const pipe = line('pipe', 0, 0, valve);
  sim.setGasLines([pipe]);
  return { sim, pipe };
}

function doseOf(sim: FireSimulation, id = 'wood'): number {
  return sim.states.get(id)?.dose ?? 0;
}

/** setGasLines every step, the way the page does, without dropping the valve. */
function run(
  sim: FireSimulation,
  dt: number,
  total: number,
  walls: InteriorWall[] = [],
  pipe = line('pipe', 0, 0, null),
) {
  let t = 0;
  while (t + 1e-9 < total) {
    const step = Math.min(dt, total - t);
    sim.setGasLines([pipe]);
    sim.setBlastCharge(TNT10);
    sim.step(step, walls, []);
    t += step;
  }
}

describe('gas rupture and the jet', () => {
  test('the rupture pressure is the cited tank-failure onset', () => {
    assert.equal(GAS_RUPTURE_KPA, 20.7);
    const atStud = pointSourceFluxKwM2(GAS_JET_KW, 3);
    const twoStuds = pointSourceFluxKwM2(GAS_JET_KW, 6);
    assert.ok(atStud > 10, `3 m flux ${atStud} should be above the wood critical flux`);
    assert.ok(twoStuds < 10, `6 m flux ${twoStuds} should be under the wood critical flux`);
  });

  test('pressure below 20.7 kPa does not open the line, even inside the fireball', () => {
    let far = 1;
    while (blastPressureAt(TNT10, far, false).effectiveKpa >= GAS_RUPTURE_KPA && far < 400) far += 1;
    assert.ok(far < 400, 'expected some range under the rupture pressure');
    assert.ok(blastPressureAt(TNT10, 1, false).effectiveKpa >= GAS_RUPTURE_KPA);

    const sim = new FireSimulation();
    sim.init([stud('wood', far, 3)]);
    sim.setFuelCells(new Map([['wood', defaultLightFuel()]]));
    sim.setBlastCharge(TNT10);
    sim.setGasLines([line('pipe', far, 0)]);
    sim.applyBlast({ x: 0, y: 0 }, far + 5, 'G', []);
    assert.equal(sim.gasLineState('pipe')?.ruptured, false);
    assert.equal(sim.gasJets().length, 0);
    sim.step(30, [], []);
    assert.equal(sim.states.get('wood')?.state, 'none');
  });

  test('a missing charge does not rupture a line standing in the fireball', () => {
    const { sim } = scene();
    sim.setBlastCharge(null);
    sim.applyBlast({ x: 0, y: 0 }, 8, 'G', []);
    assert.equal(sim.gasLineState('pipe')?.ruptured, false);
    assert.equal(sim.gasJets().length, 0);
  });

  test('a rupture outside the fireball, with no flame and no arc, does not jet', () => {
    const { sim } = scene();
    sim.setGasLines([line('pipe', 2, 0)]);
    sim.applyBlast({ x: 0, y: 0 }, 0.4, 'G', []);
    const state = sim.gasLineState('pipe');
    assert.equal(state?.ruptured, true);
    assert.equal(state?.jetting, false);
    sim.step(5, [], []);
    assert.equal(sim.gasJets().length, 0);
    assert.equal(sim.states.get('wood')?.state, 'none');
  });

  test('a rupture inside the fireball jets at that point and heats the next fuel stud', () => {
    const { sim } = scene();
    sim.applyBlast({ x: 0, y: 0 }, 1, 'G', []);
    assert.equal(sim.gasLineState('pipe')?.jetting, true);
    assert.equal(sim.states.get('pipe-stud')?.state, 'none');
    run(sim, 1, 1);
    assert.ok(doseOf(sim) > 0);
    assert.equal(sim.states.get('wood')?.state, 'heating');
    assert.equal(sim.states.get('far')?.state, 'none');
    assert.equal(sim.states.get('other')?.state, 'none');

    let seconds = 1;
    while (sim.states.get('wood')?.state !== 'burning' && seconds < 120) {
      sim.setGasLines([line('pipe', 0, 0)]);
      sim.setBlastCharge(TNT10);
      sim.step(1, [], []);
      seconds += 1;
    }
    assert.equal(sim.states.get('wood')?.state, 'burning');
    assert.ok(seconds > 40 && seconds < 90, `table caught at ${seconds}s`);
    assert.equal(sim.states.get('far')?.state, 'none');
    assert.equal(sim.states.get('other')?.state, 'none');
    assert.equal(sim.states.get('pipe-stud')?.state, 'none');
  });

  test('the jet does not flash the room, and it is not a second explosion', () => {
    const { sim } = scene();
    sim.applyBlast({ x: 0, y: 0 }, 1, 'G', []);
    sim.step(1, [], []);
    assert.equal(sim.states.get('wood')?.state, 'heating');
    assert.notEqual(sim.states.get('other')?.state, 'burning');
    assert.notEqual(sim.states.get('far')?.state, 'burning');
  });

  test('a later flame or a nearby arc lights a ruptured line, and an arc does not light an intact one', () => {
    const dark = new FireSimulation();
    dark.init([stud('spark', 2, 0), stud('wood', 5, 0)]);
    dark.setFuelCells(new Map([['spark', defaultLightFuel()], ['wood', defaultLightFuel()]]));
    dark.setBlastCharge(TNT10);
    dark.setGasLines([line('pipe', 2, 0)]);
    dark.applyBlast({ x: 0, y: 0 }, 0.4, 'G', []);
    assert.equal(dark.gasLineState('pipe')?.jetting, false);
    dark.ignite(['spark']);
    dark.step(0.1, [], []);
    assert.equal(dark.gasLineState('pipe')?.jetting, true);

    const intact = new FireSimulation();
    intact.init([stud('wood', 0, 0)]);
    intact.setFuelCells(new Map([['wood', defaultLightFuel()]]));
    intact.setGasLines([line('pipe', 0, 0)]);
    intact.setElectricalSources([{ id: 'arc', pos: { x: 0, y: 0 }, level: 'G' }]);
    intact.step(1, [], []);
    assert.equal(intact.gasLineState('pipe')?.ruptured, false);
    assert.equal(intact.gasJets().length, 0);

    const arc = new FireSimulation();
    arc.init([stud('wood', 6, 0)]);
    arc.setFuelCells(new Map([['wood', defaultLightFuel()]]));
    arc.setBlastCharge(TNT10);
    arc.setGasLines([line('pipe', 2, 0)]);
    arc.applyBlast({ x: 0, y: 0 }, 0.4, 'G', []);
    assert.equal(arc.gasLineState('pipe')?.ruptured, true);
    assert.equal(arc.gasLineState('pipe')?.jetting, false);
    arc.setElectricalSources([{ id: 'far-arc', pos: { x: 2 + ELECTRICAL_IGNITE_M + 0.4, y: 0 }, level: 'G' }]);
    arc.step(0.1, [], []);
    assert.equal(arc.gasLineState('pipe')?.jetting, false);
    arc.setElectricalSources([{ id: 'near-arc', pos: { x: 2, y: 0 }, level: 'G' }]);
    arc.step(0.1, [], []);
    assert.equal(arc.gasLineState('pipe')?.jetting, true);
  });

  test('shutoff stops the jet and leaves burning fuel alight', () => {
    const { sim } = scene();
    sim.applyBlast({ x: 0, y: 0 }, 1, 'G', []);
    run(sim, 0.1, 2);
    const warmed = doseOf(sim);
    assert.ok(warmed > 0);
    assert.equal(sim.states.get('wood')?.state, 'heating');
    sim.ignite(['far']);
    sim.shutOffGas('pipe');
    assert.equal(sim.gasJets().length, 0);
    sim.setGasLines([line('pipe', 0, 0)]);
    sim.step(10, [], []);
    assert.equal(doseOf(sim), warmed);
    assert.equal(sim.states.get('wood')?.state, 'heating');
    assert.equal(sim.states.get('far')?.state, 'burning');
    assert.equal(sim.gasLineState('pipe')?.shutoff, true);
  });

  test('an automatic valve and a manual shutoff agree across frame sizes', () => {
    const valve = 0.55;
    const total = 1;
    const frames = [0.0167, 0.033, 0.064, 0.1, 1];
    const doses = frames.map((dt) => {
      const { sim } = scene(valve);
      sim.applyBlast({ x: 0, y: 0 }, 1, 'G', []);
      run(sim, dt, total, [], line('pipe', 0, 0, valve));
      return doseOf(sim);
    });
    const open = frames.map((dt) => {
      const { sim } = scene(null);
      sim.applyBlast({ x: 0, y: 0 }, 1, 'G', []);
      run(sim, dt, total);
      return doseOf(sim);
    });
    for (const dose of doses) {
      assert.ok(Math.abs(dose - doses[0]!) < 1e-6, `valve doses ${doses.join(', ')}`);
    }
    for (const dose of open) {
      assert.ok(Math.abs(dose - open[0]!) < 1e-6, `open doses ${open.join(', ')}`);
    }
    assert.ok(doses[0]! > 0);
    assert.ok(doses[0]! < open[0]!, 'the valve must cut the dose before the full second');
    const { sim } = scene(valve);
    sim.applyBlast({ x: 0, y: 0 }, 1, 'G', []);
    run(sim, 0.1, total, [], line('pipe', 0, 0, valve));
    assert.equal(sim.gasLineState('pipe')?.shutoff, true);
    assert.equal(sim.gasJets().length, 0);
  });

  test('a solid wall blocks the jet and a door gap does not', () => {
    const blocked = scene();
    blocked.sim.applyBlast({ x: 0, y: 0 }, 1, 'G', []);
    run(blocked.sim, 0.1, 2, [wall(1, -2, 1, 2, false)]);
    assert.equal(doseOf(blocked.sim), 0);

    const open = scene();
    open.sim.applyBlast({ x: 0, y: 0 }, 1, 'G', []);
    run(open.sim, 0.1, 2, [wall(1, -2, 1, 2, true)]);
    assert.ok(doseOf(open.sim) > 0);
  });

  test('a blast on another storey does not open this line', () => {
    const sim = new FireSimulation();
    sim.init([stud('wood', 3, 0, 'G'), stud('up', 3, 0, 'L1')]);
    sim.setFuelCells(new Map([['wood', defaultLightFuel()], ['up', defaultLightFuel()]]));
    sim.setBlastCharge(TNT10);
    sim.setGasLines([line('down', 0, 0, null, 'G'), line('up', 0, 0, null, 'L1')]);
    sim.applyBlast({ x: 0, y: 0 }, 1, 'L1', []);
    assert.equal(sim.gasLineState('down')?.ruptured, false);
    assert.equal(sim.gasLineState('up')?.jetting, true);
    sim.step(5, [], []);
    assert.equal(sim.states.get('wood')?.state, 'none');
    assert.equal(sim.states.get('up')?.state, 'heating');
  });
});

describe('electrical arcs', () => {
  test('the arc is the assumed 20 kW/m² at the standoff and does not reach the next stud', () => {
    const atStand = pointSourceFluxKwM2(electricalHeatReleaseKw(), FLAME_STANDOFF_M);
    const atNext = pointSourceFluxKwM2(electricalHeatReleaseKw(), 3);
    assert.ok(Math.abs(atStand - ELECTRICAL_ARC_FLUX_KW_M2) < 1e-6);
    assert.ok(atNext < 10);
  });

  test('an arc ignites fuel on its stud and leaves a stud 3 m away dark', () => {
    const sim = new FireSimulation();
    sim.init([stud('here', 0, 0), stud('next', 3, 0)]);
    sim.setFuelCells(new Map([['here', defaultLightFuel()], ['next', defaultLightFuel()]]));
    sim.setElectricalSources([{ id: 'fridge', pos: { x: 0.4, y: 0 }, level: 'G' }]);
    let seconds = 0;
    while (sim.states.get('here')?.state !== 'burning' && seconds < 200) {
      sim.step(1, [], []);
      seconds += 1;
    }
    assert.equal(sim.states.get('here')?.state, 'burning');
    assert.ok(seconds > 100 && seconds < 160, `arc lit the stud at ${seconds}s`);
    assert.equal(sim.states.get('next')?.state, 'none');
    assert.equal(sim.gasJets().length, 0);
  });

  test('a blast on an electrical object does not open a pipe that is not there', () => {
    const sim = new FireSimulation();
    sim.init([stud('fridge', 0, 0), stud('wood', 0, 0)]);
    sim.setFuelCells(new Map([['wood', defaultLightFuel()]]));
    sim.setBlastCharge(TNT10);
    sim.setElectricalSources([{ id: 'fridge', pos: { x: 0, y: 0 }, level: 'G' }]);
    sim.applyBlast({ x: 0, y: 0 }, 8, 'G', []);
    assert.equal(sim.gasJets().length, 0);
    sim.step(1, [], []);
    assert.equal(sim.gasJets().length, 0);
  });

  test('an electrical circle passed only as a hazard does not become an arc', () => {
    const sim = new FireSimulation();
    sim.init([stud('wood', 0, 0)]);
    sim.setFuelCells(new Map([['wood', defaultLightFuel()]]));
    const zone: HazardZone = {
      id: 'socket',
      pos: { x: 0, y: 0 },
      radius: 2,
      hazardType: 'electrical',
      severity: 'medium',
      label: 'Electrical',
      description: '',
      photos: [],
    };
    sim.step(30, [], [zone]);
    assert.equal(sim.states.get('wood')?.state, 'none');
    sim.setElectricalSources(confirmedElectricalSources([], [zone]));
    sim.step(1, [], []);
    assert.equal(sim.states.get('wood')?.state, 'heating');
  });
});

describe('the blast event wires the jet without a vapour cloud', () => {
  test('the effects engine ruptures from the fire event and does not spread gas', () => {
    const engine = new SpatialEffectsEngine();
    engine.init([stud('wood', 3, 0), stud('far', 9, 0), stud('pipe-stud', 0, 0)]);
    engine.setFuelCells(new Map([['wood', defaultLightFuel()], ['far', defaultLightFuel()]]));
    engine.setBlastCharge(TNT10);
    engine.setGasLines([line('pipe', 0, 0)]);
    engine.registerHazard(
      'blast-direct',
      [
        {
          triggerTimeSec: 0,
          eventType: 'explode',
          spreadType: 'fire',
          spreadRadius: 1,
          spreadRate: 10,
          description: 'Direct blast ignition',
          severity: 'critical',
        },
      ],
      { initial: 'a', triggered: 'b', worsening: 'c', critical: 'd' },
    );
    const zone: HazardZone = {
      id: 'blast-direct',
      pos: { x: 0, y: 0 },
      radius: 1,
      hazardType: 'ignitable',
      severity: 'high',
      label: 'Blast',
      description: '',
      photos: [],
    };
    engine.step(0.1, [], [zone]);
    assert.equal(engine.gasJets().length, 1);
    assert.equal(engine.studStates.get('wood')?.gas, 0);
    assert.equal(engine.studStates.get('far')?.gas, 0);
    assert.equal(engine.studStates.get('pipe-stud')?.gas, 0);
    assert.ok(engine.activeEffects.every((effect) => effect.type !== 'gas'));
    let seconds = 0.1;
    while (engine.studStates.get('wood')?.fire.state !== 'burning' && seconds < 120) {
      engine.setGasLines([line('pipe', 0, 0)]);
      engine.step(1, [], [zone]);
      seconds += 1;
    }
    assert.equal(engine.studStates.get('wood')?.fire.state, 'burning');
    assert.equal(engine.studStates.get('far')?.fire.state, 'none');
    assert.equal(engine.studStates.get('far')?.gas, 0);
    assert.ok(engine.activeEffects.every((effect) => effect.type !== 'gas'));
    engine.shutOffGas();
    engine.step(5, [], [zone]);
    assert.equal(engine.gasJets().length, 0);
    assert.equal(engine.studStates.get('wood')?.fire.state, 'burning');
  });
});

describe('the food court drinks stall', () => {
  test('the drinks fridge is electrical only, and the noodle table is one stud from the gas line', () => {
    const said = matchMaterials('Drinks stall. Fridges and a hot-water urn.');
    assert.equal(said.some((match) => match.entryId === 'gas_line'), false);
    assert.equal(said.some((match) => match.behaviour === 'electrical'), true);

    const polygon = foodCourtSample.scene.buildingPolygon.map(
      (pair) => [pair[0], pair[1]] as [number, number],
    );
    const studs = projectSceneStuds(polygon, generateSceneStuds(polygon, 0, ['G']));
    const placed = snapObjectsToStuds(
      foodCourtPlacedObjects(),
      studs.map((item) => ({ id: item.id, simPos: item.simPos, level: item.floor })),
    );
    const drinks = placed.find((obj) => obj.id === 'elec-drinks');
    const table = placed.find((obj) => obj.id === 'noodle-table');
    const noodle = placed.find((obj) => obj.id === 'legacy-hz-gas-noodle');
    assert.ok(drinks && table && noodle);
    const lines = confirmedGasLines(placed);
    const arcs = confirmedElectricalSources(placed);
    assert.equal(lines.some((item) => item.id === 'elec-drinks'), false);
    assert.equal(arcs.some((item) => item.id === 'elec-drinks'), true);
    assert.equal(drinks.matches.every((match) => match.behaviour === 'electrical'), true);

    const sim = new FireSimulation();
    sim.init([stud('anchor', drinks.pos.x, drinks.pos.y)]);
    sim.setFuelCells(new Map());
    sim.setBlastCharge(TNT10);
    sim.setGasLines(lines);
    sim.setElectricalSources(arcs);
    sim.applyBlast(drinks.pos, 1, 'G', []);
    assert.equal(sim.gasJets().some((jet) => jet.id === drinks.id), false);
    for (const jet of sim.gasJets()) {
      const pipe = lines.find((item) => item.id === jet.id);
      assert.ok(pipe);
      const range = Math.hypot(pipe.pos.x - drinks.pos.x, pipe.pos.y - drinks.pos.y);
      assert.ok(blastPressureAt(TNT10, range, false).effectiveKpa >= GAS_RUPTURE_KPA);
    }
    assert.ok(table && noodle);
    const gap = Math.hypot(table.pos.x - noodle.pos.x, table.pos.y - noodle.pos.y);
    assert.ok(gap > 2.5 && gap < 3.5, `noodle table is ${gap} m from its gas line`);
  });

  test('an unconfirmed gas line is not a pipe, and a blank valve does not auto-close', () => {
    const draft: PlacedObject = {
      id: 'draft',
      studId: 's',
      pos: { x: 1, y: 2 },
      level: 'G',
      description: 'Gas line',
      matches: [{ entryId: 'gas_line', label: 'Gas line', fuel: 'non_combustible', behaviour: 'pressurised_gas', source: 'keyword' }],
      confirmed: false,
      valveSec: 12,
    };
    const open: PlacedObject = { ...draft, id: 'open', confirmed: true, valveSec: 0 };
    const timed: PlacedObject = { ...draft, id: 'timed', confirmed: true, valveSec: 12 };
    assert.deepEqual(confirmedGasLines([draft]), []);
    const lines = confirmedGasLines([open, timed]);
    assert.equal(lines.find((item) => item.id === 'open')?.autoShutoffSec, null);
    assert.equal(lines.find((item) => item.id === 'timed')?.autoShutoffSec, 12);
  });
});
