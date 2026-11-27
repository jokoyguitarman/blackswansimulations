import type { ExitDef, Vec2 } from '../evacuation/types';
import { doorOpenFraction, leafWidthM } from './doorLeaf';
import type { InteriorWall, HazardZone } from './types';
import {
  FireSimulation,
  type FireSimStud,
  type FireStudState,
  type FireParams,
  type GasJet,
} from './fireSimulation';
import { GAS_JET_KW, STUD_AREA_M2, electricalHeatReleaseKw, type FuelCell } from './flameFront';
import {
  AMBIENT_K,
  blackLayerRadiantKwM2,
  CEILING_JET_DEPTH_FRACTION,
  DOOR_SOFFIT_M,
  DISTINCT_LAYER_RISE_K,
  HEAD_HEIGHT_M,
  HOOD_EXTRACT_M3_PER_S,
  HOOD_FAN_WHEN,
  HOOD_INTAKE_M,
  LAYER_OFF_FRACTION,
  MIN_LAYER_FIRE_KW,
  diameterForReleaseKw,
  enclosureFromGrid,
  heskestadFlameHeightM,
  type FacadeOpening,
  formsSustainedLayer,
  freshLayer,
  hasSmokeReservoir,
  coolUnclaimedSheet,
  isothermalSheet,
  withRememberedSheets,
  O2_AMBIENT_MASS,
  oxygenLimitedBurn,
  oxygenMassFraction,
  spillOriginM,
  steadyLayer,
  stepZone,
  type Boundary,
  type Lining,
  type DoorJetInflow,
  type Enclosure,
  type FirePlume,
  type GridStud,
  type MechanicalVent,
  type GridWall,
  type HoodFanWhen,
  type LayerSpec,
  type Vent,
  type VentOutside,
  type ZoneState,
} from './twoZone';
import type { ChargeSpec } from './blast/blastModel';
import type {
  ElectricalPlacement,
  GasLinePlacement,
  SuppressionPlacement,
} from './materialLibrary';
import {
  GLASS_LAYER_COVER,
  advanceTimberFace,
  charRateMPerS,
  distanceToSegmentM,
  freshTimberFace,
  fuelScale,
  liningBurnAreaM2,
  liningKind,
  linkCrossesWall,
  stepGlassPane,
  timberRelease,
  wallPointFluxKwM2,
  type TimberFace,
} from './liningFire';
import { layerLiningFor } from './materialLibrary';
import { LEVEL } from '../evacuation/levelConstants';
import { levelOf, neighborIdsByLevel, shaftPairs, type ShaftLink, type ShaftPair } from './levels';
import {
  doorHeadInUpper,
  moveUpperGas,
  nextShaftK,
  shaftColumnMassKg,
  shaftDensityKgM3,
  shaftEquivalentWidthM,
  shaftOpeningM,
  shaftStackPa,
  type UpperGas,
} from './shaftVent';
import {
  addFumeGrams,
  fumesFromExtinction,
  fumesPresent,
  layerBreath,
  SOOT_EXTINCTION_M2_PER_G,
  type FumeGrams,
} from './toxicDose';
import { extinctionK, smokeFromK } from '../evacuation/hazardSensing';

// ── Effect types ─────────────────────────────────────────────────────────

export type EffectType = 'fire' | 'gas' | 'flood' | 'structural_zone';

export type SmokeGeneration = 'none' | 'light' | 'moderate' | 'heavy' | 'toxic';

export interface HazardEvent {
  triggerTimeSec: number;
  eventType: 'ignite' | 'rupture' | 'collapse' | 'flood' | 'arc' | 'explode';
  spreadType: EffectType | null;
  spreadRadius: number;
  spreadRate: number;
  description: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  smokeGeneration?: SmokeGeneration;
  smokeDescription?: string;
  affectedStuds?: string[];
}

export interface HazardStateProgression {
  initial: string;
  triggered: string;
  worsening: string;
  critical: string;
}

// ── Stud effect state (multi-layer) ──────────────────────────────────────

export interface StudEffectState {
  fire: FireStudState;
  gas: number;
  flood: number;
  structural: number;
  smoke: number;
  /** True once an open spray can reach this stud. */
  wet?: boolean;
  /**
   * ppm of the gases whose smoke has reached this stud. Absent is clean air.
   * It follows what is burning now, scaled by the smoke already stored here.
   */
  fumes?: FumeGrams;
  /** Oxygen the head breathes, volume percent. Absent is ambient. */
  oxygenVolumePercent?: number;
  /** Carbon dioxide the head breathes, volume percent. Absent is none. */
  co2VolumePercent?: number;
  /**
   * Gas temperature at the head, °C. Set when the interface is at or below
   * head height. Absent means the head is in the lower layer, at ambient.
   */
  headTempC?: number;
  /**
   * Incident flux from the room's black upper layer, kW/m². Absent means
   * this stud is not under that layer.
   */
  radiantKwM2?: number;
}

/** One room's upper smoke layer, as `smokeLayers()` reports it. */
export interface SmokeLayerView {
  room: string;
  /** Stud ids in the room. Shared with the engine, so do not mutate. */
  members: readonly string[];
  ceilingM: number;
  interfaceM: number;
  depthM: number;
  /** Soot extinction of the upper layer, 1/m. */
  extinctionK: number;
  upperK: number;
}

// ── Spatial effect instance ──────────────────────────────────────────────

interface ActiveEffect {
  id: string;
  type: EffectType;
  originPos: Vec2;
  startTime: number;
  spreadRadius: number;
  spreadRate: number;
  currentRadius: number;
}

// ── Hazard runtime state machine ─────────────────────────────────────────

export type HazardPhase = 'stable' | 'triggered' | 'worsening' | 'critical' | 'resolved';

export interface HazardRuntimeState {
  hazardId: string;
  phase: HazardPhase;
  phaseDescription: string;
  nextEventIdx: number;
  events: HazardEvent[];
  stateDescriptions: HazardStateProgression;
  activeEffectIds: string[];
  triggeredAt: number | null;
}

// ── Gas/Flood spread helpers ─────────────────────────────────────────────

const NEIGHBOR_RADIUS = 8;

/**
 * Building leakage as a first-order loss of the soot column, assumed, per
 * second. About 7 air changes an hour. It is the old indoor smoke decay
 * (0.002 per second) applied to soot mass. It is not fitted to a travel
 * time or a ppm target.
 */
export const SMOKE_LEAK_PER_S = 0.002;

/**
 * Open air loses soot at five times the indoor rate. The old outdoor rule
 * was the indoor decay plus four times that decay again.
 */
export const SMOKE_OUTDOOR_VENT_FACTOR = 5;

/**
 * Share of the extinction difference a neighbour takes per second, assumed.
 * The amount added to the neighbour is taken off the source.
 */
export const SMOKE_EXCHANGE_PER_S = 0.025;

/** Column spacing when a scene grid has only one row or column to measure. */
const SCENE_LATTICE_M = 3;

function latticeStep(values: readonly number[]): number {
  const uniq = [...new Set(values.map((value) => Math.round(value * 1000) / 1000))].sort(
    (a, b) => a - b,
  );
  let step = SCENE_LATTICE_M;
  for (let i = 1; i < uniq.length; i++) {
    const gap = (uniq[i] ?? 0) - (uniq[i - 1] ?? 0);
    if (gap > 0.5 && gap < step) step = gap;
  }
  return step;
}

/** Solid wall, including the outside wall. A door or an exit uses the full exchange. Assumed. */
export const SMOKE_WALL_LEAK = 0.05;

/**
 * Exact step of dK/dt = generation − vent·K. The loss is first-order, so a
 * fixed slice and a longer frame cut into the same slices agree.
 */
export function advanceSootK(
  k: number,
  generationPerS: number,
  ventPerS: number,
  dt: number,
): number {
  if (!(dt > 0)) return Math.max(0, k);
  const gen = generationPerS > 0 ? generationPerS : 0;
  const vent = ventPerS > 0 ? ventPerS : 0;
  if (!(vent > 0)) return Math.max(0, k + gen * dt);
  const decay = Math.exp(-vent * dt);
  return Math.max(0, k * decay + (gen / vent) * (1 - decay));
}

/** Mass, kg·K, oxygen·kg and fuel·kg offered to one neighbouring room. cp is 1 kJ/kg·K. */
export interface DoorJetParcel {
  kg: number;
  tKg: number;
  yKg: number;
  /** Unburned pyrolysate, kilograms. Absent means none. */
  fKg?: number;
  /** kg times max(sill, source interface), so the mass-weighted origin is originKg / kg. */
  originKg?: number;
  /** kg times the vent width, so the mass-weighted width is widthKg / kg. */
  widthKg?: number;
  /** kg times the bottom of the hot outflow band. Absent mass is not in the band. */
  lowKg?: number;
  /** kg times the soffit of that band. */
  soffitKg?: number;
  /** Kilograms that carried a band. The jet keeps the band only when this is the whole mass. */
  bandKg?: number;
}

/**
 * One room's upper-layer outflow, copied when a test is watching the door.
 * Play leaves this unset, so the step does not copy the vents.
 */
export interface DoorJetBook {
  room: string;
  members: readonly string[];
  receivers: readonly (readonly string[])[];
  hot: readonly { kg: number; tempK: number; oxygenY: number; fuelY?: number }[];
  /** Last substep's orifice inflow and outflow, kg/s. Set when a test is watching. */
  inKgS?: number;
  outKgS?: number;
}

/**
 * A vent flow smaller than this is numerical dust, not a door jet. The
 * queue and the conservation test use the same cutoff.
 */
export const DOOR_JET_MIN_KGS = 1e-4;

/**
 * Split one room's upper-layer outflow across the rooms on the far side of
 * each vent. The share is the fraction of that vent's receiver studs in the
 * destination. A receiver with no room is outdoors, and a receiver in the
 * source room is not a neighbour, so that share is not in the sum. The
 * enthalpy of what is assigned is the assigned mass times the vent temperature.
 */
export function assignDoorJet(
  room: string,
  members: ReadonlySet<string>,
  ventReceivers: readonly (readonly string[])[],
  hotByVent: readonly {
    kg: number;
    tempK: number;
    oxygenY: number;
    fuelY?: number;
    originM?: number;
    widthM?: number;
    lowEdgeM?: number;
    soffitM?: number;
  }[],
  rooms: ReadonlyMap<string, string>,
): Map<string, DoorJetParcel> {
  const out = new Map<string, DoorJetParcel>();
  for (let i = 0; i < hotByVent.length; i++) {
    const hot = hotByVent[i];
    const receivers = ventReceivers[i] ?? [];
    if (!hot || !(hot.kg > 1e-8) || !(hot.tempK > AMBIENT_K + 1) || receivers.length === 0) {
      continue;
    }
    const buckets = new Map<string, number>();
    for (const id of receivers) {
      if (members.has(id)) continue;
      const dest = rooms.get(id);
      if (!dest || dest === room) continue;
      buckets.set(dest, (buckets.get(dest) ?? 0) + 1);
    }
    if (buckets.size === 0) continue;
    for (const [dest, count] of buckets) {
      const kg = hot.kg * (count / receivers.length);
      const cur = out.get(dest) ?? { kg: 0, tKg: 0, yKg: 0, fKg: 0, originKg: 0, widthKg: 0 };
      cur.kg += kg;
      cur.tKg += kg * hot.tempK;
      cur.yKg += kg * hot.oxygenY;
      cur.fKg = (cur.fKg ?? 0) + kg * (hot.fuelY ?? 0);
      cur.originKg = (cur.originKg ?? 0) + kg * (hot.originM ?? 0);
      cur.widthKg = (cur.widthKg ?? 0) + kg * (hot.widthM ?? 0);
      if (hot.lowEdgeM != null && hot.soffitM != null && hot.soffitM > hot.lowEdgeM) {
        cur.lowKg = (cur.lowKg ?? 0) + kg * hot.lowEdgeM;
        cur.soffitKg = (cur.soffitKg ?? 0) + kg * hot.soffitM;
        cur.bandKg = (cur.bandKg ?? 0) + kg;
      }
      out.set(dest, cur);
    }
  }
  return out;
}

/**
 * The layer on the far side of a vent, for CFAST Eq. 4.1. A receiver with
 * no room is outdoors, and so is a vent that does not open into another
 * compartment. The gauge is that neighbour's layer from the previous step.
 * The room with the most receivers owns a vent that touches two rooms.
 */
export function neighbourVentOutside(
  receivers: readonly string[],
  room: string,
  members: ReadonlySet<string>,
  rooms: ReadonlyMap<string, string>,
  gauges: ReadonlyMap<string, VentOutside>,
): VentOutside | undefined {
  const counts = new Map<string, number>();
  for (const id of receivers) {
    if (members.has(id)) continue;
    const dest = rooms.get(id);
    if (!dest || dest === room) continue;
    counts.set(dest, (counts.get(dest) ?? 0) + 1);
  }
  let best = '';
  let bestCount = 0;
  for (const [dest, count] of counts) {
    if (count > bestCount) {
      best = dest;
      bestCount = count;
    }
  }
  return best ? gauges.get(best) : undefined;
}

/** The parcels the next step passes into `stepZone`, after the dust filter. */
export function queueDoorJets(
  parcels: ReadonlyMap<string, DoorJetParcel>,
  dt: number,
): Map<string, DoorJetInflow> {
  const ready = new Map<string, DoorJetInflow>();
  if (!(dt > 0)) return ready;
  for (const [dest, cur] of parcels) {
    if (!(cur.kg > 0)) continue;
    const kgS = cur.kg / dt;
    const tempK = cur.tKg / cur.kg;
    if (!(kgS >= DOOR_JET_MIN_KGS) || !(tempK > AMBIENT_K + 1)) continue;
    const inflow: DoorJetInflow = {
      kgS,
      tempK,
      oxygenY: cur.yKg / cur.kg,
      fuelY: (cur.fKg ?? 0) / cur.kg,
      // CFAST entrains each vent on its own width, w^(2/3). Vents that
      // land in one room are one jet here, so the width is the
      // mass-weighted mean. One vent, the usual door, is unchanged.
      originM: (cur.originKg ?? 0) / cur.kg,
      widthM: (cur.widthKg ?? 0) / cur.kg,
    };
    // A vent with no band would make the average look like a shorter
    // door. The whole mass has to carry one, or the jet entrains in full.
    const bandKg = cur.bandKg ?? 0;
    if (bandKg > 0 && bandKg >= cur.kg * 0.999 && (cur.soffitKg ?? 0) > (cur.lowKg ?? 0)) {
      inflow.lowEdgeM = (cur.lowKg ?? 0) / bandKg;
      inflow.soffitM = (cur.soffitKg ?? 0) / bandKg;
    }
    ready.set(dest, inflow);
  }
  return ready;
}

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

/** The cut an exit makes in one edge of the outline. A blocked exit is a wall. */
interface ShellOpening {
  key: string;
  a: Vec2;
  b: Vec2;
  level: string;
  widthM: number;
}

/**
 * Exit gaps on the outline. The same edge cut the evacuation walls leave
 * open. An exit with no edge is not a gap. Assumed: the facade is closed
 * everywhere else, and a blocked exit is closed.
 */
function shellOpenings(vertices: readonly Vec2[], exits: readonly ExitDef[]): ShellOpening[] {
  const openings: ShellOpening[] = [];
  const n = vertices.length;
  if (n < 2) return openings;
  for (const exit of exits) {
    if (exit.status === 'blocked') continue;
    if (!(exit.width > 0)) continue;
    if (exit.edgeIndex < 0 || exit.edgeIndex >= n) continue;
    const start = vertices[exit.edgeIndex];
    const end = vertices[(exit.edgeIndex + 1) % n];
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const len = Math.hypot(dx, dy);
    if (len < 0.01) continue;
    const half = exit.width / 2;
    const tCenter = ((exit.center.x - start.x) * dx + (exit.center.y - start.y) * dy) / (len * len);
    // A stud row just off the doorway still crosses it. 0.75 m is assumed:
    // enough for a row 0.5 m outside a 2 m door, and short of the next row.
    // The vent width stays the exit's width. The pad is only the hit test.
    const pad = (half + 0.75) / len;
    const t0 = Math.max(0, tCenter - pad);
    const t1 = Math.min(1, tCenter + pad);
    if (!(t1 > t0)) continue;
    openings.push({
      key: exit.id,
      a: { x: start.x + dx * t0, y: start.y + dy * t0 },
      b: { x: start.x + dx * t1, y: start.y + dy * t1 },
      level: exit.level ?? 'G',
      widthM: exit.width,
    });
  }
  return openings;
}

function shellSignature(vertices: readonly Vec2[], exits: readonly ExitDef[]): string {
  let key = String(vertices.length);
  for (const vertex of vertices) key += `|${vertex.x},${vertex.y}`;
  for (const exit of exits) {
    key += `|${exit.id},${exit.status},${exit.edgeIndex},${exit.width},${exit.center.x},${exit.center.y},${exit.level ?? ''}`;
  }
  return key;
}

function wallBlocksPath(from: Vec2, to: Vec2, wall: InteriorWall): boolean {
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
    const sA = { x: wall.start.x + dx * gapStart, y: wall.start.y + dy * gapStart };
    const sB = { x: wall.start.x + dx * gapEnd, y: wall.start.y + dy * gapEnd };
    return segmentsIntersect(from, to, wall.start, sA) || segmentsIntersect(from, to, sB, wall.end);
  }
  return segmentsIntersect(from, to, wall.start, wall.end);
}

function isWallBlocked(from: Vec2, to: Vec2, walls: InteriorWall[], level?: string): boolean {
  for (const w of walls) {
    if (level && levelOf(w) !== level) continue;
    if (wallBlocksPath(from, to, w)) return true;
  }
  return false;
}

function isWallBlockedIgnoringDoors(from: Vec2, to: Vec2, walls: InteriorWall[]): boolean {
  for (const w of walls) {
    if (segmentsIntersect(from, to, w.start, w.end)) return true;
  }
  return false;
}

/**
 * Studs a blast may keep feeding smoke. A null fuel set is the old rule
 * (every affected stud). A set, even an empty one, keeps only fuel studs,
 * so open tile gets the fireball and then nothing more from the blast.
 */
export function blastSmokeStudIds(
  studIds: readonly string[],
  fuel: ReadonlySet<string> | null,
): string[] {
  if (fuel == null) return [...studIds];
  return studIds.filter((id) => fuel.has(id));
}

// ── Main engine ──────────────────────────────────────────────────────────

/** One shaft orifice a pressure root solved this step. */
interface ShaftMove {
  key: string;
  pair: ShaftPair;
  /** Stud the gas leaves, and the stud it is heading for. */
  sourceId: string;
  destId: string;
  toRoom: string;
  /** The other storey already had a layer when the gauges were taken. */
  otherActive: boolean;
  ventIndex: number;
  outKg: number;
  hotKg: number;
  hotT: number;
  hotY: number;
  hotF: number;
  sootG: number;
  lowerK: number;
}

export class SpatialEffectsEngine {
  studStates: Map<string, StudEffectState> = new Map();
  hazardStates: Map<string, HazardRuntimeState> = new Map();
  activeEffects: ActiveEffect[] = [];
  elapsed = 0;
  /**
   * Sim seconds per game second. Fire growth, the front, ignition time,
   * smoke and gas are all in physical seconds, so this is 1. It used to be
   * 0.5, which ran that whole clock at half the showcase time.
   */
  timeScale = 1;

  private studIndex: Map<string, FireSimStud> = new Map();
  private neighborCache: Map<string, string[]> = new Map();
  /** Studs in insertion order, so a smoke walk can read neighbours by slot. */
  private smokeSlots: string[] = [];
  private smokeSlotOf = new Map<string, number>();
  private smokeNeigh: number[][] = [];
  /** Missing outdoor-lattice neighbours. Each one is open air, not a wall. */
  private smokeOpen = new Uint8Array(0);
  /** 1 when that neighbour link is a wall or the shell. Invalidated with the leaves. */
  private smokeBlock: Array<Uint8Array | null> = [];
  private smokeBlockKey = '';
  private smokeBlockWalls: InteriorWall[] | null = null;
  private kScratch = new Float64Array(0);
  /** Reused so the init-order sort does not allocate on the burning slices. */
  private smokeEmit: number[] = [];
  private sumScratch = new Float64Array(0);
  private scaleScratch = new Float64Array(0);
  private seenScratch = new Uint8Array(0);
  private wasInField = new Uint8Array(0);
  private usedSlots: number[] = [];
  private moveFrom: string[] = [];
  private moveTo: string[] = [];
  private moveFromSlot: number[] = [];
  private moveToSlot: number[] = [];
  private moveK: number[] = [];
  private verticalPairs: ShaftPair[] = [];
  /** Shaft column temperature, kelvin, keyed by link and the two rooms. */
  private shaftK = new Map<string, number>();
  /**
   * Upper-layer gas a shaft has delivered to a storey that has no layer
   * yet. It becomes a layer once the depth and the rise say so.
   */
  private shaftHold = new Map<
    string,
    { massKg: number; enthalpy: number; sootG: number; fuelKg: number; o2Kg: number }
  >();
  /** Landing studs the shaft has carried gas between. Fumes follow. */
  private shaftFumeTo = new Map<string, Set<string>>();
  /**
   * Kilograms the pressure roots have booked since init: each room's
   * (in − out − fans), plus a shaft outflow parked in `shaftHold` when the
   * other storey has no layer yet. The hold is that outflow's destination.
   */
  ventNetKg = 0;
  /**
   * Kilograms exchanged with the outside since init: every vent that is
   * not a shaft, minus the fans, plus ambient air booked when a shaft
   * parcel takes its place. The hold is mass still in the building.
   */
  shellNetKg = 0;
  /** Last preview's shaft net, kg/s into the room, by room and link. */
  private previewNets: { room: string; key: string; netKgS: number }[] = [];
  /** Agreed shaft net for the real solve, kg/s into the room. */
  private imposedShaft = new Map<string, number>();
  /** The real solve books the agreed flow. A preview still uses the orifice. */
  private useImposedShaft = false;
  /** Shaft vents opened during the step that is running, filled in after each pressure root. */
  private shaftMoves: ShaftMove[] = [];
  private fireSim: FireSimulation;
  /**
   * When a hood fan runs. Discharge-only until a scene says otherwise.
   * That default is an assumption. See HOOD_FAN_WHEN.
   */
  private hoodFanWhen: HoodFanWhen = HOOD_FAN_WHEN;
  /** Null keeps blast smoke on every affected stud. A set limits that source to fuel. */
  private fuelGate: Set<string> | null = null;
  /** Extinction from burning soot, kept apart from blast-event smoke. */
  private sootK = new Map<string, number>();
  /** Wall tests for one walls array. Rebuilt when a leaf moves, not on every query. */
  private blockedWalls: InteriorWall[] | null = null;
  private blockedGen = -1;
  private blockedNeighbors = new Map<string, Set<string>>();
  /** Open fraction of each wall the last time the leaf generation moved. */
  private leafWalls: InteriorWall[] | null = null;
  private leafOpen: Array<number | null> = [];
  private leafFlags: number[] = [];
  private leafIds: string[] = [];
  private leafGen = 0;
  /** Studs whose smoke or soot was non-zero after the previous slice. */
  private liveSmoke: string[] = [];
  /** Studs that carried a layer breath fraction, so the next slice can clear it. */
  private breathIds: string[] = [];
  /** Studs that received a fume split, so the next slice can clear it. */
  private fumeIds: string[] = [];
  /** Outside wall. Indoor–outdoor links are blocked unless they cross an exit. */
  private shellKey = '';
  private shellGaps: ShellOpening[] = [];
  private shellReady = false;
  private shellBlocked = new Map<string, Set<string>>();
  /** Saved storey height, metres. A missing level keeps the default. */
  private storeyHeights = new Map<string, number>();
  /** Stud positions for the layer enclosure. Built with the stud index. */
  private gridStuds = new Map<string, GridStud>();
  private layerState = new Map<
    string,
    { active: boolean; zone: ZoneState; members: string[]; areaM2: number; ceilingM: number }
  >();
  private layerWalls: InteriorWall[] | null = null;
  private layerHeightKey = '';
  private layerEnclosures = new Map<string, Enclosure | null>();
  /** Open fractions the cached enclosure was built with, for the walls it hits. */
  private layerDoorSnap = new Map<string, Array<{ id: string; open: number | null }>>();
  private layerShellKey = '';
  private layerGridWalls: GridWall[] = [];
  private layerGrants: Array<{ receivers: string[]; grams: number }> = [];
  /**
   * Door jet arriving this step, from the previous step's upper-layer
   * outflow. One step behind, so room order does not matter.
   */
  private doorJets = new Map<string, DoorJetInflow>();
  /**
   * Floor gauge of each active layer, Pa. The next step's neighbour doors
   * read it. This is the mean of the last two solved roots, not the raw
   * root: each room solves against the other's previous gauge, and
   * publishing the raw root runs a period-2 cycle once the interface is
   * on the floor.
   */
  private floorPressurePa = new Map<string, number>();
  /** The previous solved floor root, Pa. The published gauge averages it. */
  private floorPressurePrevPa = new Map<string, number>();
  /** The jet actually passed into `stepZone` this step, for rooms that take one. */
  private jetTaken = new Map<string, DoorJetInflow>();
  /**
   * Studs whose head-height soot a jet layer left in place. They keep
   * leaking after the room catches fire. A fire that forms its own layer
   * from a cold start is not in this set, and still clears the column.
   */
  private jetLowerStuds = new Set<string>();
  /** Set by the conservation test. Null in play. */
  private jetAudit: DoorJetBook[] | null = null;
  /** Door walls of a room that has flashed. The leaf clock reads this. */
  private exposedDoors = new Set<string>();
  /** Glass that has fallen out. A crack is not in this set, and it is not a vent. */
  private fallenGlass = new Set<string>();
  /**
   * Remaining-fuel mass, pane temperature, and the per-room timber face.
   * Keyed by wall id. One mass for the board, shared by both faces.
   */
  private linings = new Map<
    string,
    {
      burnedKg: number;
      paneK: number;
      cracked: boolean;
      fallen: boolean;
      faces: Map<string, TimberFace>;
    }
  >();
  /** Previous step's burned fraction, read before the layer clears the limit. */
  private liningFraction = new Map<string, number>();
  /** Equivalence ratio from the previous layer step. 0 is well ventilated. */
  private roomPhi = new Map<string, number>();
  /** Hottest touch on each glass wall during this step. */
  private glassTouch = new Map<
    string,
    { flame: number; gasK: number; hot: number; ceiling: number }
  >();
  /** Lining soot and gases, poured with the stud sources. */
  private liningFumes: Array<{ id: string; gramsPerS: FumeGrams; sootGPerS: number }> = [];
  private wallById = new Map<string, GridWall>();
  /** Timber and glass only. Empty in a building that has neither. */
  private liningWalls: GridWall[] = [];

  constructor(fireParams?: FireParams, timeScale = 1) {
    this.timeScale = timeScale;
    this.fireSim = new FireSimulation(fireParams);
  }

  init(studs: FireSimStud[]) {
    this.studIndex.clear();
    this.studStates.clear();
    this.neighborCache.clear();
    this.verticalPairs = [];
    this.shaftK.clear();
    this.shaftHold.clear();
    this.shaftFumeTo.clear();
    this.ventNetKg = 0;
    this.shellNetKg = 0;
    this.sootK.clear();
    this.blockedWalls = null;
    this.blockedGen = -1;
    this.blockedNeighbors.clear();
    this.leafWalls = null;
    this.leafOpen = [];
    this.leafFlags = [];
    this.leafIds = [];
    this.leafGen = 0;
    this.liveSmoke = [];
    this.breathIds = [];
    this.fumeIds = [];
    this.shellReady = false;
    this.shellBlocked.clear();
    this.gridStuds.clear();
    this.layerState.clear();
    this.layerEnclosures.clear();
    this.layerDoorSnap.clear();
    this.layerWalls = null;
    this.exposedDoors = new Set();
    this.layerGrants = [];
    this.doorJets = new Map();
    this.floorPressurePa.clear();
    this.floorPressurePrevPa.clear();
    this.jetTaken = new Map();
    this.jetLowerStuds = new Set();
    this.fallenGlass.clear();
    this.linings.clear();
    this.wallSheetK.clear();
    this.sheetLining.clear();
    this.claimedSheets.clear();
    this.droppedSheets.clear();
    this.liningFraction.clear();
    this.roomPhi.clear();
    this.glassTouch.clear();
    this.liningFumes = [];
    this.wallById.clear();
    this.liningWalls = [];
    this.activeEffects = [];
    this.elapsed = 0;

    for (const s of studs) {
      this.studIndex.set(s.id, s);
      this.gridStuds.set(s.id, { id: s.id, x: s.simPos.x, y: s.simPos.y, level: levelOf(s) });
      this.studStates.set(s.id, {
        fire: { state: 'none', timer: 0, fuelFactor: 1.0 },
        gas: 0,
        flood: 0,
        structural: 0,
        smoke: 0,
      });
    }

    const built = neighborIdsByLevel(studs, NEIGHBOR_RADIUS);
    for (const [id, neighbors] of built) this.neighborCache.set(id, neighbors);
    this.rebuildSmokeSlots();

    this.fireSim.init(studs);
  }

  /** Slot table for the smoke walk. Neighbour order matches `neighborCache`. */
  private rebuildSmokeSlots(): void {
    this.smokeSlots = [];
    this.smokeSlotOf.clear();
    for (const id of this.studIndex.keys()) {
      this.smokeSlotOf.set(id, this.smokeSlots.length);
      this.smokeSlots.push(id);
    }
    const n = this.smokeSlots.length;
    this.smokeNeigh = new Array(n);
    for (let i = 0; i < n; i++) {
      const id = this.smokeSlots[i] ?? '';
      const row: number[] = [];
      for (const nId of this.neighborCache.get(id) ?? []) {
        const slot = this.smokeSlotOf.get(nId);
        if (slot != null) row.push(slot);
      }
      this.smokeNeigh[i] = row;
    }
    this.smokeBlock = new Array(n).fill(null);
    this.smokeBlockKey = '';
    this.smokeBlockWalls = null;
    this.kScratch = new Float64Array(n);
    this.sumScratch = new Float64Array(n);
    this.scaleScratch = new Float64Array(n);
    this.seenScratch = new Uint8Array(n);
    this.wasInField = new Uint8Array(n);
    this.usedSlots = [];
    this.fillOpenAir();
  }

  /**
   * Studs placed after the field was built. Old studs keep their smoke and
   * their slot numbers; the new ones are appended.
   */
  extendStuds(studs: readonly FireSimStud[]): void {
    const fresh = studs.filter((stud) => !this.studIndex.has(stud.id));
    if (fresh.length === 0) return;
    for (const stud of fresh) {
      this.studIndex.set(stud.id, stud);
      this.gridStuds.set(stud.id, {
        id: stud.id,
        x: stud.simPos.x,
        y: stud.simPos.y,
        level: levelOf(stud),
      });
      this.studStates.set(stud.id, {
        fire: { state: 'none', timer: 0, fuelFactor: 1.0 },
        gas: 0,
        flood: 0,
        structural: 0,
        smoke: 0,
      });
    }
    this.neighborCache.clear();
    const built = neighborIdsByLevel([...this.studIndex.values()], NEIGHBOR_RADIUS);
    for (const [id, neighbors] of built) this.neighborCache.set(id, neighbors);
    this.rebuildSmokeSlots();
    this.fireSim.addStuds(fresh);
    this.shellReady = false;
    this.shellBlocked.clear();
    this.blockedWalls = null;
    this.blockedGen = -1;
    this.blockedNeighbors.clear();
    this.layerEnclosures.clear();
    this.layerDoorSnap.clear();
    this.layerWalls = null;
  }

  /**
   * Outdoor studs on the scene lattice. A missing 8 m neighbour is air beyond
   * the crop, so smoke leaves instead of reflecting. Indoor ids are not
   * opened: a missing upper-floor neighbour is not the outdoors.
   */
  private fillOpenAir(): void {
    const n = this.smokeSlots.length;
    const open = new Uint8Array(n);
    this.smokeOpen = open;
    const scene: Array<{ x: number; y: number; slot: number; ext: boolean }> = [];
    for (let i = 0; i < n; i++) {
      const id = this.smokeSlots[i] ?? '';
      if (!id.startsWith('ext-') && !id.startsWith('bldg-')) continue;
      const stud = this.gridStuds.get(id);
      if (!stud) continue;
      scene.push({ x: stud.x, y: stud.y, slot: i, ext: id.startsWith('ext-') });
    }
    if (!scene.some((stud) => stud.ext)) return;
    const dx = latticeStep(scene.map((stud) => stud.x));
    const dy = latticeStep(scene.map((stud) => stud.y));
    const offsets: Array<[number, number]> = [];
    for (let di = -4; di <= 4; di++) {
      for (let dj = -4; dj <= 4; dj++) {
        if (di === 0 && dj === 0) continue;
        if (Math.hypot(di * dx, dj * dy) <= NEIGHBOR_RADIUS + 1e-6) offsets.push([di, dj]);
      }
    }
    if (offsets.length === 0 || offsets.length > 32) return;
    const occupied = new Set<string>();
    const at = (x: number, y: number) => `${Math.round(x / dx)}:${Math.round(y / dy)}`;
    for (const stud of scene) occupied.add(at(stud.x, stud.y));
    for (const stud of scene) {
      if (!stud.ext) continue;
      let holes = 0;
      for (const [di, dj] of offsets) {
        if (!occupied.has(at(stud.x + di * dx, stud.y + dj * dy))) holes += 1;
      }
      open[stud.slot] = holes;
    }
  }

  /** Wall and shell bits for one stud, cached until a leaf or the shell changes. */
  private blockRow(slot: number, walls: InteriorWall[]): Uint8Array {
    if (!this.shellReady) this.rebuildShell();
    const gen = walls === this.leafWalls ? this.leafGen : this.noteLeaves(walls);
    const key = `${gen}:${this.shellKey}`;
    if (key !== this.smokeBlockKey || walls !== this.smokeBlockWalls) {
      this.smokeBlockKey = key;
      this.smokeBlockWalls = walls;
      this.smokeBlock = new Array(this.smokeSlots.length).fill(null);
    }
    const cached = this.smokeBlock[slot];
    if (cached) return cached;
    const neigh = this.smokeNeigh[slot] ?? [];
    const row = new Uint8Array(neigh.length);
    const id = this.smokeSlots[slot] ?? '';
    for (let j = 0; j < neigh.length; j++) {
      const nSlot = neigh[j] ?? 0;
      row[j] = this.exchangeBlocked(id, this.smokeSlots[nSlot] ?? '', walls) ? 1 : 0;
    }
    this.smokeBlock[slot] = row;
    return row;
  }

  /**
   * Shaft pairs for stairs and lifts. `widthM` and `heightByLevel` are optional;
   * omitted values use the 1.2 m stair and the 4 m storey. The vent uses the
   * landing door and the storey height, not the old 400 K mix.
   */
  setVerticalLinks(links: ShaftLink[]) {
    this.verticalPairs = shaftPairs([...this.studIndex.values()], links);
    this.fireSim.setShaftPairs(this.verticalPairs);
    this.shaftK.clear();
    this.shaftHold.clear();
    this.shaftFumeTo.clear();
  }

  /**
   * Saved storey heights, metres. The soot column uses one when it is set.
   * A missing or empty height keeps the 4 m storey, or 3.5 m in a basement.
   */
  setStoreyHeights(heights: Readonly<Record<string, number>>): void {
    this.storeyHeights.clear();
    for (const [id, height] of Object.entries(heights)) {
      if (height > 0) this.storeyHeights.set(id, height);
    }
  }

  /**
   * The outside wall. An indoor stud and an outdoor neighbour exchange at
   * the full rate only when the link crosses an exit opening. Every other
   * indoor–outdoor link is a wall, with the same 5% leak. Assumed: the
   * facade is closed except at exits that are not blocked. No exits, or an
   * exit with no edge, leaves that part of the shell closed.
   */
  setBuildingEnvelope(vertices: readonly Vec2[], exits: readonly ExitDef[]): void {
    const key = shellSignature(vertices, exits);
    if (key === this.shellKey) return;
    this.shellKey = key;
    this.shellGaps = shellOpenings(vertices, exits);
    this.shellReady = false;
    this.shellBlocked.clear();
  }

  /** Confirmed studs, with light wood assumed where no category was stored. Null is the indoor stand-in. */
  setFuelStuds(ids: ReadonlySet<string> | null) {
    this.fuelGate = ids == null ? null : new Set(ids);
    this.fireSim.setFuelStuds(this.fuelGate);
  }

  /** Per-stud category. An empty map burns nothing. Null is the indoor stand-in. */
  setFuelCells(cells: ReadonlyMap<string, FuelCell> | null) {
    this.fuelGate = cells == null ? null : new Set(cells.keys());
    this.fireSim.setFuelCells(cells);
  }

  /** The charge a blast event uses for rupture. It does not change the drawn fireball. */
  setBlastCharge(spec: ChargeSpec | null) {
    this.fireSim.setBlastCharge(spec);
  }

  /** Confirmed gas lines. Safe to call every frame: rupture and shutoff stay on the id. */
  setGasLines(lines: readonly GasLinePlacement[]) {
    this.fireSim.setGasLines(lines);
  }

  /** Arcs. They are not inferred from the hazard list passed to step. */
  setElectricalSources(sources: readonly ElectricalPlacement[]) {
    this.fireSim.setElectricalSources(sources);
  }

  /** Confirmed sprinkler and wet-chemical heads. A chemical circle is not a head. */
  setSuppression(heads: readonly SuppressionPlacement[]) {
    this.fireSim.setSuppression(heads);
  }

  /**
   * When the hood fan runs. `discharge` is only while the system is open.
   * `appliances` also runs it for a placed hood, the appliance under it
   * being taken as on. The default is discharge, and that choice is open.
   */
  setHoodFanWhen(when: HoodFanWhen): void {
    this.hoodFanWhen = when;
  }

  /** Close one jet, or every jet when the id is omitted. */
  shutOffGas(id?: string) {
    this.fireSim.shutOffGas(id);
  }

  /** Kill one arc, or every arc when the id is omitted. */
  shutOffPower(id?: string) {
    this.fireSim.shutOffPower(id);
  }

  gasJets(): GasJet[] {
    return this.fireSim.gasJets();
  }

  electricalArcs() {
    return this.fireSim.electricalArcs();
  }

  sprays() {
    return this.fireSim.sprays();
  }

  wetStuds(walls: InteriorWall[]) {
    return this.fireSim.wetStuds(walls);
  }

  suppressionState(id: string) {
    return this.fireSim.suppressionState(id);
  }

  fuelReleaseKw(id: string) {
    return this.fireSim.fuelReleaseKw(id);
  }

  fumeSources() {
    return this.fireSim.fumeSources();
  }

  isJetting(id: string): boolean {
    return this.fireSim.isJetting(id);
  }

  isArcing(id: string): boolean {
    return this.fireSim.isArcing(id);
  }

  gasLineState(id: string) {
    return this.fireSim.gasLineState(id);
  }

  registerHazard(
    hazardId: string,
    events: HazardEvent[],
    stateDescriptions: HazardStateProgression,
  ) {
    this.hazardStates.set(hazardId, {
      hazardId,
      phase: 'stable',
      phaseDescription: stateDescriptions.initial,
      nextEventIdx: 0,
      events: [...events].sort((a, b) => a.triggerTimeSec - b.triggerTimeSec),
      stateDescriptions,
      activeEffectIds: [],
      triggeredAt: null,
    });
  }

  step(dt: number, walls: InteriorWall[], hazards: HazardZone[]) {
    if (dt <= 0) return;
    const simDt = dt * this.timeScale;
    this.elapsed += simDt;

    this.noteLeaves(walls);
    this.processHazardEvents(hazards, walls);
    this.stepFire(simDt, walls, hazards);
    this.stepGas(simDt, walls);
    this.stepFlood(simDt, walls);
    this.stepStructural(simDt);
    this.stepSmoke(simDt, walls);
    this.stepFumes(walls);
  }

  private processHazardEvents(hazards: HazardZone[], walls: InteriorWall[]) {
    for (const [, hs] of this.hazardStates) {
      while (hs.nextEventIdx < hs.events.length) {
        const event = hs.events[hs.nextEventIdx];
        if (this.elapsed < event.triggerTimeSec) break;

        hs.nextEventIdx++;
        if (hs.triggeredAt === null) hs.triggeredAt = this.elapsed;

        this.transitionHazardPhase(hs, event);

        if (event.spreadType) {
          const hazard = hazards.find((h) => h.id === hs.hazardId);
          const origin = hazard?.pos ?? { x: 0, y: 0 };

          const effectId = `eff-${hs.hazardId}-${hs.nextEventIdx}`;
          this.activeEffects.push({
            id: effectId,
            type: event.spreadType,
            originPos: origin,
            startTime: this.elapsed,
            spreadRadius: event.spreadRadius,
            spreadRate: event.spreadRate,
            currentRadius: event.spreadRadius,
          });
          hs.activeEffectIds.push(effectId);

          if (event.spreadType === 'fire') {
            this.fireSim.igniteRadius(origin, event.spreadRadius, hazard?.level);
            this.fireSim.applyBlast(origin, event.spreadRadius, hazard?.level, walls);
          }
        }
      }
    }
  }

  private transitionHazardPhase(hs: HazardRuntimeState, event: HazardEvent) {
    const sevOrder: Record<string, number> = { low: 1, medium: 2, high: 3, critical: 4 };
    const currentOrder =
      sevOrder[
        hs.phase === 'stable'
          ? 'low'
          : hs.phase === 'triggered'
            ? 'medium'
            : hs.phase === 'worsening'
              ? 'high'
              : 'critical'
      ] ?? 0;
    const eventOrder = sevOrder[event.severity] ?? 2;

    if (eventOrder >= currentOrder) {
      if (event.severity === 'critical') {
        hs.phase = 'critical';
        hs.phaseDescription = hs.stateDescriptions.critical;
      } else if (event.severity === 'high' || hs.phase === 'triggered') {
        hs.phase = 'worsening';
        hs.phaseDescription = hs.stateDescriptions.worsening;
      } else {
        hs.phase = 'triggered';
        hs.phaseDescription = hs.stateDescriptions.triggered;
      }
    }
  }

  private stepFire(dt: number, walls: InteriorWall[], hazards: HazardZone[]) {
    this.fireSim.step(dt, walls, hazards);

    const wet = new Set(this.fireSim.wetStuds(walls).map((stud) => stud.id));
    for (const [id, fs] of this.fireSim.states) {
      const state = this.studStates.get(id);
      if (state) {
        state.fire = { ...fs };
        state.wet = wet.has(id);
      }
    }
  }

  private stepGas(dt: number, walls: InteriorWall[]) {
    const gasEffects = this.activeEffects.filter((e) => e.type === 'gas');
    if (gasEffects.length === 0) return;

    const MAX_GAS_RADIUS = 80;
    for (const effect of gasEffects) {
      if (effect.currentRadius < MAX_GAS_RADIUS) {
        effect.currentRadius = Math.min(
          MAX_GAS_RADIUS,
          effect.currentRadius + (effect.spreadRate / 60) * dt,
        );
      }
    }

    const spreadAmount = dt * 0.02;
    const decayRate = dt * 0.005;
    const toSpread: Array<{ id: string; amount: number }> = [];

    for (const [id, state] of this.studStates) {
      if (state.gas > 0.01) {
        const src = this.studIndex.get(id);
        if (!src) continue;
        const neighbors = this.neighborCache.get(id) ?? [];

        for (const nId of neighbors) {
          const nState = this.studStates.get(nId);
          const dest = this.studIndex.get(nId);
          if (!nState || !dest) continue;
          if (nState.gas >= state.gas) continue;

          const blocked = isWallBlocked(src.simPos, dest.simPos, walls, levelOf(src));
          const transfer = blocked ? spreadAmount * 0.1 : spreadAmount;
          const diff = (state.gas - nState.gas) * transfer;
          if (diff > 0.001) {
            toSpread.push({ id: nId, amount: diff });
          }
        }

        state.gas = Math.max(0, state.gas - decayRate);
        if (src.spatialContext !== 'inside_building') {
          state.gas = Math.max(0, state.gas - decayRate * 3);
        }
      }
    }

    for (const { id, amount } of toSpread) {
      const s = this.studStates.get(id);
      if (s) s.gas = Math.min(1, s.gas + amount);
    }

    for (const effect of gasEffects) {
      for (const [id, stud] of this.studIndex) {
        const d = Math.hypot(
          stud.simPos.x - effect.originPos.x,
          stud.simPos.y - effect.originPos.y,
        );
        if (d <= effect.currentRadius) {
          const state = this.studStates.get(id);
          if (state) {
            const conc = Math.max(0, 1 - d / Math.max(1, effect.currentRadius));
            state.gas = Math.min(1, Math.max(state.gas, conc * 0.8));
          }
        }
      }
    }
  }

  private stepFlood(dt: number, walls: InteriorWall[]) {
    const floodEffects = this.activeEffects.filter((e) => e.type === 'flood');
    if (floodEffects.length === 0) return;

    const MAX_FLOOD_RADIUS = 60;
    for (const effect of floodEffects) {
      if (effect.currentRadius < MAX_FLOOD_RADIUS) {
        effect.currentRadius = Math.min(
          MAX_FLOOD_RADIUS,
          effect.currentRadius + (effect.spreadRate / 60) * dt,
        );
      }
    }

    const spreadAmount = dt * 0.015;
    const toSpread: Array<{ id: string; amount: number }> = [];

    for (const [id, state] of this.studStates) {
      if (state.flood > 0.01) {
        const src = this.studIndex.get(id);
        if (!src) continue;
        const neighbors = this.neighborCache.get(id) ?? [];

        for (const nId of neighbors) {
          const nState = this.studStates.get(nId);
          const dest = this.studIndex.get(nId);
          if (!nState || !dest) continue;
          if (nState.flood >= state.flood) continue;

          if (isWallBlockedIgnoringDoors(src.simPos, dest.simPos, walls)) continue;

          const diff = (state.flood - nState.flood) * spreadAmount;
          if (diff > 0.001) {
            toSpread.push({ id: nId, amount: diff });
          }
        }
      }
    }

    for (const { id, amount } of toSpread) {
      const s = this.studStates.get(id);
      if (s) s.flood = Math.min(1, s.flood + amount);
    }

    for (const effect of floodEffects) {
      for (const [id, stud] of this.studIndex) {
        const d = Math.hypot(
          stud.simPos.x - effect.originPos.x,
          stud.simPos.y - effect.originPos.y,
        );
        if (d <= effect.currentRadius) {
          const state = this.studStates.get(id);
          if (state && stud.spatialContext === 'inside_building') {
            const level = Math.max(0, 1 - d / Math.max(1, effect.currentRadius));
            state.flood = Math.min(1, Math.max(state.flood, level * 0.6));
          }
        }
      }
    }
  }

  private stepStructural(_dt: number) {
    const structEffects = this.activeEffects.filter((e) => e.type === 'structural_zone');
    if (structEffects.length === 0) return;

    const MAX_STRUCTURAL_RADIUS = 30;
    for (const effect of structEffects) {
      if (effect.currentRadius < MAX_STRUCTURAL_RADIUS) {
        effect.currentRadius = Math.min(
          MAX_STRUCTURAL_RADIUS,
          effect.currentRadius + (effect.spreadRate / 60) * _dt,
        );
      }
    }

    for (const effect of structEffects) {
      for (const [id, stud] of this.studIndex) {
        const d = Math.hypot(
          stud.simPos.x - effect.originPos.x,
          stud.simPos.y - effect.originPos.y,
        );
        if (d <= effect.currentRadius) {
          const state = this.studStates.get(id);
          if (state) {
            const risk = Math.max(0, 1 - d / Math.max(1, effect.currentRadius));
            state.structural = Math.min(1, Math.max(state.structural, risk));
          }
        }
      }
    }
  }

  private static readonly SMOKE_RATE: Record<SmokeGeneration, number> = {
    none: 0,
    light: 0.15,
    moderate: 0.4,
    heavy: 0.7,
    toxic: 0.9,
  };

  /** Floor area times the storey height. A saved height wins. A basement otherwise uses 3.5 m. */
  private columnVolume(id: string): number {
    const stud = this.studIndex.get(id);
    const level = stud ? levelOf(stud) : 'G';
    const saved = this.storeyHeights.get(level);
    const height =
      saved != null && saved > 0
        ? saved
        : level.startsWith('B')
          ? LEVEL.DEFAULT_BASEMENT_HEIGHT_M
          : LEVEL.DEFAULT_STOREY_HEIGHT_M;
    return STUD_AREA_M2 * height;
  }

  /** Indoor–outdoor neighbours, unless the link crosses an exit on this storey. */
  private rebuildShell(): void {
    this.shellBlocked.clear();
    const block = (from: string, to: string) => {
      let set = this.shellBlocked.get(from);
      if (!set) {
        set = new Set();
        this.shellBlocked.set(from, set);
      }
      set.add(to);
    };
    for (const [id, neighbors] of this.neighborCache) {
      const src = this.studIndex.get(id);
      if (!src) continue;
      const srcIn = src.spatialContext === 'inside_building';
      for (const nId of neighbors) {
        if (nId <= id) continue;
        const dest = this.studIndex.get(nId);
        if (!dest) continue;
        const destIn = dest.spatialContext === 'inside_building';
        if (srcIn === destIn) continue;
        const level = levelOf(src);
        let open = false;
        for (const gap of this.shellGaps) {
          if (gap.level !== level) continue;
          if (segmentsIntersect(src.simPos, dest.simPos, gap.a, gap.b)) {
            open = true;
            break;
          }
        }
        if (open) continue;
        block(id, nId);
        block(nId, id);
      }
    }
    this.shellReady = true;
  }

  private shellBlocks(id: string, neighborId: string): boolean {
    if (!this.shellReady) this.rebuildShell();
    return this.shellBlocked.get(id)?.has(neighborId) ?? false;
  }

  /**
   * The outline between an indoor stud and an outdoor one. The same rule as
   * the shell: closed except where a link crosses an unblocked exit. Two
   * indoor studs are not a facade, so an opening inside the floor stays a
   * full-height side.
   */
  private facadeAt(memberId: string, outsideId: string): FacadeOpening | null {
    const member = this.studIndex.get(memberId);
    const outside = this.studIndex.get(outsideId);
    if (!member || !outside) return null;
    const memberIn = member.spatialContext === 'inside_building';
    const outsideIn = outside.spatialContext === 'inside_building';
    if (memberIn === outsideIn) return null;
    if (this.shellBlocks(memberId, outsideId)) return { kind: 'wall' };
    const level = levelOf(member);
    for (const gap of this.shellGaps) {
      if (gap.level !== level) continue;
      if (segmentsIntersect(member.simPos, outside.simPos, gap.a, gap.b)) {
        return { kind: 'exit', exitKey: gap.key, widthM: gap.widthM };
      }
    }
    return { kind: 'wall' };
  }

  /** A solid interior wall, or the outside wall away from an exit. */
  private exchangeBlocked(id: string, neighborId: string, walls: InteriorWall[]): boolean {
    return this.wallBlocked(id, neighborId, walls) || this.shellBlocks(id, neighborId);
  }

  /**
   * A solid wall between two neighbours. The result is kept for this walls
   * array, so a step does not repeat the geometry for every fire.
   */
  /**
   * Bumps when a leaf's id, open fraction, pin, or failure changes.
   * The same array with the same leaves keeps the previous generation,
   * so a smoke step does not rebuild a string for every neighbour.
   */
  private noteLeaves(walls: InteriorWall[]): number {
    const n = walls.length;
    let same = this.leafWalls === walls && this.leafOpen.length === n;
    if (same) {
      for (let i = 0; i < n; i++) {
        const wall = walls[i];
        if (!wall) {
          same = false;
          break;
        }
        const open =
          wall.openFraction == null || !Number.isFinite(wall.openFraction)
            ? null
            : wall.openFraction;
        const flags = (wall.doorPinned ? 1 : 0) + (wall.doorFailed ? 2 : 0);
        if (
          open !== this.leafOpen[i] ||
          flags !== this.leafFlags[i] ||
          wall.id !== this.leafIds[i]
        ) {
          same = false;
          break;
        }
      }
    }
    if (same) return this.leafGen;
    this.leafWalls = walls;
    this.leafOpen = new Array(n);
    this.leafFlags = new Array(n);
    this.leafIds = new Array(n);
    for (let i = 0; i < n; i++) {
      const wall = walls[i];
      if (!wall) continue;
      this.leafOpen[i] =
        wall.openFraction == null || !Number.isFinite(wall.openFraction) ? null : wall.openFraction;
      this.leafFlags[i] = (wall.doorPinned ? 1 : 0) + (wall.doorFailed ? 2 : 0);
      this.leafIds[i] = wall.id;
    }
    this.leafGen += 1;
    return this.leafGen;
  }

  private wallBlocked(id: string, neighborId: string, walls: InteriorWall[]): boolean {
    if (walls.length === 0) return false;
    const gen = walls === this.leafWalls ? this.leafGen : this.noteLeaves(walls);
    if (walls !== this.blockedWalls || gen !== this.blockedGen) {
      this.blockedWalls = walls;
      this.blockedGen = gen;
      this.blockedNeighbors.clear();
    }
    let blocked = this.blockedNeighbors.get(id);
    if (!blocked) {
      blocked = new Set();
      const src = this.studIndex.get(id);
      if (src) {
        const level = levelOf(src);
        for (const nId of this.neighborCache.get(id) ?? []) {
          const dest = this.studIndex.get(nId);
          if (dest && isWallBlocked(src.simPos, dest.simPos, walls, level)) blocked.add(nId);
        }
      }
      this.blockedNeighbors.set(id, blocked);
    }
    return blocked.has(neighborId);
  }

  /** Metres of the storey. A saved height wins. A basement otherwise uses 3.5 m. */
  private storeyHeight(level: string): number {
    const saved = this.storeyHeights.get(level);
    if (saved != null && saved > 0) return saved;
    return level.startsWith('B') ? LEVEL.DEFAULT_BASEMENT_HEIGHT_M : LEVEL.DEFAULT_STOREY_HEIGHT_M;
  }

  /** The stud a jet or an arc sits on. 2 m is assumed: about one stud, not the next. */
  private nearestStud(x: number, y: number, level: string, maxM: number): string | null {
    let best: string | null = null;
    let bestD = maxM;
    for (const [id, stud] of this.gridStuds) {
      if (stud.level !== level) continue;
      const d = Math.hypot(stud.x - x, stud.y - y);
      if (d > bestD) continue;
      if (best != null && d === bestD && id > best) continue;
      bestD = d;
      best = id;
    }
    return best;
  }

  /** Copy the current leaves onto the grid walls. A new shell or a moved wall drops the cache. */
  private syncLayerWalls(walls: InteriorWall[]) {
    const heights = [...this.storeyHeights.entries()]
      .map(([id, height]) => `${id}=${height}`)
      .join(',');
    let moved =
      walls !== this.layerWalls ||
      heights !== this.layerHeightKey ||
      this.shellKey !== this.layerShellKey ||
      walls.length !== this.layerGridWalls.length;
    if (!moved) {
      for (let i = 0; i < walls.length; i++) {
        const wall = walls[i];
        const grid = this.layerGridWalls[i];
        if (
          !wall ||
          !grid ||
          grid.id !== wall.id ||
          grid.x1 !== wall.start.x ||
          grid.y1 !== wall.start.y ||
          grid.x2 !== wall.end.x ||
          grid.y2 !== wall.end.y ||
          grid.material !== wall.material ||
          grid.level !== levelOf(wall)
        ) {
          moved = true;
          break;
        }
      }
    }
    if (moved) {
      this.layerWalls = walls;
      this.layerHeightKey = heights;
      this.layerShellKey = this.shellKey;
      this.layerEnclosures.clear();
      this.layerDoorSnap.clear();
      this.layerGridWalls = walls.map((wall) => ({
        id: wall.id,
        x1: wall.start.x,
        y1: wall.start.y,
        x2: wall.end.x,
        y2: wall.end.y,
        hasDoor: wall.hasDoor,
        doorWidth: wall.doorWidth,
        doorPosition: wall.doorPosition,
        openFraction: wall.openFraction,
        material: wall.material,
        level: levelOf(wall),
      }));
      this.wallById = new Map(this.layerGridWalls.map((wall) => [wall.id, wall]));
      this.liningWalls = this.layerGridWalls.filter(
        (wall) => liningKind(wall.material) !== 'inert',
      );
      return;
    }
    for (let i = 0; i < walls.length; i++) {
      const wall = walls[i];
      const grid = this.layerGridWalls[i];
      if (!wall || !grid) continue;
      grid.hasDoor = wall.hasDoor;
      grid.doorWidth = wall.doorWidth;
      grid.doorPosition = wall.doorPosition;
      grid.openFraction = wall.openFraction;
    }
  }

  private doorOpenOf(wall: GridWall | undefined): number | null {
    if (!wall || wall.openFraction == null || !Number.isFinite(wall.openFraction)) return null;
    return wall.openFraction;
  }

  private enclosureDoorsMatch(key: string, enc: Enclosure | null): boolean {
    const snap = this.layerDoorSnap.get(key);
    if (!snap || !enc) return snap != null && enc == null;
    if (snap.length !== enc.wallIds.length) return false;
    for (let i = 0; i < snap.length; i++) {
      const row = snap[i];
      if (!row || row.id !== enc.wallIds[i]) return false;
      if (row.open !== this.doorOpenOf(this.wallById.get(row.id))) return false;
    }
    return true;
  }

  private enclosureOf(
    room: string,
    members: readonly string[],
    walls: InteriorWall[],
    ceiling: number,
  ): Enclosure | null {
    this.syncLayerWalls(walls);
    const openKey = [...this.fallenGlass].sort().join(',');
    const key = `${room}@${ceiling}@${openKey}`;
    const cached = this.layerEnclosures.get(key);
    if (
      this.layerEnclosures.has(key) &&
      cached !== undefined &&
      this.enclosureDoorsMatch(key, cached)
    ) {
      return cached;
    }
    const found = enclosureFromGrid(
      members,
      this.gridStuds,
      this.neighborCache,
      this.layerGridWalls,
      ceiling,
      (memberId, outsideId) => this.facadeAt(memberId, outsideId),
      this.fallenGlass,
    );
    const snap = (found?.wallIds ?? []).map((id) => ({
      id,
      open: this.doorOpenOf(this.wallById.get(id)),
    }));
    this.layerDoorSnap.set(key, snap);
    this.layerEnclosures.set(key, found);
    return found;
  }

  /** Put a retiring layer back into the columns, so the soot is not deleted. */
  private dumpLayer(
    members: readonly string[],
    zone: ZoneState,
    areaM2: number,
    ceilingM: number,
  ): void {
    const volume = Math.max(areaM2 * ceilingM, 1e-6);
    const k = (SOOT_EXTINCTION_M2_PER_G * zone.sootG) / volume;
    for (const id of members) this.sootK.set(id, k);
    // The grams now live in the columns. Leaving them on the layer would
    // add them a second time if the ceiling fills again.
    zone.sootG = 0;
  }

  /**
   * Advance every ceiling that can hold a reservoir. An open side and a bare
   * grid stay on the column. A running hood is a fan on the layer, at the
   * canopy height above the floor. A hood whose room has no layer keeps
   * the same flow as a loss on its own stud.
   * Returns the studs the column must not also fill.
   */
  /** Walls of rooms that have flashed. The door rating clock reads this. */
  exposedDoorIds(): ReadonlySet<string> {
    return this.exposedDoors;
  }

  /**
   * Copy of every active upper layer, for drawing. A layer above head height
   * leaves its studs' `smoke` at zero, so the picture needs the room itself.
   * Reading it does not touch the simulation.
   */
  smokeLayers(): SmokeLayerView[] {
    const out: SmokeLayerView[] = [];
    for (const [room, live] of this.layerState) {
      if (!live.active) continue;
      const depthM = Math.max(0, live.ceilingM - live.zone.interfaceM);
      const volume = Math.max(live.areaM2 * Math.max(0.02, depthM), 1e-6);
      out.push({
        room,
        members: live.members,
        ceilingM: live.ceilingM,
        interfaceM: live.zone.interfaceM,
        depthM,
        extinctionK: (SOOT_EXTINCTION_M2_PER_G * live.zone.sootG) / volume,
        upperK: live.zone.upperK,
      });
    }
    return out;
  }

  private liningMem(wallId: string): {
    burnedKg: number;
    paneK: number;
    cracked: boolean;
    fallen: boolean;
    faces: Map<string, TimberFace>;
  } {
    let mem = this.linings.get(wallId);
    if (!mem) {
      mem = {
        burnedKg: 0,
        paneK: AMBIENT_K,
        cracked: false,
        fallen: false,
        faces: new Map(),
      };
      this.linings.set(wallId, mem);
    }
    return mem;
  }

  /**
   * Timber or glass standing inside one compartment. The enclosure only
   * keeps a wall that separates this room from another, so a partition
   * the studs can walk around is missing there. Both faces are in this
   * room. It is not a loss to the outside: the other side is the same gas.
   */
  private internalLiningWalls(members: readonly string[], skip: ReadonlySet<string>): GridWall[] {
    if (this.liningWalls.length === 0) return [];
    const inside = new Set(members);
    const found = new Map<string, GridWall>();
    for (const id of members) {
      const stud = this.gridStuds.get(id);
      if (!stud) continue;
      for (const nId of this.neighborCache.get(id) ?? []) {
        if (nId <= id || !inside.has(nId)) continue;
        const other = this.gridStuds.get(nId);
        if (!other || other.level !== stud.level) continue;
        for (const wall of this.liningWalls) {
          if (skip.has(wall.id) || found.has(wall.id) || wall.level !== stud.level) continue;
          if (
            linkCrossesWall(stud.x, stud.y, other.x, other.y, wall.x1, wall.y1, wall.x2, wall.y2)
          ) {
            found.set(wall.id, wall);
          }
        }
      }
    }
    return [...found.values()];
  }

  /** Point source on this face, and the Heskestad height of the strongest stud. */
  private flameOnWall(
    members: readonly string[],
    wall: GridWall,
  ): { flux: number; flameM: number } {
    let flux = 0;
    let best = 0;
    let bestQ = 0;
    for (const id of members) {
      const release = this.fireSim.fuelReleaseKw(id);
      if (!(release != null && release > 0)) continue;
      const stud = this.gridStuds.get(id);
      if (!stud) continue;
      const heat = release * (this.liningFraction.get(id) ?? 1);
      if (!(heat > 0)) continue;
      const dist = distanceToSegmentM(stud.x, stud.y, wall.x1, wall.y1, wall.x2, wall.y2);
      const one = wallPointFluxKwM2(heat, dist);
      flux += one;
      if (one > best) {
        best = one;
        bestQ = heat;
      }
    }
    const diameter = bestQ > 0 ? diameterForReleaseKw(bestQ) : 0;
    return { flux, flameM: bestQ > 0 ? heskestadFlameHeightM(bestQ, diameter) : 0 };
  }

  private noteGlass(
    wallId: string,
    flux: number,
    gasK: number,
    hotDepth: number,
    ceiling: number,
  ): void {
    const covered = hotDepth >= GLASS_LAYER_COVER * ceiling;
    const prev = this.glassTouch.get(wallId);
    if (!prev) {
      this.glassTouch.set(wallId, {
        flame: flux,
        gasK: covered ? gasK : AMBIENT_K,
        hot: covered ? hotDepth : 0,
        ceiling,
      });
      return;
    }
    if (flux > prev.flame) prev.flame = flux;
    if (covered && gasK > prev.gasK) {
      prev.gasK = gasK;
      prev.hot = hotDepth;
      prev.ceiling = ceiling;
    }
  }

  /**
   * Timber heat for this room, and a note of any glass the room touches.
   * The face doses advance either way. The burned mass is committed only
   * when the caller keeps the fire, so a room with no reservoir does not
   * consume the board. One remaining mass covers the whole board: a small
   * flame does not char the rest of the wall through. The heat is one step
   * behind the layer that heats it.
   */
  private proposeLining(
    room: string,
    members: readonly string[],
    enc: Enclosure | null,
    prev: { active: boolean; zone: ZoneState } | undefined,
    ceiling: number,
    dt: number,
  ): {
    heatKw: number;
    sootGPerS: number;
    fumes: FumeGrams;
    fires: FirePlume[];
    studId: string | null;
    commit: () => void;
  } {
    const empty = {
      heatKw: 0,
      sootGPerS: 0,
      fumes: {} as FumeGrams,
      fires: [] as FirePlume[],
      studId: null as string | null,
      commit: () => {},
    };
    if (!enc) return empty;
    const gasK = prev?.active ? prev.zone.upperK : AMBIENT_K;
    const hotDepth = prev?.active ? Math.max(0, ceiling - prev.zone.interfaceM) : 0;
    const phi = this.roomPhi.get(room) ?? 0;
    const pending: Array<{ mem: { burnedKg: number }; add: number }> = [];
    let heatKw = 0;
    let sootGPerS = 0;
    const fumes: FumeGrams = {};
    const fires: FirePlume[] = [];
    const seen = new Set(enc.wallIds);
    const faces: Array<{ wall: GridWall; faceCount: number }> = [];
    for (const wallId of enc.wallIds) {
      const wall = this.wallById.get(wallId);
      if (wall) faces.push({ wall, faceCount: 1 });
    }
    // An internal partition has both faces in this room. The mass is still one board.
    for (const wall of this.internalLiningWalls(members, seen)) {
      faces.push({ wall, faceCount: 2 });
    }
    for (const { wall, faceCount } of faces) {
      const kind = liningKind(wall.material);
      if (kind === 'inert') continue;
      const touch = this.flameOnWall(members, wall);
      if (kind === 'glass') {
        this.noteGlass(wall.id, touch.flux, gasK, hotDepth, ceiling);
        continue;
      }
      const mem = this.liningMem(wall.id);
      const length = Math.hypot(wall.x2 - wall.x1, wall.y2 - wall.y1);
      const open = doorOpenFraction(wall);
      const nominal = wall.hasDoor ? (wall.doorWidth > 0 ? wall.doorWidth : 0.9) : 0;
      const advanced = advanceTimberFace(mem.faces.get(room) ?? freshTimberFace(), {
        flameKwM2: touch.flux,
        gasK,
        hotDepthM: hotDepth,
        ceilingM: ceiling,
        igniterFlameM: touch.flameM,
        lengthM: length,
        doorWidthM: nominal * open,
        doorHeadM: wall.hasDoor ? Math.min(DOOR_SOFFIT_M, ceiling) : 0,
        dt,
      });
      mem.faces.set(room, advanced.face);
      if (!(advanced.areaM2 > 0)) continue;
      const row = layerLiningFor('timber');
      const solid = liningBurnAreaM2(
        length,
        ceiling,
        nominal * open,
        wall.hasDoor ? Math.min(DOOR_SOFFIT_M, ceiling) : 0,
        ceiling,
        0,
      );
      const capacity = row.densityKgM3 * row.thicknessM * solid;
      const burning = advanced.areaM2 * faceCount;
      const demand = charRateMPerS() * row.densityKgM3 * burning * dt;
      const scale = fuelScale(mem.burnedKg, capacity, demand);
      if (!(scale > 0)) continue;
      const release = timberRelease(burning * scale, phi);
      if (!(release.heatKw > 0)) continue;
      pending.push({ mem, add: demand * scale });
      heatKw += release.heatKw;
      sootGPerS += release.sootGPerS;
      addFumeGrams(fumes, release.fumes);
      fires.push({ heatKw: release.heatKw, diameterM: diameterForReleaseKw(release.heatKw) });
    }
    return {
      heatKw,
      sootGPerS,
      fumes,
      fires,
      studId: members[0] ?? null,
      commit: () => {
        for (const item of pending) item.mem.burnedKg += item.add;
      },
    };
  }

  /**
   * One temperature per pane, from the hotter side. A crack is recorded
   * and left as glass. Fallout, once the gas has reached 450 °C, opens on
   * the next step.
   */
  private commitGlass(dt: number): void {
    for (const [wallId, touch] of this.glassTouch) {
      const mem = this.liningMem(wallId);
      if (mem.fallen) continue;
      const row = layerLiningFor('glass');
      const stepped = stepGlassPane(
        {
          paneK: mem.paneK,
          gasK: touch.gasK,
          flameKwM2: touch.flame,
          dt,
          rhoKgM3: row.densityKgM3,
          cJKgK: row.specificHeatJKgK,
          thicknessM: row.thicknessM,
        },
        { cracked: mem.cracked, fallen: mem.fallen },
      );
      mem.paneK = stepped.paneK;
      mem.cracked = stepped.cracked;
      if (!stepped.fallen) continue;
      mem.fallen = true;
      this.fallenGlass.add(wallId);
    }
    this.glassTouch.clear();
  }

  /** Column soot joins the layer on the step the layer first becomes active. */
  private scoopColumnSoot(members: readonly string[], zone: ZoneState): void {
    let carried = zone.sootG;
    for (const id of members) {
      carried += ((this.sootK.get(id) ?? 0) * this.columnVolume(id)) / SOOT_EXTINCTION_M2_PER_G;
    }
    zone.sootG = carried;
  }

  /**
   * Soot grams still cross as a grant. The upper-layer mass and enthalpy
   * of the same vents become the neighbour's door jet on the next step.
   * A receiver with no room is outdoors: the gas has left the building.
   */
  private grantVented(
    room: string,
    members: readonly string[],
    enc: Enclosure,
    stepped: {
      ventedSootG: number;
      outByVentKgS: readonly number[];
      hotByVent: readonly { kg: number; tempK: number; oxygenY: number; fuelY?: number }[];
      neutralM?: number;
      inKgS: number;
      outKgS: number;
    },
    sourceInterfaceM: number,
    dt: number,
    rooms: ReadonlyMap<string, string>,
    jets: Map<string, DoorJetParcel>,
    vents: readonly Vent[] = enc.spec.vents,
    receivers: readonly (readonly string[])[] = enc.ventReceivers,
  ): void {
    const shares = stepped.outByVentKgS;
    let totalOut = 0;
    for (const share of shares) totalOut += share;
    if (stepped.ventedSootG > 0 && totalOut > 0) {
      for (let i = 0; i < shares.length; i++) {
        const share = shares[i] ?? 0;
        const dest = receivers[i] ?? [];
        // No receiver means the soot left through the opening and is
        // not painted onto the studs along the outside wall.
        if (!(share > 0) || dest.length === 0) continue;
        this.layerGrants.push({
          receivers: dest.slice(),
          grams: stepped.ventedSootG * (share / totalOut),
        });
      }
    }
    if (!(dt > 0)) return;
    const memberSet = new Set(members);
    const neutral =
      stepped.neutralM != null && Number.isFinite(stepped.neutralM)
        ? stepped.neutralM
        : sourceInterfaceM;
    const hot = stepped.hotByVent.map((row, i) => {
      const vent = vents[i];
      const sill = vent?.sillM ?? 0;
      const soffit = vent?.soffitM ?? sill;
      return {
        kg: row.kg,
        tempK: row.tempK,
        oxygenY: row.oxygenY,
        fuelY: row.fuelY,
        originM: spillOriginM(sill, sourceInterfaceM),
        widthM: vent?.widthM ?? 0,
        // Hot gas leaves from the higher of the interface and the neutral
        // plane, up to the soffit. That is the band the neighbour entrains.
        lowEdgeM: Math.max(sill, sourceInterfaceM, neutral),
        soffitM: soffit,
      };
    });
    if (this.jetAudit) {
      this.jetAudit.push({
        room,
        members: members.slice(),
        receivers: receivers.map((ids) => ids.slice()),
        hot,
        inKgS: stepped.inKgS,
        outKgS: stepped.outKgS,
      });
    }
    const assigned = assignDoorJet(room, memberSet, receivers, hot, rooms);
    for (const [dest, parcel] of assigned) {
      const cur = jets.get(dest) ?? { kg: 0, tKg: 0, yKg: 0, fKg: 0, originKg: 0, widthKg: 0 };
      cur.kg += parcel.kg;
      cur.tKg += parcel.tKg;
      cur.yKg += parcel.yKg;
      cur.fKg = (cur.fKg ?? 0) + (parcel.fKg ?? 0);
      cur.originKg = (cur.originKg ?? 0) + (parcel.originKg ?? 0);
      cur.widthKg = (cur.widthKg ?? 0) + (parcel.widthKg ?? 0);
      cur.lowKg = (cur.lowKg ?? 0) + (parcel.lowKg ?? 0);
      cur.soffitKg = (cur.soffitKg ?? 0) + (parcel.soffitKg ?? 0);
      cur.bandKg = (cur.bandKg ?? 0) + (parcel.bandKg ?? 0);
      jets.set(dest, cur);
    }
  }

  /**
   * Sheet temperature by wall id, kept after the layer that wrote it is
   * gone. A new layer reads it back instead of starting the wall at ambient.
   * While no layer claims the wall, the temperature cools toward ambient.
   */
  private wallSheetK = new Map<string, number>();
  /** The lining last integrated for that wall, so an unclaimed sheet can cool. */
  private sheetLining = new Map<string, Lining>();
  /** Walls a layer integrated on this step. The rest of wallSheetK cools. */
  private claimedSheets = new Set<string>();
  /** Walls whose temperature reached ambient this step. Zones drop the key. */
  private droppedSheets = new Set<string>();

  /** Temperatures to put on a zone that does not have them yet. */
  private rememberedSheets(): Record<string, number> | undefined {
    const out: Record<string, number> = {};
    let any = false;
    for (const [id, temp] of this.wallSheetK) {
      if (!(temp > AMBIENT_K)) continue;
      out[id] = temp;
      any = true;
    }
    return any ? out : undefined;
  }

  /** Keep each wall's sheet after this step. The pane model is a separate temperature. */
  private keepSheetTemperatures(
    boundaries: readonly Boundary[],
    sheetK: Readonly<Record<string, number>> | undefined,
  ): void {
    if (!sheetK) return;
    for (const boundary of boundaries) {
      const id = boundary.id;
      if (!id) continue;
      const temp = sheetK[id];
      if (!(temp > 0)) continue;
      this.wallSheetK.set(id, temp);
      this.sheetLining.set(id, boundary.lining);
      this.claimedSheets.add(id);
    }
  }

  /**
   * A wall id on two layers this step. Each would otherwise integrate its
   * own copy against outdoor air, and the map would keep the last writer.
   */
  private sharedSheetIds(
    jobs: readonly { boundaries: readonly Boundary[]; ageS: number }[],
  ): Set<string> {
    const counts = new Map<string, number>();
    for (const job of jobs) {
      const seen = new Set<string>();
      for (const boundary of job.boundaries) {
        const id = boundary.id;
        if (!id || seen.has(id) || !(boundary.areaM2 > 0)) continue;
        if (!isothermalSheet(boundary.lining, job.ageS)) continue;
        seen.add(id);
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }
    }
    const shared = new Set<string>();
    for (const [id, count] of counts) if (count >= 2) shared.add(id);
    return shared;
  }

  /** One starting temperature for a partition both layers are about to step. */
  private zoneWithSharedSheet(
    zone: ZoneState,
    boundaries: readonly Boundary[],
    hold: ReadonlySet<string>,
    startT: ReadonlyMap<string, number>,
  ): ZoneState {
    if (hold.size === 0) return zone;
    let sheet: Record<string, number> | undefined;
    let changed = false;
    for (const boundary of boundaries) {
      const id = boundary.id;
      if (!id || !hold.has(id)) continue;
      const temp = startT.get(id);
      if (!(temp != null && temp > 0)) continue;
      const have = (sheet ?? zone.sheetK)?.[id];
      if (have === temp) continue;
      if (!changed) {
        sheet = zone.sheetK ? { ...zone.sheetK } : {};
        changed = true;
      }
      if (sheet) sheet[id] = temp;
    }
    return changed && sheet ? { ...zone, sheetK: sheet } : zone;
  }

  /**
   * Add both sides' films to one partition. Fewer than two sides means the
   * other face was not a layer, so the step that ran already held the
   * temperature and this leaves the outdoor film out only when both
   * contributed.
   */
  private applySharedSheetGains(
    rows: readonly {
      room: string;
      boundaries: readonly Boundary[];
      gain?: Readonly<Record<string, number>>;
    }[],
    startT: ReadonlyMap<string, number>,
  ): void {
    const gained = new Map<string, { kjm2: number; lining: Lining; rooms: string[] }>();
    for (const row of rows) {
      if (!row.gain) continue;
      for (const [id, kjm2] of Object.entries(row.gain)) {
        const have = gained.get(id);
        if (have) {
          have.kjm2 += kjm2;
          have.rooms.push(row.room);
          continue;
        }
        const boundary = row.boundaries.find((item) => item.id === id);
        if (!boundary) continue;
        gained.set(id, { kjm2, lining: boundary.lining, rooms: [row.room] });
      }
    }
    for (const [id, row] of gained) {
      if (row.rooms.length < 2) continue;
      const store = row.lining.rhoKgM3 * row.lining.cKjKgK * row.lining.thicknessM;
      if (!(store > 0)) continue;
      const prev = startT.get(id) ?? AMBIENT_K;
      const next = Math.min(1500, Math.max(AMBIENT_K, prev + row.kjm2 / store));
      this.wallSheetK.set(id, next);
      this.sheetLining.set(id, row.lining);
      this.claimedSheets.add(id);
      for (const room of row.rooms) {
        const live = this.layerState.get(room);
        if (!live) continue;
        live.zone = { ...live.zone, sheetK: { ...(live.zone.sheetK ?? {}), [id]: next } };
      }
    }
  }

  /** Both films to ambient, for a sheet no layer stepped. */
  private relaxUnclaimedSheets(dt: number): void {
    if (!(dt > 0)) return;
    for (const [id, temp] of this.wallSheetK) {
      if (this.claimedSheets.has(id) || !(temp > AMBIENT_K)) continue;
      const lining = this.sheetLining.get(id);
      if (!lining) continue;
      const next = coolUnclaimedSheet(temp, lining, dt);
      if (!(next > AMBIENT_K + 1e-4)) {
        this.wallSheetK.delete(id);
        this.sheetLining.delete(id);
        this.droppedSheets.add(id);
        continue;
      }
      this.wallSheetK.set(id, next);
    }
  }

  /** Zones read the temperature the wall holds now, including one that cooled. */
  private publishSheetTemperatures(): void {
    if (this.wallSheetK.size === 0 && this.droppedSheets.size === 0) return;
    for (const live of this.layerState.values()) {
      const sheet = live.zone.sheetK;
      if (!sheet) continue;
      let next: Record<string, number> | undefined;
      let changed = false;
      for (const [id, temp] of Object.entries(sheet)) {
        const kept = this.wallSheetK.get(id);
        if (kept != null && kept > AMBIENT_K) {
          if (Math.abs(kept - temp) > 1e-6) {
            if (!next) next = { ...sheet };
            next[id] = kept;
            changed = true;
          }
          continue;
        }
        if (!this.droppedSheets.has(id)) continue;
        if (!next) next = { ...sheet };
        delete next[id];
        changed = true;
      }
      if (!changed || !next) continue;
      live.zone =
        Object.keys(next).length > 0
          ? { ...live.zone, sheetK: next }
          : { ...live.zone, sheetK: undefined };
    }
  }

  private zoneWithSheets(zone: ZoneState, boundaries: readonly Boundary[]): ZoneState {
    return withRememberedSheets(zone, boundaries, this.rememberedSheets());
  }

  /**
   * Copy the vents and, where a vent opens into another room that already
   * has a layer, put that layer on the far side. Outdoor vents are left
   * as they are, which is ambient. The cached enclosure is not mutated.
   */
  private ventsSeeingNeighbours(
    vents: readonly Vent[],
    receivers: readonly (readonly string[])[],
    room: string,
    members: readonly string[],
    rooms: ReadonlyMap<string, string>,
    gauges: ReadonlyMap<string, VentOutside>,
  ): Vent[] {
    const memberSet = new Set(members);
    return vents.map((vent, i) => {
      const outside = neighbourVentOutside(receivers[i] ?? [], room, memberSet, rooms, gauges);
      return outside ? { ...vent, outside } : vent;
    });
  }

  private rememberFloorPressure(room: string, floorPressurePa: number): void {
    const prev = this.floorPressurePrevPa.get(room);
    this.floorPressurePrevPa.set(room, floorPressurePa);
    // A steady root is unchanged. A period-2 pair A, B becomes (A + B) / 2,
    // which is what the neighbour reads, so the next solve does not
    // overshoot back to the other root. The first step has no history.
    this.floorPressurePa.set(room, prev == null ? floorPressurePa : 0.5 * (floorPressurePa + prev));
  }

  private forgetFloorPressure(room: string): void {
    this.floorPressurePa.delete(room);
    this.floorPressurePrevPa.delete(room);
  }

  private stepLayers(dt: number, walls: InteriorWall[]): Set<string> {
    this.claimedSheets.clear();
    this.droppedSheets.clear();
    const owned = new Set<string>();
    this.layerGrants = [];
    const keptLower = this.jetLowerStuds;
    this.jetLowerStuds = new Set();
    this.jetTaken = new Map();
    if (this.jetAudit) this.jetAudit.length = 0;
    this.exposedDoors = new Set();
    this.liningFumes = [];
    this.glassTouch.clear();
    this.liningFraction.clear();
    for (const id of this.gridStuds.keys()) {
      const fraction = this.fireSim.burnFraction(id);
      if (fraction < 0.999) this.liningFraction.set(id, fraction);
    }
    this.fireSim.clearBurnLimits();
    this.syncLayerWalls(walls);
    const rooms = this.fireSim.compartmentsOf(walls);
    const groups = new Map<string, string[]>();
    for (const [id, room] of rooms) {
      const list = groups.get(room);
      if (list) list.push(id);
      else groups.set(room, [id]);
    }
    // A hold from the previous step becomes a layer before the gauges, so
    // both storeys book the shaft this step.
    this.shaftMoves = [];
    this.absorbShaftHolds(walls, groups);

    const extra = new Map<string, FirePlume[]>();
    const addPlume = (studId: string | null, heatKw: number) => {
      if (!studId || !(heatKw > 0)) return;
      const room = rooms.get(studId);
      if (!room) return;
      const list = extra.get(room) ?? [];
      list.push({ heatKw, diameterM: diameterForReleaseKw(heatKw) });
      extra.set(room, list);
    };
    for (const jet of this.fireSim.gasJets()) {
      addPlume(this.nearestStud(jet.pos.x, jet.pos.y, jet.level, 2), GAS_JET_KW);
    }
    const arcKw = electricalHeatReleaseKw();
    for (const arc of this.fireSim.electricalArcs()) {
      addPlume(this.nearestStud(arc.pos.x, arc.pos.y, arc.level, 2), arcKw);
    }

    const sootByRoom = new Map<string, number>();
    for (const src of this.fireSim.burningSoot()) {
      const room = rooms.get(src.id);
      if (!room) continue;
      sootByRoom.set(room, (sootByRoom.get(room) ?? 0) + src.sootGPerS);
    }
    const seen = new Set<string>();
    const nextJets = new Map<string, DoorJetParcel>();
    const gauges = new Map<string, VentOutside>();
    for (const [id, live] of this.layerState) {
      if (!live.active) continue;
      gauges.set(id, {
        interfaceM: live.zone.interfaceM,
        upperK: live.zone.upperK,
        floorPressurePa: this.floorPressurePa.get(id) ?? 0,
        ...(live.zone.lowerK != null ? { lowerK: live.zone.lowerK } : {}),
      });
    }
    const pending: Array<{
      boundaries: readonly Boundary[];
      ageS: number;
      zone: ZoneState;
      room: string;
      /** Predict this step's gauge so the other storey's shaft uses it. */
      preview?: () => VentOutside;
      run: (
        hold: ReadonlySet<string>,
        startT: ReadonlyMap<string, number>,
      ) => { gain?: Readonly<Record<string, number>> };
    }> = [];

    for (const [room, members] of groups) {
      seen.add(room);
      const ceiling = this.storeyHeight(this.gridStuds.get(members[0] ?? '')?.level ?? 'G');
      const fires: FirePlume[] = [...(extra.get(room) ?? [])];
      for (const id of members) {
        const release = this.fireSim.fuelReleaseKw(id);
        if (release != null && release > 0)
          fires.push({ heatKw: release, diameterM: diameterForReleaseKw(release) });
      }
      let heat = 0;
      for (const fire of fires) heat += fire.heatKw;
      const prev = this.layerState.get(room);
      const retire = () => {
        if (!prev?.active) return;
        this.dumpLayer(prev.members, prev.zone, prev.areaM2, prev.ceilingM);
        prev.active = false;
      };
      // No fire, no door jet, and no combustible lining: the enclosure
      // and the face update would not write anything. A hot neighbour
      // still grants soot onto these studs later, and its jet can start
      // a layer here on a later step.
      const incoming = this.doorJets.get(room);
      const hasJet = incoming != null && incoming.kgS > 0;
      if (heat < MIN_LAYER_FIRE_KW && !prev?.active && !hasJet && this.liningWalls.length === 0) {
        continue;
      }
      const enc = this.enclosureOf(room, members, walls, ceiling);
      if (enc && members.some((id) => this.fireSim.isFlashed(id))) {
        for (const wallId of enc.wallIds) this.exposedDoors.add(wallId);
      }
      const lining = this.proposeLining(room, members, enc, prev, ceiling, dt);
      heat += lining.heatKw;
      if (heat < MIN_LAYER_FIRE_KW && !prev?.active && !hasJet) {
        retire();
        continue;
      }
      if (!enc || !hasSmokeReservoir(enc.spec.vents, ceiling)) {
        retire();
        continue;
      }
      lining.commit();
      for (const fire of lining.fires) fires.push(fire);
      if (lining.sootGPerS > 0) {
        sootByRoom.set(room, (sootByRoom.get(room) ?? 0) + lining.sootGPerS);
      }
      if (lining.studId && (lining.sootGPerS > 0 || fumesPresent(lining.fumes))) {
        this.liningFumes.push({
          id: lining.studId,
          gramsPerS: lining.fumes,
          sootGPerS: lining.sootGPerS,
        });
      }
      const memberSet = new Set(members);
      const fans: MechanicalVent[] = [];
      for (const id of this.fireSim.hoodColumns(this.hoodFanWhen)) {
        if (!memberSet.has(id)) continue;
        fans.push({ flowM3PerS: HOOD_EXTRACT_M3_PER_S, intakeM: HOOD_INTAKE_M });
      }
      const spec: LayerSpec = {
        ...enc.spec,
        vents: this.ventsSeeingNeighbours(
          enc.spec.vents,
          enc.ventReceivers,
          room,
          members,
          rooms,
          gauges,
        ),
        fires,
        fans,
      };
      const zone = this.zoneWithSheets(prev?.zone ?? freshLayer(ceiling), spec.boundaries);
      const sootRate = sootByRoom.get(room) ?? 0;
      // A paused jet leaves a fireless room on this path. The step judges
      // the layer from the zone it already holds. A room with no fire and
      // no jet of its own has a cold steady layer, which would retire a
      // ceiling that is still hot.
      if ((hasJet || prev?.active === true) && heat < MIN_LAYER_FIRE_KW) {
        // The only heat is the neighbour's jet. The steady fire correlation
        // does not see it, so the layer is the integrated upper layer.
        if (incoming) this.jetTaken.set(room, incoming);
        pending.push({
          boundaries: spec.boundaries,
          ageS: zone.ageS,
          zone,
          room,
          ...(this.touchesShaft(members)
            ? {
                preview: () =>
                  this.previewShaftGauge(
                    room,
                    members,
                    zone,
                    spec,
                    dt,
                    sootRate,
                    incoming,
                    enc.ventReceivers,
                    gauges,
                    groups,
                    zone.lowerK ?? AMBIENT_K,
                  ),
              }
            : {}),
          run: (hold, startT) => {
            const seeded = this.zoneWithSharedSheet(zone, spec.boundaries, hold, startT);
            const solved = this.stepThroughShafts(
              room,
              members,
              seeded,
              spec,
              dt,
              sootRate,
              incoming,
              hold.size > 0 ? hold : undefined,
              enc.ventReceivers,
              gauges,
              groups,
              zone.lowerK ?? AMBIENT_K,
            );
            const next = solved.stepped;
            this.keepSheetTemperatures(spec.boundaries, next.state.sheetK);
            const depth = spec.ceilingM - next.state.interfaceM;
            const rise = next.state.upperK - AMBIENT_K;
            const thick = CEILING_JET_DEPTH_FRACTION * ceiling;
            const layerHold =
              prev?.active === true &&
              rise >= DISTINCT_LAYER_RISE_K * LAYER_OFF_FRACTION &&
              depth >= thick * LAYER_OFF_FRACTION;
            // A shaft-fed film is thinner than the jet test until the next
            // step deepens it. Retiring it would throw away the gas the hold
            // just handed over.
            const shaftFed =
              solved.moves.length > 0 &&
              rise >= DISTINCT_LAYER_RISE_K * LAYER_OFF_FRACTION &&
              depth >= 0.02;
            const active = layerHold || shaftFed || formsSustainedLayer(depth, ceiling, rise, true);
            if (!active) {
              retire();
              this.forgetFloorPressure(room);
              this.layerState.set(room, {
                active: false,
                zone: next.state,
                members,
                areaM2: spec.areaM2,
                ceilingM: ceiling,
              });
              return { gain: next.sheetGainKjM2 };
            }
            // The column soot stays where it is and leaks. Copying it into the
            // layer as well would count those grams twice.
            this.rememberFloorPressure(room, next.floorPressurePa);
            this.layerState.set(room, {
              active: true,
              zone: next.state,
              members,
              areaM2: spec.areaM2,
              ceilingM: ceiling,
            });
            for (const id of members) {
              owned.add(id);
              this.jetLowerStuds.add(id);
            }
            this.grantVented(
              room,
              members,
              enc,
              next,
              next.state.interfaceM,
              dt,
              rooms,
              nextJets,
              solved.vents,
              solved.receivers,
            );
            return { gain: next.sheetGainKjM2 };
          },
        });
        continue;
      }
      const opening = oxygenLimitedBurn(
        spec,
        zone.interfaceM,
        zone.upperK,
        oxygenMassFraction(zone.lowerO2),
        oxygenMassFraction(zone.upperO2),
        dt,
        false,
        undefined,
        zone.lowerK ?? AMBIENT_K,
      ).burn;
      const limitedFires =
        opening.prescribedKw > 0 && opening.fraction < 0.999
          ? fires.map((fire) => ({ ...fire, heatKw: fire.heatKw * opening.fraction }))
          : fires;
      const steady = steadyLayer({ ...spec, fires: limitedFires }, zone.ageS);
      const rise = steady ? steady.upperK - AMBIENT_K : 0;
      const depth = steady?.depthM ?? 0;
      const jet = CEILING_JET_DEPTH_FRACTION * ceiling;
      const hold =
        prev?.active === true &&
        rise >= DISTINCT_LAYER_RISE_K * LAYER_OFF_FRACTION &&
        depth >= jet * LAYER_OFF_FRACTION;
      // A shaft landing that ignites already holds a deep jet layer. The
      // steady fire correlation is thinner than that layer and would retire
      // it, dropping the smoke the stair just delivered.
      const kept =
        this.touchesShaft(members) &&
        prev?.active === true &&
        (formsSustainedLayer(
          Math.max(0, ceiling - prev.zone.interfaceM),
          ceiling,
          prev.zone.upperK - AMBIENT_K,
          true,
        ) ||
          (prev.zone.upperK - AMBIENT_K >= DISTINCT_LAYER_RISE_K * LAYER_OFF_FRACTION &&
            ceiling - prev.zone.interfaceM >= jet * LAYER_OFF_FRACTION));
      const active = hold || kept || formsSustainedLayer(depth, ceiling, rise, true);
      if (!active) {
        retire();
        this.forgetFloorPressure(room);
        this.layerState.set(room, {
          active: false,
          zone,
          members,
          areaM2: spec.areaM2,
          ceilingM: ceiling,
        });
        if (opening.prescribedKw > 0) {
          this.roomPhi.set(room, opening.phi);
          this.fireSim.setBurnLimit(members, opening.fraction, opening.phi);
        }
        continue;
      }
      if (prev?.active !== true) this.scoopColumnSoot(members, zone);
      // A room with its own fire already solves the door. The neighbour's
      // layer is the far side of that door, so the return flow is in the
      // orifice. Adding the carrier jet on top of that flow would fill the
      // layer a second time. The orifice still carries that inflow's
      // enthalpy into the layer. The fuel in the jet is not that carrier.
      // It burns here on the oxygen this room's plume has not taken, and
      // what cannot burn stays in the layer. A room with no fire of its own
      // takes the carrier, and the orifice then leaves that upper-layer
      // inflow out. The step itself waits until every room is known, so a
      // shared partition is integrated once from both sides.
      const fuelJet =
        incoming != null && (incoming.fuelY ?? 0) > 0 ? { ...incoming, fuelOnly: true } : undefined;
      pending.push({
        boundaries: spec.boundaries,
        ageS: zone.ageS,
        zone,
        room,
        ...(this.touchesShaft(members)
          ? {
              preview: () =>
                this.previewShaftGauge(
                  room,
                  members,
                  zone,
                  spec,
                  dt,
                  sootRate,
                  fuelJet,
                  enc.ventReceivers,
                  gauges,
                  groups,
                  zone.lowerK ?? AMBIENT_K,
                ),
            }
          : {}),
        run: (hold, startT) => {
          const seeded = this.zoneWithSharedSheet(zone, spec.boundaries, hold, startT);
          const solved = this.stepThroughShafts(
            room,
            members,
            seeded,
            spec,
            dt,
            sootRate,
            fuelJet,
            hold.size > 0 ? hold : undefined,
            enc.ventReceivers,
            gauges,
            groups,
            zone.lowerK ?? AMBIENT_K,
          );
          const stepped = solved.stepped;
          this.keepSheetTemperatures(spec.boundaries, stepped.state.sheetK);
          this.rememberFloorPressure(room, stepped.floorPressurePa);
          this.layerState.set(room, {
            active: true,
            zone: stepped.state,
            members,
            areaM2: spec.areaM2,
            ceilingM: ceiling,
          });
          // Fire that spreads into a jet-fed room must not wipe the soot that
          // room already kept at head height. A layer that is only now forming
          // from its own fire is absent here, and stepSmoke still clears it.
          const keptJetSoot = prev?.active === true && members.some((id) => keptLower.has(id));
          for (const id of members) {
            owned.add(id);
            if (keptJetSoot) this.jetLowerStuds.add(id);
          }
          this.roomPhi.set(room, stepped.phi);
          this.fireSim.setBurnLimit(members, stepped.burnedFraction, stepped.phi);
          this.grantVented(
            room,
            members,
            enc,
            stepped,
            stepped.state.interfaceM,
            dt,
            rooms,
            nextJets,
            solved.vents,
            solved.receivers,
          );
          return { gain: stepped.sheetGainKjM2 };
        },
      });
    }

    const hold = this.sharedSheetIds(pending);
    const startT = new Map<string, number>();
    for (const id of hold) {
      let temp = this.wallSheetK.get(id);
      if (!(temp != null && temp > AMBIENT_K)) {
        for (const job of pending) {
          const found = job.zone.sheetK?.[id];
          if (found != null && found > AMBIENT_K) {
            temp = found;
            break;
          }
        }
      }
      startT.set(id, temp != null && temp > AMBIENT_K ? temp : AMBIENT_K);
    }
    // Each storey books its own orifice against the other's last gauge,
    // and those two flows are not equal. The preview measures the gap.
    // The real solve keeps the orifice and adds half the gap at each end,
    // so the kilogram that leaves one storey arrives in the other. The
    // hot stream stays on the orifice.
    if (this.verticalPairs.length > 0) {
      this.useImposedShaft = false;
      this.imposedShaft = new Map();
      for (let pass = 0; pass < 2; pass++) {
        this.previewNets = [];
        for (const job of pending) {
          if (!job.preview || !gauges.has(job.room)) continue;
          job.preview();
        }
        this.agreeShaftFlows();
        this.useImposedShaft = true;
      }
    }
    const finished: Array<{
      room: string;
      boundaries: readonly Boundary[];
      gain?: Readonly<Record<string, number>>;
    }> = [];
    for (const job of pending) {
      finished.push({
        room: job.room,
        boundaries: job.boundaries,
        ...job.run(hold, startT),
      });
    }
    this.useImposedShaft = false;
    this.applySharedSheetGains(finished, startT);
    this.relaxUnclaimedSheets(dt);
    this.publishSheetTemperatures();

    this.doorJets = queueDoorJets(nextJets, dt);

    for (const [room, live] of this.layerState) {
      if (seen.has(room) || !live.active) continue;
      this.dumpLayer(live.members, live.zone, live.areaM2, live.ceilingM);
      live.active = false;
      this.forgetFloorPressure(room);
    }
    this.commitGlass(dt);
    this.settleShafts(dt, groups, owned);
    return owned;
  }

  /**
   * Solve one room with its doors plus a shaft orifice into each other
   * storey. A preview measures the two orifices, and the real solve adds
   * the gap so the same kilograms leave one storey and enter the other.
   * A storey with no layer yet is a still column at the stack pressure,
   * and only the hot part of the outflow is kept for it.
   */
  private stepThroughShafts(
    room: string,
    members: readonly string[],
    state: ZoneState,
    spec: LayerSpec,
    dt: number,
    sootGPerS: number,
    jet: DoorJetInflow | null | undefined,
    hold: ReadonlySet<string> | undefined,
    doorReceivers: readonly (readonly string[])[],
    gauges: ReadonlyMap<string, VentOutside>,
    groups: ReadonlyMap<string, string[]>,
    lowerK: number,
    commit = true,
  ): {
    stepped: ReturnType<typeof stepZone>;
    vents: Vent[];
    receivers: string[][];
    moves: ShaftMove[];
  } {
    const movesBefore = this.shaftMoves.length;
    const planned = this.planShaftVents(
      room,
      members,
      state.interfaceM,
      spec,
      doorReceivers,
      gauges,
      groups,
    );
    const stepped = stepZone(state, planned.spec, dt, sootGPerS, jet, hold);
    if (!commit) {
      this.noteShaftPreview(room, planned.moves, stepped, dt);
      this.shaftMoves.length = movesBefore;
      return { stepped, vents: planned.vents, receivers: planned.receivers, moves: [] };
    }
    this.ventNetKg += stepped.bookedKg;
    this.shellNetKg += stepped.shellKg;
    this.fillShaftMoves(planned.moves, stepped, lowerK);
    return { stepped, vents: planned.vents, receivers: planned.receivers, moves: planned.moves };
  }

  /** True when this room is one end of a stair or a lift. */
  private touchesShaft(members: readonly string[]): boolean {
    if (this.verticalPairs.length === 0) return false;
    for (const pair of this.verticalPairs) {
      const lower = members.includes(pair.lower);
      const upper = members.includes(pair.upper);
      if (lower !== upper) return true;
    }
    return false;
  }

  /**
   * Thrown-away solve on this step's starting gauge. The shaft nets it
   * records are what the two orifices would book before the correction.
   */
  private previewShaftGauge(
    room: string,
    members: readonly string[],
    state: ZoneState,
    spec: LayerSpec,
    dt: number,
    sootGPerS: number,
    jet: DoorJetInflow | null | undefined,
    doorReceivers: readonly (readonly string[])[],
    gauges: ReadonlyMap<string, VentOutside>,
    groups: ReadonlyMap<string, string[]>,
    lowerK: number,
  ): VentOutside {
    const seeded: ZoneState = {
      ...state,
      ...(state.sheetK ? { sheetK: { ...state.sheetK } } : {}),
    };
    const solved = this.stepThroughShafts(
      room,
      members,
      seeded,
      spec,
      dt,
      sootGPerS,
      jet,
      undefined,
      doorReceivers,
      gauges,
      groups,
      lowerK,
      false,
    );
    const next = solved.stepped.state;
    return {
      interfaceM: next.interfaceM,
      upperK: next.upperK,
      floorPressurePa: solved.stepped.floorPressurePa,
      ...(next.lowerK != null ? { lowerK: next.lowerK } : {}),
    };
  }

  /** Shaft net from a thrown-away solve, kg/s into the room. */
  private noteShaftPreview(
    room: string,
    moves: readonly ShaftMove[],
    stepped: { inKgByVent: readonly number[]; outKgByVent: readonly number[] },
    dt: number,
  ): void {
    const scale = dt > 0 ? 1 / dt : 0;
    for (const move of moves) {
      const inn = stepped.inKgByVent[move.ventIndex] ?? 0;
      const out = stepped.outKgByVent[move.ventIndex] ?? 0;
      this.previewNets.push({ room, key: move.key, netKgS: (inn - out) * scale });
    }
  }

  /**
   * Split the preview gap evenly. Each storey keeps its own orifice, and
   * both add the same correction so the two nets sum to zero.
   */
  private agreeShaftFlows(): void {
    const byKey = new Map<string, { room: string; netKgS: number }[]>();
    for (const row of this.previewNets) {
      const list = byKey.get(row.key);
      if (list) list.push(row);
      else byKey.set(row.key, [row]);
    }
    for (const [key, rows] of byKey) {
      if (rows.length < 2) continue;
      const a = rows[0]!;
      const b = rows[1]!;
      const fix = -(a.netKgS + b.netKgS) / 2;
      if (!(Math.abs(fix) > 1e-6)) continue;
      const aKey = `${a.room}\n${key}`;
      const bKey = `${b.room}\n${key}`;
      this.imposedShaft.set(aKey, (this.imposedShaft.get(aKey) ?? 0) + fix);
      this.imposedShaft.set(bKey, (this.imposedShaft.get(bKey) ?? 0) + fix);
    }
  }

  private planShaftVents(
    room: string,
    members: readonly string[],
    interfaceM: number,
    spec: LayerSpec,
    doorReceivers: readonly (readonly string[])[],
    gauges: ReadonlyMap<string, VentOutside>,
    groups: ReadonlyMap<string, string[]>,
  ): { spec: LayerSpec; vents: Vent[]; receivers: string[][]; moves: ShaftMove[] } {
    const vents = spec.vents.slice();
    const receivers = doorReceivers.map((row) => row.slice());
    const moves: ShaftMove[] = [];
    if (this.verticalPairs.length === 0) return { spec, vents, receivers, moves };
    const memberSet = new Set(members);
    const seen = new Set<string>();
    for (const pair of this.verticalPairs) {
      const thisIsLower = memberSet.has(pair.lower);
      const thisIsUpper = memberSet.has(pair.upper);
      if ((thisIsLower && thisIsUpper) || (!thisIsLower && !thisIsUpper)) continue;
      const otherId = thisIsLower ? pair.upper : pair.lower;
      const otherRoom = this.roomOfStud(otherId, groups);
      if (!otherRoom || otherRoom === room) continue;
      const lowerRoom = thisIsLower ? room : otherRoom;
      const upperRoom = thisIsLower ? otherRoom : room;
      const key = `${pair.linkId ?? pair.lower}|${lowerRoom}|${upperRoom}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const level = levelOf(this.studIndex.get(thisIsLower ? pair.lower : pair.upper) ?? {});
      const height =
        pair.storeyHeightM && pair.storeyHeightM > 0
          ? pair.storeyHeightM
          : this.storeyHeight(level);
      const opening = shaftOpeningM(height);
      const other = gauges.get(otherRoom);
      const otherActive = other != null;
      // Cold air through an empty landing is not a layer. Wait until the
      // door head is in the smoke, then keep that hot gas for the far floor.
      if (!otherActive && !doorHeadInUpper(interfaceM, opening)) continue;
      const doorWidth =
        pair.widthM ??
        (pair.kind === 'lift' ? LEVEL.LIFT_DOOR_WIDTH_M : LEVEL.DEFAULT_STAIR_WIDTH_M);
      const width = shaftEquivalentWidthM(doorWidth);
      if (!(width > 0) || !(opening > 0)) continue;
      const shaftK = this.shaftK.get(key) ?? AMBIENT_K;
      const stack = shaftStackPa(shaftK, height);
      const outside: VentOutside = other
        ? {
            interfaceM: other.interfaceM,
            upperK: other.upperK,
            lowerK: other.lowerK,
            floorPressurePa: other.floorPressurePa + (thisIsLower ? -stack : stack),
          }
        : {
            interfaceM: opening + 1,
            upperK: AMBIENT_K,
            lowerK: AMBIENT_K,
            floorPressurePa: thisIsLower ? -stack : stack,
          };
      const move: ShaftMove = {
        key,
        pair,
        sourceId: thisIsLower ? pair.lower : pair.upper,
        destId: otherId,
        toRoom: otherRoom,
        otherActive,
        ventIndex: vents.length,
        outKg: 0,
        hotKg: 0,
        hotT: AMBIENT_K,
        hotY: O2_AMBIENT_MASS,
        hotF: 0,
        sootG: 0,
        lowerK: AMBIENT_K,
      };
      vents.push({
        widthM: width,
        sillM: 0,
        soffitM: opening,
        outside,
        shaft: true,
        ...(this.useImposedShaft && this.imposedShaft.has(`${room}\n${key}`)
          ? { imposedKgS: this.imposedShaft.get(`${room}\n${key}`) }
          : {}),
      });
      receivers.push(otherActive ? (groups.get(otherRoom) ?? []).slice() : []);
      moves.push(move);
      this.shaftMoves.push(move);
    }
    return {
      spec: vents.length === spec.vents.length ? spec : { ...spec, vents },
      vents,
      receivers,
      moves,
    };
  }

  private roomOfStud(id: string, groups: ReadonlyMap<string, string[]>): string | undefined {
    for (const [room, members] of groups) {
      if (members.includes(id)) return room;
    }
    return undefined;
  }

  private fillShaftMoves(
    moves: readonly ShaftMove[],
    stepped: {
      ventedSootG: number;
      outByVentKgS: readonly number[];
      outKgByVent: readonly number[];
      hotByVent: readonly { kg: number; tempK: number; oxygenY: number; fuelY?: number }[];
    },
    lowerK: number,
  ): void {
    if (moves.length === 0) return;
    let totalOut = 0;
    for (const share of stepped.outByVentKgS) totalOut += share;
    for (const move of moves) {
      const hot = stepped.hotByVent[move.ventIndex];
      move.outKg = stepped.outKgByVent[move.ventIndex] ?? 0;
      move.hotKg = hot?.kg ?? 0;
      move.hotT = hot?.tempK ?? AMBIENT_K;
      move.hotY = hot?.oxygenY ?? O2_AMBIENT_MASS;
      move.hotF = hot?.fuelY ?? 0;
      move.lowerK = lowerK;
      const share = totalOut > 0 ? (stepped.outByVentKgS[move.ventIndex] ?? 0) / totalOut : 0;
      move.sootG = stepped.ventedSootG * share;
    }
  }

  /**
   * The shaft's hot outflow is already in both pressure roots when the far
   * storey has a layer. Until then it waits in the hold, and the books keep
   * that same mass so the building total does not grow. The column
   * temperature and the landing flux follow the gas that entered.
   */
  private settleShafts(
    dt: number,
    groups: ReadonlyMap<string, string[]>,
    owned: Set<string>,
  ): void {
    if (!(dt > 0) || this.shaftMoves.length === 0) return;
    const byKey = new Map<string, ShaftMove[]>();
    for (const move of this.shaftMoves) {
      const list = byKey.get(move.key);
      if (list) list.push(move);
      else byKey.set(move.key, [move]);
    }
    for (const [key, moves] of byKey) {
      const pair = moves[0]!.pair;
      let inflowKg = 0;
      let inflowKT = 0;
      for (const move of moves) {
        const hot = Math.min(Math.max(0, move.hotKg), Math.max(0, move.outKg));
        if (hot > 0) {
          inflowKg += hot;
          inflowKT += hot * move.hotT;
        }
        if (!move.otherActive && move.outKg > 0) {
          if (hot > 0) {
            const soot = move.hotKg > 0 ? move.sootG * (hot / move.hotKg) : 0;
            this.parkShaftHold(move.toRoom, hot, move.hotT, soot, move.hotF * hot, move.hotY * hot);
            // The pressure root already counted this kilogram as leaving. The
            // hold still has it, so the books take it back.
            this.ventNetKg += hot;
          }
          // Whatever did not stay in the hold went into a storey with no
          // layer. That storey is the outdoor air, so the building did lose it.
          this.shellNetKg -= Math.max(0, move.outKg - hot);
        }
        if (move.hotKg > 0) {
          const from = this.shaftFumeTo.get(move.sourceId) ?? new Set<string>();
          from.add(move.destId);
          this.shaftFumeTo.set(move.sourceId, from);
          this.ownShaftRoom(move.toRoom, groups, owned);
        }
      }
      const shaftK = this.shaftK.get(key) ?? AMBIENT_K;
      const width =
        pair.widthM ??
        (pair.kind === 'lift' ? LEVEL.LIFT_DOOR_WIDTH_M : LEVEL.DEFAULT_STAIR_WIDTH_M);
      const height =
        pair.storeyHeightM && pair.storeyHeightM > 0
          ? pair.storeyHeightM
          : this.storeyHeight(levelOf(this.studIndex.get(pair.lower) ?? {}));
      const column = shaftColumnMassKg(shaftK, width, height);
      this.shaftK.set(
        key,
        nextShaftK(shaftK, dt, inflowKg, inflowKg > 0 ? inflowKT / inflowKg : null, column),
      );
      if (pair.kind !== 'stair') continue;
      const landingK = this.shaftK.get(key) ?? AMBIENT_K;
      this.fireSim.applyLandingFlux(pair.upper, blackLayerRadiantKwM2(landingK), dt);
      const fs = this.fireSim.states.get(pair.upper);
      const stud = this.studStates.get(pair.upper);
      if (fs && stud) stud.fire = { ...fs };
    }
  }

  private parkShaftHold(
    room: string,
    massKg: number,
    tempK: number,
    sootG: number,
    fuelKg: number,
    o2Kg: number,
  ): void {
    const prev = this.shaftHold.get(room);
    this.shaftHold.set(room, {
      massKg: (prev?.massKg ?? 0) + massKg,
      enthalpy: (prev?.enthalpy ?? 0) + massKg * tempK,
      sootG: (prev?.sootG ?? 0) + sootG,
      fuelKg: (prev?.fuelKg ?? 0) + fuelKg,
      o2Kg: (prev?.o2Kg ?? 0) + o2Kg,
    });
  }

  /** A hold from the last step joins the layer before this step's gauges. */
  private absorbShaftHolds(walls: InteriorWall[], groups: ReadonlyMap<string, string[]>): void {
    if (this.shaftHold.size === 0) return;
    for (const room of [...this.shaftHold.keys()]) {
      if (this.layerState.get(room)?.active) {
        this.foldShaftHold(room);
        continue;
      }
      const members = groups.get(room) ?? [];
      const level = levelOf(this.studIndex.get(members[0] ?? '') ?? {});
      const ceiling = this.storeyHeight(level);
      const area = Math.max(members.length, 1) * STUD_AREA_M2;
      this.promoteShaftHold(room, members, area, ceiling, walls);
    }
  }

  /** Gas the shaft stored on a storey that has since grown its own layer. */
  private foldShaftHold(room: string): void {
    const hold = this.shaftHold.get(room);
    const live = this.layerState.get(room);
    if (!hold || !(hold.massKg > 0) || !live?.active) return;
    const dest = this.upperGasOf(live);
    const parcel = this.parcelGas(hold, dest.areaM2, dest.ceilingM);
    const mixed = moveUpperGas(parcel, dest, hold.massKg);
    this.writeUpperGas(live, mixed.dest);
    this.shaftHold.delete(room);
  }

  private promoteShaftHold(
    room: string,
    members: readonly string[],
    areaM2: number,
    ceilingM: number,
    walls: InteriorWall[],
  ): void {
    const hold = this.shaftHold.get(room);
    if (!hold || !(hold.massKg > 0) || !(areaM2 > 0) || !(ceilingM > 0)) return;
    const enc = this.enclosureOf(room, members, walls, ceilingM);
    if (!enc || !hasSmokeReservoir(enc.spec.vents, ceilingM)) return;
    const area = enc.spec.areaM2 > 0 ? enc.spec.areaM2 : areaM2;
    const temp = hold.enthalpy / hold.massKg;
    const natural = area > 0 && temp > 0 ? hold.massKg / (shaftDensityKgM3(temp) * area) : 0;
    // Wait for a ceiling slice, not the 12% jet depth. On a large floor that
    // deeper test discards the ambient in the whole band when the parcel
    // becomes the layer.
    if (temp < AMBIENT_K + DISTINCT_LAYER_RISE_K || natural < 0.02) return;
    const gas = this.parcelGas(hold, area, ceilingM);
    const depth = Math.max(0, ceilingM - gas.interfaceM);
    // The parcel takes the place of the ambient air that filled that slice.
    // The outdoor books record the air that left.
    this.shellNetKg -= shaftDensityKgM3(AMBIENT_K) * area * depth;
    const prev = this.layerState.get(room);
    this.layerState.set(room, {
      active: true,
      zone: {
        ...(prev?.zone ?? {
          ageS: 1,
          lowerO2: O2_AMBIENT_MASS,
        }),
        interfaceM: gas.interfaceM,
        upperK: gas.upperK,
        sootG: gas.sootG,
        fuelKg: gas.fuelKg,
        upperO2: gas.upperO2,
        ageS: prev?.zone.ageS ?? 1,
        lowerO2: prev?.zone.lowerO2 ?? O2_AMBIENT_MASS,
      },
      members: members.length > 0 ? [...members] : (prev?.members ?? []),
      areaM2: area,
      ceilingM,
    });
    this.shaftHold.delete(room);
  }

  private ownShaftRoom(
    room: string,
    groups: ReadonlyMap<string, string[]>,
    owned: Set<string>,
  ): void {
    const live = this.layerState.get(room);
    if (!live?.active) return;
    for (const id of live.members.length > 0 ? live.members : (groups.get(room) ?? [])) {
      owned.add(id);
    }
  }

  private upperGasOf(live: {
    zone: {
      interfaceM: number;
      upperK: number;
      sootG: number;
      fuelKg?: number;
      upperO2?: number;
    };
    areaM2: number;
    ceilingM: number;
  }): UpperGas {
    return {
      interfaceM: live.zone.interfaceM,
      upperK: live.zone.upperK,
      sootG: live.zone.sootG,
      fuelKg: live.zone.fuelKg ?? 0,
      upperO2: oxygenMassFraction(live.zone.upperO2),
      areaM2: live.areaM2,
      ceilingM: live.ceilingM,
    };
  }

  private parcelGas(
    hold: { massKg: number; enthalpy: number; sootG: number; fuelKg: number; o2Kg: number },
    areaM2: number,
    ceilingM: number,
  ): UpperGas {
    const temp = hold.massKg > 0 ? hold.enthalpy / hold.massKg : AMBIENT_K;
    const depth = areaM2 > 0 && temp > 0 ? hold.massKg / (shaftDensityKgM3(temp) * areaM2) : 0;
    const z = ceilingM - depth;
    return {
      interfaceM: Math.min(Math.max(z, 0.05), Math.max(0.05, ceilingM - 0.02)),
      upperK: temp,
      sootG: hold.sootG,
      fuelKg: hold.fuelKg,
      upperO2: hold.massKg > 0 ? hold.o2Kg / hold.massKg : O2_AMBIENT_MASS,
      areaM2,
      ceilingM,
    };
  }

  private writeUpperGas(
    live: {
      zone: {
        interfaceM: number;
        upperK: number;
        sootG: number;
        fuelKg?: number;
        upperO2?: number;
      };
    },
    gas: UpperGas,
  ): void {
    live.zone.interfaceM = gas.interfaceM;
    live.zone.upperK = gas.upperK;
    live.zone.sootG = gas.sootG;
    live.zone.fuelKg = gas.fuelKg;
    live.zone.upperO2 = gas.upperO2;
  }

  /** Write the layer onto heads that have reached it, and hand vented soot to the next stud. */
  private commitLayers(owned: ReadonlySet<string>, touch: Set<string>): void {
    for (const id of this.breathIds) {
      const state = this.studStates.get(id);
      if (!state) continue;
      state.oxygenVolumePercent = undefined;
      state.co2VolumePercent = undefined;
      state.headTempC = undefined;
      state.radiantKwM2 = undefined;
    }
    this.breathIds = [];
    const incoming = new Map<string, number>();
    for (const grant of this.layerGrants) {
      if (grant.receivers.length === 0) continue;
      const each = grant.grams / grant.receivers.length;
      for (const id of grant.receivers) {
        if (!this.studStates.has(id)) continue;
        touch.add(id);
        if (owned.has(id)) {
          incoming.set(id, (incoming.get(id) ?? 0) + each);
          continue;
        }
        const volume = Math.max(this.columnVolume(id), 1e-6);
        const k = (this.sootK.get(id) ?? 0) + (SOOT_EXTINCTION_M2_PER_G * each) / volume;
        this.sootK.set(id, k);
      }
    }
    for (const live of this.layerState.values()) {
      if (!live.active) continue;
      let extra = 0;
      for (const id of live.members) extra += incoming.get(id) ?? 0;
      if (extra > 0) live.zone.sootG += extra;
      const depth = Math.max(0.02, live.ceilingM - live.zone.interfaceM);
      const upper = Math.max(live.areaM2 * depth, 1e-6);
      const k = (SOOT_EXTINCTION_M2_PER_G * live.zone.sootG) / upper;
      const atHead = live.zone.interfaceM <= HEAD_HEIGHT_M;
      const breath = layerBreath(
        oxygenMassFraction(atHead ? live.zone.upperO2 : live.zone.lowerO2),
      );
      const radiantKwM2 = blackLayerRadiantKwM2(live.zone.upperK);
      const headK = atHead ? live.zone.upperK : (live.zone.lowerK ?? AMBIENT_K);
      const headTempC = headK - 273.15;
      for (const id of live.members) {
        touch.add(id);
        if (!owned.has(id)) continue;
        // Above the head the person is in the lower layer. A jet-formed
        // layer leaves the soot that was already there. A fire-driven
        // layer still clears the column: it forms before that soot exists.
        // Crossing 1.7 m sets the stud to the layer's soot extinction.
        // The smoke number, written after this, saturates at the visibility
        // scale. The extinction kept here does not: the gas dose reads it.
        // A layer that is already optically thick steps the smoke number
        // to the cap in one frame. That is the sharp interface, not a
        // mixing time. See the FV-4 note.
        if (atHead && k > 0) this.sootK.set(id, k);
        else if (atHead || !this.jetLowerStuds.has(id)) this.sootK.delete(id);
        const state = this.studStates.get(id);
        if (!state) continue;
        state.oxygenVolumePercent = breath.oxygenVolumePercent;
        state.co2VolumePercent = breath.co2VolumePercent;
        state.radiantKwM2 = radiantKwM2;
        if (headTempC != null) state.headTempC = headTempC;
        this.breathIds.push(id);
      }
    }
  }

  private stepSmoke(dt: number, walls: InteriorWall[]) {
    if (!(dt > 0)) return;
    const kMax = extinctionK(1);
    const touch = new Set<string>(this.liveSmoke);
    // Smoke written onto a stud before the first step, as the level tests do,
    // is not in liveSmoke yet. After that the step itself is the only writer,
    // and liveSmoke already lists those studs.
    if (this.liveSmoke.length === 0) {
      for (const [id, state] of this.studStates) {
        if (state.smoke > 0) touch.add(id);
      }
    }
    for (const src of this.fireSim.burningSoot()) touch.add(src.id);

    // Blast smoke stays a smoke number with the old constant loss. It is not
    // the soot of a burning material, so the soot vent below does not take it.
    // Cold studs stay at zero and are not written again.
    const eventD = new Map<string, number>();
    for (const id of touch) {
      const state = this.studStates.get(id);
      if (!state) continue;
      const total = extinctionK(state.smoke);
      let soot = this.sootK.get(id) ?? 0;
      // Below the visibility cap the smoke number is the whole reading, so a
      // lower number lowers the column too. Past the cap the number has
      // saturated and the extra soot stays.
      if (soot <= kMax && soot > total) soot = total;
      if (!(soot > 0)) this.sootK.delete(id);
      else this.sootK.set(id, soot);
      const event = smokeFromK(Math.max(0, total - Math.min(soot, kMax)));
      if (event > 0) eventD.set(id, event);
    }

    for (const [, hs] of this.hazardStates) {
      for (let i = 0; i < hs.nextEventIdx; i++) {
        const event = hs.events[i];
        const rate = SpatialEffectsEngine.SMOKE_RATE[event.smokeGeneration ?? 'none'];
        if (rate <= 0) continue;
        if (!event.affectedStuds?.length) continue;
        for (const sId of event.affectedStuds) {
          if (this.fuelGate && !this.fuelGate.has(sId)) continue;
          if (!this.studStates.has(sId)) continue;
          eventD.set(sId, Math.min(1, (eventD.get(sId) ?? 0) + dt * rate * 0.02));
          touch.add(sId);
        }
      }
    }

    // Previous event decay: 0.002 per second, and four times that again outdoors.
    for (const [id, density] of eventD) {
      if (!(density > 0.02)) continue;
      const src = this.studIndex.get(id);
      let loss = dt * 0.002;
      if (src && src.spatialContext !== 'inside_building') loss += dt * 0.008;
      eventD.set(id, Math.max(0, density - loss));
    }

    // Soot mass becomes extinction in the stud column (NUREG-1805 Eq. 18-2,
    // K = σₘ × soot / volume). Volume is 9 m² times the storey height.
    // The release is the decayed one, so a spray that has cut the fire cuts
    // the smoke with it. A running hood on an active layer is a fan, not a
    // second loss here. A hood whose room has no layer still extracts the
    // IMC flow from its own column. A stud inside a fire-driven layer is
    // cleared: the layer holds that soot. A jet-formed layer keeps soot
    // that was already at head height and leaks it at the usual rate.
    const owned = this.stepLayers(dt, walls);
    const extractM3 = new Map<string, number>();
    for (const id of this.fireSim.hoodColumns(this.hoodFanWhen)) {
      if (owned.has(id)) continue;
      extractM3.set(id, (extractM3.get(id) ?? 0) + HOOD_EXTRACT_M3_PER_S);
    }
    const sootById = new Map<string, number>();
    for (const src of this.fireSim.burningSoot()) {
      sootById.set(src.id, src.sootGPerS);
      touch.add(src.id);
    }
    for (const id of owned) touch.add(id);
    for (const id of this.sootK.keys()) touch.add(id);
    for (const id of touch) {
      if (!this.studStates.has(id)) continue;
      if (owned.has(id) && !this.jetLowerStuds.has(id)) {
        this.sootK.delete(id);
        continue;
      }
      const volume = this.columnVolume(id);
      // New soot of a stud the layer owns belongs in the layer. The column
      // only leaks the head-height soot it already had.
      const generation =
        owned.has(id) && this.jetLowerStuds.has(id)
          ? 0
          : ((sootById.get(id) ?? 0) * SOOT_EXTINCTION_M2_PER_G) / volume;
      const src = this.studIndex.get(id);
      const outdoor = src != null && src.spatialContext !== 'inside_building';
      const leak = SMOKE_LEAK_PER_S * (outdoor ? SMOKE_OUTDOOR_VENT_FACTOR : 1);
      const flow = extractM3.get(id) ?? 0;
      const vent = leak + (flow > 0 ? flow / volume : 0);
      const k = advanceSootK(this.sootK.get(id) ?? 0, generation, vent, dt);
      if (k > 0) this.sootK.set(id, k);
      else this.sootK.delete(id);
    }

    // What leaves a stud is taken off it, in each reservoir.
    this.moveSmoke(eventD, 1, dt, walls, undefined, touch);
    // The soot inventory is not the visibility scale. Sight saturates later,
    // when the smoke number is written.
    this.moveSmoke(this.sootK, Number.POSITIVE_INFINITY, dt, walls, owned, touch);
    this.commitLayers(owned, touch);
    for (const id of this.sootK.keys()) touch.add(id);

    const next: string[] = [];
    for (const id of touch) {
      const state = this.studStates.get(id);
      if (!state) continue;
      const soot = this.sootK.get(id) ?? 0;
      const eventK = extinctionK(eventD.get(id) ?? 0);
      state.smoke = smokeFromK(Math.min(kMax, soot + eventK));
      if (state.smoke > 0 || soot > 0) next.push(id);
    }
    this.liveSmoke = next;
  }

  /** Neighbours on this storey. A shaft moves gas in the layer, not this mix. */
  private moveSmoke(
    field: Map<string, number>,
    cap: number,
    dt: number,
    walls: InteriorWall[],
    skip?: ReadonlySet<string>,
    touch?: Set<string>,
  ): void {
    const froms = this.moveFrom;
    const tos = this.moveTo;
    const fromSlots = this.moveFromSlot;
    const toSlots = this.moveToSlot;
    const ks = this.moveK;
    let n = 0;
    const openShare = dt * SMOKE_EXCHANGE_PER_S;
    const leakShare = openShare * SMOKE_WALL_LEAK;
    const scratch = this.kScratch;
    const was = this.wasInField;
    const present: number[] = [];
    for (const [id, value] of field) {
      const slot = this.smokeSlotOf.get(id);
      if (slot == null) continue;
      scratch[slot] = value;
      was[slot] = 1;
      present.push(slot);
    }
    // The old map held every stud, so positive sources were visited in init
    // order. The live map only keeps the positive keys, in touch order.
    // Emitting in slot order is that same init order, and the sums stay
    // bit-identical.
    const emit = this.smokeEmit;
    emit.length = 0;
    for (const slot of present) {
      if ((scratch[slot] ?? 0) > 0) emit.push(slot);
    }
    emit.sort((a, b) => a - b);
    for (const slot of emit) {
      const value = scratch[slot] ?? 0;
      const id = this.smokeSlots[slot] ?? '';
      if (skip?.has(id) || !this.studIndex.has(id)) continue;
      const neigh = this.smokeNeigh[slot] ?? [];
      const blocked = this.blockRow(slot, walls);
      for (let j = 0; j < neigh.length; j++) {
        const nSlot = neigh[j] ?? 0;
        const nId = this.smokeSlots[nSlot] ?? '';
        if (skip?.has(nId)) continue;
        const other = scratch[nSlot] ?? 0;
        if (!(value > other)) continue;
        const share = blocked[j] === 1 ? leakShare : openShare;
        const moved = (value - other) * share;
        if (moved > 1e-10) {
          froms[n] = id;
          tos[n] = nId;
          fromSlots[n] = slot;
          toSlots[n] = nSlot;
          ks[n] = moved;
          n += 1;
        }
      }
      const holes = this.smokeOpen[slot] ?? 0;
      if (holes > 0) {
        const leaving = value * openShare * holes;
        if (leaving > 1e-10) {
          froms[n] = id;
          tos[n] = '';
          fromSlots[n] = slot;
          toSlots[n] = -1;
          ks[n] = leaving;
          n += 1;
        }
      }
    }
    this.applySmokeMoves(field, n, cap, touch);
    for (const slot of present) {
      scratch[slot] = 0;
      was[slot] = 0;
    }
  }

  /**
   * Same sums as walking the move list with maps: outgoing scale, then the
   * room left under the cap, then the paired add and remove. Map insertion
   * order stays the order of the first write.
   */
  private applySmokeMoves(
    kNow: Map<string, number>,
    n: number,
    kMax: number,
    touch?: Set<string>,
  ): void {
    const froms = this.moveFrom;
    const tos = this.moveTo;
    const fromSlots = this.moveFromSlot;
    const toSlots = this.moveToSlot;
    const ks = this.moveK;
    const sum = this.sumScratch;
    const seen = this.seenScratch;
    const used = this.usedSlots;
    const work = this.kScratch;
    const was = this.wasInField;
    let usedN = 0;
    for (let i = 0; i < n; i++) {
      const slot = fromSlots[i] ?? 0;
      if (seen[slot] === 0) {
        seen[slot] = 1;
        used[usedN] = slot;
        usedN += 1;
      }
      sum[slot] = (sum[slot] ?? 0) + (ks[i] ?? 0);
    }
    for (let i = 0; i < n; i++) {
      const slot = fromSlots[i] ?? 0;
      const available = work[slot] ?? 0;
      const total = sum[slot] ?? 0;
      if (total > available && total > 0) ks[i] = (ks[i] ?? 0) * (available / total);
    }
    for (let u = 0; u < usedN; u++) {
      const slot = used[u] ?? 0;
      seen[slot] = 0;
      sum[slot] = 0;
    }
    const scale = this.scaleScratch;
    usedN = 0;
    for (let i = 0; i < n; i++) {
      const slot = toSlots[i] ?? 0;
      if (slot < 0) continue;
      if (seen[slot] === 0) {
        seen[slot] = 1;
        used[usedN] = slot;
        usedN += 1;
        sum[slot] = 0;
      }
      sum[slot] = (sum[slot] ?? 0) + (ks[i] ?? 0);
    }
    for (let u = 0; u < usedN; u++) {
      const slot = used[u] ?? 0;
      const add = sum[slot] ?? 0;
      const room = kMax - (work[slot] ?? 0);
      scale[slot] = add > room && add > 0 ? Math.max(0, room) / add : 1;
      seen[slot] = 0;
      sum[slot] = 0;
    }
    const appended: number[] = [];
    for (let i = 0; i < n; i++) {
      const toSlot = toSlots[i] ?? 0;
      const fromSlot = fromSlots[i] ?? 0;
      if (toSlot < 0) {
        const moved = ks[i] ?? 0;
        if (!(moved > 0)) continue;
        work[fromSlot] = (work[fromSlot] ?? 0) - moved;
        if (touch) touch.add(froms[i] ?? '');
        continue;
      }
      const moved = (ks[i] ?? 0) * (scale[toSlot] ?? 1);
      if (!(moved > 0)) continue;
      work[fromSlot] = (work[fromSlot] ?? 0) - moved;
      work[toSlot] = Math.min(kMax, (work[toSlot] ?? 0) + moved);
      if (was[fromSlot] === 0 && seen[fromSlot] === 0) {
        seen[fromSlot] = 1;
        appended.push(fromSlot);
      }
      if (was[toSlot] === 0 && seen[toSlot] === 0) {
        seen[toSlot] = 1;
        appended.push(toSlot);
      }
      if (touch) {
        touch.add(froms[i] ?? '');
        touch.add(tos[i] ?? '');
      }
    }
    for (const [id, old] of kNow) {
      const slot = this.smokeSlotOf.get(id);
      if (slot == null) continue;
      const next = work[slot] ?? 0;
      if (next !== old) kNow.set(id, next);
    }
    for (const slot of appended) {
      kNow.set(this.smokeSlots[slot] ?? '', work[slot] ?? 0);
      seen[slot] = 0;
      work[slot] = 0;
    }
    for (const [id, k] of kNow) {
      if (!(k > 1e-10)) kNow.delete(id);
    }
  }

  /**
   * Read the gases off the soot mass already on each stud. The production of
   * the fires whose smoke has reached it only splits that soot among species.
   * A solid wall stops the walk, and so does the outside wall away from an
   * exit. A door gap does not. Another storey is reached through a shaft
   * that has carried gas that way, and only where smoke has arrived.
   * Nothing burning
   * clears the split, including a jet or an arc on its own.
   */
  private stepFumes(walls: InteriorWall[]) {
    for (const id of this.fumeIds) {
      const state = this.studStates.get(id);
      if (state) state.fumes = undefined;
    }
    this.fumeIds = [];
    const sources = [...this.fireSim.fumeSources(), ...this.liningFumes];
    if (sources.length === 0) return;

    // Same-level smoke is an undirected graph, so every fire in one
    // component reaches the same studs. One flood per component replaces
    // a walk from every fire. A shaft carries the split only along a
    // vent that has already moved gas, including back down. A fire whose
    // own stud is still below the smoke threshold is not in a component;
    // it is walked on its own, which is the early fire and not the
    // expensive case.
    const compOf = new Map<string, number>();
    let compCount = 0;
    const stack: string[] = [];
    for (const id of this.liveSmoke) {
      const state = this.studStates.get(id);
      if (!state || !(state.smoke > 0.02) || compOf.has(id)) continue;
      const cid = compCount++;
      stack.push(id);
      compOf.set(id, cid);
      while (stack.length > 0) {
        const cur = stack.pop();
        if (cur == null) continue;
        for (const nId of this.neighborCache.get(cur) ?? []) {
          if (compOf.has(nId) || this.exchangeBlocked(cur, nId, walls)) continue;
          const next = this.studStates.get(nId);
          if (!next || !(next.smoke > 0.02)) continue;
          compOf.set(nId, cid);
          stack.push(nId);
        }
      }
    }

    const compGrams: FumeGrams[] = [];
    const compSoot: number[] = [];
    for (let i = 0; i < compCount; i++) {
      compGrams.push({});
      compSoot.push(0);
    }
    const lone: Array<{ id: string; gramsPerS: FumeGrams; sootGPerS: number }> = [];
    for (const source of sources) {
      const cid = compOf.get(source.id);
      if (cid == null) {
        lone.push(source);
        continue;
      }
      addFumeGrams(compGrams[cid], source.gramsPerS);
      compSoot[cid] += source.sootGPerS;
    }

    const outgoing = new Map<number, number[]>();
    const linked = new Set<string>();
    for (const [from, tos] of this.shaftFumeTo) {
      const src = compOf.get(from);
      if (src == null) continue;
      for (const to of tos) {
        const dst = compOf.get(to);
        if (dst == null || dst === src) continue;
        const key = `${src}>${dst}`;
        if (linked.has(key)) continue;
        linked.add(key);
        const list = outgoing.get(src);
        if (list) list.push(dst);
        else outgoing.set(src, [dst]);
      }
    }
    // Each component's own production is added once to every component
    // its shaft has carried gas into, including through another storey.
    const ownGrams = compGrams.map((grams) => ({ ...grams }));
    const ownSoot = compSoot.slice();
    for (let cid = 0; cid < compCount; cid++) {
      const seen = new Set<number>();
      const walk = [cid];
      while (walk.length > 0) {
        const cur = walk.pop();
        if (cur == null) continue;
        for (const upper of outgoing.get(cur) ?? []) {
          if (seen.has(upper)) continue;
          seen.add(upper);
          addFumeGrams(compGrams[upper], ownGrams[cid]);
          compSoot[upper] += ownSoot[cid];
          walk.push(upper);
        }
      }
    }

    const totals = new Map<string, { grams: FumeGrams; soot: number }>();
    const pour = (id: string, gramsPerS: FumeGrams, sootGPerS: number) => {
      const bucket = totals.get(id);
      if (bucket) {
        addFumeGrams(bucket.grams, gramsPerS);
        bucket.soot += sootGPerS;
        return;
      }
      const grams: FumeGrams = {};
      addFumeGrams(grams, gramsPerS);
      totals.set(id, { grams, soot: sootGPerS });
    };
    for (const [id, cid] of compOf) pour(id, compGrams[cid], compSoot[cid]);

    for (const source of lone) {
      const seen = new Set<string>();
      const walk = [source.id];
      while (walk.length > 0) {
        const id = walk.pop();
        if (id == null || seen.has(id)) continue;
        seen.add(id);
        const state = this.studStates.get(id);
        if (!state) continue;
        const origin = id === source.id;
        if (!origin && !(state.smoke > 0.02)) continue;
        pour(id, source.gramsPerS, source.sootGPerS);
        for (const nextId of this.neighborCache.get(id) ?? []) {
          if (seen.has(nextId) || this.exchangeBlocked(id, nextId, walls)) continue;
          const next = this.studStates.get(nextId);
          if (next && next.smoke > 0.02) walk.push(nextId);
        }
        for (const nextId of this.shaftFumeTo.get(id) ?? []) {
          const next = this.studStates.get(nextId);
          if (next && next.smoke > 0.02) walk.push(nextId);
        }
      }
    }

    for (const [id, bucket] of totals) {
      const state = this.studStates.get(id);
      if (!state || !(state.smoke > 0)) continue;
      const ppm = fumesFromExtinction(this.sootK.get(id) ?? 0, bucket.grams, bucket.soot);
      let any = false;
      for (const value of Object.values(ppm)) {
        if (value != null && value > 0) any = true;
      }
      if (any) {
        state.fumes = ppm;
        this.fumeIds.push(id);
      }
    }
  }

  runPreview(
    seconds: number,
    walls: InteriorWall[],
    hazards: HazardZone[],
    stepSize = 1,
  ): Map<string, StudEffectState> {
    const steps = Math.ceil(seconds / stepSize);
    for (let i = 0; i < steps; i++) {
      this.step(stepSize, walls, hazards);
    }
    return new Map(this.studStates);
  }

  getStats() {
    let fireNone = 0,
      fireHeating = 0,
      fireBurning = 0,
      fireBurnt = 0;
    let gasAffected = 0,
      floodAffected = 0,
      structAffected = 0,
      smokeAffected = 0;

    for (const s of this.studStates.values()) {
      switch (s.fire.state) {
        case 'none':
          fireNone++;
          break;
        case 'heating':
          fireHeating++;
          break;
        case 'burning':
          fireBurning++;
          break;
        case 'burnt_out':
          fireBurnt++;
          break;
      }
      if (s.gas > 0.05) gasAffected++;
      if (s.flood > 0.05) floodAffected++;
      if (s.structural > 0.05) structAffected++;
      if (s.smoke > 0.05) smokeAffected++;
    }

    return {
      total: this.studStates.size,
      fire: { none: fireNone, heating: fireHeating, burning: fireBurning, burntOut: fireBurnt },
      gasAffected,
      floodAffected,
      structAffected,
      smokeAffected,
    };
  }
}
