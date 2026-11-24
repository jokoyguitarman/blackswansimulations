import type { ExitDef, Vec2 } from '../evacuation/types';
import type { InteriorWall, HazardZone } from './types';
import {
  FireSimulation,
  type FireSimStud,
  type FireStudState,
  type FireParams,
  type GasJet,
} from './fireSimulation';
import {
  GAS_JET_KW,
  STUD_AREA_M2,
  electricalHeatReleaseKw,
  type FuelCell,
} from './flameFront';
import {
  AMBIENT_K,
  CEILING_JET_DEPTH_FRACTION,
  DISTINCT_LAYER_RISE_K,
  HEAD_HEIGHT_M,
  HOOD_EXTRACT_M3_PER_S,
  HOOD_FAN_WHEN,
  HOOD_INTAKE_M,
  LAYER_OFF_FRACTION,
  MIN_LAYER_FIRE_KW,
  diameterForReleaseKw,
  enclosureFromGrid,
  type FacadeOpening,
  formsSustainedLayer,
  freshLayer,
  hasSmokeReservoir,
  oxygenLimitedBurn,
  oxygenMassFraction,
  steadyLayer,
  stepZone,
  type Enclosure,
  type FirePlume,
  type GridStud,
  type MechanicalVent,
  type GridWall,
  type HoodFanWhen,
  type LayerSpec,
  type ZoneState,
} from './twoZone';
import type { ChargeSpec } from './blast/blastModel';
import type { ElectricalPlacement, GasLinePlacement, SuppressionPlacement } from './materialLibrary';
import { LEVEL } from '../evacuation/levelConstants';
import { levelOf, neighborIdsByLevel, shaftPairs, type ShaftLink, type ShaftPair } from './levels';
import { addFumeGrams, fumesFromSmoke, layerBreath, SOOT_EXTINCTION_M2_PER_G, type FumeGrams } from './toxicDose';
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

/** Solid wall, including the outside wall. A door or an exit uses the full exchange. Assumed. */
export const SMOKE_WALL_LEAK = 0.05;

/**
 * Exact step of dK/dt = generation − vent·K. The loss is first-order, so a
 * fixed slice and a longer frame cut into the same slices agree.
 */
export function advanceSootK(k: number, generationPerS: number, ventPerS: number, dt: number): number {
  if (!(dt > 0)) return Math.max(0, k);
  const gen = generationPerS > 0 ? generationPerS : 0;
  const vent = ventPerS > 0 ? ventPerS : 0;
  if (!(vent > 0)) return Math.max(0, k + gen * dt);
  const decay = Math.exp(-vent * dt);
  return Math.max(0, k * decay + (gen / vent) * (1 - decay));
}

function applySmokeMoves(
  kNow: Map<string, number>,
  moves: Array<{ from: string; to: string; k: number }>,
  kMax: number,
): void {
  const out = new Map<string, number>();
  for (const move of moves) out.set(move.from, (out.get(move.from) ?? 0) + move.k);
  for (const move of moves) {
    const available = kNow.get(move.from) ?? 0;
    const total = out.get(move.from) ?? 0;
    if (total > available && total > 0) move.k *= available / total;
  }
  const incoming = new Map<string, number>();
  for (const move of moves) incoming.set(move.to, (incoming.get(move.to) ?? 0) + move.k);
  const roomScale = new Map<string, number>();
  for (const [id, add] of incoming) {
    const room = kMax - (kNow.get(id) ?? 0);
    roomScale.set(id, add > room && add > 0 ? Math.max(0, room) / add : 1);
  }
  for (const move of moves) {
    const moved = move.k * (roomScale.get(move.to) ?? 1);
    if (!(moved > 0)) continue;
    kNow.set(move.from, (kNow.get(move.from) ?? 0) - moved);
    kNow.set(move.to, Math.min(kMax, (kNow.get(move.to) ?? 0) + moved));
  }
  for (const [id, k] of kNow) {
    if (!(k > 1e-10)) kNow.set(id, 0);
  }
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
  if (wall.hasDoor) {
    const dx = wall.end.x - wall.start.x;
    const dy = wall.end.y - wall.start.y;
    const len = Math.hypot(dx, dy);
    if (len < 0.01) return false;
    const doorCenter = wall.doorPosition;
    const doorHalf = wall.doorWidth / (2 * len);
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
  private verticalPairs: ShaftPair[] = [];
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
  /** Wall tests for one walls array. Rebuilt when the caller passes another array. */
  private blockedWalls: InteriorWall[] | null = null;
  private blockedNeighbors = new Map<string, Set<string>>();
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
  private layerShellKey = '';
  private layerGridWalls: GridWall[] = [];
  private layerGrants: Array<{ receivers: string[]; grams: number }> = [];

  constructor(fireParams?: FireParams, timeScale = 1) {
    this.timeScale = timeScale;
    this.fireSim = new FireSimulation(fireParams);
  }

  init(studs: FireSimStud[]) {
    this.studIndex.clear();
    this.studStates.clear();
    this.neighborCache.clear();
    this.verticalPairs = [];
    this.sootK.clear();
    this.blockedWalls = null;
    this.blockedNeighbors.clear();
    this.shellReady = false;
    this.shellBlocked.clear();
    this.gridStuds.clear();
    this.layerState.clear();
    this.layerEnclosures.clear();
    this.layerWalls = null;
    this.layerGrants = [];
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

    this.fireSim.init(studs);
  }

  /**
   * Shaft pairs for stairs and lifts. `widthM` and `heightByLevel` are optional;
   * omitted values use the 1.2 m stair and the 4 m storey.
   */
  setVerticalLinks(links: ShaftLink[]) {
    this.verticalPairs = shaftPairs([...this.studIndex.values()], links);
    this.fireSim.setShaftPairs(this.verticalPairs);
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
  private wallBlocked(id: string, neighborId: string, walls: InteriorWall[]): boolean {
    if (walls.length === 0) return false;
    if (walls !== this.blockedWalls) {
      this.blockedWalls = walls;
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

  private enclosureOf(
    room: string,
    members: readonly string[],
    walls: InteriorWall[],
    ceiling: number,
  ): Enclosure | null {
    const heights = [...this.storeyHeights.entries()].map(([id, height]) => `${id}=${height}`).join(',');
    if (walls !== this.layerWalls || heights !== this.layerHeightKey || this.shellKey !== this.layerShellKey) {
      this.layerWalls = walls;
      this.layerHeightKey = heights;
      this.layerShellKey = this.shellKey;
      this.layerEnclosures.clear();
      this.layerGridWalls = walls.map((wall) => ({
        id: wall.id,
        x1: wall.start.x,
        y1: wall.start.y,
        x2: wall.end.x,
        y2: wall.end.y,
        hasDoor: wall.hasDoor,
        doorWidth: wall.doorWidth,
        doorPosition: wall.doorPosition,
        material: wall.material,
        level: levelOf(wall),
      }));
    }
    const key = `${room}@${ceiling}`;
    if (this.layerEnclosures.has(key)) return this.layerEnclosures.get(key) ?? null;
    const found = enclosureFromGrid(
      members,
      this.gridStuds,
      this.neighborCache,
      this.layerGridWalls,
      ceiling,
      (memberId, outsideId) => this.facadeAt(memberId, outsideId),
    );
    this.layerEnclosures.set(key, found);
    return found;
  }

  /** Put a retiring layer back into the columns, so the soot is not deleted. */
  private dumpLayer(
    members: readonly string[],
    zone: ZoneState,
    areaM2: number,
    ceilingM: number,
    kMax: number,
  ): void {
    const volume = Math.max(areaM2 * ceilingM, 1e-6);
    let k = (SOOT_EXTINCTION_M2_PER_G * zone.sootG) / volume;
    if (k > kMax) k = kMax;
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
  private stepLayers(dt: number, walls: InteriorWall[], kMax: number): Set<string> {
    const owned = new Set<string>();
    this.layerGrants = [];
    this.fireSim.clearBurnLimits();
    const rooms = this.fireSim.compartmentIds(walls);
    const groups = new Map<string, string[]>();
    for (const [id, room] of rooms) {
      const list = groups.get(room);
      if (list) list.push(id);
      else groups.set(room, [id]);
    }

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

    for (const [room, members] of groups) {
      seen.add(room);
      const ceiling = this.storeyHeight(this.gridStuds.get(members[0] ?? '')?.level ?? 'G');
      const fires: FirePlume[] = [...(extra.get(room) ?? [])];
      for (const id of members) {
        const release = this.fireSim.fuelReleaseKw(id);
        if (release != null && release > 0) fires.push({ heatKw: release, diameterM: diameterForReleaseKw(release) });
      }
      let heat = 0;
      for (const fire of fires) heat += fire.heatKw;
      const prev = this.layerState.get(room);
      const retire = () => {
        if (!prev?.active) return;
        this.dumpLayer(prev.members, prev.zone, prev.areaM2, prev.ceilingM, kMax);
        prev.active = false;
      };
      if (heat < MIN_LAYER_FIRE_KW && !prev?.active) {
        retire();
        continue;
      }
      const enc = this.enclosureOf(room, members, walls, ceiling);
      if (!enc || !hasSmokeReservoir(enc.spec.vents, ceiling)) {
        retire();
        continue;
      }
      const memberSet = new Set(members);
      const fans: MechanicalVent[] = [];
      for (const id of this.fireSim.hoodColumns(this.hoodFanWhen)) {
        if (!memberSet.has(id)) continue;
        fans.push({ flowM3PerS: HOOD_EXTRACT_M3_PER_S, intakeM: HOOD_INTAKE_M });
      }
      const spec: LayerSpec = { ...enc.spec, fires, fans };
      const zone = prev?.zone ?? freshLayer(ceiling);
      const opening = oxygenLimitedBurn(
        spec,
        zone.interfaceM,
        zone.upperK,
        oxygenMassFraction(zone.lowerO2),
        oxygenMassFraction(zone.upperO2),
        dt,
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
      const active = hold || formsSustainedLayer(depth, ceiling, rise, true);
      if (!active) {
        retire();
        this.layerState.set(room, {
          active: false,
          zone,
          members,
          areaM2: spec.areaM2,
          ceilingM: ceiling,
        });
        if (opening.prescribedKw > 0) this.fireSim.setBurnLimit(members, opening.fraction, opening.phi);
        continue;
      }
      if (prev?.active !== true) {
        let carried = zone.sootG;
        for (const id of members) {
          carried += ((this.sootK.get(id) ?? 0) * this.columnVolume(id)) / SOOT_EXTINCTION_M2_PER_G;
        }
        zone.sootG = carried;
      }
      const stepped = stepZone(zone, spec, dt, sootByRoom.get(room) ?? 0);
      this.layerState.set(room, {
        active: true,
        zone: stepped.state,
        members,
        areaM2: spec.areaM2,
        ceilingM: ceiling,
      });
      for (const id of members) owned.add(id);
      this.fireSim.setBurnLimit(members, stepped.burnedFraction, stepped.phi);
      if (stepped.ventedSootG > 0) {
        const shares = stepped.outByVentKgS;
        let totalOut = 0;
        for (const share of shares) totalOut += share;
        if (totalOut > 0) {
          for (let i = 0; i < shares.length; i++) {
            const share = shares[i] ?? 0;
            const receivers = enc.ventReceivers[i] ?? [];
            // No receiver means the soot left through the opening and is
            // not painted onto the studs along the outside wall.
            if (!(share > 0) || receivers.length === 0) continue;
            this.layerGrants.push({
              receivers,
              grams: stepped.ventedSootG * (share / totalOut),
            });
          }
        }
      }
    }

    for (const [room, live] of this.layerState) {
      if (seen.has(room) || !live.active) continue;
      this.dumpLayer(live.members, live.zone, live.areaM2, live.ceilingM, kMax);
      live.active = false;
    }
    return owned;
  }

  /** Write the layer onto heads that have reached it, and hand vented soot to the next stud. */
  private commitLayers(owned: ReadonlySet<string>, kMax: number): void {
    for (const state of this.studStates.values()) {
      state.oxygenVolumePercent = undefined;
      state.co2VolumePercent = undefined;
    }
    const incoming = new Map<string, number>();
    for (const grant of this.layerGrants) {
      if (grant.receivers.length === 0) continue;
      const each = grant.grams / grant.receivers.length;
      for (const id of grant.receivers) {
        if (!this.studStates.has(id)) continue;
        if (owned.has(id)) {
          incoming.set(id, (incoming.get(id) ?? 0) + each);
          continue;
        }
        const volume = Math.max(this.columnVolume(id), 1e-6);
        let k = (this.sootK.get(id) ?? 0) + (SOOT_EXTINCTION_M2_PER_G * each) / volume;
        if (k > kMax) k = kMax;
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
      let k = (SOOT_EXTINCTION_M2_PER_G * live.zone.sootG) / upper;
      if (k > kMax) k = kMax;
      const atHead = live.zone.interfaceM <= HEAD_HEIGHT_M;
      const breath = layerBreath(
        oxygenMassFraction(atHead ? live.zone.upperO2 : live.zone.lowerO2),
      );
      for (const id of live.members) {
        if (!owned.has(id)) continue;
        this.sootK.set(id, atHead ? k : 0);
        const state = this.studStates.get(id);
        if (!state) continue;
        state.oxygenVolumePercent = breath.oxygenVolumePercent;
        state.co2VolumePercent = breath.co2VolumePercent;
      }
    }
  }

  private stepSmoke(dt: number, walls: InteriorWall[]) {
    if (!(dt > 0)) return;
    const kMax = extinctionK(1);

    // Blast smoke stays a smoke number with the old constant loss. It is not
    // the soot of a burning material, so the soot vent below does not take it.
    const eventD = new Map<string, number>();
    for (const [id, state] of this.studStates) {
      const total = extinctionK(state.smoke);
      let soot = this.sootK.get(id) ?? 0;
      if (soot > total) soot = total;
      if (!(soot > 0)) soot = 0;
      this.sootK.set(id, soot);
      eventD.set(id, smokeFromK(Math.max(0, total - soot)));
    }

    for (const [, hs] of this.hazardStates) {
      for (let i = 0; i < hs.nextEventIdx; i++) {
        const event = hs.events[i];
        const rate = SpatialEffectsEngine.SMOKE_RATE[event.smokeGeneration ?? 'none'];
        if (rate <= 0) continue;
        if (!event.affectedStuds?.length) continue;
        for (const sId of event.affectedStuds) {
          if (this.fuelGate && !this.fuelGate.has(sId)) continue;
          if (!eventD.has(sId)) continue;
          eventD.set(sId, Math.min(1, (eventD.get(sId) ?? 0) + dt * rate * 0.02));
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
    // IMC flow from its own column. A stud inside an active layer is
    // skipped: the layer holds that soot, and the column must not make a
    // second copy or leak it through the wall.
    const owned = this.stepLayers(dt, walls, kMax);
    const extractM3 = new Map<string, number>();
    for (const id of this.fireSim.hoodColumns(this.hoodFanWhen)) {
      if (owned.has(id)) continue;
      extractM3.set(id, (extractM3.get(id) ?? 0) + HOOD_EXTRACT_M3_PER_S);
    }
    const sootById = new Map<string, number>();
    for (const src of this.fireSim.burningSoot()) sootById.set(src.id, src.sootGPerS);
    for (const id of this.studStates.keys()) {
      if (owned.has(id)) {
        this.sootK.set(id, 0);
        continue;
      }
      const volume = this.columnVolume(id);
      const generation = ((sootById.get(id) ?? 0) * SOOT_EXTINCTION_M2_PER_G) / volume;
      const src = this.studIndex.get(id);
      const outdoor = src != null && src.spatialContext !== 'inside_building';
      const leak = SMOKE_LEAK_PER_S * (outdoor ? SMOKE_OUTDOOR_VENT_FACTOR : 1);
      const flow = extractM3.get(id) ?? 0;
      const vent = leak + (flow > 0 ? flow / volume : 0);
      let k = advanceSootK(this.sootK.get(id) ?? 0, generation, vent, dt);
      if (k > kMax) k = kMax;
      this.sootK.set(id, k);
    }

    // What leaves a stud is taken off it, in each reservoir.
    this.moveSmoke(eventD, 1, dt, walls);
    this.moveSmoke(this.sootK, kMax, dt, walls, owned);
    this.commitLayers(owned, kMax);

    for (const [id, state] of this.studStates) {
      let soot = this.sootK.get(id) ?? 0;
      let eventK = extinctionK(eventD.get(id) ?? 0);
      const sum = soot + eventK;
      if (sum > kMax && sum > 0) {
        const scale = kMax / sum;
        soot *= scale;
        eventK *= scale;
        this.sootK.set(id, soot);
      }
      state.smoke = smokeFromK(Math.min(kMax, soot + eventK));
    }
  }

  /** Neighbours and the shaft above. The amount added is the amount removed. */
  private moveSmoke(
    field: Map<string, number>,
    cap: number,
    dt: number,
    walls: InteriorWall[],
    skip?: ReadonlySet<string>,
  ): void {
    const moves: Array<{ from: string; to: string; k: number }> = [];
    for (const [id, value] of field) {
      if (!(value > 0) || skip?.has(id)) continue;
      const src = this.studIndex.get(id);
      if (!src) continue;
      for (const nId of this.neighborCache.get(id) ?? []) {
        if (skip?.has(nId)) continue;
        const dest = this.studIndex.get(nId);
        if (!dest) continue;
        const other = field.get(nId) ?? 0;
        if (!(value > other)) continue;
        const blocked = this.exchangeBlocked(id, nId, walls);
        const share = dt * SMOKE_EXCHANGE_PER_S * (blocked ? SMOKE_WALL_LEAK : 1);
        const moved = (value - other) * share;
        if (moved > 1e-10) moves.push({ from: id, to: nId, k: moved });
      }
    }
    for (const pair of this.verticalPairs) {
      if (skip?.has(pair.lower) || skip?.has(pair.upper)) continue;
      const lower = field.get(pair.lower) ?? 0;
      const upper = field.get(pair.upper) ?? 0;
      if (!(lower > upper) || !field.has(pair.lower) || !field.has(pair.upper)) continue;
      const moved = (lower - upper) * Math.min(0.5, pair.coeffPerS * dt);
      if (moved > 1e-10) moves.push({ from: pair.lower, to: pair.upper, k: moved });
    }
    applySmokeMoves(field, moves, cap);
  }

  /**
   * Read the gases off the smoke already on each stud. The production of the
   * fires whose smoke has reached it only splits that soot among species.
   * A solid wall stops the walk, and so does the outside wall away from an
   * exit. A door gap does not. Another storey is
   * reached only up a shaft, and only where smoke has risen. Nothing burning
   * clears the split, including a jet or an arc on its own.
   */
  private stepFumes(walls: InteriorWall[]) {
    for (const state of this.studStates.values()) state.fumes = undefined;
    const sources = this.fireSim.fumeSources();
    if (sources.length === 0) return;

    const upward = new Map<string, string[]>();
    for (const pair of this.verticalPairs) {
      const list = upward.get(pair.lower);
      if (list) list.push(pair.upper);
      else upward.set(pair.lower, [pair.upper]);
    }

    // Same-level smoke is an undirected graph, so every fire in one
    // component reaches the same studs. One flood per component replaces
    // a walk from every fire. Shafts only go up, so those sums move up
    // after the components are known. A fire whose own stud is still
    // below the smoke threshold is not in a component; it is walked on
    // its own, which is the early fire and not the expensive case.
    const compOf = new Map<string, number>();
    let compCount = 0;
    const stack: string[] = [];
    for (const [id, state] of this.studStates) {
      if (!(state.smoke > 0.02) || compOf.has(id)) continue;
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
    for (const pair of this.verticalPairs) {
      const lower = compOf.get(pair.lower);
      const upper = compOf.get(pair.upper);
      if (lower == null || upper == null || lower === upper) continue;
      const key = `${lower}>${upper}`;
      if (linked.has(key)) continue;
      linked.add(key);
      const list = outgoing.get(lower);
      if (list) list.push(upper);
      else outgoing.set(lower, [upper]);
    }
    // Each lower component's own production is added once to every
    // component it can reach upward, including through another storey.
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
        for (const upperId of upward.get(id) ?? []) {
          const upper = this.studStates.get(upperId);
          if (upper && upper.smoke > 0.02) walk.push(upperId);
        }
      }
    }

    for (const [id, bucket] of totals) {
      const state = this.studStates.get(id);
      if (!state || !(state.smoke > 0)) continue;
      const ppm = fumesFromSmoke(state.smoke, bucket.grams, bucket.soot);
      let any = false;
      for (const value of Object.values(ppm)) {
        if (value != null && value > 0) any = true;
      }
      if (any) state.fumes = ppm;
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
