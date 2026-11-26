/**
 * Harbour House crowd, open or with the east exit blocked at 120 s.
 * Same loop as the review `fire-mall` run: 120 people, plan walls, to T+600.
 * The counts on the result are the T+300 snapshot. `late` is T+600, past
 * the head-height crossing, so the crowd effect is pinned. The crowd
 * model has no ISO 13571 heat dose: FED and the down count are fumes.
 */
import { heatReleaseKw } from '../../src/lib/rts/flameFront.ts';
import { confirmedFuelCells } from '../../src/lib/rts/materialLibrary.ts';
import { harbourHouseFuelObjects } from '../../src/lib/rts/harbourHouseShowcase.ts';
import { AMBIENT_K } from '../../src/lib/rts/twoZone.ts';
import { HarbourRun } from './harbourHarness.ts';
import { effectsView } from './effectsView.ts';
import { fixed } from './round.ts';

const DT = 1 / 60;
const MARKS = [180, 240, 300] as const;

export interface HarbourMark {
  smoke: string;
  out: number;
  westLit: number;
  eastLit: number;
  burning: number;
}

export interface HarbourMallLayer {
  active: boolean;
  interfaceM: number;
  riseK: number;
}

/** T+600, after the layer has passed head height. Fumes only: no heat dose. */
export interface HarbourLate {
  inside: number;
  down: number;
  out: number;
  /** People whose nearest mall stud is within 2 m. */
  inMall: number;
  /** Highest FED among people still inside, including anyone down. */
  maxFed: number;
  /** Highest FED among the people standing in the mall. */
  mallFed: number;
  mall: HarbourMallLayer;
  smoke: string;
}

export interface HarbourCrowdResult {
  blocked: boolean;
  down: number;
  fumeDown: number;
  flashoverAtS: number | null;
  peakTotalMw: number;
  within120: number;
  crawling: number;
  reroutes: number;
  outByT300: number;
  reachable: number;
  /** Tile mall at T+300. A stud in the open mall, not a shop. */
  mall: HarbourMallLayer;
  marks: { t180: HarbourMark; t240: HarbourMark; t300: HarbourMark };
  late: HarbourLate;
}

interface CrowdBody {
  __ped: {
    pedId: number;
    state?: string;
    fumeDown?: boolean;
    fed?: number;
    spawn?: { x: number; y: number };
  };
  position?: { x: number; y: number };
}

function bodiesOf(run: HarbourRun): CrowdBody[] {
  return (run.evac as unknown as { pedestrians: CrowdBody[] }).pedestrians;
}

/** Plan (27.5, 18.5) is tile, clear of the shops and the kiosk. */
const MALL_STUD = 's_27_18';

function mallLayer(run: HarbourRun): HarbourMallLayer {
  const live = [...effectsView(run.effects).layerState.values()].find(
    (row) => row.active && row.members.includes(MALL_STUD),
  );
  if (!live) return { active: false, interfaceM: 4, riseK: 0 };
  return {
    active: true,
    interfaceM: fixed(live.zone.interfaceM, 2),
    riseK: fixed(live.zone.upperK - AMBIENT_K, 1),
  };
}

function lit(
  run: HarbourRun,
  stud: { id: string; simPos: { x: number; y: number } },
  where: 'west' | 'east',
): boolean {
  const fire = run.effects.studStates.get(stud.id)?.fire.state;
  if (fire !== 'burning' && fire !== 'burnt_out') return false;
  if (where === 'west') return stud.simPos.x < 22 && stud.simPos.y > 8;
  return stud.simPos.x > 40;
}

/** The Decision 9 crowd for a few seconds, before the blast at 60 s. */
export function harbourCrowdAt(seconds: number): HarbourRun {
  const run = new HarbourRun({
    afterExit: 'zone',
    zones: [
      { pos: { x: -30, y: -10 }, kind: 'assembly' },
      { pos: { x: 95, y: 20 }, kind: 'convening' },
    ],
  });
  run.start();
  run.effects.setFuelCells(confirmedFuelCells(harbourHouseFuelObjects(run.studs), run.studs));
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) run.frame(DT);
  return run;
}

export function runHarbourCrowd(blocked: boolean): HarbourCrowdResult {
  const run = new HarbourRun({
    afterExit: 'zone',
    zones: [
      { pos: { x: -30, y: -10 }, kind: 'assembly' },
      { pos: { x: 95, y: 20 }, kind: 'convening' },
    ],
  });
  run.start();
  const cells = confirmedFuelCells(harbourHouseFuelObjects(run.studs), run.studs);
  run.effects.setFuelCells(cells);
  const view = effectsView(run.effects);
  const fire = view.fireSim;

  const startEv = new Map<number, number>();
  const outAt = new Map<number, number>();
  let flashAt: number | null = null;
  let peakKw = 0;
  let exitBlocked = false;
  const marks = new Map<number, HarbourMark>();
  let at300: {
    down: number;
    fumeDown: number;
    within120: number;
    crawling: number;
    reroutes: number;
    outByT300: number;
    reachable: number;
    mall: HarbourMallLayer;
    peakTotalMw: number;
    flashoverAtS: number | null;
  } | null = null;
  while (run.rts.state.clock.elapsed < 600) {
    run.frame(DT);
    const t = run.rts.state.clock.elapsed;
    if (blocked && !exitBlocked && t >= 120) {
      run.setExitStatus('E2-east', 'blocked');
      exitBlocked = true;
    }
    for (const body of bodiesOf(run)) {
      const ped = body.__ped;
      const state = ped.state;
      if (state === 'evacuating' && !startEv.has(ped.pedId)) startEv.set(ped.pedId, t);
      if (
        (state === 'outside' || state === 'arrived' || state === 'left_map') &&
        !outAt.has(ped.pedId)
      ) {
        outAt.set(ped.pedId, t);
      }
    }
    if (flashAt == null && fire.flashedStuds.size > 0) flashAt = fixed(t, 2);
    let roomKw = 0;
    for (const [id, state] of fire.states) {
      if (state.state !== 'burning') continue;
      roomKw += heatReleaseKw(fire.burningCell(id), fire.burn.get(id)?.age ?? 0);
    }
    peakKw = Math.max(peakKw, roomKw);
    for (const mark of MARKS) {
      if (marks.has(mark) || t < mark) continue;
      const stats = run.effects.getStats();
      marks.set(mark, {
        smoke: run.meanIndoorSmoke().toFixed(3),
        out: outAt.size,
        westLit: run.studs.filter((stud) => lit(run, stud, 'west')).length,
        eastLit: run.studs.filter((stud) => lit(run, stud, 'east')).length,
        burning: stats.fire.burning,
      });
    }
    if (at300 == null && t >= 300) {
      const bodies = bodiesOf(run);
      const reachable = bodies.filter((body) => {
        const ped = body.__ped;
        const spawn = ped.spawn;
        return ped.state !== 'down' && !(spawn != null && spawn.x >= 46 && spawn.y <= 8);
      }).length;
      let within = 0;
      for (const [id, started] of startEv) {
        const left = outAt.get(id);
        if (left != null && left - started <= 120) within += 1;
      }
      const showcase = run.evac.getMetrics().showcase;
      at300 = {
        down: bodies.filter((body) => body.__ped.state === 'down').length,
        fumeDown: bodies.filter((body) => body.__ped.fumeDown).length,
        within120: reachable > 0 ? fixed(within / reachable, 3) : 0,
        crawling: showcase?.crawling ?? 0,
        reroutes: showcase?.reroutes ?? 0,
        outByT300: outAt.size,
        reachable,
        mall: mallLayer(run),
        peakTotalMw: fixed(peakKw / 1000, 1),
        flashoverAtS: flashAt,
      };
    }
  }

  if (at300 == null) throw new Error('Harbour crowd never reached T+300');
  const studPos = new Map(run.studs.map((stud) => [stud.id, stud.simPos]));
  let mallMembers: string[] = [];
  for (const live of effectsView(run.effects).layerState.values()) {
    if (live.members.includes(MALL_STUD)) mallMembers = live.members;
  }
  let inside = 0;
  let inMall = 0;
  let maxFed = 0;
  let mallFed = 0;
  let downLate = 0;
  for (const body of bodiesOf(run)) {
    const ped = body.__ped;
    if (ped.state === 'down') downLate += 1;
    if (ped.state === 'outside' || ped.state === 'arrived' || ped.state === 'left_map') continue;
    inside += 1;
    const fed = ped.fed ?? 0;
    if (fed > maxFed) maxFed = fed;
    const pos = body.position;
    if (!pos) continue;
    let best = Infinity;
    for (const id of mallMembers) {
      const sp = studPos.get(id);
      if (!sp) continue;
      const dist = Math.hypot(sp.x - pos.x, sp.y - pos.y);
      if (dist < best) best = dist;
    }
    if (best <= 2) {
      inMall += 1;
      if (fed > mallFed) mallFed = fed;
    }
  }
  const mark = (second: number): HarbourMark => {
    const found = marks.get(second);
    if (!found) throw new Error(`Harbour crowd missed T+${second}`);
    return found;
  };
  return {
    blocked,
    down: at300.down,
    fumeDown: at300.fumeDown,
    flashoverAtS: at300.flashoverAtS,
    peakTotalMw: at300.peakTotalMw,
    within120: at300.within120,
    crawling: at300.crawling,
    reroutes: at300.reroutes,
    outByT300: at300.outByT300,
    reachable: at300.reachable,
    mall: at300.mall,
    marks: { t180: mark(180), t240: mark(240), t300: mark(300) },
    late: {
      inside,
      down: downLate,
      out: outAt.size,
      inMall,
      maxFed: fixed(maxFed, 3),
      mallFed: fixed(mallFed, 3),
      mall: mallLayer(run),
      smoke: run.meanIndoorSmoke().toFixed(3),
    },
  };
}
