import type { Vec2 } from '../evacuation/types';
import { LEVEL } from '../evacuation/levelConstants';
import type { InteriorWall, HazardZone } from './types';
import { levelOf, neighborIdsByLevel, type ShaftPair } from './levels';
import { defaultLightFuel } from './materialLibrary';
import {
  FIREBALL_PULSE_S,
  FLAME_STANDOFF_M,
  FLASHOVER_MAX_AREA_M2,
  FLASHOVER_ROOM_KW,
  LOCAL_FLASHOVER_RADIUS_M,
  STUD_AREA_M2,
  addIgnitionDose,
  burnoutSec,
  fireballFluxKwM2,
  frontSpeedMps,
  heatReleaseKw,
  ignitionTimeSec,
  pointSourceFluxKwM2,
  type FuelCell,
} from './flameFront';

// ── Types ────────────────────────────────────────────────────────────────

export type FireState = 'none' | 'heating' | 'burning' | 'burnt_out';

export interface FireParams {
  /** Unused. The flame front does not read a spread rate in seconds. */
  baseSpreadRate: number;
  /** Fallback burn time when a stud has no fuel numbers. */
  burnDuration: number;
  /** Unused. Ignition time is t_ig. */
  heatTransferRate: number;
  /** Seconds a barrier resists after the source side has flashed over. */
  wallResistance: Record<string, number>;
  /** Unused. A hazard circle does not speed the front. */
  hazardAcceleration: Record<string, number>;
  /** Unused. The 8 m neighbour rule is gone. */
  ambientSpread?: boolean;
  /** Unused. The 30 s ambient timer is gone. */
  ambientHeatSec?: number;
}

export interface FireStudState {
  state: FireState;
  timer: number;
  fuelFactor: number;
  /** 0–1, how far the front has crossed into this stud. */
  approach?: number;
  /** Accumulated Σ dt / t_ig. Holds when the flux drops below CHF. */
  dose?: number;
}

export interface FireSimStud {
  id: string;
  simPos: Vec2;
  spatialContext: string | null;
  level?: string;
}

// ── Barrier ratings (seconds). The timer starts at flashover, not before. ─

export const DEFAULT_FIRE_PARAMS: FireParams = {
  baseSpreadRate: 30,
  burnDuration: 300,
  heatTransferRate: 15,
  wallResistance: {
    concrete: Infinity,
    brick: Infinity,
    masonry: Infinity,
    reinforced: Infinity,
    drywall: 1200,
    plasterboard: 1200,
    gypsum: 1200,
    glass: 120,
    window: 120,
    wood: 600,
    timber: 600,
    metal: 1800,
    steel: 1800,
    aluminum: 1500,
    '': 900,
  },
  hazardAcceleration: {
    combustible: 3,
    ignitable: 5,
    chemical: 4,
    electrical: 2,
    debris_risk: 1,
    falling_object: 1,
  },
};

// ── Geometry helpers ─────────────────────────────────────────────────────

function segmentsIntersect(p1: Vec2, p2: Vec2, p3: Vec2, p4: Vec2): boolean {
  const d1x = p2.x - p1.x;
  const d1y = p2.y - p1.y;
  const d2x = p4.x - p3.x;
  const d2y = p4.y - p3.y;

  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < 1e-10) return false;

  const t = ((p3.x - p1.x) * d2y - (p3.y - p1.y) * d2x) / denom;
  const u = ((p3.x - p1.x) * d1y - (p3.y - p1.y) * d1x) / denom;

  return t > 0.01 && t < 0.99 && u > 0.01 && u < 0.99;
}

function wallBlocksFire(from: Vec2, to: Vec2, wall: InteriorWall): boolean {
  if (wall.hasDoor) {
    const dx = wall.end.x - wall.start.x;
    const dy = wall.end.y - wall.start.y;
    const len = Math.hypot(dx, dy);
    if (len < 0.01) return false;

    const doorCenter = wall.doorPosition;
    const doorHalf = wall.doorWidth / (2 * len);
    const gapStart = Math.max(0, doorCenter - doorHalf);
    const gapEnd = Math.min(1, doorCenter + doorHalf);

    const solidA = {
      start: wall.start,
      end: { x: wall.start.x + dx * gapStart, y: wall.start.y + dy * gapStart },
    };
    const solidB = {
      start: { x: wall.start.x + dx * gapEnd, y: wall.start.y + dy * gapEnd },
      end: wall.end,
    };

    const hitsA = segmentsIntersect(from, to, solidA.start, solidA.end);
    const hitsB = segmentsIntersect(from, to, solidB.start, solidB.end);
    return hitsA || hitsB;
  }
  return segmentsIntersect(from, to, wall.start, wall.end);
}

function getWallMaterial(wall: InteriorWall): string {
  return (wall.material || '').toLowerCase().trim();
}

/**
 * Neighbour lookup. Wider than a single stud step so the existing order
 * check still sees the old 8 m set. The front itself refuses anything past
 * FRONT_LINK_M, so fire does not jump that neighbourhood.
 */
const NEIGHBOR_RADIUS = 8;

/**
 * One step on the 3 m grid, including the diagonal (about 4.24 m).
 * The front crosses to that next fuel stud and not across an empty one.
 */
const FRONT_LINK_M = 4.5;

// ── Fire Simulation Class ────────────────────────────────────────────────

export class FireSimulation {
  states: Map<string, FireStudState> = new Map();
  wallBreachTimers: Map<string, number> = new Map();
  params: FireParams;
  elapsed = 0;

  private studIndex: Map<string, FireSimStud> = new Map();
  private neighborCache: Map<string, string[]> = new Map();
  private shaftPairs: ShaftPair[] = [];
  private shaftBurn = new Map<string, number>();
  /**
   * Null means the caller named no fuel: indoor studs stand in as light wood.
   * A set, including an empty one, is the library: only those studs ignite.
   */
  private fuelStuds: Set<string> | null = null;
  private fuelCells: Map<string, FuelCell> | null = null;
  private burn = new Map<string, { age: number }>();
  /** Wall timers already advanced during this step. */
  private wallTick = new Set<string>();
  /**
   * Indoor studs on one storey that you can walk between without crossing a
   * wall. The door gap stays part of the wall for this split, so two rooms
   * stay two rooms. The gap still lets the front through. Outdoor studs are
   * not a path around a wall.
   */
  private compartmentOf = new Map<string, string>();
  private rooms = new Map<string, string[]>();
  private compartmentKey = '';
  /**
   * Studs that have met the flashover rule. In a room of at most 500 m²
   * that is every stud in the room. In a larger room it is a stud whose
   * burning neighbours, within the 12.6 m disc, sum to 1 MW. The latch
   * does not clear, so a barrier timer keeps running after the heat drops.
   */
  private flashedStuds = new Set<string>();

  constructor(params?: FireParams) {
    this.params = params ?? { ...DEFAULT_FIRE_PARAMS };
  }

  init(studs: FireSimStud[]) {
    this.studIndex.clear();
    this.states.clear();
    this.neighborCache.clear();
    this.wallBreachTimers.clear();
    this.shaftPairs = [];
    this.shaftBurn.clear();
    this.burn.clear();
    this.wallTick.clear();
    this.compartmentOf.clear();
    this.rooms.clear();
    this.compartmentKey = '';
    this.flashedStuds.clear();
    this.elapsed = 0;

    for (const s of studs) {
      this.studIndex.set(s.id, s);
      this.states.set(s.id, { state: 'none', timer: 0, fuelFactor: 1.0, approach: 0, dose: 0 });
    }

    this.buildNeighborCache(studs);
  }

  private buildNeighborCache(studs: FireSimStud[]) {
    const built = neighborIdsByLevel(studs, NEIGHBOR_RADIUS);
    for (const [id, neighbors] of built) this.neighborCache.set(id, neighbors);
  }

  setShaftPairs(pairs: ShaftPair[]) {
    this.shaftPairs = pairs;
    this.shaftBurn.clear();
  }

  /** Pass null for the indoor light-wood stand-in. The set survives init. */
  setFuelStuds(ids: ReadonlySet<string> | null) {
    this.fuelStuds = ids == null ? null : new Set(ids);
    this.fuelCells = null;
  }

  /**
   * Category and ignition numbers per stud. Null is the indoor stand-in.
   * The id set is the map's keys, so an empty map burns nothing.
   */
  setFuelCells(cells: ReadonlyMap<string, FuelCell> | null) {
    if (cells == null) {
      this.fuelCells = null;
      this.fuelStuds = null;
      return;
    }
    this.fuelCells = new Map(cells);
    this.fuelStuds = new Set(cells.keys());
  }

  private acceptsFuel(id: string): boolean {
    if (this.fuelStuds == null) {
      return this.studIndex.get(id)?.spatialContext === 'inside_building';
    }
    return this.fuelStuds.has(id);
  }

  private cellFor(id: string): FuelCell | null {
    if (!this.acceptsFuel(id)) return null;
    return this.fuelCells?.get(id) ?? defaultLightFuel();
  }

  private burningCell(id: string): FuelCell {
    return this.fuelCells?.get(id) ?? defaultLightFuel();
  }

  private catchFire(id: string) {
    const state = this.states.get(id);
    if (!state || state.state === 'burning' || state.state === 'burnt_out') return;
    const cell = this.burningCell(id);
    state.state = 'burning';
    state.timer = burnoutSec(cell);
    state.fuelFactor = 1;
    state.approach = 1;
    state.dose = 1;
    if (!this.burn.has(id)) this.burn.set(id, { age: 0 });
  }

  ignite(studIds: string[]) {
    for (const id of studIds) this.catchFire(id);
  }

  /**
   * The blast pulse. Fuel inside the radius takes the fireball flux for the
   * whole pulse at once. Tile and anything outside the radius are unchanged.
   */
  igniteRadius(center: Vec2, radius: number, level?: string) {
    for (const [id, stud] of this.studIndex) {
      if (level && (stud.level ?? 'G') !== level) continue;
      if (!this.acceptsFuel(id)) continue;
      const distance = Math.hypot(stud.simPos.x - center.x, stud.simPos.y - center.y);
      if (distance > radius + 1e-6) continue;
      const state = this.states.get(id);
      const cell = this.cellFor(id);
      if (!state || !cell || state.state === 'burning' || state.state === 'burnt_out') continue;
      const flux = fireballFluxKwM2(distance, radius);
      const tig = ignitionTimeSec(flux, cell.chfKwM2, cell.trp);
      const dose = tig == null ? state.dose ?? 0 : (state.dose ?? 0) + FIREBALL_PULSE_S / tig;
      state.dose = dose;
      if (dose >= 1 - 1e-6) this.catchFire(id);
      else if (dose > 0) {
        state.state = 'heating';
        state.approach = Math.min(1, dose);
      }
    }
  }

  step(dt: number, walls: InteriorWall[], _hazards: HazardZone[]) {
    if (dt <= 0) return;
    this.elapsed += dt;
    this.wallTick.clear();
    this.ensureCompartments(walls);

    const burning: Array<{
      id: string;
      stud: FireSimStud;
      cell: FuelCell;
      heatKw: number;
      reachM: number;
    }> = [];
    const roomHeat = new Map<string, number>();

    for (const [id, fState] of this.states) {
      if (fState.state !== 'burning') continue;
      const stud = this.studIndex.get(id);
      if (!stud) continue;
      const meta = this.burn.get(id) ?? { age: 0 };
      meta.age += dt;
      const cell = this.burningCell(id);
      const heatKw = heatReleaseKw(cell, meta.age);
      this.burn.set(id, meta);
      const room = this.compartmentOf.get(id);
      if (room) roomHeat.set(room, (roomHeat.get(room) ?? 0) + heatKw);
      fState.timer -= dt;
      fState.approach = 1;
      if (fState.timer <= 0) {
        fState.state = 'burnt_out';
        fState.timer = 0;
        fState.approach = 0;
        continue;
      }
      burning.push({
        id,
        stud,
        cell,
        heatKw,
        reachM: meta.age * frontSpeedMps(cell.spreadMPerMin),
      });
    }

    this.applyFlashover(roomHeat, burning);

    const incoming = new Map<string, { flux: number; approach: number }>();
    for (const src of burning) {
      const neighbors = this.neighborCache.get(src.id) ?? [];
      for (const nId of neighbors) {
        const dest = this.studIndex.get(nId);
        const nState = this.states.get(nId);
        if (!dest || !nState) continue;
        if (nState.state === 'burning' || nState.state === 'burnt_out') continue;
        if (!this.acceptsFuel(nId)) continue;
        const dist = Math.hypot(dest.simPos.x - src.stud.simPos.x, dest.simPos.y - src.stud.simPos.y);
        if (!(dist > 0) || dist > FRONT_LINK_M) continue;
        if (!this.crossingOpen(src.stud, dest, walls, dt)) continue;
        const slot = incoming.get(nId) ?? { flux: 0, approach: 0 };
        slot.flux += pointSourceFluxKwM2(src.heatKw, Math.max(dist, FLAME_STANDOFF_M));
        const along = src.reachM / dist;
        if (along > slot.approach) slot.approach = along;
        incoming.set(nId, slot);
      }
    }

    for (const [id, fState] of this.states) {
      if (fState.state !== 'heating' || incoming.has(id)) continue;
      if ((fState.dose ?? 0) > 0) {
        fState.approach = Math.min(1, fState.dose ?? 0);
        continue;
      }
      fState.state = 'none';
      fState.approach = 0;
    }

    for (const [id, slot] of incoming) {
      const fState = this.states.get(id);
      const cell = this.cellFor(id);
      if (!fState || !cell || fState.state === 'burning' || fState.state === 'burnt_out') continue;
      const dose = addIgnitionDose(fState.dose ?? 0, slot.flux, cell.chfKwM2, cell.trp, dt);
      fState.dose = dose;
      if (dose >= 1 || slot.approach >= 1) {
        this.catchFire(id);
        continue;
      }
      if (dose > 0 || slot.approach > 0) {
        fState.state = 'heating';
        fState.approach = Math.max(slot.approach, Math.min(1, dose));
      }
    }

    for (const pair of this.shaftPairs) {
      if (pair.kind !== 'stair') continue;
      const lower = this.states.get(pair.lower);
      const key = `${pair.lower}->${pair.upper}`;
      if (lower?.state !== 'burning') continue;
      const burned = (this.shaftBurn.get(key) ?? 0) + dt;
      this.shaftBurn.set(key, burned);
      if (burned + 1e-9 < LEVEL.STAIR_FIRE_HEAT_S) continue;
      if (!this.acceptsFuel(pair.upper)) continue;
      const upper = this.states.get(pair.upper);
      if (!upper || upper.state !== 'none') continue;
      this.catchFire(pair.upper);
    }
  }

  /**
   * Indoor studs joined by a walk that does not cross a wall, door included.
   * Rebuilt when the wall geometry changes.
   */
  private ensureCompartments(walls: InteriorWall[]) {
    let key = String(this.studIndex.size);
    for (const wall of walls) {
      key += `|${levelOf(wall)}:${wall.start.x},${wall.start.y}:${wall.end.x},${wall.end.y}`;
    }
    if (key === this.compartmentKey) return;
    this.compartmentKey = key;
    this.compartmentOf.clear();
    this.rooms.clear();

    const seen = new Set<string>();
    for (const start of this.studIndex.values()) {
      if (start.spatialContext !== 'inside_building' || seen.has(start.id)) continue;
      const members: string[] = [];
      const stack = [start.id];
      seen.add(start.id);
      while (stack.length > 0) {
        const id = stack.pop() as string;
        members.push(id);
        const stud = this.studIndex.get(id);
        if (!stud) continue;
        const level = levelOf(stud);
        for (const nId of this.neighborCache.get(id) ?? []) {
          if (seen.has(nId)) continue;
          const dest = this.studIndex.get(nId);
          if (!dest || dest.spatialContext !== 'inside_building' || levelOf(dest) !== level) continue;
          let separated = false;
          for (const wall of walls) {
            if (levelOf(wall) !== level) continue;
            if (segmentsIntersect(stud.simPos, dest.simPos, wall.start, wall.end)) {
              separated = true;
              break;
            }
          }
          if (separated) continue;
          seen.add(nId);
          stack.push(nId);
        }
      }
      const roomId = members.reduce((best, id) => (id < best ? id : best));
      this.rooms.set(roomId, members);
      for (const id of members) this.compartmentOf.set(id, roomId);
    }
  }

  /**
   * A room of at most 500 m² flashes over when the burning fuel in it sums
   * to about 1 MW. Every fuelled stud in that room ignites. A larger room
   * does not. There the fire travels by the front and the flux, and a stud
   * latches when the burning fuel within about 12.6 m of it sums to 1 MW,
   * which is what starts a barrier timer. The latch stays after the heat drops.
   */
  private applyFlashover(
    roomHeat: Map<string, number>,
    burning: Array<{ id: string; stud: FireSimStud; heatKw: number }>,
  ) {
    const heatOf = new Map<string, number>();
    for (const src of burning) heatOf.set(src.id, src.heatKw);

    for (const [room, members] of this.rooms) {
      const area = members.length * STUD_AREA_M2;
      if (area <= FLASHOVER_MAX_AREA_M2) {
        const hot = (roomHeat.get(room) ?? 0) >= FLASHOVER_ROOM_KW;
        const latched = members.some((id) => this.flashedStuds.has(id));
        if (!hot && !latched) continue;
        for (const id of members) {
          this.flashedStuds.add(id);
          if (this.acceptsFuel(id)) this.catchFire(id);
        }
        continue;
      }

      const local: Array<{ id: string; x: number; y: number; heat: number }> = [];
      for (const id of members) {
        const heat = heatOf.get(id);
        const stud = this.studIndex.get(id);
        if (heat == null || !stud) continue;
        local.push({ id, x: stud.simPos.x, y: stud.simPos.y, heat });
      }
      for (const src of local) {
        if (this.flashedStuds.has(src.id)) continue;
        let sum = 0;
        for (const other of local) {
          const dist = Math.hypot(other.x - src.x, other.y - src.y);
          if (dist <= LOCAL_FLASHOVER_RADIUS_M + 1e-6) sum += other.heat;
        }
        if (sum >= FLASHOVER_ROOM_KW) this.flashedStuds.add(src.id);
      }
    }
  }

  /**
   * A door gap is open. A solid barrier stays shut until the source has
   * flashed over, then for its rating. In a room of at most 500 m² that is
   * the whole room. In a larger room it is the 12.6 m disc around this stud.
   * Concrete and the other infinite ratings never open. The timer does not
   * run before that criterion.
   */
  private crossingOpen(
    src: FireSimStud,
    dest: FireSimStud,
    walls: InteriorWall[],
    dt: number,
  ): boolean {
    const srcLevel = levelOf(src);
    for (const wall of walls) {
      if (levelOf(wall) !== srcLevel) continue;
      if (!wallBlocksFire(src.simPos, dest.simPos, wall)) continue;
      if (!this.flashedStuds.has(src.id)) return false;
      const resistance = this.lookupResistance(getWallMaterial(wall));
      if (resistance === Infinity) return false;
      const key = `${src.id}->${dest.id}`;
      const elapsed = this.wallBreachTimers.get(key) ?? 0;
      if (this.wallTick.has(key)) return elapsed + 1e-9 >= resistance;
      const next = elapsed + dt;
      this.wallBreachTimers.set(key, next);
      this.wallTick.add(key);
      return next + 1e-9 >= resistance;
    }
    return true;
  }

  private lookupResistance(material: string): number {
    const mat = material.toLowerCase().trim();
    for (const [key, val] of Object.entries(this.params.wallResistance)) {
      if (mat.includes(key) || key.includes(mat)) {
        return val;
      }
    }
    return this.params.wallResistance[''] ?? 900;
  }

  runPreview(
    seconds: number,
    walls: InteriorWall[],
    hazards: HazardZone[],
    stepSize = 1,
  ): Map<string, FireStudState> {
    const steps = Math.ceil(seconds / stepSize);
    for (let i = 0; i < steps; i++) {
      this.step(stepSize, walls, hazards);
    }
    return new Map(this.states);
  }

  getStats() {
    let none = 0,
      heating = 0,
      burning = 0,
      burntOut = 0;
    for (const s of this.states.values()) {
      switch (s.state) {
        case 'none':
          none++;
          break;
        case 'heating':
          heating++;
          break;
        case 'burning':
          burning++;
          break;
        case 'burnt_out':
          burntOut++;
          break;
      }
    }
    return { none, heating, burning, burntOut, total: none + heating + burning + burntOut };
  }
}
