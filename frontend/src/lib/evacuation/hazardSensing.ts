import type { ExitDef, Vec2 } from './types';
import { isInsidePolygon } from './geometry';
import { SHOWCASE } from './showcaseConstants';
import { BLAST_CONSTANTS } from '../rts/blast/blastModel';

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

function routeLegs(pos: Vec2, approach: Vec2, walls?: WallLike[]): Array<[Vec2, Vec2]> {
  const via = walls && walls.length > 0 ? nextIndoorWaypoint(pos, approach, walls) : approach;
  const legs: Array<[Vec2, Vec2]> = [];
  if (via.x !== pos.x || via.y !== pos.y) legs.push([pos, via]);
  if (via.x !== approach.x || via.y !== approach.y) legs.push([via, approach]);
  if (legs.length === 0) legs.push([pos, approach]);
  return legs;
}

export function exitCost(
  pos: Vec2,
  exit: ExitDef,
  verts: Vec2[],
  field: HazardField,
  walls?: WallLike[],
): number {
  if (!isExitUsable(exit, verts, field)) return Infinity;
  const approach = exitApproachInside(exit, verts);
  let extra = exit.status === 'congested' ? SHOWCASE.CONGESTED_PENALTY_M : 0;
  for (const [a, b] of routeLegs(pos, approach, walls)) {
    for (const p of sampleSegment(a, b, SHOWCASE.SAMPLE_STEP_M)) {
      const s = field.sample(p.x, p.y);
      if (s.fire === 'burning') return Infinity;
      extra += extinctionK(s.smoke) * SHOWCASE.SMOKE_COST_M_PER_K;
    }
  }
  return Math.hypot(exit.center.x - pos.x, exit.center.y - pos.y) + extra;
}

/**
 * Fire and the worst extinction on the walked route (person, then door, then
 * the inside approach). Blocked and service exits are not a look-ahead signal.
 */
export function walkedRouteHazard(
  pos: Vec2,
  exit: ExitDef,
  verts: Vec2[],
  field: HazardField,
  walls?: WallLike[],
): { burning: boolean; maxK: number } {
  if (exit.exitType === 'service' || exit.status === 'blocked') return { burning: false, maxK: 0 };
  const approach = exitApproachInside(exit, verts);
  let burning = false;
  let maxK = 0;
  for (const [a, b] of routeLegs(pos, approach, walls)) {
    for (const p of sampleSegment(a, b, SHOWCASE.SAMPLE_STEP_M)) {
      const s = field.sample(p.x, p.y);
      if (s.fire === 'burning') burning = true;
      maxK = Math.max(maxK, extinctionK(s.smoke));
    }
  }
  return { burning, maxK };
}

/** True while fire or untenable smoke still lies on the walked route to this exit. */
export function exitRouteHazardous(
  pos: Vec2,
  exit: ExitDef,
  verts: Vec2[],
  field: HazardField,
  walls?: WallLike[],
): boolean {
  if (!isExitUsable(exit, verts, field)) return true;
  const hazard = walkedRouteHazard(pos, exit, verts, field, walls);
  return hazard.burning || hazard.maxK > SHOWCASE.REROUTE_EXTINCTION;
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
  options?: {
    ignoreHysteresis?: boolean;
    excludeId?: string;
    avoidIds?: string[];
    walls?: WallLike[];
  },
): ExitChoice | null {
  const avoided = new Set(options?.avoidIds ?? []);
  const pool = exits.filter((e) => e.id !== options?.excludeId && !avoided.has(e.id));
  const ranked = pool
    .map((e) => ({ id: e.id, cost: exitCost(pos, e, verts, field, options?.walls) }))
    .sort((a, b) => a.cost - b.cost || a.id.localeCompare(b.id));
  const best = ranked.find((r) => r.cost < Infinity);

  if (!best) {
    // §2.6: every exit costs Infinity, so crawl to the nearest non-blocked exit.
    // Avoid lists and the exclude id do not apply here — a sticky turn-back must
    // not force someone past a nearer door onto a farther one.
    let nearest: ExitDef | null = null;
    let nearestD = Infinity;
    for (const e of exits) {
      if (e.exitType === 'service' || e.status === 'blocked') continue;
      const d = Math.hypot(e.center.x - pos.x, e.center.y - pos.y);
      if (d < nearestD || (d === nearestD && nearest && e.id < nearest.id)) {
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
    !avoided.has(current.id) &&
    !options?.ignoreHysteresis &&
    pool.some((e) => e.id === current.id);
  if (stay && current) {
    const now = exitCost(
      pos,
      pool.find((e) => e.id === current.id) as ExitDef,
      verts,
      field,
      options?.walls,
    );
    // A blocked or burning exit is abandoned on this check, not one check later.
    if (now < Infinity && !(best.cost < now * (1 - SHOWCASE.REROUTE_HYSTERESIS))) {
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

const BODY_RADIUS_M = 0.25;
/** Half of the 0.8 m wall slab. */
const SLAB_HALF_M = 0.4;
/**
 * A body is clear of a 0.8 m wall once its centre is this far from the
 * wall line: half the slab (0.4) plus the body radius (0.25).
 */
export const WALL_FACE_CLEAR_M = 0.65;
/** Just clear of a 0.8 m wall (half thickness 0.4 plus a body radius). */
const GAP_CLEAR_M = 0.7;
/** Switch from lining up to walking through once this close to the opening. */
export const MOUTH_APPROACH_M = 1.05;
const GAP_MOUTH_M = MOUTH_APPROACH_M;

/** Seeded door or exit flow: specific flow times width less the boundary layer each side. */
export function openingFlowPerS(widthM: number): number {
  const effective = Math.max(0, widthM - 2 * SHOWCASE.BOUNDARY_LAYER_DOOR_M);
  return SHOWCASE.MAX_SPECIFIC_FLOW * effective;
}
const GAP_THROUGH_M = 1.5;

/** A point on the door gap, inset by a body radius so the target stays in the opening. */
export function pointOnDoorGap(wall: WallLike, lane: number): Vec2 {
  const dx = wall.endX - wall.startX;
  const dy = wall.endY - wall.startY;
  const len = Math.hypot(dx, dy) || 1;
  const centre = wall.doorPosition * len;
  const lo = Math.max(BODY_RADIUS_M, centre - wall.doorWidth / 2 + BODY_RADIUS_M);
  const hi = Math.min(len - BODY_RADIUS_M, centre + wall.doorWidth / 2 - BODY_RADIUS_M);
  const t = Math.min(1, Math.max(0, lane));
  const at = lo <= hi ? lo + (hi - lo) * t : centre;
  return { x: wall.startX + (dx / len) * at, y: wall.startY + (dy / len) * at };
}

/**
 * Next point toward `target`. When the segment crosses a door wall, the point
 * is on that door's gap. `lane` in [0, 1] spreads people across the opening;
 * omit it to keep the door centre.
 */
export function nextIndoorWaypoint(pos: Vec2, target: Vec2, walls: WallLike[], lane?: number): Vec2 {
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
  if (lane == null) {
    return {
      x: best.startX + (best.endX - best.startX) * best.doorPosition,
      y: best.startY + (best.endY - best.startY) * best.doorPosition,
    };
  }
  return pointOnDoorGap(best, lane);
}

function wallFrame(wall: WallLike): { ux: number; uy: number; len: number } {
  const dx = wall.endX - wall.startX;
  const dy = wall.endY - wall.startY;
  const len = Math.hypot(dx, dy) || 1;
  return { ux: dx / len, uy: dy / len, len };
}

function nearestBlockingWall(pos: Vec2, target: Vec2, walls: WallLike[]): WallLike | null {
  const travel = Math.hypot(target.x - pos.x, target.y - pos.y);
  const samples = Math.max(1, Math.ceil(travel / 0.5));
  let bestT = Infinity;
  let best: WallLike | null = null;
  for (const wall of walls) {
    let hitT = Infinity;
    for (const [a, b] of solidParts(wall)) {
      const t = segmentsHitT(pos, target, a, b);
      if (t != null && t < hitT) hitT = t;
    }
    if (!(hitT < Infinity)) {
      for (let i = 1; i <= samples; i++) {
        const t = i / samples;
        const p = {
          x: pos.x + (target.x - pos.x) * t,
          y: pos.y + (target.y - pos.y) * t,
        };
        for (const [a, b] of solidParts(wall)) {
          if (projectOnto(p, a.x, a.y, b.x, b.y).dist < WALL_FACE_CLEAR_M) {
            hitT = t;
            break;
          }
        }
        if (hitT < Infinity) break;
      }
    }
    if (hitT < bestT) {
      bestT = hitT;
      best = wall;
    }
  }
  return best;
}

function gapSpan(wall: WallLike, inset: number): { ax: number; ay: number; bx: number; by: number } | null {
  if (!wall.hasDoor) return null;
  const { ux, uy, len } = wallFrame(wall);
  const centre = wall.doorPosition * len;
  const lo = Math.max(inset, centre - wall.doorWidth / 2 + inset);
  const hi = Math.min(len - inset, centre + wall.doorWidth / 2 - inset);
  const a = lo <= hi ? lo : centre;
  const b = lo <= hi ? hi : centre;
  return {
    ax: wall.startX + ux * a,
    ay: wall.startY + uy * a,
    bx: wall.startX + ux * b,
    by: wall.startY + uy * b,
  };
}

function usableGap(wall: WallLike): { ax: number; ay: number; bx: number; by: number } | null {
  return gapSpan(wall, BODY_RADIUS_M);
}

/** Project onto a segment. The normal points from the segment toward `pos`. */
function projectOnto(pos: Vec2, ax: number, ay: number, bx: number, by: number): {
  slot: Vec2;
  clamped: boolean;
  dist: number;
  nx: number;
  ny: number;
} {
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) {
    const vx = pos.x - ax;
    const vy = pos.y - ay;
    const d = Math.hypot(vx, vy) || 1;
    return { slot: { x: ax, y: ay }, clamped: true, dist: Math.hypot(vx, vy), nx: vx / d, ny: vy / d };
  }
  const ux = dx / len;
  const uy = dy / len;
  const raw = (pos.x - ax) * ux + (pos.y - ay) * uy;
  const t = Math.max(0, Math.min(len, raw));
  const slot = { x: ax + ux * t, y: ay + uy * t };
  let nx = -uy;
  let ny = ux;
  if ((pos.x - slot.x) * nx + (pos.y - slot.y) * ny < 0) {
    nx = -nx;
    ny = -ny;
  }
  const dist = Math.hypot(pos.x - slot.x, pos.y - slot.y);
  return { slot, clamped: raw < 0 || raw > len, dist, nx, ny };
}

function aroundSolid(pos: Vec2, wall: WallLike, target: Vec2): Vec2 {
  const ends = [
    { x: wall.startX, y: wall.startY },
    { x: wall.endX, y: wall.endY },
  ];
  let best = ends[0];
  let bestLen = Infinity;
  for (const end of ends) {
    const len =
      Math.hypot(end.x - pos.x, end.y - pos.y) + Math.hypot(target.x - end.x, target.y - end.y);
    if (len < bestLen) {
      bestLen = len;
      best = end;
    }
  }
  const { ux, uy } = wallFrame(wall);
  const midX = (wall.startX + wall.endX) / 2;
  const midY = (wall.startY + wall.endY) / 2;
  const along = Math.sign((best.x - midX) * ux + (best.y - midY) * uy) || 1;
  let nx = -uy;
  let ny = ux;
  // The person's own side. A waypoint on the target's side cuts the corner
  // and leaves the body pinned on the slab.
  if ((pos.x - best.x) * nx + (pos.y - best.y) * ny < 0) {
    nx = -nx;
    ny = -ny;
  }
  const clear = GAP_CLEAR_M + 0.2;
  return {
    x: best.x + ux * along * clear + nx * clear,
    y: best.y + uy * along * clear + ny * clear,
  };
}

/**
 * A point on the way to `target`. People in front of a door each keep their
 * own slot across the opening, so a crowd does not stack on the centre.
 * `hold` keeps them on the near side (the release cap has not let them through).
 * Solid walls are walked around at the nearer end.
 */
function doorInApproach(pos: Vec2, target: Vec2, walls: WallLike[]): WallLike | null {
  let best: WallLike | null = null;
  let bestDist = Infinity;
  for (const wall of walls) {
    if (!wall.hasDoor) continue;
    const mouth = mouthProgress(pos, wall, target);
    if (!mouth || mouth.through > 0.25 || mouth.dist > GAP_MOUTH_M) continue;
    if (mouth.dist < bestDist) {
      bestDist = mouth.dist;
      best = wall;
    }
  }
  return best;
}

export function steerToTarget(pos: Vec2, target: Vec2, walls: WallLike[], hold = false): Vec2 {
  let wall = nearestBlockingWall(pos, target, walls);
  if (hold) {
    const approach = doorInApproach(pos, target, walls);
    if (approach) wall = approach;
  }
  let aim = target;
  if (wall) {
    if (!wall.hasDoor) {
      aim = aroundSolid(pos, wall, target);
    } else {
      const gap = usableGap(wall);
      const opening = gapSpan(wall, 0);
      if (gap && opening) {
        const mouth = projectOnto(pos, opening.ax, opening.ay, opening.bx, opening.by);
        const mid = { x: (gap.ax + gap.bx) / 2, y: (gap.ay + gap.by) / 2 };
        const { ux, uy } = wallFrame(wall);
        let nx = -uy;
        let ny = ux;
        const along = (pos.x - mid.x) * ux + (pos.y - mid.y) * uy;
        const usableHalf = Math.hypot(gap.bx - gap.ax, gap.by - gap.ay) / 2;
        const lane = Math.max(-usableHalf, Math.min(usableHalf, along));
        const slot = { x: mid.x + ux * lane, y: mid.y + uy * lane };
        // Lineup normal points at the approach side (away from the target).
        // Using the body's side instead reverses the aim on the wall line, and
        // the crowd steps back and forth across the opening without crossing.
        const toward = (target.x - mid.x) * nx + (target.y - mid.y) * ny;
        if (toward > 0) {
          nx = -nx;
          ny = -ny;
        }
        const inFront = Math.abs(along) <= usableHalf + 0.05;
        const crossing = !hold && inFront && !mouth.clamped && mouth.dist < GAP_MOUTH_M;
        aim = crossing
          ? { x: slot.x - nx * GAP_THROUGH_M, y: slot.y - ny * GAP_THROUGH_M }
          : { x: slot.x + nx * GAP_CLEAR_M, y: slot.y + ny * GAP_CLEAR_M };
      }
    }
  }
  return separateFromWalls(aim, walls, WALL_FACE_CLEAR_M);
}

/** The door this person is about to enter, when they are already in its approach. */
export function committedDoor(
  pos: Vec2,
  target: Vec2,
  walls: WallLike[],
): { index: number; dist: number; through: number; width: number } | null {
  const wall = doorInApproach(pos, target, walls);
  if (!wall) return null;
  const mouth = mouthProgress(pos, wall, target);
  if (!mouth) return null;
  const index = walls.indexOf(wall);
  if (index < 0) return null;
  return { index, dist: mouth.dist, through: mouth.through, width: wall.doorWidth };
}

/**
 * Where a body centre has to move so it no longer overlaps the slab.
 * Alongside the wall that is `clear` from the line. Past a jamb it is only
 * the real overlap with the end of the slab: a circle of `clear` around the
 * jamb would fill the doorway and pin everyone there.
 */
function clearOfSlab(pos: Vec2, a: Vec2, b: Vec2, clear: number): Vec2 | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return null;
  const ux = dx / len;
  const uy = dy / len;
  const along = (pos.x - a.x) * ux + (pos.y - a.y) * uy;
  const proj = projectOnto(pos, a.x, a.y, b.x, b.y);
  if (along >= 0 && along <= len) {
    if (proj.dist >= clear || proj.dist < 1e-4) return null;
    return { x: proj.slot.x + proj.nx * clear, y: proj.slot.y + proj.ny * clear };
  }
  const end = along < 0 ? a : b;
  const nx = -uy;
  const ny = ux;
  const side = Math.sign((pos.x - end.x) * nx + (pos.y - end.y) * ny) || 1;
  const perp = Math.abs((pos.x - end.x) * nx + (pos.y - end.y) * ny);
  const past = along < 0 ? -along : along - len;
  const rect = {
    x: end.x + nx * side * Math.min(perp, SLAB_HALF_M),
    y: end.y + ny * side * Math.min(perp, SLAB_HALF_M),
  };
  const ox = pos.x - rect.x;
  const oy = pos.y - rect.y;
  const od = Math.hypot(ox, oy);
  if (od >= BODY_RADIUS_M || od < 1e-4) return null;
  if (past < 1e-4 && perp < 1e-4) return null;
  const need = BODY_RADIUS_M - od;
  return { x: pos.x + (ox / od) * need, y: pos.y + (oy / od) * need };
}

/**
 * Move a point out of every solid wall slab. Door openings are left alone.
 * `clear` is the distance from the wall line; 0.65 m is just out of contact.
 */
export function separateFromWalls(pos: Vec2, walls: WallLike[], clear = WALL_FACE_CLEAR_M): Vec2 {
  let x = pos.x;
  let y = pos.y;
  for (let pass = 0; pass < 4; pass++) {
    let moved = false;
    for (const wall of walls) {
      for (const [a, b] of solidParts(wall)) {
        const next = clearOfSlab({ x, y }, a, b, clear);
        if (!next) continue;
        x = next.x;
        y = next.y;
        moved = true;
      }
    }
    if (!moved) break;
  }
  return { x, y };
}

/** How far `pos` is from a door opening, and how far through it toward `target`. */
export function mouthProgress(
  pos: Vec2,
  wall: WallLike,
  target: Vec2,
): { dist: number; through: number } | null {
  if (!wall.hasDoor) return null;
  const gap = usableGap(wall);
  if (!gap) return null;
  const proj = projectOnto(pos, gap.ax, gap.ay, gap.bx, gap.by);
  const { ux, uy } = wallFrame(wall);
  let nx = -uy;
  let ny = ux;
  if ((target.x - proj.slot.x) * nx + (target.y - proj.slot.y) * ny < 0) {
    nx = -nx;
    ny = -ny;
  }
  return {
    dist: proj.dist,
    through: (pos.x - proj.slot.x) * nx + (pos.y - proj.slot.y) * ny,
  };
}

/** The person's slot on an exit opening: nearest point, inset by a body radius. */
export function exitGapSlot(pos: Vec2, exit: ExitDef, verts: Vec2[]): {
  slot: Vec2;
  inward: Vec2;
  clamped: boolean;
  planeDist: number;
} | null {
  const a = verts[exit.edgeIndex];
  const b = verts[(exit.edgeIndex + 1) % verts.length];
  if (!a || !b) return null;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const half = Math.max(0, exit.width / 2 - BODY_RADIUS_M);
  const gap = projectOnto(
    pos,
    exit.center.x - ux * half,
    exit.center.y - uy * half,
    exit.center.x + ux * half,
    exit.center.y + uy * half,
  );
  const fullHalf = exit.width / 2;
  const full = projectOnto(
    pos,
    exit.center.x - ux * fullHalf,
    exit.center.y - uy * fullHalf,
    exit.center.x + ux * fullHalf,
    exit.center.y + uy * fullHalf,
  );
  // projectOnto's normal points at pos. Inward is from the exit toward the inside approach.
  const approach = exitApproachInside(exit, verts);
  const ix = approach.x - exit.center.x;
  const iy = approach.y - exit.center.y;
  const il = Math.hypot(ix, iy) || 1;
  const inward = { x: ix / il, y: iy / il };
  const planeDist = (pos.x - gap.slot.x) * inward.x + (pos.y - gap.slot.y) * inward.y;
  return { slot: gap.slot, inward, clamped: full.clamped, planeDist };
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

const OUTDOOR_CLEARANCE_M = 3;
/** Wall half-thickness (0.4 m) plus a body radius (0.25 m). */
const OUTDOOR_BODY_CLEARANCE_M = 0.65;
/** First step outside a door, straight out, before any corner. */
const OUTDOOR_DEPART_M = 2.5;
const OUTDOOR_DOOR_M = 1.5;

function offsetOutline(verts: Vec2[], dist: number): Vec2[] {
  const n = verts.length;
  if (n < 3) return verts.map((v) => ({ ...v }));
  const normals: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const a = verts[i];
    const b = verts[(i + 1) % n];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    let nx = -dy / len;
    let ny = dx / len;
    if (isInsidePolygon((a.x + b.x) / 2 + nx, (a.y + b.y) / 2 + ny, verts)) {
      nx = -nx;
      ny = -ny;
    }
    normals.push({ x: nx, y: ny });
  }
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const n0 = normals[(i + n - 1) % n];
    const n1 = normals[i];
    let bx = n0.x + n1.x;
    let by = n0.y + n1.y;
    const bl = Math.hypot(bx, by);
    if (bl < 1e-6) {
      bx = n1.x;
      by = n1.y;
    } else {
      bx /= bl;
      by /= bl;
    }
    const denom = bx * n1.x + by * n1.y;
    const scale = Math.abs(denom) > 0.25 ? dist / denom : dist;
    out.push({ x: verts[i].x + bx * scale, y: verts[i].y + by * scale });
  }
  return out;
}

function segmentCrossesOutline(a: Vec2, b: Vec2, verts: Vec2[]): boolean {
  for (let i = 0; i < verts.length; i++) {
    if (segmentsHitT(a, b, verts[i], verts[(i + 1) % verts.length]) != null) return true;  }
  return false;
}

function walkRing(ring: Vec2[], from: number, to: number, dir: 1 | -1): Vec2[] {
  const n = ring.length;
  const out: Vec2[] = [ring[from]];
  let i = from;
  while (i !== to && out.length <= n) {
    i = (i + dir + n) % n;
    out.push(ring[i]);
  }
  return out;
}

function pathLength(pts: Vec2[]): number {
  let len = 0;
  for (let i = 1; i < pts.length; i++) {
    len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  }
  return len;
}

function outwardFrame(p: Vec2, verts: Vec2[]): { foot: Vec2; out: Vec2 } {
  let best = Infinity;
  let foot = p;
  let out = { x: 0, y: 1 };
  for (let i = 0; i < verts.length; i++) {
    const a = verts[i];
    const b = verts[(i + 1) % verts.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / (len * len);
    t = Math.max(0, Math.min(1, t));
    const fx = a.x + dx * t;
    const fy = a.y + dy * t;
    const d = Math.hypot(p.x - fx, p.y - fy);
    if (d < best) {
      best = d;
      foot = { x: fx, y: fy };
      let nx = -dy / len;
      let ny = dx / len;
      if (isInsidePolygon(fx + nx, fy + ny, verts)) {
        nx = -nx;
        ny = -ny;
      }
      out = { x: nx, y: ny };
    }
  }
  return { foot, out };
}

/** A leg stays outside the building and at least ~0.65 m off the outline. */
function legClearsBuilding(a: Vec2, b: Vec2, verts: Vec2[]): boolean {
  if (segmentCrossesOutline(a, b, verts)) return false;
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const n = Math.max(1, Math.ceil(len / 0.5));
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const x = a.x + (b.x - a.x) * t;
    const y = a.y + (b.y - a.y) * t;
    if (distanceToOutline(x, y, verts) < OUTDOOR_BODY_CLEARANCE_M) return false;
  }
  return true;
}

function sampleRing(ring: Vec2[], step: number): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const n = Math.max(1, Math.round(len / step));
    for (let k = 0; k < n; k++) {
      const t = k / n;
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  }
  return out;
}

/**
 * Outdoor route that stays off the building. Someone who has just come through
 * a door is sent straight out first. Ring points are chosen because they can
 * see the departure and the target, not because they are the nearest corner.
 */
export function routeAroundOutline(from: Vec2, target: Vec2, verts: Vec2[]): Vec2[] {
  if (verts.length < 3) return [target];
  const atDoor = distanceToOutline(from.x, from.y, verts) <= OUTDOOR_DOOR_M;
  const frame = atDoor ? outwardFrame(from, verts) : null;
  const depart = frame
    ? {
        x: frame.foot.x + frame.out.x * OUTDOOR_DEPART_M,
        y: frame.foot.y + frame.out.y * OUTDOOR_DEPART_M,
      }
    : from;
  const origin = atDoor ? depart : from;
  if (legClearsBuilding(origin, target, verts)) {
    return atDoor ? [depart, { ...target }] : [{ ...target }];
  }
  let fallback: Vec2[] = atDoor ? [depart, { ...target }] : [{ ...target }];
  for (const clearance of [OUTDOOR_CLEARANCE_M, 6, 9]) {
    const ring = offsetOutline(verts, clearance);
    if (ring.length < 3) continue;
    const samples = sampleRing(ring, 4);
    const fromIdx: number[] = [];
    const toIdx: number[] = [];
    for (let i = 0; i < samples.length; i++) {
      if (legClearsBuilding(origin, samples[i], verts)) fromIdx.push(i);
      if (legClearsBuilding(samples[i], target, verts)) toIdx.push(i);
    }
    let best: Vec2[] | null = null;
    let bestLen = Infinity;
    for (const i of fromIdx) {
      for (const j of toIdx) {
        for (const dir of [1, -1] as const) {
          const along = walkRing(samples, i, j, dir);
          const len = pathLength([origin, ...along, target]);
          if (len < bestLen) {
            bestLen = len;
            best = along;
          }
        }
      }
    }
    if (best) {
      const path = [...best, { ...target }];
      if (atDoor) path.unshift(depart);
      return path;
    }
    fallback = atDoor ? [depart, { ...target }] : [{ ...target }];
  }
  return fallback;
}
function segmentsCross(p1: Vec2, p2: Vec2, p3: Vec2, p4: Vec2): { t: number; u: number } | null {
  const d1x = p2.x - p1.x;
  const d1y = p2.y - p1.y;
  const d2x = p4.x - p3.x;
  const d2y = p4.y - p3.y;
  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < 1e-10) return null;
  const t = ((p3.x - p1.x) * d2y - (p3.y - p1.y) * d2x) / denom;
  const u = ((p3.x - p1.x) * d1y - (p3.y - p1.y) * d1x) / denom;
  if (t > 1e-4 && t <= 1 + 1e-6 && u >= -1e-6 && u <= 1 + 1e-6) return { t, u };
  return null;
}

/** True when a solid wall or outline edge sits just behind the person, on the side away from the charge. */
export function isNearWallBehind(
  p: Vec2,
  site: Vec2,
  walls: WallLike[],
  verts: Vec2[],
  exits?: Array<Pick<ExitDef, 'center' | 'width' | 'edgeIndex'>>,
): boolean {
  const dx = p.x - site.x;
  const dy = p.y - site.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return false;
  const reach = BLAST_CONSTANTS.NEAR_WALL_M;
  const end = { x: p.x + (dx / len) * reach, y: p.y + (dy / len) * reach };
  for (const wall of walls) {
    for (const [a, b] of solidParts(wall)) {
      if (segmentsCross(p, end, a, b)) return true;
    }
  }
  const n = verts.length;
  for (let i = 0; i < n; i++) {
    const a = verts[i]!;
    const b = verts[(i + 1) % n]!;
    const hit = segmentsCross(p, end, a, b);
    if (!hit) continue;
    const edgeDx = b.x - a.x;
    const edgeDy = b.y - a.y;
    const edgeLen = Math.hypot(edgeDx, edgeDy);
    if (edgeLen < 1e-6) continue;
    let gap = false;
    for (const exit of exits ?? []) {
      if (exit.edgeIndex !== i || exit.width <= 0) continue;
      const along = ((exit.center.x - a.x) * edgeDx + (exit.center.y - a.y) * edgeDy) / (edgeLen * edgeLen);
      const half = exit.width / (2 * edgeLen);
      const t0 = Math.max(0, along - half);
      const t1 = Math.min(1, along + half);
      if (hit.u >= t0 - 1e-6 && hit.u <= t1 + 1e-6) {
        gap = true;
        break;
      }
    }
    if (!gap) return true;
  }
  return false;
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
