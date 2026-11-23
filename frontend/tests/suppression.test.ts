import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import Matter from 'matter-js';
import { PolygonEvacuationEngine } from '../src/lib/evacuation/engine';
import { HazardField, type Posture } from '../src/lib/evacuation/hazardSensing';
import type { ExitDef, Vec2 } from '../src/lib/evacuation/types';
import { blastPressureAt, type ChargeSpec } from '../src/lib/rts/blast/blastModel';
import {
  GAS_JET_KW,
  GAS_RUPTURE_KPA,
  LINK_QUANTUM_S,
  SPRINKLER_ACT_C,
  SPRINKLER_AMBIENT_C,
  SPRINKLER_CEILING_M,
  SPRINKLER_RTI,
  SUPPRESSION_REACH_M,
  SUPPRESSION_TAU_S,
  WET_CHEMICAL_RTI,
  WET_FLOOR_SPEED,
  advanceSprinklerLink,
  ceilingJet,
  heatReleaseKw,
  steadyActivationSec,
  suppressedHeatKw,
} from '../src/lib/rts/flameFront';
import { DEFAULT_FIRE_PARAMS, FireSimulation, type FireSimStud } from '../src/lib/rts/fireSimulation';
import {
  confirmedFuelCells,
  confirmedSuppression,
  defaultLightFuel,
  matchMaterials,
  snapObjectsToStuds,
  type PlacedObject,
  type SuppressionPlacement,
} from '../src/lib/rts/materialLibrary';
import { foodCourtPlacedObjects, foodCourtSample } from '../src/lib/rts/foodCourtSample';
import { generateSceneStuds, projectSceneStuds } from '../src/lib/rts/sceneStuds';
import { SpatialEffectsEngine } from '../src/lib/rts/spatialEffects';
import type { HazardZone, InteriorWall } from '../src/lib/rts/types';

const CHARGE: ChargeSpec = { presetKey: 'tnt', amountKg: 10, burst: 'surface', heightM: 1.5 };
const WOOD = defaultLightFuel();

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
  ceilingM = 3,
  level = 'G',
): SuppressionPlacement {
  return { id, pos: { x, y }, level, kind, ceilingM };
}

function fuelSim(studs: FireSimStud[], fuelIds: string[], heads: SuppressionPlacement[]) {
  const sim = new FireSimulation();
  sim.init(studs);
  sim.setFuelCells(new Map(fuelIds.map((id) => [id, WOOD])));
  sim.setSuppression(heads);
  return sim;
}

function lightJet(sim: FireSimulation, id: string, x: number, y: number, level = 'G') {
  sim.setBlastCharge(CHARGE);
  sim.setGasLines([{ id, pos: { x, y }, level, autoShutoffSec: null }]);
  const range = 0;
  assert.ok(blastPressureAt(CHARGE, range, false).psKpa >= GAS_RUPTURE_KPA);
  sim.applyBlast({ x, y }, 0.4, level, []);
  assert.equal(sim.isJetting(id), true);
}

/** Step until `pred` or `limit` seconds. Returns the time reached. */
function run(sim: FireSimulation, walls: InteriorWall[], seconds: number, dt: number, pred?: () => boolean) {
  let t = 0;
  while (t + 1e-9 < seconds) {
    if (pred?.()) return t;
    const step = Math.min(dt, seconds - t);
    sim.step(step, walls, []);
    t += step;
  }
  return t;
}

describe('sprinkler link and decay', () => {
  test('the worked example opens a quick head in 54.4 s, at any frame size', () => {
    const jet = ceilingJet(1000, 3, 4);
    assert.ok(Math.abs(jet.riseK - 71.2) / 71.2 < 0.01, `rise ${jet.riseK}`);
    assert.ok(Math.abs(jet.speedMps - 1.064) / 1.064 < 0.01, `speed ${jet.speedMps}`);
    const closed = steadyActivationSec(
      SPRINKLER_AMBIENT_C,
      SPRINKLER_AMBIENT_C + jet.riseK,
      jet.speedMps,
      SPRINKLER_RTI,
    );
    assert.ok(closed != null);
    assert.ok(Math.abs(closed - 54.4) / 54.4 < 0.01, `closed form ${closed}`);

    const times = [0.1, 0.5, 0.7, 1].map((dt) => {
      let link = SPRINKLER_AMBIENT_C;
      let t = 0;
      while (t < 80) {
        const step = advanceSprinklerLink(link, SPRINKLER_AMBIENT_C + jet.riseK, jet.speedMps, SPRINKLER_RTI, dt);
        if (step.openedAt != null) return t + step.openedAt;
        link = step.linkC;
        t += dt;
      }
      return -1;
    });
    for (const time of times) {
      assert.ok(Math.abs(time - 54.4) / 54.4 < 0.01, `opened at ${time}`);
      assert.ok(Math.abs(time - times[0]) < 1e-6, `${time} vs ${times[0]}`);
    }
    assert.equal(LINK_QUANTUM_S, 0.1);
  });

  test('three hundred seconds of decay leaves about half the release', () => {
    const q = suppressedHeatKw(1000, 300, SUPPRESSION_TAU_S);
    assert.ok(Math.abs(q - 501.7) / 501.7 < 0.01, `Q ${q}`);
    assert.equal(SUPPRESSION_TAU_S, 435);
  });

  test('a still jet does not move the link, and a cool jet does not open it', () => {
    const still = advanceSprinklerLink(20, 80, 0, SPRINKLER_RTI, 10);
    assert.equal(still.linkC, 20);
    assert.equal(still.openedAt, null);
    const cool = advanceSprinklerLink(20, 40, 1, SPRINKLER_RTI, 100);
    assert.ok(cool.linkC < SPRINKLER_ACT_C);
    assert.equal(cool.openedAt, null);
    assert.deepEqual(ceilingJet(0, 3, 1), { riseK: 0, speedMps: 0 });
  });

  test('a constant jet opens on the formula, whatever the frame size', () => {
    const jet = ceilingJet(GAS_JET_KW, 3, 4);
    const expected = steadyActivationSec(20, 20 + jet.riseK, jet.speedMps, SPRINKLER_RTI);
    assert.ok(expected != null && expected > 1);
    const times: number[] = [];
    const links: number[] = [];
    for (const dt of [0.1, 1]) {
      const sim = fuelSim([stud('a', 0, 0), stud('b', 4, 0)], [], [head('h', 4, 0)]);
      lightJet(sim, 'pipe', 0, 0);
      const mark = Math.max(0.1, expected - 1);
      run(sim, [], mark, dt);
      links.push(sim.suppressionState('h')?.linkC ?? -1);
      assert.equal(sim.suppressionState('h')?.open, false);
      let t = mark;
      while (sim.suppressionState('h')?.open !== true && t < expected + 5) {
        sim.step(dt, [], []);
        t += dt;
      }
      const age = sim.suppressionState('h')?.age ?? 0;
      times.push(t - age);
    }
    for (const time of times) {
      assert.ok(Math.abs(time - expected) / expected < 0.01, `opened at ${time}, formula ${expected}`);
    }
    assert.ok(Math.abs(links[0] - links[1]) < 1e-4, `link ${links[0]} vs ${links[1]}`);
    assert.ok(Math.abs(times[0] - times[1]) < 1e-6);
  });

  test('a growing fire agrees across frame sizes, before and after the head opens', () => {
    const sampleAt = (dt: number, seconds: number) => {
      const sim = fuelSim([stud('a', 0, 0), stud('tile', 3, 0)], ['a'], [head('h', 0, 0)]);
      sim.ignite(['a']);
      run(sim, [], seconds, dt);
      return {
        link: sim.suppressionState('h')?.linkC ?? -1,
        open: sim.suppressionState('h')?.open ?? false,
        heat: sim.fuelReleaseKw('a'),
      };
    };
    const early = [0.1, 0.7, 1].map((dt) => sampleAt(dt, 70));
    for (const row of early) {
      assert.equal(row.open, false);
      assert.ok(row.link > SPRINKLER_AMBIENT_C);
      assert.ok(Math.abs(row.link - early[0].link) < 1e-4, `link ${row.link} vs ${early[0].link}`);
    }
    const later = [0.1, 0.7, 1].map((dt) => sampleAt(dt, 210));
    for (const row of later) {
      assert.equal(row.open, true);
      assert.ok(row.heat != null && row.heat > 0);
      assert.ok(Math.abs((row.heat ?? 0) - (later[0].heat ?? 0)) < 1e-3, `Q ${row.heat} vs ${later[0].heat}`);
      const bare = heatReleaseKw(WOOD, 210);
      assert.ok((row.heat ?? 0) < bare * 0.95, `decayed ${row.heat}, bare ${bare}`);
    }
  });
});

describe('what the spray does and does not reach', () => {
  test('fuel under the spray decays and stays alight, and the front stops', () => {
    const open = fuelSim([stud('a', 0, 0), stud('b', 3, 0), stud('tile', 2, 0)], ['a', 'b'], [head('h', 0, 0)]);
    const free = fuelSim([stud('a', 0, 0), stud('b', 3, 0)], ['a', 'b'], []);
    open.ignite(['a']);
    free.ignite(['a']);
    run(open, [], 30, 1);
    assert.equal(open.suppressionState('h')?.open, false);
    assert.equal(open.wetStuds([]).length, 0);
    const opened = 30 + run(open, [], 370, 1, () => open.suppressionState('h')?.open === true);
    assert.ok(opened < 250, `head opened at ${opened}`);
    run(open, [], 400 - opened, 1);
    run(free, [], 400, 1);
    assert.equal(open.states.get('a')?.state, 'burning');
    assert.notEqual(open.states.get('b')?.state, 'burning');
    assert.ok((open.states.get('b')?.dose ?? 0) < 1);
    assert.equal(free.states.get('b')?.state, 'burning');
    const decayed = open.fuelReleaseKw('a');
    const bare = free.fuelReleaseKw('a');
    assert.ok(decayed != null && bare != null && decayed < bare * 0.8, `${decayed} vs ${bare}`);
    const wet = open.wetStuds([]).map((item) => item.id).sort();
    assert.deepEqual(wet, ['a', 'b', 'tile']);
    assert.equal(open.sprays().length, 1);
    assert.equal(open.sprays()[0]?.id, 'h');
  });

  test('fuel outside the throw keeps growing, and a second head does not decay twice', () => {
    const one = fuelSim(
      [stud('a', 0, 0), stud('far', 9, 0)],
      ['a', 'far'],
      [head('h', 0, 0)],
    );
    const two = fuelSim(
      [stud('a', 0, 0), stud('far', 9, 0)],
      ['a', 'far'],
      [head('h', 0, 0), head('h2', 1, 0)],
    );
    one.ignite(['a', 'far']);
    two.ignite(['a', 'far']);
    run(one, [], 250, 1);
    run(two, [], 250, 1);
    assert.equal(one.suppressionState('h')?.open, true);
    const near = one.fuelReleaseKw('a');
    const far = one.fuelReleaseKw('far');
    const bareFar = heatReleaseKw(WOOD, 250);
    assert.ok(near != null && far != null);
    assert.ok(Math.abs(far - bareFar) / bareFar < 0.01, `outside ${far}, bare ${bareFar}`);
    assert.ok(near < far * 0.8);
    assert.ok(Math.abs((two.fuelReleaseKw('a') ?? 0) - near) < 1e-3, 'two heads stacked the decay');
    assert.equal(one.wetStuds([]).some((item) => item.id === 'far'), false);
  });

  test('a solid wall blocks the jet and the spray, a door gap does not, and another storey does not', () => {
    const blocked = fuelSim([stud('a', 0, 0), stud('b', 3, 0)], ['a', 'b'], [head('h', 3, 0)]);
    blocked.ignite(['a']);
    run(blocked, [wall(1.5, -5, 1.5, 5)], 300, 1);
    assert.equal(blocked.suppressionState('h')?.open, false);
    assert.equal(blocked.suppressionState('h')?.linkC, SPRINKLER_AMBIENT_C);
    assert.equal(blocked.wetStuds([wall(1.5, -5, 1.5, 5)]).length, 0);
    assert.ok(Math.abs((blocked.fuelReleaseKw('a') ?? 0) - heatReleaseKw(WOOD, 300)) < 1e-6);

    const gap = fuelSim([stud('a', 0, 0), stud('b', 3, 0)], ['a'], [head('h', 3, 0)]);
    gap.ignite(['a']);
    const door = wall(1.5, -5, 1.5, 5, true);
    const opened = run(gap, [door], 300, 1, () => gap.suppressionState('h')?.open === true);
    assert.ok(opened < 300, 'the door gap never heated the link');
    assert.equal(gap.wetStuds([door]).some((item) => item.id === 'b'), true);

    const upstairs = fuelSim(
      [stud('a', 0, 0, 'G'), stud('up', 0, 0, 'L1')],
      ['a'],
      [head('h', 0, 0, 'sprinkler', 3, 'L1')],
    );
    upstairs.ignite(['a']);
    run(upstairs, [], 300, 1);
    assert.equal(upstairs.suppressionState('h')?.open, false);
    assert.equal(upstairs.wetStuds([]).some((item) => item.id === 'up'), false);
  });

  test('a jet under an open spray decays from its full release, and an arc does not open a head', () => {
    const sim = fuelSim([stud('a', 0, 0), stud('b', 2, 0)], [], [head('h', 0, 0)]);
    lightJet(sim, 'near', 0, 0);
    const opened = run(sim, [], 30, 0.1, () => sim.suppressionState('h')?.open === true);
    assert.ok(opened < 5, `head opened at ${opened}`);
    sim.setGasLines([
      { id: 'near', pos: { x: 0, y: 0 }, level: 'G', autoShutoffSec: null },
      { id: 'late', pos: { x: 2, y: 0 }, level: 'G', autoShutoffSec: null },
    ]);
    sim.setBlastCharge(CHARGE);
    sim.applyBlast({ x: 2, y: 0 }, 0.4, 'G', []);
    assert.equal(sim.isJetting('late'), true);
    assert.equal(sim.gasLineState('late')?.heatKw, GAS_JET_KW);
    run(sim, [], 100, 1);
    const late = sim.gasLineState('late')?.heatKw ?? 0;
    const expected = suppressedHeatKw(GAS_JET_KW, 100);
    assert.ok(Math.abs(late - expected) / expected < 0.02, `late jet ${late}, expected ${expected}`);
    assert.ok(late < GAS_JET_KW * 0.9);

    const arc = new FireSimulation();
    arc.init([stud('a', 0, 0)]);
    arc.setFuelCells(new Map());
    arc.setSuppression([head('h', 0, 0)]);
    arc.setBlastCharge(CHARGE);
    arc.setElectricalSources([{ id: 'fit', pos: { x: 0, y: 0 }, level: 'G' }]);
    arc.applyBlast({ x: 0, y: 0 }, 1, 'G', []);
    assert.equal(arc.isArcing('fit'), true);
    run(arc, [], 60, 1);
    assert.equal(arc.suppressionState('h')?.open, false);
    assert.equal(arc.suppressionState('h')?.linkC, SPRINKLER_AMBIENT_C);
    assert.equal(arc.sprays().length, 0);
  });

  test('once the spray is open, a stud it covers stops heating and one it misses does not', () => {
    const sim = fuelSim(
      [stud('jet', 0, 0), stud('in', 3, 0), stud('out', 9, 0), stud('farjet', 12, 0)],
      ['in', 'out'],
      [head('h', 0, 0)],
    );
    lightJet(sim, 'near', 0, 0);
    run(sim, [], 5, 0.1);
    assert.equal(sim.suppressionState('h')?.open, true);
    sim.setGasLines([
      { id: 'near', pos: { x: 0, y: 0 }, level: 'G', autoShutoffSec: null },
      { id: 'far', pos: { x: 12, y: 0 }, level: 'G', autoShutoffSec: null },
    ]);
    sim.applyBlast({ x: 12, y: 0 }, 0.4, 'G', []);
    assert.equal(sim.isJetting('far'), true);
    run(sim, [], 2, 0.1);
    const held = sim.states.get('in')?.dose ?? 0;
    const outside = sim.states.get('out')?.dose ?? 0;
    run(sim, [], 20, 1);
    assert.equal(sim.states.get('in')?.state === 'burning', false);
    assert.ok(Math.abs((sim.states.get('in')?.dose ?? 0) - held) < 1e-9, 'dose moved under the spray');
    assert.ok((sim.states.get('out')?.dose ?? 0) > outside + 0.05, 'the stud outside the spray did not heat');
    assert.ok(Math.hypot(3, 0) <= SUPPRESSION_REACH_M);
    assert.ok(Math.hypot(9, 0) > SUPPRESSION_REACH_M);
  });

  test('a wet-chemical head is the same spray with the slower link', () => {
    const openAt = (kind: SuppressionPlacement['kind']) => {
      const sim = fuelSim([stud('a', 0, 0)], [], [head('h', 0, 0, kind)]);
      lightJet(sim, 'pipe', 0, 0);
      return run(sim, [], 60, 0.1, () => sim.suppressionState('h')?.open === true);
    };
    const quick = openAt('sprinkler');
    const kitchen = openAt('wet_chemical');
    assert.ok(quick < 10 && kitchen > quick * 2, `quick ${quick}, kitchen ${kitchen}`);
    assert.equal(SPRINKLER_RTI, 50);
    assert.equal(WET_CHEMICAL_RTI, 135);
  });
});

describe('nothing sprays without a fire', () => {
  test('no heat, an unconfirmed head, and a chemical circle do nothing', () => {
    assert.equal(DEFAULT_FIRE_PARAMS.hazardAcceleration.chemical, 1);
    const draft: PlacedObject = {
      id: 'draft',
      studId: 'a',
      pos: { x: 0, y: 0 },
      level: 'G',
      description: 'Wet chemical system',
      matches: [
        {
          entryId: 'wet_chemical',
          label: 'Wet-chemical system',
          fuel: 'non_combustible',
          behaviour: 'suppression',
          source: 'keyword',
        },
      ],
      confirmed: false,
    };
    assert.deepEqual(confirmedSuppression([draft]), []);
    assert.equal(matchMaterials('handheld extinguisher').some((match) => match.behaviour === 'suppression'), false);
    assert.equal(matchMaterials('ceiling sprinkler').some((match) => match.entryId === 'sprinkler'), true);
    assert.equal(matchMaterials('wet chemical hood').some((match) => match.entryId === 'wet_chemical'), true);
    assert.equal(matchMaterials('wet chemical hood').some((match) => match.entryId === 'sprinkler'), false);

    const zone: HazardZone = {
      id: 'chem',
      pos: { x: 0, y: 0 },
      radius: 8,
      hazardType: 'chemical',
      severity: 'high',
      label: 'Chemical',
      description: 'Chemical',
      photos: [],
    };
    const withZone = fuelSim([stud('a', 0, 0), stud('b', 3, 0)], ['a', 'b'], []);
    const plain = fuelSim([stud('a', 0, 0), stud('b', 3, 0)], ['a', 'b'], []);
    withZone.ignite(['a']);
    plain.ignite(['a']);
    for (let i = 0; i < 30; i++) {
      withZone.step(1, [], [zone]);
      plain.step(1, [], []);
    }
    assert.equal(withZone.sprays().length, 0);
    assert.equal(withZone.states.get('b')?.dose, plain.states.get('b')?.dose);
    assert.equal(withZone.fuelReleaseKw('a'), plain.fuelReleaseKw('a'));

    const idle = fuelSim([stud('a', 0, 0), stud('b', 3, 0)], ['a'], [head('h', 0, 0)]);
    idle.setSuppression([head('h', 0, 0)]);
    run(idle, [], 100, 1);
    assert.equal(idle.suppressionState('h')?.open, false);
    assert.equal(idle.suppressionState('h')?.linkC, SPRINKLER_AMBIENT_C);
    assert.equal(idle.wetStuds([]).length, 0);
    assert.equal(idle.states.get('a')?.state, 'none');
  });

  test('the food court stays dry for five minutes when nothing is burning', () => {
    const polygon = foodCourtSample.scene.buildingPolygon.map((pair) => [pair[0], pair[1]] as [number, number]);
    const studs = projectSceneStuds(polygon, generateSceneStuds(polygon, 0, ['G']));
    const placed = snapObjectsToStuds(
      foodCourtPlacedObjects(),
      studs.map((item) => ({ id: item.id, simPos: item.simPos, level: item.floor })),
    );
    const heads = confirmedSuppression(placed, { G: 4 });
    assert.equal(heads.length, 5);
    assert.ok(heads.every((item) => item.kind === 'wet_chemical' && item.ceilingM === 4));
    const bare = confirmedSuppression(placed, {});
    assert.ok(bare.every((item) => item.ceilingM === SPRINKLER_CEILING_M));

    const asFire = studs.map((item) => ({
      id: item.id,
      simPos: item.simPos,
      spatialContext: item.spatialContext,
      level: item.floor === 'Ground' ? 'G' : item.floor,
    }));
    const fuel = confirmedFuelCells(placed, asFire);
    const table = placed.find((obj) => obj.id === 'pizza-table');
    const pizzaHood = placed.find((obj) => obj.id === 'hood-pizza');
    assert.ok(table && pizzaHood);
    assert.notEqual(table.studId, pizzaHood.studId);
    const walls = foodCourtSample.scene.interiorWalls as unknown as InteriorWall[];
    const sim = new FireSimulation();
    sim.init(asFire);
    sim.setFuelCells(fuel);
    for (let t = 0; t < 300; t++) {
      sim.setSuppression(heads);
      sim.step(1, walls, []);
    }
    for (const state of sim.states.values()) assert.equal(state.state, 'none');
    assert.equal(sim.sprays().length, 0);
    assert.equal(sim.wetStuds(walls).length, 0);
    assert.equal(sim.states.get(table.studId)?.state, 'none');
    for (const item of heads) assert.equal(sim.suppressionState(item.id)?.open, false);
  });
});

describe('wet floor', () => {
  test('the effects engine marks a sprayed stud wet, and only after the head opens', () => {
    const engine = new SpatialEffectsEngine(undefined, 1);
    engine.init([stud('a', 0, 0), stud('tile', 2, 0)]);
    engine.setFuelCells(new Map([['a', WOOD]]));
    engine.setSuppression([head('h', 0, 0)]);
    engine.step(1, [], []);
    assert.equal(engine.studStates.get('tile')?.wet, false);
    const sim = engine as unknown as { fireSim: FireSimulation };
    sim.fireSim.ignite(['a']);
    let t = 0;
    while (engine.sprays().length === 0 && t < 300) {
      engine.step(1, [], []);
      t += 1;
    }
    assert.ok(engine.sprays().length === 1, `no spray by ${t}`);
    assert.equal(engine.studStates.get('a')?.wet, true);
    assert.equal(engine.studStates.get('tile')?.wet, true);
    assert.equal(engine.studStates.get('a')?.fire.state, 'burning');
  });

  test('stand and crawl are slower on a wet stud, and a dry sample is not', () => {
    const field = new HazardField([{ id: 's', simPos: { x: 0, y: 0 }, indoor: true }]);
    field.setStates(new Map([['s', { smoke: 0, fire: { state: 'none' } }]]));
    assert.equal(field.sample(0, 0).wet, false);
    field.setStates(new Map([['s', { smoke: 0, fire: { state: 'none' }, wet: true }]]));
    assert.equal(field.sample(0, 0).wet, true);
    assert.equal(field.sample(100, 100).wet, false);

    for (const posture of ['stand', 'crawl'] as const) {
      const moved = (wet: boolean) => distance(posture, wet);
      const dry = moved(false);
      const wet = moved(true);
      assert.ok(dry > 0.3, `${posture} did not walk (${dry})`);
      assert.ok(Math.abs(wet / dry - WET_FLOOR_SPEED) < 0.05, `${posture} ${wet} / ${dry}`);
    }
  });
});

function distance(posture: Posture, wet: boolean): number {
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
  const states = new Map<string, { smoke: number; fire: { state: string }; wet?: boolean }>();
  for (let x = 0; x <= 40; x += 3) {
    const id = `s${x}`;
    studs.push({ id, simPos: { x, y: 10 }, indoor: true });
    states.set(id, { smoke: 0, fire: { state: 'none' }, wet });
  }
  const hazard = new HazardField(studs);
  hazard.setStates(states);
  eng.setHazardField(hazard);
  const body = (eng as unknown as { pedestrians: Matter.Body[] }).pedestrians[0];
  Matter.Body.setPosition(body, { x: 8, y: 10 });
  Matter.Body.setVelocity(body, { x: 0, y: 0 });
  const ped = (body as Matter.Body & {
    __ped: { state: string; targetExitId: string; nextCheckAt: number; posture: Posture; forcedCrawl?: boolean };
  }).__ped;
  ped.state = 'evacuating';
  ped.targetExitId = 'east';
  ped.nextCheckAt = 1e9;
  ped.posture = posture;
  ped.forcedCrawl = posture === 'crawl';
  const start = body.position.x;
  for (let i = 0; i < 180; i++) eng.step();
  const moved = body.position.x - start;
  eng.destroy();
  return moved;
}
