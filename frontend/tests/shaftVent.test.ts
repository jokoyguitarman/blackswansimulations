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
import { shaftPairs } from '../src/lib/rts/levels.ts';
import { projectSceneStuds } from '../src/lib/rts/sceneStuds.ts';
import {
  stairShaftFuelObjects,
  stairShaftSample,
  stairShaftStuds,
} from '../src/lib/rts/stairShaftTest.ts';
import type { InteriorWall } from '../src/lib/rts/types.ts';
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

function roomWalls(level: string): InteriorWall[] {
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
    doorWidth: 0.9,
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
function shaftRoom() {
  const studs = [
    stud('g0', 0, 0, 'G', true),
    stud('g1', 3, 0, 'G', true),
    stud('gout', 6, 0, 'G', false),
    stud('u0', 0, 0, 'L1', true),
    stud('u1', 3, 0, 'L1', true),
    stud('uout', 6, 0, 'L1', false),
  ];
  const walls = [...roomWalls('G'), ...roomWalls('L1')];
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
});

describe('stair shaft scene', () => {
  test('the upper floor is bare and both shafts are there', () => {
    const scene = stairShaftSample.scene;
    assert.deepEqual(
      scene.levels.map((level) => level.id),
      ['G', 'L1'],
    );
    assert.equal(scene.levels[0]?.heightM, 3);
    assert.equal(scene.levels[1]?.heightM, 3);
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
});
