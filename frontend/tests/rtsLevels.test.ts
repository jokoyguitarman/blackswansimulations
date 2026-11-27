import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Matter from 'matter-js';
import { LEVEL } from '../src/lib/evacuation/levelConstants.ts';
import { HazardField, chooseRoute } from '../src/lib/evacuation/hazardSensing.ts';
import { PolygonEvacuationEngine } from '../src/lib/evacuation/engine.ts';
import { DEFAULT_POLYGON_CONFIG } from '../src/lib/evacuation/types.ts';
import type { ExitDef, Vec2 } from '../src/lib/evacuation/types.ts';
import { FireSimulation } from '../src/lib/rts/fireSimulation.ts';
import { SpatialEffectsEngine } from '../src/lib/rts/spatialEffects.ts';
import {
  defaultLevels,
  effectiveLevelPlan,
  levelCategories,
  levelIndex,
  shaftCoeffPerS,
  sortLevels,
  stairFlowPerS,
  stairTravelS,
  ventMeanVelocity,
  linkLevels,
  normaliseStairwell,
} from '../src/lib/rts/levels.ts';
import { generateSceneStuds, projectSceneStuds } from '../src/lib/rts/sceneStuds.ts';
import { defaultCharge } from '../src/lib/rts/blast/blastModel.ts';
import type { InteriorWall, LevelDef, Stairwell } from '../src/lib/rts/types.ts';

const NEIGHBOR_RADIUS = 8;

function close(actual: number, expected: number, label: string) {
  const tol = Math.abs(expected) * 0.01;
  assert.ok(Math.abs(actual - expected) <= tol, `${label}: ${actual} vs ${expected}`);
}

/** The pre-hash neighbour walk, kept as the order oracle. */
function oldNeighbors(
  studs: Array<{ id: string; simPos: Vec2; level?: string }>,
  radius: number,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (let i = 0; i < studs.length; i++) {
    const neighbors: string[] = [];
    const level = studs[i].level ?? 'G';
    for (let j = 0; j < studs.length; j++) {
      if (i === j || studs[j].id === studs[i].id) continue;
      if ((studs[j].level ?? 'G') !== level) continue;
      const d = Math.hypot(
        studs[j].simPos.x - studs[i].simPos.x,
        studs[j].simPos.y - studs[i].simPos.y,
      );
      if (d <= radius) neighbors.push(studs[j].id);
    }
    out.set(studs[i].id, neighbors);
  }
  return out;
}

function gridStuds(n: number, level?: string, prefix = 's') {
  const studs: Array<{ id: string; simPos: Vec2; spatialContext: string; level?: string }> = [];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      studs.push({
        id: `${prefix}-${r}-${c}`,
        simPos: { x: c * 3, y: r * 3 },
        spatialContext: 'inside_building',
        ...(level ? { level } : {}),
      });
    }
  }
  return studs;
}

function cacheOf(engine: object): Map<string, string[]> {
  return (engine as { neighborCache: Map<string, string[]> }).neighborCache;
}

function levelDef(id: string, index: number, designed = true): LevelDef {
  return { id, name: id, index, heightM: 4, designed, pedestrianCount: 0 };
}

const RECT: Vec2[] = [
  { x: 0, y: 0 },
  { x: 40, y: 0 },
  { x: 40, y: 20 },
  { x: 0, y: 20 },
];

function exitOn(id: string, level: string): ExitDef {
  return {
    id,
    center: { x: 0, y: 10 },
    width: 2,
    edgeIndex: 3,
    description: '',
    status: 'open',
    photos: [],
    level,
  };
}

describe('rts levels', () => {
  it('indexes, sorts and defaults storeys', () => {
    assert.equal(levelIndex('B2'), -2);
    assert.equal(levelIndex('G'), 0);
    assert.equal(levelIndex('L3'), 3);
    assert.throws(() => levelIndex('nope'));
    assert.deepEqual(sortLevels(['L2', 'B1', 'G', 'L1']), ['B1', 'G', 'L1', 'L2']);
    const defs = defaultLevels(['B1', 'G', 'L1', 'L2']);
    assert.deepEqual(
      defs.map((l) => l.id),
      ['B1', 'G', 'L1', 'L2'],
    );
    assert.equal(defaultLevels(['Ground'])[0].id, 'G');
    assert.equal(defaultLevels([])[0].id, 'G');
  });

  it('normalises a legacy stair and keeps connectsFloors in sync', () => {
    const levels = [levelDef('G', 0), levelDef('L1', 1), levelDef('L2', 2)];
    const legacy: Stairwell = {
      id: 's',
      pos: { x: 1, y: 1 },
      connectsFloors: [0, 2],
      blocked: false,
      label: 'A',
    };
    const norm = normaliseStairwell(legacy, levels);
    assert.deepEqual(norm.levels, { from: 'G', to: 'L2' });
    assert.deepEqual(linkLevels(norm, levels), ['G', 'L1', 'L2']);
    assert.deepEqual(norm.connectsFloors, [0, 2]);
    const edited = normaliseStairwell({ ...norm, levels: { from: 'G', to: 'L1' } }, levels);
    assert.deepEqual(edited.connectsFloors, [0, 1]);
    assert.deepEqual(linkLevels(edited, levels), ['G', 'L1']);
  });

  it('matches the old neighbour order on one level', () => {
    const studs = gridStuds(10);
    const oracle = oldNeighbors(studs, NEIGHBOR_RADIUS);
    const fire = new FireSimulation();
    fire.init(studs);
    const effects = new SpatialEffectsEngine(undefined, 1);
    effects.init(studs);
    for (const stud of studs) {
      assert.deepEqual(cacheOf(fire).get(stud.id), oracle.get(stud.id));
      assert.deepEqual(cacheOf(effects).get(stud.id), oracle.get(stud.id));
    }
  });

  it('does not neighbour or smoke across levels without a shaft', () => {
    const studs = [...gridStuds(4, 'G', 'g'), ...gridStuds(4, 'L1', 'u')];
    const effects = new SpatialEffectsEngine(undefined, 1);
    effects.init(studs);
    const cache = cacheOf(effects);
    for (const [id, neighbors] of cache) {
      const mine = id.startsWith('g') ? 'g' : 'u';
      for (const other of neighbors) assert.ok(other.startsWith(mine));
    }
    const source = effects.studStates.get('g-0-0');
    assert.ok(source);
    source.smoke = 1;
    for (let i = 0; i < 600; i++) effects.step(0.05, [], []);
    for (const [id, state] of effects.studStates) {
      if (id.startsWith('u')) assert.equal(state.smoke, 0);
    }
  });

  it('matches the door-flow oracle and the stack coefficients', () => {
    const temp = 400;
    const rhoS = 353 / temp;
    const depth = 0.5;
    const dP = (LEVEL.RHO_AIR - rhoS) * LEVEL.G * depth;
    const vTop = LEVEL.ORIFICE_C * Math.sqrt((2 * dP) / rhoS);
    const vMean = ventMeanVelocity(temp, depth);
    const mass = rhoS * vMean * 0.9 * depth;
    close(dP, 1.557, 'dP_top');
    close(vTop, 1.315, 'v_top');
    close(vMean, 0.877, 'v_mean');
    close(mass, 0.3482, 'mass flow');
    const stair = shaftCoeffPerS('stair', 1.2, 4);
    const lift = shaftCoeffPerS('lift', 1.2, 4);
    close(stair, (ventMeanVelocity(400, 2) * 1.2) / 9, 'stair coeff');
    close(stair, 0.234, 'stair coeff oracle');
    close(lift, 0.195, 'lift coeff');
    assert.equal(
      stairFlowPerS({ widthM: 1.2 } as Stairwell),
      LEVEL.STAIR_SPECIFIC_FLOW * (1.2 - 0.3),
    );
    const travel = stairTravelS(levelDef('L1', 1), 'down');
    close(travel, (4 * LEVEL.STAIR_TRAVEL_FACTOR) / LEVEL.STAIR_SPEED_DOWN, 'travel');
  });

  it('does not carry a cold smoke number through a shaft', () => {
    const pair = [
      { id: 'g', simPos: { x: 5, y: 5 }, spatialContext: 'inside_building', level: 'G' },
      { id: 'u', simPos: { x: 5, y: 5 }, spatialContext: 'inside_building', level: 'L1' },
    ];
    const run = (kind: 'stair' | 'lift', blocked: boolean, source: 'g' | 'u') => {
      const engine = new SpatialEffectsEngine(undefined, 1);
      engine.init(pair);
      engine.setVerticalLinks([
        { id: 's', pos: { x: 5, y: 5 }, levels: ['G', 'L1'], kind, blocked },
      ]);
      engine.studStates.get(source)!.smoke = 1;
      for (let i = 0; i < 120; i++) engine.step(0.05, [], []);
      return {
        g: engine.studStates.get('g')!.smoke,
        u: engine.studStates.get('u')!.smoke,
      };
    };
    // The old mix pushed this number upstairs at a fixed 400 K. A shaft
    // now moves the layer, and a cold stud has no layer.
    const open = run('stair', false, 'g');
    assert.equal(open.u, 0);
    const blocked = run('stair', true, 'g');
    assert.equal(blocked.u, 0);
    const down = run('stair', false, 'u');
    assert.equal(down.g, 0);
    const lift = run('lift', false, 'g');
    assert.equal(lift.u, 0);
  });

  it('does not ignite a landing on the 60 s timer', () => {
    const studs = [
      { id: 'g', simPos: { x: 5, y: 5 }, spatialContext: 'inside_building', level: 'G' },
      { id: 'u', simPos: { x: 5, y: 5 }, spatialContext: 'inside_building', level: 'L1' },
    ];
    const fire = new FireSimulation();
    fire.init(studs);
    fire.setShaftPairs([{ lower: 'g', upper: 'u', kind: 'stair', blocked: false, coeffPerS: 0.2 }]);
    fire.ignite(['g']);
    for (let i = 0; i < LEVEL.STAIR_FIRE_HEAT_S + 5; i++) fire.step(1, [], []);
    assert.equal(fire.states.get('g')!.state, 'burning');
    assert.equal(fire.states.get('u')!.state, 'none');
  });

  it('chooses a clear stair, refuses blocked stairs, and takes a local exit', () => {
    const levels = [levelDef('G', 0), levelDef('L1', 1), levelDef('L2', 2)];
    const stairs: Stairwell[] = [
      {
        id: 'smoky',
        pos: { x: 4, y: 10 },
        connectsFloors: [0, 2],
        blocked: false,
        label: 'S',
        kind: 'stair',
        levels: { from: 'G', to: 'L2' },
      },
      {
        id: 'clear',
        pos: { x: 26, y: 10 },
        connectsFloors: [0, 2],
        blocked: false,
        label: 'C',
        kind: 'stair',
        levels: { from: 'G', to: 'L2' },
      },
    ];
    const smoky = new HazardField([{ id: 'burn', simPos: { x: 4, y: 10 }, indoor: true }], 3);
    smoky.setStates(new Map([['burn', { smoke: 1, fire: { state: 'burning' } }]]));
    const clear = new HazardField([], 3);
    const fields = new Map<string, HazardField>([
      ['L2', smoky],
      ['L1', clear],
      ['G', clear],
    ]);
    const exits = [exitOn('out', 'G')];
    const picked = chooseRoute({ x: 10, y: 10 }, 'L2', exits, stairs, levels, fields, RECT);
    assert.equal(picked?.kind, 'stair');
    assert.equal(picked?.id, 'clear');
    const blocked = stairs.map((sw) => ({ ...sw, blocked: true }));
    assert.equal(chooseRoute({ x: 10, y: 10 }, 'L2', exits, blocked, levels, fields, RECT), null);
    const direct = chooseRoute({ x: 2, y: 10 }, 'G', exits, stairs, levels, fields, RECT);
    assert.equal(direct?.kind, 'exit');
    assert.equal(direct?.id, 'out');
  });

  it('copies an undesigned storey from the designed storey below', () => {
    const levels = [levelDef('G', 0), levelDef('L1', 1), levelDef('L2', 2, false)];
    const wall: InteriorWall = {
      id: 'w',
      start: { x: 1, y: 1 },
      end: { x: 4, y: 1 },
      hasDoor: true,
      doorWidth: 1,
      doorPosition: 0.5,
      description: '',
      material: '',
      photos: [],
      level: 'L1',
    };
    const plan = effectiveLevelPlan('L2', levels, { walls: [wall], exits: [] });
    assert.equal(plan.assumedFrom, 'L1');
    assert.equal(plan.walls.length, 1);
    assert.equal(plan.walls[0].level, 'L2');
    assert.equal(plan.walls[0].id, 'w');
  });

  it('keeps the single-level collision categories', () => {
    assert.deepEqual(levelCategories(0), { ped: 0x0001, wall: 0x0002 });
    assert.equal(levelCategories(1).ped, 0x0004);
    assert.equal(levelCategories(1).wall, 0x0008);
  });

  it('leaves a single-storey snapshot without a level', () => {
    const eng = new PolygonEvacuationEngine(
      { ...DEFAULT_POLYGON_CONFIG, vertices: RECT, pedestrianCount: 1 },
      [exitOn('out', 'G')],
    );
    const snap = eng.getSnapshots()[0];
    assert.ok(snap);
    assert.equal('level' in snap, false);
    assert.equal(eng.getMetrics().showcase, undefined);
    eng.destroy();
  });

  it('walks an empty stair in about 11.5 seconds', () => {
    const levels = [levelDef('G', 0), levelDef('L1', 1)];
    const stair: Stairwell = {
      id: 's',
      pos: { x: 20, y: 10 },
      connectsFloors: [0, 1],
      blocked: false,
      label: 'S',
      kind: 'stair',
      widthM: 1.2,
      levels: { from: 'G', to: 'L1' },
    };
    const eng = new PolygonEvacuationEngine(
      { ...DEFAULT_POLYGON_CONFIG, vertices: RECT, pedestrianCount: 0 },
      [],
      [],
      [],
      { afterExit: 'zone', zones: [], seed: 1 },
      {
        ids: ['G', 'L1'],
        exitsByLevel: { G: [exitOn('out', 'G')], L1: [] },
        wallsByLevel: { G: [], L1: [] },
        stairs: [stair],
        counts: { G: 0, L1: 1 },
        heights: { G: 4, L1: 4 },
      },
    );
    const body = (eng as unknown as { pedestrians: Matter.Body[] }).pedestrians[0];
    const ped = (
      body as Matter.Body & { __ped: { state: string; nextCheckAt: number; level: string } }
    ).__ped;
    Matter.Body.setPosition(body, { x: 20.2, y: 10 });
    ped.state = 'evacuating';
    ped.nextCheckAt = 0;
    ped.level = 'L1';
    const dt = DEFAULT_POLYGON_CONFIG.dt;
    let appeared = -1;
    for (let i = 0; i < 800; i++) {
      eng.step();
      const onG = eng.getSnapshots().find((s) => s.level === 'G' && !s.inStair);
      if (onG) {
        appeared = (i + 1) * dt;
        break;
      }
    }
    const expectS = (4 * 2) / 0.694;
    assert.ok(appeared > 0, 'person never arrived on G');
    assert.ok(Math.abs(appeared - expectS) <= 0.5, `transit ${appeared}s, expected ${expectS}`);
    eng.destroy();
  });

  it('releases a stair queue no faster than the specific flow', () => {
    const levels = [levelDef('G', 0), levelDef('L1', 1), levelDef('L2', 2)];
    const stair: Stairwell = {
      id: 's',
      pos: { x: 20, y: 10 },
      connectsFloors: [0, 2],
      blocked: false,
      label: 'S',
      kind: 'stair',
      widthM: 1.2,
      levels: { from: 'G', to: 'L2' },
    };
    const count = 25;
    const eng = new PolygonEvacuationEngine(
      { ...DEFAULT_POLYGON_CONFIG, vertices: RECT, pedestrianCount: 0 },
      [],
      [],
      [],
      { afterExit: 'zone', zones: [], seed: 2 },
      {
        ids: ['G', 'L1', 'L2'],
        exitsByLevel: { G: [exitOn('out', 'G')], L1: [], L2: [] },
        wallsByLevel: { G: [], L1: [], L2: [] },
        stairs: [stair],
        counts: { G: 0, L1: 0, L2: count },
        heights: { G: 4, L1: 4, L2: 4 },
      },
    );
    const bodies = (eng as unknown as { pedestrians: Matter.Body[] }).pedestrians;
    const wall = levelCategories(2).wall;
    for (const body of bodies) {
      const ped = (body as Matter.Body & { __ped: { state: string; nextCheckAt: number } }).__ped;
      Matter.Body.setPosition(body, { x: 20, y: 10 });
      ped.state = 'evacuating';
      ped.nextCheckAt = 0;
      body.collisionFilter.mask = wall;
    }
    const dt = DEFAULT_POLYGON_CONFIG.dt;
    const steps = Math.round(10 / dt);
    for (let i = 0; i < steps; i++) eng.step();
    const occ = (eng as unknown as { stairPeople: Array<{ phase: string }> }).stairPeople;
    const traveling = occ.filter((p) => p.phase === 'travel').length;
    const below = eng.getSnapshots().filter((s) => s.level !== 'L2').length;
    const released = traveling + below;
    const flow = stairFlowPerS(stair);
    assert.ok(released >= 2, `only ${released} released`);
    assert.ok(released <= flow * 10 + 1 + 1e-6, `released ${released}, cap ${flow * 10 + 1}`);
    eng.destroy();
  });

  it('holds 40 trickled and bunched arrivals to the stair cap', () => {
    const stair: Stairwell = {
      id: 's',
      pos: { x: 20, y: 10 },
      connectsFloors: [0, 1],
      blocked: false,
      label: 'S',
      kind: 'stair',
      widthM: 1.2,
      levels: { from: 'G', to: 'L1' },
    };
    const count = 40;
    const eng = new PolygonEvacuationEngine(
      { ...DEFAULT_POLYGON_CONFIG, vertices: RECT, pedestrianCount: 0 },
      [],
      [],
      [],
      { afterExit: 'zone', zones: [], seed: 4 },
      {
        ids: ['G', 'L1'],
        exitsByLevel: { G: [exitOn('out', 'G')], L1: [] },
        wallsByLevel: { G: [], L1: [] },
        stairs: [stair],
        counts: { G: 0, L1: count },
        heights: { G: 4, L1: 4 },
      },
    );
    type Occ = {
      label: { pedId: number; state: string };
      stairId: string;
      dir: 'up' | 'down';
      fromLevel: string;
      toLevel: string;
      phase: 'queue' | 'travel';
      enqueuedAt: number;
      travelStart: number;
      travelDuration: number;
    };
    const inner = eng as unknown as {
      pedestrians: Matter.Body[];
      stairPeople: Occ[];
      engine: Matter.Engine;
    };
    const labels = inner.pedestrians.map(
      (body) => (body as Matter.Body & { __ped: Occ['label'] }).__ped,
    );
    for (const body of inner.pedestrians) Matter.Composite.remove(inner.engine.world, body);
    inner.pedestrians.length = 0;
    const spacing = [0.02, 0.02, 0.02, 0.3, 0.6, 1.5, 3, 0.02, 0.9, 0.4];
    const dt = DEFAULT_POLYGON_CONFIG.dt;
    const arriveAt: number[] = [];
    let t = 0.5;
    for (let i = 0; i < count; i++) {
      arriveAt.push(t);
      t += spacing[i % spacing.length];
    }
    const released = new Map<number, number>();
    let next = 0;
    for (let i = 0; i < Math.round((t + 60) / dt); i++) {
      const now = i * dt;
      while (next < count && arriveAt[next] <= now + 1e-9) {
        labels[next].state = 'evacuating';
        inner.stairPeople.push({
          label: labels[next],
          stairId: 's',
          dir: 'down',
          fromLevel: 'L1',
          toLevel: 'G',
          phase: 'queue',
          enqueuedAt: now,
          travelStart: now,
          travelDuration: 1,
        });
        next++;
      }
      eng.step();
      for (const occ of inner.stairPeople) {
        if (occ.phase === 'travel' && !released.has(occ.label.pedId)) {
          released.set(occ.label.pedId, occ.travelStart);
        }
      }
    }
    const times = [...released.values()].sort((a, b) => a - b);
    assert.equal(times.length, count);
    const flow = stairFlowPerS(stair);
    for (let i = 1; i < times.length; i++) {
      const gap = times[i] - times[i - 1];
      assert.ok(gap >= 1 / flow - dt - 1e-9, `gap ${gap.toFixed(3)} s after release ${i}`);
    }
    for (let i = 0; i < times.length; i++) {
      for (let j = i + 1; j < times.length; j++) {
        const cap = (times[j] - times[i] + dt) * flow + 1e-6;
        assert.ok(j - i <= cap, `${j - i} releases in ${(times[j] - times[i]).toFixed(2)} s`);
      }
    }
    eng.destroy();
  });

  it('switches stairs within half a second when the one in use is smoke-logged', () => {
    const levels = [levelDef('G', 0), levelDef('L1', 1), levelDef('L2', 2)];
    const stairs: Stairwell[] = [
      {
        id: 'smoky',
        pos: { x: 4, y: 10 },
        connectsFloors: [0, 2],
        blocked: false,
        label: 'S',
        kind: 'stair',
        levels: { from: 'G', to: 'L2' },
      },
      {
        id: 'clear',
        pos: { x: 26, y: 10 },
        connectsFloors: [0, 2],
        blocked: false,
        label: 'C',
        kind: 'stair',
        levels: { from: 'G', to: 'L2' },
      },
    ];
    const eng = new PolygonEvacuationEngine(
      { ...DEFAULT_POLYGON_CONFIG, vertices: RECT, pedestrianCount: 0 },
      [],
      [],
      [],
      { afterExit: 'zone', zones: [], seed: 3 },
      {
        ids: ['G', 'L1', 'L2'],
        exitsByLevel: { G: [exitOn('out', 'G')], L1: [], L2: [] },
        wallsByLevel: { G: [], L1: [], L2: [] },
        stairs,
        counts: { G: 0, L1: 0, L2: 1 },
        heights: { G: 4, L1: 4, L2: 4 },
      },
    );
    const smoky = new HazardField([{ id: 'top', simPos: { x: 4, y: 10 }, indoor: true }], 3);
    smoky.setStates(new Map([['top', { smoke: 1, fire: { state: 'none' } }]]));
    const empty = new HazardField([], 3);
    eng.setHazardFields(
      new Map([
        ['L2', smoky],
        ['L1', empty],
        ['G', empty],
      ]),
    );
    const body = (eng as unknown as { pedestrians: Matter.Body[] }).pedestrians[0];
    const ped = (
      body as Matter.Body & {
        __ped: {
          state: string;
          nextCheckAt: number;
          targetStairId: string | null;
          stairDir: string;
        };
      }
    ).__ped;
    Matter.Body.setPosition(body, { x: 10, y: 10 });
    ped.state = 'evacuating';
    ped.nextCheckAt = 0;
    ped.targetStairId = 'smoky';
    ped.stairDir = 'down';
    const steps = Math.round(0.5 / DEFAULT_POLYGON_CONFIG.dt);
    for (let i = 0; i < steps; i++) eng.step();
    assert.equal(ped.targetStairId, 'clear');
    eng.destroy();
  });

  it('alarms every storey from triggerBlast', () => {
    const eng = new PolygonEvacuationEngine(
      { ...DEFAULT_POLYGON_CONFIG, vertices: RECT, pedestrianCount: 0 },
      [exitOn('out', 'G')],
      [],
      [],
      { afterExit: 'zone', zones: [], seed: 1 },
      {
        ids: ['G', 'L1'],
        exitsByLevel: { G: [exitOn('out', 'G')], L1: [] },
        wallsByLevel: { G: [], L1: [] },
        stairs: [],
        counts: { G: 1, L1: 1 },
        heights: { G: 4, L1: 4 },
      },
    );
    eng.setBlastLevel('G');
    const bodies = (eng as unknown as { pedestrians: Matter.Body[] }).pedestrians;
    for (const body of bodies) Matter.Body.setPosition(body, { x: 10, y: 10 });
    eng.triggerBlast({ x: 10, y: 10 }, 8);
    const byLevel = new Map<string, { state: string; injury: string }>();
    for (const body of bodies) {
      const ped = (
        body as Matter.Body & { __ped: { level: string; state: string; injury: string } }
      ).__ped;
      byLevel.set(ped.level, { state: ped.state, injury: ped.injury });
    }
    assert.equal(byLevel.get('G')?.state, 'down');
    assert.equal(byLevel.get('L1')?.state, 'reacting');
    assert.equal(byLevel.get('L1')?.injury, 'none');
    eng.destroy();
  });

  it('a wall on another storey does not raise blast pressure', () => {
    const behind = {
      startX: 8,
      startY: 0,
      endX: 8,
      endY: 20,
      hasDoor: false,
      doorWidth: 0,
      doorPosition: 0.5,
    };
    const eng = new PolygonEvacuationEngine(
      { ...DEFAULT_POLYGON_CONFIG, vertices: RECT, pedestrianCount: 0 },
      [],
      [behind],
      [],
      { afterExit: 'zone', zones: [], seed: 1 },
      {
        ids: ['G', 'L1'],
        exitsByLevel: { G: [exitOn('out', 'G')], L1: [exitOn('up', 'L1')] },
        wallsByLevel: { G: [], L1: [behind] },
        stairs: [],
        counts: { G: 1, L1: 0 },
        heights: { G: 4, L1: 4 },
      },
    );
    eng.setBlastLevel('G');
    eng.setInteriorWalls([behind]);
    const body = (eng as unknown as { pedestrians: Matter.Body[] }).pedestrians[0];
    Matter.Body.setPosition(body, { x: 7, y: 10 });
    eng.triggerBlast({ x: 0, y: 10 }, { mode: 'pressure', spec: defaultCharge(), heightM: 0 });
    const ped = (
      body as Matter.Body & {
        __ped: {
          level: string;
          state: string;
          injury: string;
          nearWall?: boolean;
          blastKpa?: number;
        };
      }
    ).__ped;
    assert.equal(ped.level, 'G');
    assert.equal(ped.nearWall, false);
    assert.equal(ped.injury, 'minor');
    assert.equal(ped.state, 'reacting');
    assert.ok(ped.blastKpa != null && Math.abs(ped.blastKpa - 128) < 2, `pressure ${ped.blastKpa}`);
    eng.destroy();
  });

  it('reloads indoor studs on every saved storey', () => {
    const polygon: [number, number][] = [
      [51.5, -0.12],
      [51.5, -0.1196],
      [51.50036, -0.1196],
      [51.50036, -0.12],
    ];
    const studs = generateSceneStuds(polygon, 0, ['G', 'L1', 'B1']);
    const inside = (floor: string) =>
      studs.filter((s) => s.spatialContext === 'inside_building' && s.floor === floor);
    assert.ok(inside('G').length > 0);
    assert.equal(inside('L1').length, inside('G').length);
    assert.equal(inside('B1').length, inside('G').length);
    assert.ok(inside('L1').every((s) => s.id.includes('-L1-')));
    const outdoor = studs.filter((s) => s.spatialContext === 'open_air');
    assert.ok(outdoor.length > 0);
    assert.ok(outdoor.every((s) => s.floor === 'G'));
    assert.equal(new Set(studs.map((s) => s.id)).size, studs.length);
    const groundOnly = generateSceneStuds(polygon, 0, ['G']);
    assert.ok(groundOnly.some((s) => s.id.startsWith('bldg-0-G-')));
    assert.equal(groundOnly.filter((s) => s.floor === 'L1').length, 0);
  });

  it('covers a placement past the margin without moving indoor studs', () => {
    const polygon: [number, number][] = [
      [51.5, -0.12],
      [51.5, -0.1196],
      [51.50036, -0.1196],
      [51.50036, -0.12],
    ];
    const plain = generateSceneStuds(polygon, 0, ['G']);
    const indoors = plain.filter((stud) => stud.spatialContext === 'inside_building');
    assert.ok(indoors.length > 0);
    const covered = generateSceneStuds(polygon, 0, ['G'], [{ x: 120, y: -30, radiusM: 8 }]);
    for (const stud of indoors) {
      const again = covered.find((other) => other.id === stud.id);
      assert.ok(again, stud.id);
      assert.equal(again?.lat, stud.lat);
      assert.equal(again?.lng, stud.lng);
    }
    const projected = projectSceneStuds(polygon, covered);
    const near = projected.some((stud) => Math.hypot(stud.simPos.x - 120, stud.simPos.y + 30) < 4);
    assert.ok(near, 'placement has no stud');
    const inside = generateSceneStuds(polygon, 0, ['G'], [{ x: 1, y: 1, radiusM: 2 }]);
    assert.deepEqual(
      inside.map((stud) => stud.id),
      plain.map((stud) => stud.id),
    );
    const far = generateSceneStuds(polygon, 0, ['G'], [{ x: 220, y: 0 }]);
    const farProjected = projectSceneStuds(polygon, far);
    assert.ok(
      farProjected.some((stud) => Math.hypot(stud.simPos.x - 220, stud.simPos.y) < 4),
      'placement past the index pad has no stud',
    );
  });

  it('lets smoke leave the outdoor edge of a scene grid', () => {
    const openStuds = [];
    const closedStuds = [];
    for (let r = 0; r < 5; r++) {
      for (let c = 0; c < 5; c++) {
        const simPos = { x: c * 3, y: r * 3 };
        openStuds.push({
          id: `ext-0-${r}-${c}`,
          simPos,
          spatialContext: 'open_air' as const,
          level: 'G',
        });
        closedStuds.push({
          id: `s-${r}-${c}`,
          simPos,
          spatialContext: 'open_air' as const,
          level: 'G',
        });
      }
    }
    const open = new SpatialEffectsEngine(undefined, 1);
    const closed = new SpatialEffectsEngine(undefined, 1);
    open.init(openStuds);
    closed.init(closedStuds);
    const openCorner = open.studStates.get('ext-0-0-0');
    const openCenter = open.studStates.get('ext-0-2-2');
    const closedCorner = closed.studStates.get('s-0-0');
    const closedCenter = closed.studStates.get('s-2-2');
    assert.ok(openCorner && openCenter && closedCorner && closedCenter);
    openCorner.smoke = 1;
    openCenter.smoke = 1;
    closedCorner.smoke = 1;
    closedCenter.smoke = 1;
    open.step(0.1, [], []);
    closed.step(0.1, [], []);
    assert.ok(
      openCorner.smoke < closedCorner.smoke,
      `corner ${openCorner.smoke} vs ${closedCorner.smoke}`,
    );
    assert.ok(
      Math.abs(openCenter.smoke - closedCenter.smoke) < 1e-9,
      `center ${openCenter.smoke} vs ${closedCenter.smoke}`,
    );
  });

  it('initialises four storeys of studs within half a second', () => {
    const studs = [];
    for (const level of ['B1', 'G', 'L1', 'L2']) {
      for (let i = 0; i < 700; i++) {
        studs.push({
          id: `${level}-${i}`,
          simPos: { x: (i % 28) * 3, y: Math.floor(i / 28) * 3 },
          spatialContext: 'inside_building',
          level,
        });
      }
    }
    const engine = new SpatialEffectsEngine(undefined, 1);
    const t0 = performance.now();
    engine.init(studs);
    const ms = performance.now() - t0;
    assert.ok(ms <= 500, `effects init ${ms.toFixed(1)} ms`);
  });
});
