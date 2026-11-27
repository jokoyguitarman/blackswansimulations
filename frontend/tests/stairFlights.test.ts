/**
 * Stair flights in buildings of three or more storeys: one queue and one
 * release slot per flight, floor and stair streams merging at landings,
 * counterflow taking a lane, a full flight holding the releases above it,
 * and the shaft's gas breathed on the stair.
 *
 * Reference numbers (see LEVEL_SOURCES):
 *  - SFPE specific flow 1.01 p/s/m on a 7/11 stair, 0.15 m boundary layers,
 *    so a 1.2 m stair carries 1.01 × 0.9 = 0.909 p/s.
 *  - Galea, Sharp & Lawrence (2008): merging at landings close to 50:50.
 *  - Fruin (1971) / HCM: a minor reverse stream takes one 0.76 m lane;
 *    NIST NCSTAR 1-7: on 1.1 m stairs that leaves single file each way.
 *  - SFPE S = k(1 − 0.266 D): movement stops at 3.76 p/m².
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Matter from 'matter-js';
import { LEVEL } from '../src/lib/evacuation/levelConstants.ts';
import { HazardField, chooseRoute } from '../src/lib/evacuation/hazardSensing.ts';
import { PolygonEvacuationEngine } from '../src/lib/evacuation/engine.ts';
import { DEFAULT_POLYGON_CONFIG } from '../src/lib/evacuation/types.ts';
import type { ExitDef, Vec2 } from '../src/lib/evacuation/types.ts';
import {
  flightAreaM2,
  flightFlowPerS,
  flightKey,
  flightStorage,
  flightWaitS,
  flightWidthM,
  mergePick,
  stairDensitySpeed,
} from '../src/lib/evacuation/stairFlow.ts';
import { isInsidePolygon } from '../src/lib/evacuation/geometry.ts';
import { heatFedPerMin } from '../src/lib/rts/toxicDose.ts';
import type { LevelDef, Stairwell } from '../src/lib/rts/types.ts';

const DT = DEFAULT_POLYGON_CONFIG.dt;
const RECT: Vec2[] = [
  { x: 0, y: 0 },
  { x: 40, y: 0 },
  { x: 40, y: 20 },
  { x: 0, y: 20 },
];

function levelDef(id: string, index: number, heightM = 4): LevelDef {
  return { id, name: id, index, heightM, designed: true, pedestrianCount: 0 };
}

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

function stairOf(id: string, from: string, to: string, widthM = 1.2, pos = { x: 20, y: 10 }) {
  const index = (lvl: string) => (lvl === 'G' ? 0 : Number(lvl.slice(1)));
  return {
    id,
    pos,
    connectsFloors: [index(from), index(to)] as [number, number],
    blocked: false,
    label: id,
    kind: 'stair' as const,
    widthM,
    levels: { from, to },
  } satisfies Stairwell;
}

type Label = {
  pedId: number;
  state: string;
  level: string;
  fed?: number;
  heatFed?: number;
  stairToLevel?: string;
  targetStairId?: string | null;
  stairDir?: string;
};

type Occ = {
  label: Label;
  stairId: string;
  dir: 'up' | 'down';
  fromLevel: string;
  toLevel: string;
  phase: 'queue' | 'travel';
  source?: 'floor' | 'stream';
  enqueuedAt: number;
  travelStart: number;
  travelDuration: number;
};

interface Inner {
  pedestrians: Matter.Body[];
  stairPeople: Occ[];
  engine: Matter.Engine;
}

/**
 * An engine with `counts` people per storey whose bodies are taken out of
 * the world, so the test can put them straight into stair queues.
 */
function build(ids: string[], counts: Record<string, number>, stairs: Stairwell[], heightM = 4) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const eng = new PolygonEvacuationEngine(
    { ...DEFAULT_POLYGON_CONFIG, vertices: RECT, pedestrianCount: 0 },
    [],
    [],
    [],
    { afterExit: 'zone', zones: [], seed: 7 },
    {
      ids,
      exitsByLevel: Object.fromEntries(
        ids.map((id) => [id, id === 'G' ? [exitOn('out', 'G')] : []]),
      ),
      wallsByLevel: Object.fromEntries(ids.map((id) => [id, []])),
      stairs,
      counts,
      heights: Object.fromEntries(ids.map((id) => [id, heightM])),
    },
  );
  const inner = eng as unknown as Inner;
  const labels = inner.pedestrians.map((body) => (body as Matter.Body & { __ped: Label }).__ped);
  assert.equal(labels.length, total);
  for (const body of inner.pedestrians) Matter.Composite.remove(inner.engine.world, body);
  inner.pedestrians.length = 0;
  return { eng, inner, labels };
}

function enqueue(
  inner: Inner,
  label: Label,
  stairId: string,
  fromLevel: string,
  toLevel: string,
  at: number,
) {
  label.state = 'evacuating';
  label.level = fromLevel;
  label.stairToLevel = toLevel;
  label.targetStairId = stairId;
  const dir = Number(toLevel.slice(1) || 0) < Number(fromLevel.slice(1) || 0) ? 'down' : 'up';
  label.stairDir = dir;
  inner.stairPeople.push({
    label,
    stairId,
    dir,
    fromLevel,
    toLevel,
    phase: 'queue',
    source: 'floor',
    enqueuedAt: at,
    travelStart: at,
    travelDuration: 1,
  });
}

/** Release time of every person onto every flight: `${pedId}@${fromLevel}` → s. */
function watchReleases(inner: Inner) {
  const seen = new Map<string, { t: number; from: string; source: string; pedId: number }>();
  return {
    seen,
    tick(now: number) {
      for (const occ of inner.stairPeople) {
        if (occ.phase !== 'travel') continue;
        const key = `${occ.label.pedId}@${occ.fromLevel}`;
        if (!seen.has(key)) {
          seen.set(key, {
            t: now,
            from: occ.fromLevel,
            source: occ.source ?? 'floor',
            pedId: occ.label.pedId,
          });
        }
      }
    },
  };
}

describe('stair flight arithmetic', () => {
  it('gives the whole effective width to one direction, and a lane to a minor reverse stream', () => {
    const narrow = stairOf('n', 'G', 'L1', 1.2);
    // 1.2 m less two 0.15 m boundary layers: 0.9 m, 0.909 p/s (SFPE 7/11).
    assert.ok(Math.abs(flightWidthM(narrow, 30, 0) - 0.9) < 1e-9);
    assert.ok(Math.abs(flightFlowPerS(narrow, 30, 0) - 0.909) < 1e-9);
    // On a 1.2 m stair the lane is capped at half: single file each way.
    assert.ok(Math.abs(flightWidthM(narrow, 30, 2) - 0.45) < 1e-9);
    assert.ok(Math.abs(flightWidthM(narrow, 2, 30) - 0.45) < 1e-9);
    const wide = stairOf('w', 'G', 'L1', 2.4);
    // 2.1 m effective: the minor stream takes one 0.76 m lane, the major the rest.
    assert.ok(Math.abs(flightWidthM(wide, 2, 30) - 0.76) < 1e-9);
    assert.ok(Math.abs(flightWidthM(wide, 30, 2) - 1.34) < 1e-9);
    // Equal demand splits evenly.
    assert.ok(Math.abs(flightWidthM(wide, 10, 10) - 1.05) < 1e-9);
  });

  it('stores a flight at the SFPE stopped density on its effective area', () => {
    // 4 m storey × 2.0 travel factor × 0.9 m effective × 3.76 p/m² = 27.1.
    assert.equal(flightStorage(stairOf('s', 'G', 'L1'), levelDef('L1', 1, 4)), 27);
    assert.equal(flightStorage(stairOf('s', 'G', 'L1'), levelDef('L1', 1, 3)), 20);
    // The area storage fills is the area the descent density is read on, so
    // a full flight sits at the jam density, not 3.76 × 1.2/0.9 = 5 p/m².
    for (const widthM of [1.0, 1.2, 1.8, 2.4]) {
      const stair = stairOf('s', 'G', 'L1', widthM);
      const from = levelDef('L1', 1, 3.5);
      const full = flightStorage(stair, from) / flightAreaM2(stair, from);
      assert.ok(full <= LEVEL.STAIR_JAM_DENSITY_PM2 + 1e-9, `${widthM} m: ${full} p/m²`);
      assert.ok(full > LEVEL.STAIR_JAM_DENSITY_PM2 - 1 / flightAreaM2(stair, from) - 1e-9);
    }
  });

  it('splits merged releases by the floor share', () => {
    for (const share of [0.5, 0.25, 0.75]) {
      let credit = 0;
      let floor = 0;
      for (let i = 0; i < 100; i++) {
        const next = mergePick(credit, share);
        credit = next.credit;
        if (next.pick === 'floor') floor++;
      }
      assert.equal(floor, share * 100, `share ${share}`);
    }
    let credit = 0;
    const picks: string[] = [];
    for (let i = 0; i < 4; i++) {
      const next = mergePick(credit, 0.5);
      credit = next.credit;
      picks.push(next.pick);
    }
    assert.deepEqual(picks, ['stream', 'floor', 'stream', 'floor']);
  });

  it('slows descent with density on the SFPE hydraulic curve, peaking at the specific flow', () => {
    // k = 4 × 0.266 × 1.01 = 1.075 m/s (SFPE ch. 59 gives 1.08 for 7/11).
    const k = 4 * 0.266 * 1.01;
    assert.ok(Math.abs(stairDensitySpeed(0) - k) < 1e-12);
    assert.ok(Math.abs(stairDensitySpeed(1) - k * (1 - 0.266)) < 1e-12);
    // The optimum: D = 1/(2a) = 1.88 p/m², S = k/2, S·D = 1.01 p/s/m.
    const dOpt = 1 / (2 * 0.266);
    assert.ok(Math.abs(stairDensitySpeed(dOpt) * dOpt - 1.01) < 1e-9);
    // Denser than the optimum is a queue, not a slower walk.
    assert.equal(stairDensitySpeed(3), stairDensitySpeed(dOpt));
    // The engine's free descent, 0.694 m/s, binds below about 1.33 p/m².
    const binds = (1 - LEVEL.STAIR_SPEED_DOWN / k) / 0.266;
    assert.ok(binds > 1.3 && binds < 1.36, `${binds}`);
  });

  it('prices a wait by the people ahead and the other stream’s share', () => {
    assert.equal(flightWaitS(9, 0, 0.5, 0.9), 10);
    // Ten ahead at the door and plenty on the stair: every door release waits one stair release.
    assert.equal(flightWaitS(9, 50, 0.5, 0.9), 20);
    // Only two on the stair to interleave.
    assert.ok(Math.abs(flightWaitS(9, 2, 0.5, 0.9) - 11 / 0.9) < 1e-9);
    assert.equal(flightWaitS(0, 10, 0.5, 0.9), 0);
  });
});

describe('stair flights in the engine', () => {
  it('runs every flight of a tall stair at its own capacity at once', () => {
    // Before per-flight queues all the down flights shared one 0.909 p/s slot.
    const stair = stairOf('s', 'G', 'L2');
    const { eng, inner, labels } = build(['G', 'L1', 'L2'], { G: 0, L1: 15, L2: 15 }, [stair]);
    for (let i = 0; i < 15; i++) enqueue(inner, labels[i], 's', 'L1', 'G', 0);
    for (let i = 15; i < 30; i++) enqueue(inner, labels[i], 's', 'L2', 'L1', 0);
    const watch = watchReleases(inner);
    const steps = Math.round(8 / DT);
    for (let i = 0; i < steps; i++) {
      eng.step();
      watch.tick((i + 1) * DT);
    }
    const rows = [...watch.seen.values()];
    const fromL1 = rows.filter((r) => r.from === 'L1').length;
    const fromL2 = rows.filter((r) => r.from === 'L2').length;
    const cap = 0.909 * 8;
    // Each flight starts at t = 0 and chains every 1.10 s: 8 releases in 8 s.
    assert.ok(fromL1 >= Math.floor(cap) && fromL1 <= Math.ceil(cap), `L1 flight ${fromL1}`);
    assert.ok(fromL2 >= Math.floor(cap) && fromL2 <= Math.ceil(cap), `L2 flight ${fromL2}`);
    eng.destroy();
  });

  it('keeps through-travellers on the stair and merges them 50:50 with the floor at the landing', () => {
    const stair = stairOf('s', 'G', 'L2');
    const { eng, inner, labels } = build(['G', 'L1', 'L2'], { G: 0, L1: 30, L2: 30 }, [stair]);
    // L2 starts first so its stream reaches the L1 landing while L1's door queue still stands.
    for (let i = 30; i < 60; i++) enqueue(inner, labels[i], 's', 'L2', 'L1', 0);
    for (let i = 0; i < 30; i++) enqueue(inner, labels[i], 's', 'L1', 'G', 0);
    const watch = watchReleases(inner);
    let respawnedOnL1 = 0;
    const steps = Math.round(90 / DT);
    for (let i = 0; i < steps; i++) {
      eng.step();
      watch.tick((i + 1) * DT);
      respawnedOnL1 += eng
        .getSnapshots()
        .filter((s) => s.level === 'L1' && !s.inStair && s.id >= labels[30].pedId).length;
    }
    // Nobody from L2 stepped off onto L1: they stayed in the stair.
    assert.equal(respawnedOnL1, 0);
    const l1 = [...watch.seen.values()].filter((r) => r.from === 'L1').sort((a, b) => a.t - b.t);
    const firstStream = l1.findIndex((r) => r.source === 'stream');
    const lastFloor = l1.map((r) => r.source).lastIndexOf('floor');
    assert.ok(firstStream >= 0 && lastFloor > firstStream, 'no contention at the landing');
    const contended = l1.slice(firstStream, lastFloor + 1);
    const floor = contended.filter((r) => r.source === 'floor').length;
    const share = floor / contended.length;
    // Galea et al. (2008) even merge; deterministic alternation leaves at most one over.
    assert.ok(Math.abs(floor - contended.length / 2) <= 1, `floor ${floor} of ${contended.length}`);
    assert.ok(share > 0.45 && share < 0.55, `share ${share.toFixed(2)}`);
    // The merged flight still runs at the stair's capacity.
    const span = contended.at(-1)!.t - contended[0].t;
    const rate = (contended.length - 1) / span;
    assert.ok(Math.abs(rate - 0.909) < 0.02, `merged rate ${rate.toFixed(3)} p/s`);
    eng.destroy();
  });

  it('holds the flight above a full landing to its storage, and the upper floor waits at its door', () => {
    // 2.5 m storeys: storage floor(2.5 × 2.0 × 0.9 × 3.76) = 16 per flight.
    const stair = stairOf('s', 'G', 'L2');
    const { eng, inner, labels } = build(['G', 'L1', 'L2'], { G: 0, L1: 80, L2: 80 }, [stair], 2.5);
    const storage = flightStorage(stair, levelDef('L2', 2, 2.5));
    assert.equal(storage, 16);
    for (let i = 80; i < 160; i++) enqueue(inner, labels[i], 's', 'L2', 'L1', 0);
    for (let i = 0; i < 80; i++) enqueue(inner, labels[i], 's', 'L1', 'G', 0);
    const watch = watchReleases(inner);
    let peakHeld = 0;
    let sawFull = false;
    const steps = Math.round(120 / DT);
    for (let i = 0; i < steps; i++) {
      eng.step();
      watch.tick((i + 1) * DT);
      const onFlight = inner.stairPeople.filter(
        (o) => o.phase === 'travel' && o.fromLevel === 'L2',
      ).length;
      const atLanding = inner.stairPeople.filter(
        (o) => o.phase === 'queue' && o.fromLevel === 'L1' && o.source === 'stream',
      ).length;
      peakHeld = Math.max(peakHeld, onFlight + atLanding);
      const view = eng.getStairFlights().find((f) => f.fromLevel === 'L2' && f.dir === 'down');
      if (view?.full) sawFull = true;
    }
    assert.ok(sawFull, 'the L2 flight never filled');
    // One person may land in the step the last release was granted.
    assert.ok(peakHeld <= storage + 1, `held ${peakHeld} over storage ${storage}`);
    // Once full, the L2 door is fed at the stair stream's half of the L1 flight.
    const l2 = [...watch.seen.values()].filter((r) => r.from === 'L2').sort((a, b) => a.t - b.t);
    const late = l2.filter((r) => r.t >= 80 && r.t <= 115);
    const rate = (late.length - 1) / (late.at(-1)!.t - late[0].t);
    assert.ok(Math.abs(rate - 0.909 / 2) < 0.06, `L2 rate when full ${rate.toFixed(3)} p/s`);
    eng.destroy();
  });

  it('narrows the descent to single file while responders climb the same flight', () => {
    const stair = stairOf('s', 'G', 'L1');
    const { eng, inner, labels } = build(['G', 'L1'], { G: 0, L1: 30 }, [stair]);
    for (let i = 0; i < 30; i++) enqueue(inner, labels[i], 's', 'L1', 'G', 0);
    for (let i = 0; i < Math.round(5 / DT); i++) eng.step();
    const ids = eng.sendStairResponders('s', 4);
    assert.equal(ids.length, 4);
    const watch = watchReleases(inner);
    let counterflowSeen = false;
    for (let i = 0; i < Math.round(60 / DT); i++) {
      eng.step();
      watch.tick(5 + (i + 1) * DT);
      const down = eng.getStairFlights().find((f) => f.dir === 'down');
      if (down?.counterflow) {
        counterflowSeen = true;
        // 1.01 p/s/m × 0.45 m: half the stair, single file.
        assert.ok(Math.abs(down.flowPerS - 1.01 * 0.45) < 1e-9, `down ${down.flowPerS}`);
      }
    }
    assert.ok(counterflowSeen);
    const arrivals = eng.getResponderArrivals();
    assert.equal(arrivals.length, 4);
    assert.ok(arrivals.every((a) => a.level === 'L1'));
    // Responders queue at the G door on the narrowed up lane: 2.2 s apart, then a 4 m climb.
    const climb = (4 * LEVEL.STAIR_TRAVEL_FACTOR) / LEVEL.STAIR_SPEED_UP;
    const last = arrivals.at(-1)!.atS;
    assert.ok(last >= 5 + climb + 3 * (1 / (1.01 * 0.45)) - 0.1, `last responder at ${last}`);
    // While they were on it, descending releases were at least 2.2 s apart.
    const times = [...watch.seen.values()].map((r) => r.t).sort((a, b) => a - b);
    const during = times.filter((t) => t > 5.1 && t < last - climb);
    for (let i = 1; i < during.length; i++) {
      assert.ok(during[i] - during[i - 1] >= 1 / (1.01 * 0.45) - DT - 1e-9);
    }
    // No dose for responders, and they are not evacuees.
    assert.equal(eng.getSnapshots().length, 30);
    eng.destroy();
  });

  it('breathes the landing ahead in step with the walk down, and only the floor at the door', () => {
    // Before, a walker on the flight breathed only the storey they left.
    const stair = stairOf('s', 'G', 'L1');
    const { eng, inner, labels } = build(['G', 'L1'], { G: 0, L1: 10 }, [stair]);
    const hot = new HazardField([{ id: 'g-land', simPos: { x: 20, y: 10 }, indoor: true }], 3);
    hot.setStates(new Map([['g-land', { smoke: 0, fire: { state: 'none' }, headTempC: 120 }]]));
    eng.setHazardFields(
      new Map([
        ['G', hot],
        ['L1', new HazardField([], 3)],
      ]),
    );
    for (let i = 0; i < 10; i++) enqueue(inner, labels[i], 's', 'L1', 'G', 0);
    for (let i = 0; i < Math.round(4 / DT); i++) eng.step();
    const walking = inner.stairPeople.filter((o) => o.phase === 'travel');
    const queued = inner.stairPeople.filter((o) => o.phase === 'queue');
    assert.ok(walking.length >= 3 && queued.length >= 5);
    // Linear in progress: after s seconds of a T s flight, the dose is
    // rate × s² / 2T, half of standing in the G landing's air throughout.
    const rate = heatFedPerMin(120, undefined) / 60;
    for (const o of walking) {
      const s = 4 - o.travelStart;
      const expected = (rate * s * s) / (2 * o.travelDuration);
      const got = o.label.heatFed ?? 0;
      assert.ok(Math.abs(got - expected) <= rate * DT + 1e-9, `${got} vs ${expected}`);
    }
    for (const o of queued) assert.equal(o.label.heatFed ?? 0, 0);
    eng.destroy();
  });

  it('takes longer down a crowded flight than an empty one, never slower than k/2', () => {
    const stair = stairOf('s', 'G', 'L1');
    const { eng, inner, labels } = build(['G', 'L1'], { G: 0, L1: 20 }, [stair]);
    for (let i = 0; i < 20; i++) enqueue(inner, labels[i], 's', 'L1', 'G', 0);
    const durations = new Map<number, number>();
    for (let i = 0; i < Math.round(25 / DT); i++) {
      eng.step();
      for (const o of inner.stairPeople) {
        if (o.phase === 'travel' && !durations.has(o.label.pedId)) {
          durations.set(o.label.pedId, o.travelDuration);
        }
      }
    }
    const list = [...durations.values()];
    const free = (4 * LEVEL.STAIR_TRAVEL_FACTOR) / LEVEL.STAIR_SPEED_DOWN;
    const packed = (4 * LEVEL.STAIR_TRAVEL_FACTOR) / ((4 * 0.266 * 1.01) / 2);
    assert.ok(Math.abs(list[0] - free) < 1e-9, `first ${list[0]} vs ${free}`);
    assert.ok(Math.max(...list) > free + 1, `slowest ${Math.max(...list)}`);
    assert.ok(Math.max(...list) <= packed + 1e-9);
    eng.destroy();
  });

  it('packs the descent into its lane while responders climb against it', () => {
    // 4 m storey, 1.2 m stair: 7.2 m² of flight at full width, 3.6 m² in
    // single file. The flight is loaded at full width before the crews come.
    const run = (crews: boolean) => {
      const stair = stairOf('s', 'G', 'L1');
      const { eng, inner, labels } = build(['G', 'L1'], { G: 0, L1: 30 }, [stair]);
      for (let i = 0; i < 30; i++) enqueue(inner, labels[i], 's', 'L1', 'G', 0);
      const rows: Array<{ t: number; duration: number; on: number }> = [];
      const seen = new Set<number>();
      for (let i = 0; i < Math.round(20 / DT); i++) {
        const t = (i + 1) * DT;
        if (crews && i === Math.round(8 / DT)) eng.sendStairResponders('s', 4);
        eng.step();
        const travelling = inner.stairPeople.filter((o) => o.phase === 'travel');
        for (const o of travelling) {
          if (seen.has(o.label.pedId)) continue;
          seen.add(o.label.pedId);
          rows.push({ t, duration: o.travelDuration, on: travelling.length });
        }
      }
      eng.destroy();
      return rows;
    };
    const alone = run(false);
    const against = run(true);
    // Nothing changes before anyone climbs.
    const before = (rows: typeof alone) => rows.filter((r) => r.t <= 8 + 1e-9);
    assert.deepEqual(before(against), before(alone));
    const firstAfter = (rows: typeof alone) => rows.find((r) => r.t > 8 + DT)!;
    const a = firstAfter(alone);
    const b = firstAfter(against);
    assert.ok(b, 'no descender released while the crews climbed');
    const length = 4 * LEVEL.STAIR_TRAVEL_FACTOR;
    // The full-width density would leave this walker at (or near) free speed.
    const wide =
      length / Math.min(LEVEL.STAIR_SPEED_DOWN, stairDensitySpeed(b.on / (length * 0.9)));
    const lane =
      length / Math.min(LEVEL.STAIR_SPEED_DOWN, stairDensitySpeed(b.on / (length * 0.45)));
    assert.ok(lane > wide + 1, `lane ${lane} vs wide ${wide}`);
    assert.ok(b.duration > a.duration + 1, `against ${b.duration} vs alone ${a.duration}`);
    assert.ok(Math.abs(b.duration - lane) < Math.abs(b.duration - wide), `${b.duration}`);
    // Never slower than the optimum's k/2.
    const packed = length / ((4 * 0.266 * 1.01) / 2);
    for (const r of against) assert.ok(r.duration <= packed + 1e-9, `${r.duration}`);
  });

  it('breathes the landing blend on a flight the effects engine reports no column for', () => {
    // An unsolved column is left out of shaftColumns(); the flight must not read ambient.
    const stair = stairOf('s', 'G', 'L1');
    const { eng, inner, labels } = build(['G', 'L1'], { G: 0, L1: 1 }, [stair]);
    const hot = (id: string) => {
      const field = new HazardField([{ id, simPos: { x: 20, y: 10 }, indoor: true }], 3);
      field.setStates(new Map([[id, { smoke: 0, fire: { state: 'none' }, headTempC: 120 }]]));
      return field;
    };
    eng.setHazardFields(
      new Map([
        ['G', hot('g-land')],
        ['L1', hot('u-land')],
      ]),
    );
    eng.setShaftColumns([]);
    enqueue(inner, labels[0], 's', 'L1', 'G', 0);
    for (let i = 0; i < Math.round(4 / DT); i++) eng.step();
    const walker = inner.stairPeople[0];
    assert.equal(walker.phase, 'travel');
    // Both landings at 120 °C, so the blend is 120 °C throughout.
    const expected = (heatFedPerMin(120, undefined) / 60) * (4 - walker.travelStart);
    const got = labels[0].heatFed ?? 0;
    assert.ok(
      expected > 0 && Math.abs(got - expected) <= expected * 0.02 + 1e-9,
      `${got} vs ${expected}`,
    );
    eng.destroy();
  });

  it('breathes the shaft column’s heat on a flight when the effects engine reports one', () => {
    const stair = stairOf('s', 'G', 'L1');
    const { eng, inner, labels } = build(['G', 'L1'], { G: 0, L1: 1 }, [stair]);
    const clear = new HazardField([], 3);
    eng.setHazardFields(
      new Map([
        ['G', clear],
        ['L1', clear],
      ]),
    );
    eng.setShaftColumns([{ linkId: 's', lowerLevel: 'G', upperLevel: 'L1', tempK: 393.15 }]);
    enqueue(inner, labels[0], 's', 'L1', 'G', 0);
    for (let i = 0; i < Math.round(4 / DT); i++) eng.step();
    const walker = inner.stairPeople[0];
    assert.equal(walker.phase, 'travel');
    // 120 °C throughout the flight, though both landings are clear.
    const expected = (heatFedPerMin(120, undefined) / 60) * (4 - walker.travelStart);
    const got = labels[0].heatFed ?? 0;
    assert.ok(Math.abs(got - expected) <= expected * 0.02 + 1e-9, `${got} vs ${expected}`);
    eng.destroy();
  });

  it('lays the door queue out on the floor round the stair, one person per place', () => {
    const stair = stairOf('s', 'G', 'L2');
    const { eng, inner, labels } = build(['G', 'L1', 'L2'], { G: 0, L1: 0, L2: 25 }, [stair]);
    for (let i = 0; i < 25; i++) enqueue(inner, labels[i], 's', 'L2', 'L1', 0);
    eng.step();
    const queued = eng.getSnapshots().filter((s) => s.inStair?.queue === 'floor');
    assert.ok(queued.length >= 23, `${queued.length} queued`);
    const keys = new Set(queued.map((s) => `${s.x.toFixed(2)},${s.y.toFixed(2)}`));
    assert.equal(keys.size, queued.length, 'two queued people drawn on one place');
    for (const s of queued) {
      assert.equal(s.level, 'L2');
      assert.ok(isInsidePolygon(s.x, s.y, RECT));
      const d = Math.hypot(s.x - stair.pos.x, s.y - stair.pos.y);
      assert.ok(d >= 0.9 - 1e-9 && d <= 4, `queue place ${d.toFixed(2)} m out`);
    }
    // Nearest the stair is first in line.
    const first = queued.reduce((a, b) => (a.id < b.id ? a : b));
    const dFirst = Math.hypot(first.x - stair.pos.x, first.y - stair.pos.y);
    assert.ok(dFirst < 1.3, `first in line ${dFirst.toFixed(2)} m out`);
    eng.destroy();
  });

  it('prices each flight’s own queue in the route, not the whole stair’s', () => {
    // Stair A is nearer but has a long door queue on L2. Someone on L1 joins
    // A's L1 flight, which is empty, so A is still the better stair.
    const levels = [levelDef('G', 0), levelDef('L1', 1), levelDef('L2', 2)];
    const a = stairOf('a', 'G', 'L2', 1.2, { x: 12, y: 10 });
    const b = stairOf('b', 'G', 'L2', 1.2, { x: 30, y: 10 });
    const empty = new HazardField([], 3);
    const fields = new Map([
      ['G', empty],
      ['L1', empty],
      ['L2', empty],
    ]);
    const exits = [exitOn('out', 'G')];
    const queues = new Map([['a', { up: 0, down: 40 }]]);
    const pos = { x: 14, y: 10 };
    const legacy = chooseRoute(pos, 'L1', exits, [a, b], levels, fields, RECT, queues);
    assert.equal(legacy?.id, 'b', 'the stair-wide queue sends them to the far stair');
    const waits = new Map([
      [flightKey('a', 'down', 'L2'), { floor: 40 / 0.909, stream: 0 }],
      [flightKey('a', 'down', 'L1'), { floor: 0, stream: 0 }],
    ]);
    const perFlight = chooseRoute(
      pos,
      'L1',
      exits,
      [a, b],
      levels,
      fields,
      RECT,
      queues,
      null,
      undefined,
      undefined,
      {
        flightWaits: waits,
      },
    );
    assert.equal(perFlight?.id, 'a');
    assert.equal(perFlight?.toLevel, 'G');
  });
});
