/**
 * Six-storey drill on one 1.2 m stair: 25 people on each of L1 to L5 walk
 * to the stair at once, with no smoke, and leave by a ground-floor door.
 *
 * Checked against the hydraulic model (SFPE Handbook 5th ed. ch. 64):
 *  - the stair delivers its capacity, 1.01 p/s/m × 0.9 m = 0.909 p/s, at
 *    the ground, however many flights feed it;
 *  - each landing merges its floor and the stair stream close to 50:50
 *    (Galea, Sharp & Lawrence 2008) while both wait;
 *  - no flight holds more than its storage (3.76 p/m², SFPE);
 *  - the top floor, which has no stream to merge with, empties at the full
 *    flight rate, and every floor below takes longer.
 *
 * About 2 s of wall time, so it runs in the per-PR suite.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import Matter from 'matter-js';
import { PolygonEvacuationEngine } from '../src/lib/evacuation/engine.ts';
import { HazardField } from '../src/lib/evacuation/hazardSensing.ts';
import { DEFAULT_POLYGON_CONFIG, type ExitDef, type Vec2 } from '../src/lib/evacuation/types.ts';
import { flightStorage } from '../src/lib/evacuation/stairFlow.ts';
import type { LevelDef, Stairwell } from '../src/lib/rts/types.ts';

const IDS = ['G', 'L1', 'L2', 'L3', 'L4', 'L5'];
const PER_FLOOR = 25;
const HEIGHT_M = 3.5;
const RECT: Vec2[] = [
  { x: 0, y: 0 },
  { x: 24, y: 0 },
  { x: 24, y: 12 },
  { x: 0, y: 12 },
];
const STAIR: Stairwell = {
  id: 'core',
  pos: { x: 3, y: 6 },
  connectsFloors: [0, 5],
  blocked: false,
  label: 'Core',
  kind: 'stair',
  widthM: 1.2,
  levels: { from: 'G', to: 'L5' },
};
const EXIT: ExitDef = {
  id: 'out',
  center: { x: 0, y: 6 },
  width: 2,
  edgeIndex: 3,
  description: '',
  status: 'open',
  photos: [],
  level: 'G',
};

interface Label {
  pedId: number;
  state?: string;
  level?: string;
  nextCheckAt?: number;
}

interface Occ {
  label: Label;
  fromLevel: string;
  dir: 'up' | 'down';
  phase: 'queue' | 'travel';
  source?: 'floor' | 'stream';
}

function runDrill(durationS: number) {
  const dt = DEFAULT_POLYGON_CONFIG.dt;
  const eng = new PolygonEvacuationEngine(
    { ...DEFAULT_POLYGON_CONFIG, vertices: RECT, pedestrianCount: 0 },
    [],
    [],
    [],
    { afterExit: 'zone', zones: [], seed: 11 },
    {
      ids: IDS,
      exitsByLevel: Object.fromEntries(IDS.map((id) => [id, id === 'G' ? [EXIT] : []])),
      wallsByLevel: Object.fromEntries(IDS.map((id) => [id, []])),
      stairs: [STAIR],
      counts: Object.fromEntries(IDS.map((id) => [id, id === 'G' ? 0 : PER_FLOOR])),
      heights: Object.fromEntries(IDS.map((id) => [id, HEIGHT_M])),
    },
  );
  const empty = new HazardField([], 3);
  eng.setHazardFields(new Map(IDS.map((id) => [id, empty])));
  const inner = eng as unknown as { pedestrians: Matter.Body[]; stairPeople: Occ[] };
  const home = new Map<number, string>();
  for (const body of inner.pedestrians) {
    const ped = (body as Matter.Body & { __ped: Label }).__ped;
    ped.state = 'evacuating';
    ped.nextCheckAt = 0;
    home.set(ped.pedId, ped.level ?? '');
  }
  const released = new Map<string, { t: number; from: string; source: string }>();
  const onG = new Map<number, number>();
  let peakHeld = 0;
  let stepOffMidway = 0;
  const storage = flightStorage(STAIR, {
    id: 'L1',
    name: 'L1',
    index: 1,
    heightM: HEIGHT_M,
    designed: true,
    pedestrianCount: 0,
  } satisfies LevelDef);
  for (let i = 0; i < Math.round(durationS / dt); i++) {
    eng.step();
    const t = (i + 1) * dt;
    for (const occ of inner.stairPeople) {
      if (occ.phase !== 'travel') continue;
      const key = `${occ.label.pedId}@${occ.fromLevel}`;
      if (!released.has(key)) {
        released.set(key, { t, from: occ.fromLevel, source: occ.source ?? 'floor' });
      }
    }
    for (let k = 1; k < IDS.length; k++) {
      const flight = inner.stairPeople.filter(
        (o) => o.phase === 'travel' && o.fromLevel === IDS[k],
      ).length;
      const landing = inner.stairPeople.filter(
        (o) => o.phase === 'queue' && o.source === 'stream' && o.fromLevel === IDS[k - 1],
      ).length;
      peakHeld = Math.max(peakHeld, flight + landing);
    }
    for (const snap of eng.getSnapshots()) {
      if (snap.inStair) continue;
      if (snap.level === 'G' && !onG.has(snap.id)) onG.set(snap.id, t);
      const from = home.get(snap.id);
      if (snap.level && snap.level !== 'G' && snap.level !== from) stepOffMidway++;
    }
  }
  eng.destroy();
  return { released, onG, peakHeld, storage, stepOffMidway };
}

test(
  'six storeys on one stair: capacity at the ground, even merges, storage held, the top floor first',
  { timeout: 2 * 60 * 1000 },
  () => {
    const run = runDrill(260);
    const total = PER_FLOOR * (IDS.length - 1);
    assert.equal(run.onG.size, total, `${run.onG.size} of ${total} reached the ground`);
    assert.equal(run.stepOffMidway, 0, 'someone stepped off the stair on a middle storey');
    assert.ok(run.peakHeld <= run.storage + 1, `held ${run.peakHeld}, storage ${run.storage}`);

    // Ground delivery between the 10th and 90th percentile arrivals.
    const times = [...run.onG.values()].sort((a, b) => a - b);
    const lo = Math.floor(total * 0.1);
    const hi = Math.floor(total * 0.9);
    const rate = (hi - lo) / (times[hi] - times[lo]);
    assert.ok(Math.abs(rate - 0.909) / 0.909 < 0.05, `ground delivery ${rate.toFixed(3)} p/s`);

    // Every landing from L1 to L4 merges about evenly while both streams wait.
    for (const level of ['L1', 'L2', 'L3', 'L4']) {
      const rows = [...run.released.values()]
        .filter((r) => r.from === level)
        .sort((a, b) => a.t - b.t);
      const first = rows.findIndex((r) => r.source === 'stream');
      const last = rows.map((r) => r.source).lastIndexOf('floor');
      assert.ok(first >= 0 && last > first, `${level}: no merge`);
      const both = rows.slice(first, last + 1);
      const floor = both.filter((r) => r.source === 'floor').length;
      const share = floor / both.length;
      assert.ok(share >= 0.4 && share <= 0.6, `${level}: floor share ${share.toFixed(2)}`);
    }

    // The top floor never merges: its door empties at the full flight rate,
    // 25 / 0.909 = 27.5 s after its first release. Every floor below shares
    // its flight with the stream from above and takes longer.
    const doorTimes = (id: string) =>
      [...run.released.values()]
        .filter((r) => r.from === id && r.source === 'floor')
        .map((r) => r.t)
        .sort((a, b) => a - b);
    const top = doorTimes('L5');
    const topRate = (top.length - 1) / (top.at(-1)! - top[0]);
    assert.ok(Math.abs(topRate - 0.909) < 0.02, `L5 door ${topRate.toFixed(3)} p/s`);
    for (const id of ['L1', 'L2', 'L3', 'L4']) {
      assert.ok(doorTimes(id).at(-1)! > top.at(-1)! + 5, `${id} door done before L5`);
    }
    // The hydraulic lower bound: everyone through one 0.909 p/s stair.
    assert.ok(times.at(-1)! >= total / 0.909, `last on G at ${times.at(-1)!.toFixed(0)} s`);
  },
);
