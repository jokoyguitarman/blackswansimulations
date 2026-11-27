import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { LEVEL } from '../src/lib/evacuation/levelConstants.ts';
import { FireSimulation } from '../src/lib/rts/fireSimulation.ts';
import { defaultLightFuel } from '../src/lib/rts/materialLibrary.ts';
import {
  doorHeadInUpper,
  moveUpperGas,
  shaftDensityKgM3,
  nextShaftK,
  shaftColumnMassKg,
  shaftDrivePa,
  shaftGaugePa,
  shaftMassFlowKgS,
  shaftOpeningM,
  type ShaftEnd,
  type UpperGas,
} from '../src/lib/rts/shaftVent.ts';
import { SpatialEffectsEngine } from '../src/lib/rts/spatialEffects.ts';
import { normaliseStairwell, shaftPairs } from '../src/lib/rts/levels.ts';
import { projectSceneStuds } from '../src/lib/rts/sceneStuds.ts';
import {
  stairShaftFuelObjects,
  stairShaftSample,
  stairShaftStuds,
} from '../src/lib/rts/stairShaftTest.ts';
import type { InteriorWall, LevelDef } from '../src/lib/rts/types.ts';
import Matter from 'matter-js';
import { PolygonEvacuationEngine } from '../src/lib/evacuation/engine.ts';
import { projectPolygon } from '../src/lib/evacuation/geometry.ts';
import { DEFAULT_POLYGON_CONFIG, type ExitDef } from '../src/lib/evacuation/types.ts';
import { AMBIENT_K, blackLayerRadiantKwM2 } from '../src/lib/rts/twoZone.ts';

function close(actual: number, expected: number, label: string) {
  const tol = Math.max(0.05, Math.abs(expected) * 0.02);
  assert.ok(Math.abs(actual - expected) <= tol, `${label}: ${actual} vs ${expected}`);
}

function end(partial: Partial<ShaftEnd> & Pick<ShaftEnd, 'active'>): ShaftEnd {
  return {
    interfaceM: 3,
    upperK: AMBIENT_K,
    lowerK: AMBIENT_K,
    floorPressurePa: 0,
    ceilingM: 3,
    ...partial,
  };
}

describe('shaft vent', () => {
  test('a hot lower floor drives flow up, and a deep upper floor drives it down', () => {
    assert.equal(shaftOpeningM(3), 2);
    assert.equal(shaftOpeningM(1.5), 1.5);
    const lower = end({
      active: true,
      interfaceM: 1,
      upperK: 600,
      lowerK: AMBIENT_K,
      floorPressurePa: 0,
      ceilingM: 3,
    });
    const cold = end({ active: false, ceilingM: 3 });
    const gauge = shaftGaugePa(2, 1, 0, AMBIENT_K, 600);
    const stack = (shaftDensityKgM3(AMBIENT_K) - shaftDensityKgM3(600)) * LEVEL.G * 3;
    const drive = shaftDrivePa(lower, cold, 600, 3);
    close(drive, gauge + stack, 'upward drive');
    assert.ok(drive > 20, `drive ${drive}`);
    const flow = shaftMassFlowKgS(drive, 1.2, 2, 600);
    assert.ok(flow > 1, `upward flow ${flow}`);
    const area = (1.2 * 2) / Math.sqrt(2);
    const expectFlow = LEVEL.ORIFICE_C * area * Math.sqrt(2 * shaftDensityKgM3(600) * drive);
    close(flow, expectFlow, 'series orifice');

    const upper = end({
      active: true,
      interfaceM: 0.4,
      upperK: 700,
      lowerK: AMBIENT_K,
      floorPressurePa: 8,
      ceilingM: 3,
    });
    const down = shaftDrivePa(cold, upper, AMBIENT_K, 3);
    assert.ok(down < 0, `downward drive ${down}`);
    assert.ok(shaftMassFlowKgS(down, 1.2, 2, 700) < 0);
    assert.equal(shaftDrivePa(cold, cold, AMBIENT_K, 3), 0);
    const column = shaftColumnMassKg(AMBIENT_K, 1.2, 3);
    assert.ok(column > 5, `column ${column}`);
    const warmed = nextShaftK(AMBIENT_K, 1, 0.2, 600, column);
    assert.ok(warmed < 320, `one parcel heated the well to ${warmed}`);
    assert.ok(warmed > AMBIENT_K, `the parcel left the well at ${warmed}`);
    assert.equal(doorHeadInUpper(1.9, 2), true);
    assert.equal(doorHeadInUpper(2, 2), false);
  });

  test('moving upper gas keeps the soot and warms the far layer', () => {
    const source: UpperGas = {
      interfaceM: 1,
      upperK: 600,
      sootG: 40,
      fuelKg: 0.2,
      upperO2: 0.1,
      areaM2: 18,
      ceilingM: 3,
    };
    const dest: UpperGas = {
      interfaceM: 3,
      upperK: AMBIENT_K,
      sootG: 0,
      fuelKg: 0,
      upperO2: 0.23,
      areaM2: 18,
      ceilingM: 3,
    };
    const moved = moveUpperGas(source, dest, 2);
    assert.ok(moved.movedKg > 1, `moved ${moved.movedKg}`);
    close(moved.source.sootG + moved.dest.sootG, 40, 'soot');
    close(moved.source.fuelKg + moved.dest.fuelKg, 0.2, 'fuel');
    assert.ok(moved.dest.upperK > 500, `dest ${moved.dest.upperK}`);
    assert.ok(moved.dest.interfaceM < 3, `dest interface ${moved.dest.interfaceM}`);
    assert.ok(moved.source.interfaceM > source.interfaceM, 'source layer thinned');
    assert.equal(moveUpperGas(source, dest, 0).movedKg, 0);
  });

  test('the landing ignites on the layer flux and not before, and a cool gas does not', () => {
    const studs = [
      { id: 'g', simPos: { x: 0, y: 0 }, spatialContext: 'inside_building' as const, level: 'G' },
      { id: 'u', simPos: { x: 0, y: 0 }, spatialContext: 'inside_building' as const, level: 'L1' },
    ];
    const flux = 30;
    const trp = 134;
    const chf = 10;
    const tig = (Math.PI / 4) * (trp / (flux - chf)) ** 2;
    const fire = new FireSimulation();
    fire.init(studs);
    fire.setFuelCells(new Map([['u', defaultLightFuel()]]));
    const early = Math.floor(tig - 2);
    for (let i = 0; i < early; i++) fire.applyLandingFlux('u', flux, 1);
    assert.notEqual(fire.states.get('u')!.state, 'burning');
    assert.ok((fire.states.get('u')!.dose ?? 0) > 0.5);
    for (let i = early; i < Math.ceil(tig + 1); i++) fire.applyLandingFlux('u', flux, 1);
    assert.equal(fire.states.get('u')!.state, 'burning');

    const cool = new FireSimulation();
    cool.init(studs);
    cool.setFuelCells(new Map([['u', defaultLightFuel()]]));
    const dim = blackLayerRadiantKwM2(400);
    assert.ok(dim < 10, `400 K flux ${dim}`);
    for (let i = 0; i < 100; i++) cool.applyLandingFlux('u', dim, 1);
    assert.equal(cool.states.get('u')!.state, 'none');
  });
});

function roomWalls(level: string, doorWidth = 0.9): InteriorWall[] {
  const wall = (
    id: string,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    door: boolean,
  ): InteriorWall => ({
    id: `${id}-${level}`,
    start: { x: x1, y: y1 },
    end: { x: x2, y: y2 },
    hasDoor: door,
    doorWidth,
    doorPosition: 0.5,
    description: '',
    material: 'concrete',
    photos: [],
    level,
  });
  return [
    wall('n', -1.5, 1.5, 4.5, 1.5, false),
    wall('s', -1.5, -1.5, 4.5, -1.5, false),
    wall('w', -1.5, -1.5, -1.5, 1.5, false),
    wall('e', 4.5, -1.5, 4.5, 1.5, true),
  ];
}

function stud(
  id: string,
  x: number,
  y: number,
  level: string,
  inside: boolean,
): {
  id: string;
  simPos: { x: number; y: number };
  spatialContext: 'inside_building' | 'open_air';
  level: string;
} {
  return {
    id,
    simPos: { x, y },
    spatialContext: inside ? 'inside_building' : 'open_air',
    level,
  };
}

/** Two studs and an outside neighbour, on both floors, with a door. */
function shaftRoom(doorWidth = 0.9) {
  const studs = [
    stud('g0', 0, 0, 'G', true),
    stud('g1', 3, 0, 'G', true),
    stud('gout', 6, 0, 'G', false),
    stud('u0', 0, 0, 'L1', true),
    stud('u1', 3, 0, 'L1', true),
    stud('uout', 6, 0, 'L1', false),
  ];
  const walls = [...roomWalls('G', doorWidth), ...roomWalls('L1', doorWidth)];
  const engine = new SpatialEffectsEngine(undefined, 1);
  engine.init(studs);
  engine.setStoreyHeights({ G: 2.6, L1: 2.6 });
  engine.setVerticalLinks([
    {
      id: 'stair',
      pos: { x: 0, y: 0 },
      levels: ['G', 'L1'],
      kind: 'stair',
      blocked: false,
      widthM: 1.2,
      heightByLevel: { G: 2.6, L1: 2.6 },
    },
  ]);
  return { engine, walls, studs };
}

function hotFuel() {
  return { ...defaultLightFuel(), alphaKwS2: 1, fuelLoadKgM2: 400, spreadMPerMin: 0 };
}

interface LiveLayer {
  active: boolean;
  members: string[];
  ceilingM: number;
  zone: { interfaceM: number; upperK: number; sootG: number };
}

function layersOf(engine: SpatialEffectsEngine): LiveLayer[] {
  const state = (
    engine as unknown as {
      layerState: Map<string, LiveLayer>;
    }
  ).layerState;
  return [...state.values()].filter((row) => row.active);
}

function layerWith(engine: SpatialEffectsEngine, studId: string): LiveLayer | undefined {
  return layersOf(engine).find((row) => row.members.includes(studId));
}

describe('shaft between two storeys', () => {
  test('smoke rises into the upper floor and the landing takes a dose', () => {
    const { engine, walls } = shaftRoom();
    const fuel = hotFuel();
    engine.setFuelCells(
      new Map([
        ['g0', fuel],
        ['g1', fuel],
        ['u0', defaultLightFuel()],
      ]),
    );
    const fire = (engine as unknown as { fireSim: FireSimulation }).fireSim;
    fire.ignite(['g0', 'g1']);
    let upperSoot = 0;
    let upperK = AMBIENT_K;
    let dose = 0;
    for (let t = 0; t < 180 && (upperSoot < 0.5 || dose <= 0); t++) {
      engine.step(1, walls, []);
      const upper = layerWith(engine, 'u0');
      upperSoot = upper?.zone.sootG ?? 0;
      upperK = upper?.zone.upperK ?? AMBIENT_K;
      dose = fire.states.get('u0')?.dose ?? 0;
    }
    const lower = layerWith(engine, 'g0');
    assert.ok(lower, 'the ground floor did not form a layer');
    assert.ok(
      upperSoot > 0.5,
      `upper soot ${upperSoot} g, lower ${lower?.zone.sootG} g at ${lower?.zone.upperK} K, interface ${lower?.zone.interfaceM}`,
    );
    assert.ok(upperK > AMBIENT_K + 20, `upper temperature ${upperK}`);
    assert.ok(dose > 0, `landing dose ${dose}, upper layer ${upperK} K`);
    let smokeT = 0;
    let smoke = engine.studStates.get('u0')?.smoke ?? 0;
    while (smoke <= 0.02 && smokeT < 180) {
      engine.step(1, walls, []);
      smoke = engine.studStates.get('u0')?.smoke ?? 0;
      smokeT += 1;
    }
    assert.ok(smoke > 0.02, `upper smoke ${smoke} after ${smokeT} s more`);
    assert.ok((engine.studStates.get('u0')?.fumes?.CO ?? 0) > 0, 'CO did not follow the smoke');
  });

  test('a deep upper layer sends smoke back down the stair', () => {
    const { engine, walls } = shaftRoom();
    const fuel = hotFuel();
    engine.setFuelCells(
      new Map([
        ['u0', fuel],
        ['u1', fuel],
      ]),
    );
    const fire = (engine as unknown as { fireSim: FireSimulation }).fireSim;
    fire.ignite(['u0', 'u1']);
    let lowerSoot = 0;
    let lowerK = AMBIENT_K;
    for (let t = 0; t < 180 && lowerSoot < 0.5; t++) {
      engine.step(1, walls, []);
      const lower = layerWith(engine, 'g0');
      lowerSoot = lower?.zone.sootG ?? 0;
      lowerK = lower?.zone.upperK ?? AMBIENT_K;
    }
    const upper = layerWith(engine, 'u0');
    assert.ok(upper, 'the upper floor did not form a layer');
    assert.ok(
      lowerSoot > 0.5,
      `lower soot ${lowerSoot} g, upper ${upper?.zone.sootG} g at ${upper?.zone.upperK} K, interface ${upper?.zone.interfaceM}`,
    );
    assert.ok(lowerK > AMBIENT_K + 20, `lower temperature ${lowerK}`);
    assert.equal(fire.states.get('g0')?.state ?? 'none', 'none');
  });

  test('the two storeys conserve mass, including gas waiting in the shaft hold', () => {
    const { engine, walls } = shaftRoom();
    const fuel = hotFuel();
    engine.setFuelCells(
      new Map([
        ['g0', fuel],
        ['g1', fuel],
      ]),
    );
    const fire = (engine as unknown as { fireSim: FireSimulation }).fireSim;
    fire.ignite(['g0', 'g1']);
    const view = engine as unknown as {
      layerState: Map<string, BudgetLayer>;
      shaftHold: Map<string, { massKg: number }>;
      ventNetKg: number;
    };
    const mass = () => storeyMass(view) + holdMass(view.shaftHold);
    let prev = mass();
    let residual = 0;
    let peakHold = 0;
    let peak = 0;
    for (let t = 1; t <= 180; t++) {
      const netBefore = view.ventNetKg;
      engine.step(1, walls, []);
      const hold = holdMass(view.shaftHold);
      if (hold > peakHold) peakHold = hold;
      const now = mass();
      residual += now - prev - (view.ventNetKg - netBefore);
      if (Math.abs(residual) > Math.abs(peak)) peak = residual;
      prev = now;
    }
    // A closed room with no shaft loses about 3 kg to the floor clamp. The
    // same scene at d4dd0df, with the shaft moved outside the pressure roots,
    // is about +510 kg by T+180 and still climbing.
    assert.ok(
      Math.abs(residual) < 6,
      `mass residual ${residual.toFixed(1)} kg at T+180 (peak ${peak.toFixed(1)} kg)`,
    );
    assert.ok(peakHold > 0, `no gas waited in the shaft hold (residual ${residual.toFixed(1)} kg)`);
  });

  test('a clamped upper storey conserves mass through the outdoor vents and the hold', () => {
    const { engine, walls } = shaftRoom(0.25);
    const fuel = hotFuel();
    engine.setFuelCells(
      new Map([
        ['g0', fuel],
        ['g1', fuel],
      ]),
    );
    const fire = (engine as unknown as { fireSim: FireSimulation }).fireSim;
    fire.ignite(['g0', 'g1']);
    const run = buildingBudget(engine, walls, 600);
    assert.ok(
      run.minInterface <= 0.051,
      `upper interface ${run.minInterface} never reached the floor`,
    );
    assert.ok(
      Math.abs(run.residual) < 6,
      `mass residual ${run.residual.toFixed(1)} kg at T+600 (peak ${run.peak.toFixed(1)} kg)`,
    );
  });

  test('a fuelled landing conserves mass', () => {
    const { engine, walls } = shaftRoom();
    const fuel = hotFuel();
    engine.setFuelCells(
      new Map([
        ['g0', fuel],
        ['g1', fuel],
        ['u0', defaultLightFuel()],
      ]),
    );
    const fire = (engine as unknown as { fireSim: FireSimulation }).fireSim;
    fire.ignite(['g0', 'g1']);
    const run = buildingBudget(engine, walls, 240);
    assert.equal(fire.states.get('u0')?.state, 'burning');
    assert.ok(
      Math.abs(run.residual) < 6,
      `mass residual ${run.residual.toFixed(1)} kg at T+240 (peak ${run.peak.toFixed(1)} kg)`,
    );
  });

  test('a fuelled landing keeps the shaft inflow enthalpy', () => {
    const { engine, walls } = shaftRoom();
    const fuel = hotFuel();
    engine.setFuelCells(
      new Map([
        ['g0', fuel],
        ['g1', fuel],
        ['u0', defaultLightFuel()],
      ]),
    );
    const fire = (engine as unknown as { fireSim: FireSimulation }).fireSim;
    fire.ignite(['g0', 'g1']);
    const eng = engine as unknown as {
      stepThroughShafts: (...args: unknown[]) => {
        stepped: { inKT: number; outKT: number; upperLossKw: number; lowerLossKw: number };
      };
      layerState: Map<string, BudgetLayer>;
    };
    const orig = eng.stepThroughShafts.bind(eng);
    let energyKj = 0;
    eng.stepThroughShafts = (...args: unknown[]) => {
      const solved = orig(...args);
      const members = args[1] as readonly string[];
      if (args[12] !== false && members.includes('u0')) {
        const stepped = solved.stepped;
        if (Number.isFinite(stepped.inKT) && Number.isFinite(stepped.outKT)) {
          energyKj += stepped.inKT - stepped.outKT - (stepped.upperLossKw + stepped.lowerLossKw);
        }
      }
      return solved;
    };
    let riseAt120 = 0;
    for (let t = 1; t <= 240; t++) {
      engine.step(1, walls, []);
      if (t === 120) {
        const upper = [...eng.layerState.values()].find(
          (row) => row.active && row.members.includes('u0'),
        );
        riseAt120 = (upper?.zone.upperK ?? AMBIENT_K) - AMBIENT_K;
      }
    }
    // The shaft is feeding gas hundreds of kelvin hotter. Booking that
    // inflow as cool makeup drops the rise from about 400 K to about 60 K
    // and leaves about +280 MJ unaccounted by T+240.
    assert.ok(riseAt120 > 200, `L1 rise ${riseAt120.toFixed(0)} K at T+120`);
    assert.ok(
      energyKj / 1000 < 40,
      `L1 energy residual ${(energyKj / 1000).toFixed(0)} MJ at T+240`,
    );
  });
});

interface BudgetLayer {
  active: boolean;
  members: string[];
  areaM2: number;
  ceilingM: number;
  zone: { interfaceM: number; upperK: number; lowerK?: number };
}

function storeyMass(view: { layerState: Map<string, BudgetLayer> }): number {
  let total = 0;
  for (const id of ['g0', 'u0']) {
    const live = [...view.layerState.values()].find((row) => row.members.includes(id));
    if (live?.active) {
      const z = live.zone.interfaceM;
      const lowerK =
        live.zone.lowerK != null && live.zone.lowerK > 0 ? live.zone.lowerK : AMBIENT_K;
      total +=
        (353 / live.zone.upperK) * live.areaM2 * (live.ceilingM - z) +
        (353 / lowerK) * live.areaM2 * z;
    } else {
      total += (353 / AMBIENT_K) * 18 * 2.6;
    }
  }
  return total;
}

function holdMass(hold: Map<string, { massKg: number }>): number {
  let mass = 0;
  for (const row of hold.values()) mass += row.massKg;
  return mass;
}

/** Building residual: storey mass plus the hold, minus outdoor vents and fans. */
function buildingBudget(
  engine: SpatialEffectsEngine,
  walls: InteriorWall[],
  steps: number,
): { residual: number; peak: number; minInterface: number } {
  const view = engine as unknown as {
    layerState: Map<string, BudgetLayer>;
    shaftHold: Map<string, { massKg: number }>;
    shellNetKg: number;
  };
  const mass = () => storeyMass(view) + holdMass(view.shaftHold);
  let prev = mass();
  let residual = 0;
  let peak = 0;
  let minInterface = 99;
  for (let t = 1; t <= steps; t++) {
    const netBefore = view.shellNetKg;
    engine.step(1, walls, []);
    const upper = [...view.layerState.values()].find(
      (row) => row.active && row.members.includes('u0'),
    );
    if (upper && upper.zone.interfaceM < minInterface) minInterface = upper.zone.interfaceM;
    const now = mass();
    residual += now - prev - (view.shellNetKg - netBefore);
    if (Math.abs(residual) > Math.abs(peak)) peak = residual;
    prev = now;
  }
  return { residual, peak, minInterface };
}

describe('stair shaft scene', () => {
  test('the upper floor is bare and both shafts are there', () => {
    const scene = stairShaftSample.scene;
    assert.deepEqual(
      scene.levels.map((level) => level.id),
      ['G', 'L1'],
    );
    assert.equal(scene.levels[0]?.heightM, 3);
    assert.equal(scene.levels[1]?.heightM, 3);
    assert.match(scene.locationDescription, /cannot ignite/);
    assert.deepEqual(
      scene.stairwells.map((shaft) => shaft.kind),
      ['stair', 'lift'],
    );
    assert.deepEqual(
      scene.exits.map((exit) => exit.level),
      ['G', 'L1'],
    );
    const fuel = stairShaftFuelObjects(
      [
        { id: 'g', simPos: { x: 0, y: 0 }, spatialContext: 'inside_building', level: 'G' },
        { id: 'u', simPos: { x: 0, y: 0 }, spatialContext: 'inside_building', level: 'L1' },
        { id: 'out', simPos: { x: 20, y: 0 }, spatialContext: 'open_air', level: 'G' },
      ],
      'plan',
    );
    assert.deepEqual(
      fuel.map((item) => item.level),
      ['G'],
    );
    assert.equal(fuel[0]?.studId, 'g');
    const polygon = scene.buildingPolygon.map((pair) => [pair[0], pair[1]] as [number, number]);
    const projected = projectSceneStuds(polygon, stairShaftStuds(polygon, ['G', 'L1']));
    const pairs = shaftPairs(
      projected.map((stud) => ({
        id: stud.id,
        simPos: stud.simPos,
        level: stud.floor,
      })),
      scene.stairwells.map((shaft) => ({
        id: shaft.id,
        pos: shaft.pos,
        levels: ['G', 'L1'],
        kind: shaft.kind ?? 'stair',
        blocked: false,
        widthM: shaft.widthM,
      })),
    );
    assert.ok(
      pairs.some((pair) => pair.kind === 'stair'),
      'the stair missed every stud',
    );
    assert.ok(
      pairs.some((pair) => pair.kind === 'lift'),
      'the lift missed every stud',
    );
  });

  test('the upper crowd walks down the stair and the ground crowd uses its door', () => {
    const scene = stairShaftSample.scene;
    const polygon = scene.buildingPolygon.map((pair) => [pair[0], pair[1]] as [number, number]);
    const exits = scene.exits as unknown as ExitDef[];
    const levels = scene.levels as LevelDef[];
    const eng = new PolygonEvacuationEngine(
      { ...DEFAULT_POLYGON_CONFIG, vertices: projectPolygon(polygon), pedestrianCount: 0 },
      exits,
      [],
      [],
      { afterExit: 'zone', zones: [], seed: 5 },
      {
        ids: levels.map((level) => level.id),
        exitsByLevel: Object.fromEntries(
          levels.map((level) => [level.id, exits.filter((exit) => exit.level === level.id)]),
        ),
        wallsByLevel: { G: [], L1: [] },
        stairs: scene.stairwells.map((shaft) => normaliseStairwell(shaft, levels)),
        counts: Object.fromEntries(levels.map((level) => [level.id, level.pedestrianCount])),
        heights: Object.fromEntries(levels.map((level) => [level.id, level.heightM])),
      },
    );
    type Label = { state: string; nextCheckAt: number; pedId: number; level: string };
    const labelOf = (body: Matter.Body) => (body as Matter.Body & { __ped: Label }).__ped;
    const bodies = (eng as unknown as { pedestrians: Matter.Body[] }).pedestrians;
    const upper = new Set(
      bodies.filter((b) => labelOf(b).level === 'L1').map((b) => labelOf(b).pedId),
    );
    assert.equal(upper.size, 20);
    for (const body of bodies) {
      labelOf(body).state = 'evacuating';
      labelOf(body).nextCheckAt = 0;
    }
    const used = new Map<number, string>();
    const occ = eng as unknown as {
      stairPeople: Array<{ stairId: string; dir: string; label: Label }>;
    };
    for (let i = 0; i < Math.round(60 / DEFAULT_POLYGON_CONFIG.dt); i++) {
      eng.step();
      for (const row of occ.stairPeople) used.set(row.label.pedId, `${row.stairId}:${row.dir}`);
    }
    assert.deepEqual([...used.keys()].sort(), [...upper].sort());
    assert.ok([...used.values()].every((v) => v === 'stair-nw:down'));
    eng.destroy();
  });
});
