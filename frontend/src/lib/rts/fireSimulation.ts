import type { Vec2 } from '../evacuation/types';
import { LEVEL } from '../evacuation/levelConstants';
import { isNearWallBehind } from '../evacuation/hazardSensing';
import type { InteriorWall, HazardZone } from './types';
import { levelOf, neighborIdsByLevel, type ShaftPair } from './levels';
import { defaultLightFuel, type ElectricalPlacement, type GasLinePlacement } from './materialLibrary';
import { blastPressureAt, type ChargeSpec } from './blast/blastModel';
import {
  ELECTRICAL_IGNITE_M,
  FIREBALL_PULSE_S,
  FLAME_STANDOFF_M,
  FLASHOVER_MAX_AREA_M2,
  FLASHOVER_ROOM_KW,
  GAS_JET_KW,
  GAS_JET_REACH_M,
  GAS_RUPTURE_KPA,
  LOCAL_FLASHOVER_RADIUS_M,
  STUD_AREA_M2,
  addIgnitionDose,
  burnoutSec,
  electricalHeatReleaseKw,
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

/** A jet that is burning right now, for the picture on the plan. */
export interface GasJet {
  id: string;
  pos: Vec2;
  level: string;
}

export interface GasLineState {
  ruptured: boolean;
  jetting: boolean;
  shutoff: boolean;
  age: number;
}

interface GasRuntime {
  id: string;
  pos: Vec2;
  level: string;
  autoShutoffSec: number | null;
  ruptured: boolean;
  jetting: boolean;
  shutoff: boolean;
  age: number;
}

interface HeatSlot {
  flux: number;
  approach: number;
  partials: Array<{ flux: number; seconds: number }>;
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

/**
 * A crossing this close to a wall end still counts. The old 1% of the wall
 * length left a gap at a joint, so two collinear walls did not split a room.
 * Five centimetres is shorter than a body and far shorter than a door.
 */
const WALL_END_TOL_M = 0.05;

function segmentsIntersect(p1: Vec2, p2: Vec2, p3: Vec2, p4: Vec2): boolean {
  const d1x = p2.x - p1.x;
  const d1y = p2.y - p1.y;
  const d2x = p4.x - p3.x;
  const d2y = p4.y - p3.y;

  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < 1e-10) return false;

  const t = ((p3.x - p1.x) * d2y - (p3.y - p1.y) * d2x) / denom;
  const u = ((p3.x - p1.x) * d1y - (p3.y - p1.y) * d1x) / denom;
  if (!(t > 0.01 && t < 0.99)) return false;

  const wallLen = Math.hypot(d2x, d2y);
  const along = u * wallLen;
  return along >= -WALL_END_TOL_M && along <= wallLen + WALL_END_TOL_M;
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
  /** Survives setGasLines, so a shut valve stays shut when the page refreshes the list. */
  private gasRuntime = new Map<string, GasRuntime>();
  private electrical: ElectricalPlacement[] = [];
  private charge: ChargeSpec | null = null;

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
    this.gasRuntime.clear();
    this.electrical = [];
    this.charge = null;
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
   * The charge used the next time a blast event asks whether a line ruptures.
   * A missing or non-positive amount ruptures nothing.
   */
  setBlastCharge(spec: ChargeSpec | null) {
    if (!spec || !(spec.amountKg > 0) || !Number.isFinite(spec.amountKg)) {
      this.charge = null;
      return;
    }
    this.charge = {
      presetKey: spec.presetKey,
      amountKg: spec.amountKg,
      burst: spec.burst,
      heightM: spec.heightM,
    };
  }

  /**
   * Confirmed gas lines. Rupture, the jet, and shutoff stay with the id, so
   * calling this every frame does not close a jet or open a shut valve.
   * A line that disappeared is dropped.
   */
  setGasLines(lines: readonly GasLinePlacement[]) {
    const next = new Map<string, GasRuntime>();
    for (const line of lines) {
      const prev = this.gasRuntime.get(line.id);
      const valve =
        line.autoShutoffSec != null && Number.isFinite(line.autoShutoffSec) && line.autoShutoffSec > 0
          ? line.autoShutoffSec
          : null;
      next.set(line.id, {
        id: line.id,
        pos: { x: line.pos.x, y: line.pos.y },
        level: line.level || 'G',
        autoShutoffSec: valve,
        ruptured: prev?.ruptured ?? false,
        jetting: prev?.jetting ?? false,
        shutoff: prev?.shutoff ?? false,
        age: prev?.age ?? 0,
      });
    }
    this.gasRuntime = next;
  }

  /** Confirmed arcs and electrical circles. Replaced every call. They are not fuel. */
  setElectricalSources(sources: readonly ElectricalPlacement[]) {
    this.electrical = sources.map((source) => ({
      id: source.id,
      pos: { x: source.pos.x, y: source.pos.y },
      level: source.level || 'G',
    }));
  }

  /**
   * Trainer or player shutoff. Omit the id to close every jet.
   * Fuel that is already burning stays burning. A stud that was only heating
   * keeps the dose it has and does not take any more from the jet.
   */
  shutOffGas(id?: string) {
    for (const line of this.gasRuntime.values()) {
      if (id && line.id !== id) continue;
      line.shutoff = true;
      line.jetting = false;
    }
  }

  gasJets(): GasJet[] {
    const jets: GasJet[] = [];
    for (const line of this.gasRuntime.values()) {
      if (!line.jetting || line.shutoff) continue;
      jets.push({ id: line.id, pos: { x: line.pos.x, y: line.pos.y }, level: line.level });
    }
    return jets;
  }

  isJetting(id: string): boolean {
    const line = this.gasRuntime.get(id);
    return !!line && line.jetting && !line.shutoff;
  }

  gasLineState(id: string): GasLineState | null {
    const line = this.gasRuntime.get(id);
    if (!line) return null;
    return { ruptured: line.ruptured, jetting: line.jetting, shutoff: line.shutoff, age: line.age };
  }

  /**
   * Open a gas line where the blast's effective pressure reaches
   * GAS_RUPTURE_KPA. A line inside the fireball, or one that already has a
   * flame or an arc nearby, then burns as a jet at that point. A rupture
   * with no ignition source does nothing visible: no cloud and no second blast.
   * `level` omitted means every storey, matching igniteRadius.
   */
  applyBlast(origin: Vec2, fireballRadiusM: number, level: string | undefined, walls: InteriorWall[]) {
    const spec = this.charge;
    if (!spec || this.gasRuntime.size === 0) return;
    for (const line of this.gasRuntime.values()) {
      if (line.shutoff || line.ruptured) continue;
      if (level && line.level !== level) continue;
      const pressure = this.pressureAt(origin, line, spec, walls);
      if (!(pressure >= GAS_RUPTURE_KPA)) continue;
      line.ruptured = true;
      const dist = Math.hypot(line.pos.x - origin.x, line.pos.y - origin.y);
      const inFireball = fireballRadiusM > 0 && dist <= fireballRadiusM + 1e-6;
      if (inFireball || this.ignitionNear(line, walls)) line.jetting = true;
    }
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

    const heated = new Map<string, HeatSlot>();
    const slotFor = (id: string): HeatSlot => {
      let slot = heated.get(id);
      if (!slot) {
        slot = { flux: 0, approach: 0, partials: [] };
        heated.set(id, slot);
      }
      return slot;
    };
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
        const slot = slotFor(nId);
        slot.flux += pointSourceFluxKwM2(src.heatKw, Math.max(dist, FLAME_STANDOFF_M));
        const along = src.reachM / dist;
        if (along > slot.approach) slot.approach = along;
      }
    }

    this.refreshJets(walls);
    for (const line of this.gasRuntime.values()) {
      if (!line.jetting || line.shutoff) continue;
      let seconds = dt;
      if (line.autoShutoffSec != null) {
        const room = Math.max(0, line.autoShutoffSec - line.age);
        seconds = Math.min(dt, room);
        line.age += seconds;
        if (line.age + 1e-9 >= line.autoShutoffSec) {
          line.jetting = false;
          line.shutoff = true;
        }
      } else {
        line.age += dt;
      }
      if (!(seconds > 0)) continue;
      this.addSourceFlux(line.pos, line.level, GAS_JET_KW, walls, seconds, dt, slotFor);
    }
    const arcKw = electricalHeatReleaseKw();
    for (const source of this.electrical) {
      this.addSourceFlux(source.pos, source.level, arcKw, walls, dt, dt, slotFor);
    }

    for (const [id, fState] of this.states) {
      if (fState.state !== 'heating' || heated.has(id)) continue;
      if ((fState.dose ?? 0) > 0) {
        fState.approach = Math.min(1, fState.dose ?? 0);
        continue;
      }
      fState.state = 'none';
      fState.approach = 0;
    }

    for (const [id, slot] of heated) {
      const fState = this.states.get(id);
      const cell = this.cellFor(id);
      if (!fState || !cell || fState.state === 'burning' || fState.state === 'burnt_out') continue;
      const dose = this.accrueDose(fState.dose ?? 0, cell, slot, dt);
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
   * A ruptured line starts its jet when a flame is within one stud step, or
   * an arc is within ELECTRICAL_IGNITE_M. A solid wall blocks either. A door
   * gap does not. The jet itself never sets approach: it only adds flux.
   */
  private refreshJets(walls: InteriorWall[]) {
    for (const line of this.gasRuntime.values()) {
      if (line.shutoff || !line.ruptured || line.jetting) continue;
      if (this.ignitionNear(line, walls)) line.jetting = true;
    }
  }

  private ignitionNear(line: GasRuntime, walls: InteriorWall[]): boolean {
    for (const source of this.electrical) {
      if (source.level !== line.level) continue;
      const dist = Math.hypot(source.pos.x - line.pos.x, source.pos.y - line.pos.y);
      if (dist > ELECTRICAL_IGNITE_M + 1e-6) continue;
      if (this.lineBlocked(source.pos, line.pos, line.level, walls)) continue;
      return true;
    }
    for (const [id, state] of this.states) {
      if (state.state !== 'burning') continue;
      const stud = this.studIndex.get(id);
      if (!stud || levelOf(stud) !== line.level) continue;
      const dist = Math.hypot(stud.simPos.x - line.pos.x, stud.simPos.y - line.pos.y);
      if (dist > FRONT_LINK_M) continue;
      if (this.lineBlocked(stud.simPos, line.pos, line.level, walls)) continue;
      return true;
    }
    return false;
  }

  private pressureAt(origin: Vec2, line: GasRuntime, spec: ChargeSpec, walls: InteriorWall[]): number {
    const height = spec.burst === 'surface' ? 0 : spec.heightM;
    const range = Math.hypot(line.pos.x - origin.x, line.pos.y - origin.y, height);
    const near = isNearWallBehind(
      line.pos,
      origin,
      walls
        .filter((wall) => levelOf(wall) === line.level)
        .map((wall) => ({
          startX: wall.start.x,
          startY: wall.start.y,
          endX: wall.end.x,
          endY: wall.end.y,
          hasDoor: wall.hasDoor,
          doorWidth: wall.doorWidth,
          doorPosition: wall.doorPosition,
        })),
      [],
    );
    return blastPressureAt(spec, range, near).effectiveKpa;
  }

  /** A solid wall between the two points. A door gap is open. Flashover is not required. */
  private lineBlocked(from: Vec2, to: Vec2, level: string, walls: InteriorWall[]): boolean {
    for (const wall of walls) {
      if (levelOf(wall) !== level) continue;
      if (wallBlocksFire(from, to, wall)) return true;
    }
    return false;
  }

  /**
   * Add one source into the step's flux. A source that lasts the whole step
   * joins the steady flux. A valve that closes mid-step is a partial, so the
   * dose can be split. t_ig is not linear in flux, so the jet is not scaled.
   */
  private addSourceFlux(
    origin: Vec2,
    level: string,
    heatKw: number,
    walls: InteriorWall[],
    seconds: number,
    dt: number,
    slotFor: (id: string) => HeatSlot,
  ) {
    if (!(heatKw > 0) || !(seconds > 0)) return;
    const whole = seconds >= dt - 1e-9;
    for (const [id, stud] of this.studIndex) {
      if (levelOf(stud) !== level) continue;
      if (!this.acceptsFuel(id)) continue;
      const state = this.states.get(id);
      if (!state || state.state === 'burning' || state.state === 'burnt_out') continue;
      const dist = Math.hypot(stud.simPos.x - origin.x, stud.simPos.y - origin.y);
      if (dist > GAS_JET_REACH_M) continue;
      if (this.lineBlocked(origin, stud.simPos, level, walls)) continue;
      const flux = pointSourceFluxKwM2(heatKw, Math.max(dist, FLAME_STANDOFF_M));
      if (!(flux > 0)) continue;
      const slot = slotFor(id);
      if (whole) slot.flux += flux;
      else slot.partials.push({ flux, seconds });
    }
  }

  /**
   * Σ dt / t_ig. Partials cover a prefix of the step (the jet, until the
   * valve) and the steady flux covers the whole step. Cuts are the shutoff
   * instants, so a 1 s step and ten 0.1 s steps deliver the same dose.
   */
  private accrueDose(dose: number, cell: FuelCell, slot: HeatSlot, dt: number): number {
    if (slot.partials.length === 0) {
      return addIgnitionDose(dose, slot.flux, cell.chfKwM2, cell.trp, dt);
    }
    const cuts = [0, dt];
    for (const part of slot.partials) {
      if (part.seconds > 1e-9 && part.seconds < dt - 1e-9) cuts.push(part.seconds);
    }
    cuts.sort((a, b) => a - b);
    let next = dose;
    for (let i = 0; i < cuts.length - 1; i++) {
      const start = cuts[i] ?? 0;
      const end = cuts[i + 1] ?? start;
      const span = end - start;
      if (!(span > 1e-12)) continue;
      let flux = slot.flux;
      for (const part of slot.partials) {
        if (part.seconds > start + 1e-12) flux += part.flux;
      }
      next = addIgnitionDose(next, flux, cell.chfKwM2, cell.trp, span);
    }
    return next;
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

  /** Indoor stud → room, after the wall split. The door counts as wall. */
  compartmentIds(walls: InteriorWall[]): Map<string, string> {
    this.ensureCompartments(walls);
    return new Map(this.compartmentOf);
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
