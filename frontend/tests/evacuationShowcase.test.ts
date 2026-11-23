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
  openingFlowPerS,
  separateFromWalls,
  doorBlockedByBodies,
  doorSqueezeAim,
  steerPastBodies,
  steerToTarget,
  WALL_FACE_CLEAR_M,
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
import { DEFAULT_FIRE_PARAMS, FireSimulation } from '../src/lib/rts/fireSimulation';
import type { HazardZone, InteriorWall } from '../src/lib/rts/types';
import { RTSEngine } from '../src/lib/rts/engine';
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
    const forcedDespiteAvoid = chooseExit({ x: 0, y: 20 }, [smoky, clear], box, bothBurn, null, {
      avoidIds: ['near'],
      excludeId: 'near',
    });
    assert.equal(forcedDespiteAvoid?.forced, true);
    assert.equal(forcedDespiteAvoid?.id, 'near');
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
    const lo = nextIndoorWaypoint({ x: 5, y: 2 }, { x: 25, y: 2 }, [wall], 0);
    const hi = nextIndoorWaypoint({ x: 5, y: 2 }, { x: 25, y: 2 }, [wall], 1);
    close(lo.x, 15, 1e-9);
    close(hi.x, 15, 1e-9);
    close(lo.y, 9.25, 1e-6);
    close(hi.y, 10.75, 1e-6);
    assert.ok(hi.y - lo.y > 1);
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

test('a turn-back expires so the nearer clear exit can be used again', () => {
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
    { x: 200, y: 0 },
    { x: 200, y: 20 },
    { x: 0, y: 20 },
  ];
  const exits: ExitDef[] = [
    exit({ id: 'west', center: { x: 0, y: 10 }, edgeIndex: 3, width: 4 }),
    exit({ id: 'east', center: { x: 200, y: 10 }, edgeIndex: 1, width: 4 }),
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
      { afterExit: 'disperse', zones: [], seed },
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
      for (let i = 0; i < 5 * 60; i++) eng.step();
      assert.equal(ped.targetExitId, 'east');
      for (let i = 0; i < 26 * 60; i++) eng.step();
      assert.equal(ped.targetExitId, 'west');
      found = true;
    }
    eng.destroy();
  }
  assert.equal(found, true);
});

test('a point on a wall face is moved out to the body clearance', () => {
  const walls = [
    { startX: 40, startY: 6, endX: 40, endY: 40, hasDoor: true, doorWidth: 1.6, doorPosition: 0.4 },
  ];
  const moved = separateFromWalls({ x: 40.4, y: 14.3 }, walls, WALL_FACE_CLEAR_M);
  assert.ok(Math.abs(moved.x - 40) >= WALL_FACE_CLEAR_M - 1e-6, `still on the face at x ${moved.x}`);
  const doorY = 6 + 0.4 * 34;
  const inGap = separateFromWalls({ x: 40, y: doorY }, walls, WALL_FACE_CLEAR_M);
  assert.ok(Math.abs(inGap.x - 40) < 0.05, `door opening was pushed to x ${inGap.x}`);
  const nearJamb = separateFromWalls({ x: 39.5, y: doorY - 0.34 }, walls, WALL_FACE_CLEAR_M);
  assert.ok(Math.abs(nearJamb.x - 39.5) < 0.05, `doorway beside the jamb was pushed to x ${nearJamb.x}`);
});

test('a door crowd takes a slot each, and the flow cap is the seeded specific flow', () => {
  const wall = {
    startX: 40, startY: 6, endX: 40, endY: 40, hasDoor: true, doorWidth: 1.6, doorPosition: 0.4,
  };
  const centre = steerToTarget({ x: 40.8, y: 19.6 }, { x: 30, y: 40 }, [wall]);
  const offset = steerToTarget({ x: 40.8, y: 20.05 }, { x: 30, y: 40 }, [wall]);
  const held = steerToTarget({ x: 40.8, y: 19.6 }, { x: 30, y: 40 }, [wall], true);
  const heldOffset = steerToTarget({ x: 40.8, y: 20.05 }, { x: 30, y: 40 }, [wall], true);
  assert.ok(centre.x < 40, `centre should cross, x ${centre.x}`);
  assert.ok(offset.x < 40, `offset slot should cross, x ${offset.x}`);
  assert.ok(Math.abs(offset.y - centre.y) > 0.15, `slots collapsed to y ${centre.y} and ${offset.y}`);
  assert.ok(held.x > 40.2 && held.x < 42, `held person left the queue, x ${held.x}`);
  assert.ok(Math.abs(held.y - heldOffset.y) > 0.15, `held slots collapsed`);
  const onLine = steerToTarget({ x: 40, y: 19.6 }, { x: 30, y: 40 }, [wall]);
  const justPast = steerToTarget({ x: 39.7, y: 19.6 }, { x: 30, y: 40 }, [wall]);
  assert.ok(onLine.x < 40, `on the door line the aim reversed, x ${onLine.x}`);
  assert.ok(justPast.x < 39.7, `just past the door the aim reversed, x ${justPast.x}`);
  close(openingFlowPerS(1.6), 1.3 * (1.6 - 0.3));
  close(openingFlowPerS(2), 1.3 * (2 - 0.3));
  assert.equal(openingFlowPerS(0.2), 0);
});

test('a downed body moves the steering aim off to one side', () => {
  const clear = steerPastBodies({ x: 0, y: 0 }, { x: 10, y: 0 }, []);
  assert.deepEqual(clear, { x: 10, y: 0 });
  const wide = steerPastBodies({ x: 0, y: 0 }, { x: 10, y: 0 }, [{ x: 3, y: 3 }]);
  assert.deepEqual(wide, { x: 10, y: 0 });
  const behind = steerPastBodies({ x: 5, y: 0 }, { x: 10, y: 0 }, [{ x: 1, y: 0 }]);
  assert.deepEqual(behind, { x: 10, y: 0 });
  const ahead = steerPastBodies({ x: 0, y: 0 }, { x: 10, y: 0 }, [{ x: 3, y: 0 }]);
  assert.ok(Math.abs(ahead.y) > 0.5, `still aimed through the body at y ${ahead.y}`);
  assert.ok(ahead.x > 1, `aim did not move toward the exit, x ${ahead.x}`);
});

test('a blocked exit is left on the next step', () => {
  const eng = showcaseEngine(1);
  const body = (eng as unknown as { pedestrians: Matter.Body[] }).pedestrians[0];
  Matter.Body.setPosition(body, { x: 20, y: 10 });
  const ped = (body as Matter.Body & {
    __ped: { state: string; targetExitId: string; exitCost: number; nextCheckAt: number; posture: string };
  }).__ped;
  ped.state = 'evacuating';
  ped.targetExitId = 'east';
  ped.exitCost = 10;
  ped.nextCheckAt = 1e9;
  ped.posture = 'stand';
  eng.syncExits([
    exit({ id: 'west', center: { x: 0, y: 10 }, edgeIndex: 3, width: 4 }),
    exit({ id: 'east', center: { x: 40, y: 10 }, edgeIndex: 1, width: 4, status: 'blocked' }),
  ]);
  eng.step();
  assert.equal(ped.targetExitId, 'west');
  eng.destroy();
});

test('a centred body leaves a lane in a 1.6 m door and closes a 1.0 m door', () => {
  const wall = {
    startX: 22, startY: 0, endX: 22, endY: 34, hasDoor: true, doorWidth: 1.6, doorPosition: 0.5,
  };
  const body = [{ x: 22, y: 17 }];
  assert.equal(doorBlockedByBodies(wall, body), false);
  assert.equal(doorBlockedByBodies({ ...wall, doorWidth: 1 }, body), true);
  assert.equal(doorBlockedByBodies(wall, []), false);
  const squeeze = doorSqueezeAim({ x: 26, y: 17 }, { x: 0, y: 17 }, [wall], body);
  assert.ok(squeeze, 'the 1.6 m door should still be a way through');
  assert.ok(squeeze.aim.x < 22, `aim did not pass through the door, x ${squeeze.aim.x}`);
  const t = (26 - 22) / (26 - squeeze.aim.x);
  const y = 17 + (squeeze.aim.y - 17) * t;
  assert.ok(Math.abs(y - 17) >= 0.5, `lane crosses the body at ${y}`);
  assert.ok(Math.abs(y - 17) <= 0.55, `lane misses the opening at ${y}`);
});

test('a free lane under 0.15 m between two bodies closes the door', () => {
  const wall = {
    startX: 20, startY: 0, endX: 20, endY: 20, hasDoor: true, doorWidth: 1.6, doorPosition: 0.5,
  };
  // Surface gap 0.6 m: centres 1.1 m apart, so the walker-centre lane is 0.10 m
  // and it sits between the bodies, not against the jamb.
  const jammed = [{ x: 20, y: 9.45 }, { x: 20, y: 10.55 }];
  assert.equal(doorBlockedByBodies(wall, jammed), true);
  // 0.20 m interior lane, and a lane of exactly 0.15 m, both stay open.
  assert.equal(doorBlockedByBodies(wall, [{ x: 20, y: 9.15 }, { x: 20, y: 10.35 }]), false);
  assert.equal(doorBlockedByBodies(wall, [{ x: 20, y: 9.15 }, { x: 20, y: 10.3 }]), false);
  // The jamb sliver beside one centred body is still a way through.
  assert.equal(doorBlockedByBodies(wall, [{ x: 20, y: 10 }]), false);
});

test('a walker steers past a static body instead of stopping on it', () => {
  const eng = showcaseEngine(2);
  const bodies = (eng as unknown as { pedestrians: Matter.Body[] }).pedestrians;
  const blocker = bodies[0];
  const walker = bodies[1];
  Matter.Body.setPosition(blocker, { x: 10, y: 10 });
  Matter.Body.setStatic(blocker, true);
  (blocker as Matter.Body & { __ped: { state: string } }).__ped.state = 'down';
  Matter.Body.setPosition(walker, { x: 4, y: 10 });
  const ped = (walker as Matter.Body & {
    __ped: { state: string; targetExitId: string; exitCost: number; nextCheckAt: number; posture: string };
  }).__ped;
  ped.state = 'evacuating';
  ped.targetExitId = 'east';
  ped.exitCost = 10;
  ped.nextCheckAt = 1e9;
  ped.posture = 'stand';
  for (let i = 0; i < 45 * 60; i++) eng.step();
  assert.ok(walker.position.x > 12, `still short of the body at x ${walker.position.x.toFixed(2)}`);
  eng.destroy();
});

test('a body in a 1.6 m door is not a wall: the ten walkers are through within 90s', () => {
  const verts: Vec2[] = [
    { x: 0, y: 0 },
    { x: 60, y: 0 },
    { x: 60, y: 40 },
    { x: 0, y: 40 },
  ];
  const walls = [
    { startX: 22, startY: 0, endX: 22, endY: 34, hasDoor: true, doorWidth: 1.6, doorPosition: 0.5 },
  ];
  const eng = new PolygonEvacuationEngine(
    {
      vertices: verts,
      pedestrianCount: 11,
      pedestrianRadius: 0.25,
      desiredSpeed: 1.4,
      panicFactor: 0,
      dt: 1 / 60,
    },
    [exit({ id: 'W', center: { x: 0, y: 20 }, edgeIndex: 3, width: 2 })],
    walls,
    [],
    { afterExit: 'disperse', zones: [], seed: 1 },
  );
  const bodies = (eng as unknown as { pedestrians: Matter.Body[] }).pedestrians;
  const blocker = bodies[0];
  Matter.Body.setPosition(blocker, { x: 22, y: 17 });
  Matter.Body.setStatic(blocker, true);
  (blocker as Matter.Body & { __ped: { state: string } }).__ped.state = 'down';
  const walkers = bodies.slice(1);
  walkers.forEach((body, i) => {
    Matter.Body.setPosition(body, { x: 26 + (i % 5), y: 15 + Math.floor(i / 5) * 3 });
    Object.assign((body as Matter.Body & { __ped: Record<string, unknown> }).__ped, {
      state: 'evacuating',
      targetExitId: 'W',
      exitCost: 30,
      nextCheckAt: 0,
      posture: 'stand',
    });
  });
  let minD = Infinity;
  for (let i = 0; i < 90 * 60; i++) {
    eng.step();
    for (const body of walkers) {
      minD = Math.min(minD, Math.hypot(body.position.x - 22, body.position.y - 17));
    }
  }
  const stuck = walkers.filter((body) => {
    const ped = (body as Matter.Body & { __ped: { state: string } }).__ped;
    return body.position.x >= 21 && ped.state === 'evacuating';
  });
  assert.equal(stuck.length, 0, `${stuck.length} still east of the door, closest approach ${minD.toFixed(3)} m`);
  assert.ok(minD >= 0.45, `walked through the body, closest approach ${minD.toFixed(3)} m`);
  eng.destroy();
});

test('a 0.6 m gap between two bodies sends people to the other exit', () => {
  const verts: Vec2[] = [
    { x: 0, y: 0 },
    { x: 40, y: 0 },
    { x: 40, y: 20 },
    { x: 0, y: 20 },
  ];
  const walls = [
    { startX: 20, startY: 0, endX: 20, endY: 20, hasDoor: true, doorWidth: 1.6, doorPosition: 0.5 },
  ];
  const eng = new PolygonEvacuationEngine(
    {
      vertices: verts,
      pedestrianCount: 10,
      pedestrianRadius: 0.25,
      desiredSpeed: 1.4,
      panicFactor: 0,
      dt: 1 / 60,
    },
    [
      exit({ id: 'west', center: { x: 0, y: 10 }, edgeIndex: 3, width: 4 }),
      exit({ id: 'east', center: { x: 40, y: 10 }, edgeIndex: 1, width: 4 }),
    ],
    walls,
    [],
    { afterExit: 'disperse', zones: [], seed: 1 },
  );
  const bodies = (eng as unknown as { pedestrians: Matter.Body[] }).pedestrians;
  // Centres 1.1 m apart: 0.6 m between the surfaces, 0.10 m of walker centre.
  bodies.slice(0, 2).forEach((body, i) => {
    Matter.Body.setPosition(body, { x: 20, y: i === 0 ? 9.45 : 10.55 });
    Matter.Body.setStatic(body, true);
    (body as Matter.Body & { __ped: { state: string } }).__ped.state = 'down';
  });
  const walkers = bodies.slice(2);
  walkers.forEach((body, i) => {
    Matter.Body.setPosition(body, { x: 26, y: 6 + i });
    Object.assign((body as Matter.Body & { __ped: Record<string, unknown> }).__ped, {
      state: 'evacuating',
      targetExitId: 'west',
      exitCost: 30,
      nextCheckAt: 1e9,
      posture: 'stand',
    });
  });
  eng.step();
  for (const body of walkers) {
    const ped = (body as Matter.Body & { __ped: { targetExitId: string } }).__ped;
    assert.equal(ped.targetExitId, 'east');
  }
  for (let i = 0; i < 90 * 60; i++) eng.step();
  const stuck = walkers.filter((body) => {
    const ped = (body as Matter.Body & { __ped: { state: string } }).__ped;
    return ped.state === 'evacuating' && body.position.x < 30;
  });
  assert.equal(stuck.length, 0, `${stuck.length} still short of the east exit`);
  eng.destroy();
});

test('a body that fills a door sends people to the other exit', () => {
  const verts: Vec2[] = [
    { x: 0, y: 0 },
    { x: 40, y: 0 },
    { x: 40, y: 20 },
    { x: 0, y: 20 },
  ];
  const walls = [
    { startX: 20, startY: 0, endX: 20, endY: 20, hasDoor: true, doorWidth: 1, doorPosition: 0.5 },
  ];
  const eng = new PolygonEvacuationEngine(
    {
      vertices: verts,
      pedestrianCount: 4,
      pedestrianRadius: 0.25,
      desiredSpeed: 1.4,
      panicFactor: 0,
      dt: 1 / 60,
    },
    [
      exit({ id: 'west', center: { x: 0, y: 10 }, edgeIndex: 3, width: 4 }),
      exit({ id: 'east', center: { x: 40, y: 10 }, edgeIndex: 1, width: 4 }),
    ],
    walls,
    [],
    { afterExit: 'disperse', zones: [], seed: 1 },
  );
  const bodies = (eng as unknown as { pedestrians: Matter.Body[] }).pedestrians;
  const blocker = bodies[0];
  Matter.Body.setPosition(blocker, { x: 20, y: 10 });
  Matter.Body.setStatic(blocker, true);
  (blocker as Matter.Body & { __ped: { state: string } }).__ped.state = 'down';
  const walkers = bodies.slice(1);
  walkers.forEach((body, i) => {
    Matter.Body.setPosition(body, { x: 26, y: 8 + i * 2 });
    Object.assign((body as Matter.Body & { __ped: Record<string, unknown> }).__ped, {
      state: 'evacuating',
      targetExitId: 'west',
      exitCost: 30,
      nextCheckAt: 1e9,
      posture: 'stand',
    });
  });
  eng.step();
  for (const body of walkers) {
    const ped = (body as Matter.Body & { __ped: { targetExitId: string } }).__ped;
    assert.equal(ped.targetExitId, 'east');
  }
  for (let i = 0; i < 90 * 60; i++) eng.step();
  const stuck = walkers.filter((body) => {
    const ped = (body as Matter.Body & { __ped: { state: string } }).__ped;
    return ped.state === 'evacuating' && body.position.x < 30;
  });
  assert.equal(stuck.length, 0, `${stuck.length} still short of the east exit`);
  eng.destroy();
});

test('a downed body on another storey does not close this storey\'s door', () => {
  const verts: Vec2[] = [
    { x: 0, y: 0 },
    { x: 40, y: 0 },
    { x: 40, y: 20 },
    { x: 0, y: 20 },
  ];
  const door = {
    startX: 20, startY: 0, endX: 20, endY: 20, hasDoor: true, doorWidth: 1, doorPosition: 0.5,
  };
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
    { afterExit: 'disperse', zones: [], seed: 1 },
    {
      ids: ['G', 'L1'],
      exitsByLevel: {
        G: [
          exit({ id: 'west', center: { x: 0, y: 10 }, edgeIndex: 3, width: 4 }),
          exit({ id: 'east', center: { x: 40, y: 10 }, edgeIndex: 1, width: 4 }),
        ],
        L1: [],
      },
      wallsByLevel: { G: [door], L1: [] },
      stairs: [],
      counts: { G: 1, L1: 1 },
    },
  );
  const bodies = (eng as unknown as { pedestrians: Matter.Body[] }).pedestrians;
  const byLevel = (level: string) =>
    bodies.find((body) => (body as Matter.Body & { __ped: { level?: string } }).__ped.level === level);
  const walker = byLevel('G');
  const blocker = byLevel('L1');
  assert.ok(walker && blocker);
  Matter.Body.setPosition(blocker, { x: 20, y: 10 });
  Matter.Body.setStatic(blocker, true);
  (blocker as Matter.Body & { __ped: { state: string } }).__ped.state = 'down';
  Matter.Body.setPosition(walker, { x: 26, y: 10 });
  Object.assign((walker as Matter.Body & { __ped: Record<string, unknown> }).__ped, {
    state: 'evacuating',
    targetExitId: 'west',
    exitCost: 20,
    nextCheckAt: 1e9,
    posture: 'stand',
  });
  eng.step();
  assert.equal((walker as Matter.Body & { __ped: { targetExitId: string } }).__ped.targetExitId, 'west');
  for (let i = 0; i < 40 * 60; i++) eng.step();
  assert.equal((walker as Matter.Body & { __ped: { targetExitId: string } }).__ped.targetExitId, 'west');
  assert.ok(walker.position.x < 16, `other-storey body held them at x ${walker.position.x.toFixed(2)}`);
  eng.destroy();
});

function leaveShare(blast: Vec2, blastR: number): { eligible: number; within: number; down: number; fired: boolean } {
  const verts: Vec2[] = [
    { x: 0, y: 0 },
    { x: 60, y: 0 },
    { x: 60, y: 40 },
    { x: 0, y: 40 },
  ];
  const exits: ExitDef[] = [
    exit({ id: 'E1-west', center: { x: 0, y: 20 }, edgeIndex: 3, width: 2 }),
    exit({ id: 'E2-east', center: { x: 60, y: 12 }, edgeIndex: 1, width: 2 }),
    exit({ id: 'E3-north', center: { x: 30, y: 40 }, edgeIndex: 2, width: 2, status: 'congested' }),
  ];
  const walls = [
    { startX: 22, startY: 0, endX: 22, endY: 34, hasDoor: true, doorWidth: 1.6, doorPosition: 0.5 },
    { startX: 40, startY: 6, endX: 40, endY: 40, hasDoor: true, doorWidth: 1.6, doorPosition: 0.4 },
    { startX: 46, startY: 0, endX: 46, endY: 8, hasDoor: false, doorWidth: 1.6, doorPosition: 0.5 },
    { startX: 46, startY: 8, endX: 60, endY: 8, hasDoor: false, doorWidth: 1.6, doorPosition: 0.5 },
  ];
  const eng = new PolygonEvacuationEngine(
    {
      vertices: verts,
      pedestrianCount: 120,
      pedestrianRadius: 0.25,
      desiredSpeed: 1.4,
      panicFactor: 0,
      dt: 1 / 60,
    },
    exits,
    walls,
    [],
    { afterExit: 'disperse', zones: [], seed: SHOWCASE.RNG_SEED },
  );
  const rts = new RTSEngine();
  rts.setBuildingVertices(verts);
  rts.startDetonation();
  const bodies = (eng as unknown as { pedestrians: Matter.Body[] }).pedestrians;
  const sealed = (spawn: { x: number; y: number }) => spawn.x >= 46 && spawn.y <= 8;
  const startEv = new Map<number, number>();
  const outAt = new Map<number, number>();
  let fired = false;
  const dt = 1 / 60;
  const horizon = SHOWCASE.BLAST_AT_GAME_S + SHOWCASE.PREMOVE_MAX_S + 120;
  while (rts.state.clock.elapsed < horizon) {
    rts.tick(dt);
    if (!fired && isBlastDue(rts.state.clock.elapsed, fired)) {
      fired = true;
      eng.triggerBlast(blast, blastR);
    }
    if (!rts.state.clock.paused && rts.state.clock.phase !== 'setup') {
      eng.syncExits(exits);
      eng.setZones([]);
      const steps = Math.max(1, Math.round(rts.state.clock.speed));
      for (let i = 0; i < steps; i++) eng.step();
    }
    const t = rts.state.clock.elapsed;
    let pending = 0;
    for (const body of bodies) {
      const ped = (body as Matter.Body & {
        __ped: { pedId: number; state: string; spawn: { x: number; y: number } };
      }).__ped;
      if (sealed(ped.spawn)) continue;
      if (ped.state === 'evacuating' && !startEv.has(ped.pedId)) startEv.set(ped.pedId, t);
      if (
        (ped.state === 'outside' || ped.state === 'arrived' || ped.state === 'left_map') &&
        !outAt.has(ped.pedId)
      ) {
        outAt.set(ped.pedId, t);
      }
      if (!outAt.has(ped.pedId) && ped.state !== 'down') pending++;
    }
    if (fired && pending === 0) break;
  }
  let eligible = 0;
  let within = 0;
  let down = 0;
  for (const body of bodies) {
    const ped = (body as Matter.Body & {
      __ped: { pedId: number; state: string; spawn: { x: number; y: number } };
    }).__ped;
    if (ped.state === 'down') down++;
    if (sealed(ped.spawn) || ped.state === 'down') continue;
    eligible++;
    const t0 = startEv.get(ped.pedId);
    const t1 = outAt.get(ped.pedId);
    if (t0 != null && t1 != null && t1 - t0 <= 120) within++;
  }
  eng.destroy();
  return { eligible, within, down, fired };
}

test('no hazards: at least 90% of people who can leave are out within 120s', () => {
  const result = leaveShare({ x: -30, y: -30 }, 1);
  assert.equal(result.fired, true);
  assert.equal(result.down, 0);
  assert.ok(
    result.eligible > 0 && result.within >= 0.9 * result.eligible,
    `out within 120s of starting ${result.within} of ${result.eligible} who were not sealed in`,
  );
});

test('no hazards, normal blast: at least 90% of people who can leave are out within 120s', () => {
  const result = leaveShare({ x: 10, y: 20 }, 15);
  assert.equal(result.fired, true);
  assert.ok(result.down > 0, 'the blast downed nobody');
  assert.ok(
    result.eligible > 0 && result.within >= 0.9 * result.eligible,
    `out within 120s of starting ${result.within} of ${result.eligible} who were not sealed in`,
  );
});

test('east exit blocked at T+2:00: at least 80% of people who can leave are out by T+5:00', () => {
  const verts: Vec2[] = [
    { x: 0, y: 0 },
    { x: 60, y: 0 },
    { x: 60, y: 40 },
    { x: 0, y: 40 },
  ];
  const exits: ExitDef[] = [
    exit({ id: 'E1-west', center: { x: 0, y: 20 }, edgeIndex: 3, width: 2 }),
    exit({ id: 'E2-east', center: { x: 60, y: 12 }, edgeIndex: 1, width: 2 }),
    exit({ id: 'E3-north', center: { x: 30, y: 40 }, edgeIndex: 2, width: 2, status: 'congested' }),
  ];
  const walls = [
    { startX: 22, startY: 0, endX: 22, endY: 34, hasDoor: true, doorWidth: 1.6, doorPosition: 0.5 },
    { startX: 40, startY: 6, endX: 40, endY: 40, hasDoor: true, doorWidth: 1.6, doorPosition: 0.4 },
    { startX: 46, startY: 0, endX: 46, endY: 8, hasDoor: false, doorWidth: 1.6, doorPosition: 0.5 },
    { startX: 46, startY: 8, endX: 60, endY: 8, hasDoor: false, doorWidth: 1.6, doorPosition: 0.5 },
  ];
  const effectWalls: InteriorWall[] = walls.map((w, i) => ({
    id: `w${i}`,
    start: { x: w.startX, y: w.startY },
    end: { x: w.endX, y: w.endY },
    hasDoor: w.hasDoor,
    doorWidth: w.doorWidth,
    doorPosition: w.doorPosition,
    description: `w${i}`,
    material: i >= 2 ? 'concrete' : 'drywall',
    photos: [],
  }));
  const studs: { id: string; simPos: Vec2; spatialContext: 'inside_building' | 'open_air' }[] = [];
  for (let x = -15; x <= 75; x += 3) {
    for (let y = -15; y <= 55; y += 3) {
      const inside = isInsidePolygon(x + 0.5, y + 0.5, verts);
      studs.push({
        id: `s_${x}_${y}`,
        simPos: { x: x + 0.5, y: y + 0.5 },
        spatialContext: inside ? 'inside_building' : 'open_air',
      });
    }
  }
  const blastSite = { x: 10, y: 20 };
  const blastR = 15;
  const rts = new RTSEngine();
  rts.setBuildingVertices(verts);
  const zoneKinds: Record<string, 'assembly' | 'convening'> = {};
  for (const z of [
    { pos: { x: -30, y: -10 }, kind: 'assembly' as const },
    { pos: { x: 95, y: 20 }, kind: 'convening' as const },
  ]) {
    zoneKinds[rts.placeEquipment('assembly_point', z.pos, 'system').id] = z.kind;
  }
  const currentZones = (): ShowcaseZone[] =>
    rts.state.equipment
      .filter((e) => e.def.kind === 'assembly_point' && e.active)
      .map((e) => ({
        id: e.id,
        pos: e.pos,
        radius: e.def.radius,
        label: e.def.label,
        kind: zoneKinds[e.id] ?? 'assembly',
      }));
  const eng = new PolygonEvacuationEngine(
    {
      vertices: verts,
      pedestrianCount: 120,
      pedestrianRadius: 0.25,
      desiredSpeed: 1.4,
      panicFactor: 0,
      dt: 1 / 60,
    },
    exits,
    walls,
    [],
    {
      afterExit: 'zone',
      zones: currentZones(),
      seed: SHOWCASE.RNG_SEED,
      buildingHeightM: SHOWCASE.BUILDING_STOREY_HEIGHT_M,
    },
  );
  rts.startDetonation();
  const effects = new SpatialEffectsEngine({
    ...DEFAULT_FIRE_PARAMS,
    ambientSpread: true,
    ambientHeatSec: SHOWCASE.AMBIENT_HEAT_S,
  });
  effects.init(studs);
  const affected = studs
    .filter((s) => Math.hypot(s.simPos.x - blastSite.x, s.simPos.y - blastSite.y) <= blastR)
    .map((s) => s.id);
  effects.registerHazard(
    'blast-direct',
    [
      {
        triggerTimeSec: blastEffectsTriggerSec(effects.timeScale),
        eventType: 'explode',
        spreadType: 'fire',
        spreadRadius: blastR,
        spreadRate: 10,
        description: 'Direct blast ignition',
        severity: 'critical',
        smokeGeneration: 'heavy',
        affectedStuds: affected,
      },
    ],
    { initial: 'a', triggered: 'b', worsening: 'c', critical: 'd' },
  );
  const hazardZones: HazardZone[] = [
    {
      id: 'blast-direct',
      pos: blastSite,
      radius: blastR,
      hazardType: 'ignitable',
      severity: 'high',
      label: 'Blast',
      description: 'Direct blast ignition',
      photos: [],
    },
  ];
  const field = new HazardField(
    studs.map((s) => ({ id: s.id, simPos: s.simPos, indoor: s.spatialContext === 'inside_building' })),
    3,
  );
  eng.setHazardField(field);
  let fired = false;
  let blocked = false;
  const dt = 1 / 60;
  while (rts.state.clock.elapsed < 300) {
    rts.tick(dt);
    const t = rts.state.clock.elapsed;
    if (!fired && isBlastDue(t, fired)) {
      fired = true;
      eng.triggerBlast(blastSite, blastR);
    }
    if (!blocked && t >= 120) {
      exits.find((e) => e.id === 'E2-east')!.status = 'blocked';
      blocked = true;
    }
    if (!rts.state.clock.paused && rts.state.clock.phase !== 'setup') {
      field.setStates(effects.studStates);
      eng.syncExits(exits);
      eng.setZones(currentZones());
      const steps = Math.max(1, Math.round(rts.state.clock.speed));
      for (let i = 0; i < steps; i++) eng.step();
      effects.step(dt * rts.state.clock.speed, effectWalls, hazardZones);
    }
  }
  const bodies = (eng as unknown as { pedestrians: Matter.Body[] }).pedestrians;
  const sealed = (spawn: { x: number; y: number }) => spawn.x >= 46 && spawn.y <= 8;
  let eligible = 0;
  let out = 0;
  for (const body of bodies) {
    const ped = (body as Matter.Body & {
      __ped: { state: string; spawn: { x: number; y: number } };
    }).__ped;
    if (sealed(ped.spawn) || ped.state === 'down') continue;
    eligible++;
    if (ped.state === 'outside' || ped.state === 'arrived' || ped.state === 'left_map') out++;
  }
  eng.destroy();
  assert.equal(fired, true);
  assert.equal(blocked, true);
  assert.ok(
    eligible > 0 && out >= 0.8 * eligible,
    `out by T+5:00 ${out} of ${eligible} who were not sealed in`,
  );
});
