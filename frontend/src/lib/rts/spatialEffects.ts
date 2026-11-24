import type { Vec2 } from '../evacuation/types';
import type { InteriorWall, HazardZone } from './types';
import {
  FireSimulation,
  type FireSimStud,
  type FireStudState,
  type FireParams,
  type GasJet,
} from './fireSimulation';
import { STUD_AREA_M2, type FuelCell } from './flameFront';
import type { ChargeSpec } from './blast/blastModel';
import type { ElectricalPlacement, GasLinePlacement, SuppressionPlacement } from './materialLibrary';
import { LEVEL } from '../evacuation/levelConstants';
import { levelOf, neighborIdsByLevel, shaftPairs, type ShaftLink, type ShaftPair } from './levels';
import { addFumeGrams, fumesFromSmoke, SOOT_EXTINCTION_M2_PER_G, type FumeGrams } from './toxicDose';
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
 * Wet-chemical hood exhaust, assumed, of order 1 m³/s per hood. It is
 * applied to the stud that hood is mounted on, and only while the hood is
 * discharging. The loss rate is this flow divided by that stud's column.
 * A sprinkler is not an exhaust.
 */
export const HOOD_EXTRACT_M3_PER_S = 1;

/**
 * Share of the extinction difference a neighbour takes per second, assumed.
 * The amount added to the neighbour is taken off the source.
 */
export const SMOKE_EXCHANGE_PER_S = 0.025;

/** Solid wall. A door gap uses the full exchange. Assumed. */
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
  /** Null keeps blast smoke on every affected stud. A set limits that source to fuel. */
  private fuelGate: Set<string> | null = null;
  /** Extinction from burning soot, kept apart from blast-event smoke. */
  private sootK = new Map<string, number>();
  /** Wall tests for one walls array. Rebuilt when the caller passes another array. */
  private blockedWalls: InteriorWall[] | null = null;
  private blockedNeighbors = new Map<string, Set<string>>();

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
    this.activeEffects = [];
    this.elapsed = 0;

    for (const s of studs) {
      this.studIndex.set(s.id, s);
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

  /** Floor area times the storey height. Basements use the basement height. */
  private columnVolume(id: string): number {
    const stud = this.studIndex.get(id);
    const level = stud ? levelOf(stud) : 'G';
    const height = level.startsWith('B')
      ? LEVEL.DEFAULT_BASEMENT_HEIGHT_M
      : LEVEL.DEFAULT_STOREY_HEIGHT_M;
    return STUD_AREA_M2 * height;
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
    // the smoke with it. An open hood adds its exhaust on its own stud.
    const extractM3 = new Map<string, number>();
    for (const id of this.fireSim.hoodColumns()) {
      extractM3.set(id, (extractM3.get(id) ?? 0) + HOOD_EXTRACT_M3_PER_S);
    }
    const sootById = new Map<string, number>();
    for (const src of this.fireSim.burningSoot()) sootById.set(src.id, src.sootGPerS);
    for (const id of this.studStates.keys()) {
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
    this.moveSmoke(this.sootK, kMax, dt, walls);

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
  ): void {
    const moves: Array<{ from: string; to: string; k: number }> = [];
    for (const [id, value] of field) {
      if (!(value > 0)) continue;
      const src = this.studIndex.get(id);
      if (!src) continue;
      for (const nId of this.neighborCache.get(id) ?? []) {
        const dest = this.studIndex.get(nId);
        if (!dest) continue;
        const other = field.get(nId) ?? 0;
        if (!(value > other)) continue;
        const blocked = this.wallBlocked(id, nId, walls);
        const share = dt * SMOKE_EXCHANGE_PER_S * (blocked ? SMOKE_WALL_LEAK : 1);
        const moved = (value - other) * share;
        if (moved > 1e-10) moves.push({ from: id, to: nId, k: moved });
      }
    }
    for (const pair of this.verticalPairs) {
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
   * A solid wall stops the walk. A door gap does not. Another storey is
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
          if (compOf.has(nId) || this.wallBlocked(cur, nId, walls)) continue;
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
          if (seen.has(nextId) || this.wallBlocked(id, nextId, walls)) continue;
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
