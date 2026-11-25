/**
 * Harbour House crowd, open or with the east exit blocked at 120 s.
 * Same loop as the review `fire-mall` run: 120 people, plan walls, to T+300.
 */
import { heatReleaseKw } from '../../src/lib/rts/flameFront.ts';
import { confirmedFuelCells } from '../../src/lib/rts/materialLibrary.ts';
import { harbourHouseFuelObjects } from '../../src/lib/rts/harbourHouseShowcase.ts';
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
  marks: { t180: HarbourMark; t240: HarbourMark; t300: HarbourMark };
}

interface CrowdBody {
  __ped: {
    pedId: number;
    state?: string;
    fumeDown?: boolean;
    spawn?: { x: number; y: number };
  };
}

function bodiesOf(run: HarbourRun): CrowdBody[] {
  return (run.evac as unknown as { pedestrians: CrowdBody[] }).pedestrians;
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
  while (run.rts.state.clock.elapsed < 300) {
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
  }

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
  const down = bodies.filter((body) => body.__ped.state === 'down').length;
  const fumeDown = bodies.filter((body) => body.__ped.fumeDown).length;
  const mark = (second: number): HarbourMark => {
    const found = marks.get(second);
    if (!found) throw new Error(`Harbour crowd missed T+${second}`);
    return found;
  };
  return {
    blocked,
    down,
    fumeDown,
    flashoverAtS: flashAt,
    peakTotalMw: fixed(peakKw / 1000, 1),
    within120: reachable > 0 ? fixed(within / reachable, 3) : 0,
    crawling: showcase?.crawling ?? 0,
    reroutes: showcase?.reroutes ?? 0,
    outByT300: outAt.size,
    reachable,
    marks: { t180: mark(180), t240: mark(240), t300: mark(300) },
  };
}
