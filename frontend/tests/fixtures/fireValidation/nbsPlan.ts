import { extinctionK } from '../../../src/lib/evacuation/hazardSensing.ts';
import type { ExitDef, Vec2 } from '../../../src/lib/evacuation/types.ts';
import { poolFireKw, type FuelCell } from '../../../src/lib/rts/flameFront.ts';
import { SpatialEffectsEngine } from '../../../src/lib/rts/spatialEffects.ts';
import type { InteriorWall } from '../../../src/lib/rts/types.ts';
import { AMBIENT_K } from '../../../src/lib/rts/twoZone.ts';

/**
 * NBS MV100A as one plan in the live engine: fire room, entry and corridor on
 * the 3 m stud grid, joined by the two 0.81 m doors, with the corridor's
 * 0.76 m door to the outside as the building exit. The engine fixes what the
 * grid can say, so this is the test's topology, not its dimensions.
 *
 * The entry stud is not its own room. A diagonal link meets the end of the
 * corridor-entry wall, so the entry joins the corridor: one 45 m² room
 * (`c0`–`c3` and `entry`). The jet is not cooled in a separate entry. The
 * corridor samples below still use `c0`–`c3` only.
 *
 * - The studs are whole cells of 9 m²: the fire room is one stud (5.5 m² in the
 *   test), the entry one stud (1.05 m²) and the corridor four (29.7 m²).
 * - One storey height, the corridor's 2.44 m. The fire room is 2.16 m.
 * - Walls are the engine's concrete lining; the test's are ceramic fibre and
 *   Marinite. Doors and the exit take the 2.0 m head (the test: 1.6 m and 2.03 m).
 * - The burner is a liquid pool stud sized to 110 kW, so its radiative
 *   fraction is the contents 0.35, not methane's 0.2.
 * - The 0.79 m door from the corridor to the target-room entry is shut for
 *   the whole of MV100A (CFAST `WallVent_4`, F = 0), so it is not in the plan.
 */

export const NBS_PLAN_CEILING_M = 2.44;
export const NBS_PLAN_FIRE_KW = 110;

const CORRIDOR = ['c0', 'c1', 'c2', 'c3'] as const;
const FIRE_ROOM = 'fire';
const ENTRY = 'entry';

function wall(
  id: string,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  doorWidth = 0,
): InteriorWall {
  return {
    id,
    start: { x: x1, y: y1 },
    end: { x: x2, y: y2 },
    hasDoor: doorWidth > 0,
    doorWidth,
    doorPosition: 0.5,
    description: '',
    material: 'concrete',
    photos: [],
    level: 'G',
  };
}

/** Pool area whose NUREG Eq. 3-2 release is `targetKw`. */
function poolAreaForKw(targetKw: number): number {
  let lo = 1e-4;
  let hi = 10;
  for (let i = 0; i < 60; i++) {
    const mid = 0.5 * (lo + hi);
    if (poolFireKw(mid) < targetKw) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

/** Grows within a second, then holds the pan; the load outlasts the run. */
function burner(): FuelCell {
  return {
    category: 'light',
    chfKwM2: 10,
    trp: 134,
    alphaKwS2: 1000,
    spreadMPerMin: 0,
    fuelLoadKgM2: 1e6,
    liquidPool: true,
    poolAreaM2: poolAreaForKw(NBS_PLAN_FIRE_KW),
    sootYieldGPerG: 0.005,
  };
}

export interface RoomSample {
  t: number;
  /** Ceiling when the room has no active layer. */
  interfaceM: number;
  /** Zero when the room has no active layer. */
  riseK: number;
  active: boolean;
  /** Mean extinction coefficient of the room's studs, 1/m. */
  meanK: number;
}

export interface NbsPlanRun {
  fireRoom: RoomSample[];
  corridor: RoomSample[];
  /** Burned release of the fire stud at the end, kW. */
  fireKw: number;
}

export function runNbsPlan(endS: number, sampleEveryS = 10): NbsPlanRun {
  const engine = new SpatialEffectsEngine(undefined, 1);
  const inside = (id: string, x: number, y: number) => ({
    id,
    simPos: { x, y },
    spatialContext: 'inside_building' as const,
    level: 'G',
  });
  engine.init([
    ...CORRIDOR.map((id, i) => inside(id, 3 * i, 0)),
    inside(ENTRY, 9, 3),
    inside(FIRE_ROOM, 9, 6),
    { id: 'out', simPos: { x: -3, y: 0 }, spatialContext: 'open_air' as const, level: 'G' },
  ]);
  engine.setStoreyHeights({ G: NBS_PLAN_CEILING_M });
  const verts: Vec2[] = [
    { x: -1.5, y: -1.5 },
    { x: 10.5, y: -1.5 },
    { x: 10.5, y: 7.5 },
    { x: 7.5, y: 7.5 },
    { x: 7.5, y: 1.5 },
    { x: -1.5, y: 1.5 },
  ];
  const outsideDoor: ExitDef = {
    id: 'corridor-outside',
    center: { x: -1.5, y: 0 },
    width: 0.76,
    edgeIndex: 5,
    description: 'corridor door to outside',
    status: 'open',
    photos: [],
    level: 'G',
  };
  engine.setBuildingEnvelope(verts, [outsideDoor]);
  const walls = [
    wall('corridor-entry', 7.5, 1.5, 10.5, 1.5, 0.81),
    wall('entry-fire', 7.5, 4.5, 10.5, 4.5, 0.81),
  ];
  engine.setFuelCells(new Map([[FIRE_ROOM, burner()]]));
  const internals = engine as unknown as {
    fireSim: { ignite: (ids: string[]) => void; fuelReleaseKw: (id: string) => number | undefined };
    layerState: Map<
      string,
      { active: boolean; members: string[]; zone: { interfaceM: number; upperK: number } }
    >;
  };
  internals.fireSim.ignite([FIRE_ROOM]);

  const sample = (t: number, members: readonly string[]): RoomSample => {
    let meanK = 0;
    for (const id of members) meanK += extinctionK(engine.studStates.get(id)?.smoke ?? 0);
    meanK /= members.length;
    const live = [...internals.layerState.values()].find(
      (row) => row.active && members.every((id) => row.members.includes(id)),
    );
    return {
      t,
      active: live != null,
      interfaceM: live ? live.zone.interfaceM : NBS_PLAN_CEILING_M,
      riseK: live ? live.zone.upperK - AMBIENT_K : 0,
      meanK,
    };
  };
  const fireRoom: RoomSample[] = [];
  const corridor: RoomSample[] = [];
  for (let t = 1; t <= endS; t++) {
    engine.step(1, walls, []);
    if (t % sampleEveryS === 0) {
      fireRoom.push(sample(t, [FIRE_ROOM]));
      corridor.push(sample(t, CORRIDOR));
    }
  }
  return { fireRoom, corridor, fireKw: internals.fireSim.fuelReleaseKw(FIRE_ROOM) ?? 0 };
}
