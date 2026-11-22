/**
 * Pure storey helpers. No matter-js, React, or DOM.
 */
import type { ExitDef, Vec2 } from '../evacuation/types';
import { LEVEL } from '../evacuation/levelConstants';
import type { InteriorWall, LevelDef, Stairwell } from './types';

export function levelIndex(id: string): number {
  if (id === 'G') return 0;
  const match = /^(B|L)(\d+)$/.exec(id);
  if (!match) throw new Error(`bad level id ${id}`);
  const n = Number(match[2]);
  if (!Number.isInteger(n) || n < 1) throw new Error(`bad level id ${id}`);
  return match[1] === 'B' ? -n : n;
}

export function levelName(id: string): string {
  if (id === 'G') return 'Ground';
  if (id.startsWith('B')) return `Basement ${id.slice(1)}`;
  if (id.startsWith('L')) return `Level ${id.slice(1)}`;
  return id;
}

export function sortLevels(ids: string[]): string[] {
  return [...ids].sort((a, b) => levelIndex(a) - levelIndex(b));
}

export function defaultLevels(floors: string[]): LevelDef[] {
  const ids: string[] = [];
  for (const floor of floors) {
    const id = floor === 'Ground' ? 'G' : floor;
    if (!ids.includes(id)) ids.push(id);
  }
  if (ids.length === 0) ids.push('G');
  return sortLevels(ids).map((id) => ({
    id,
    name: levelName(id),
    index: levelIndex(id),
    heightM: id.startsWith('B') ? LEVEL.DEFAULT_BASEMENT_HEIGHT_M : LEVEL.DEFAULT_STOREY_HEIGHT_M,
    designed: true,
    pedestrianCount: 0,
  }));
}

export function levelOf<T extends { level?: string }>(el: T): string {
  return el.level ?? 'G';
}

export function linkLevels(sw: Stairwell, levels: LevelDef[]): string[] {
  const from = sw.levels?.from;
  const to = sw.levels?.to;
  let lo: number;
  let hi: number;
  if (from && to) {
    lo = Math.min(levelIndex(from), levelIndex(to));
    hi = Math.max(levelIndex(from), levelIndex(to));
  } else {
    lo = Math.min(sw.connectsFloors[0], sw.connectsFloors[1]);
    hi = Math.max(sw.connectsFloors[0], sw.connectsFloors[1]);
  }
  return sortLevels(levels.filter((l) => l.index >= lo && l.index <= hi).map((l) => l.id));
}

export function normaliseStairwell(sw: Stairwell, levels: LevelDef[]): Stairwell {
  const kind = sw.kind ?? 'stair';
  const widthM = sw.widthM ?? LEVEL.DEFAULT_STAIR_WIDTH_M;
  let from = sw.levels?.from;
  let to = sw.levels?.to;
  if (!from || !to) {
    from = levels.find((l) => l.index === sw.connectsFloors[0])?.id ?? 'G';
    to = levels.find((l) => l.index === sw.connectsFloors[1])?.id ?? 'G';
  }
  const known = (id: string) => levels.some((l) => l.id === id);
  if ((!known(from) || !known(to) || from === to) && levels.some((l) => l.id === 'L1')) {
    from = 'G';
    to = 'L1';
  }
  const fromIdx = levels.find((l) => l.id === from)?.index ?? sw.connectsFloors[0];
  const toIdx = levels.find((l) => l.id === to)?.index ?? sw.connectsFloors[1];
  return {
    ...sw,
    kind,
    widthM,
    levels: { from, to },
    connectsFloors: [Math.min(fromIdx, toIdx), Math.max(fromIdx, toIdx)],
  };
}

export function effectiveLevelPlan(
  levelId: string,
  levels: LevelDef[],
  elements: { walls: InteriorWall[]; exits: ExitDef[] },
): { walls: InteriorWall[]; exits: ExitDef[]; assumedFrom: string | null } {
  const self = levels.find((l) => l.id === levelId);
  if (!self) return { walls: [], exits: [], assumedFrom: null };
  const ownWalls = elements.walls.filter((w) => levelOf(w) === levelId);
  const ownExits = elements.exits.filter((e) => levelOf(e) === levelId);
  if (self.designed) return { walls: ownWalls, exits: ownExits, assumedFrom: null };
  const below = [...levels]
    .filter((l) => l.index < self.index && l.designed)
    .sort((a, b) => b.index - a.index)[0];
  if (!below) return { walls: [], exits: [], assumedFrom: null };
  return {
    walls: elements.walls
      .filter((w) => levelOf(w) === below.id)
      .map((w) => ({ ...w, level: levelId })),
    exits: elements.exits
      .filter((e) => levelOf(e) === below.id)
      .map((e) => ({ ...e, level: levelId })),
    assumedFrom: below.id,
  };
}

export function stairEffectiveWidthM(sw: Stairwell): number {
  const width = sw.widthM ?? LEVEL.DEFAULT_STAIR_WIDTH_M;
  return Math.max(0.3, width - 2 * LEVEL.STAIR_BOUNDARY_LAYER_M);
}

export function stairFlowPerS(sw: Stairwell): number {
  return LEVEL.STAIR_SPECIFIC_FLOW * stairEffectiveWidthM(sw);
}

export function stairTravelS(fromLevel: LevelDef, dir: 'up' | 'down'): number {
  const speed = dir === 'up' ? LEVEL.STAIR_SPEED_UP : LEVEL.STAIR_SPEED_DOWN;
  return (fromLevel.heightM * LEVEL.STAIR_TRAVEL_FACTOR) / speed;
}

/** Ped and wall collision bits for storey slot k (0 = lowest). */
export function levelCategories(k: number): { ped: number; wall: number } {
  return { ped: 1 << (2 * k), wall: 1 << (2 * k + 1) };
}

/**
 * Mean vent velocity through a door, from stack pressure and the CFAST orifice
 * relation. Mean is two thirds of the velocity at the top of the opening.
 */
export function ventMeanVelocity(tempK: number, depthM: number): number {
  if (!(tempK > 0) || !(depthM > 0)) return 0;
  const rhoS = 353 / tempK;
  const dRho = LEVEL.RHO_AIR - rhoS;
  if (dRho <= 0 || rhoS <= 0) return 0;
  return (2 / 3) * LEVEL.ORIFICE_C * Math.sqrt((2 * dRho * LEVEL.G * depthM) / rhoS);
}

/** Density-transfer coefficient per 3 m cell, upward only. */
export function shaftCoeffPerS(
  kind: 'stair' | 'lift',
  widthM: number,
  storeyHeightM: number,
): number {
  const depth = storeyHeightM * LEVEL.STAIR_NEUTRAL_DEPTH_FRACTION;
  const door = kind === 'lift' ? LEVEL.LIFT_DOOR_WIDTH_M : widthM;
  return (ventMeanVelocity(LEVEL.SMOKE_TEMP_K, depth) * door) / LEVEL.CELL_AREA_M2;
}

export interface ShaftLink {
  id: string;
  pos: Vec2;
  levels: string[];
  kind: 'stair' | 'lift';
  blocked: boolean;
  widthM?: number;
  /** Storey height keyed by the lower level of each landing. */
  heightByLevel?: Record<string, number>;
}

export interface ShaftPair {
  lower: string;
  upper: string;
  kind: 'stair' | 'lift';
  blocked: boolean;
  coeffPerS: number;
}

/** Same-level neighbours within `radius`, in original array order. */
export function neighborIdsByLevel(
  studs: Array<{ id: string; simPos: Vec2; level?: string }>,
  radius: number,
): Map<string, string[]> {
  const cell = radius;
  const buckets = new Map<string, number[]>();
  for (let i = 0; i < studs.length; i++) {
    const s = studs[i];
    const key = `${levelOf(s)}:${Math.floor(s.simPos.x / cell)}:${Math.floor(s.simPos.y / cell)}`;
    const list = buckets.get(key);
    if (list) list.push(i);
    else buckets.set(key, [i]);
  }
  const out = new Map<string, string[]>();
  for (let i = 0; i < studs.length; i++) {
    const s = studs[i];
    const cx = Math.floor(s.simPos.x / cell);
    const cy = Math.floor(s.simPos.y / cell);
    const lvl = levelOf(s);
    const cand: number[] = [];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const list = buckets.get(`${lvl}:${cx + dx}:${cy + dy}`);
        if (list) cand.push(...list);
      }
    }
    cand.sort((a, b) => a - b);
    const neighbors: string[] = [];
    for (const j of cand) {
      if (j === i) continue;
      const other = studs[j];
      if (other.id === s.id) continue;
      if (levelOf(other) !== lvl) continue;
      if (Math.hypot(other.simPos.x - s.simPos.x, other.simPos.y - s.simPos.y) <= radius) {
        neighbors.push(other.id);
      }
    }
    out.set(s.id, neighbors);
  }
  return out;
}

export function shaftPairs(
  studs: Array<{ id: string; simPos: Vec2; level?: string }>,
  links: ShaftLink[],
): ShaftPair[] {
  const pairs: ShaftPair[] = [];
  for (const link of links) {
    const ids = sortLevels(link.levels);
    const width = link.widthM ?? LEVEL.DEFAULT_STAIR_WIDTH_M;
    for (let i = 0; i < ids.length - 1; i++) {
      const lowerId = ids[i];
      const upperId = ids[i + 1];
      if (levelIndex(upperId) !== levelIndex(lowerId) + 1) continue;
      const height = link.heightByLevel?.[lowerId] ?? LEVEL.DEFAULT_STOREY_HEIGHT_M;
      const coeffPerS = shaftCoeffPerS(link.kind, width, height);
      const near = (id: string) =>
        studs.filter(
          (s) =>
            levelOf(s) === id &&
            Math.hypot(s.simPos.x - link.pos.x, s.simPos.y - link.pos.y) <= LEVEL.STAIR_STUD_RADIUS_M,
        );
      for (const lo of near(lowerId)) {
        let best: (typeof studs)[number] | null = null;
        let bestD = Infinity;
        for (const up of near(upperId)) {
          const d = Math.hypot(up.simPos.x - lo.simPos.x, up.simPos.y - lo.simPos.y);
          if (d < bestD) {
            bestD = d;
            best = up;
          }
        }
        if (!best) continue;
        pairs.push({
          lower: lo.id,
          upper: best.id,
          kind: link.kind,
          blocked: link.blocked,
          coeffPerS,
        });
      }
    }
  }
  return pairs;
}
