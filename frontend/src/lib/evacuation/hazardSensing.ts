import type { ExitDef, Vec2 } from './types';
import { isInsidePolygon } from './geometry';
import { SHOWCASE } from './showcaseConstants';
import { BLAST_CONSTANTS } from '../rts/blast/blastModel';
import type { LevelDef, Stairwell } from '../rts/types';
import { levelIndex, levelOf, linkLevels, stairFlowPerS, stairTravelS } from '../rts/levels';

export type HeadSmokeClass = 'clear' | 'light' | 'thick' | 'untenable';
export type FireCell = 'none' | 'heating' | 'burning' | 'burnt_out';
export type Familiarity = 'visitor' | 'staff';
export type Posture = 'stand' | 'crouch' | 'crawl';

export interface HazardSample {
  smoke: number;
  fire: FireCell;
  /** True when an open spray has wetted the nearest stud. Absent means dry. */
  wet: boolean;
}

export interface HazardStud {
  id: string;
  simPos: Vec2;
  indoor: boolean;
}

interface StudStateLike {
  smoke: number;
  fire: { state: string };
  wet?: boolean;
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
    if (!nearest) return { smoke: 0, fire: 'none', wet: false };
    const st = this.states?.get(nearest.id);
    return { smoke: st?.smoke ?? 0, fire: asFireCell(st?.fire.state), wet: st?.wet === true };
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

export function isExitUsable(
  exit: ExitDef,
  verts: Vec2[],
  field: HazardField,
  recover = false,
): boolean {
  if (exit.exitType === 'service') return false;
  if (exit.status === 'blocked') return false;
  const approach = exitApproachInside(exit, verts);
  const s = field.sample(approach.x, approach.y);
  if (s.fire === 'burning') return false;
  const k = extinctionK(s.smoke);
  // Inclusive at the open threshold: K 1.5 is still usable, 1.51 is not
  // (showcase oracle). Once an exit has gone unusable, it is usable again
  // only below 1.3, so a value sitting between the two does not flip.
  if (recover ? k >= SHOWCASE.REROUTE_RECOVER : k > SHOWCASE.REROUTE_EXTINCTION) return false;
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
  blockedDoors?: readonly WallLike[],
  recover = false,
): number {
  if (!isExitUsable(exit, verts, field, recover)) return Infinity;
  const approach = exitApproachInside(exit, verts);
  if (
    blockedDoors &&
    blockedDoors.length > 0 &&
    routeCrossesBlockedDoor(pos, exit, verts, walls, blockedDoors)
  ) {
    return Infinity;
  }
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
    blockedDoors?: readonly WallLike[];
  },
): ExitChoice | null {
  const avoided = new Set(options?.avoidIds ?? []);
  const pool = exits.filter((e) => e.id !== options?.excludeId && !avoided.has(e.id));
  // The exit someone is already on stays usable up to 1.5. Every other exit,
  // and a current exit that has already gone unusable, needs to be back under
  // 1.3 before it can be chosen.
  const heldUsable = current != null && current.cost < Infinity;
  const costOf = (e: ExitDef) =>
    exitCost(
      pos,
      e,
      verts,
      field,
      options?.walls,
      options?.blockedDoors,
      current != null && !(heldUsable && e.id === current.id),
    );
  const ranked = pool
    .map((e) => ({ id: e.id, cost: costOf(e) }))
    .sort((a, b) => a.cost - b.cost || a.id.localeCompare(b.id));
  const best = ranked.find((r) => r.cost < Infinity);

  if (!best) {
    // §2.6: every exit costs Infinity. Keep the current door while it is
    // still a door, so a check that sits on the smoke threshold does not
    // hop to whichever exit is nearest this frame. The nearest-exit crawl
    // is only for someone with no open current door. Avoid lists and the
    // exclude id do not apply to that crawl — a sticky turn-back must not
    // force someone past a nearer door onto a farther one.
    const held = current != null ? exits.find((e) => e.id === current.id) : undefined;
    const doorBlocked =
      held != null &&
      options?.blockedDoors != null &&
      options.blockedDoors.length > 0 &&
      routeCrossesBlockedDoor(pos, held, verts, options.walls, options.blockedDoors);
    if (
      held &&
      held.id !== options?.excludeId &&
      held.exitType !== 'service' &&
      held.status !== 'blocked' &&
      !doorBlocked
    ) {
      return { id: held.id, cost: Infinity, forced: true };
    }
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
    const now = costOf(pool.find((e) => e.id === current.id) as ExitDef);
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

/**
 * A crossing this close to a wall end still counts. The old 1% of the wall
 * length missed a joint, so a route looked clear while the wall body held
 * the person there. Five centimetres is shorter than a body.
 */
const WALL_END_TOL_M = 0.05;

function segmentsHitT(p1: Vec2, p2: Vec2, p3: Vec2, p4: Vec2): number | null {
  const d1x = p2.x - p1.x;
  const d1y = p2.y - p1.y;
  const d2x = p4.x - p3.x;
  const d2y = p4.y - p3.y;
  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < 1e-10) return null;
  const t = ((p3.x - p1.x) * d2y - (p3.y - p1.y) * d2x) / denom;
  const u = ((p3.x - p1.x) * d1y - (p3.y - p1.y) * d1x) / denom;
  if (!(t > 0.01 && t < 0.99)) return null;
  const wallLen = Math.hypot(d2x, d2y);
  const along = u * wallLen;
  if (along >= -WALL_END_TOL_M && along <= wallLen + WALL_END_TOL_M) return t;
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

/**
 * Stay about this far from a downed or static body in open space. Two body
 * radii are 0.5 m, so 0.8 m leaves a gap and still lets people slip past.
 * A door mouth is narrower than that gap: there the keep-out shrinks to
 * contact distance, DOWNED_CONTACT_M.
 */
export const DOWNED_AVOID_M = 0.8;

/** Centre-to-centre distance at which two pedestrians touch. */
export const DOWNED_CONTACT_M = BODY_RADIUS_M * 2;

/**
 * A walker-centre gap narrower than this, and not against the jamb, jams.
 * Two bodies with a 0.6 m surface gap leave 0.10 m between their contact
 * disks; people overlap by a few centimetres and stop, and the door still
 * looks open so nobody reroutes. A sliver against the frame still counts
 * as open: one body in a 1.6 m door leaves only that, and people get through.
 */
const NARROW_INTERIOR_LANE_M = 0.15;

interface DoorFrame {
  ux: number;
  uy: number;
  nx: number;
  ny: number;
  len: number;
}

/**
 * Reused frames. `frameScratch` is only valid until the next load.
 * `frameHold` is for a caller that then loads the scratch frame.
 */
const frameScratch: DoorFrame = { ux: 0, uy: 0, nx: 0, ny: 0, len: 0 };
const frameHold: DoorFrame = { ux: 0, uy: 0, nx: 0, ny: 0, len: 0 };

function loadDoorFrame(wall: WallLike, out: DoorFrame): DoorFrame {
  const dx = wall.endX - wall.startX;
  const dy = wall.endY - wall.startY;
  const len = Math.hypot(dx, dy) || 1;
  out.len = len;
  out.ux = dx / len;
  out.uy = dy / len;
  out.nx = -out.uy;
  out.ny = out.ux;
  return out;
}

/** Walker-centre span of a door, metres from the wall start. Null when the opening is narrower than a body. */
function usableAlong(wall: WallLike): { lo: number; hi: number } | null {
  if (!wall.hasDoor || !(wall.doorWidth > 0)) return null;
  const { len } = wallFrame(wall);
  const centre = wall.doorPosition * len;
  const lo = Math.max(BODY_RADIUS_M, centre - wall.doorWidth / 2 + BODY_RADIUS_M);
  const hi = Math.min(len - BODY_RADIUS_M, centre + wall.doorWidth / 2 - BODY_RADIUS_M);
  if (!(hi > lo + 1e-3)) return null;
  return { lo, hi };
}

interface BodyOnDoor {
  index: number;
  along: number;
  off: number;
}

function bodiesOnDoor(
  wall: WallLike,
  bodies: ReadonlyArray<{ x: number; y: number }>,
  contact: number,
  count = bodies.length,
): BodyOnDoor[] {
  const frame = loadDoorFrame(wall, frameScratch);
  const centre = wall.doorPosition * frame.len;
  const half = wall.doorWidth / 2 + contact;
  const out: BodyOnDoor[] = [];
  for (let i = 0; i < count; i++) {
    const b = bodies[i];
    const dx = b.x - wall.startX;
    const dy = b.y - wall.startY;
    const along = dx * frame.ux + dy * frame.uy;
    const off = dx * frame.nx + dy * frame.ny;
    if (Math.abs(off) >= contact) continue;
    if (along < centre - half || along > centre + half) continue;
    out.push({ index: i, along, off });
  }
  return out;
}

function laneUsable(lo: number, hi: number, spanLo: number, spanHi: number): boolean {
  const width = hi - lo;
  if (!(width > 1e-3)) return false;
  if (width + 1e-6 >= NARROW_INTERIOR_LANE_M) return true;
  // Against the frame, not between two bodies. Keep this: the 0.05 m sliver
  // beside one body in a 1.6 m door is how that crowd gets through.
  return lo <= spanLo + 1e-3 || hi >= spanHi - 1e-3;
}

/**
 * Centre-line intervals a walker can still use, metres from the wall start.
 * Null when no body reaches the opening. Empty when bodies cover every usable
 * point, including when the only leftover is a narrow lane between bodies.
 * `count` lets the caller pass a reused buffer longer than the live list.
 */
export function doorFreeLanes(
  wall: WallLike,
  bodies: ReadonlyArray<{ x: number; y: number }>,
  contact = DOWNED_CONTACT_M,
  count = bodies.length,
): Array<[number, number]> | null {
  const span = usableAlong(wall);
  if (!span) return null;
  const onDoor = bodiesOnDoor(wall, bodies, contact, count);
  if (onDoor.length === 0) return null;
  const cuts: Array<[number, number]> = [];
  for (const b of onDoor) {
    const reachSq = contact * contact - b.off * b.off;
    if (!(reachSq > 0)) continue;
    const reach = Math.sqrt(reachSq);
    const a = Math.max(span.lo, b.along - reach);
    const c = Math.min(span.hi, b.along + reach);
    if (c > a) cuts.push([a, c]);
  }
  if (cuts.length === 0) return null;
  cuts.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const free: Array<[number, number]> = [];
  let cursor = span.lo;
  for (const [a, c] of cuts) {
    if (a > cursor + 1e-3 && laneUsable(cursor, a, span.lo, span.hi)) free.push([cursor, a]);
    if (c > cursor) cursor = c;
  }
  if (span.hi > cursor + 1e-3 && laneUsable(cursor, span.hi, span.lo, span.hi)) free.push([cursor, span.hi]);
  return free;
}

/** True when no usable walker-centre lane remains in the opening. */
export function doorBlockedByBodies(
  wall: WallLike,
  bodies: ReadonlyArray<{ x: number; y: number }>,
  contact = DOWNED_CONTACT_M,
): boolean {
  const lanes = doorFreeLanes(wall, bodies, contact);
  return lanes != null && lanes.length === 0;
}

/** Indices of bodies standing in a door opening. The keep-out for these shrinks to contact. */
export function doorMouthIndices(
  walls: readonly WallLike[],
  bodies: ReadonlyArray<{ x: number; y: number }>,
  contact = DOWNED_CONTACT_M,
): number[] {
  const ids = new Set<number>();
  for (const wall of walls) {
    if (!wall.hasDoor || !(wall.doorWidth > 0)) continue;
    for (const b of bodiesOnDoor(wall, bodies, contact)) ids.add(b.index);
  }
  return [...ids];
}

/** Writes 1 at each index standing in any door opening, and 0 at the rest. */
export function markBodiesInDoors(
  walls: readonly WallLike[],
  bodies: ReadonlyArray<{ x: number; y: number }>,
  mark: number[],
  contact = DOWNED_CONTACT_M,
): void {
  for (let i = 0; i < bodies.length; i++) mark[i] = 0;
  for (const wall of walls) {
    if (!wall.hasDoor || !(wall.doorWidth > 0)) continue;
    const frame = loadDoorFrame(wall, frameScratch);
    const centre = wall.doorPosition * frame.len;
    const half = wall.doorWidth / 2 + contact;
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i];
      const dx = b.x - wall.startX;
      const dy = b.y - wall.startY;
      const off = dx * frame.nx + dy * frame.ny;
      if (Math.abs(off) >= contact) continue;
      const along = dx * frame.ux + dy * frame.uy;
      if (along < centre - half || along > centre + half) continue;
      mark[i] = 1;
    }
  }
}

/** Where the segment crosses a door opening, as a fraction along a→b. */
function openingCrossT(a: Vec2, b: Vec2, wall: WallLike): number | null {
  if (!wall.hasDoor || !(wall.doorWidth > 0)) return null;
  const frame = loadDoorFrame(wall, frameScratch);
  const ax = a.x - wall.startX;
  const ay = a.y - wall.startY;
  const bx = b.x - wall.startX;
  const by = b.y - wall.startY;
  const offA = ax * frame.nx + ay * frame.ny;
  const offB = bx * frame.nx + by * frame.ny;
  if (offA * offB > 1e-4 && Math.min(Math.abs(offA), Math.abs(offB)) > 0.35) return null;
  const denom = offA - offB;
  if (Math.abs(denom) < 1e-9) return null;
  const t = offA / denom;
  if (t < -0.02 || t > 1.02) return null;
  const clamped = Math.max(0, Math.min(1, t));
  const along = (ax + (bx - ax) * clamped) * frame.ux + (ay + (by - ay) * clamped) * frame.uy;
  const centre = wall.doorPosition * frame.len;
  const half = wall.doorWidth / 2;
  if (along < centre - half - 0.05 || along > centre + half + 0.05) return null;
  return Math.max(0, Math.min(1, t));
}

export function segmentHitsBlockedDoor(a: Vec2, b: Vec2, doors: readonly WallLike[]): boolean {
  for (const wall of doors) {
    if (openingCrossT(a, b, wall) != null) return true;
  }
  return false;
}

/** The walked route to this exit goes through a door bodies have closed. */
export function routeCrossesBlockedDoor(
  pos: Vec2,
  exit: ExitDef,
  verts: Vec2[],
  walls: WallLike[] | undefined,
  blockedDoors: readonly WallLike[],
): boolean {
  if (blockedDoors.length === 0) return false;
  const approach = exitApproachInside(exit, verts);
  for (const [a, b] of routeLegs(pos, approach, walls)) {
    if (segmentHitsBlockedDoor(a, b, blockedDoors)) return true;
  }
  return false;
}

/**
 * Aim through the free part of a door a body is standing in.
 * The point is past the opening, on a line that clears the body by contact
 * distance, so the open-floor sidestep does not throw the aim into the jamb.
 * Null when no passable door on the way has a body in it.
 */
export function doorSqueezeAim(
  pos: Vec2,
  target: Vec2,
  walls: readonly WallLike[],
  bodies: ReadonlyArray<{ x: number; y: number }>,
  contact = DOWNED_CONTACT_M,
  lanesFor?: (wall: WallLike) => Array<[number, number]> | null,
): { aim: Vec2; mouth: number[] } | null {
  let bestWall: WallLike | null = null;
  let bestT = Infinity;
  let bestLanes: Array<[number, number]> | null = null;
  for (const wall of walls) {
    const lanes = lanesFor ? lanesFor(wall) : doorFreeLanes(wall, bodies, contact);
    if (!lanes || lanes.length === 0) continue;
    const t = openingCrossT(pos, target, wall);
    if (t == null || t >= bestT) continue;
    bestT = t;
    bestWall = wall;
    bestLanes = lanes;
  }
  if (!bestWall || !bestLanes) return null;
  const frame = loadDoorFrame(bestWall, frameHold);
  const along = (pos.x - bestWall.startX) * frame.ux + (pos.y - bestWall.startY) * frame.uy;
  const onDoor = bodiesOnDoor(bestWall, bodies, contact);
  let lane = bestLanes[0];
  let laneDist = Infinity;
  for (const iv of bestLanes) {
    const mid = (iv[0] + iv[1]) / 2;
    const d = Math.abs(mid - along);
    if (d < laneDist) {
      laneDist = d;
      lane = iv;
    }
  }
  const inset = Math.min(0.01, (lane[1] - lane[0]) * 0.25);
  const ends = [lane[0] + inset, lane[1] - inset];
  const clearOf = (at: number) => {
    let best = Infinity;
    for (const b of onDoor) best = Math.min(best, Math.hypot(at - b.along, b.off));
    return best;
  };
  const at = clearOf(ends[0]) >= clearOf(ends[1]) ? ends[0] : ends[1];
  const onLine = {
    x: bestWall.startX + frame.ux * at,
    y: bestWall.startY + frame.uy * at,
  };
  let nx = frame.nx;
  let ny = frame.ny;
  if ((target.x - onLine.x) * nx + (target.y - onLine.y) * ny < 0) {
    nx = -nx;
    ny = -ny;
  }
  const mouth = onDoor.map((b) => b.index);
  // Once the centre is through the slot, keep going the way the target lies.
  // Extending the approach line past that point turns around and pins them on the body.
  const progress = (pos.x - onLine.x) * nx + (pos.y - onLine.y) * ny;
  if (progress > 0.4) return { aim: target, mouth };
  if (progress > 0) return { aim: { x: onLine.x + nx * 1.5, y: onLine.y + ny * 1.5 }, mouth };
  const vx = onLine.x - pos.x;
  const vy = onLine.y - pos.y;
  const dist = Math.hypot(vx, vy) || 1;
  return {
    aim: { x: onLine.x + (vx / dist) * 1.2, y: onLine.y + (vy / dist) * 1.2 },
    mouth,
  };
}

/**
 * Move the steering target off a downed or static body that stands on the way.
 * A head-on repulsion stops on the body; this puts the aim on one side of it.
 * A body may carry its own radius. Door mouths pass contact distance; open floor stays at 0.8 m.
 */
let skipGen = 1;
const skipStamp: number[] = [];

export function steerPastBodies(
  pos: Vec2,
  target: Vec2,
  bodies: ReadonlyArray<{ x: number; y: number; radius?: number }>,
  radius = DOWNED_AVOID_M,
  out?: Vec2,
): Vec2 {
  let aimX = target.x;
  let aimY = target.y;
  if (++skipGen >= 0x7ffffffe) {
    skipStamp.fill(0);
    skipGen = 1;
  }
  const gen = skipGen;
  for (let pass = 0; pass < 4; pass++) {
    const dx = aimX - pos.x;
    const dy = aimY - pos.y;
    const len = Math.hypot(dx, dy);
    if (len < 0.05) break;
    const ux = dx / len;
    const uy = dy / len;
    let bestI = -1;
    let bestAlong = Infinity;
    let bestVx = 0;
    let bestVy = 0;
    let bestAvoid = radius;
    for (let i = 0; i < bodies.length; i++) {
      if (skipStamp[i] === gen) continue;
      const avoid = bodies[i].radius ?? radius;
      const vx = bodies[i].x - pos.x;
      const vy = bodies[i].y - pos.y;
      const along = vx * ux + vy * uy;
      const lat = Math.abs(ux * vy - uy * vx);
      const dist = Math.hypot(vx, vy);
      const onTheWay = along > -avoid * 0.25 && along < len && lat < avoid;
      const overlapping = dist < avoid && along > -avoid * 0.5;
      if (!onTheWay && !overlapping) continue;
      if (along < bestAlong) {
        bestAlong = along;
        bestI = i;
        bestVx = vx;
        bestVy = vy;
        bestAvoid = avoid;
      }
    }
    if (bestI < 0) break;
    skipStamp[bestI] = gen;
    const cross = ux * bestVy - uy * bestVx;
    // Positive cross means the body is to the left. Step the other way.
    const side =
      Math.abs(cross) > 0.02
        ? -Math.sign(cross)
        : ((Math.round(pos.x * 8) + Math.round(pos.y * 8)) & 1) === 0
          ? 1
          : -1;
    const past = Math.min(len, Math.max(bestAlong, 0) + bestAvoid);
    aimX = pos.x + ux * past - uy * side * bestAvoid;
    aimY = pos.y + uy * past + ux * side * bestAvoid;
  }
  if (out) {
    out.x = aimX;
    out.y = aimY;
    return out;
  }
  return { x: aimX, y: aimY };
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

export interface RouteChoice {
  kind: 'exit' | 'stair';
  id: string;
  cost: number;
  dir?: 'up' | 'down';
  toLevel?: string;
}

function routePointCost(a: Vec2, b: Vec2, field: HazardField | undefined): number {
  let extra = 0;
  if (field) {
    for (const p of sampleSegment(a, b, SHOWCASE.SAMPLE_STEP_M)) {
      const s = field.sample(p.x, p.y);
      if (s.fire === 'burning') return Infinity;
      extra += extinctionK(s.smoke) * SHOWCASE.SMOKE_COST_M_PER_K;
    }
  }
  return Math.hypot(b.x - a.x, b.y - a.y) + extra;
}

/**
 * Next hop toward the cheapest usable exit, possibly via stairs.
 * Lifts are not used. Returns null when no stair or exit can be reached.
 */
export function chooseRoute(
  pos: Vec2,
  level: string,
  exits: ExitDef[],
  stairs: Stairwell[],
  levels: LevelDef[],
  fields: ReadonlyMap<string, HazardField>,
  verts: Vec2[],
  queues?: ReadonlyMap<string, { up: number; down: number }>,
  current?: { id: string; cost: number } | null,
  blockedDoors?: ReadonlyMap<string, readonly WallLike[]>,
  wallsByLevel?: ReadonlyMap<string, readonly WallLike[]>,
): RouteChoice | null {
  const fieldOf = (id: string) => fields.get(id);
  interface Node {
    key: string;
    level: string;
    pos: Vec2;
    kind: 'person' | 'exit' | 'stair';
    id: string;
  }
  const nodes = new Map<string, Node>();
  nodes.set('person', { key: 'person', level, pos, kind: 'person', id: '' });

  for (const sw of stairs) {
    if (sw.blocked || sw.kind === 'lift') continue;
    const span = linkLevels(sw, levels);
    for (let i = 0; i < span.length; i++) {
      const key = `stair:${sw.id}:${span[i]}`;
      nodes.set(key, { key, level: span[i], pos: sw.pos, kind: 'stair', id: sw.id });
    }
  }
  for (const exit of exits) {
    const exitLevel = levelOf(exit);
    const field = fieldOf(exitLevel);
    if (field && !isExitUsable(exit, verts, field)) continue;
    if (!field && (exit.exitType === 'service' || exit.status === 'blocked')) continue;
    const key = `exit:${exit.id}`;
    nodes.set(key, { key, level: exitLevel, pos: exit.center, kind: 'exit', id: exit.id });
  }

  const edges = new Map<string, Array<{ to: string; cost: number }>>();
  const add = (from: string, to: string, cost: number) => {
    if (!(cost < Infinity)) return;
    const list = edges.get(from);
    if (list) list.push({ to, cost });
    else edges.set(from, [{ to, cost }]);
  };

  const byLevel = new Map<string, Node[]>();
  for (const node of nodes.values()) {
    if (node.kind === 'person') continue;
    const list = byLevel.get(node.level);
    if (list) list.push(node);
    else byLevel.set(node.level, [node]);
  }
  const linkCost = (a: Node, b: Node): number => {
    const field = fieldOf(a.level);
    const doors = blockedDoors?.get(a.level);
    const walls = wallsByLevel?.get(a.level) as WallLike[] | undefined;
    if (doors && doors.length > 0 && segmentHitsBlockedDoor(a.pos, b.pos, doors)) return Infinity;
    if (b.kind === 'exit') {
      const exit = exits.find((e) => e.id === b.id);
      if (!exit) return Infinity;
      if (!field) {
        if (doors && doors.length > 0 && routeCrossesBlockedDoor(a.pos, exit, verts, walls, doors)) {
          return Infinity;
        }
        return Math.hypot(b.pos.x - a.pos.x, b.pos.y - a.pos.y);
      }
      return exitCost(a.pos, exit, verts, field, walls, doors);
    }
    return routePointCost(a.pos, b.pos, field);
  };
  for (const [lvl, group] of byLevel) {
    if (lvl === level) {
      const person = nodes.get('person')!;
      for (const node of group) add('person', node.key, linkCost(person, node));
    }
    for (const a of group) {
      for (const b of group) {
        if (a.key === b.key) continue;
        add(a.key, b.key, linkCost(a, b));
      }
    }
  }
  for (const sw of stairs) {
    if (sw.blocked || sw.kind === 'lift') continue;
    const span = linkLevels(sw, levels);
    const flow = stairFlowPerS(sw);
    const q = queues?.get(sw.id) ?? { up: 0, down: 0 };
    for (let i = 0; i < span.length - 1; i++) {
      const lowerId = span[i];
      const upperId = span[i + 1];
      if (levelIndex(upperId) !== levelIndex(lowerId) + 1) continue;
      const lower = levels.find((l) => l.id === lowerId);
      const upper = levels.find((l) => l.id === upperId);
      if (!lower || !upper) continue;
      const upM =
        stairTravelS(lower, 'up') * SHOWCASE.FREE_WALK_SPEED +
        (q.up / flow) * SHOWCASE.FREE_WALK_SPEED;
      const downM =
        stairTravelS(upper, 'down') * SHOWCASE.FREE_WALK_SPEED +
        (q.down / flow) * SHOWCASE.FREE_WALK_SPEED;
      add(`stair:${sw.id}:${lowerId}`, `stair:${sw.id}:${upperId}`, upM);
      add(`stair:${sw.id}:${upperId}`, `stair:${sw.id}:${lowerId}`, downM);
    }
  }

  const dist = new Map<string, number>([['person', 0]]);
  const prev = new Map<string, string>();
  const seen = new Set<string>();
  while (seen.size < nodes.size) {
    let bestKey: string | null = null;
    let bestD = Infinity;
    for (const key of nodes.keys()) {
      if (seen.has(key)) continue;
      const d = dist.get(key) ?? Infinity;
      if (d < bestD) {
        bestD = d;
        bestKey = key;
      }
    }
    if (!bestKey || !(bestD < Infinity)) break;
    seen.add(bestKey);
    for (const edge of edges.get(bestKey) ?? []) {
      const next = bestD + edge.cost;
      if (next < (dist.get(edge.to) ?? Infinity)) {
        dist.set(edge.to, next);
        prev.set(edge.to, bestKey);
      }
    }
  }

  let bestExit: Node | null = null;
  let bestCost = Infinity;
  for (const node of nodes.values()) {
    if (node.kind !== 'exit') continue;
    const cost = dist.get(node.key) ?? Infinity;
    if (cost < bestCost) {
      bestCost = cost;
      bestExit = node;
    }
  }
  if (!bestExit || !(bestCost < Infinity)) return null;

  const pathTo = (exitKey: string): string[] => {
    const path = [exitKey];
    let cursor = exitKey;
    while (prev.get(cursor) && prev.get(cursor) !== 'person') {
      cursor = prev.get(cursor)!;
      path.push(cursor);
    }
    path.push('person');
    path.reverse();
    return path;
  };
  const choiceFrom = (path: string[], cost: number): RouteChoice | null => {
    const hop = nodes.get(path[1] ?? '');
    if (!hop) return null;
    if (hop.kind === 'exit') return { kind: 'exit', id: hop.id, cost };
    const next = nodes.get(path[2] ?? '');
    let dir: 'up' | 'down' = 'down';
    let toLevel = hop.level;
    if (next && next.kind === 'stair' && next.id === hop.id && next.level !== hop.level) {
      dir = levelIndex(next.level) > levelIndex(hop.level) ? 'up' : 'down';
      toLevel = next.level;
    }
    return { kind: 'stair', id: hop.id, cost, dir, toLevel };
  };

  const best = choiceFrom(pathTo(bestExit.key), bestCost);
  if (!best) return null;

  if (current) {
    let stayCost = Infinity;
    let stay: RouteChoice | null = null;
    for (const node of nodes.values()) {
      if (node.kind !== 'exit') continue;
      const cost = dist.get(node.key) ?? Infinity;
      if (!(cost < stayCost)) continue;
      const choice = choiceFrom(pathTo(node.key), cost);
      if (choice?.id !== current.id) continue;
      stayCost = cost;
      stay = choice;
    }
    if (stay && stayCost < Infinity && !(best.cost < stayCost * (1 - SHOWCASE.REROUTE_HYSTERESIS))) {
      return stay;
    }
  }

  if (best.kind === 'exit') {
    const local = exits.filter((e) => levelOf(e) === level);
    if (local.some((e) => e.id === best.id)) {
      const field = fieldOf(level) ?? new HazardField([]);
      const picked = chooseExit(
        pos,
        local,
        verts,
        field,
        current && local.some((e) => e.id === current.id) ? current : null,
        {
          walls: wallsByLevel?.get(level) as WallLike[] | undefined,
          blockedDoors: blockedDoors?.get(level),
        },
      );
      if (!picked) return null;
      return { kind: 'exit', id: picked.id, cost: picked.cost };
    }
  }
  return best;
}
