/**
 * Server-side deterministic environmental simulation.
 *
 * Replicates the core logic of the frontend SpatialEffectsEngine / FireSimulation
 * for batch snapshot generation. Self-contained — no frontend imports.
 *
 * Given studs (in sim-space meters), walls, hazards, and per-hazard AI-produced
 * HazardEvent arrays, this steps the simulation at 1-second resolution and captures
 * EnvironmentalSnapshot objects at specified time marks.
 */

import { logger } from '../lib/logger.js';
import type {
  EnvironmentalSnapshot,
  StudEnvironmentalEffect,
  HazardEvent,
  HazardAnalysis,
  SmokeGeneration,
} from './rtsSceneEnrichmentService.js';

// ── Minimal types for the simulation ────────────────────────────────────

interface Vec2 {
  x: number;
  y: number;
}

export interface SimStud {
  id: string;
  simPos: Vec2;
  spatialContext: string | null;
}

export interface SimWall {
  start: Vec2;
  end: Vec2;
  hasDoor: boolean;
  doorWidth: number;
  doorPosition: number;
  material: string;
}

export interface SimHazard {
  id: string;
  pos: Vec2;
  radius: number;
  hazardType: string;
}

// ── Fire state types ────────────────────────────────────────────────────

type FireState = 'none' | 'heating' | 'burning' | 'burnt_out';

interface FireStudState {
  state: FireState;
  timer: number;
  fuelFactor: number;
}

interface StudState {
  fire: FireStudState;
  gas: number;
  flood: number;
  structural: number;
  smoke: number;
}

// ── Constants (matching frontend) ───────────────────────────────────────

const NEIGHBOR_RADIUS = 8;

const DEFAULT_WALL_RESISTANCE: Record<string, number> = {
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
};

const DEFAULT_HAZARD_ACCELERATION: Record<string, number> = {
  combustible: 3,
  ignitable: 5,
  chemical: 4,
  electrical: 2,
  debris_risk: 1,
  falling_object: 1,
};

const BURN_DURATION = 300;
const HEAT_TRANSFER_RATE = 15;

const SMOKE_RATE: Record<SmokeGeneration, number> = {
  none: 0,
  light: 0.15,
  moderate: 0.4,
  heavy: 0.7,
  toxic: 0.9,
};

const DEFAULT_SNAPSHOT_TIMES_MIN = [0, 1, 3, 5, 10, 15, 20, 30, 45, 60];
const DEFAULT_TIME_SCALE = 0.5;

// ── Geometry helpers ────────────────────────────────────────────────────

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

function wallBlocksPath(from: Vec2, to: Vec2, wall: SimWall): boolean {
  if (wall.hasDoor) {
    const dx = wall.end.x - wall.start.x;
    const dy = wall.end.y - wall.start.y;
    const len = Math.hypot(dx, dy);
    if (len < 0.01) return false;
    const doorHalf = wall.doorWidth / (2 * len);
    const gapStart = Math.max(0, wall.doorPosition - doorHalf);
    const gapEnd = Math.min(1, wall.doorPosition + doorHalf);
    const sA = { x: wall.start.x + dx * gapStart, y: wall.start.y + dy * gapStart };
    const sB = { x: wall.start.x + dx * gapEnd, y: wall.start.y + dy * gapEnd };
    return segmentsIntersect(from, to, wall.start, sA) || segmentsIntersect(from, to, sB, wall.end);
  }
  return segmentsIntersect(from, to, wall.start, wall.end);
}

function wallBlocksIgnoringDoors(from: Vec2, to: Vec2, wall: SimWall): boolean {
  return segmentsIntersect(from, to, wall.start, wall.end);
}

function isWallBlocked(from: Vec2, to: Vec2, walls: SimWall[]): boolean {
  for (const w of walls) {
    if (wallBlocksPath(from, to, w)) return true;
  }
  return false;
}

function isWallBlockedIgnoringDoors(from: Vec2, to: Vec2, walls: SimWall[]): boolean {
  for (const w of walls) {
    if (wallBlocksIgnoringDoors(from, to, w)) return true;
  }
  return false;
}

function lookupResistance(material: string): number {
  const mat = material.toLowerCase().trim();
  for (const [key, val] of Object.entries(DEFAULT_WALL_RESISTANCE)) {
    if (mat.includes(key) || key.includes(mat)) return val;
  }
  return DEFAULT_WALL_RESISTANCE[''] ?? 900;
}

function getHazardAcceleration(pos: Vec2, hazards: SimHazard[]): number {
  let maxAccel = 0;
  for (const h of hazards) {
    const d = Math.hypot(h.pos.x - pos.x, h.pos.y - pos.y);
    if (d <= h.radius) {
      const accel = DEFAULT_HAZARD_ACCELERATION[h.hazardType] ?? 1;
      if (accel > maxAccel) maxAccel = accel;
    }
  }
  return maxAccel;
}

// ── Active effect tracking ──────────────────────────────────────────────

interface ActiveEffect {
  type: 'fire' | 'gas' | 'flood' | 'structural_zone';
  originPos: Vec2;
  spreadRadius: number;
  spreadRate: number;
  currentRadius: number;
  smokeGeneration: SmokeGeneration;
}

interface HazardRuntime {
  hazardId: string;
  nextEventIdx: number;
  events: HazardEvent[];
  activeEffects: ActiveEffect[];
  triggeredEventSmokeRates: number[];
}

// ── Main simulation runner ──────────────────────────────────────────────

export function runEnvironmentalSimulation(
  studs: SimStud[],
  walls: SimWall[],
  hazards: SimHazard[],
  hazardAnalyses: HazardAnalysis[],
  gameDurationMin = 60,
  timeScale = DEFAULT_TIME_SCALE,
  snapshotTimesMin?: number[],
): EnvironmentalSnapshot[] {
  if (studs.length === 0) return [];

  const effectiveSnapshots = (snapshotTimesMin ?? DEFAULT_SNAPSHOT_TIMES_MIN).filter(
    (t) => t <= gameDurationMin,
  );

  // Build stud index and neighbor cache
  const studIndex = new Map<string, SimStud>();
  const studStates = new Map<string, StudState>();
  const neighborCache = new Map<string, string[]>();

  for (const s of studs) {
    studIndex.set(s.id, s);
    studStates.set(s.id, {
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
      if (Math.hypot(other.simPos.x - s.simPos.x, other.simPos.y - s.simPos.y) <= NEIGHBOR_RADIUS) {
        neighbors.push(other.id);
      }
    }
    neighborCache.set(s.id, neighbors);
  }

  // Fire breach timers (wall penetration tracking)
  const wallBreachTimers = new Map<string, number>();

  // Register hazard runtimes from AI analyses
  const hazardRuntimes: HazardRuntime[] = [];
  for (const analysis of hazardAnalyses) {
    if (!analysis.events?.length) continue;
    hazardRuntimes.push({
      hazardId: analysis.hazardId,
      nextEventIdx: 0,
      events: [...analysis.events].sort((a, b) => a.triggerTimeSec - b.triggerTimeSec),
      activeEffects: [],
      triggeredEventSmokeRates: [],
    });
  }

  // Snapshot collection (game-time minutes → game-time seconds)
  const snapshotTimesSec = new Set(effectiveSnapshots.map((m) => m * 60));
  const snapshots: EnvironmentalSnapshot[] = [];

  // Time scaling: loop iterates in game-seconds, physics advance by simDt per tick.
  // AI event.triggerTimeSec is in real/sim time, so compare against simElapsed.
  const gameDurationSec = gameDurationMin * 60;
  const DT_GAME = 1;
  const DT_SIM = DT_GAME * timeScale;

  let simElapsed = 0;

  for (let gameTick = 0; gameTick <= gameDurationSec; gameTick += DT_GAME) {
    simElapsed = gameTick * timeScale;

    // Process hazard events (trigger times are in sim-time seconds)
    for (const hr of hazardRuntimes) {
      while (hr.nextEventIdx < hr.events.length) {
        const event = hr.events[hr.nextEventIdx];
        if (simElapsed < event.triggerTimeSec) break;
        hr.nextEventIdx++;

        if (event.spreadType) {
          const hazard = hazards.find((h) => h.id === hr.hazardId);
          const origin = hazard?.pos ?? { x: 0, y: 0 };

          const effect: ActiveEffect = {
            type: event.spreadType as ActiveEffect['type'],
            originPos: origin,
            spreadRadius: event.spreadRadius,
            spreadRate: event.spreadRate,
            currentRadius: event.spreadRadius,
            smokeGeneration: event.smokeGeneration ?? 'none',
          };
          hr.activeEffects.push(effect);

          if (event.spreadType === 'fire') {
            // Ignite studs within initial radius
            for (const [id, stud] of studIndex) {
              const d = Math.hypot(stud.simPos.x - origin.x, stud.simPos.y - origin.y);
              if (d <= event.spreadRadius) {
                const st = studStates.get(id)!;
                if (st.fire.state === 'none') {
                  st.fire.state = 'burning';
                  st.fire.timer = BURN_DURATION;
                }
              }
            }
          }

          hr.triggeredEventSmokeRates.push(SMOKE_RATE[event.smokeGeneration ?? 'none']);
        }
      }
    }

    // Step fire (physics uses DT_SIM)
    {
      const toHeat: Array<{ id: string; accel: number }> = [];

      for (const [id, st] of studStates) {
        if (st.fire.state === 'burning') {
          st.fire.timer -= DT_SIM;
          if (st.fire.timer <= 0) {
            st.fire.state = 'burnt_out';
            st.fire.timer = 0;
            continue;
          }

          const src = studIndex.get(id);
          if (!src) continue;
          const neighbors = neighborCache.get(id) ?? [];

          for (const nId of neighbors) {
            const nSt = studStates.get(nId);
            if (!nSt || nSt.fire.state !== 'none') continue;
            const dest = studIndex.get(nId);
            if (!dest) continue;

            let blocked = false;
            for (const w of walls) {
              if (wallBlocksPath(src.simPos, dest.simPos, w)) {
                const resistance = lookupResistance(w.material);
                if (resistance === Infinity) {
                  blocked = true;
                  break;
                }
                const breachKey = `${id}->${nId}`;
                const breachElapsed = wallBreachTimers.get(breachKey) ?? 0;
                if (breachElapsed < resistance) {
                  wallBreachTimers.set(breachKey, breachElapsed + DT_SIM);
                  blocked = true;
                }
                break;
              }
            }

            if (!blocked) {
              const accel = getHazardAcceleration(dest.simPos, hazards);
              if (accel > 0) {
                toHeat.push({ id: nId, accel });
              }
            }
          }
        } else if (st.fire.state === 'heating') {
          st.fire.timer -= DT_SIM;
          if (st.fire.timer <= 0) {
            st.fire.state = 'burning';
            st.fire.timer = BURN_DURATION * st.fire.fuelFactor;
          }
        }
      }

      for (const { id, accel } of toHeat) {
        const nSt = studStates.get(id);
        if (!nSt || nSt.fire.state !== 'none') continue;
        nSt.fire.state = 'heating';
        const effectiveAccel = Math.max(1, accel);
        nSt.fire.timer = HEAT_TRANSFER_RATE / effectiveAccel;
        nSt.fire.fuelFactor = effectiveAccel > 1 ? effectiveAccel * 0.5 : 1.0;
      }
    }

    // Step gas
    {
      const allGasEffects: ActiveEffect[] = [];
      for (const hr of hazardRuntimes) {
        for (const e of hr.activeEffects) {
          if (e.type === 'gas') allGasEffects.push(e);
        }
      }

      if (allGasEffects.length > 0) {
        const MAX_GAS_RADIUS = 80;
        for (const effect of allGasEffects) {
          if (effect.currentRadius < MAX_GAS_RADIUS) {
            effect.currentRadius = Math.min(
              MAX_GAS_RADIUS,
              effect.currentRadius + (effect.spreadRate / 60) * DT_SIM,
            );
          }
        }

        const spreadAmount = DT_SIM * 0.02;
        const decayRate = DT_SIM * 0.005;
        const toSpread: Array<{ id: string; amount: number }> = [];

        for (const [id, st] of studStates) {
          if (st.gas > 0.01) {
            const src = studIndex.get(id);
            if (!src) continue;
            const neighbors = neighborCache.get(id) ?? [];
            for (const nId of neighbors) {
              const nSt = studStates.get(nId);
              const dest = studIndex.get(nId);
              if (!nSt || !dest) continue;
              if (nSt.gas >= st.gas) continue;
              const blocked = isWallBlocked(src.simPos, dest.simPos, walls);
              const transfer = blocked ? spreadAmount * 0.1 : spreadAmount;
              const diff = (st.gas - nSt.gas) * transfer;
              if (diff > 0.001) toSpread.push({ id: nId, amount: diff });
            }
            st.gas = Math.max(0, st.gas - decayRate);
            if (src.spatialContext !== 'inside_building') {
              st.gas = Math.max(0, st.gas - decayRate * 3);
            }
          }
        }

        for (const { id, amount } of toSpread) {
          const s = studStates.get(id);
          if (s) s.gas = Math.min(1, s.gas + amount);
        }

        for (const effect of allGasEffects) {
          for (const [id, stud] of studIndex) {
            const d = Math.hypot(
              stud.simPos.x - effect.originPos.x,
              stud.simPos.y - effect.originPos.y,
            );
            if (d <= effect.currentRadius) {
              const st = studStates.get(id);
              if (st) {
                const conc = Math.max(0, 1 - d / Math.max(1, effect.currentRadius));
                st.gas = Math.min(1, Math.max(st.gas, conc * 0.8));
              }
            }
          }
        }
      }
    }

    // Step flood
    {
      const allFloodEffects: ActiveEffect[] = [];
      for (const hr of hazardRuntimes) {
        for (const e of hr.activeEffects) {
          if (e.type === 'flood') allFloodEffects.push(e);
        }
      }

      if (allFloodEffects.length > 0) {
        const MAX_FLOOD_RADIUS = 60;
        for (const effect of allFloodEffects) {
          if (effect.currentRadius < MAX_FLOOD_RADIUS) {
            effect.currentRadius = Math.min(
              MAX_FLOOD_RADIUS,
              effect.currentRadius + (effect.spreadRate / 60) * DT_SIM,
            );
          }
        }

        const spreadAmount = DT_SIM * 0.015;
        const toSpread: Array<{ id: string; amount: number }> = [];
        for (const [id, st] of studStates) {
          if (st.flood > 0.01) {
            const src = studIndex.get(id);
            if (!src) continue;
            const neighbors = neighborCache.get(id) ?? [];
            for (const nId of neighbors) {
              const nSt = studStates.get(nId);
              const dest = studIndex.get(nId);
              if (!nSt || !dest) continue;
              if (nSt.flood >= st.flood) continue;
              if (isWallBlockedIgnoringDoors(src.simPos, dest.simPos, walls)) continue;
              const diff = (st.flood - nSt.flood) * spreadAmount;
              if (diff > 0.001) toSpread.push({ id: nId, amount: diff });
            }
          }
        }
        for (const { id, amount } of toSpread) {
          const s = studStates.get(id);
          if (s) s.flood = Math.min(1, s.flood + amount);
        }
        for (const effect of allFloodEffects) {
          for (const [id, stud] of studIndex) {
            const d = Math.hypot(
              stud.simPos.x - effect.originPos.x,
              stud.simPos.y - effect.originPos.y,
            );
            if (d <= effect.currentRadius) {
              const st = studStates.get(id);
              if (st && stud.spatialContext === 'inside_building') {
                const level = Math.max(0, 1 - d / Math.max(1, effect.currentRadius));
                st.flood = Math.min(1, Math.max(st.flood, level * 0.6));
              }
            }
          }
        }
      }
    }

    // Step structural
    {
      const allStructEffects: ActiveEffect[] = [];
      for (const hr of hazardRuntimes) {
        for (const e of hr.activeEffects) {
          if (e.type === 'structural_zone') allStructEffects.push(e);
        }
      }
      if (allStructEffects.length > 0) {
        const MAX_STRUCTURAL_RADIUS = 30;
        for (const effect of allStructEffects) {
          if (effect.currentRadius < MAX_STRUCTURAL_RADIUS) {
            effect.currentRadius = Math.min(
              MAX_STRUCTURAL_RADIUS,
              effect.currentRadius + (effect.spreadRate / 60) * DT_SIM,
            );
          }
        }
        for (const effect of allStructEffects) {
          for (const [id, stud] of studIndex) {
            const d = Math.hypot(
              stud.simPos.x - effect.originPos.x,
              stud.simPos.y - effect.originPos.y,
            );
            if (d <= effect.currentRadius) {
              const st = studStates.get(id);
              if (st) {
                const risk = Math.max(0, 1 - d / Math.max(1, effect.currentRadius));
                st.structural = Math.min(1, Math.max(st.structural, risk));
              }
            }
          }
        }
      }
    }

    // Step smoke (derived from burning studs and smoke-producing events)
    {
      for (const [, st] of studStates) {
        if (st.fire.state === 'burning') {
          st.smoke = Math.min(1, st.smoke + DT_SIM * 0.03);
        }
      }

      for (const hr of hazardRuntimes) {
        for (let i = 0; i < hr.triggeredEventSmokeRates.length; i++) {
          const rate = hr.triggeredEventSmokeRates[i];
          if (rate <= 0) continue;
          const event = hr.events[i];
          if (event?.affectedStuds?.length) {
            for (const sId of event.affectedStuds) {
              const s = studStates.get(sId);
              if (s) s.smoke = Math.min(1, s.smoke + DT_SIM * rate * 0.02);
            }
          }
        }
      }

      const spreadAmount = DT_SIM * 0.025;
      const toSpread: Array<{ id: string; amount: number }> = [];

      for (const [id, st] of studStates) {
        if (st.smoke > 0.02) {
          const src = studIndex.get(id);
          if (!src) continue;
          const neighbors = neighborCache.get(id) ?? [];
          for (const nId of neighbors) {
            const nSt = studStates.get(nId);
            const dest = studIndex.get(nId);
            if (!nSt || !dest) continue;
            if (nSt.smoke >= st.smoke) continue;
            const blocked = isWallBlocked(src.simPos, dest.simPos, walls);
            const transfer = blocked ? spreadAmount * 0.05 : spreadAmount;
            const diff = (st.smoke - nSt.smoke) * transfer;
            if (diff > 0.001) toSpread.push({ id: nId, amount: diff });
          }
          const smokeDecay = DT_SIM * 0.002;
          st.smoke = Math.max(0, st.smoke - smokeDecay);
          if (src.spatialContext !== 'inside_building') {
            st.smoke = Math.max(0, st.smoke - smokeDecay * 4);
          }
        }
      }

      for (const { id, amount } of toSpread) {
        const s = studStates.get(id);
        if (s) s.smoke = Math.min(1, s.smoke + amount);
      }
    }

    // Capture snapshot if this is a snapshot time (game-time)
    if (snapshotTimesSec.has(gameTick)) {
      const atMinutes = gameTick / 60;
      const studEffects: StudEnvironmentalEffect[] = [];

      for (const [id, st] of studStates) {
        const fireIntensity =
          st.fire.state === 'burning'
            ? 1.0
            : st.fire.state === 'heating'
              ? 0.3
              : st.fire.state === 'burnt_out'
                ? 0.05
                : 0;

        if (fireIntensity > 0 || st.smoke > 0.02 || st.gas > 0.02 || st.structural > 0.02) {
          const smokeDensity = Math.min(1, st.smoke);
          let visibilityM = 15;
          if (smokeDensity > 0.8) visibilityM = 0.5;
          else if (smokeDensity > 0.6) visibilityM = 1;
          else if (smokeDensity > 0.4) visibilityM = 3;
          else if (smokeDensity > 0.2) visibilityM = 8;
          else if (smokeDensity > 0.05) visibilityM = 12;

          studEffects.push({
            stud_id: id,
            smoke_density: Math.round(smokeDensity * 100) / 100,
            fire_intensity: Math.round(fireIntensity * 100) / 100,
            gas_concentration: Math.round(st.gas * 100) / 100,
            structural_damage: Math.round(st.structural * 100) / 100,
            visibility_m: visibilityM,
          });
        }
      }

      snapshots.push({
        at_minutes: atMinutes,
        stud_effects: studEffects,
        narrative: '',
      });
    }
  }

  logger.info(
    {
      studs: studs.length,
      hazardRuntimes: hazardRuntimes.length,
      snapshots: snapshots.length,
      totalAffectedStuds: snapshots.reduce((s, snap) => Math.max(s, snap.stud_effects.length), 0),
    },
    'Environmental simulation complete',
  );

  return snapshots;
}
