import type { Vec2 } from '../evacuation/types';
import type { InteriorWall, HazardZone, HazardType } from './types';

// ── Types ────────────────────────────────────────────────────────────────

export type FireState = 'none' | 'heating' | 'burning' | 'burnt_out';

export interface FireParams {
  baseSpreadRate: number;
  burnDuration: number;
  heatTransferRate: number;
  wallResistance: Record<string, number>;
  hazardAcceleration: Record<string, number>;
}

export interface FireStudState {
  state: FireState;
  timer: number;
  fuelFactor: number;
}

export interface FireSimStud {
  id: string;
  simPos: Vec2;
  spatialContext: string | null;
}

// ── Default parameters (NFPA / ISO 834 based) ───────────────────────────

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

// ── Neighbor search radius (diagonal of 5m grid = ~7.1m, add margin) ───

const NEIGHBOR_RADIUS = 8;

// ── Fire Simulation Class ────────────────────────────────────────────────

export class FireSimulation {
  states: Map<string, FireStudState> = new Map();
  wallBreachTimers: Map<string, number> = new Map();
  params: FireParams;
  elapsed = 0;

  private studIndex: Map<string, FireSimStud> = new Map();
  private neighborCache: Map<string, string[]> = new Map();

  constructor(params?: FireParams) {
    this.params = params ?? { ...DEFAULT_FIRE_PARAMS };
  }

  init(studs: FireSimStud[]) {
    this.studIndex.clear();
    this.states.clear();
    this.neighborCache.clear();
    this.wallBreachTimers.clear();
    this.elapsed = 0;

    for (const s of studs) {
      this.studIndex.set(s.id, s);
      this.states.set(s.id, { state: 'none', timer: 0, fuelFactor: 1.0 });
    }

    this.buildNeighborCache(studs);
  }

  private buildNeighborCache(studs: FireSimStud[]) {
    for (const s of studs) {
      const neighbors: string[] = [];
      for (const other of studs) {
        if (other.id === s.id) continue;
        const d = Math.hypot(other.simPos.x - s.simPos.x, other.simPos.y - s.simPos.y);
        if (d <= NEIGHBOR_RADIUS) {
          neighbors.push(other.id);
        }
      }
      this.neighborCache.set(s.id, neighbors);
    }
  }

  ignite(studIds: string[]) {
    for (const id of studIds) {
      const state = this.states.get(id);
      if (state && state.state === 'none') {
        state.state = 'burning';
        state.timer = this.params.burnDuration;
      }
    }
  }

  igniteRadius(center: Vec2, radius: number) {
    const ids: string[] = [];
    for (const [id, stud] of this.studIndex) {
      const d = Math.hypot(stud.simPos.x - center.x, stud.simPos.y - center.y);
      if (d <= radius) {
        ids.push(id);
      }
    }
    this.ignite(ids);
  }

  step(dt: number, walls: InteriorWall[], hazards: HazardZone[]) {
    if (dt <= 0) return;
    this.elapsed += dt;

    const toHeat: Array<{ id: string; accel: number }> = [];

    for (const [id, fState] of this.states) {
      if (fState.state === 'burning') {
        fState.timer -= dt;
        if (fState.timer <= 0) {
          fState.state = 'burnt_out';
          fState.timer = 0;
          continue;
        }

        const src = this.studIndex.get(id);
        if (!src) continue;
        const neighbors = this.neighborCache.get(id) ?? [];

        for (const nId of neighbors) {
          const nState = this.states.get(nId);
          if (!nState || nState.state !== 'none') continue;

          const dest = this.studIndex.get(nId);
          if (!dest) continue;

          let blocked = false;
          let wallMaterial = '';
          for (const w of walls) {
            if (wallBlocksFire(src.simPos, dest.simPos, w)) {
              wallMaterial = getWallMaterial(w);
              const resistance = this.lookupResistance(wallMaterial);
              if (resistance === Infinity) {
                blocked = true;
                break;
              }

              const breachKey = `${id}->${nId}`;
              const elapsed = this.wallBreachTimers.get(breachKey) ?? 0;
              if (elapsed < resistance) {
                this.wallBreachTimers.set(breachKey, elapsed + dt);
                blocked = true;
              }
              break;
            }
          }

          if (!blocked) {
            const accel = this.getHazardAcceleration(dest.simPos, hazards);
            toHeat.push({ id: nId, accel });
          }
        }
      } else if (fState.state === 'heating') {
        fState.timer -= dt;
        if (fState.timer <= 0) {
          fState.state = 'burning';
          fState.timer = this.params.burnDuration * fState.fuelFactor;
        }
      }
    }

    for (const { id, accel } of toHeat) {
      const nState = this.states.get(id);
      if (!nState || nState.state !== 'none') continue;
      nState.state = 'heating';
      nState.timer = this.params.heatTransferRate / accel;
      nState.fuelFactor = accel > 1 ? accel * 0.5 : 1.0;
    }
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

  private getHazardAcceleration(pos: Vec2, hazards: HazardZone[]): number {
    let maxAccel = 1;
    for (const h of hazards) {
      const d = Math.hypot(h.pos.x - pos.x, h.pos.y - pos.y);
      if (d <= h.radius) {
        const accel = this.params.hazardAcceleration[h.hazardType as HazardType] ?? 1;
        if (accel > maxAccel) maxAccel = accel;
      }
    }
    return maxAccel;
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
