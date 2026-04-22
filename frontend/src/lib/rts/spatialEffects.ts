import type { Vec2 } from '../evacuation/types';
import type { InteriorWall, HazardZone } from './types';
import {
  FireSimulation,
  type FireSimStud,
  type FireStudState,
  type FireParams,
} from './fireSimulation';

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

function isWallBlocked(from: Vec2, to: Vec2, walls: InteriorWall[]): boolean {
  for (const w of walls) {
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

// ── Main engine ──────────────────────────────────────────────────────────

export class SpatialEffectsEngine {
  studStates: Map<string, StudEffectState> = new Map();
  hazardStates: Map<string, HazardRuntimeState> = new Map();
  activeEffects: ActiveEffect[] = [];
  elapsed = 0;
  timeScale = 0.5;

  private studIndex: Map<string, FireSimStud> = new Map();
  private neighborCache: Map<string, string[]> = new Map();
  private fireSim: FireSimulation;

  constructor(fireParams?: FireParams, timeScale = 0.5) {
    this.timeScale = timeScale;
    this.fireSim = new FireSimulation(fireParams);
  }

  init(studs: FireSimStud[]) {
    this.studIndex.clear();
    this.studStates.clear();
    this.neighborCache.clear();
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

    for (const s of studs) {
      const neighbors: string[] = [];
      for (const other of studs) {
        if (other.id === s.id) continue;
        if (
          Math.hypot(other.simPos.x - s.simPos.x, other.simPos.y - s.simPos.y) <= NEIGHBOR_RADIUS
        ) {
          neighbors.push(other.id);
        }
      }
      this.neighborCache.set(s.id, neighbors);
    }

    this.fireSim.init(studs);
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

    this.processHazardEvents(hazards);
    this.stepFire(simDt, walls, hazards);
    this.stepGas(simDt, walls);
    this.stepFlood(simDt, walls);
    this.stepStructural(simDt);
    this.stepSmoke(simDt, walls);
  }

  private processHazardEvents(hazards: HazardZone[]) {
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
            this.fireSim.igniteRadius(origin, event.spreadRadius);
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

    for (const [id, fs] of this.fireSim.states) {
      const state = this.studStates.get(id);
      if (state) {
        state.fire = { ...fs };
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

          const blocked = isWallBlocked(src.simPos, dest.simPos, walls);
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

  private stepSmoke(dt: number, walls: InteriorWall[]) {
    // Generate smoke from active fires and smoke-producing events
    for (const [id, state] of this.studStates) {
      if (state.fire.state === 'burning') {
        state.smoke = Math.min(1, state.smoke + dt * 0.03);
      }
    }

    for (const [, hs] of this.hazardStates) {
      for (let i = 0; i < hs.nextEventIdx; i++) {
        const event = hs.events[i];
        const rate = SpatialEffectsEngine.SMOKE_RATE[event.smokeGeneration ?? 'none'];
        if (rate <= 0) continue;

        if (event.affectedStuds?.length) {
          for (const sId of event.affectedStuds) {
            const s = this.studStates.get(sId);
            if (s) s.smoke = Math.min(1, s.smoke + dt * rate * 0.02);
          }
        }
      }
    }

    // Spread smoke between neighbors (passes through doors, partially blocked by solid walls)
    const spreadAmount = dt * 0.025;
    const toSpread: Array<{ id: string; amount: number }> = [];

    for (const [id, state] of this.studStates) {
      if (state.smoke > 0.02) {
        const src = this.studIndex.get(id);
        if (!src) continue;
        const neighbors = this.neighborCache.get(id) ?? [];

        for (const nId of neighbors) {
          const nState = this.studStates.get(nId);
          const dest = this.studIndex.get(nId);
          if (!nState || !dest) continue;
          if (nState.smoke >= state.smoke) continue;

          const blocked = isWallBlocked(src.simPos, dest.simPos, walls);
          const transfer = blocked ? spreadAmount * 0.05 : spreadAmount;
          const diff = (state.smoke - nState.smoke) * transfer;
          if (diff > 0.001) {
            toSpread.push({ id: nId, amount: diff });
          }
        }

        // Slow decay; faster outdoors where smoke disperses
        const decayRate = dt * 0.002;
        state.smoke = Math.max(0, state.smoke - decayRate);
        if (src.spatialContext !== 'inside_building') {
          state.smoke = Math.max(0, state.smoke - decayRate * 4);
        }
      }
    }

    for (const { id, amount } of toSpread) {
      const s = this.studStates.get(id);
      if (s) s.smoke = Math.min(1, s.smoke + amount);
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
