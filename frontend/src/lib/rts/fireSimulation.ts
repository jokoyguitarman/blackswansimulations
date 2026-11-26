import type { Vec2 } from '../evacuation/types';
import { LEVEL } from '../evacuation/levelConstants';
import type { InteriorWall, HazardZone } from './types';
import { levelOf, neighborIdsByLevel, type ShaftPair } from './levels';
import {
  defaultLightFuel,
  type ElectricalPlacement,
  type GasLinePlacement,
  type SuppressionPlacement,
} from './materialLibrary';
import { blastPressureAt, type ChargeSpec } from './blast/blastModel';
import { leafWidthM } from './doorLeaf';
import { HOOD_FAN_WHEN, pyrolysisFraction, type HoodFanWhen } from './twoZone';
import {
  ELECTRICAL_ARC_SEC,
  ELECTRICAL_DAMAGE_KPA,
  ELECTRICAL_IGNITE_M,
  FIREBALL_PULSE_S,
  FLAME_STANDOFF_M,
  FLASHOVER_MAX_AREA_M2,
  FLASHOVER_ROOM_KW,
  GAS_JET_KW,
  GAS_JET_REACH_M,
  GAS_RUPTURE_KPA,
  HOOD_HEIGHT_M,
  HOOD_LINK_C,
  LINK_QUANTUM_S,
  LOCAL_FLASHOVER_RADIUS_M,
  SPRINKLER_ACT_C,
  SPRINKLER_AMBIENT_C,
  SPRINKLER_CEILING_M,
  SPRINKLER_RTI,
  STUD_AREA_M2,
  SUPPRESSION_REACH_M,
  WET_CHEMICAL_RTI,
  addIgnitionDose,
  burnoutSec,
  fuelEnergyKj,
  releaseEnergyKj,
  advanceSprinklerLink,
  ceilingJet,
  electricalHeatReleaseKw,
  fireballFluxKwM2,
  frontSpeedMps,
  heatReleaseKw,
  ignitionTimeSec,
  pointSourceFluxKwM2,
  suppressedHeatKw,
  type FuelCell,
} from './flameFront';
import {
  fumesPresent,
  sootProductionGPerS,
  speciesProductionGPerS,
  type FumeGrams,
} from './toxicDose';

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
  /**
   * Unused by the flame front. A chemical circle is 1: it does not speed
   * ignition. Suppression is a placed head, not this multiplier.
   */
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
  /**
   * Burning release divided by the unsprayed release. 1 until a spray
   * opens on this stud, then it falls with the decay.
   */
  output?: number;
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
  /** kW while the valve is open. A spray does not reduce it. */
  heatKw: number;
}

/** An arc that is burning right now, for the picture on the plan. */
export interface ElectricalArc {
  id: string;
  pos: Vec2;
  level: string;
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
  /**
   * Seconds into the current step when a wet-chemical interlock closed this
   * line. Null when the valve was not closed during this step. The jet still
   * heats for that prefix, then stops. It is not persisted.
   */
  closedAt: number | null;
}

interface ArcRuntime {
  id: string;
  pos: Vec2;
  level: string;
  damaged: boolean;
  arcing: boolean;
  shutoff: boolean;
  age: number;
}

/** A head that is discharging, for the picture on the plan. */
export interface SuppressionSpray {
  id: string;
  pos: Vec2;
  level: string;
}

interface SuppressionRuntime {
  id: string;
  pos: Vec2;
  level: string;
  kind: SuppressionPlacement['kind'];
  /** Fire-to-link distance. Storey height for a sprinkler, hood height for wet chemical. */
  ceilingM: number;
  rti: number;
  /** Temperature that opens this link, °C. */
  actC: number;
  linkC: number;
  open: boolean;
  /** Seconds since the link opened. */
  age: number;
}

interface BurnRuntime {
  age: number;
  qAct: number | null;
  suppressAge: number;
  /**
   * Share of the prescribed release pyrolysed this step. Taken while the
   * layer's limit is still the one this step burns on. The layer clears
   * that limit before it reads the soot.
   */
  pyrolysis?: number;
  /**
   * Kilojoules of the fuel load not yet pyrolysed. Absent when the cell has
   * no load to integrate, and the free-burn clock is used instead.
   */
  fuelKj?: number;
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
    chemical: 1, // a chemical circle does not speed ignition
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
  const openWidth = leafWidthM(wall);
  if (openWidth > 0) {
    const dx = wall.end.x - wall.start.x;
    const dy = wall.end.y - wall.start.y;
    const len = Math.hypot(dx, dy);
    if (len < 0.01) return false;

    const doorCenter = wall.doorPosition;
    const doorHalf = openWidth / (2 * len);
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
  private burn = new Map<string, BurnRuntime>();
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
  /**
   * Oxygen limit from the last layer step. `fraction` scales the heat that
   * spreads. `phi` is the equivalence ratio the yields read, and above 2
   * it scales the pyrolysed mass. A stud with no entry is burning in free air.
   */
  private burnLimit = new Map<string, { fraction: number; phi: number }>();
  /** Survives setGasLines, so a shut valve stays shut when the page refreshes the list. */
  private gasRuntime = new Map<string, GasRuntime>();
  /** Survives setElectricalSources, so a shut supply stays shut. */
  private arcRuntime = new Map<string, ArcRuntime>();
  /** Survives setSuppression, so a link that is already warming is not reset. */
  private suppressionRuntime = new Map<string, SuppressionRuntime>();
  /** Seconds into the current step when a spray first covers a stud. */
  private coverFrom = new Map<string, number>();
  /** Walls from the latest step, so a fireball respects an open spray. */
  private sceneWalls: InteriorWall[] = [];
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
    this.burnLimit.clear();
    this.gasRuntime.clear();
    this.arcRuntime.clear();
    this.suppressionRuntime.clear();
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

  /**
   * Studs added after the fire has started. Existing burn state stays.
   * New studs are appended, so an old neighbour list keeps its order.
   */
  addStuds(studs: readonly FireSimStud[]): void {
    let added = false;
    for (const stud of studs) {
      if (this.studIndex.has(stud.id)) continue;
      this.studIndex.set(stud.id, stud);
      this.states.set(stud.id, {
        state: 'none',
        timer: 0,
        fuelFactor: 1.0,
        approach: 0,
        dose: 0,
      });
      added = true;
    }
    if (!added) return;
    this.neighborCache.clear();
    this.buildNeighborCache([...this.studIndex.values()]);
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
    if (!this.burn.has(id)) this.burn.set(id, this.freshBurn(cell));
  }

  /** Fuel ledger for a stud that just caught. The load is the free-burn integral. */
  private freshBurn(cell: FuelCell): BurnRuntime {
    const load = fuelEnergyKj(cell);
    return {
      age: 0,
      qAct: null,
      suppressAge: 0,
      fuelKj: load > 0 && cell.alphaKwS2 > 0 ? load : undefined,
    };
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
        line.autoShutoffSec != null &&
        Number.isFinite(line.autoShutoffSec) &&
        line.autoShutoffSec > 0
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
        closedAt: null,
      });
    }
    this.gasRuntime = next;
  }

  /**
   * Confirmed sprinkler and wet-chemical heads. The link temperature and
   * whether it has opened stay with the id, so calling this every frame
   * does not cool a link or close a head. A head that disappeared is dropped.
   * Nothing here opens a head: only the ceiling jet does that.
   */
  setSuppression(heads: readonly SuppressionPlacement[]) {
    const next = new Map<string, SuppressionRuntime>();
    for (const head of heads) {
      const prev = this.suppressionRuntime.get(head.id);
      const wet = head.kind === 'wet_chemical';
      const storey =
        Number.isFinite(head.ceilingM) && head.ceilingM > 0 ? head.ceilingM : SPRINKLER_CEILING_M;
      next.set(head.id, {
        id: head.id,
        pos: { x: head.pos.x, y: head.pos.y },
        level: head.level || 'G',
        kind: wet ? 'wet_chemical' : 'sprinkler',
        ceilingM: wet ? HOOD_HEIGHT_M : storey,
        rti: wet ? WET_CHEMICAL_RTI : SPRINKLER_RTI,
        actC: wet ? HOOD_LINK_C : SPRINKLER_ACT_C,
        linkC: prev?.linkC ?? SPRINKLER_AMBIENT_C,
        open: prev?.open ?? false,
        age: prev?.age ?? 0,
      });
    }
    this.suppressionRuntime = next;
  }

  /**
   * Confirmed electrical fittings. Damage, the arc, and shutoff stay with
   * the id, so calling this every frame does not start an undamaged fitting
   * or restart a supply that was shut off. A fitting that disappeared is
   * dropped. They are not fuel, and they do not arc until a blast faults them.
   */
  setElectricalSources(sources: readonly ElectricalPlacement[]) {
    const next = new Map<string, ArcRuntime>();
    for (const source of sources) {
      const prev = this.arcRuntime.get(source.id);
      next.set(source.id, {
        id: source.id,
        pos: { x: source.pos.x, y: source.pos.y },
        level: source.level || 'G',
        damaged: prev?.damaged ?? false,
        arcing: prev?.arcing ?? false,
        shutoff: prev?.shutoff ?? false,
        age: prev?.age ?? 0,
      });
    }
    this.arcRuntime = next;
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

  /**
   * Trainer or player power shutoff. Omit the id to kill every arc.
   * Fuel that is already burning stays burning. A stud that was only heating
   * keeps the dose it has.
   */
  shutOffPower(id?: string) {
    for (const arc of this.arcRuntime.values()) {
      if (id && arc.id !== id) continue;
      arc.shutoff = true;
      arc.arcing = false;
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

  electricalArcs(): ElectricalArc[] {
    const arcs: ElectricalArc[] = [];
    for (const arc of this.arcRuntime.values()) {
      if (!arc.arcing || arc.shutoff) continue;
      arcs.push({ id: arc.id, pos: { x: arc.pos.x, y: arc.pos.y }, level: arc.level });
    }
    return arcs;
  }

  sprays(): SuppressionSpray[] {
    const sprays: SuppressionSpray[] = [];
    for (const head of this.suppressionRuntime.values()) {
      if (!head.open) continue;
      sprays.push({ id: head.id, pos: { x: head.pos.x, y: head.pos.y }, level: head.level });
    }
    return sprays;
  }

  /** Link temperature and whether the head is open. Null when there is no such head. */
  suppressionState(id: string): { linkC: number; open: boolean; age: number } | null {
    const head = this.suppressionRuntime.get(id);
    if (!head) return null;
    return { linkC: head.linkC, open: head.open, age: head.age };
  }

  /** Release of a burning stud after suppression, or null when it is not burning. */
  fuelReleaseKw(id: string): number | null {
    const state = this.states.get(id);
    if (!state || state.state !== 'burning') return null;
    const meta = this.burn.get(id);
    if (!meta) return null;
    return this.releaseKw(this.burningCell(id), meta);
  }

  /** True once this stud has met the flashover rule. The latch does not clear. */
  isFlashed(id: string): boolean {
    return this.flashedStuds.has(id);
  }

  /** Drop every room's oxygen limit. The layer step puts the current ones back. */
  clearBurnLimits(): void {
    this.burnLimit.clear();
  }

  /**
   * One room's oxygen limit, on every stud in it. The fraction is the share
   * of the prescribed release that the oxygen can burn. φ is the equivalence
   * ratio before the lower-oxygen cutoff.
   */
  setBurnLimit(ids: readonly string[], fraction: number, phi: number): void {
    const kept = fraction > 0 ? Math.min(1, fraction) : 0;
    const ratio =
      phi > 0 && Number.isFinite(phi)
        ? phi
        : phi === Number.POSITIVE_INFINITY
          ? Number.POSITIVE_INFINITY
          : 0;
    for (const id of ids) this.burnLimit.set(id, { fraction: kept, phi: ratio });
  }

  /** 1 when this stud is not in a limited room. */
  burnFraction(id: string): number {
    return this.burnLimit.get(id)?.fraction ?? 1;
  }

  /** 0 when this stud has no equivalence ratio. Well-ventilated yields. */
  burnPhi(id: string): number {
    return this.burnLimit.get(id)?.phi ?? 0;
  }

  /**
   * Share of this stud's prescribed release that leaves as pyrolysis.
   * The step records it before the layer clears the limit. A caller that
   * has not stepped yet reads the limit directly.
   */
  private pyrolysisShare(id: string, meta: BurnRuntime): number {
    return meta.pyrolysis ?? pyrolysisFraction(this.burnPhi(id));
  }

  /** The oxygen limit on the stud nearest this point, for a jet or an arc. */
  private burnFractionNear(x: number, y: number, level: string): number {
    let best = 1;
    let bestD = 2;
    let found = false;
    for (const [id, stud] of this.studIndex) {
      if (levelOf(stud) !== level) continue;
      const d = Math.hypot(stud.simPos.x - x, stud.simPos.y - y);
      if (d > bestD) continue;
      bestD = d;
      best = this.burnFraction(id);
      found = true;
    }
    return found ? best : 1;
  }

  /**
   * Soot grams per second from each burning cell. The yield is the
   * well-ventilated figure, times the pyrolysis the φ ≤ 2 cap allows.
   * The release is the decayed one. A cell with no soot yield, a jet,
   * and an arc are absent.
   */
  burningSoot(): Array<{ id: string; sootGPerS: number }> {
    const sources: Array<{ id: string; sootGPerS: number }> = [];
    for (const fire of this.liveFires()) {
      const release =
        this.releaseKw(fire.cell, fire.meta) * this.pyrolysisShare(fire.id, fire.meta);
      const sootGPerS = sootProductionGPerS(fire.cell, release);
      if (sootGPerS > 0) sources.push({ id: fire.id, sootGPerS });
    }
    return sources;
  }

  /**
   * Grams per second each burning cell is putting into the smoke, and the
   * soot that splits them. Heating, burnt-out, a jet, and an arc are absent.
   * The mass is the pyrolysis the φ ≤ 2 cap allows. The yield still follows
   * the stud's equivalence ratio, so a richer room keeps the under-ventilated
   * yield on less fuel. The oxygen limit cuts the heat, not this mass. No
   * layer means the well-ventilated set and the full prescription. The
   * flashover latch does not choose it.
   */
  fumeSources(): Array<{
    id: string;
    pos: Vec2;
    level: string;
    gramsPerS: FumeGrams;
    sootGPerS: number;
  }> {
    const sources: Array<{
      id: string;
      pos: Vec2;
      level: string;
      gramsPerS: FumeGrams;
      sootGPerS: number;
    }> = [];
    for (const fire of this.liveFires()) {
      const release =
        this.releaseKw(fire.cell, fire.meta) * this.pyrolysisShare(fire.id, fire.meta);
      const gramsPerS = speciesProductionGPerS(fire.cell, release, this.burnPhi(fire.id));
      const sootGPerS = sootProductionGPerS(fire.cell, release);
      if (!fumesPresent(gramsPerS) || !(sootGPerS > 0)) continue;
      sources.push({
        id: fire.id,
        pos: { x: fire.stud.simPos.x, y: fire.stud.simPos.y },
        level: levelOf(fire.stud),
        gramsPerS,
        sootGPerS,
      });
    }
    return sources;
  }

  /**
   * Studs whose floor is wet. A head wets them only after it has opened,
   * and only where the spray can reach: same storey, inside the throw,
   * and not behind a solid wall.
   */
  wetStuds(walls: InteriorWall[]): Array<{ id: string; pos: Vec2; level: string }> {
    const wet: Array<{ id: string; pos: Vec2; level: string }> = [];
    for (const [id, stud] of this.studIndex) {
      if (!this.sprayed(stud, walls)) continue;
      wet.push({ id, pos: { x: stud.simPos.x, y: stud.simPos.y }, level: levelOf(stud) });
    }
    return wet;
  }

  /**
   * The stud a wet-chemical hood is mounted on, one entry per hood. Half a
   * stud (1.5 m) is the mount. The spray throw is wider and is not the
   * exhaust. A sprinkler is not a hood. `discharge` counts a hood only
   * while it is open. `appliances` counts every placed hood, because the
   * appliance under it is taken as on.
   */
  hoodColumns(when: HoodFanWhen = HOOD_FAN_WHEN): string[] {
    const ids: string[] = [];
    for (const head of this.suppressionRuntime.values()) {
      if (head.kind !== 'wet_chemical') continue;
      if (when === 'discharge' && !head.open) continue;
      let best: string | null = null;
      let bestD = 1.5;
      for (const [id, stud] of this.studIndex) {
        if (levelOf(stud) !== head.level) continue;
        const d = Math.hypot(stud.simPos.x - head.pos.x, stud.simPos.y - head.pos.y);
        if (d > bestD) continue;
        if (best != null && d === bestD && id > best) continue;
        bestD = d;
        best = id;
      }
      if (best != null) ids.push(best);
    }
    return ids;
  }

  isArcing(id: string): boolean {
    const arc = this.arcRuntime.get(id);
    return !!arc && arc.arcing && !arc.shutoff;
  }

  gasLineState(id: string): GasLineState | null {
    const line = this.gasRuntime.get(id);
    if (!line) return null;
    const heatKw = line.jetting && !line.shutoff ? GAS_JET_KW : 0;
    return {
      ruptured: line.ruptured,
      jetting: line.jetting,
      shutoff: line.shutoff,
      age: line.age,
      heatKw,
    };
  }

  /**
   * Open a gas line where the blast's incident overpressure reaches
   * GAS_RUPTURE_KPA. A line inside the fireball, or one that already has a
   * flame or an arcing fitting nearby, then burns as a jet at that point.
   * A rupture with no ignition source does nothing visible: no cloud and no
   * second blast. The same blast faults an appliance inside the fireball or
   * at ELECTRICAL_DAMAGE_KPA, and that fitting then arcs. `level` omitted
   * means every storey, matching igniteRadius.
   */
  applyBlast(
    origin: Vec2,
    fireballRadiusM: number,
    level: string | undefined,
    walls: InteriorWall[],
  ) {
    const spec = this.charge;
    if (!spec) return;
    for (const arc of this.arcRuntime.values()) {
      if (arc.shutoff || arc.damaged) continue;
      if (level && arc.level !== level) continue;
      const dist = Math.hypot(arc.pos.x - origin.x, arc.pos.y - origin.y);
      const inFireball = fireballRadiusM > 0 && dist <= fireballRadiusM + 1e-6;
      const faulted =
        inFireball || this.incidentKpa(origin, arc.pos, spec) >= ELECTRICAL_DAMAGE_KPA;
      if (!faulted) continue;
      arc.damaged = true;
      arc.arcing = true;
    }
    for (const line of this.gasRuntime.values()) {
      if (line.shutoff || line.ruptured) continue;
      if (level && line.level !== level) continue;
      const dist = Math.hypot(line.pos.x - origin.x, line.pos.y - origin.y);
      if (!(this.incidentKpa(origin, line.pos, spec) >= GAS_RUPTURE_KPA)) continue;
      line.ruptured = true;
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
      const dose = tig == null ? (state.dose ?? 0) : (state.dose ?? 0) + FIREBALL_PULSE_S / tig;
      state.dose = dose;
      if (dose >= 1 - 1e-6 && !this.sprayed(stud, this.sceneWalls)) this.catchFire(id);
      else if (dose > 0) {
        state.state = 'heating';
        state.approach = Math.min(1, dose);
      }
    }
  }

  step(dt: number, walls: InteriorWall[], _hazards: HazardZone[]) {
    if (dt <= 0) return;
    this.sceneWalls = walls;
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

    this.refreshJets(walls);
    const live = this.liveFires();
    this.integrateSuppression(dt, walls, live);

    for (const fire of live) {
      const { id, stud, cell, meta } = fire;
      const fState = this.states.get(id);
      if (!fState || fState.state !== 'burning') continue;
      meta.age += dt;
      // Age still walks the prescribed curve, so the αt² demand and the
      // flame-front reach are not slowed. Above φ = 2 the fuel ledger
      // spends the capped pyrolysis in kilojoules against the load. At
      // φ ≤ 2 that integral is the free-burn clock, which stays the timer.
      const pyro = pyrolysisFraction(this.burnPhi(id));
      meta.pyrolysis = pyro;
      const heatKw = this.releaseKw(cell, meta) * this.burnFraction(id);
      const bare = heatReleaseKw(cell, meta.age);
      fState.output = bare > 0 ? Math.min(1, heatKw / bare) : 1;
      const room = this.compartmentOf.get(id);
      if (room) roomHeat.set(room, (roomHeat.get(room) ?? 0) + heatKw);
      if (meta.fuelKj != null) {
        const spent =
          meta.qAct != null
            ? this.releaseKw(cell, meta) * pyro * dt
            : releaseEnergyKj(cell, meta.age - dt, meta.age) * pyro;
        meta.fuelKj -= spent;
      }
      fState.timer -= dt * pyro;
      fState.approach = 1;
      // Above φ = 2 the ledger ends the stud. The schedule seconds run
      // long on the αt² rise, so they do not. φ ≤ 2 keeps the free-burn clock.
      const fuelKj = meta.fuelKj;
      const onLedger = pyro < 1 && fuelKj != null;
      if ((onLedger ? fuelKj <= 0 : fState.timer <= 0)) {
        fState.state = 'burnt_out';
        fState.timer = 0;
        fState.approach = 0;
        fState.output = 0;
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
        const dist = Math.hypot(
          dest.simPos.x - src.stud.simPos.x,
          dest.simPos.y - src.stud.simPos.y,
        );
        if (!(dist > 0) || dist > FRONT_LINK_M) continue;
        if (!this.crossingOpen(src.stud, dest, walls, dt)) continue;
        const slot = slotFor(nId);
        slot.flux += pointSourceFluxKwM2(src.heatKw, Math.max(dist, FLAME_STANDOFF_M));
        const along = src.reachM / dist;
        if (along > slot.approach) slot.approach = along;
      }
    }

    for (const line of this.gasRuntime.values()) {
      const closedAt = line.closedAt;
      line.closedAt = null;
      if (closedAt == null && (!line.jetting || line.shutoff)) continue;
      let seconds = dt;
      if (closedAt != null) {
        seconds = Math.min(dt, Math.max(0, closedAt));
        line.age += seconds;
      } else if (line.autoShutoffSec != null) {
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
      const jetKw = GAS_JET_KW * this.burnFractionNear(line.pos.x, line.pos.y, line.level);
      this.addSourceFlux(line.pos, line.level, jetKw, walls, seconds, dt, slotFor);
    }
    const arcKw = electricalHeatReleaseKw();
    for (const arc of this.arcRuntime.values()) {
      if (!arc.arcing || arc.shutoff) continue;
      const room = Math.max(0, ELECTRICAL_ARC_SEC - arc.age);
      const seconds = Math.min(dt, room);
      arc.age += seconds;
      if (arc.age + 1e-9 >= ELECTRICAL_ARC_SEC) arc.arcing = false;
      if (!(seconds > 0)) continue;
      const limitedArc = arcKw * this.burnFractionNear(arc.pos.x, arc.pos.y, arc.level);
      this.addSourceFlux(arc.pos, arc.level, limitedArc, walls, seconds, dt, slotFor);
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
      const cover = this.coverFrom.get(id);
      if (cover != null && cover <= 1e-9) {
        if ((fState.dose ?? 0) > 0) {
          fState.state = 'heating';
          fState.approach = Math.min(1, fState.dose ?? 0);
        }
        continue;
      }
      const window = cover != null ? Math.min(dt, cover) : dt;
      const dose = this.accrueDose(fState.dose ?? 0, cell, slot, window);
      fState.dose = dose;
      if (dose >= 1 || (cover == null && slot.approach >= 1)) {
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
      if (this.coverFrom.has(pair.upper)) continue;
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
    for (const source of this.arcRuntime.values()) {
      if (!source.arcing || source.shutoff) continue;
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

  private liveFires(): Array<{ id: string; stud: FireSimStud; cell: FuelCell; meta: BurnRuntime }> {
    const fires: Array<{ id: string; stud: FireSimStud; cell: FuelCell; meta: BurnRuntime }> = [];
    for (const [id, state] of this.states) {
      if (state.state !== 'burning') continue;
      const stud = this.studIndex.get(id);
      if (!stud) continue;
      const cell = this.burningCell(id);
      let meta = this.burn.get(id);
      if (!meta) {
        meta = this.freshBurn(cell);
        this.burn.set(id, meta);
      }
      fires.push({ id, stud, cell, meta });
    }
    return fires;
  }

  /** Suppressed release when a spray has reached this fuel, otherwise α t². */
  private releaseKw(cell: FuelCell, meta: BurnRuntime): number {
    if (meta.qAct != null) return suppressedHeatKw(meta.qAct, meta.suppressAge);
    return heatReleaseKw(cell, meta.age);
  }

  /**
   * Warm every link on the 0.1 s grid and open it when the RTI equation says
   * so. Solid fuel the spray can reach keeps Q(t_act) from the first head.
   * A second head does not start a second decay. A water sprinkler does not
   * decay a liquid pool. A gas jet is never decayed. A wet-chemical head
   * that opens shuts off the gas and power inside its throw.
   */
  private integrateSuppression(
    dt: number,
    walls: InteriorWall[],
    fires: Array<{ id: string; stud: FireSimStud; cell: FuelCell; meta: BurnRuntime }>,
  ) {
    this.coverFrom.clear();
    const heldFuel = new Set<string>();
    for (const fire of fires) {
      if (fire.meta.qAct != null) heldFuel.add(fire.id);
    }
    const openedFuel = new Map<string, number>();
    const openedHead = new Map<string, number>();

    for (const head of this.suppressionRuntime.values()) {
      if (!head.open) continue;
      this.markCover(head, walls, 0);
      this.snapshotReached(head, fires, 0, walls, heldFuel, openedFuel);
      this.applyInterlock(head, walls, 0);
    }

    let cursor = 0;
    while (cursor < dt - 1e-12) {
      const slice = Math.min(LINK_QUANTUM_S, dt - cursor);
      const plumes = this.plumesAt(fires, cursor, openedFuel);
      for (const head of this.suppressionRuntime.values()) {
        if (head.open) continue;
        const jet = this.strongestCeiling(head, plumes, walls);
        if (!jet || !(jet.speedMps > 0)) continue;
        const gasC = SPRINKLER_AMBIENT_C + jet.riseK;
        const step = advanceSprinklerLink(
          head.linkC,
          gasC,
          jet.speedMps,
          head.rti,
          slice,
          head.actC,
        );
        head.linkC = step.linkC;
        if (step.openedAt != null) {
          const tOpen = cursor + step.openedAt;
          head.open = true;
          openedHead.set(head.id, tOpen);
          this.markCover(head, walls, tOpen);
          this.snapshotReached(head, fires, tOpen, walls, heldFuel, openedFuel);
          this.applyInterlock(head, walls, tOpen);
        }
      }
      cursor += slice;
    }

    for (const fire of fires) {
      const tOpen = openedFuel.get(fire.id);
      if (tOpen != null) fire.meta.suppressAge = Math.max(0, dt - tOpen);
      else if (fire.meta.qAct != null) fire.meta.suppressAge += dt;
    }
    for (const head of this.suppressionRuntime.values()) {
      const tOpen = openedHead.get(head.id);
      if (tOpen != null) head.age = Math.max(0, dt - tOpen);
      else if (head.open) head.age += dt;
    }
  }

  private plumesAt(
    fires: Array<{ id: string; stud: FireSimStud; cell: FuelCell; meta: BurnRuntime }>,
    cursor: number,
    openedFuel: Map<string, number>,
  ): Array<{ pos: Vec2; level: string; heatKw: number }> {
    const plumes: Array<{ pos: Vec2; level: string; heatKw: number }> = [];
    for (const fire of fires) {
      const tOpen = openedFuel.get(fire.id);
      let heat = 0;
      if (fire.meta.qAct != null && tOpen == null) {
        heat = suppressedHeatKw(fire.meta.qAct, fire.meta.suppressAge + cursor);
      } else if (tOpen != null && cursor + 1e-9 >= tOpen) {
        heat = suppressedHeatKw(fire.meta.qAct ?? 0, Math.max(0, cursor - tOpen));
      } else {
        heat = heatReleaseKw(fire.cell, fire.meta.age + cursor);
      }
      if (heat > 0) plumes.push({ pos: fire.stud.simPos, level: levelOf(fire.stud), heatKw: heat });
    }
    for (const line of this.gasRuntime.values()) {
      if (!line.jetting || line.shutoff) continue;
      plumes.push({ pos: line.pos, level: line.level, heatKw: GAS_JET_KW });
    }
    return plumes;
  }

  /** The hottest ceiling jet at this head. Fires are not added together. */
  private strongestCeiling(
    head: SuppressionRuntime,
    plumes: Array<{ pos: Vec2; level: string; heatKw: number }>,
    walls: InteriorWall[],
  ): { riseK: number; speedMps: number } | null {
    let best: { riseK: number; speedMps: number } | null = null;
    for (const plume of plumes) {
      if (plume.level !== head.level) continue;
      if (this.lineBlocked(plume.pos, head.pos, head.level, walls)) continue;
      const dist = Math.hypot(plume.pos.x - head.pos.x, plume.pos.y - head.pos.y);
      const jet = ceilingJet(plume.heatKw, head.ceilingM, dist);
      if (!best || jet.riseK > best.riseK) best = jet;
    }
    return best;
  }

  private markCover(head: SuppressionRuntime, walls: InteriorWall[], tOpen: number) {
    for (const [id, stud] of this.studIndex) {
      if (!this.headReaches(head, stud.simPos, levelOf(stud), walls)) continue;
      const prev = this.coverFrom.get(id);
      if (prev == null || tOpen < prev) this.coverFrom.set(id, tOpen);
    }
  }

  /**
   * Freeze Q(t_act) for solid fuel this head can wet, and for cooking oil
   * under wet chemical. A water sprinkler leaves a liquid pool on its own
   * curve. The earliest open wins. Fuel that was already decaying stays on
   * its first snapshot. A gas jet is not snapshotted: it stays at the
   * supply rate until a valve or the wet-chemical interlock closes it.
   */
  private snapshotReached(
    head: SuppressionRuntime,
    fires: Array<{ id: string; stud: FireSimStud; cell: FuelCell; meta: BurnRuntime }>,
    tOpen: number,
    walls: InteriorWall[],
    heldFuel: Set<string>,
    openedFuel: Map<string, number>,
  ) {
    for (const fire of fires) {
      if (heldFuel.has(fire.id)) continue;
      if (head.kind === 'sprinkler' && fire.cell.liquidPool) continue;
      if (!this.headReaches(head, fire.stud.simPos, levelOf(fire.stud), walls)) continue;
      const prev = openedFuel.get(fire.id);
      if (prev != null && prev <= tOpen + 1e-9) continue;
      openedFuel.set(fire.id, tOpen);
      fire.meta.qAct = heatReleaseKw(fire.cell, fire.meta.age + tOpen);
    }
  }

  /**
   * NFPA 17A and NFPA 96: a wet-chemical discharge shuts off fuel and power
   * to the equipment it protects. The protected set is whatever this head's
   * throw reaches. A sprinkler does not. A jet that was burning keeps heating
   * until `tOpen`, then the valve is shut.
   */
  private applyInterlock(head: SuppressionRuntime, walls: InteriorWall[], tOpen: number) {
    if (head.kind !== 'wet_chemical') return;
    for (const line of this.gasRuntime.values()) {
      if (line.shutoff) continue;
      if (!this.headReaches(head, line.pos, line.level, walls)) continue;
      if (line.jetting && (line.closedAt == null || tOpen < line.closedAt)) line.closedAt = tOpen;
      line.shutoff = true;
      line.jetting = false;
    }
    for (const arc of this.arcRuntime.values()) {
      if (arc.shutoff) continue;
      if (!this.headReaches(head, arc.pos, arc.level, walls)) continue;
      arc.shutoff = true;
      arc.arcing = false;
    }
  }

  private headReaches(
    head: SuppressionRuntime,
    pos: Vec2,
    level: string,
    walls: InteriorWall[],
  ): boolean {
    if (level !== head.level) return false;
    const dist = Math.hypot(pos.x - head.pos.x, pos.y - head.pos.y);
    if (dist > SUPPRESSION_REACH_M + 1e-6) return false;
    return !this.lineBlocked(head.pos, pos, head.level, walls);
  }

  private sprayed(stud: FireSimStud, walls: InteriorWall[]): boolean {
    const level = levelOf(stud);
    for (const head of this.suppressionRuntime.values()) {
      if (!head.open) continue;
      if (this.headReaches(head, stud.simPos, level, walls)) return true;
    }
    return false;
  }

  /** Side-on overpressure. The Clancey table is incident, not reflected. */
  private incidentKpa(origin: Vec2, pos: Vec2, spec: ChargeSpec): number {
    const height = spec.burst === 'surface' ? 0 : spec.heightM;
    const range = Math.hypot(pos.x - origin.x, pos.y - origin.y, height);
    return blastPressureAt(spec, range, false).psKpa;
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
          if (!dest || dest.spatialContext !== 'inside_building' || levelOf(dest) !== level)
            continue;
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
   * The engine's own membership map. The layer step only reads it.
   * `compartmentIds` copies, for callers that keep the map.
   */
  compartmentsOf(walls: InteriorWall[]): ReadonlyMap<string, string> {
    this.ensureCompartments(walls);
    return this.compartmentOf;
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
          if (this.acceptsFuel(id) && !this.coverFrom.has(id)) this.catchFire(id);
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
