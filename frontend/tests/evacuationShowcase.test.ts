import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { SHOWCASE, SHOWCASE_SOURCES, type ShowcaseKey } from '../src/lib/evacuation/showcaseConstants';
import {
  HazardField,
  assemblyMinDistanceM,
  chooseExit,
  crouchExtinction,
  exitApproachInside,
  exitCost,
  extinctionK,
  headSmokeClass,
  isExitUsable,
  jinFactor,
  layerK,
  lognormalFromPercentiles,
  lognormalFromQuartiles,
  mulberry32,
  nextIndoorWaypoint,
  nextPosture,
  distanceToOutline,
  routeAroundOutline,
  outdoorSpeed,
  radiantAvoidRadiusM,
  samplePremovementS,
  smokeAheadAction,
  visibilityM,
  walkingSpeed,
  type HazardStud,
} from '../src/lib/evacuation/hazardSensing';
import {
  blastEffectsTriggerSec,
  blastInjuryBand,
  countdownLabel,
  explosionFxFrame,
  isBlastDue,
  shiftEvents,
} from '../src/lib/evacuation/showcase';
import { FireSimulation } from '../src/lib/rts/fireSimulation';
import { SpatialEffectsEngine } from '../src/lib/rts/spatialEffects';
import { isInsidePolygon } from '../src/lib/evacuation/geometry';
import { PolygonEvacuationEngine } from '../src/lib/evacuation/engine';
import type { ExitDef, PolygonSimConfig, ShowcaseZone, Vec2 } from '../src/lib/evacuation/types';
import Matter from 'matter-js';

const FOLDER_ASSUMED: Partial<Record<ShowcaseKey, string>> = {
  D_TO_K_POINTS: 'knowledge-seeds/fire-smoke-tenability/',
  SMOKE_HEAD_ONSET: 'knowledge-seeds/fire-smoke-tenability/',
  LAYER_STEP_D: 'knowledge-seeds/fire-smoke-tenability/',
  CROUCH_SPEED_FACTOR: 'knowledge-seeds/fire-smoke-tenability/',
  HEAT_AVOID_RADIUS_M: 'knowledge-seeds/fire-smoke-tenability/',
  PREMOVE_MAX_S: 'knowledge-seeds/fire-smoke-tenability/',
  DEFAULT_BLAST_RADIUS_M: 'knowledge-seeds/blast-effects/',
  MINOR_INJURY_SPEED_FACTOR: 'knowledge-seeds/blast-effects/',
  BLAST_PUSH_SPEED: 'knowledge-seeds/blast-effects/',
  AMBIENT_HEAT_S: 'knowledge-seeds/fire-smoke-tenability/',
};

const NO_STREAM: ShowcaseKey[] = [
  'STAFF_SHARE',
  'SHOWCASE_PANIC',
  'IDLE_WANDER_SPEED',
  'IDLE_WANDER_RADIUS_M',
  'SMOKE_COST_M_PER_K',
  'CONGESTED_PENALTY_M',
  'DISPERSE_SHARE',
];

function close(actual: number, expected: number, rel = 0.01) {
  const tol = Math.max(1e-9, Math.abs(expected) * rel);
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `expected ${expected} ± ${tol}, got ${actual}`,
  );
}

function exit(partial: {
  id: string;
  center: Vec2;
  edgeIndex: number;
  status?: ExitDef['status'];
  exitType?: ExitDef['exitType'];
  width?: number;
}): ExitDef {
  return {
    id: partial.id,
    center: partial.center,
    width: partial.width ?? 2,
    edgeIndex: partial.edgeIndex,
    description: partial.id,
    status: partial.status ?? 'open',
    photos: [],
    exitType: partial.exitType,
  };
}

function field(
  studs: HazardStud[],
  states: Record<string, { smoke: number; fire: string }> = {},
): HazardField {
  const f = new HazardField(studs, 3);
  const map = new Map<string, { smoke: number; fire: { state: string } }>();
  for (const [id, s] of Object.entries(states)) {
    map.set(id, { smoke: s.smoke, fire: { state: s.fire } });
  }
  f.setStates(map);
  return f;
}

const BIG: Vec2[] = [
  { x: -10, y: -10 },
  { x: 500, y: -10 },
  { x: 500, y: 10 },
  { x: -10, y: 10 },
];

describe('evacuation showcase', () => {
  test('1 sources cover every showcase key', () => {
    const keys = Object.keys(SHOWCASE).sort();
    assert.deepEqual(Object.keys(SHOWCASE_SOURCES).sort(), keys);
    for (const key of NO_STREAM) {
      assert.equal(SHOWCASE_SOURCES[key].status, 'assumed');
      assert.equal(SHOWCASE_SOURCES[key].ref, 'assumed: no research stream');
    }
    for (const [key, folder] of Object.entries(FOLDER_ASSUMED) as Array<[ShowcaseKey, string]>) {
      const source = SHOWCASE_SOURCES[key];
      assert.equal(source.status, 'assumed', key);
      assert.ok(source.ref.includes(folder), `${key} ref ${source.ref} missing ${folder}`);
    }
  });

  test('2 extinction and visibility', () => {
    assert.equal(extinctionK(0), 0);
    close(extinctionK(0.03), 0.15, 1e-9);
    close(extinctionK(0.24), 0.5, 1e-9);
    close(extinctionK(0.45), 1.5, 1e-9);
    close(extinctionK(0.9), 6.05, 1e-6);
    let prev = -1;
    for (let d = 0; d <= 1.0001; d += 0.01) {
      const k = extinctionK(d);
      assert.ok(k >= prev - 1e-9);
      prev = k;
    }
    assert.equal(visibilityM(0.15), 20);
    assert.equal(visibilityM(0.5), 6);
    assert.equal(visibilityM(1.5), 2);
    assert.equal(visibilityM(0.05), 30);
    close(visibilityM(1.5, 8), 8 / 1.5, 1e-9);
  });

  test('3 Jin oracle stores thresholds as K', () => {
    assert.equal(crouchExtinction('visitor'), 0.15);
    assert.equal(crouchExtinction('staff'), 0.5);
    close(0.15 * 13, 1.95, 0.01);
    close(0.5 * 4, 2.0, 0.01);
    const classes = [0.14, 0.15, 0.49, 0.5, 1.49, 1.5].map(headSmokeClass);
    assert.deepEqual(classes, ['clear', 'light', 'light', 'thick', 'thick', 'untenable']);
  });

  test('4 posture layers and speeds', () => {
    const layers = layerK(0.45);
    close(layers.head, 1.5, 1e-9);
    close(layers.waist, extinctionK(0.25), 1e-12);
    close(layers.waist, 0.531, 0.002);
    assert.equal(nextPosture('stand', 0.02, 'visitor'), 'stand');
    assert.equal(nextPosture('stand', 0.03, 'visitor'), 'crouch');
    assert.equal(nextPosture('crouch', 0.23, 'visitor'), 'crawl');
    assert.equal(nextPosture('stand', 0.23, 'staff'), 'stand');
    assert.equal(nextPosture('stand', 0.24, 'staff'), 'crouch');
    assert.equal(nextPosture('crouch', 0.44, 'staff'), 'crawl');
    assert.equal(nextPosture('crawl', 0.21, 'visitor'), 'crouch');
    const stand = walkingSpeed(0.2, 'stand', 0.5, 1);
    assert.equal(walkingSpeed(0.2, 'crouch', 0.5, 1), stand * 0.6);
    assert.equal(walkingSpeed(1.2, 'crawl', 0.5, 0.4), 0.71 * 0.4);
  });

  test('5 jin factor is monotone', () => {
    assert.equal(jinFactor(0), 1);
    close(jinFactor(1), (1.0573 - 0.4326) / 1.0573, 1e-6);
    assert.equal(jinFactor(6), 0.2 / 1.19);
    let prev = jinFactor(0);
    for (let k = 0.25; k <= 6.001; k += 0.25) {
      const v = jinFactor(k);
      assert.ok(v <= prev + 1e-12);
      prev = v;
    }
  });

  test('5a pre-movement oracles', () => {
    const pct = lognormalFromPercentiles(0.5, 2.5);
    assert.ok(Math.abs(pct.mu - 0.1116) < 1e-3);
    assert.ok(Math.abs(pct.sigma - 0.3459) < 1e-3);
    assert.ok(Math.abs(Math.exp(pct.mu) - 1.118) < 1e-3);
    const q = lognormalFromQuartiles(0.3, 0.9);
    assert.ok(Math.abs(q.sigma - 0.8144) < 1e-3, `sigma ${q.sigma}`);
    assert.equal(SHOWCASE.PREMOVE_MEDIAN_S / 60, 0.5);
    const rng = mulberry32(SHOWCASE.RNG_SEED);
    const draws: number[] = [];
    for (let i = 0; i < 10_000; i++) draws.push(samplePremovementS(rng));
    draws.sort((a, b) => a - b);
    const median = (draws[4999] + draws[5000]) / 2;
    assert.ok(Math.abs(median - 30) <= 1.5, `median ${median}`);
    for (const v of draws) assert.ok(v >= 12 && v <= 150);
  });

  test('5b assembly distance', () => {
    assert.equal(assemblyMinDistanceM(45), 45);
    assert.equal(assemblyMinDistanceM(12), 20);
  });

  test('5c radiant oracle', () => {
    const q = (0.35 * 2000) / (4 * Math.PI * 4 * 4);
    close(q, 3.482, 0.01);
    close(Math.pow(35 / q, 1.33), 21.5, 0.01);
    close(radiantAvoidRadiusM(2250, 0.35, 2.5), 5, 0.01);
  });

  test('5d outdoor speed switches', () => {
    assert.equal(outdoorSpeed(10, 0.5, 1), 2.14);
    assert.equal(outdoorSpeed(60, 0.5, 1), 1.44);
    assert.equal(outdoorSpeed(10, 2.0, 1), 1.44);
  });

  test('5e turn-back share', () => {
    const rng = mulberry32(SHOWCASE.RNG_SEED);
    let n = 0;
    for (let i = 0; i < 1000; i++) if (rng() < SHOWCASE.TURN_BACK_PERMILLE / 1000) n++;
    assert.ok(Math.abs(n / 1000 - 0.3) <= 0.03, `share ${n / 1000}`);
  });

  test('5f reroute rule and exit approach', () => {
    assert.equal(smokeAheadAction(1.4, 100, 50), 'keep');
    assert.equal(smokeAheadAction(1.6, 100, 140), 'switch');
    assert.equal(smokeAheadAction(1.6, 100, 160), 'keep');
    const usable = exit({ id: 'e', center: { x: 500, y: 0 }, edgeIndex: 1 });
    const approach = exitApproachInside(usable, BIG);
    const at15 = field([{ id: 's', simPos: approach, indoor: true }], {
      s: { smoke: 0.45, fire: 'none' },
    });
    const at151 = field([{ id: 's', simPos: approach, indoor: true }], {
      s: { smoke: 0.451, fire: 'none' },
    });
    assert.equal(isExitUsable(usable, BIG, at15), true);
    assert.equal(isExitUsable(usable, BIG, at151), false);
    assert.ok(Math.abs(extinctionK(0.45) - 1.5) < 1e-9);
    assert.ok(extinctionK(0.451) > 1.5);
  });

  test('6 exit cost', () => {
    const open = exit({ id: 'e', center: { x: 200, y: 0 }, edgeIndex: 1 });
    const blocked = { ...open, status: 'blocked' as const };
    const congested = { ...open, status: 'congested' as const };
    const empty = field([]);
    const pos = { x: 0, y: 0 };
    assert.equal(exitCost(pos, blocked, BIG, empty), Infinity);
    assert.equal(exitCost(pos, congested, BIG, empty) - exitCost(pos, open, BIG, empty), 15);
    const approach = exitApproachInside(open, BIG);
    const mid = { x: (pos.x + approach.x) / 2, y: (pos.y + approach.y) / 2 };
    const burning = field([{ id: 'b', simPos: mid, indoor: true }], {
      b: { smoke: 0, fire: 'burning' },
    });
    assert.equal(exitCost(pos, open, BIG, burning), Infinity);
  });

  test('7 chooseExit hysteresis, exclude, and fallback', () => {
    const pos = { x: 0, y: 0 };
    const far = exit({ id: 'far', center: { x: 500, y: 0 }, edgeIndex: 1 });
    const x85 = Math.sqrt(425 * 425 - 100);
    const x75 = Math.sqrt(375 * 375 - 100);
    const x90 = Math.sqrt(450 * 450 - 100);
    const near85 = exit({ id: 'near', center: { x: x85, y: 10 }, edgeIndex: 2 });
    const near75 = exit({ id: 'near', center: { x: x75, y: 10 }, edgeIndex: 2 });
    const near90 = exit({ id: 'near', center: { x: x90, y: 10 }, edgeIndex: 2 });
    const empty = field([]);
    const farCost = exitCost(pos, far, BIG, empty);
    const stay85 = chooseExit(pos, [far, near85], BIG, empty, { id: 'far', cost: farCost });
    assert.equal(stay85?.id, 'far');
    const go75 = chooseExit(pos, [far, near75], BIG, empty, { id: 'far', cost: farCost });
    assert.equal(go75?.id, 'near');
    const stay90 = chooseExit(pos, [far, near90], BIG, empty, { id: 'far', cost: farCost });
    assert.equal(stay90?.id, 'far');
    const force90 = chooseExit(pos, [far, near90], BIG, empty, { id: 'far', cost: farCost }, {
      ignoreHysteresis: true,
    });
    assert.equal(force90?.id, 'near');

    const a = exit({ id: 'a', center: { x: 80, y: 0 }, edgeIndex: 1 });
    const b = exit({ id: 'b', center: { x: 200, y: 0 }, edgeIndex: 1 });
    const excluded = chooseExit(pos, [a, b], BIG, empty, null, { excludeId: 'a' });
    assert.equal(excluded?.id, 'b');

    const box: Vec2[] = [
      { x: -10, y: -10 },
      { x: 200, y: -10 },
      { x: 200, y: 200 },
      { x: -10, y: 200 },
    ];
    const smoky = exit({ id: 'near', center: { x: 200, y: 20 }, edgeIndex: 1 });
    const clear = exit({ id: 'far', center: { x: 200, y: 160 }, edgeIndex: 1 });
    const smokyApproach = exitApproachInside(smoky, box);
    const smoked = field([{ id: 's', simPos: smokyApproach, indoor: true }], {
      s: { smoke: 0.46, fire: 'none' },
    });
    const picked = chooseExit({ x: 0, y: 20 }, [smoky, clear], box, smoked, null);
    assert.equal(picked?.id, 'far');

    const appA = exitApproachInside(smoky, box);
    const appB = exitApproachInside(clear, box);
    const bothBurn = field(
      [
        { id: 'a', simPos: appA, indoor: true },
        { id: 'b', simPos: appB, indoor: true },
      ],
      { a: { smoke: 0, fire: 'burning' }, b: { smoke: 0, fire: 'burning' } },
    );
    const forced = chooseExit({ x: 0, y: 20 }, [smoky, clear], box, bothBurn, null);
    assert.equal(forced?.forced, true);
    assert.equal(forced?.id, 'near');
    const blockedA = { ...smoky, status: 'blocked' as const };
    const blockedB = { ...clear, status: 'blocked' as const };
    assert.equal(chooseExit({ x: 0, y: 20 }, [blockedA, blockedB], box, field([]), null), null);
  });

  test('8 nextIndoorWaypoint', () => {
    const wall = {
      startX: 15,
      startY: 0,
      endX: 15,
      endY: 20,
      hasDoor: true,
      doorWidth: 2,
      doorPosition: 0.5,
    };
    const door = nextIndoorWaypoint({ x: 5, y: 2 }, { x: 25, y: 2 }, [wall]);
    close(door.x, 15, 1e-9);
    close(door.y, 10, 1e-9);
    const direct = nextIndoorWaypoint({ x: 5, y: 2 }, { x: 25, y: 2 }, []);
    assert.deepEqual(direct, { x: 25, y: 2 });
  });

  test('9 injury bands', () => {
    const R = 20;
    assert.equal(blastInjuryBand(R * 0.293, R), 'lethal');
    assert.equal(blastInjuryBand(R * 0.294, R), 'serious');
    assert.equal(blastInjuryBand(R * 0.444, R), 'serious');
    assert.equal(blastInjuryBand(R * 0.445, R), 'minor');
    assert.equal(blastInjuryBand(R, R), 'minor');
    assert.equal(blastInjuryBand(R * 1.01, R), 'none');
  });

  test('10 blast timing', () => {
    assert.equal(blastEffectsTriggerSec(0.5), 30);
    const input = [{ triggerTimeSec: 4, eventType: 'explode' }];
    const shifted = shiftEvents(input, 30);
    assert.notEqual(shifted[0], input[0]);
    assert.equal(input[0].triggerTimeSec, 4);
    assert.equal(shifted[0].triggerTimeSec, 34);
    assert.equal(isBlastDue(59.99, false), false);
    assert.equal(isBlastDue(60, false), true);
    assert.equal(isBlastDue(61, true), false);
    assert.equal(countdownLabel(60), '');
    assert.equal(countdownLabel(59), 'Blast in 0:01');
  });

  test('11 explosion frame', () => {
    assert.equal(explosionFxFrame(0, 20, false).flashAlpha, 0.8);
    assert.equal(explosionFxFrame(1.2, 20, false).ringRadiusM, 32);
    const reduced = explosionFxFrame(0, 20, true);
    assert.equal(reduced.flashAlpha, 0);
    assert.equal(reduced.shakePx, 0);
  });

  test('12 ambient fire spread stays indoors', () => {
    const studs = [
      { id: 'a', simPos: { x: 0, y: 0 }, spatialContext: 'inside_building' },
      { id: 'b', simPos: { x: 3, y: 0 }, spatialContext: 'inside_building' },
      { id: 'c', simPos: { x: 0, y: 3 }, spatialContext: 'open_air' },
    ];
    const plain = new FireSimulation();
    plain.init(studs);
    plain.ignite(['a']);
    for (let i = 0; i < 60; i++) plain.step(1, [], []);
    assert.equal(plain.states.get('b')?.state, 'none');
    assert.equal(plain.states.get('c')?.state, 'none');

    const spread = new FireSimulation({
      baseSpreadRate: 30,
      burnDuration: 300,
      heatTransferRate: 15,
      wallResistance: { '': 900 },
      hazardAcceleration: {},
      ambientSpread: true,
      ambientHeatSec: 30,
    });
    spread.init(studs);
    spread.ignite(['a']);
    spread.step(1, [], []);
    assert.equal(spread.states.get('b')?.state, 'heating');
    assert.equal(spread.states.get('c')?.state, 'none');
    for (let i = 0; i < 30; i++) spread.step(1, [], []);
    assert.equal(spread.states.get('b')?.state, 'burning');
    assert.equal(spread.states.get('c')?.state, 'none');
  });

  test('blocked exit is abandoned on the same re-check', () => {
    const pos = { x: 0, y: 0 };
    const blocked = exit({ id: 'a', center: { x: 40, y: 0 }, edgeIndex: 1, status: 'blocked' });
    const other = exit({ id: 'b', center: { x: 200, y: 0 }, edgeIndex: 1 });
    const picked = chooseExit(pos, [blocked, other], BIG, field([]), { id: 'a', cost: 10 });
    assert.equal(picked?.id, 'b');
  });

  test('outdoor route does not cross the outline', () => {
    const verts: Vec2[] = [
      { x: 0, y: 0 },
      { x: 60, y: 0 },
      { x: 60, y: 40 },
      { x: 0, y: 40 },
    ];
    assert.deepEqual(routeAroundOutline({ x: 30, y: 50 }, { x: 10, y: 55 }, verts), [{ x: 10, y: 55 }]);
    const around = routeAroundOutline({ x: 30, y: 42 }, { x: 30, y: -8 }, verts);
    assert.ok(around.length > 1);
    const door = routeAroundOutline({ x: 30, y: 40.2 }, { x: 95, y: 20 }, verts);
    assert.ok(Math.abs(door[0].x - 30) < 0.2, `depart x ${door[0].x}`);
    assert.ok(door[0].y > 42 && door[0].y < 43.2, `depart y ${door[0].y}`);
    assert.ok(door.every((p) => p.x > -1), 'east zone must not detour via the west corner');
    const graze = routeAroundOutline({ x: 30, y: 40.3 }, { x: 90, y: 40.3 }, verts);
    assert.ok(graze[0].y > 42, 'a path along the wall leaves straight out first');
    const legs = [graze[0], ...graze.slice(1)];
    for (let i = 0; i < legs.length - 1; i++) {
      for (let s = 0; s <= 8; s++) {
        const t = s / 8;
        const p = {
          x: legs[i].x + (legs[i + 1].x - legs[i].x) * t,
          y: legs[i].y + (legs[i + 1].y - legs[i].y) * t,
        };
        assert.ok(distanceToOutline(p.x, p.y, verts) >= 0.65);
      }
    }
    const aroundLegs = [{ x: 30, y: 42 }, ...around];
    for (let i = 0; i < aroundLegs.length - 1; i++) {
      for (let s = 1; s < 24; s++) {
        const t = s / 24;
        const p = {
          x: aroundLegs[i].x + (aroundLegs[i + 1].x - aroundLegs[i].x) * t,
          y: aroundLegs[i].y + (aroundLegs[i + 1].y - aroundLegs[i].y) * t,
        };
        assert.equal(isInsidePolygon(p.x, p.y, verts), false);
      }
    }
  });

  test('blast ignition uses the blast zone, not the origin', () => {
    const engine = new SpatialEffectsEngine(undefined, 1);
    engine.init([
      { id: 'origin', simPos: { x: 0, y: 0 }, spatialContext: 'inside_building' },
      { id: 'site', simPos: { x: 50, y: 30 }, spatialContext: 'inside_building' },
    ]);
    engine.registerHazard(
      'blast-direct',
      [
        {
          triggerTimeSec: 0,
          eventType: 'explode',
          spreadType: 'fire',
          spreadRadius: 5,
          spreadRate: 10,
          description: 'Direct blast ignition',
          severity: 'critical',
        },
      ],
      { initial: '', triggered: '', worsening: '', critical: '' },
    );
    engine.step(0.01, [], [
      {
        id: 'blast-direct',
        pos: { x: 50, y: 30 },
        radius: 5,
        hazardType: 'ignitable',
        severity: 'critical',
        label: 'Blast',
        description: '',
        photos: [],
      },
    ]);
    assert.equal(engine.studStates.get('site')?.fire.state, 'burning');
    assert.equal(engine.studStates.get('origin')?.fire.state, 'none');
  });
});

function showcaseEngine(
  count: number,
  zones: ShowcaseZone[] = [],
  walls: Array<{
    startX: number;
    startY: number;
    endX: number;
    endY: number;
    hasDoor: boolean;
    doorWidth: number;
    doorPosition: number;
  }> = [],
) {
  const verts: Vec2[] = [
    { x: 0, y: 0 },
    { x: 40, y: 0 },
    { x: 40, y: 20 },
    { x: 0, y: 20 },
  ];
  const config: PolygonSimConfig = {
    vertices: verts,
    pedestrianCount: count,
    pedestrianRadius: 0.25,
    desiredSpeed: 1.4,
    panicFactor: 0,
    dt: 1 / 60,
  };
  const exits: ExitDef[] = [
    exit({ id: 'west', center: { x: 0, y: 10 }, edgeIndex: 3, width: 4 }),
    exit({ id: 'east', center: { x: 40, y: 10 }, edgeIndex: 1, width: 4 }),
  ];
  return new PolygonEvacuationEngine(config, exits, walls, [], {
    afterExit: 'zone',
    zones,
    seed: 1,
  });
}

test('lookahead switch survives the next re-check', () => {
  const eng = showcaseEngine(1, [], [
    {
      startX: 4,
      startY: 0,
      endX: 4,
      endY: 20,
      hasDoor: true,
      doorWidth: 2,
      doorPosition: 0.9,
    },
  ]);
  const hazard = field([{ id: 'door', simPos: { x: 4, y: 18 }, indoor: true }], {
    door: { smoke: 0, fire: 'burning' },
  });
  eng.setHazardField(hazard);
  const body = (eng as unknown as { pedestrians: Matter.Body[] }).pedestrians[0];
  assert.ok(body);
  Matter.Body.setPosition(body, { x: 10, y: 10 });
  Matter.Body.setVelocity(body, { x: 0, y: 0 });
  const ped = (body as Matter.Body & {
    __ped: { state: string; targetExitId: string; exitCost: number; nextCheckAt: number; posture: string };
  }).__ped;
  ped.state = 'evacuating';
  ped.targetExitId = 'west';
  ped.exitCost = 12;
  ped.nextCheckAt = 0;
  ped.posture = 'stand';
  eng.step();
  assert.equal(ped.targetExitId, 'east');
  for (let i = 0; i < 120; i++) eng.step();
  assert.equal(ped.targetExitId, 'east');
  eng.destroy();
});

test('fire beyond the door sticks for 2s and off-route velocity does not flip', () => {
  const walls = [
    {
      startX: 6,
      startY: 0,
      endX: 6,
      endY: 20,
      hasDoor: true,
      doorWidth: 2,
      doorPosition: 0.5,
    },
  ];
  const burning = showcaseEngine(1, [], walls);
  burning.setHazardField(
    field([{ id: 'past', simPos: { x: 3, y: 10 }, indoor: true }], {
      past: { smoke: 0, fire: 'burning' },
    }),
  );
  const body = (burning as unknown as { pedestrians: Matter.Body[] }).pedestrians[0];
  Matter.Body.setPosition(body, { x: 14, y: 10 });
  Matter.Body.setVelocity(body, { x: -1, y: 1 });
  const ped = (body as Matter.Body & {
    __ped: { state: string; targetExitId: string; exitCost: number; nextCheckAt: number; posture: string };
  }).__ped;
  ped.state = 'evacuating';
  ped.targetExitId = 'west';
  ped.exitCost = 20;
  ped.nextCheckAt = 0;
  ped.posture = 'stand';
  burning.step();
  assert.equal(ped.targetExitId, 'east');
  for (let i = 0; i < 120; i++) burning.step();
  assert.equal(ped.targetExitId, 'east');
  burning.destroy();

  const off = showcaseEngine(1, [], walls);
  off.setHazardField(
    field([{ id: 'side', simPos: { x: 6, y: 18 }, indoor: true }], {
      side: { smoke: 0, fire: 'burning' },
    }),
  );
  const offBody = (off as unknown as { pedestrians: Matter.Body[] }).pedestrians[0];
  Matter.Body.setPosition(offBody, { x: 14, y: 10 });
  Matter.Body.setVelocity(offBody, { x: -0.8, y: 0.8 });
  const offPed = (offBody as Matter.Body & {
    __ped: { state: string; targetExitId: string; exitCost: number; nextCheckAt: number; posture: string };
  }).__ped;
  offPed.state = 'evacuating';
  offPed.targetExitId = 'west';
  offPed.exitCost = 14;
  offPed.nextCheckAt = 1e9;
  offPed.posture = 'stand';
  for (let i = 0; i < 20; i++) off.step();
  assert.equal(offPed.targetExitId, 'west');
  off.destroy();
});

test('people beside a door line up with the opening instead of the wall', () => {
  const verts: Vec2[] = [
    { x: 0, y: 0 },
    { x: 40, y: 0 },
    { x: 40, y: 20 },
    { x: 0, y: 20 },
  ];
  const eng = new PolygonEvacuationEngine(
    {
      vertices: verts,
      pedestrianCount: 1,
      pedestrianRadius: 0.25,
      desiredSpeed: 1.4,
      panicFactor: 0,
      dt: 1 / 60,
    },
    [exit({ id: 'east', center: { x: 40, y: 10 }, edgeIndex: 1, width: 2 })],
    [],
    [],
    { afterExit: 'disperse', zones: [], seed: 1 },
  );
  const body = (eng as unknown as { pedestrians: Matter.Body[] }).pedestrians[0];
  Matter.Body.setPosition(body, { x: 37, y: 16 });
  Matter.Body.setVelocity(body, { x: 0, y: 0 });
  const ped = (body as Matter.Body & {
    __ped: { state: string; targetExitId: string; exitCost: number; nextCheckAt: number; posture: string };
  }).__ped;
  ped.state = 'evacuating';
  ped.targetExitId = 'east';
  ped.exitCost = 8;
  ped.nextCheckAt = 1e9;
  ped.posture = 'stand';
  for (let i = 0; i < 180; i++) eng.step();
  assert.ok(body.position.y < 15.5, `headed for the opening, y=${body.position.y.toFixed(2)}`);
  assert.ok(body.position.x < 38.5, `stayed off the wall, x=${body.position.x.toFixed(2)}`);
  eng.destroy();
});

test('people who turned back do not return to that exit', () => {
  const walls = [
    {
      startX: 6,
      startY: 0,
      endX: 6,
      endY: 20,
      hasDoor: true,
      doorWidth: 2,
      doorPosition: 0.5,
    },
  ];
  const verts: Vec2[] = [
    { x: 0, y: 0 },
    { x: 40, y: 0 },
    { x: 40, y: 20 },
    { x: 0, y: 20 },
  ];
  const exits: ExitDef[] = [
    exit({ id: 'west', center: { x: 0, y: 10 }, edgeIndex: 3, width: 4 }),
    exit({ id: 'east', center: { x: 40, y: 10 }, edgeIndex: 1, width: 4 }),
  ];
  const smoke = field([{ id: 's', simPos: { x: 3, y: 10 }, indoor: true }], {
    s: { smoke: 1, fire: 'none' },
  });
  let found = false;
  for (let seed = 1; seed <= 40 && !found; seed++) {
    const eng = new PolygonEvacuationEngine(
      {
        vertices: verts,
        pedestrianCount: 1,
        pedestrianRadius: 0.25,
        desiredSpeed: 1.4,
        panicFactor: 0,
        dt: 1 / 60,
      },
      exits,
      walls,
      [],
      { afterExit: 'zone', zones: [], seed },
    );
    eng.setHazardField(smoke);
    const body = (eng as unknown as { pedestrians: Matter.Body[] }).pedestrians[0];
    Matter.Body.setPosition(body, { x: 14, y: 10 });
    const ped = (body as Matter.Body & {
      __ped: { state: string; targetExitId: string; exitCost: number; nextCheckAt: number; posture: string };
    }).__ped;
    ped.state = 'evacuating';
    ped.targetExitId = 'west';
    ped.exitCost = 30;
    ped.nextCheckAt = 1e9;
    ped.posture = 'stand';
    const before = eng.getMetrics().showcase?.turnedBack ?? 0;
    eng.step();
    const turned = (eng.getMetrics().showcase?.turnedBack ?? 0) > before;
    if (turned && ped.targetExitId === 'east') {
      smoke.setStates(new Map([['s', { smoke: 0, fire: { state: 'none' } }]]));
      ped.nextCheckAt = 0;
      for (let i = 0; i < 300; i++) eng.step();
      assert.equal(ped.targetExitId, 'east');
      found = true;
    }
    eng.destroy();
  }
  assert.equal(found, true);
});

test('posture resets outside and crawling counts only evacuating people', () => {
  const eng = showcaseEngine(2);
  const bodies = (eng as unknown as { pedestrians: Matter.Body[] }).pedestrians;
  assert.equal(bodies.length, 2);
  const outside = (bodies[0] as Matter.Body & { __ped: { state: string; posture: string } }).__ped;
  outside.state = 'evacuating';
  outside.posture = 'crawl';
  Matter.Body.setPosition(bodies[0], { x: -0.4, y: 10 });
  const inside = (bodies[1] as Matter.Body & {
    __ped: { state: string; posture: string; forcedCrawl: boolean };
  }).__ped;
  inside.state = 'evacuating';
  inside.posture = 'crawl';
  inside.forcedCrawl = true;
  Matter.Body.setPosition(bodies[1], { x: 20, y: 10 });
  eng.step();
  const snaps = eng.getSnapshots();
  const left = snaps.find((s) => s.state === 'outside');
  assert.equal(left?.posture, 'stand');
  assert.equal(eng.getMetrics().showcase?.crawling, 1);
});

test('all-unsafe zones record a note and use the farthest', () => {
  const zones: ShowcaseZone[] = [
    { id: 'near', pos: { x: 12, y: 10 }, radius: 3, label: 'Near', kind: 'assembly' },
    { id: 'far', pos: { x: 70, y: 10 }, radius: 3, label: 'Far', kind: 'assembly' },
  ];
  const eng = showcaseEngine(1, zones);
  (eng as unknown as { blast: { site: Vec2; radius: number } }).blast = {
    site: { x: 20, y: 10 },
    radius: 30,
  };
  const body = (eng as unknown as { pedestrians: Matter.Body[] }).pedestrians[0];
  const ped = (body as Matter.Body & { __ped: { state: string; zoneId: string | null } }).__ped;
  ped.state = 'evacuating';
  Matter.Body.setPosition(body, { x: -0.4, y: 10 });
  eng.step();
  assert.equal(ped.zoneId, 'far');
  assert.match(
    eng.getMetrics().showcase?.unsafeZoneNote ?? '',
    /farthest from the blast/,
  );
});
