import Matter from 'matter-js';
import { doorHeldShut } from '../rts/doorLeaf';
import type {
  EvacShowcaseOptions,
  EvacState,
  ExitDef,
  PolygonSimConfig,
  ShowcaseZone,
  Vec2,
} from './types';
import { isInsidePolygon, polygonBounds } from './geometry';
import type { Bounds } from './geometry';
import {
  HazardField,
  assemblyMinDistanceM,
  chooseExit,
  distanceToOutline,
  exitApproachInside,
  committedDoor,
  exitGapSlot,
  mouthProgress,
  MOUTH_APPROACH_M,
  openingFlowPerS,
  separateFromWalls,
  WALL_FACE_CLEAR_M,
  exitRouteHazardous,
  extinctionK,
  mulberry32,
  isNearWallBehind,
  steerPastBodies,
  DOWNED_AVOID_M,
  DOWNED_CONTACT_M,
  doorFreeLanes,
  doorSqueezeAim,
  markBodiesInDoors,
  routeCrossesBlockedDoor,
  segmentHitsBlockedDoor,
  steerToTarget,
  nextPosture,
  outdoorSpeed,
  samplePremovementS,
  chooseRoute,
  routeAroundOutline,
  walkedRouteHazard,
  smokeAheadAction,
  walkingSpeed,
  RouteRegions,
  type ExitChoice,
  type Familiarity,
  type Posture,
  type WallLike,
} from './hazardSensing';
import { SHOWCASE } from './showcaseConstants';
import { blastInjuryBand } from './showcase';
import {
  bandForEffectiveKpa,
  blastPressureAt,
  computeBlastRings,
  type ChargeSpec,
} from '../rts/blast/blastModel';
import { LEVEL } from './levelConstants';
import { WET_FLOOR_SPEED } from '../rts/flameFront';
import {
  advanceFed,
  advanceHeatFed,
  exposureIncapacitates,
  fecImpairs,
  fecOf,
} from '../rts/toxicDose';
import {
  levelCategories,
  levelIndex,
  levelOf,
  normaliseStairwell,
  sortLevels,
  stairFlowPerS,
  stairTravelS,
} from '../rts/levels';
import type { LevelDef, Stairwell } from '../rts/types';

export type { Posture } from './hazardSensing';

const WALL_THICKNESS = 0.8;
/**
 * Matter's default slop is 0.05 world units, sized for pixels. A unit here is
 * a metre, and the position solver pulls any pair overlapping by less than the
 * slop back to it, so two people who touch tow each other at the faster one's
 * pace, whatever exit each is heading for. Without slop a contact only pushes.
 */
const BODY_SLOP_M = 0;
const PED_CATEGORY = 0x0001;
const WALL_CATEGORY = 0x0002;
const STATIC_CELL_M = 2;
/** Numeric cell id `(cx + bias) * stride + (cy + bias)`. Covers ±8 km at 2 m cells. */
const CELL_BIAS = 4096;
const CELL_STRIDE = 8192;
const CELL_STAMP_SLOTS = 8192;

export interface PedSnapshot {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  speed: number;
  evacuated: boolean;
  state?: EvacState;
  posture?: Posture;
  familiarity?: Familiarity;
  injury?: 'none' | 'minor' | 'serious' | 'lethal';
  /** ISO 13571 asphyxiant dose. Stays once accumulated. */
  fumeFed?: number;
  /** ISO 13571 heat dose. Stays once accumulated. Separate from the asphyxiant dose. */
  heatFed?: number;
  /** ISO 13571 irritant fraction at the last breath. */
  fumeFec?: number;
  /** Stopped while the irritant fraction is at least 1. Clears in cleaner air. */
  fumeHeld?: boolean;
  /** Down because the asphyxiant dose reached 1, not because of the blast. */
  fumeDown?: boolean;
  /** Down because the heat dose reached 1. */
  heatDown?: boolean;
  /** Frozen in fear and waiting for a responder. Not the same as sheltering with no route. */
  frozen?: boolean;
  zoneId?: string | null;
  /** Effective pressure for someone inside the minor ring, in kPa. */
  blastKpa?: number;
  nearWall?: boolean;
  /** Present only when a level plan is in use. */
  level?: string;
  inStair?: { stairId: string; dir: 'up' | 'down'; progress: number };
}

export interface ShowcaseMetrics {
  idle: number;
  reacting: number;
  evacuating: number;
  crouching: number;
  crawling: number;
  turnedBack: number;
  outside: number;
  arrived: Record<string, number>;
  leftMap: number;
  down: { lethal: number; serious: number };
  /** People stopped right now because the irritant fraction is at least 1. */
  fumeHeld: number;
  /** People the asphyxiant dose has put down. They are also counted in `down`. */
  fumeDown: number;
  /** People the heat dose has put down. They are also counted in `down`. */
  heatDown: number;
  minorInjured: number;
  reroutes: number;
  /** People frozen in fear right now. */
  frozen: number;
  /** Frozen people a responder has got moving again. */
  unfrozen: number;
  /** Set when every zone was unsafe and people were sent to the farthest one. */
  unsafeZoneNote?: string | null;
  /** Present only when a level plan was passed to the engine. */
  byLevel?: Record<string, { remaining: number; crawling: number }>;
  stairQueues?: Record<string, { up: number; down: number }>;
}

export interface EvacMetrics {
  elapsed: number;
  totalPedestrians: number;
  evacuated: number;
  remaining: number;
  avgSpeed: number;
  exitFlows: { exitId: string; count: number }[];
  showcase?: ShowcaseMetrics;
}

interface PedLabel {
  kind: 'pedestrian';
  pedId: number;
  evacuated: boolean;
  targetExitId: string;
  state?: EvacState;
  posture?: Posture;
  familiarity?: Familiarity;
  injury?: 'none' | 'minor' | 'serious' | 'lethal';
  /** Asphyxiant dose so far. It does not fall when the person walks clear. */
  fed?: number;
  /** Heat dose so far. It does not fall when the person walks clear. */
  heatFed?: number;
  /** Irritant fraction of the smoke they are in now. */
  fec?: number;
  /** True while FEC is at least 1. Cleared on the next breath under 1. */
  fumeHeld?: boolean;
  /** True when the asphyxiant dose, not the blast, put them down. */
  fumeDown?: boolean;
  /** True when the heat dose put them down. */
  heatDown?: boolean;
  reactAt?: number;
  exitCost?: number;
  nextCheckAt?: number;
  waypoints?: Vec2[];
  zoneId?: string | null;
  wanderTarget?: Vec2 | null;
  wanderUntil?: number;
  spawn?: Vec2;
  smokeRollDone?: boolean;
  /** Frozen in fear: standing still until a responder reaches them. */
  frozen?: boolean;
  /** The one-time freeze roll has been made. */
  freezeRollDone?: boolean;
  /** Exit the lookahead already acted on. Cleared when that heading is clear again. */
  latchedExitId?: string | null;
  /** Exits the lookahead left because of fire or untenable smoke, until that route clears. */
  avoidExitIds?: string[];
  /** Exits left by the turn-back roll, dropped once `turnedAwayUntil` passes. */
  turnedAwayIds?: string[];
  /** Sim-time expiry for each id in `turnedAwayIds`, same order. */
  turnedAwayUntil?: number[];
  sheltering?: boolean;
  forcedCrawl?: boolean;
  shelterTarget?: Vec2 | null;
  blastImpulse?: Vec2 | null;
  blastKpa?: number;
  nearWall?: boolean;
  exitUsed?: Vec2 | null;
  jitterTarget?: Vec2 | null;
  jitterUntil?: number;
  disperse?: boolean;
  lastDir?: Vec2 | null;
  /** Storey id when a scene has more than one. Unset on the single floor. */
  level?: string;
  targetStairId?: string | null;
  stairDir?: 'up' | 'down';
  stairToLevel?: string;
}

export interface EvacLevelPlan {
  ids: string[];
  exitsByLevel: Record<string, ExitDef[]>;
  wallsByLevel: Record<string, InteriorWallDef[]>;
  stairs: Stairwell[];
  counts?: Record<string, number>;
  heights?: Record<string, number>;
}

interface StairOccupant {
  label: PedLabel;
  stairId: string;
  dir: 'up' | 'down';
  fromLevel: string;
  toLevel: string;
  phase: 'queue' | 'travel';
  enqueuedAt: number;
  travelStart: number;
  travelDuration: number;
  /** The remaining stair time was stretched for irritant smoke. */
  fumeStretched?: boolean;
  /** Factor applied to the remaining time while the irritant crawl is on. */
  fumeStretch?: number;
}

export interface ObstaclePoint {
  x: number;
  y: number;
  radius: number;
}

export interface InteriorWallDef {
  id?: string;
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  hasDoor: boolean;
  doorWidth: number;
  doorPosition: number;
  level?: string;
  /** Leaf, 0 shut to 1 open. Absent means fully open. */
  openFraction?: number;
  fireRatingMin?: number;
  doorExposedSec?: number;
  doorFailed?: boolean;
  doorPinned?: boolean;
}

export class PolygonEvacuationEngine {
  private engine: Matter.Engine;
  private pedestrians: Matter.Body[] = [];
  private wallBodies: Matter.Body[] = [];
  private exits: ExitDef[] = [];
  private config: PolygonSimConfig;
  private elapsed = 0;
  private exitCounts = new Map<string, number>();
  private pedIdCounter = 0;
  private obstacles: ObstaclePoint[] = [];
  private showcase: EvacShowcaseOptions | null = null;
  private rng: (() => number) | null = null;
  private hazardField: HazardField | null = null;
  private interiorWalls: InteriorWallDef[] = [];
  private routeRegions: RouteRegions | null = null;
  private restMask = new WeakMap<Matter.Body, number>();
  /** People in a mouth approach who have not been released yet. */
  private mouthWait = new Set<number>();
  /** People the flow cap has released into the opening. */
  private mouthGrant = new Set<number>();
  /** Walkers who were stacked on one point in a door. They collide until they leave it. */
  private stackedPair = new Set<number>();
  /** Where each walker was at the start of this step, so a contact that undoes the step is visible. */
  private placeX: number[] = [];
  private placeY: number[] = [];
  /** Frames a slipping walker has stayed on a downed body. A passing graze does not count. */
  private stillOnBody = new WeakMap<Matter.Body, number>();
  private flowAcc = new Map<string, number>();
  private zones: ShowcaseZone[] = [];
  private blast: { site: Vec2; radius: number; glassInjuryM?: number } | null = null;
  private turnedBackCount = 0;
  private unfrozenCount = 0;
  private responders: Array<{ id: string; pos: Vec2; level?: string }> = [];
  private rerouteCount = 0;
  private unsafeZoneNote: string | null = null;
  private leftMapCount = 0;
  private arrivedCounts = new Map<string, number>();
  private buildingHeightM: number = SHOWCASE.BUILDING_STOREY_HEIGHT_M;
  private levelPlan: EvacLevelPlan | null = null;
  private levelDefs: LevelDef[] = [];
  private stairPeople: StairOccupant[] = [];
  private stairAcc = new Map<string, number>();
  private stairPrimed = new Map<string, boolean>();
  private pendingCapture: Matter.Body[] = [];
  private hazardFields = new Map<string, HazardField>();
  private blastLevel: string | null = null;
  private wallsByLevel = new Map<string, InteriorWallDef[]>();
  private motionSerial = 0;
  private staticIndexSerial = -1;
  private grids = new Map<
    string,
    Map<number, { hits: Array<{ x: number; y: number; body: Matter.Body }>; len: number }>
  >();
  private levelBodies = new Map<string, Array<{ x: number; y: number }>>();
  private levelBodyN = new Map<string, number>();
  private laneGen = 0;
  private laneCache = new WeakMap<
    WallLike,
    { gen: number; lanes: Array<[number, number]> | null }
  >();
  private readonly lookupLanes = (wall: WallLike): Array<[number, number]> | null => {
    const hit = this.laneCache.get(wall);
    return hit && hit.gen === this.laneGen ? hit.lanes : null;
  };
  private cellIds: number[] = [];
  private cellN = 0;
  private stampKeys = new Int32Array(CELL_STAMP_SLOTS);
  private stampGens = new Int32Array(CELL_STAMP_SLOTS);
  private stampMask = CELL_STAMP_SLOTS - 1;
  private stampGen = 1;
  private nearPool: Array<{ x: number; y: number; radius?: number }> = [];
  private nearView: Array<{ x: number; y: number; radius?: number }> = [];
  private steerView: Array<{ x: number; y: number; radius?: number }> = [];
  private mouthMark: number[] = [];
  private squeezeSkip: number[] = [];
  private steerAim: Vec2 = { x: 0, y: 0 };
  private steerPos: Vec2 = { x: 0, y: 0 };
  private blockedDoorsByLevel = new Map<string, WallLike[]>();

  constructor(
    config: PolygonSimConfig,
    exits: ExitDef[],
    interiorWalls?: InteriorWallDef[],
    obstacles?: ObstaclePoint[],
    showcase?: EvacShowcaseOptions,
    levels?: EvacLevelPlan,
  ) {
    this.config = config;
    this.exits = exits;
    this.obstacles = obstacles ?? [];
    this.interiorWalls = interiorWalls ? interiorWalls.map((w) => ({ ...w })) : [];
    if (showcase) {
      this.showcase = showcase;
      this.rng = mulberry32(showcase.seed ?? SHOWCASE.RNG_SEED);
      this.zones = showcase.zones.map((z) => ({ ...z, pos: { ...z.pos } }));
      if (showcase.buildingHeightM != null) this.buildingHeightM = showcase.buildingHeightM;
    }

    this.engine = Matter.Engine.create({
      gravity: { x: 0, y: 0, scale: 1 },
    });
    this.engine.timing.timeScale = 1;

    if (levels && levels.ids.length > 0) {
      this.installLevelPlan(levels);
    } else {
      this.buildWalls();
      if (interiorWalls) this.buildInteriorWalls(interiorWalls);
      this.spawnPedestrians();
    }
  }

  private buildWalls(
    sourceExits: ExitDef[] = this.exits,
    category = WALL_CATEGORY,
    mask = PED_CATEGORY,
  ) {
    const { vertices } = this.config;
    const created: Matter.Body[] = [];
    const t = WALL_THICKNESS;
    const n = vertices.length;

    for (let i = 0; i < n; i++) {
      const a = vertices[i];
      const b = vertices[(i + 1) % n];
      const edgeDx = b.x - a.x;
      const edgeDy = b.y - a.y;
      const edgeLen = Math.hypot(edgeDx, edgeDy);
      if (edgeLen < 0.01) continue;

      const angle = Math.atan2(edgeDy, edgeDx);

      // Collect exits on this edge, sorted by parametric t
      const edgeExits = sourceExits
        .filter((ex) => ex.edgeIndex === i)
        .map((ex) => {
          const halfW = ex.width / 2;
          const tCenter =
            ((ex.center.x - a.x) * edgeDx + (ex.center.y - a.y) * edgeDy) / (edgeLen * edgeLen);
          const tStart = Math.max(0, tCenter - halfW / edgeLen);
          const tEnd = Math.min(1, tCenter + halfW / edgeLen);
          return { tStart, tEnd };
        })
        .sort((x, y) => x.tStart - y.tStart);

      // Build wall segments around exit gaps
      const segments: { tStart: number; tEnd: number }[] = [];
      let cursor = 0;
      for (const gap of edgeExits) {
        if (gap.tStart > cursor + 0.001) {
          segments.push({ tStart: cursor, tEnd: gap.tStart });
        }
        cursor = Math.max(cursor, gap.tEnd);
      }
      if (cursor < 1 - 0.001) {
        segments.push({ tStart: cursor, tEnd: 1 });
      }

      for (const seg of segments) {
        const segLen = (seg.tEnd - seg.tStart) * edgeLen;
        if (segLen < 0.05) continue;
        const tMid = (seg.tStart + seg.tEnd) / 2;
        const mx = a.x + tMid * edgeDx;
        const my = a.y + tMid * edgeDy;

        const body = Matter.Bodies.rectangle(mx, my, segLen, t, {
          isStatic: true,
          angle,
          slop: BODY_SLOP_M,
        });
        body.collisionFilter = { group: 0, category, mask };
        body.restitution = 0.1;
        body.friction = 0.05;
        created.push(body);
      }
    }

    this.wallBodies.push(...created);
    if (created.length > 0) Matter.Composite.add(this.engine.world, created);
  }

  private buildInteriorWalls(
    walls: InteriorWallDef[],
    category = WALL_CATEGORY,
    mask = PED_CATEGORY,
  ) {
    const t = WALL_THICKNESS;
    const interiorBodies: Matter.Body[] = [];

    for (const wall of walls) {
      const dx = wall.endX - wall.startX;
      const dy = wall.endY - wall.startY;
      const len = Math.hypot(dx, dy);
      if (len < 0.1) continue;
      const angle = Math.atan2(dy, dx);

      if (wall.hasDoor) {
        const doorCenter = wall.doorPosition * len;
        const halfDoor = wall.doorWidth / 2;
        const seg1Len = doorCenter - halfDoor;
        const seg2Start = doorCenter + halfDoor;
        const seg2Len = len - seg2Start;

        if (seg1Len > 0.1) {
          const mid1 = seg1Len / 2;
          const mx = wall.startX + (dx / len) * mid1;
          const my = wall.startY + (dy / len) * mid1;
          const body = Matter.Bodies.rectangle(mx, my, seg1Len, t, {
            isStatic: true,
            angle,
            slop: BODY_SLOP_M,
          });
          body.collisionFilter = { group: 0, category, mask };
          body.restitution = 0.1;
          interiorBodies.push(body);
        }
        if (seg2Len > 0.1) {
          const mid2 = seg2Start + seg2Len / 2;
          const mx = wall.startX + (dx / len) * mid2;
          const my = wall.startY + (dy / len) * mid2;
          const body = Matter.Bodies.rectangle(mx, my, seg2Len, t, {
            isStatic: true,
            angle,
            slop: BODY_SLOP_M,
          });
          body.collisionFilter = { group: 0, category, mask };
          body.restitution = 0.1;
          interiorBodies.push(body);
        }
      } else {
        const mx = (wall.startX + wall.endX) / 2;
        const my = (wall.startY + wall.endY) / 2;
        const body = Matter.Bodies.rectangle(mx, my, len, t, {
          isStatic: true,
          angle,
          slop: BODY_SLOP_M,
        });
        body.collisionFilter = { group: 0, category, mask };
        body.restitution = 0.1;
        interiorBodies.push(body);
      }
    }

    this.wallBodies.push(...interiorBodies);
    Matter.Composite.add(this.engine.world, interiorBodies);
  }

  private spawnPedestrians() {
    const { vertices, pedestrianCount, pedestrianRadius: r } = this.config;
    const bounds = polygonBounds(vertices);
    const margin = r * 2;

    let spawned = 0;
    let attempts = 0;
    const maxAttempts = pedestrianCount * 50;

    while (spawned < pedestrianCount && attempts < maxAttempts) {
      attempts++;
      const rnd = () => (this.rng ? this.rng() : Math.random());
      const x = bounds.minX + margin + rnd() * (bounds.width - 2 * margin);
      const y = bounds.minY + margin + rnd() * (bounds.height - 2 * margin);

      if (!isInsidePolygon(x, y, vertices)) continue;

      const body = Matter.Bodies.circle(x, y, r, {
        restitution: 0.05,
        friction: 0.3,
        frictionAir: 0.15,
        density: 50,
        slop: BODY_SLOP_M,
        label: 'pedestrian',
      });

      body.collisionFilter = {
        group: 0,
        category: PED_CATEGORY,
        mask: PED_CATEGORY | WALL_CATEGORY,
      };

      const pedLabel: PedLabel = this.showcase
        ? {
            kind: 'pedestrian',
            pedId: this.pedIdCounter++,
            evacuated: false,
            targetExitId: '',
            state: 'idle',
            posture: 'stand',
            familiarity: this.rng!() < SHOWCASE.STAFF_SHARE ? 'staff' : 'visitor',
            injury: 'none',
            reactAt: Infinity,
            exitCost: Infinity,
            nextCheckAt: 0,
            waypoints: [],
            zoneId: null,
            wanderTarget: null,
            wanderUntil: 0,
            spawn: { x, y },
            smokeRollDone: false,
            latchedExitId: null,
            avoidExitIds: [],
            turnedAwayIds: [],
            turnedAwayUntil: [],
            sheltering: false,
            forcedCrawl: false,
            shelterTarget: null,
            blastImpulse: null,
            exitUsed: null,
            jitterTarget: null,
            jitterUntil: 0,
            disperse: false,
            lastDir: null,
          }
        : {
            kind: 'pedestrian',
            pedId: this.pedIdCounter++,
            evacuated: false,
            targetExitId: this.pickNearestExit(x, y),
          };
      (body as any).__ped = pedLabel;

      this.pedestrians.push(body);
      spawned++;
    }

    Matter.Composite.add(this.engine.world, this.pedestrians);
  }

  private pickNearestExit(x: number, y: number): string {
    const publicExits = this.exits.filter((e) => e.exitType !== 'service');
    let best = publicExits[0]?.id ?? this.exits[0]?.id ?? '';
    let bestDist = Infinity;
    for (const e of this.exits) {
      if (e.exitType === 'service') continue;
      const dx = e.center.x - x;
      const dy = e.center.y - y;
      const d = dx * dx + dy * dy;
      if (d < bestDist) {
        bestDist = d;
        best = e.id;
      }
    }
    return best;
  }

  step() {
    this.motionSerial++;
    this.prepareStaticBodies();
    const breathDt = this.config.dt;
    for (const body of this.pedestrians) {
      const ped = this.pedOf(body);
      if (ped.state === 'down' || ped.state === 'left_map') continue;
      if (!this.breathe(ped, body.position.x, body.position.y, breathDt)) continue;
      Matter.Body.setStatic(body, true);
      Matter.Body.setVelocity(body, { x: 0, y: 0 });
    }
    if (this.showcase) {
      this.stepShowcase();
      return;
    }
    const { dt, desiredSpeed, panicFactor } = this.config;
    this.tickStairs(dt);
    const targetSpeed = desiredSpeed * (1 + panicFactor * 0.6);
    const tau = 0.4;

    for (const body of this.pedestrians) {
      const ped: PedLabel = (body as any).__ped;
      if (ped.evacuated || ped.state === 'down' || ped.state === 'left_map') continue;
      // FEC at 1 is the seeded crawl toward the exit, not a stop. Injury
      // and a wet floor slow that crawl the same way they slow a walk.
      const pace = ped.fumeHeld
        ? SHOWCASE.CRAWL_SPEED *
          this.irritantFooting(ped, body.position.x, body.position.y, ped.level)
        : targetSpeed;
      if (ped.fumeHeld) ped.posture = 'crawl';
      if (this.levelPlan && ped.level) {
        this.stepPlainLevel(body, ped, pace, dt, tau);
        continue;
      }

      const exit = this.exits.find((e) => e.id === ped.targetExitId);
      if (!exit) continue;

      const steered = this.aimAroundBodies(body, exit.center);
      const dx = steered.aim.x - body.position.x;
      const dy = steered.aim.y - body.position.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist < 0.01) continue;

      const nx = dx / dist;
      const ny = dy / dist;

      const vDesX = nx * pace * dt;
      const vDesY = ny * pace * dt;

      // Repulsion from obstacles (hazards, casualties) and static bodies.
      let repX = 0;
      let repY = 0;
      for (const obs of this.obstacles) {
        const push = this.obstaclePush(body, obs.x, obs.y, obs.radius, pace, dt);
        repX += push.x;
        repY += push.y;
      }
      const bodies = this.pushFromBodies(body, steered.near, pace, dt);
      repX += bodies.x;
      repY += bodies.y;

      const blend = Math.min(1, dt / tau);
      const newVx = body.velocity.x + (vDesX + repX - body.velocity.x) * blend;
      const newVy = body.velocity.y + (vDesY + repY - body.velocity.y) * blend;

      Matter.Body.setVelocity(body, { x: newVx, y: newVy });

      const currentSpeed = Math.sqrt(body.velocity.x ** 2 + body.velocity.y ** 2);
      const maxSpeed = pace * dt * 1.3;
      if (currentSpeed > maxSpeed) {
        const s = maxSpeed / currentSpeed;
        Matter.Body.setVelocity(body, {
          x: body.velocity.x * s,
          y: body.velocity.y * s,
        });
      }
    }

    Matter.Engine.update(this.engine, dt * 1000);

    for (const body of this.pedestrians) {
      const ped: PedLabel = (body as any).__ped;
      if (!ped.evacuated) this.checkEvacuated(body, ped);
    }

    this.collectCaptures();
    this.flushCapture();
    this.elapsed += dt;
  }

  private checkEvacuated(body: Matter.Body, ped: PedLabel) {
    const { vertices } = this.config;
    const x = body.position.x;
    const y = body.position.y;

    const inside = isInsidePolygon(x, y, vertices);
    if (inside) return;

    // Outside polygon — check if near target exit
    const exit = this.exits.find((e) => e.id === ped.targetExitId);
    if (exit && !(ped.level && levelOf(exit) !== ped.level)) {
      const dToExit = Math.hypot(x - exit.center.x, y - exit.center.y);
      if (dToExit < exit.width + 1.5) {
        ped.evacuated = true;
        Matter.Composite.remove(this.engine.world, body);
        const count = this.exitCounts.get(ped.targetExitId) ?? 0;
        this.exitCounts.set(ped.targetExitId, count + 1);
        return;
      }
    }

    // Outside but not near exit — push back to nearest point inside
    this.pushBackInside(body, vertices);
  }

  private pushBackInside(body: Matter.Body, vertices: Vec2[]) {
    // Find closest point on any edge and push just inside
    const x = body.position.x;
    const y = body.position.y;
    let bestPx = x;
    let bestPy = y;
    let bestDist = Infinity;

    for (let i = 0; i < vertices.length; i++) {
      const a = vertices[i];
      const b = vertices[(i + 1) % vertices.length];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const lenSq = dx * dx + dy * dy;
      if (lenSq < 1e-10) continue;

      let t = ((x - a.x) * dx + (y - a.y) * dy) / lenSq;
      t = Math.max(0, Math.min(1, t));
      const px = a.x + t * dx;
      const py = a.y + t * dy;
      const d = Math.hypot(x - px, y - py);
      if (d < bestDist) {
        bestDist = d;
        bestPx = px;
        bestPy = py;
      }
    }

    // Nudge 0.5m inside from the edge point
    const cx = (bestPx + x) / 2;
    const cy = (bestPy + y) / 2;
    const inward = isInsidePolygon(cx, cy, vertices) ? { x: cx, y: cy } : { x: bestPx, y: bestPy };
    Matter.Body.setPosition(body, inward);
    Matter.Body.setVelocity(body, { x: 0, y: 0 });
  }

  setHazardField(field: HazardField | null) {
    if (!this.showcase && !this.levelPlan) return;
    this.hazardField = field;
  }

  setHazardFields(fields: ReadonlyMap<string, HazardField>) {
    this.hazardFields = new Map(fields);
  }

  setBlastLevel(level: string | null) {
    this.blastLevel = level;
  }

  setInteriorWalls(walls: InteriorWallDef[]) {
    if (!this.showcase) return;
    this.interiorWalls = walls.map((w) => ({ ...w }));
    this.routeRegions = null;
  }

  syncExits(exits: ExitDef[]) {
    if (!this.showcase) return;
    for (const incoming of exits) {
      const cur = this.exits.find((e) => e.id === incoming.id);
      if (cur) cur.status = incoming.status;
    }
  }

  /** Copy the shared leaf onto the crowd's wall copies. Match is by id. */
  syncDoorLeaves(
    walls: readonly {
      id: string;
      openFraction?: number;
      fireRatingMin?: number;
      doorExposedSec?: number;
      doorFailed?: boolean;
      doorPinned?: boolean;
    }[],
  ): void {
    const byId = new Map(walls.map((wall) => [wall.id, wall]));
    const apply = (row: InteriorWallDef) => {
      if (!row.id) return;
      const src = byId.get(row.id);
      if (!src) return;
      row.openFraction = src.openFraction;
      row.fireRatingMin = src.fireRatingMin;
      row.doorExposedSec = src.doorExposedSec;
      row.doorFailed = src.doorFailed;
      row.doorPinned = src.doorPinned;
    };
    for (const row of this.interiorWalls) apply(row);
    for (const rows of this.wallsByLevel.values()) {
      for (const row of rows) apply(row);
    }
  }

  setZones(zones: ShowcaseZone[]) {
    if (!this.showcase) return;
    this.zones = zones.map((z) => ({ ...z, pos: { ...z.pos } }));
  }

  /** Illustrative blast. A second call does nothing. */
  triggerBlast(site: Vec2, arg: number | { mode: 'pressure'; spec: ChargeSpec; heightM: number }) {
    if (!this.showcase || this.blast) return;
    const pressure = typeof arg === 'number' ? null : arg;
    let radius: number;
    let glassInjuryM: number | undefined;
    if (typeof arg === 'number') {
      radius = arg;
    } else {
      const rings = computeBlastRings(arg.spec);
      radius = rings.minorM;
      glassInjuryM = rings.glassInjuryM;
    }
    this.blast = {
      site: { x: site.x, y: site.y },
      radius,
      ...(glassInjuryM != null ? { glassInjuryM } : {}),
    };
    const dt = this.config.dt;
    const h = pressure ? (pressure.spec.burst === 'surface' ? 0 : pressure.heightM) : 0;
    for (const body of this.pedestrians) {
      const ped = this.pedOf(body);
      if (ped.state === 'down' || ped.state === 'left_map' || ped.state === 'arrived') continue;
      // Other storeys are alarmed but not injured: the blast only hits its own floor.
      const otherStorey = !!(ped.level && this.blastLevel && ped.level !== this.blastLevel);
      if (!otherStorey) {
        const dx = body.position.x - site.x;
        const dy = body.position.y - site.y;
        const dist = Math.hypot(dx, dy);
        let band: ReturnType<typeof blastInjuryBand>;
        if (pressure) {
          // interiorWalls and this.exits hold every storey. A wall on another
          // floor must not raise the pressure on this one.
          const storeyWalls = this.wallsByLevel.get(this.blastLevel ?? '') ?? this.interiorWalls;
          const storeyExits = this.blastLevel
            ? this.exits.filter((exit) => levelOf(exit) === this.blastLevel)
            : this.exits;
          const near = isNearWallBehind(
            { x: body.position.x, y: body.position.y },
            site,
            storeyWalls,
            this.config.vertices,
            storeyExits,
          );
          const felt = blastPressureAt(pressure.spec, Math.hypot(dx, dy, h), near);
          band = bandForEffectiveKpa(felt.effectiveKpa);
          if (band !== 'none') {
            ped.blastKpa = felt.effectiveKpa;
            ped.nearWall = near;
          }
        } else {
          band = blastInjuryBand(dist, radius);
        }
        if (band === 'lethal' || band === 'serious') {
          ped.state = 'down';
          ped.injury = band;
          ped.evacuated = false;
          Matter.Body.setStatic(body, true);
          Matter.Body.setVelocity(body, { x: 0, y: 0 });
          continue;
        }
        if (band === 'minor') {
          ped.injury = 'minor';
          const len = dist > 0.01 ? dist : 1;
          ped.blastImpulse = {
            x: (dx / len) * SHOWCASE.BLAST_PUSH_SPEED * dt,
            y: (dy / len) * SHOWCASE.BLAST_PUSH_SPEED * dt,
          };
        }
      }
      ped.state = 'reacting';
      ped.reactAt = this.elapsed + samplePremovementS(this.rng!);
    }
  }

  private pedOf(body: Matter.Body): PedLabel {
    return (body as Matter.Body & { __ped: PedLabel }).__ped;
  }

  /**
   * Injury and a wet floor on the irritant crawl. A minor injury is the
   * seeded 0.6, and a wet stud is the 0.75 floor factor. Serious injury is
   * already down, so it is not a crawl.
   */
  private irritantFooting(ped: PedLabel, x: number, y: number, level?: string): number {
    const injury = ped.injury === 'minor' ? SHOWCASE.MINOR_INJURY_SPEED_FACTOR : 1;
    const wet = this.field(level).sample(x, y).wet ? WET_FLOOR_SPEED : 1;
    return injury * wet;
  }

  private field(level?: string): HazardField {
    if (level) {
      const own = this.hazardFields.get(level);
      if (own) return own;
    }
    if (!this.hazardField) this.hazardField = new HazardField([]);
    return this.hazardField;
  }

  private stepShowcase() {
    const dt = this.config.dt;
    this.refreshMouthGrants();
    this.tickStairs(dt);
    this.rememberPlaces();
    const outside: Array<{ id: number; x: number; y: number }> = [];
    for (const body of this.pedestrians) {
      const ped = this.pedOf(body);
      if (ped.state === 'outside') {
        outside.push({ id: ped.pedId, x: body.position.x, y: body.position.y });
      }
    }

    for (const body of this.pedestrians) {
      const ped = this.pedOf(body);
      if (ped.state === 'down' || ped.state === 'left_map') continue;
      if (ped.state === 'arrived') {
        this.stepArrived(body, ped);
        continue;
      }
      if (ped.state === 'idle') {
        this.stepIdle(body, ped);
        continue;
      }
      if (ped.state === 'reacting') {
        if (this.elapsed + 1e-9 >= (ped.reactAt ?? Infinity)) {
          ped.state = 'evacuating';
          ped.posture = ped.posture ?? 'stand';
          const offset = (ped.pedId % 30) * dt;
          ped.nextCheckAt = this.elapsed + (offset === 0 ? SHOWCASE.REROUTE_CHECK_S : offset);
          if (this.levelPlan && ped.level) this.applyRoute(ped, this.posOf(body), false);
          else
            this.assignChoice(ped, this.posOf(body), this.pickInitialExit(this.posOf(body)), false);
          this.stepEvacuating(body, ped);
        } else if (ped.blastImpulse) {
          Matter.Body.setVelocity(body, ped.blastImpulse);
          ped.blastImpulse = null;
        } else {
          Matter.Body.setVelocity(body, { x: 0, y: 0 });
        }
        continue;
      }
      if (ped.state === 'evacuating') {
        if (this.holdFrozen(body, ped)) continue;
        this.stepEvacuating(body, ped);
        continue;
      }
      if (ped.state === 'outside') {
        this.stepOutside(
          body,
          ped,
          this.localDensity(outside, body.position.x, body.position.y, ped.pedId),
        );
      }
    }

    Matter.Engine.update(this.engine, dt * 1000);
    this.unstickFromWalls();
    this.slipThroughOpenings();

    const { vertices } = this.config;
    for (const body of this.pedestrians) {
      const ped = this.pedOf(body);
      if (ped.state === 'evacuating') this.checkEvacuatedShowcase(body, ped);
      else if (
        (ped.state === 'idle' || ped.state === 'reacting') &&
        !isInsidePolygon(body.position.x, body.position.y, vertices)
      ) {
        this.pushBackInside(body, vertices);
      }
    }

    this.collectCaptures();
    this.flushCapture();
    this.elapsed += dt;
  }

  private posOf(body: Matter.Body): Vec2 {
    return { x: body.position.x, y: body.position.y };
  }

  /**
   * Responders who can get a frozen person moving: positions in sim metres.
   * Unset level means the single floor.
   */
  setResponders(responders: ReadonlyArray<{ id: string; pos: Vec2; level?: string }>) {
    this.responders = responders.map((r) => ({ id: r.id, pos: { ...r.pos }, level: r.level }));
  }

  /**
   * Freezing in fear. The first time smoke at FREEZE_TRIGGER_K or a burning
   * stud reaches an evacuee who has a route, a seeded per-person roll may
   * freeze them. They stand still, still breathing the smoke, until a
   * responder comes within FREEZE_RELEASE_M; then they re-choose and go.
   * The roll is keyed on the person, not drawn from the shared stream, so it
   * leaves every other seeded draw where it was. Someone sheltering with no
   * route is not frozen; that is a different state.
   */
  private holdFrozen(body: Matter.Body, ped: PedLabel): boolean {
    if (ped.frozen) {
      if (this.responderNear(body, ped)) {
        ped.frozen = false;
        ped.nextCheckAt = this.elapsed;
        this.unfrozenCount++;
        return false;
      }
      Matter.Body.setVelocity(body, { x: 0, y: 0 });
      return true;
    }
    if (ped.freezeRollDone || ped.sheltering) return false;
    const pos = this.posOf(body);
    const field = this.field(ped.level);
    const smoky = extinctionK(field.sample(pos.x, pos.y).smoke) >= SHOWCASE.FREEZE_TRIGGER_K;
    const fire =
      !smoky &&
      field
        .firesNear(pos.x, pos.y, SHOWCASE.FIRE_AVOID_RADIUS_M)
        .some((f) => f.state === 'burning');
    if (!smoky && !fire) return false;
    ped.freezeRollDone = true;
    const permille = this.showcase?.freezePermille ?? SHOWCASE.FREEZE_PERMILLE;
    if (!(permille > 0) || this.freezeRoll(ped.pedId) >= permille / 1000) return false;
    if (this.responderNear(body, ped)) return false;
    ped.frozen = true;
    Matter.Body.setVelocity(body, { x: 0, y: 0 });
    return true;
  }

  private freezeRoll(pedId: number): number {
    const seed = (this.showcase?.seed ?? SHOWCASE.RNG_SEED) >>> 0;
    return mulberry32((seed ^ Math.imul(pedId + 1, 0x9e3779b1)) >>> 0)();
  }

  private responderNear(body: Matter.Body, ped: PedLabel): boolean {
    const reach = SHOWCASE.FREEZE_RELEASE_M;
    for (const r of this.responders) {
      if ((r.level ?? '') !== (ped.level ?? '') && r.level != null && ped.level != null) continue;
      if (Math.hypot(r.pos.x - body.position.x, r.pos.y - body.position.y) <= reach) return true;
    }
    return false;
  }

  private stepIdle(body: Matter.Body, ped: PedLabel) {
    const pos = this.posOf(body);
    if ((ped.wanderUntil ?? 0) > this.elapsed) {
      Matter.Body.setVelocity(body, { x: 0, y: 0 });
      return;
    }
    if (!ped.wanderTarget) {
      ped.wanderTarget = this.pickWander(ped.spawn ?? pos);
    }
    const d = Math.hypot(ped.wanderTarget.x - pos.x, ped.wanderTarget.y - pos.y);
    if (d < 0.4) {
      ped.wanderTarget = null;
      ped.wanderUntil = this.elapsed + 2 + this.rng!() * 4;
      Matter.Body.setVelocity(body, { x: 0, y: 0 });
      return;
    }
    this.steer(body, ped.wanderTarget, SHOWCASE.IDLE_WANDER_SPEED, null);
  }

  private pickWander(spawn: Vec2): Vec2 {
    const r = SHOWCASE.IDLE_WANDER_RADIUS_M;
    const verts = this.config.vertices;
    for (let i = 0; i < 20; i++) {
      const ang = this.rng!() * Math.PI * 2;
      const rad = Math.sqrt(this.rng!()) * r;
      const p = { x: spawn.x + Math.cos(ang) * rad, y: spawn.y + Math.sin(ang) * rad };
      if (isInsidePolygon(p.x, p.y, verts)) return p;
    }
    return { x: spawn.x, y: spawn.y };
  }

  private stepEvacuating(body: Matter.Body, ped: PedLabel) {
    if (this.levelPlan && ped.level) {
      this.stepEvacuatingLevel(body, ped);
      return;
    }
    const pos = this.posOf(body);
    const field = this.field(ped.level);
    const sample = field.sample(pos.x, pos.y);
    const fam = ped.familiarity ?? 'visitor';
    if (!ped.forcedCrawl && !ped.sheltering) {
      ped.posture = nextPosture(ped.posture ?? 'stand', sample.smoke, fam);
    } else {
      ped.posture = 'crawl';
    }
    // FEC at 1 forces the seeded crawl. The pace below includes the injury
    // factor inside walkingSpeed and the wet-floor factor on the footing.
    if (ped.fumeHeld) ped.posture = 'crawl';
    const injuryFactor = ped.injury === 'minor' ? SHOWCASE.MINOR_INJURY_SPEED_FACTOR : 1;
    const footing = sample.wet ? WET_FLOOR_SPEED : 1;
    const speed =
      walkingSpeed(
        extinctionK(sample.smoke),
        ped.posture ?? 'stand',
        SHOWCASE.SHOWCASE_PANIC,
        injuryFactor,
      ) * footing;

    const blockedDoors = this.blockedDoorsFor(ped);
    const exit = this.exits.find((e) => e.id === ped.targetExitId);
    const provisional =
      ped.sheltering && ped.shelterTarget
        ? ped.shelterTarget
        : exit
          ? steerToTarget(pos, exit.center, this.interiorWalls)
          : pos;
    let ka = 0;
    let burningAhead = false;
    if (exit) {
      const hazard = walkedRouteHazard(pos, exit, this.config.vertices, field, this.interiorWalls);
      ka = hazard.maxK;
      burningAhead = hazard.burning;
    }

    const ahead = (burningAhead || ka > SHOWCASE.REROUTE_EXTINCTION) && !!ped.targetExitId;
    if (!ahead && ped.latchedExitId === ped.targetExitId) ped.latchedExitId = null;
    if (ahead && ped.latchedExitId !== ped.targetExitId && ped.targetExitId) {
      const fromId = ped.targetExitId;
      ped.latchedExitId = fromId;
      const exitOpts = {
        excludeId: fromId,
        avoidIds: ped.avoidExitIds,
        walls: this.interiorWalls,
        blockedDoors,
      };
      if (burningAhead) {
        const alt = this.routedChoice(
          pos,
          this.exits,
          this.config.vertices,
          field,
          this.currentChoice(ped),
          exitOpts,
        );
        this.assignChoice(ped, pos, alt, true);
        if (ped.targetExitId !== fromId) this.noteAvoid(ped, fromId);
      } else {
        let turned = false;
        if (!ped.smokeRollDone) {
          ped.smokeRollDone = true;
          if (this.rng!() < SHOWCASE.TURN_BACK_PERMILLE / 1000) {
            turned = true;
            this.turnedBackCount++;
            this.rerouteCount++;
            const alt = this.routedChoice(
              pos,
              this.exits,
              this.config.vertices,
              field,
              this.currentChoice(ped),
              {
                ...exitOpts,
                ignoreHysteresis: true,
              },
            );
            this.assignChoice(ped, pos, alt, false);
            this.noteAvoid(ped, fromId, true);
          }
        }
        if (!turned) {
          const alt = this.routedChoice(
            pos,
            this.exits,
            this.config.vertices,
            field,
            this.currentChoice(ped),
            exitOpts,
          );
          const altCost = alt && !alt.forced ? alt.cost : null;
          if (smokeAheadAction(ka, ped.exitCost ?? Infinity, altCost) === 'switch' && alt) {
            this.assignChoice(ped, pos, alt, true);
            if (ped.targetExitId !== fromId) this.noteAvoid(ped, fromId);
          }
        }
      }
    }

    // A blocked exit, or a door a body has closed, is dropped on this step.
    // Waiting out the 0.5 s re-check lands one frame late on the page clock.
    const routed = this.exits.find((e) => e.id === ped.targetExitId);
    const doorBlocked =
      routed != null &&
      routeCrossesBlockedDoor(pos, routed, this.config.vertices, this.interiorWalls, blockedDoors);
    if (
      routed?.status === 'blocked' ||
      doorBlocked ||
      this.elapsed + 1e-9 >= (ped.nextCheckAt ?? 0)
    ) {
      this.pruneAvoid(ped, pos);
      const choice = this.routedChoice(
        pos,
        this.exits,
        this.config.vertices,
        field,
        ped.targetExitId ? this.currentChoice(ped) : null,
        { avoidIds: ped.avoidExitIds, walls: this.interiorWalls, blockedDoors },
      );
      ped.nextCheckAt = this.elapsed + SHOWCASE.REROUTE_CHECK_S;
      this.assignChoice(ped, pos, choice, true);
    }

    if (ped.sheltering) {
      ped.shelterTarget =
        this.field(ped.level)?.lowestKWithin(pos.x, pos.y, 6, this.sameRegion(pos)) ??
        ped.shelterTarget ??
        null;
      ped.posture = 'crawl';
    }

    const liveExit = this.exits.find((e) => e.id === ped.targetExitId);
    const held = this.mouthWait.has(ped.pedId) && !this.mouthGrant.has(ped.pedId);
    const target =
      ped.sheltering && ped.shelterTarget
        ? steerToTarget(pos, ped.shelterTarget, this.interiorWalls)
        : liveExit
          ? this.exitSteerTarget(pos, liveExit, held)
          : provisional;
    // A forced crawl has no safe exit, so it keeps moving. A released person
    // finishes the opening: repulsion may slide them sideways, not back out.
    const keepForward = ped.forcedCrawl === true || this.mouthGrant.has(ped.pedId);
    this.steer(body, target, speed, field, keepForward);
  }

  /**
   * Release people into a door or exit at the seeded specific flow. Everyone
   * else in the approach waits on their own slot. Credits are not saved up,
   * so a pause cannot dump a crowd through at once.
   */
  private refreshMouthGrants() {
    const groups = new Map<
      string,
      { flow: number; waiters: Array<{ id: number; dist: number }> }
    >();
    const waiting = new Set<number>();
    for (const body of this.pedestrians) {
      const ped = this.pedOf(body);
      if (ped.state !== 'evacuating' || !ped.targetExitId) continue;
      const exit = this.exits.find((e) => e.id === ped.targetExitId);
      if (!exit) continue;
      const mouth = this.classifyWait(this.posOf(body), exit, this.wallsNear(ped), ped.level ?? '');
      if (!mouth) continue;
      waiting.add(ped.pedId);
      const group = groups.get(mouth.key) ?? { flow: mouth.flow, waiters: [] };
      group.waiters.push({ id: ped.pedId, dist: mouth.dist });
      groups.set(mouth.key, group);
    }
    this.mouthWait = waiting;
    for (const id of this.mouthGrant) {
      if (!waiting.has(id)) this.mouthGrant.delete(id);
    }
    for (const key of [...this.flowAcc.keys()]) {
      if (!groups.has(key)) this.flowAcc.delete(key);
    }
    const dt = this.config.dt;
    for (const [key, group] of groups) {
      let acc = this.flowAcc.get(key) ?? 1;
      acc = Math.min(2, acc + group.flow * dt);
      group.waiters.sort((a, b) => a.dist - b.dist || a.id - b.id);
      for (const waiter of group.waiters) {
        if (this.mouthGrant.has(waiter.id)) continue;
        if (acc < 1) break;
        acc -= 1;
        this.mouthGrant.add(waiter.id);
      }
      this.flowAcc.set(key, acc);
    }
  }

  /** Door approach first, otherwise the exit opening, when the person is in it. */
  private classifyWait(
    pos: Vec2,
    exit: ExitDef,
    walls: InteriorWallDef[],
    level: string,
  ): { key: string; flow: number; dist: number } | null {
    const door = committedDoor(pos, exitApproachInside(exit, this.config.vertices), walls);
    if (door) {
      return { key: `${level}|d${door.index}`, flow: openingFlowPerS(door.width), dist: door.dist };
    }
    if (exit.exitType === 'service') return null;
    const gap = exitGapSlot(pos, exit, this.config.vertices);
    if (!gap || gap.clamped) return null;
    // The radiant shell (a burning stud pushes out to 5 m) sits outside the
    // mouth. Queue there, or the crowd never reaches the opening to be counted.
    if (gap.planeDist > SHOWCASE.FIRE_AVOID_RADIUS_M || gap.planeDist < 0) return null;
    return { key: `${level}|e:${exit.id}`, flow: openingFlowPerS(exit.width), dist: gap.planeDist };
  }

  /**
   * A released person, or someone already past the opening, does not collide
   * with other people while they finish the crossing. Everyone still waiting
   * keeps colliding. The overlap on the way through is a visual artefact of
   * that slip; the release cap is what limits the flow.
   * Two centres on one point never get a contact normal, so they stay stacked
   * on the body. Those two are eased apart and collide again. Ending the slip
   * for everyone past the line jams the rest of the crowd in the opening.
   * A lone walker pressed into a downed body is different: that body keeps the
   * wall category, and the resting contact pulls every step back into the slop.
   * Once they have sat there, they are set just clear of it.
   */
  private slipThroughOpenings() {
    const slipping = new Set<Matter.Body>();
    const doorMouth: Matter.Body[] = [];
    for (const body of this.pedestrians) {
      const ped = this.pedOf(body);
      if (ped.state !== 'evacuating') continue;
      const goal = this.steerGoal(ped);
      if (!goal) continue;
      const pos = this.posOf(body);
      let inMouth = false;
      for (const wall of this.wallsNear(ped)) {
        if (!wall.hasDoor) continue;
        const mouth = mouthProgress(pos, wall, goal);
        if (mouth && mouth.dist <= 1.05 && mouth.through < 0.55 && mouth.through > -1.05) {
          inMouth = true;
          doorMouth.push(body);
          break;
        }
      }
      const exit = ped.targetExitId ? this.exits.find((e) => e.id === ped.targetExitId) : undefined;
      if (!inMouth && exit && exit.exitType !== 'service') {
        const gap = exitGapSlot(pos, exit, this.config.vertices);
        if (
          gap &&
          !gap.clamped &&
          gap.planeDist <= SHOWCASE.FIRE_AVOID_RADIUS_M &&
          gap.planeDist >= -0.15
        ) {
          inMouth = true;
        }
      }
      // Only a released person, or someone already past the line, overlaps.
      // The queue behind the opening keeps colliding.
      const released = this.mouthGrant.has(ped.pedId);
      let pastLine = false;
      if (inMouth && !released) {
        for (const wall of this.wallsNear(ped)) {
          if (!wall.hasDoor) continue;
          const mouth = mouthProgress(pos, wall, goal);
          if (mouth && mouth.through > 0) pastLine = true;
        }
        if (exit) {
          const gap = exitGapSlot(pos, exit, this.config.vertices);
          if (gap && gap.planeDist < 0.15) pastLine = true;
        }
      }
      if (inMouth && (released || pastLine)) slipping.add(body);
    }
    this.separateSameSpot(doorMouth, slipping);
    this.releasePinned(slipping);
    for (const body of this.pedestrians) {
      const saved = this.restMask.get(body);
      const rest = saved ?? body.collisionFilter.mask ?? 0;
      if (saved == null) this.restMask.set(body, rest);
      const category = body.collisionFilter.category ?? 0;
      body.collisionFilter.mask = slipping.has(body) ? rest & ~category : rest;
    }
  }

  /**
   * Two centres on one point never get a contact normal, so they stay stacked
   * inside a body in the doorway. Swing them to opposite sides of that body
   * and keep person-to-person collisions on until they leave the opening.
   * Everyone else keeps the slip, which is what lets the rest of the crowd through.
   */
  private separateSameSpot(bodies: Matter.Body[], slipping: Set<Matter.Body>) {
    const still = new Set<number>();
    for (const body of bodies) still.add(this.pedOf(body).pedId);
    for (const id of this.stackedPair) {
      if (!still.has(id)) this.stackedPair.delete(id);
    }
    for (let i = 0; i < bodies.length; i++) {
      for (let j = i + 1; j < bodies.length; j++) {
        const a = bodies[i];
        const b = bodies[j];
        if (!slipping.has(a) || !slipping.has(b)) continue;
        if (Math.hypot(b.position.x - a.position.x, b.position.y - a.position.y) >= 0.08) continue;
        this.stackedPair.add(this.pedOf(a).pedId);
        this.stackedPair.add(this.pedOf(b).pedId);
        this.orbitApart(a, b);
      }
    }
    for (const body of bodies) {
      if (this.stackedPair.has(this.pedOf(body).pedId)) slipping.delete(body);
    }
  }

  private rememberPlaces() {
    const n = this.pedestrians.length;
    for (let i = 0; i < n; i++) {
      this.placeX[i] = this.pedestrians[i].position.x;
      this.placeY[i] = this.pedestrians[i].position.y;
    }
  }

  /**
   * Walls this person can actually hit: their own storey, plus the shell.
   * A swing is rejected when it would sit inside one of those slabs.
   */
  private clearanceWalls(ped: PedLabel): WallLike[] {
    const shell = this.separationWalls().filter((wall) => !this.interiorWalls.includes(wall));
    return [...this.wallsNear(ped), ...shell];
  }

  /** True when a centre is outside wall slabs and not on another person. */
  private spotClear(
    x: number,
    y: number,
    walls: WallLike[],
    ped: PedLabel,
    skipA?: Matter.Body,
    skipB?: Matter.Body,
  ): boolean {
    const next = separateFromWalls({ x, y }, walls);
    if ((next.x - x) * (next.x - x) + (next.y - y) * (next.y - y) > 1e-6) return false;
    for (const other of this.pedestrians) {
      if (other === skipA || other === skipB) continue;
      const op = this.pedOf(other);
      if (ped.level && op.level && ped.level !== op.level) continue;
      const dx = other.position.x - x;
      const dy = other.position.y - y;
      if (dx * dx + dy * dy < DOWNED_CONTACT_M * DOWNED_CONTACT_M) return false;
    }
    return true;
  }

  /**
   * Place a stacked pair on opposite sides of the nearest downed body.
   * The arm starts at 0.45 m. A landing inside a jamb, a wall or another
   * body is shortened, then turned, and dropped if nothing is clear.
   */
  private orbitApart(a: Matter.Body, b: Matter.Body) {
    const mx = (a.position.x + b.position.x) / 2;
    const my = (a.position.y + b.position.y) / 2;
    const pedA = this.pedOf(a);
    let sx = mx;
    let sy = my - 1;
    let best = 1.2;
    for (const other of this.pedestrians) {
      if (other === a || other === b) continue;
      const ped = this.pedOf(other);
      if (ped.level && pedA.level && ped.level !== pedA.level) continue;
      if (ped.state !== 'down' && !other.isStatic) continue;
      const d = Math.hypot(other.position.x - mx, other.position.y - my);
      if (d < best) {
        best = d;
        sx = other.position.x;
        sy = other.position.y;
      }
    }
    let rx = mx - sx;
    let ry = my - sy;
    const rl = Math.hypot(rx, ry);
    if (rl < 1e-3) {
      rx = 0;
      ry = 1;
    } else {
      rx /= rl;
      ry /= rl;
    }
    const tx = -ry;
    const ty = rx;
    const walls = this.clearanceWalls(pedA);
    const arms = [0.45, 0.38, 0.32];
    for (let step = 0; step <= 6; step++) {
      const ang = step * (Math.PI / 12);
      const c = Math.cos(ang);
      const s = Math.sin(ang);
      const dx = tx * c + rx * s;
      const dy = ty * c + ry * s;
      for (const arm of arms) {
        const ax = mx - dx * arm;
        const ay = my - dy * arm;
        const bx = mx + dx * arm;
        const by = my + dy * arm;
        if (
          !this.spotClear(ax, ay, walls, pedA, a, b) ||
          !this.spotClear(bx, by, walls, pedA, a, b)
        ) {
          continue;
        }
        Matter.Body.setPosition(a, { x: ax, y: ay });
        Matter.Body.setPosition(b, { x: bx, y: by });
        Matter.Body.setVelocity(a, { x: 0, y: 0 });
        Matter.Body.setVelocity(b, { x: 0, y: 0 });
        return;
      }
    }
  }

  /**
   * A slipping walker overlapping a static body can be commanded away and
   * still not move: the contact is inside the solver slop, so each step is
   * pulled back. After a few such frames, set them just clear of the body,
   * on a spot that is not inside a wall or someone else.
   */
  private releasePinned(slipping: Set<Matter.Body>) {
    const n = this.pedestrians.length;
    let walls: WallLike[] | null = null;
    let wallLevel: string | undefined;
    for (let i = 0; i < n; i++) {
      const body = this.pedestrians[i];
      const ped = this.pedOf(body);
      if (ped.state !== 'evacuating') continue;
      if (!slipping.has(body) && !this.stackedPair.has(ped.pedId)) {
        this.stillOnBody.delete(body);
        continue;
      }
      const movedX = body.position.x - (this.placeX[i] ?? body.position.x);
      const movedY = body.position.y - (this.placeY[i] ?? body.position.y);
      if (movedX * movedX + movedY * movedY > 1e-6) {
        this.stillOnBody.set(body, 0);
        continue;
      }
      let sx = 0;
      let sy = 0;
      let best = DOWNED_CONTACT_M;
      let anchor: Matter.Body | null = null;
      for (const other of this.pedestrians) {
        if (other === body) continue;
        const op = this.pedOf(other);
        if (ped.level && op.level && ped.level !== op.level) continue;
        if (op.state !== 'down' && !other.isStatic) continue;
        const d = Math.hypot(
          other.position.x - body.position.x,
          other.position.y - body.position.y,
        );
        if (d < best) {
          best = d;
          sx = other.position.x;
          sy = other.position.y;
          anchor = other;
        }
      }
      if (!anchor) {
        this.stillOnBody.set(body, 0);
        continue;
      }
      const still = (this.stillOnBody.get(body) ?? 0) + 1;
      this.stillOnBody.set(body, still);
      if (still < 6) continue;
      let ax = body.position.x - sx;
      let ay = body.position.y - sy;
      const al = Math.hypot(ax, ay);
      if (al < 1e-3) {
        ax = 0;
        ay = -1;
      } else {
        ax /= al;
        ay /= al;
      }
      const goal = this.steerGoal(ped);
      let gx = goal ? goal.x - body.position.x : ax;
      let gy = goal ? goal.y - body.position.y : ay;
      const gl = Math.hypot(gx, gy);
      if (gl < 0.3) continue;
      gx /= gl;
      gy /= gl;
      const side = Math.sign(ax * gy - ay * gx) || 1;
      if (!walls || wallLevel !== (ped.level ?? '')) {
        walls = this.clearanceWalls(ped);
        wallLevel = ped.level ?? '';
      }
      const spot = this.clearOfBody(sx, sy, ax, ay, gx, gy, side, walls, ped, body);
      if (!spot) continue;
      Matter.Body.setPosition(body, spot);
      Matter.Body.setVelocity(body, { x: 0, y: 0 });
      this.stillOnBody.set(body, 0);
    }
  }

  /** A point just outside `anchor`, toward the goal, and off the walls. */
  private clearOfBody(
    sx: number,
    sy: number,
    ax: number,
    ay: number,
    gx: number,
    gy: number,
    side: number,
    walls: WallLike[],
    ped: PedLabel,
    self: Matter.Body,
  ): Vec2 | null {
    for (const radius of [0.58, 0.7]) {
      for (const dir of [side, -side]) {
        for (let step = 0; step <= 6; step++) {
          const ang = dir * step * (Math.PI / 12);
          const c = Math.cos(ang);
          const s = Math.sin(ang);
          const rx = ax * c - ay * s;
          const ry = ax * s + ay * c;
          if (rx * gx + ry * gy < -0.15) continue;
          const x = sx + rx * radius;
          const y = sy + ry * radius;
          if (this.spotClear(x, y, walls, ped, self)) return { x, y };
        }
      }
    }
    return null;
  }

  private wallsNear(ped: PedLabel): InteriorWallDef[] {
    if (ped.level && this.wallsByLevel.has(ped.level)) return this.wallsByLevel.get(ped.level)!;
    return this.interiorWalls;
  }

  /** Where this person is actually walking: a stair end, or their exit. */
  private steerGoal(ped: PedLabel): Vec2 | null {
    if (this.levelPlan && ped.level && ped.targetStairId) {
      const stair = this.stairById(ped.targetStairId);
      if (stair) return stair.pos;
    }
    const exit = this.exits.find((e) => e.id === ped.targetExitId);
    return exit ? exit.center : null;
  }

  /**
   * A body overlapping a wall slab sticks to the face. Push it out by the
   * overlap: 0.65 m from the wall line alongside a face, and only the real
   * overlap with a jamb. Door and exit openings are not solid.
   */
  private unstickFromWalls() {
    const walls = this.separationWalls();
    const clear = WALL_FACE_CLEAR_M + 0.05;
    for (const body of this.pedestrians) {
      const ped = this.pedOf(body);
      if (ped.state === 'down' || ped.state === 'left_map') continue;
      const pos = this.posOf(body);
      const next = separateFromWalls(pos, [...walls, ...this.wallsNear(ped)], clear);
      if (Math.hypot(next.x - pos.x, next.y - pos.y) < 1e-3) continue;
      Matter.Body.setPosition(body, next);
      const nx = next.x - pos.x;
      const ny = next.y - pos.y;
      const len = Math.hypot(nx, ny) || 1;
      const vn = (body.velocity.x * nx + body.velocity.y * ny) / len;
      if (vn < 0) {
        Matter.Body.setVelocity(body, {
          x: body.velocity.x - (vn * nx) / len,
          y: body.velocity.y - (vn * ny) / len,
        });
      }
    }
  }

  /** Interior partitions plus the building shell, with exit gaps left open. */
  private separationWalls(): InteriorWallDef[] {
    const verts = this.config.vertices;
    const shell: InteriorWallDef[] = [];
    for (let i = 0; i < verts.length; i++) {
      const a = verts[i];
      const b = verts[(i + 1) % verts.length];
      const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const ux = (b.x - a.x) / len;
      const uy = (b.y - a.y) / len;
      const gaps = this.exits
        .filter((e) => e.edgeIndex === i && e.exitType !== 'service')
        .map((e) => {
          const t = (e.center.x - a.x) * ux + (e.center.y - a.y) * uy;
          return { lo: t - e.width / 2, hi: t + e.width / 2 };
        })
        .sort((p, q) => p.lo - q.lo);
      let cursor = 0;
      const push = (lo: number, hi: number) => {
        if (hi - lo < 0.05) return;
        shell.push({
          startX: a.x + ux * lo,
          startY: a.y + uy * lo,
          endX: a.x + ux * hi,
          endY: a.y + uy * hi,
          hasDoor: false,
          doorWidth: 0,
          doorPosition: 0.5,
        });
      };
      for (const gap of gaps) {
        push(cursor, Math.max(cursor, gap.lo));
        cursor = Math.max(cursor, gap.hi);
      }
      push(cursor, len);
    }
    return [...this.interiorWalls, ...shell];
  }

  /**
   * Line up on this side of the opening, on the person's own slot, then walk
   * through. `hold` keeps them on the near side until the flow cap releases them.
   * A target on the jamb leaves the body pinned on the slab.
   */
  private exitSteerTarget(
    pos: Vec2,
    exit: ExitDef,
    hold = false,
    walls: InteriorWallDef[] = this.interiorWalls,
  ): Vec2 {
    const verts = this.config.vertices;
    const gap = exitGapSlot(pos, exit, verts);
    if (!gap) {
      return steerToTarget(pos, exitApproachInside(exit, verts), walls, hold);
    }
    const edge = verts[exit.edgeIndex];
    const edgeB = verts[(exit.edgeIndex + 1) % verts.length];
    const edgeLen = Math.hypot(edgeB.x - edge.x, edgeB.y - edge.y) || 1;
    const ux = (edgeB.x - edge.x) / edgeLen;
    const uy = (edgeB.y - edge.y) / edgeLen;
    const along = (pos.x - exit.center.x) * ux + (pos.y - exit.center.y) * uy;
    const half = Math.max(0, exit.width / 2 - 0.25);
    const lane = Math.max(-half, Math.min(half, along));
    const slot = { x: exit.center.x + ux * lane, y: exit.center.y + uy * lane };
    const through =
      !hold &&
      !gap.clamped &&
      Math.abs(along) <= half + 0.05 &&
      gap.planeDist < MOUTH_APPROACH_M &&
      gap.planeDist > -0.4;
    // A person the cap has not released keeps their distance. Pulling the
    // whole queue onto the 0.7 m line stacks them on the radiant shell.
    const waitDist = Math.max(0.7, gap.planeDist);
    const goal = through
      ? { x: slot.x - gap.inward.x * 1.5, y: slot.y - gap.inward.y * 1.5 }
      : {
          x: slot.x + gap.inward.x * (hold ? waitDist : 0.7),
          y: slot.y + gap.inward.y * (hold ? waitDist : 0.7),
        };
    return steerToTarget(pos, goal, walls, hold);
  }

  private noteAvoid(ped: PedLabel, exitId: string, sticky = false) {
    if (!exitId) return;
    if (!ped.avoidExitIds) ped.avoidExitIds = [];
    if (!ped.avoidExitIds.includes(exitId)) ped.avoidExitIds.push(exitId);
    if (!sticky) return;
    if (!ped.turnedAwayIds) ped.turnedAwayIds = [];
    if (!ped.turnedAwayUntil) ped.turnedAwayUntil = [];
    const until = this.elapsed + SHOWCASE.TURN_BACK_HOLD_S;
    const i = ped.turnedAwayIds.indexOf(exitId);
    if (i < 0) {
      ped.turnedAwayIds.push(exitId);
      ped.turnedAwayUntil.push(until);
    } else {
      ped.turnedAwayUntil[i] = until;
    }
  }

  private expireTurnBacks(ped: PedLabel) {
    if (!ped.turnedAwayIds?.length) return;
    const ids: string[] = [];
    const until: number[] = [];
    for (let i = 0; i < ped.turnedAwayIds.length; i++) {
      if ((ped.turnedAwayUntil?.[i] ?? 0) > this.elapsed) {
        ids.push(ped.turnedAwayIds[i]);
        until.push(ped.turnedAwayUntil?.[i] ?? 0);
      }
    }
    ped.turnedAwayIds = ids;
    ped.turnedAwayUntil = until;
  }

  private pruneAvoid(ped: PedLabel, pos: Vec2) {
    this.expireTurnBacks(ped);
    if (!ped.avoidExitIds?.length) return;
    const field = this.field(ped.level);
    ped.avoidExitIds = ped.avoidExitIds.filter((id) => {
      if (ped.turnedAwayIds?.includes(id)) return true;
      const exit = this.exits.find((e) => e.id === id);
      if (!exit) return false;
      return exitRouteHazardous(pos, exit, this.config.vertices, field, this.interiorWalls);
    });
  }

  private currentChoice(ped: PedLabel): { id: string; cost: number } {
    return { id: ped.targetExitId, cost: ped.exitCost ?? Infinity };
  }

  private regions(): RouteRegions {
    if (!this.routeRegions) {
      this.routeRegions = new RouteRegions(this.config.vertices, this.interiorWalls);
    }
    return this.routeRegions;
  }

  /** False when no usable exit shares this person's floor region: walls, not smoke. */
  private routeOut(pos: Vec2): boolean {
    if (this.levelPlan) return true;
    return this.regions().hasRouteOut(pos, this.exits, this.config.vertices);
  }

  /** Stud positions a person can walk to without leaving their floor region. */
  private sameRegion(pos: Vec2): ((p: Vec2) => boolean) | undefined {
    if (this.levelPlan) return undefined;
    const regions = this.regions();
    const here = regions.regionAt(pos);
    if (here < 0) return undefined;
    const verts = this.config.vertices;
    return (p) => isInsidePolygon(p.x, p.y, verts) && regions.regionAt(p, 1) === here;
  }

  /** chooseExit, or null (shelter in place) when walls leave no route to any usable exit. */
  private routedChoice(...args: Parameters<typeof chooseExit>): ExitChoice | null {
    if (!this.routeOut(args[0])) return null;
    return chooseExit(...args);
  }

  private pickInitialExit(pos: Vec2): ExitChoice | null {
    return this.routedChoice(pos, this.exits, this.config.vertices, this.field(), null, {
      walls: this.interiorWalls,
      blockedDoors: this.blockedDoorsByLevel.get('') ?? [],
    });
  }

  private assignChoice(ped: PedLabel, pos: Vec2, choice: ExitChoice | null, count: boolean) {
    if (!choice) {
      const changed = !ped.sheltering;
      ped.sheltering = true;
      ped.forcedCrawl = true;
      ped.posture = 'crawl';
      ped.shelterTarget =
        this.field(ped.level).lowestKWithin(pos.x, pos.y, 6, this.sameRegion(pos)) ??
        ped.shelterTarget ??
        null;
      if (count && changed) this.rerouteCount++;
      return;
    }
    const wasForcedExit = ped.forcedCrawl === true && !ped.sheltering;
    const changed = choice.id !== ped.targetExitId;
    ped.targetExitId = choice.id;
    ped.exitCost = choice.cost;
    ped.sheltering = false;
    ped.forcedCrawl = choice.forced;
    if (choice.forced) ped.posture = 'crawl';
    // Hopping from one forced crawl to another is the threshold fallback
    // settling, not a decision to leave a usable exit.
    if (count && changed && !(wasForcedExit && choice.forced)) this.rerouteCount++;
  }

  private stepOutside(body: Matter.Body, ped: PedLabel, density: number) {
    const pos = this.posOf(body);
    if (ped.zoneId && !ped.disperse) {
      const z = this.zones.find((zone) => zone.id === ped.zoneId);
      if (z && Math.hypot(pos.x - z.pos.x, pos.y - z.pos.y) <= z.radius) {
        this.arrive(ped, z.id);
        Matter.Body.setVelocity(body, { x: 0, y: 0 });
        return;
      }
    }
    const bounds = polygonBounds(this.config.vertices);
    if (this.outsideGrown(pos, bounds)) {
      this.leaveMap(body, ped);
      return;
    }
    const wps = ped.waypoints ?? [];
    if (wps.length > 0 && Math.hypot(wps[0].x - pos.x, wps[0].y - pos.y) < 1.5) wps.shift();
    const injuryFactor = ped.injury === 'minor' ? SHOWCASE.MINOR_INJURY_SPEED_FACTOR : 1;
    const distExit = ped.exitUsed ? Math.hypot(pos.x - ped.exitUsed.x, pos.y - ped.exitUsed.y) : 0;
    const speed = outdoorSpeed(distExit, density, injuryFactor);
    if (wps.length > 0) {
      ped.lastDir = { x: wps[0].x - pos.x, y: wps[0].y - pos.y };
      this.steer(body, wps[0], speed, null);
      return;
    }
    if (ped.disperse) {
      const dir = ped.lastDir ?? { x: 1, y: 0 };
      const len = Math.hypot(dir.x, dir.y) || 1;
      this.steer(body, { x: pos.x + (dir.x / len) * 5, y: pos.y + (dir.y / len) * 5 }, speed, null);
      return;
    }
    const z = this.zones.find((zone) => zone.id === ped.zoneId);
    if (z) this.steer(body, z.pos, speed, null);
  }

  private stepArrived(body: Matter.Body, ped: PedLabel) {
    const z = this.zones.find((zone) => zone.id === ped.zoneId);
    if (!z) {
      Matter.Body.setVelocity(body, { x: 0, y: 0 });
      return;
    }
    if (!ped.jitterTarget || (ped.jitterUntil ?? 0) <= this.elapsed) {
      const ang = this.rng!() * Math.PI * 2;
      const rad = Math.sqrt(this.rng!()) * z.radius;
      ped.jitterTarget = { x: z.pos.x + Math.cos(ang) * rad, y: z.pos.y + Math.sin(ang) * rad };
      ped.jitterUntil = this.elapsed + 4;
    }
    this.steer(body, ped.jitterTarget, SHOWCASE.IDLE_WANDER_SPEED * 0.3, null);
  }

  private checkEvacuatedShowcase(body: Matter.Body, ped: PedLabel) {
    const { vertices } = this.config;
    const x = body.position.x;
    const y = body.position.y;
    if (isInsidePolygon(x, y, vertices)) return;

    let best: ExitDef | null = null;
    let bestD = Infinity;
    for (const exit of this.exits) {
      if (exit.exitType === 'service') continue;
      if (ped.level && levelOf(exit) !== ped.level) continue;
      const d = Math.hypot(x - exit.center.x, y - exit.center.y);
      if (d < exit.width + 1.5 && d < bestD) {
        best = exit;
        bestD = d;
      }
    }
    if (best) {
      this.exitCounts.set(best.id, (this.exitCounts.get(best.id) ?? 0) + 1);
      this.planOutdoor(ped, best, { x, y });
      return;
    }
    this.pushBackInside(body, vertices);
  }

  private planOutdoor(ped: PedLabel, exit: ExitDef, pos: Vec2) {
    ped.state = 'outside';
    ped.evacuated = true;
    ped.posture = 'stand';
    ped.exitUsed = { x: exit.center.x, y: exit.center.y };
    const mode = this.showcase?.afterExit ?? 'zone';
    const rollDisperse = mode === 'mixed' && this.rng!() < SHOWCASE.DISPERSE_SHARE;
    const safe = this.zones.filter((z) => this.zoneSafe(z));
    const useZone = !rollDisperse && mode !== 'disperse' && this.zones.length > 0;
    if (!useZone) {
      ped.disperse = true;
      ped.zoneId = null;
      const blast = this.blast?.site ?? pos;
      const target = this.disperseTarget(blast, exit.center);
      ped.waypoints = routeAroundOutline(pos, target, this.config.vertices);
      ped.lastDir = { x: target.x - pos.x, y: target.y - pos.y };
      return;
    }
    const pool = safe.length > 0 ? safe : this.zones;
    let pick = pool[0];
    if (safe.length > 0) {
      let best = Infinity;
      for (const z of safe) {
        const d = Math.hypot(z.pos.x - exit.center.x, z.pos.y - exit.center.y);
        if (d < best) {
          best = d;
          pick = z;
        }
      }
    } else {
      const blast = this.blast?.site ?? exit.center;
      let best = -1;
      for (const z of this.zones) {
        const d = Math.hypot(z.pos.x - blast.x, z.pos.y - blast.y);
        if (d > best) {
          best = d;
          pick = z;
        }
      }
      this.unsafeZoneNote = 'All assembly zones are unsafe; using the one farthest from the blast.';
    }
    ped.disperse = false;
    ped.zoneId = pick.id;
    const ang = this.rng!() * Math.PI * 2;
    const rad = Math.sqrt(this.rng!()) * 0.8 * pick.radius;
    const target = { x: pick.pos.x + Math.cos(ang) * rad, y: pick.pos.y + Math.sin(ang) * rad };
    ped.waypoints = routeAroundOutline(pos, target, this.config.vertices);
    ped.lastDir = { x: target.x - pos.x, y: target.y - pos.y };
  }

  private zoneSafe(zone: ShowcaseZone): boolean {
    const minD = assemblyMinDistanceM(this.buildingHeightM);
    if (distanceToOutline(zone.pos.x, zone.pos.y, this.config.vertices) < minD) return false;
    if (this.blast) {
      const d = Math.hypot(zone.pos.x - this.blast.site.x, zone.pos.y - this.blast.site.y);
      const glass = this.blast.glassInjuryM;
      const limit =
        glass != null && glass > 0 ? glass : SHOWCASE.ZONE_UNSAFE_FACTOR * this.blast.radius;
      if (d <= limit) return false;
    }
    return true;
  }

  private disperseTarget(blast: Vec2, exitCenter: Vec2): Vec2 {
    const bounds = polygonBounds(this.config.vertices);
    const minX = bounds.minX - SHOWCASE.MAP_MARGIN_M;
    const maxX = bounds.maxX + SHOWCASE.MAP_MARGIN_M;
    const minY = bounds.minY - SHOWCASE.MAP_MARGIN_M;
    const maxY = bounds.maxY + SHOWCASE.MAP_MARGIN_M;
    let dx = exitCenter.x - blast.x;
    let dy = exitCenter.y - blast.y;
    const len = Math.hypot(dx, dy) || 1;
    dx /= len;
    dy /= len;
    let tHit = Infinity;
    if (dx > 1e-9) tHit = Math.min(tHit, (maxX - blast.x) / dx);
    if (dx < -1e-9) tHit = Math.min(tHit, (minX - blast.x) / dx);
    if (dy > 1e-9) tHit = Math.min(tHit, (maxY - blast.y) / dy);
    if (dy < -1e-9) tHit = Math.min(tHit, (minY - blast.y) / dy);
    const t = (Number.isFinite(tHit) ? tHit : 0) + SHOWCASE.LEAVE_OVERSHOOT_M;
    return { x: blast.x + dx * t, y: blast.y + dy * t };
  }

  private outsideGrown(pos: Vec2, bounds: Bounds): boolean {
    return (
      pos.x < bounds.minX - SHOWCASE.MAP_MARGIN_M ||
      pos.x > bounds.maxX + SHOWCASE.MAP_MARGIN_M ||
      pos.y < bounds.minY - SHOWCASE.MAP_MARGIN_M ||
      pos.y > bounds.maxY + SHOWCASE.MAP_MARGIN_M
    );
  }

  private arrive(ped: PedLabel, zoneId: string) {
    if (ped.state === 'arrived') return;
    ped.state = 'arrived';
    ped.evacuated = true;
    ped.zoneId = zoneId;
    this.arrivedCounts.set(zoneId, (this.arrivedCounts.get(zoneId) ?? 0) + 1);
  }

  private leaveMap(body: Matter.Body, ped: PedLabel) {
    if (ped.state === 'left_map') return;
    ped.state = 'left_map';
    ped.evacuated = true;
    Matter.Composite.remove(this.engine.world, body);
    this.leftMapCount++;
  }

  private localDensity(
    people: Array<{ id: number; x: number; y: number }>,
    x: number,
    y: number,
    selfId: number,
  ): number {
    const cell = 1;
    const buckets = new Map<string, Array<{ id: number; x: number; y: number }>>();
    for (const p of people) {
      const key = `${Math.floor(p.x / cell)},${Math.floor(p.y / cell)}`;
      const list = buckets.get(key);
      if (list) list.push(p);
      else buckets.set(key, [p]);
    }
    const cx = Math.floor(x / cell);
    const cy = Math.floor(y / cell);
    let n = 0;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const list = buckets.get(`${cx + dx},${cy + dy}`);
        if (!list) continue;
        for (const p of list) {
          if (p.id === selfId) continue;
          if (Math.hypot(p.x - x, p.y - y) <= 1) n++;
        }
      }
    }
    return n / Math.PI;
  }

  private bumpStamp() {
    this.stampGen++;
    if (this.stampGen >= 0x7ffffffe) {
      this.stampGens.fill(0);
      this.stampGen = 1;
    }
  }

  /** True the first time `id` is seen for this query. */
  private stampFresh(id: number): boolean {
    let i = (Math.imul(id, 0x9e3779b1) >>> 0) & this.stampMask;
    const g = this.stampGen;
    const keys = this.stampKeys;
    const gens = this.stampGens;
    const mask = this.stampMask;
    for (let n = 0; n <= mask; n++) {
      if (gens[i] !== g) {
        gens[i] = g;
        keys[i] = id;
        return true;
      }
      if (keys[i] === id) return false;
      i = (i + 1) & mask;
    }
    return true;
  }

  /** Cells the segment touches, plus one cell of padding so a 0.8 m keep-out is never missed. */
  private cellsAlong(ax: number, ay: number, bx: number, by: number): number {
    const x0 = Math.floor(ax / STATIC_CELL_M);
    const y0 = Math.floor(ay / STATIC_CELL_M);
    const x1 = Math.floor(bx / STATIC_CELL_M);
    const y1 = Math.floor(by / STATIC_CELL_M);
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
    this.bumpStamp();
    this.cellN = 0;
    if (steps === 0) this.notePad(x0, y0);
    else {
      for (let i = 0; i <= steps; i++) {
        this.notePad(
          Math.round(x0 + ((x1 - x0) * i) / steps),
          Math.round(y0 + ((y1 - y0) * i) / steps),
        );
      }
    }
    return this.cellN;
  }

  private notePad(cx: number, cy: number) {
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const id = (cx + dx + CELL_BIAS) * CELL_STRIDE + (cy + dy + CELL_BIAS);
        if (!this.stampFresh(id)) continue;
        this.cellIds[this.cellN++] = id;
      }
    }
  }

  private addStaticHit(level: string, body: Matter.Body) {
    const cx = Math.floor(body.position.x / STATIC_CELL_M);
    const cy = Math.floor(body.position.y / STATIC_CELL_M);
    const id = (cx + CELL_BIAS) * CELL_STRIDE + (cy + CELL_BIAS);
    let grid = this.grids.get(level);
    if (!grid) {
      grid = new Map();
      this.grids.set(level, grid);
    }
    let bucket = grid.get(id);
    if (!bucket) {
      bucket = { hits: [], len: 0 };
      grid.set(id, bucket);
    }
    let hit = bucket.hits[bucket.len];
    if (!hit) {
      hit = { x: 0, y: 0, body };
      bucket.hits.push(hit);
    }
    hit.x = body.position.x;
    hit.y = body.position.y;
    hit.body = body;
    bucket.len++;
    let pts = this.levelBodies.get(level);
    if (!pts) {
      pts = [];
      this.levelBodies.set(level, pts);
    }
    const n = this.levelBodyN.get(level) ?? 0;
    let point = pts[n];
    if (!point) {
      point = { x: 0, y: 0 };
      pts.push(point);
    }
    point.x = hit.x;
    point.y = hit.y;
    this.levelBodyN.set(level, n + 1);
  }

  /**
   * Static bodies on this floor whose cells the segment touches.
   * The lists are reused; the result is valid until the next fill.
   */
  private fillNear(
    level: string,
    ax: number,
    ay: number,
    bx: number,
    by: number,
    self?: Matter.Body,
  ) {
    this.prepareStaticBodies();
    const nCells = this.cellsAlong(ax, ay, bx, by);
    const grid = this.grids.get(level);
    const view = this.nearView;
    view.length = 0;
    if (!grid) return;
    const ids = this.cellIds;
    for (let i = 0; i < nCells; i++) {
      const bucket = grid.get(ids[i]);
      if (!bucket) continue;
      for (let j = 0; j < bucket.len; j++) {
        const hit = bucket.hits[j];
        if (self && hit.body === self) continue;
        let slot = this.nearPool[view.length];
        if (!slot) {
          slot = { x: 0, y: 0 };
          this.nearPool.push(slot);
        }
        slot.x = hit.x;
        slot.y = hit.y;
        slot.radius = undefined;
        view.push(slot);
      }
    }
  }

  /** One grid per storey, then the doors whose openings those bodies have closed. */
  private prepareStaticBodies() {
    if (this.staticIndexSerial === this.motionSerial) return;
    this.staticIndexSerial = this.motionSerial;
    for (const grid of this.grids.values()) {
      for (const bucket of grid.values()) bucket.len = 0;
    }
    for (const level of this.levelBodyN.keys()) this.levelBodyN.set(level, 0);
    this.laneGen++;
    for (const body of this.pedestrians) {
      const other = this.pedOf(body);
      if (other.state !== 'down' && !body.isStatic) continue;
      const level = other.level ?? '';
      this.addStaticHit(level, body);
      // A slipping walker drops their own category. A downed body keeps the
      // wall bit of its storey, which that mask still includes, so people
      // squeeze past it instead of walking through it. Other storeys use
      // other bits and do not collide.
      const bits = this.collisionBits(other);
      body.collisionFilter.category = bits.wall;
      body.collisionFilter.mask = bits.ped;
    }
    this.blockedDoorsByLevel.clear();
    const groups: Array<[string, InteriorWallDef[]]> =
      this.wallsByLevel.size > 0 ? [...this.wallsByLevel.entries()] : [['', this.interiorWalls]];
    for (const [level, walls] of groups) {
      const pts = this.levelBodies.get(level) ?? [];
      const count = this.levelBodyN.get(level) ?? 0;
      const blocked: WallLike[] = [];
      for (const wall of walls) {
        if (!wall.hasDoor || !(wall.doorWidth > 0)) continue;
        if (doorHeldShut(wall)) {
          blocked.push(wall);
          continue;
        }
        const lanes = doorFreeLanes(wall, pts, DOWNED_CONTACT_M, count);
        this.laneCache.set(wall, { gen: this.laneGen, lanes });
        if (lanes != null && lanes.length === 0) blocked.push(wall);
      }
      if (blocked.length > 0) this.blockedDoorsByLevel.set(level, blocked);
    }
  }

  private collisionBits(ped: PedLabel): { ped: number; wall: number } {
    if (this.levelPlan && ped.level) {
      const slot = this.levelDefs.findIndex((l) => l.id === ped.level);
      if (slot >= 0) return levelCategories(slot);
    }
    return { ped: PED_CATEGORY, wall: WALL_CATEGORY };
  }

  private blockedDoorsFor(ped: PedLabel): readonly WallLike[] {
    return this.blockedDoorsByLevel.get(ped.level ?? '') ?? [];
  }

  private levelRouteBlocked(ped: PedLabel, pos: Vec2): boolean {
    const doors = this.blockedDoorsFor(ped);
    if (doors.length === 0) return false;
    if (ped.targetExitId) {
      const exit = this.exits.find((e) => e.id === ped.targetExitId);
      if (!exit) return false;
      const walls = this.wallsByLevel.get(ped.level ?? '') ?? this.interiorWalls;
      return routeCrossesBlockedDoor(pos, exit, this.config.vertices, walls, doors);
    }
    if (ped.targetStairId) {
      const stair = this.stairById(ped.targetStairId);
      if (!stair) return false;
      return segmentHitsBlockedDoor(pos, stair.pos, doors);
    }
    return false;
  }

  private obstaclePush(
    body: Matter.Body,
    x: number,
    y: number,
    radius: number,
    targetSpeed: number,
    dt: number,
  ): Vec2 {
    const odx = body.position.x - x;
    const ody = body.position.y - y;
    const oDist = Math.hypot(odx, ody);
    if (oDist >= radius || oDist <= 0.01) return { x: 0, y: 0 };
    const strength = ((radius - oDist) / radius) * targetSpeed * dt * 2;
    return { x: (odx / oDist) * strength, y: (ody / oDist) * strength };
  }

  private pushFromBodies(
    body: Matter.Body,
    near: ReadonlyArray<{ x: number; y: number }>,
    targetSpeed: number,
    dt: number,
  ): Vec2 {
    let x = 0;
    let y = 0;
    const mark = this.mouthMark;
    for (let i = 0; i < near.length; i++) {
      const radius = mark[i] ? DOWNED_CONTACT_M : DOWNED_AVOID_M;
      const push = this.obstaclePush(body, near[i].x, near[i].y, radius, targetSpeed, dt);
      x += push.x;
      y += push.y;
    }
    return { x, y };
  }

  /**
   * Open floor keeps the 0.8 m sidestep. A body in a door is contact distance,
   * and a passable door is aimed through the free lane so that sidestep does
   * not throw the line into the jamb.
   * `mouthMark` lines up with the returned `near` list.
   */
  private aimAroundBodies(
    body: Matter.Body,
    target: Vec2,
  ): {
    aim: Vec2;
    near: Array<{ x: number; y: number }>;
  } {
    const ped = this.pedOf(body);
    const pos = this.steerPos;
    pos.x = body.position.x;
    pos.y = body.position.y;
    this.fillNear(ped.level ?? '', pos.x, pos.y, target.x, target.y, body);
    const walls = this.wallsNear(ped);
    const near = this.nearView;
    markBodiesInDoors(walls, near, this.mouthMark);
    const squeeze = doorSqueezeAim(pos, target, walls, near, DOWNED_CONTACT_M, this.lookupLanes);
    const mark = this.mouthMark;
    let forSteer: Array<{ x: number; y: number; radius?: number }> = near;
    if (squeeze && squeeze.mouth.length > 0) {
      const skip = this.squeezeSkip;
      for (let k = 0; k < squeeze.mouth.length; k++) skip[squeeze.mouth[k]] = 1;
      const dst = this.steerView;
      dst.length = 0;
      for (let i = 0; i < near.length; i++) {
        near[i].radius = mark[i] ? DOWNED_CONTACT_M : undefined;
        if (skip[i] === 1) continue;
        dst.push(near[i]);
      }
      for (let k = 0; k < squeeze.mouth.length; k++) skip[squeeze.mouth[k]] = 0;
      forSteer = dst;
    } else {
      for (let i = 0; i < near.length; i++) near[i].radius = mark[i] ? DOWNED_CONTACT_M : undefined;
    }
    steerPastBodies(pos, squeeze?.aim ?? target, forSteer, DOWNED_AVOID_M, this.steerAim);
    return { aim: this.steerAim, near };
  }

  private steer(
    body: Matter.Body,
    target: Vec2,
    targetSpeed: number,
    fireField: HazardField | null,
    keepForward = false,
  ) {
    const dt = this.config.dt;
    const steered = this.aimAroundBodies(body, target);
    const aim = steered.aim;
    const dx = aim.x - body.position.x;
    const dy = aim.y - body.position.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 0.01) {
      Matter.Body.setVelocity(body, { x: 0, y: 0 });
      return;
    }
    const nx = dx / dist;
    const ny = dy / dist;
    let repX = 0;
    let repY = 0;
    for (const obs of this.obstacles) {
      const push = this.obstaclePush(body, obs.x, obs.y, obs.radius, targetSpeed, dt);
      repX += push.x;
      repY += push.y;
    }
    // A forced crawl, or a person the cap has released, is committed to the
    // opening. The radiant push is exactly what held that crowd on the shell.
    if (fireField && !keepForward) {
      for (const f of fireField.firesNear(
        body.position.x,
        body.position.y,
        SHOWCASE.FIRE_AVOID_RADIUS_M,
      )) {
        const r =
          f.state === 'burning' ? SHOWCASE.FIRE_AVOID_RADIUS_M : SHOWCASE.HEAT_AVOID_RADIUS_M;
        const odx = body.position.x - f.pos.x;
        const ody = body.position.y - f.pos.y;
        const oDist = Math.hypot(odx, ody);
        if (oDist < r && oDist > 0.01) {
          const strength = ((r - oDist) / r) * targetSpeed * dt * 2;
          repX += (odx / oDist) * strength;
          repY += (ody / oDist) * strength;
        }
      }
    } else if (keepForward) {
      const back = repX * nx + repY * ny;
      if (back < 0) {
        repX -= nx * back;
        repY -= ny * back;
      }
    }
    // A downed body still pushes, including backwards. Stripping that is
    // what walks people into the body they are trying to pass.
    const bodies = this.pushFromBodies(body, steered.near, targetSpeed, dt);
    repX += bodies.x;
    repY += bodies.y;
    // The 0.4 s blend never catches the air drag, so a crawler held on a
    // shell creeps. A released crossing takes the step it was given.
    const blend = keepForward ? 1 : Math.min(1, dt / 0.4);
    let newVx = body.velocity.x + (nx * targetSpeed * dt + repX - body.velocity.x) * blend;
    let newVy = body.velocity.y + (ny * targetSpeed * dt + repY - body.velocity.y) * blend;
    const currentSpeed = Math.hypot(newVx, newVy);
    const maxSpeed = targetSpeed * dt * 1.3;
    if (currentSpeed > maxSpeed && currentSpeed > 0) {
      const s = maxSpeed / currentSpeed;
      newVx *= s;
      newVy *= s;
    }
    Matter.Body.setVelocity(body, { x: newVx, y: newVy });
  }

  getSnapshots(): PedSnapshot[] {
    const snaps = this.pedestrians.map((body) =>
      this.snapshotOf(this.pedOf(body), body.position, body.velocity),
    );
    for (const occ of this.stairPeople) {
      const stair = this.stairById(occ.stairId);
      const pos = stair?.pos ?? { x: 0, y: 0 };
      const progress =
        occ.phase === 'travel'
          ? Math.min(1, (this.elapsed - occ.travelStart) / Math.max(1e-6, occ.travelDuration))
          : 0;
      const snap = this.snapshotOf(occ.label, pos, { x: 0, y: 0 });
      snap.level = occ.fromLevel;
      snap.inStair = { stairId: occ.stairId, dir: occ.dir, progress };
      snaps.push(snap);
    }
    return snaps;
  }

  private snapshotOf(
    ped: PedLabel,
    pos: { x: number; y: number },
    vel: { x: number; y: number },
  ): PedSnapshot {
    const snap: PedSnapshot = {
      id: ped.pedId,
      x: pos.x,
      y: pos.y,
      vx: vel.x,
      vy: vel.y,
      speed: Math.sqrt(vel.x ** 2 + vel.y ** 2) / this.config.dt,
      evacuated: ped.evacuated,
    };
    if (ped.state) {
      snap.state = ped.state;
      snap.posture = ped.posture;
      snap.familiarity = ped.familiarity;
      snap.injury = ped.injury;
      if (ped.fed != null && ped.fed > 0) snap.fumeFed = ped.fed;
      if (ped.heatFed != null && ped.heatFed > 0) snap.heatFed = ped.heatFed;
      if (ped.fec != null && ped.fec > 0) snap.fumeFec = ped.fec;
      if (ped.fumeHeld) snap.fumeHeld = true;
      if (ped.fumeDown) snap.fumeDown = true;
      if (ped.frozen && ped.state === 'evacuating') snap.frozen = true;
      if (ped.heatDown) snap.heatDown = true;
      snap.zoneId = ped.zoneId ?? null;
      if (ped.blastKpa != null) {
        snap.blastKpa = ped.blastKpa;
        snap.nearWall = ped.nearWall === true;
      }
    }
    if (ped.level) snap.level = ped.level;
    return snap;
  }

  getMetrics(): EvacMetrics {
    const snaps = this.getSnapshots();
    const active = snaps.filter((s) => !s.evacuated);
    const evacuated = snaps.filter((s) => s.evacuated).length;
    const avgSpeed =
      active.length > 0 ? active.reduce((sum, s) => sum + s.speed, 0) / active.length : 0;

    const exitFlows = this.exits.map((e) => ({
      exitId: e.id,
      count: this.exitCounts.get(e.id) ?? 0,
    }));

    const metrics: EvacMetrics = {
      elapsed: this.elapsed,
      totalPedestrians: snaps.length,
      evacuated,
      remaining: active.length,
      avgSpeed,
      exitFlows,
    };
    if (this.showcase) {
      const showcase = this.showcaseMetrics(snaps);
      metrics.showcase = showcase;
      metrics.remaining = showcase.idle + showcase.reacting + showcase.evacuating;
    }
    return metrics;
  }

  private showcaseMetrics(snaps: PedSnapshot[]): ShowcaseMetrics {
    let idle = 0;
    let reacting = 0;
    let evacuating = 0;
    let crouching = 0;
    let crawling = 0;
    let outside = 0;
    let minorInjured = 0;
    let lethal = 0;
    let serious = 0;
    let fumeHeld = 0;
    let frozen = 0;
    let fumeDown = 0;
    let heatDown = 0;
    for (const s of snaps) {
      if (s.state === 'idle') idle++;
      else if (s.state === 'reacting') reacting++;
      else if (s.state === 'evacuating') evacuating++;
      else if (s.state === 'outside') outside++;
      // A frozen person keeps the posture they froze in but is not moving in it.
      if (s.state === 'evacuating' && !s.frozen && s.posture === 'crouch') crouching++;
      if (s.state === 'evacuating' && !s.frozen && s.posture === 'crawl') crawling++;
      if (s.injury === 'minor') minorInjured++;
      if (s.state === 'down' && s.injury === 'lethal') lethal++;
      if (s.state === 'down' && s.injury === 'serious') serious++;
      if (s.fumeHeld && s.state !== 'down') fumeHeld++;
      if (s.frozen && s.state === 'evacuating') frozen++;
      if (s.fumeDown) fumeDown++;
      if (s.heatDown) heatDown++;
    }
    const arrived: Record<string, number> = {};
    for (const [id, n] of this.arrivedCounts) arrived[id] = n;
    return {
      idle,
      reacting,
      evacuating,
      crouching,
      crawling,
      turnedBack: this.turnedBackCount,
      outside,
      arrived,
      leftMap: this.leftMapCount,
      down: { lethal, serious },
      fumeHeld,
      fumeDown,
      heatDown,
      minorInjured,
      reroutes: this.rerouteCount,
      frozen,
      unfrozen: this.unfrozenCount,
      unsafeZoneNote: this.unsafeZoneNote,
      ...(this.levelPlan
        ? { byLevel: this.metricsByLevel(snaps), stairQueues: this.metricsQueues() }
        : {}),
    };
  }

  private metricsByLevel(
    snaps: PedSnapshot[],
  ): Record<string, { remaining: number; crawling: number }> {
    const out: Record<string, { remaining: number; crawling: number }> = {};
    for (const id of this.levelDefs.map((l) => l.id)) out[id] = { remaining: 0, crawling: 0 };
    for (const s of snaps) {
      const id = s.level;
      if (!id || !out[id]) continue;
      if (s.state === 'idle' || s.state === 'reacting' || s.state === 'evacuating')
        out[id].remaining++;
      if (s.state === 'evacuating' && !s.frozen && s.posture === 'crawl') out[id].crawling++;
    }
    return out;
  }

  private metricsQueues(): Record<string, { up: number; down: number }> {
    const out: Record<string, { up: number; down: number }> = {};
    for (const occ of this.stairPeople) {
      if (occ.phase !== 'queue') continue;
      const row = out[occ.stairId] ?? { up: 0, down: 0 };
      row[occ.dir]++;
      out[occ.stairId] = row;
    }
    return out;
  }

  private installLevelPlan(plan: EvacLevelPlan) {
    const ids = sortLevels(plan.ids);
    this.levelPlan = plan;
    this.levelDefs = ids.map((id) => ({
      id,
      name: id,
      index: levelIndex(id),
      heightM:
        plan.heights?.[id] ??
        (id.startsWith('B') ? LEVEL.DEFAULT_BASEMENT_HEIGHT_M : LEVEL.DEFAULT_STOREY_HEIGHT_M),
      designed: true,
      pedestrianCount: plan.counts?.[id] ?? 0,
    }));
    const stairs = plan.stairs.map((sw) => normaliseStairwell(sw, this.levelDefs));
    this.levelPlan = { ...plan, stairs };
    const flatExits: ExitDef[] = [];
    for (let k = 0; k < ids.length; k++) {
      const id = ids[k];
      const bits = levelCategories(k);
      const exits = (plan.exitsByLevel[id] ?? []).map((e) => ({ ...e, level: e.level ?? id }));
      flatExits.push(...exits);
      this.buildWalls(exits, bits.wall, bits.ped);
      const walls = plan.wallsByLevel[id] ?? [];
      this.wallsByLevel.set(id, walls);
      if (walls.length > 0) this.buildInteriorWalls(walls, bits.wall, bits.ped);
    }
    this.exits = flatExits;
    for (const id of ids) {
      const count = plan.counts?.[id] ?? 0;
      const slot = ids.indexOf(id);
      for (let n = 0; n < count; n++) this.spawnOnLevel(id, slot);
    }
    if (this.pedestrians.length > 0) Matter.Composite.add(this.engine.world, this.pedestrians);
  }

  private spawnOnLevel(levelId: string, slot: number) {
    const { vertices, pedestrianRadius: r } = this.config;
    const bounds = polygonBounds(vertices);
    const margin = r * 2;
    const bits = levelCategories(slot);
    const rnd = () => (this.rng ? this.rng() : Math.random());
    for (let attempt = 0; attempt < 50; attempt++) {
      const x = bounds.minX + margin + rnd() * (bounds.width - 2 * margin);
      const y = bounds.minY + margin + rnd() * (bounds.height - 2 * margin);
      if (!isInsidePolygon(x, y, vertices)) continue;
      const body = Matter.Bodies.circle(x, y, r, {
        restitution: 0.05,
        friction: 0.3,
        frictionAir: 0.15,
        density: 50,
        slop: BODY_SLOP_M,
        label: 'pedestrian',
      });
      body.collisionFilter = { group: 0, category: bits.ped, mask: bits.ped | bits.wall };
      const exits = this.exits.filter((e) => levelOf(e) === levelId && e.exitType !== 'service');
      const label: PedLabel = this.showcase
        ? {
            kind: 'pedestrian',
            pedId: this.pedIdCounter++,
            evacuated: false,
            targetExitId: '',
            state: 'idle',
            posture: 'stand',
            familiarity: this.rng!() < SHOWCASE.STAFF_SHARE ? 'staff' : 'visitor',
            injury: 'none',
            reactAt: Infinity,
            exitCost: Infinity,
            nextCheckAt: 0,
            waypoints: [],
            zoneId: null,
            wanderTarget: null,
            wanderUntil: 0,
            spawn: { x, y },
            smokeRollDone: false,
            latchedExitId: null,
            avoidExitIds: [],
            sheltering: false,
            forcedCrawl: false,
            shelterTarget: null,
            blastImpulse: null,
            exitUsed: null,
            jitterTarget: null,
            jitterUntil: 0,
            disperse: false,
            lastDir: null,
            level: levelId,
            targetStairId: null,
          }
        : {
            kind: 'pedestrian',
            pedId: this.pedIdCounter++,
            evacuated: false,
            targetExitId: exits[0]?.id ?? '',
            level: levelId,
            targetStairId: null,
          };
      (body as Matter.Body & { __ped: PedLabel }).__ped = label;
      this.pedestrians.push(body);
      return;
    }
  }

  private stepPlainLevel(
    body: Matter.Body,
    ped: PedLabel,
    targetSpeed: number,
    dt: number,
    tau: number,
  ) {
    const pos = this.posOf(body);
    if (this.elapsed + 1e-9 >= (ped.nextCheckAt ?? 0) || this.levelRouteBlocked(ped, pos)) {
      this.applyRoute(ped, pos, false);
      ped.nextCheckAt = this.elapsed + SHOWCASE.REROUTE_CHECK_S;
    }
    const target = this.routeTarget(ped);
    if (!target) {
      Matter.Body.setVelocity(body, { x: 0, y: 0 });
      return;
    }
    const dx = target.x - pos.x;
    const dy = target.y - pos.y;
    const dist = Math.hypot(dx, dy) || 1;
    const vDesX = (dx / dist) * targetSpeed * dt;
    const vDesY = (dy / dist) * targetSpeed * dt;
    const blend = Math.min(1, dt / tau);
    Matter.Body.setVelocity(body, {
      x: body.velocity.x + (vDesX - body.velocity.x) * blend,
      y: body.velocity.y + (vDesY - body.velocity.y) * blend,
    });
  }

  private stepEvacuatingLevel(body: Matter.Body, ped: PedLabel) {
    const pos = this.posOf(body);
    const field = this.field(ped.level);
    const sample = field.sample(pos.x, pos.y);
    const fam = ped.familiarity ?? 'visitor';
    if (!ped.forcedCrawl && !ped.sheltering)
      ped.posture = nextPosture(ped.posture ?? 'stand', sample.smoke, fam);
    else ped.posture = 'crawl';
    if (ped.fumeHeld) ped.posture = 'crawl';
    const injuryFactor = ped.injury === 'minor' ? SHOWCASE.MINOR_INJURY_SPEED_FACTOR : 1;
    const footing = sample.wet ? WET_FLOOR_SPEED : 1;
    const speed =
      walkingSpeed(
        extinctionK(sample.smoke),
        ped.posture ?? 'stand',
        SHOWCASE.SHOWCASE_PANIC,
        injuryFactor,
      ) * footing;
    if (
      this.elapsed + 1e-9 >= (ped.nextCheckAt ?? 0) ||
      (!ped.targetStairId && !ped.targetExitId) ||
      this.levelRouteBlocked(ped, pos)
    ) {
      this.applyRoute(ped, pos, true);
      ped.nextCheckAt = this.elapsed + SHOWCASE.REROUTE_CHECK_S;
    }
    const walls = this.wallsByLevel.get(ped.level ?? '') ?? [];
    if (ped.sheltering) {
      ped.shelterTarget = field.lowestKWithin(pos.x, pos.y, 6) ?? ped.shelterTarget ?? null;
      ped.posture = 'crawl';
      const shelter = ped.shelterTarget ?? pos;
      this.steer(body, steerToTarget(pos, shelter, walls), speed, field);
      return;
    }
    if (ped.targetStairId) {
      const stair = this.stairById(ped.targetStairId);
      const slot = stair ? this.stairAim(pos, stair, ped.pedId) : (this.routeTarget(ped) ?? pos);
      this.steer(body, steerToTarget(pos, slot, walls), speed, field);
      return;
    }
    const exit = this.exits.find((e) => e.id === ped.targetExitId);
    const held = this.mouthWait.has(ped.pedId) && !this.mouthGrant.has(ped.pedId);
    const aim = exit
      ? this.exitSteerTarget(pos, exit, held, walls)
      : steerToTarget(pos, this.routeTarget(ped) ?? pos, walls);
    const keepForward = ped.forcedCrawl === true || this.mouthGrant.has(ped.pedId);
    this.steer(body, aim, speed, field, keepForward);
  }

  /**
   * Spread people across the stair opening. The offset stays inside the
   * capture radius, and anyone already at the stair aims at its centre.
   */
  private stairAim(pos: Vec2, stair: Stairwell, pedId: number): Vec2 {
    const dx = stair.pos.x - pos.x;
    const dy = stair.pos.y - pos.y;
    const len = Math.hypot(dx, dy);
    if (len < 0.6) return stair.pos;
    const width = stair.widthM ?? LEVEL.DEFAULT_STAIR_WIDTH_M;
    const half = Math.min(0.45, Math.max(0, width / 2 - 0.25));
    const px = -dy / len;
    const py = dx / len;
    const lane = ((Math.imul(pedId + 1, 0x9e3779b1) >>> 0) % 1000) / 999;
    const shift = (lane - 0.5) * 2 * half;
    return { x: stair.pos.x + px * shift, y: stair.pos.y + py * shift };
  }

  private routeTarget(ped: PedLabel): Vec2 | null {
    if (ped.targetStairId) {
      const stair = this.stairById(ped.targetStairId);
      if (stair) return stair.pos;
    }
    const exit = this.exits.find((e) => e.id === ped.targetExitId);
    return exit ? exit.center : null;
  }

  private applyRoute(ped: PedLabel, pos: Vec2, count: boolean) {
    if (!this.levelPlan || !ped.level) return;
    const current = ped.targetStairId
      ? { id: ped.targetStairId, cost: ped.exitCost ?? Infinity }
      : ped.targetExitId
        ? { id: ped.targetExitId, cost: ped.exitCost ?? Infinity }
        : null;
    const choice = chooseRoute(
      pos,
      ped.level,
      this.exits,
      this.levelPlan.stairs,
      this.levelDefs,
      this.hazardFields,
      this.config.vertices,
      this.queueLengths(),
      current,
      this.blockedDoorsByLevel,
      this.wallsByLevel,
    );
    if (!choice) {
      ped.targetStairId = null;
      this.assignChoice(ped, pos, null, count);
      return;
    }
    if (choice.kind === 'exit') {
      const changed = ped.targetExitId !== choice.id || Boolean(ped.targetStairId);
      ped.targetStairId = null;
      this.assignChoice(
        ped,
        pos,
        { id: choice.id, cost: choice.cost, forced: false },
        count && changed,
      );
      return;
    }
    const changed = ped.targetStairId !== choice.id || ped.stairDir !== choice.dir;
    ped.targetStairId = choice.id;
    ped.stairDir = choice.dir ?? 'down';
    ped.stairToLevel = choice.toLevel;
    ped.targetExitId = '';
    ped.exitCost = choice.cost;
    ped.sheltering = false;
    if (count && changed) this.rerouteCount++;
  }

  private queueLengths(): Map<string, { up: number; down: number }> {
    const map = new Map<string, { up: number; down: number }>();
    for (const occ of this.stairPeople) {
      if (occ.phase !== 'queue') continue;
      const row = map.get(occ.stairId) ?? { up: 0, down: 0 };
      row[occ.dir]++;
      map.set(occ.stairId, row);
    }
    return map;
  }

  private stairById(id: string): Stairwell | undefined {
    return this.levelPlan?.stairs.find((s) => s.id === id);
  }

  private tickStairs(dt: number) {
    if (!this.levelPlan) return;
    const collapsed: StairOccupant[] = [];
    for (const occ of this.stairPeople) {
      const stair = this.stairById(occ.stairId);
      if (!stair) continue;
      if (this.breathe(occ.label, stair.pos.x, stair.pos.y, dt)) collapsed.push(occ);
    }
    for (const occ of collapsed) {
      occ.toLevel = occ.fromLevel;
      this.arriveFromStair(occ);
    }
    for (const occ of this.stairPeople) {
      if (occ.phase !== 'travel') continue;
      if (occ.label.fumeHeld && !occ.fumeStretched && occ.label.posture !== 'crawl') {
        const done = Math.min(occ.travelDuration, Math.max(0, this.elapsed - occ.travelStart));
        const remain = Math.max(0, occ.travelDuration - done);
        const stair = this.stairById(occ.stairId);
        const pos = stair?.pos ?? { x: 0, y: 0 };
        const slow =
          LEVEL.STAIR_CRAWL_FACTOR * this.irritantFooting(occ.label, pos.x, pos.y, occ.fromLevel);
        occ.travelDuration = done + remain / slow;
        occ.fumeStretch = slow;
        occ.label.posture = 'crawl';
        occ.fumeStretched = true;
      } else if (!occ.label.fumeHeld && occ.fumeStretched) {
        const done = Math.min(occ.travelDuration, Math.max(0, this.elapsed - occ.travelStart));
        const remain = Math.max(0, occ.travelDuration - done);
        occ.travelDuration = done + remain * (occ.fumeStretch ?? LEVEL.STAIR_CRAWL_FACTOR);
        occ.fumeStretched = false;
        occ.fumeStretch = undefined;
      }
    }
    this.advanceStairs();
    this.releaseStairs(dt);
  }

  /**
   * One breath of the smoke on the nearest stud, and the heat at that head.
   * Walking speed stays on the smoke density. FEC at 1 makes them crawl
   * until the next breath under 1. The asphyxiant FED and the heat FED are
   * separate. Either one at 1 puts them down, and that stays.
   */
  private breathe(ped: PedLabel, x: number, y: number, dt: number): boolean {
    if (ped.state === 'down' || ped.state === 'left_map') return false;
    const sample = this.field(ped.level).sample(x, y);
    const fumes = sample.fumes;
    ped.fed = advanceFed(
      ped.fed ?? 0,
      fumes,
      dt,
      sample.oxygenVolumePercent,
      sample.co2VolumePercent,
    );
    ped.heatFed = advanceHeatFed(ped.heatFed ?? 0, sample.headTempC, sample.radiantKwM2, dt);
    ped.fec = fecOf(fumes);
    ped.fumeHeld = fecImpairs(ped.fec);
    const gasDown = (ped.fed ?? 0) >= 1;
    const heatDown = (ped.heatFed ?? 0) >= 1;
    if (!exposureIncapacitates(ped.fed ?? 0, ped.heatFed ?? 0)) return false;
    ped.state = 'down';
    ped.injury = 'serious';
    if (gasDown) ped.fumeDown = true;
    if (heatDown) ped.heatDown = true;
    ped.fumeHeld = false;
    ped.evacuated = false;
    return true;
  }

  private advanceStairs() {
    const done: StairOccupant[] = [];
    for (const occ of this.stairPeople) {
      if (occ.phase !== 'travel') continue;
      if (this.elapsed - occ.travelStart + 1e-9 >= occ.travelDuration) done.push(occ);
    }
    for (const occ of done) this.arriveFromStair(occ);
  }

  private releaseStairs(dt: number) {
    if (!this.levelPlan) return;
    for (const stair of this.levelPlan.stairs) {
      if (stair.blocked || (stair.kind ?? 'stair') === 'lift') continue;
      for (const dir of ['up', 'down'] as const) {
        const key = `${stair.id}:${dir}`;
        const waiting = this.stairPeople
          .filter((p) => p.stairId === stair.id && p.dir === dir && p.phase === 'queue')
          .sort((a, b) => a.enqueuedAt - b.enqueuedAt);
        if (waiting.length === 0) {
          this.stairAcc.set(key, 0);
          this.stairPrimed.set(key, false);
          continue;
        }
        if (waiting[0].label.fumeHeld) waiting[0].label.posture = 'crawl';
        let acc = this.stairAcc.get(key) ?? 0;
        if (!this.stairPrimed.get(key)) {
          acc = Math.max(acc, 1);
          this.stairPrimed.set(key, true);
        }
        acc += stairFlowPerS(stair) * dt;
        while (acc >= 1 && waiting.length > 0) {
          acc -= 1;
          const next = waiting.shift()!;
          this.beginTravel(next);
        }
        const stillWaiting = this.stairPeople.some(
          (p) => p.stairId === stair.id && p.dir === dir && p.phase === 'queue',
        );
        if (!stillWaiting) {
          acc = 0;
          this.stairPrimed.set(key, false);
        }
        this.stairAcc.set(key, acc);
      }
    }
  }

  private beginTravel(occ: StairOccupant) {
    const from = this.levelDefs.find((l) => l.id === occ.fromLevel);
    if (occ.label.fumeHeld) occ.label.posture = 'crawl';
    const stair = this.stairById(occ.stairId);
    const pos = stair?.pos ?? { x: 0, y: 0 };
    const footing = occ.label.fumeHeld
      ? this.irritantFooting(occ.label, pos.x, pos.y, occ.fromLevel)
      : 1;
    const postureFactor =
      occ.label.posture === 'crawl'
        ? LEVEL.STAIR_CRAWL_FACTOR
        : occ.label.posture === 'crouch'
          ? LEVEL.CROUCH_SPEED_FACTOR
          : 1;
    const factor = postureFactor * footing;
    // The irritant crawl can clear on the stair. Remember the slowdown so
    // the remaining time returns to the pace they had without it.
    occ.fumeStretched = occ.label.fumeHeld === true;
    occ.fumeStretch = occ.label.fumeHeld ? factor : undefined;
    occ.phase = 'travel';
    occ.travelStart = this.elapsed;
    occ.travelDuration = from ? stairTravelS(from, occ.dir) / factor : 1;
  }

  private arriveFromStair(occ: StairOccupant) {
    this.stairPeople = this.stairPeople.filter((p) => p !== occ);
    const stair = this.stairById(occ.stairId);
    const slot = this.levelDefs.findIndex((l) => l.id === occ.toLevel);
    if (!stair || slot < 0) return;
    const rnd = () => (this.rng ? this.rng() : Math.random());
    const ang = rnd() * Math.PI * 2;
    const rad = Math.sqrt(rnd()) * 0.5;
    let x = stair.pos.x + Math.cos(ang) * rad;
    let y = stair.pos.y + Math.sin(ang) * rad;
    if (!isInsidePolygon(x, y, this.config.vertices)) {
      x = stair.pos.x;
      y = stair.pos.y;
    }
    const bits = levelCategories(slot);
    const r = this.config.pedestrianRadius;
    const body = Matter.Bodies.circle(x, y, r, {
      restitution: 0.05,
      friction: 0.3,
      frictionAir: 0.15,
      density: 50,
      slop: BODY_SLOP_M,
      label: 'pedestrian',
    });
    body.collisionFilter = { group: 0, category: bits.ped, mask: bits.ped | bits.wall };
    const ped = occ.label;
    const fumeDown = ped.fumeDown === true || ped.heatDown === true;
    ped.level = occ.toLevel;
    ped.targetStairId = null;
    ped.targetExitId = '';
    ped.nextCheckAt = 0;
    ped.evacuated = false;
    ped.waypoints = [];
    if (this.showcase && !fumeDown) ped.state = 'evacuating';
    if (fumeDown) {
      ped.state = 'down';
      ped.injury = 'serious';
      Matter.Body.setStatic(body, true);
      Matter.Body.setVelocity(body, { x: 0, y: 0 });
    }
    (body as Matter.Body & { __ped: PedLabel }).__ped = ped;
    this.pedestrians.push(body);
    Matter.Composite.add(this.engine.world, body);
  }

  private collectCaptures() {
    if (!this.levelPlan) return;
    for (const body of this.pedestrians) {
      const ped = this.pedOf(body);
      if (ped.evacuated || !ped.level || !ped.targetStairId) continue;
      if (ped.state && ped.state !== 'evacuating') continue;
      const stair = this.stairById(ped.targetStairId);
      if (!stair || stair.blocked || (stair.kind ?? 'stair') === 'lift') continue;
      const d = Math.hypot(body.position.x - stair.pos.x, body.position.y - stair.pos.y);
      if (d <= LEVEL.STAIR_CAPTURE_RADIUS_M) this.pendingCapture.push(body);
    }
  }

  private flushCapture() {
    const bodies = this.pendingCapture;
    this.pendingCapture = [];
    for (const body of bodies) {
      const idx = this.pedestrians.indexOf(body);
      if (idx < 0) continue;
      const ped = this.pedOf(body);
      const stair = ped.targetStairId ? this.stairById(ped.targetStairId) : undefined;
      if (!stair || !ped.level || !ped.stairToLevel) continue;
      const field = this.field(ped.level);
      const sample = field.sample(stair.pos.x, stair.pos.y);
      if (!ped.forcedCrawl)
        ped.posture = nextPosture(
          ped.posture ?? 'stand',
          sample.smoke,
          ped.familiarity ?? 'visitor',
        );
      this.pedestrians.splice(idx, 1);
      Matter.Composite.remove(this.engine.world, body);
      this.stairPeople.push({
        label: ped,
        stairId: stair.id,
        dir: ped.stairDir ?? 'down',
        fromLevel: ped.level,
        toLevel: ped.stairToLevel,
        phase: 'queue',
        enqueuedAt: this.elapsed,
        travelStart: this.elapsed,
        travelDuration: 1,
      });
    }
  }

  getVertices() {
    return this.config.vertices;
  }

  getExits() {
    return this.exits;
  }

  getConfig() {
    return this.config;
  }

  destroy() {
    Matter.Engine.clear(this.engine);
    Matter.Composite.clear(this.engine.world, false);
  }
}
