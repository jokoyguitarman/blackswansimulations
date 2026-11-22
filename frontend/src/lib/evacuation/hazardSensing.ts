import type { ExitDef, Vec2 } from './types';
import { isInsidePolygon } from './geometry';
import { SHOWCASE } from './showcaseConstants';

export type HeadSmokeClass = 'clear' | 'light' | 'thick' | 'untenable';
export type FireCell = 'none' | 'heating' | 'burning' | 'burnt_out';
export type Familiarity = 'visitor' | 'staff';
export type Posture = 'stand' | 'crouch' | 'crawl';

export interface HazardSample {
  smoke: number;
  fire: FireCell;
}

export interface HazardStud {
  id: string;
  simPos: Vec2;
  indoor: boolean;
}

interface StudStateLike {
  smoke: number;
  fire: { state: string };
}

function asFireCell(state: string | undefined): FireCell {
  if (state === 'heating' || state === 'burning' || state === 'burnt_out') return state;
  return 'none';
}

/** Read-only view of the effects engine's stud states, with a spatial hash for nearest-stud lookup. */
export class HazardField {
  private readonly cellM: number;
  private readonly buckets = new Map<string, HazardStud[]>();
  private states: ReadonlyMap<string, StudStateLike> | null = null;

  constructor(studs: HazardStud[], cellM = 3) {
    this.cellM = cellM;
    for (const s of studs) {
      const key = this.key(s.simPos.x, s.simPos.y);
      const list = this.buckets.get(key);
      if (list) list.push(s);
      else this.buckets.set(key, [s]);
    }
  }

  /** Replace the state map reference each frame (no copy). */
  setStates(states: ReadonlyMap<string, StudStateLike>): void {
    this.states = states;
  }

  /** Nearest stud within 1.5 × cellM, else { smoke: 0, fire: 'none' }. */
  sample(x: number, y: number): HazardSample {
    const nearest = this.nearest(x, y, 1.5 * this.cellM);
    if (!nearest) return { smoke: 0, fire: 'none' };
    const st = this.states?.get(nearest.id);
    return { smoke: st?.smoke ?? 0, fire: asFireCell(st?.fire.state) };
  }

  /** Burning and heating studs within radius, for repulsion. */
  firesNear(x: number, y: number, radius: number): Array<{ pos: Vec2; state: 'burning' | 'heating' }> {
    const out: Array<{ pos: Vec2; state: 'burning' | 'heating' }> = [];
    const span = Math.max(1, Math.ceil(radius / this.cellM));
    const cx = Math.floor(x / this.cellM);
    const cy = Math.floor(y / this.cellM);
    for (let dx = -span; dx <= span; dx++) {
      for (let dy = -span; dy <= span; dy++) {
        const list = this.buckets.get(`${cx + dx},${cy + dy}`);
        if (!list) continue;
        for (const s of list) {
          if (Math.hypot(s.simPos.x - x, s.simPos.y - y) > radius) continue;
          const fire = asFireCell(this.states?.get(s.id)?.fire.state);
          if (fire === 'burning' || fire === 'heating') out.push({ pos: s.simPos, state: fire });
        }
      }
    }
    return out;
  }

  /** Stud position with the lowest extinction coefficient within `radius`, if any. */
  lowestKWithin(x: number, y: number, radius: number): Vec2 | null {
    let best: Vec2 | null = null;
    let bestK = Infinity;
    const span = Math.max(1, Math.ceil(radius / this.cellM));
    const cx = Math.floor(x / this.cellM);
    const cy = Math.floor(y / this.cellM);
    for (let dx = -span; dx <= span; dx++) {
      for (let dy = -span; dy <= span; dy++) {
        const list = this.buckets.get(`${cx + dx},${cy + dy}`);
        if (!list) continue;
        for (const s of list) {
          if (Math.hypot(s.simPos.x - x, s.simPos.y - y) > radius) continue;
          const k = extinctionK(this.states?.get(s.id)?.smoke ?? 0);
          if (k < bestK) {
            bestK = k;
            best = s.simPos;
          }
        }
      }
    }
    return best;
  }

  private nearest(x: number, y: number, limit: number): HazardStud | null {
    const cx = Math.floor(x / this.cellM);
    const cy = Math.floor(y / this.cellM);
    let best: HazardStud | null = null;
    let bestD = limit;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const list = this.buckets.get(`${cx + dx},${cy + dy}`);
        if (!list) continue;
        for (const s of list) {
          const d = Math.hypot(s.simPos.x - x, s.simPos.y - y);
          if (d <= bestD) {
            bestD = d;
            best = s;
          }
        }
      }
    }
    return best;
  }

  private key(x: number, y: number): string {
    return `${Math.floor(x / this.cellM)},${Math.floor(y / this.cellM)}`;
  }
}

export function extinctionK(d: number): number {
  const x = Math.min(1, Math.max(0, d));
  const pts = SHOWCASE.D_TO_K_POINTS;
  if (x <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1];
    const [x1, y1] = pts[i];
    if (x <= x1) {
      const t = x1 === x0 ? 0 : (x - x0) / (x1 - x0);
      return y0 + t * (y1 - y0);
    }
  }
  return pts[pts.length - 1][1];
}

/** Visibility in metres. Reports 30 m when K < 0.1. C defaults to the reflective constant. */
export function visibilityM(K: number, C: number = SHOWCASE.VIS_K_REFLECTIVE): number {
  if (K < 0.1) return 30;
  return C / K;
}

/** Overlay opacity only. */
export function headSmoke(d: number): number {
  const onset = SHOWCASE.SMOKE_HEAD_ONSET;
  return Math.min(1, Math.max(0, (d - onset) / (1 - onset)));
}

export function headSmokeClass(K: number): HeadSmokeClass {
  if (K < 0.15) return 'clear';
  if (K < 0.5) return 'light';
  if (K < SHOWCASE.REROUTE_EXTINCTION) return 'thick';
  return 'untenable';
}

export function crouchExtinction(f: Familiarity): number {
  return f === 'staff' ? SHOWCASE.CROUCH_EXTINCTION_STAFF : SHOWCASE.CROUCH_EXTINCTION_VISITOR;
}

export function jinFactor(K: number): number {
  const raw = (SHOWCASE.JIN_A - SHOWCASE.JIN_B * K) / SHOWCASE.JIN_A;
  const min = SHOWCASE.SMOKE_SPEED_MIN / SHOWCASE.FREE_WALK_SPEED;
  return Math.min(1, Math.max(min, raw));
}

export function layerK(d: number): { head: number; waist: number } {
  return {
    head: extinctionK(d),
    waist: extinctionK(Math.max(0, d - SHOWCASE.LAYER_STEP_D)),
  };
}

/**
 * Stand while the head layer holds, crouch when the head layer fails and the waist holds,
 * crawl when the waist layer also fails. A failed layer recovers below POSTURE_RELEASE × threshold.
 * The equality at the threshold counts as failed (d = 0.03 / 0.24 / 0.23 / 0.44 oracles).
 */
export function nextPosture(current: Posture, d: number, f: Familiarity): Posture {
  const { head, waist } = layerK(d);
  const thr = crouchExtinction(f);
  const release = SHOWCASE.POSTURE_RELEASE * thr;
  // Piecewise interpolation lands a few ulps under the exact knots (0.24 → 0.5, 0.44 → waist 0.5).
  const failed = (k: number, limit: number) => k + 1e-9 >= limit;
  const headFails = current === 'stand' ? failed(head, thr) : failed(head, release);
  const waistFails = current === 'crawl' ? failed(waist, release) : failed(waist, thr);
  if (waistFails) return 'crawl';
  if (headFails) return 'crouch';
  return 'stand';
}

/** Indoor speed (m/s). Panic is the caller's factor; the showcase passes SHOWCASE_PANIC. */
export function walkingSpeed(
  K: number,
  posture: Posture,
  panic: number,
  injuryFactor: number,
): number {
  if (posture === 'crawl') return SHOWCASE.CRAWL_SPEED * injuryFactor;
  const stand =
    SHOWCASE.FREE_WALK_SPEED * (1 + 0.6 * panic) * jinFactor(K) * injuryFactor;
  if (posture === 'crouch') return stand * SHOWCASE.CROUCH_SPEED_FACTOR;
  return stand;
}

export function outdoorSpeed(
  distFromExitM: number,
  localDensityPm2: number,
  injuryFactor: number,
): number {
  const walk =
    distFromExitM >= SHOWCASE.RUN_DISTANCE_M || localDensityPm2 > SHOWCASE.RUN_DENSITY_LIMIT;
  const base = walk ? SHOWCASE.OUTDOOR_WALK_SPEED : SHOWCASE.OUTDOOR_RUN_SPEED;
  return base * injuryFactor;
}

export function lognormalFromQuartiles(q1: number, q3: number): { mu: number; sigma: number } {
  const sigma = Math.log(q3 / q1) / (2 * 0.6745);
  const mu = (Math.log(q1) + Math.log(q3)) / 2;
  return { mu, sigma };
}

export function lognormalFromPercentiles(p1: number, p99: number): { mu: number; sigma: number } {
  const z = 2.3263;
  const sigma = Math.log(p99 / p1) / (2 * z);
  const mu = (Math.log(p1) + Math.log(p99)) / 2;
  return { mu, sigma };
}

export function samplePremovementS(rng: () => number): number {
  let u1 = rng();
  if (u1 < 1e-12) u1 = 1e-12;
  const u2 = rng();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  const raw = Math.exp(Math.log(SHOWCASE.PREMOVE_MEDIAN_S) + SHOWCASE.PREMOVE_SIGMA_LN * z);
  return Math.min(SHOWCASE.PREMOVE_MAX_S, Math.max(SHOWCASE.PREMOVE_MIN_S, raw));
}

export function assemblyMinDistanceM(buildingHeightM: number): number {
  return Math.max(buildingHeightM, SHOWCASE.ASSEMBLY_MIN_DISTANCE_M);
}

export function radiantAvoidRadiusM(hrrKw: number, chi: number, qLimitKwM2: number): number {
  return Math.sqrt((chi * hrrKw) / (4 * Math.PI * qLimitKwM2));
}

/** 2 m inside the exit centre, mirroring exitInteriorPoint in pathfinding. */
export function exitApproachInside(exit: ExitDef, verts: Vec2[], offset = 2): Vec2 {
  const a = verts[exit.edgeIndex];
  const b = verts[(exit.edgeIndex + 1) % verts.length];
  if (!a || !b) return { x: exit.center.x, y: exit.center.y };
  const edgeDx = b.x - a.x;
  const edgeDy = b.y - a.y;
  const edgeLen = Math.hypot(edgeDx, edgeDy);
  if (edgeLen < 0.01) return { x: exit.center.x, y: exit.center.y };
  let nx = -edgeDy / edgeLen;
  let ny = edgeDx / edgeLen;
  if (isInsidePolygon(exit.center.x + nx * 2, exit.center.y + ny * 2, verts)) {
    nx = -nx;
    ny = -ny;
  }
  return { x: exit.center.x - nx * offset, y: exit.center.y - ny * offset };
}

export function isExitUsable(exit: ExitDef, verts: Vec2[], field: HazardField): boolean {
  if (exit.exitType === 'service') return false;
  if (exit.status === 'blocked') return false;
  const approach = exitApproachInside(exit, verts);
  const s = field.sample(approach.x, approach.y);
  if (s.fire === 'burning') return false;
  // Inclusive at the threshold: K 1.5 is still usable, 1.51 is not (showcase oracle).
  if (extinctionK(s.smoke) > SHOWCASE.REROUTE_EXTINCTION) return false;
  return true;
}

function sampleSegment(a: Vec2, b: Vec2, step: number): Vec2[] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  const n = Math.max(1, Math.ceil(len / step));
  const pts: Vec2[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    pts.push({ x: a.x + dx * t, y: a.y + dy * t });
  }
  return pts;
}

export function exitCost(pos: Vec2, exit: ExitDef, verts: Vec2[], field: HazardField): number {
  if (!isExitUsable(exit, verts, field)) return Infinity;
  const approach = exitApproachInside(exit, verts);
  let extra = exit.status === 'congested' ? SHOWCASE.CONGESTED_PENALTY_M : 0;
  for (const p of sampleSegment(pos, approach, SHOWCASE.SAMPLE_STEP_M)) {
    const s = field.sample(p.x, p.y);
    if (s.fire === 'burning') return Infinity;
    extra += extinctionK(s.smoke) * SHOWCASE.SMOKE_COST_M_PER_K;
  }
  return Math.hypot(exit.center.x - pos.x, exit.center.y - pos.y) + extra;
}

export interface ExitChoice {
  id: string;
  cost: number;
  forced: boolean;
}

/**
 * Lowest-cost usable exit, with hysteresis, an exclude list, and the all-Infinity fallback.
 * Returns null only when every considered exit is blocked (or there are none).
 */
export function chooseExit(
  pos: Vec2,
  exits: ExitDef[],
  verts: Vec2[],
  field: HazardField,
  current: { id: string; cost: number } | null,
  options?: { ignoreHysteresis?: boolean; excludeId?: string },
): ExitChoice | null {
  const pool = exits.filter((e) => e.id !== options?.excludeId);
  const ranked = pool
    .map((e) => ({ id: e.id, cost: exitCost(pos, e, verts, field) }))
    .sort((a, b) => a.cost - b.cost || a.id.localeCompare(b.id));
  const best = ranked.find((r) => r.cost < Infinity);

  if (!best) {
    let nearest: ExitDef | null = null;
    let nearestD = Infinity;
    for (const e of pool) {
      if (e.exitType === 'service' || e.status === 'blocked') continue;
      const d = Math.hypot(e.center.x - pos.x, e.center.y - pos.y);
      if (d < nearestD) {
        nearestD = d;
        nearest = e;
      }
    }
    if (!nearest) return null;
    return { id: nearest.id, cost: Infinity, forced: true };
  }

  const stay =
    current != null &&
    current.id !== options?.excludeId &&
    !options?.ignoreHysteresis &&
    pool.some((e) => e.id === current.id);
  if (stay && current) {
    const now = exitCost(
      pos,
      pool.find((e) => e.id === current.id) as ExitDef,
      verts,
      field,
    );
    const basis = now < Infinity ? now : current.cost;
    if (basis < Infinity && !(best.cost < basis * (1 - SHOWCASE.REROUTE_HYSTERESIS))) {
      return { id: current.id, cost: now, forced: false };
    }
  }
  return { id: best.id, cost: best.cost, forced: false };
}

/**
 * Smoke-ahead decision (main game §6.30). Burning-ahead and the turn-back roll are separate.
 * `altCost` null means no alternative was found.
 */
export function smokeAheadAction(
  ka: number,
  currentCost: number,
  altCost: number | null,
): 'keep' | 'switch' {
  if (!(ka > SHOWCASE.REROUTE_EXTINCTION)) return 'keep';
  if (altCost != null && altCost < SHOWCASE.REROUTE_COST_RATIO * currentCost) return 'switch';
  return 'keep';
}

export interface WallLike {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  hasDoor: boolean;
  doorWidth: number;
  doorPosition: number;
}

function segmentsHitT(p1: Vec2, p2: Vec2, p3: Vec2, p4: Vec2): number | null {
  const d1x = p2.x - p1.x;
  const d1y = p2.y - p1.y;
  const d2x = p4.x - p3.x;
  const d2y = p4.y - p3.y;
  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < 1e-10) return null;
  const t = ((p3.x - p1.x) * d2y - (p3.y - p1.y) * d2x) / denom;
  const u = ((p3.x - p1.x) * d1y - (p3.y - p1.y) * d1x) / denom;
  if (t > 0.01 && t < 0.99 && u > 0.01 && u < 0.99) return t;
  return null;
}

function solidParts(wall: WallLike): Array<[Vec2, Vec2]> {
  const start = { x: wall.startX, y: wall.startY };
  const end = { x: wall.endX, y: wall.endY };
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const len = Math.hypot(dx, dy);
  if (len < 0.01) return [];
  if (!wall.hasDoor) return [[start, end]];
  const doorHalf = wall.doorWidth / (2 * len);
  const gapStart = Math.max(0, wall.doorPosition - doorHalf);
  const gapEnd = Math.min(1, wall.doorPosition + doorHalf);
  const parts: Array<[Vec2, Vec2]> = [];
  if (gapStart > 0.001) {
    parts.push([start, { x: start.x + dx * gapStart, y: start.y + dy * gapStart }]);
  }
  if (1 - gapEnd > 0.001) {
    parts.push([{ x: start.x + dx * gapEnd, y: start.y + dy * gapEnd }, end]);
  }
  return parts;
}

export function nextIndoorWaypoint(pos: Vec2, target: Vec2, walls: WallLike[]): Vec2 {
  let bestT = Infinity;
  let best: WallLike | null = null;
  for (const wall of walls) {
    if (!wall.hasDoor) continue;
    let hitT = Infinity;
    for (const [a, b] of solidParts(wall)) {
      const t = segmentsHitT(pos, target, a, b);
      if (t != null && t < hitT) hitT = t;
    }
    if (hitT < bestT) {
      bestT = hitT;
      best = wall;
    }
  }
  if (!best) return target;
  return {
    x: best.startX + (best.endX - best.startX) * best.doorPosition,
    y: best.startY + (best.endY - best.startY) * best.doorPosition,
  };
}

export function distanceToOutline(x: number, y: number, verts: Vec2[]): number {
  if (verts.length < 2) return Infinity;
  if (isInsidePolygon(x, y, verts)) return 0;
  let best = Infinity;
  for (let i = 0; i < verts.length; i++) {
    const a = verts[i];
    const b = verts[(i + 1) % verts.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;
    if (lenSq < 1e-12) continue;
    let t = ((x - a.x) * dx + (y - a.y) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(x - (a.x + t * dx), y - (a.y + t * dy));
    if (d < best) best = d;
  }
  return best;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
