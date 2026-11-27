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
  sampleWalkSpeedMps,
  unimpededWalkMps,
  walkingSpeed,
  RouteRegions,
  type ExitChoice,
  type Familiarity,
  type RouteChoice,
  type Posture,
  type StudStateLike,
  type WallLike,
  sightBlocked,
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
  fedPerMin,
  heatFedPerMin,
} from '../rts/toxicDose';
import {
  levelCategories,
  levelIndex,
  levelOf,
  linkLevels,
  normaliseStairwell,
  sortLevels,
  stairTravelS,
} from '../rts/levels';
import type { LevelDef, Stairwell } from '../rts/types';
import {
  flightAreaM2,
  flightFlowPerS,
  flightKey,
  flightStorage,
  flightWaitS,
  flightWidthM,
  mergePick,
  stairDensitySpeed,
  stairFlights,
  type FlightWait,
  type StairSource,
} from './stairFlow';

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
/** Spacing of drawn door-queue places: hexagonal, about 3.2 p/m². Display only. */
const QUEUE_SPACING_M = 0.6;
/** Farthest a drawn door-queue place sits from the stair point. Display only. */
const QUEUE_REACH_M = 8;
/** Door-queue places start outside the stair point's own disc. Display only. */
const QUEUE_CLEAR_M = 0.9;

interface FlightLoad {
  /** Waiting at the floor door. */
  floor: number;
  /** Waiting on the landing, already on the stair. */
  stream: number;
  moving: number;
  responders: number;
}

const NO_LOAD: FlightLoad = { floor: 0, stream: 0, moving: 0, responders: 0 };

function demandOf(load: FlightLoad): number {
  return load.floor + load.stream + load.moving;
}

function opposite(dir: 'up' | 'down'): 'up' | 'down' {
  return dir === 'up' ? 'down' : 'up';
}

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
  inStair?: {
    stairId: string;
    dir: 'up' | 'down';
    progress: number;
    /** Waiting at the flight's head, or walking it. Absent means walking. */
    phase?: 'queue' | 'travel';
    /** Floor door queue, or the stair stream waiting on the landing. */
    queue?: StairSource;
    /** Storey the flight leads to. */
    toLevel?: string;
  };
}

/** One flight of one stair in one direction, as the debug page shows it. */
export interface StairFlightView {
  stairId: string;
  dir: 'up' | 'down';
  fromLevel: string;
  toLevel: string;
  /** Waiting at the floor door to step on. */
  door: number;
  /** Already on the stair, waiting on the landing to go on down or up. */
  landing: number;
  /** Walking the flight now. */
  moving: number;
  /** Responders among `door`, `landing` and `moving`. */
  responders: number;
  /** Release rate for this direction right now, persons per second. */
  flowPerS: number;
  /** Most the flight holds, walking plus waiting at its foot. */
  storage: number;
  counterflow: boolean;
  /** Releases held because the flight below the landing is full. */
  full: boolean;
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
  stairFlights?: StairFlightView[];
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
  /** Unimpeded level speed, m/s. Drawn once. Stairs keep the stair timer. */
  freeWalkMps?: number;
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
  /**
   * Projected FED at the far door when a dead-end stair crawl was first
   * taken. Set once, on that first decision, and never reset by later route
   * checks, reroutes or arrival.
   */
  crawlProjection?: number;
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
  /**
   * Forced-crawl command, in the same units as Matter velocity. Held while a
   * corner aim flips, so the body is not reversed every step.
   */
  crawlVx?: number;
  crawlVy?: number;
  /** Sim time when the aim first opposed `crawlVx`/`crawlVy`. */
  crawlOpposeAt?: number;
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

interface FlightOccupant {
  stairId: string;
  dir: 'up' | 'down';
  /** Storey at the head of the flight now being queued for or walked. */
  fromLevel: string;
  toLevel: string;
  phase: 'queue' | 'travel';
  /** Came in at the floor door, or stayed on the stair from the flight before. Absent means floor. */
  source?: StairSource;
  enqueuedAt: number;
  travelStart: number;
  travelDuration: number;
  /** Walking pace on the flight before the density cap, m/s: free speed times posture and footing. */
  ownMps?: number;
  /** Pace the remaining travel time is set at: the lower of `ownMps` and the density cap. */
  paceMps?: number;
}

interface StairOccupant extends FlightOccupant {
  label: PedLabel;
  /** The remaining stair time was stretched for irritant smoke. */
  fumeStretched?: boolean;
  /** Factor applied to the remaining time while the irritant crawl is on. */
  fumeStretch?: number;
}

/**
 * A responder climbing or descending a stair. Not an evacuee: breathing
 * apparatus, so no dose, and not in the crowd counts. It takes flight
 * capacity like anyone else, and against the crowd it is counterflow.
 */
interface StairResponder extends FlightOccupant {
  id: string;
  finalLevel: string;
}

function isPerson(occ: FlightOccupant): occ is StairOccupant {
  return 'label' in occ;
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

/**
 * The §2.6 crawl takes the held or the straight-line nearest door. A door
 * behind a wall would pin the person on the wall, so a forced pick outside
 * their region is made again from the doors they can reach.
 */
function forcedWithinWalls(
  choice: ExitChoice | null,
  regions: RouteRegions,
  args: Parameters<typeof chooseExit>,
): ExitChoice | null {
  if (!choice?.forced) return choice;
  const [pos, exits, verts, ...rest] = args;
  const reach = regions.reachableExits(pos, exits, verts);
  if (reach.length === 0 || reach.some((exit) => exit.id === choice.id)) return choice;
  return chooseExit(pos, reach, verts, ...rest);
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
  private walkSeed: number = SHOWCASE.RNG_SEED;
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
  private stairResponders: StairResponder[] = [];
  /** Responders who have reached their storey: id, storey, seconds. */
  private responderArrivals: Array<{ id: string; level: string; atS: number }> = [];
  /** Release slot of the last person let onto each flight, by flightKey. */
  private stairLastRelease = new Map<string, number>();
  /** Floor-share credit carried between merged releases, by flightKey. */
  private mergeCredit = new Map<string, number>();
  /** Flights holding releases for want of room below, by flightKey, last step. */
  private flightFull = new Set<string>();
  private flightWaitCache: { at: number; waits: Map<string, FlightWait> } | null = null;
  /** Shaft column temperature, kelvin, by `stairId|lowerLevel|upperLevel`. */
  private shaftColumnK = new Map<string, number>();
  /** Queue places around each stair on each storey, by `stairId:level`. */
  private queueSlots = new Map<string, Vec2[]>();
  private pendingCapture: Matter.Body[] = [];
  private hazardFields = new Map<string, HazardField>();
  /** Last map passed to setHazardStates. A field installed later starts on it. */
  private hazardStates: ReadonlyMap<string, StudStateLike> | null = null;
  private blastLevel: string | null = null;
  private wallsByLevel = new Map<string, InteriorWallDef[]>();
  private levelRegions = new Map<string, RouteRegions>();
  /**
   * Per-stud dose rates at the last DOSE_TREND_SAMPLES trend samples, oldest
   * first, keyed `level:studId`.
   */
  private trend: Array<{ t: number; rates: Map<string, { fed: number; heat: number }> }> = [];
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
    this.walkSeed = showcase?.seed ?? SHOWCASE.RNG_SEED;
    if (showcase) {
      this.showcase = showcase;
      this.rng = mulberry32(this.walkSeed);
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

  /**
   * Air drag stays at 0. A frictionAir of 0.15, combined with the 0.4 s
   * steering blend, settled near a fifth of the commanded speed. The blend
   * is the damping: each step relaxes the body toward the velocity it was
   * given, so a contact leftover fades without holding the walk under that speed.
   */
  private personBody(x: number, y: number, r: number): Matter.Body {
    return Matter.Bodies.circle(x, y, r, {
      restitution: 0.05,
      friction: 0.3,
      frictionAir: 0,
      density: 50,
      slop: BODY_SLOP_M,
      label: 'pedestrian',
    });
  }

  private walkMps(pedId: number): number {
    return sampleWalkSpeedMps(this.walkSeed, pedId);
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

      const body = this.personBody(x, y, r);

      body.collisionFilter = {
        group: 0,
        category: PED_CATEGORY,
        mask: PED_CATEGORY | WALL_CATEGORY,
      };

      const pedId = this.pedIdCounter++;
      const freeWalkMps = this.walkMps(pedId);
      const pedLabel: PedLabel = this.showcase
        ? {
            kind: 'pedestrian',
            pedId,
            freeWalkMps,
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
            pedId,
            freeWalkMps,
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
      this.sampleDoseTrend();
      this.stepShowcase();
      return;
    }
    const { dt, desiredSpeed, panicFactor } = this.config;
    this.tickStairs(dt);
    const tau = 0.4;

    for (const body of this.pedestrians) {
      const ped: PedLabel = (body as any).__ped;
      if (ped.evacuated || ped.state === 'down' || ped.state === 'left_map') continue;
      // FEC at 1 is the seeded crawl toward the exit, not a stop. Injury
      // and a wet floor slow that crawl the same way they slow a walk.
      // The seeded free speed is scaled so a crowd's mean matches desiredSpeed.
      const personal =
        ped.freeWalkMps != null
          ? ped.freeWalkMps * (desiredSpeed / SHOWCASE.WALK_SPEED_MEAN)
          : desiredSpeed;
      const pace = ped.fumeHeld
        ? SHOWCASE.CRAWL_SPEED *
          this.irritantFooting(ped, body.position.x, body.position.y, ped.level)
        : unimpededWalkMps(personal, panicFactor);
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
    if (field && this.hazardStates) field.setStates(this.hazardStates);
  }

  setHazardFields(fields: ReadonlyMap<string, HazardField>) {
    this.hazardFields = new Map(fields);
    if (!this.hazardStates) return;
    for (const field of this.hazardFields.values()) field.setStates(this.hazardStates);
  }

  /**
   * Point every field the crowd reads, the single one and each storey's, at
   * the effects engine's stud states. Call it every frame: the effects
   * engine can be rebuilt with a new map.
   */
  setHazardStates(states: ReadonlyMap<string, StudStateLike>) {
    this.hazardStates = states;
    this.hazardField?.setStates(states);
    for (const field of this.hazardFields.values()) field.setStates(states);
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
    // In a multi-storey scene a responder releases only people on its own
    // storey. One without a level is on G, as the renderer draws it, so a unit
    // placed before a second storey was added still works on the ground floor.
    this.responders = responders.map((r) => ({ id: r.id, pos: { ...r.pos }, level: r.level }));
  }

  /**
   * Freezing in fear. The first time smoke at FREEZE_TRIGGER_K or a burning
   * stud reaches an evacuee who has a route, a seeded per-person roll may
   * freeze them. They stand still, still breathing the smoke, until a
   * responder on their storey comes within FREEZE_RELEASE_M with no wall
   * between them; then they re-choose and go.
   * Nothing else ends a freeze. The freeze roll and the smoke turn-back roll
   * are both keyed on the person, not drawn from the shared stream, so
   * someone held frozen moves nobody else's pre-movement or turn-back draw.
   * After-exit wander points still come from the shared stream, in arrival
   * order. Someone sheltering with no route is not frozen; that is a
   * different state.
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

  /** One-time smoke turn-back roll, keyed on the person like the freeze roll. */
  private turnBackRoll(pedId: number): number {
    const seed = (this.showcase?.seed ?? SHOWCASE.RNG_SEED) >>> 0;
    return mulberry32((seed ^ Math.imul(pedId + 1, 0x85ebca6b) ^ 0x5bd1e995) >>> 0)();
  }

  private responderNear(body: Matter.Body, ped: PedLabel): boolean {
    const reach = SHOWCASE.FREEZE_RELEASE_M;
    const pos = this.posOf(body);
    let walls: WallLike[] | null = null;
    for (const r of this.responders) {
      if (this.levelPlan && levelOf(r) !== levelOf(ped)) continue;
      if (Math.hypot(r.pos.x - pos.x, r.pos.y - pos.y) > reach) continue;
      // Interior walls and the shell, with exit gaps open: a marshal outside an
      // exit can reach someone in it, not someone behind the wall beside it.
      walls ??= [...this.wallsNear(ped), ...this.shellWalls(ped.level)];
      if (sightBlocked(r.pos, pos, walls)) continue;
      return true;
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
        ped.freeWalkMps ?? SHOWCASE.FREE_WALK_SPEED,
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
          if (this.turnBackRoll(ped.pedId) < SHOWCASE.TURN_BACK_PERMILLE / 1000) {
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
    const granted = this.mouthGrant.has(ped.pedId);
    const keepForward = ped.forcedCrawl === true || granted;
    this.steer(body, target, speed, field, keepForward, granted);
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
    return [...this.wallsNear(ped), ...this.shellWalls(ped.level)];
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

  /**
   * Partitions on this person's storey. With a level plan, interiorWalls
   * holds every storey, so it is never the answer for one person.
   */
  private wallsNear(ped: PedLabel): InteriorWallDef[] {
    if (ped.level && this.wallsByLevel.has(ped.level)) return this.wallsByLevel.get(ped.level)!;
    if (this.levelPlan && ped.level) return [];
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
    const byLevel = new Map<string, InteriorWallDef[]>();
    const clear = WALL_FACE_CLEAR_M + 0.05;
    for (const body of this.pedestrians) {
      const ped = this.pedOf(body);
      if (ped.state === 'down' || ped.state === 'left_map') continue;
      const pos = this.posOf(body);
      const key = ped.level ?? '';
      let walls = byLevel.get(key);
      if (!walls) {
        walls = this.separationWalls(ped.level);
        byLevel.set(key, walls);
      }
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

  /**
   * Interior partitions plus the building shell, with exit gaps left open.
   * A storey gets only its own partitions and its own exit gaps: the shell
   * of an upper floor is solid where the ground floor has a door.
   */
  private separationWalls(level?: string): InteriorWallDef[] {
    const shell = this.shellWalls(level);
    if (this.levelPlan && level) return shell;
    return [...this.interiorWalls, ...shell];
  }

  private shellWalls(level?: string): InteriorWallDef[] {
    const verts = this.config.vertices;
    const storey = this.levelPlan && level ? level : null;
    const shell: InteriorWallDef[] = [];
    for (let i = 0; i < verts.length; i++) {
      const a = verts[i];
      const b = verts[(i + 1) % verts.length];
      const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const ux = (b.x - a.x) / len;
      const uy = (b.y - a.y) / len;
      const gaps = this.exits
        .filter(
          (e) =>
            e.edgeIndex === i &&
            e.exitType !== 'service' &&
            (storey == null || levelOf(e) === storey),
        )
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
    return shell;
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
    return forcedWithinWalls(chooseExit(...args), this.regions(), args);
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
    /** A mouth grant takes the commanded step at once. A forced crawl does not. */
    takeStep = false,
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
    // Relax toward the commanded step. With no air drag this reaches that
    // speed. A released crossing takes the step at once. A forced crawl keeps
    // its last command while a corner aim opposes it. On the stall corner the
    // two ends trade about once a second, and the wall contact zeroes the
    // body velocity, so a short blend follows the trade and the crawl never
    // leaves. A reverse has to persist before it is taken.
    const cmdVx = nx * targetSpeed * dt + repX;
    const cmdVy = ny * targetSpeed * dt + repY;
    const crawler = this.pedOf(body);
    let newVx: number;
    let newVy: number;
    if (keepForward && !takeStep) {
      const px = crawler.crawlVx;
      const py = crawler.crawlVy;
      const has = px != null && py != null;
      const oppose = has && px * cmdVx + py * cmdVy < 0;
      if (!has || !oppose) {
        newVx = cmdVx;
        newVy = cmdVy;
        crawler.crawlOpposeAt = undefined;
      } else {
        const since = crawler.crawlOpposeAt ?? this.elapsed;
        crawler.crawlOpposeAt = since;
        if (this.elapsed - since >= 2) {
          const relax = Math.min(1, dt / 0.4);
          newVx = px + (cmdVx - px) * relax;
          newVy = py + (cmdVy - py) * relax;
        } else {
          newVx = px;
          newVy = py;
        }
      }
      crawler.crawlVx = newVx;
      crawler.crawlVy = newVy;
    } else {
      crawler.crawlVx = undefined;
      crawler.crawlVy = undefined;
      crawler.crawlOpposeAt = undefined;
      const blend = takeStep ? 1 : Math.min(1, dt / 0.4);
      newVx = body.velocity.x + (cmdVx - body.velocity.x) * blend;
      newVy = body.velocity.y + (cmdVy - body.velocity.y) * blend;
    }
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
    const ranks = new Map<string, number>();
    const queued = this.stairPeople
      .filter((occ) => occ.phase === 'queue')
      .sort((a, b) => a.enqueuedAt - b.enqueuedAt);
    for (const occ of this.stairPeople) {
      const stair = this.stairById(occ.stairId);
      let pos = stair?.pos ?? { x: 0, y: 0 };
      const progress =
        occ.phase === 'travel'
          ? Math.min(1, (this.elapsed - occ.travelStart) / Math.max(1e-6, occ.travelDuration))
          : 0;
      const source = occ.source ?? 'floor';
      if (stair && occ.phase === 'queue') {
        // Up and down door queues at one landing share the floor there.
        const key = `${occ.stairId}:${occ.fromLevel}:${source}`;
        let rank = ranks.get(`${key}#${occ.label.pedId}`);
        if (rank == null) {
          let n = 0;
          for (const other of queued) {
            if (other.stairId !== occ.stairId || other.fromLevel !== occ.fromLevel) continue;
            if ((other.source ?? 'floor') !== source) continue;
            ranks.set(`${key}#${other.label.pedId}`, n++);
          }
          rank = ranks.get(`${key}#${occ.label.pedId}`) ?? 0;
        }
        pos = this.queuePlace(stair, occ.fromLevel, source, rank);
      }
      const snap = this.snapshotOf(occ.label, pos, { x: 0, y: 0 });
      snap.level = occ.fromLevel;
      snap.inStair = {
        stairId: occ.stairId,
        dir: occ.dir,
        progress,
        phase: occ.phase,
        toLevel: occ.toLevel,
        ...(occ.phase === 'queue' ? { queue: source } : {}),
      };
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
        ? {
            byLevel: this.metricsByLevel(snaps),
            stairQueues: this.metricsQueues(),
            stairFlights: this.getStairFlights(),
          }
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
      const body = this.personBody(x, y, r);
      body.collisionFilter = { group: 0, category: bits.ped, mask: bits.ped | bits.wall };
      const exits = this.exits.filter((e) => levelOf(e) === levelId && e.exitType !== 'service');
      const pedId = this.pedIdCounter++;
      const freeWalkMps = this.walkMps(pedId);
      const label: PedLabel = this.showcase
        ? {
            kind: 'pedestrian',
            pedId,
            freeWalkMps,
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
            pedId,
            freeWalkMps,
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
        ped.freeWalkMps ?? SHOWCASE.FREE_WALK_SPEED,
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
    const granted = this.mouthGrant.has(ped.pedId);
    const keepForward = ped.forcedCrawl === true || granted;
    this.steer(body, aim, speed, field, keepForward, granted);
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
      { flightWaits: this.flightWaits() },
    );
    if (!choice) {
      const door = this.storeyFallback(ped, pos);
      const stair = door ? null : this.stairCrawl(ped, pos);
      if (stair) {
        this.assignStair(ped, stair, count, true);
        return;
      }
      ped.targetStairId = null;
      this.assignChoice(ped, pos, door, count);
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
    this.assignStair(ped, choice, count, false);
  }

  private assignStair(ped: PedLabel, choice: RouteChoice, count: boolean, forced: boolean) {
    const wasForced = ped.forcedCrawl === true && !ped.sheltering;
    const changed = ped.targetStairId !== choice.id || ped.stairDir !== choice.dir;
    ped.targetStairId = choice.id;
    ped.stairDir = choice.dir ?? 'down';
    ped.stairToLevel = choice.toLevel;
    ped.targetExitId = '';
    ped.exitCost = choice.cost;
    ped.sheltering = false;
    ped.forcedCrawl = forced;
    if (forced) ped.posture = 'crawl';
    if (count && changed && !(wasForced && forced)) this.rerouteCount++;
  }

  private storeyRegions(level: string): RouteRegions {
    let regions = this.levelRegions.get(level);
    if (!regions) {
      regions = new RouteRegions(this.config.vertices, this.wallsByLevel.get(level) ?? []);
      this.levelRegions.set(level, regions);
    }
    return regions;
  }

  /** Doors a person on `level` at `pos` can walk to without crossing a wall. */
  private reachableDoors(level: string, pos: Vec2): ExitDef[] {
    const local = this.exits.filter(
      (e) => levelOf(e) === level && e.exitType !== 'service' && e.status !== 'blocked',
    );
    return this.storeyRegions(level).reachableExits(pos, local, this.config.vertices);
  }

  /**
   * No stair or door has a finite cost. As on a single floor (§2.6 in
   * chooseExit), smoke and fire alone do not make anyone shelter: a person
   * with a door they can reach on their own storey crawls for it. Only the
   * doors inside their walls are candidates.
   */
  private storeyFallback(ped: PedLabel, pos: Vec2): ExitChoice | null {
    const level = ped.level ?? '';
    const reach = this.reachableDoors(level, pos);
    if (reach.length === 0) return null;
    const held = reach.some((e) => e.id === ped.targetExitId) ? this.currentChoice(ped) : null;
    return chooseExit(pos, reach, this.config.vertices, this.field(ped.level), held, {
      walls: this.wallsByLevel.get(level) ?? [],
      blockedDoors: this.blockedDoorsFor(ped),
    });
  }

  /**
   * The same crawl across one stair: no door on this storey, but a stair the
   * person can reach lands next to a door on the storey beside it. It is
   * taken if the crawl is survivable: either FED, projected to the far door
   * by crawlDose, stays under DEAD_END_CRAWL_MAX_FED. A crawl over that is
   * started only when staying is projected to incapacitate (the same
   * projection, standing where they are for DEFEND_HORIZON_S, reaches 1)
   * and the crawl projects under DEAD_END_OVER_LIMIT_CAP. The stay
   * projection is used only as that lethal-or-not test, never as a dose to
   * trade against. Otherwise the person defends in place. The check runs again on
   * every route check, so a crawl that has become lethal is not started
   * late. A crawl already under way is kept until the projection reaches the
   * incapacitating dose, so nobody stops on the landing for a small rise.
   */
  private stairCrawl(ped: PedLabel, pos: Vec2): RouteChoice | null {
    if (!this.levelPlan || !ped.level) return null;
    const from = ped.level;
    const fromDef = this.levelDefs.find((l) => l.id === from);
    if (!fromDef) return null;
    const here = this.storeyRegions(from);
    const verts = this.config.vertices;
    const waits = this.flightWaits();
    let stay: number | null = null;
    const stayDose = () =>
      (stay ??= this.crawlDose(ped, [
        { levels: [from], a: pos, b: pos, holdS: LEVEL.DEFEND_HORIZON_S },
      ]));
    let best: { choice: RouteChoice; dose: number; dist: number } | null = null;
    for (const stair of this.levelPlan.stairs) {
      if (stair.blocked || (stair.kind ?? 'stair') === 'lift') continue;
      const span = linkLevels(stair, this.levelDefs);
      const at = span.indexOf(from);
      if (at < 0 || !here.connects(pos, stair.pos)) continue;
      for (const to of [span[at - 1], span[at + 1]]) {
        if (!to || Math.abs(levelIndex(to) - levelIndex(from)) !== 1) continue;
        const dir = levelIndex(to) < levelIndex(from) ? 'down' : 'up';
        // The flight is crawled, as the floor legs are, so it takes
        // 1/STAIR_CRAWL_FACTOR of the walking time on the shaft's air.
        const holdS =
          (waits.get(flightKey(stair.id, dir, from))?.floor ?? 0) +
          stairTravelS(fromDef, dir) / LEVEL.STAIR_CRAWL_FACTOR;
        const held =
          ped.forcedCrawl === true &&
          !ped.sheltering &&
          ped.targetStairId === stair.id &&
          ped.stairToLevel === to;
        const limit = held ? 1 : LEVEL.DEAD_END_CRAWL_MAX_FED;
        for (const exit of this.reachableDoors(to, stair.pos)) {
          const approach = exitApproachInside(exit, verts);
          const dose = this.crawlDose(ped, [
            { levels: [from], a: pos, b: stair.pos },
            { levels: [from, to], a: stair.pos, b: stair.pos, holdS },
            { levels: [to], a: stair.pos, b: approach },
            { levels: [to], a: approach, b: exit.center },
          ]);
          // Over the limit, a crawl is started only when staying is itself
          // projected to incapacitate, and only up to the cap. One already
          // under way keeps going while it projects lower than staying.
          const overLimitOk = held
            ? stayDose() >= 1 && dose < stayDose()
            : stayDose() >= 1 && dose < LEVEL.DEAD_END_OVER_LIMIT_CAP;
          if (!(dose < limit) && !overLimitOk) continue;
          const dist =
            Math.hypot(stair.pos.x - pos.x, stair.pos.y - pos.y) +
            Math.hypot(exit.center.x - stair.pos.x, exit.center.y - stair.pos.y);
          if (best && (dose > best.dose || (dose === best.dose && dist >= best.dist))) continue;
          best = {
            choice: { kind: 'stair', id: stair.id, cost: Infinity, dir, toLevel: to },
            dose,
            dist,
          };
        }
      }
    }
    if (!best) return null;
    if (ped.crawlProjection == null) ped.crawlProjection = best.dose;
    return best.choice;
  }

  /**
   * Every DOSE_TREND_S, each storey's dose rates per stud, kept for the last
   * DOSE_TREND_SAMPLES samples, so crawlDose can
   * carry a growing fire forward instead of freezing it at this instant.
   */
  private sampleDoseTrend() {
    if (!this.levelPlan) return;
    const last = this.trend.at(-1);
    if (last && this.elapsed + 1e-9 < last.t + LEVEL.DOSE_TREND_S) return;
    const next = new Map<string, { fed: number; heat: number }>();
    for (const [level, field] of this.hazardFields) {
      field.forEachStud((stud) => {
        const s = field.sample(stud.simPos.x, stud.simPos.y);
        next.set(`${level}:${stud.id}`, {
          fed: fedPerMin(s.fumes, s.oxygenVolumePercent, s.co2VolumePercent),
          heat: heatFedPerMin(s.headTempC, s.radiantKwM2),
        });
      });
    }
    this.trend.push({ t: this.elapsed, rates: next });
    if (this.trend.length > LEVEL.DOSE_TREND_SAMPLES) this.trend.shift();
  }

  /**
   * Per-minute dose-rate rise per second at the stud read here, never
   * negative: the least-squares slope over the trend window, so one spiky
   * sample does not swing the projection.
   */
  private doseSlope(level: string, field: HazardField, p: Vec2): { fed: number; heat: number } {
    const id = field.nearestId(p.x, p.y);
    if (!id || this.trend.length < 2) return { fed: 0, heat: 0 };
    const key = `${level}:${id}`;
    let n = 0;
    let st = 0;
    let sf = 0;
    let sh = 0;
    for (const sample of this.trend) {
      const rate = sample.rates.get(key);
      if (!rate) continue;
      n++;
      st += sample.t;
      sf += rate.fed;
      sh += rate.heat;
    }
    if (n < 2) return { fed: 0, heat: 0 };
    const tMean = st / n;
    let stt = 0;
    let stf = 0;
    let sth = 0;
    for (const sample of this.trend) {
      const rate = sample.rates.get(key);
      if (!rate) continue;
      const dt = sample.t - tMean;
      stt += dt * dt;
      stf += dt * (rate.fed - sf / n);
      sth += dt * (rate.heat - sh / n);
    }
    if (!(stt > 0)) return { fed: 0, heat: 0 };
    return { fed: Math.max(0, stf / stt), heat: Math.max(0, sth / stt) };
  }

  /**
   * The larger of the asphyxiant and heat FED this person would carry at the
   * end of `legs`, crawling. Each sample's dose rate is today's, carried
   * forward on its stud's recent rise to the time the person gets there.
   * `holdS` is time spent at `a`: the stair queue and flight, read at the
   * worse of the two storeys, since the shaft is hotter than either room.
   * The sum is then scaled by DEAD_END_DOSE_MARGIN for what the trend
   * misses: the fire accelerating, and the crowd slowing the crawl.
   */
  private crawlDose(
    ped: PedLabel,
    legs: Array<{ levels: string[]; a: Vec2; b: Vec2; holdS?: number }>,
  ): number {
    const injury = ped.injury === 'minor' ? SHOWCASE.MINOR_INJURY_SPEED_FACTOR : 1;
    const speed = walkingSpeed(0, 'crawl', SHOWCASE.SHOWCASE_PANIC, injury);
    let fed = 0;
    let heat = 0;
    let tau = 0;
    const add = (levels: string[], p: Vec2, seconds: number) => {
      const mid = tau + seconds / 2;
      let fedRate = 0;
      let heatRate = 0;
      for (const level of levels) {
        const field = this.field(level);
        const s = field.sample(p.x, p.y);
        const rise = this.doseSlope(level, field, p);
        const f = fedPerMin(s.fumes, s.oxygenVolumePercent, s.co2VolumePercent) + rise.fed * mid;
        const h = heatFedPerMin(s.headTempC, s.radiantKwM2) + rise.heat * mid;
        fedRate = Math.max(fedRate, f);
        heatRate = Math.max(heatRate, h);
      }
      fed += fedRate * (seconds / 60);
      heat += heatRate * (seconds / 60);
      tau += seconds;
    };
    for (const leg of legs) {
      if (leg.holdS) add(leg.levels, leg.a, leg.holdS);
      const len = Math.hypot(leg.b.x - leg.a.x, leg.b.y - leg.a.y);
      if (len < 1e-6) continue;
      const n = Math.max(1, Math.ceil(len / SHOWCASE.SAMPLE_STEP_M));
      for (let i = 1; i <= n; i++) {
        const t = i / n;
        add(
          leg.levels,
          { x: leg.a.x + (leg.b.x - leg.a.x) * t, y: leg.a.y + (leg.b.y - leg.a.y) * t },
          len / n / speed,
        );
      }
    }
    const margin = LEVEL.DEAD_END_DOSE_MARGIN;
    return Math.max((ped.fed ?? 0) + fed * margin, (ped.heatFed ?? 0) + heat * margin);
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

  private flightLoads(): Map<string, FlightLoad> {
    const out = new Map<string, FlightLoad>();
    const add = (occ: FlightOccupant, responder: boolean) => {
      const key = flightKey(occ.stairId, occ.dir, occ.fromLevel);
      let row = out.get(key);
      if (!row) {
        row = { floor: 0, stream: 0, moving: 0, responders: 0 };
        out.set(key, row);
      }
      if (occ.phase === 'travel') row.moving++;
      else if (occ.source === 'stream') row.stream++;
      else row.floor++;
      if (responder) row.responders++;
    };
    for (const occ of this.stairPeople) add(occ, false);
    for (const occ of this.stairResponders) add(occ, true);
    return out;
  }

  /** Waits at every flight head this step, for route costs. */
  private flightWaits(): Map<string, FlightWait> {
    if (this.flightWaitCache?.at === this.elapsed) return this.flightWaitCache.waits;
    const waits = new Map<string, FlightWait>();
    if (this.levelPlan) {
      const loads = this.flightLoads();
      const share = LEVEL.STAIR_MERGE_FLOOR_SHARE;
      for (const stair of this.levelPlan.stairs) {
        if (stair.blocked || (stair.kind ?? 'stair') === 'lift') continue;
        for (const f of stairFlights(linkLevels(stair, this.levelDefs), levelIndex)) {
          const own = loads.get(flightKey(stair.id, f.dir, f.from)) ?? NO_LOAD;
          const opp = loads.get(flightKey(stair.id, opposite(f.dir), f.to)) ?? NO_LOAD;
          const flow = flightFlowPerS(stair, demandOf(own) + 1, demandOf(opp));
          waits.set(flightKey(stair.id, f.dir, f.from), {
            floor: flightWaitS(own.floor, own.stream, share, flow),
            stream: flightWaitS(own.stream, own.floor, 1 - share, flow),
          });
        }
      }
    }
    this.flightWaitCache = { at: this.elapsed, waits };
    return waits;
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
      // On a flight the gas goes from the landing left to the landing ahead
      // in step with the walk; the shaft carries its fumes between the two.
      // The heat is the shaft column's own temperature when the effects
      // engine reports it, else the same landing blend. At a door or on a
      // landing it is that storey's stud.
      let weights: Array<{ level: string; weight: number }> | undefined;
      let columnC: number | undefined;
      if (occ.phase === 'travel') {
        columnC = this.columnTempC(occ.stairId, occ.fromLevel, occ.toLevel);
        const p = Math.min(
          1,
          Math.max(0, (this.elapsed - occ.travelStart) / Math.max(1e-6, occ.travelDuration)),
        );
        weights = [
          { level: occ.fromLevel, weight: 1 - p },
          { level: occ.toLevel, weight: p },
        ];
      }
      if (this.breathe(occ.label, stair.pos.x, stair.pos.y, dt, weights, columnC)) {
        collapsed.push(occ);
      }
    }
    for (const occ of collapsed) {
      occ.toLevel = occ.fromLevel;
      this.arriveFromStair(occ);
    }
    for (const occ of this.stairPeople) {
      if (occ.phase !== 'travel' || occ.ownMps == null) continue;
      if (occ.label.fumeHeld && !occ.fumeStretched && occ.label.posture !== 'crawl') {
        const stair = this.stairById(occ.stairId);
        const pos = stair?.pos ?? { x: 0, y: 0 };
        const slow =
          LEVEL.STAIR_CRAWL_FACTOR * this.irritantFooting(occ.label, pos.x, pos.y, occ.fromLevel);
        occ.ownMps *= slow;
        occ.fumeStretch = slow;
        occ.label.posture = 'crawl';
        occ.fumeStretched = true;
      } else if (!occ.label.fumeHeld && occ.fumeStretched) {
        occ.ownMps /= occ.fumeStretch ?? LEVEL.STAIR_CRAWL_FACTOR;
        occ.fumeStretched = false;
        occ.fumeStretch = undefined;
      }
    }
    this.repaceFlights();
    this.advanceStairs();
    this.releaseStairs(dt);
  }

  /**
   * One breath of the smoke on the nearest stud, and the heat at that head.
   * Walking speed stays on the smoke density. FEC at 1 makes them crawl
   * until the next breath under 1. The asphyxiant FED and the heat FED are
   * separate. Either one at 1 puts them down, and that stays. `weights`
   * blends the studs at (x, y) on several storeys, each dose by its weight;
   * unset means the person's own storey. `heatTempC`, with weights, replaces
   * the blended heat by convection at that gas temperature.
   */
  private breathe(
    ped: PedLabel,
    x: number,
    y: number,
    dt: number,
    weights?: ReadonlyArray<{ level: string; weight: number }>,
    heatTempC?: number,
  ): boolean {
    if (ped.state === 'down' || ped.state === 'left_map') return false;
    if (!weights) {
      const sample = this.field(ped.level).sample(x, y);
      ped.fed = advanceFed(
        ped.fed ?? 0,
        sample.fumes,
        dt,
        sample.oxygenVolumePercent,
        sample.co2VolumePercent,
      );
      ped.heatFed = advanceHeatFed(ped.heatFed ?? 0, sample.headTempC, sample.radiantKwM2, dt);
      ped.fec = fecOf(sample.fumes);
    } else {
      // Both doses grow linearly in time, so blending the increments is the
      // dose of the blended exposure.
      const fed0 = ped.fed ?? 0;
      const heat0 = ped.heatFed ?? 0;
      let fed = fed0;
      let heatFed = heat0;
      let fec = 0;
      for (const { level, weight } of weights) {
        if (!(weight > 0)) continue;
        const s = this.field(level).sample(x, y);
        fed +=
          weight *
          (advanceFed(fed0, s.fumes, dt, s.oxygenVolumePercent, s.co2VolumePercent) - fed0);
        if (heatTempC == null) {
          heatFed += weight * (advanceHeatFed(heat0, s.headTempC, s.radiantKwM2, dt) - heat0);
        }
        fec += weight * fecOf(s.fumes);
      }
      if (heatTempC != null) heatFed = advanceHeatFed(heat0, heatTempC, undefined, dt);
      ped.fed = fed;
      ped.heatFed = heatFed;
      ped.fec = fec;
    }
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
    const done: FlightOccupant[] = [];
    for (const occ of [...this.stairPeople, ...this.stairResponders]) {
      if (occ.phase !== 'travel') continue;
      if (this.elapsed - occ.travelStart + 1e-9 >= occ.travelDuration) done.push(occ);
    }
    for (const occ of done) {
      if (isPerson(occ)) this.landPerson(occ);
      else this.landResponder(occ as StairResponder);
    }
  }

  /**
   * Each flight releases at its own headway: the specific flow on the width
   * this direction has, which a reverse stream narrows. Floor and stair
   * streams waiting at the same head share the releases by
   * STAIR_MERGE_FLOOR_SHARE. Nobody steps on while the flight and the
   * landing at its foot already hold the flight's storage on that width.
   */
  private releaseStairs(dt: number) {
    if (!this.levelPlan) return;
    this.flightFull.clear();
    const all: FlightOccupant[] = [...this.stairPeople, ...this.stairResponders];
    if (all.length === 0) return;
    const loads = this.flightLoads();
    for (const stair of this.levelPlan.stairs) {
      if (stair.blocked || (stair.kind ?? 'stair') === 'lift') continue;
      for (const f of stairFlights(linkLevels(stair, this.levelDefs), levelIndex)) {
        const waiting = all
          .filter(
            (o) =>
              o.phase === 'queue' &&
              o.stairId === stair.id &&
              o.dir === f.dir &&
              o.fromLevel === f.from,
          )
          .sort((a, b) => a.enqueuedAt - b.enqueuedAt);
        if (waiting.length === 0) continue;
        const head = waiting[0];
        if (isPerson(head) && head.label.fumeHeld) head.label.posture = 'crawl';
        const key = flightKey(stair.id, f.dir, f.from);
        const own = loads.get(key) ?? NO_LOAD;
        const opp = loads.get(flightKey(stair.id, opposite(f.dir), f.to)) ?? NO_LOAD;
        const widthM = flightWidthM(stair, demandOf(own), demandOf(opp));
        const headway = 1 / flightFlowPerS(stair, demandOf(own), demandOf(opp));
        const fromDef = this.levelDefs.find((l) => l.id === f.from);
        const storage = fromDef ? flightStorage(stair, fromDef, widthM) : Infinity;
        const atFoot = loads.get(flightKey(stair.id, f.dir, f.to))?.stream ?? 0;
        let held = own.moving + atFoot;
        const floorQ = waiting.filter((o) => o.source !== 'stream');
        const streamQ = waiting.filter((o) => o.source === 'stream');
        // The headway holds across an empty queue, so a trickle of arrivals
        // is held to the same cap as a crowd. A standing queue chains on the
        // slot, not the step, so the rate stays exact.
        let last = this.stairLastRelease.get(key) ?? -Infinity;
        let credit = this.mergeCredit.get(key) ?? 0;
        while (floorQ.length + streamQ.length > 0 && this.elapsed + 1e-9 >= last + headway) {
          if (held >= storage) {
            this.flightFull.add(key);
            break;
          }
          let next: FlightOccupant;
          if (floorQ.length > 0 && streamQ.length > 0) {
            const merged = mergePick(credit, LEVEL.STAIR_MERGE_FLOOR_SHARE);
            credit = merged.credit;
            next = merged.pick === 'floor' ? floorQ.shift()! : streamQ.shift()!;
          } else {
            next = floorQ.length > 0 ? floorQ.shift()! : streamQ.shift()!;
          }
          last = Math.max(last + headway, this.elapsed - dt);
          this.beginTravel(next, widthM);
          held++;
        }
        this.stairLastRelease.set(key, last);
        this.mergeCredit.set(key, credit);
      }
    }
  }

  private beginTravel(occ: FlightOccupant, widthM: number) {
    const from = this.levelDefs.find((l) => l.id === occ.fromLevel);
    const cap = this.descentCapMps(occ, from, widthM);
    occ.phase = 'travel';
    occ.travelStart = this.elapsed;
    if (!from) {
      occ.travelDuration = 1;
      occ.ownMps = undefined;
      occ.paceMps = undefined;
      return;
    }
    const free = stairTravelS(from, occ.dir);
    const freeMps = (from.heightM * LEVEL.STAIR_TRAVEL_FACTOR) / free;
    if (!isPerson(occ)) {
      occ.ownMps = freeMps;
      occ.paceMps = Math.min(freeMps, cap);
      occ.travelDuration = free * Math.max(1, freeMps / cap);
      return;
    }
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
    const speed = Math.min(freeMps * factor, cap);
    // The irritant crawl can clear on the stair. Remember the slowdown so
    // the pace returns to what they had without it.
    occ.fumeStretched = occ.label.fumeHeld === true;
    occ.fumeStretch = occ.label.fumeHeld ? factor : undefined;
    occ.ownMps = freeMps * factor;
    occ.paceMps = speed;
    occ.travelDuration = free * (freeMps / speed);
  }

  /**
   * Most a descent can go at, m/s, from the density on the flight as this
   * person steps on (themselves included): the SFPE hydraulic speed. The
   * density is read on `widthM`, the width this direction has, so people
   * and responders climbing against it pack the descent into its lane.
   * Ascent is not capped.
   */
  private descentCapMps(occ: FlightOccupant, from: LevelDef | undefined, widthM: number): number {
    if (occ.dir !== 'down' || !from) return Infinity;
    const stair = this.stairById(occ.stairId);
    if (!stair) return Infinity;
    let on = 1;
    for (const o of [...this.stairPeople, ...this.stairResponders]) {
      if (o === occ || o.phase !== 'travel') continue;
      if (o.stairId === occ.stairId && o.dir === 'down' && o.fromLevel === occ.fromLevel) on++;
    }
    return stairDensitySpeed(on / flightAreaM2(stair, from, widthM));
  }

  /**
   * Hold everyone on a flight to the descent cap as the flight fills and
   * empties, not just at the step on: each step the pace is the lower of
   * their own and the SFPE speed at the density now on the descent's lane,
   * and the remaining time is rescaled to it. Ascent has no cap, so only a
   * change of their own pace (the irritant crawl) moves a climber.
   */
  private repaceFlights() {
    const moving = [...this.stairPeople, ...this.stairResponders].filter(
      (o) => o.phase === 'travel' && o.ownMps != null && o.paceMps != null,
    );
    if (moving.length === 0) return;
    const descending = new Map<string, number>();
    for (const o of moving) {
      if (o.dir !== 'down') continue;
      const key = flightKey(o.stairId, 'down', o.fromLevel);
      descending.set(key, (descending.get(key) ?? 0) + 1);
    }
    const loads = descending.size > 0 ? this.flightLoads() : null;
    const caps = new Map<string, number>();
    for (const o of moving) {
      let cap = Infinity;
      if (o.dir === 'down' && loads) {
        const key = flightKey(o.stairId, 'down', o.fromLevel);
        const known = caps.get(key);
        if (known != null) cap = known;
        else {
          const stair = this.stairById(o.stairId);
          const from = this.levelDefs.find((l) => l.id === o.fromLevel);
          if (stair && from) {
            const own = loads.get(key) ?? NO_LOAD;
            const opp = loads.get(flightKey(o.stairId, 'up', o.toLevel)) ?? NO_LOAD;
            const widthM = flightWidthM(stair, demandOf(own), demandOf(opp));
            cap = stairDensitySpeed((descending.get(key) ?? 1) / flightAreaM2(stair, from, widthM));
          }
          caps.set(key, cap);
        }
      }
      const pace = Math.min(o.ownMps!, cap);
      if (pace === o.paceMps) continue;
      const done = Math.min(o.travelDuration, Math.max(0, this.elapsed - o.travelStart));
      const remain = Math.max(0, o.travelDuration - done);
      o.travelDuration = done + remain * (o.paceMps! / pace);
      o.paceMps = pace;
    }
  }

  /** The storey after `level` on this stair going `dir`, if the stair goes on. */
  private nextOnStair(stair: Stairwell, level: string, dir: 'up' | 'down'): string | null {
    const want = levelIndex(level) + (dir === 'down' ? -1 : 1);
    return linkLevels(stair, this.levelDefs).find((id) => levelIndex(id) === want) ?? null;
  }

  /**
   * End of a flight. Someone whose route still runs on down (or up) the same
   * stair stays in it and joins the landing's stair stream for the next
   * flight. Anyone else steps off onto the storey.
   */
  private landPerson(occ: StairOccupant) {
    const next = this.continueOnStair(occ);
    if (!next) {
      this.arriveFromStair(occ);
      return;
    }
    occ.fromLevel = occ.toLevel;
    occ.toLevel = next;
    occ.phase = 'queue';
    occ.source = 'stream';
    occ.enqueuedAt = this.elapsed;
    occ.travelStart = this.elapsed;
    occ.travelDuration = 1;
    occ.fumeStretched = false;
    occ.fumeStretch = undefined;
    occ.label.level = occ.fromLevel;
    occ.label.stairToLevel = next;
  }

  private continueOnStair(occ: StairOccupant): string | null {
    const ped = occ.label;
    if (!this.levelPlan || ped.forcedCrawl || ped.state === 'down') return null;
    const stair = this.stairById(occ.stairId);
    if (!stair || stair.blocked) return null;
    const next = this.nextOnStair(stair, occ.toLevel, occ.dir);
    if (!next) return null;
    const choice = chooseRoute(
      stair.pos,
      occ.toLevel,
      this.exits,
      this.levelPlan.stairs,
      this.levelDefs,
      this.hazardFields,
      this.config.vertices,
      this.queueLengths(),
      { id: stair.id, cost: ped.exitCost ?? Infinity },
      this.blockedDoorsByLevel,
      this.wallsByLevel,
      { flightWaits: this.flightWaits(), entry: 'stream' },
    );
    if (
      choice?.kind !== 'stair' ||
      choice.id !== stair.id ||
      choice.dir !== occ.dir ||
      choice.toLevel !== next
    ) {
      return null;
    }
    ped.exitCost = choice.cost;
    return next;
  }

  private landResponder(occ: StairResponder) {
    const stair = this.stairById(occ.stairId);
    const next =
      stair && occ.toLevel !== occ.finalLevel
        ? this.nextOnStair(stair, occ.toLevel, occ.dir)
        : null;
    if (!next) {
      this.stairResponders = this.stairResponders.filter((r) => r !== occ);
      this.responderArrivals.push({ id: occ.id, level: occ.toLevel, atS: this.elapsed });
      return;
    }
    occ.fromLevel = occ.toLevel;
    occ.toLevel = next;
    occ.phase = 'queue';
    occ.source = 'stream';
    occ.enqueuedAt = this.elapsed;
    occ.travelStart = this.elapsed;
    occ.travelDuration = 1;
  }

  /**
   * Shaft column temperatures from the effects engine
   * (`SpatialEffectsEngine.shaftColumns()`). A flight with a column breathes
   * its heat; one without keeps the landing blend.
   */
  setShaftColumns(
    columns: ReadonlyArray<{
      linkId: string;
      lowerLevel: string;
      upperLevel: string;
      tempK: number;
    }>,
  ) {
    this.shaftColumnK.clear();
    for (const c of columns) {
      this.shaftColumnK.set(`${c.linkId}|${c.lowerLevel}|${c.upperLevel}`, c.tempK);
    }
  }

  private columnTempC(stairId: string, a: string, b: string): number | undefined {
    const [lower, upper] = levelIndex(a) < levelIndex(b) ? [a, b] : [b, a];
    const k = this.shaftColumnK.get(`${stairId}|${lower}|${upper}`);
    return k == null ? undefined : k - 273.15;
  }

  /**
   * Send responders along a stair, from one storey to another, as RTS crews
   * climbing against the crowd. They queue at the door of `fromLevel` and
   * walk every flight to `toLevel`. Defaults: the lowest storey the stair
   * serves to its highest. Returns the responder ids, empty when the stair
   * cannot be used.
   */
  sendStairResponders(
    stairId: string,
    count: number,
    opts: { fromLevel?: string; toLevel?: string; idPrefix?: string } = {},
  ): string[] {
    const stair = this.stairById(stairId);
    if (!stair || stair.blocked || (stair.kind ?? 'stair') === 'lift') return [];
    const span = linkLevels(stair, this.levelDefs);
    const from = opts.fromLevel ?? span[0];
    const to = opts.toLevel ?? span[span.length - 1];
    if (!span.includes(from) || !span.includes(to) || from === to) return [];
    const dir: 'up' | 'down' = levelIndex(to) > levelIndex(from) ? 'up' : 'down';
    const first = this.nextOnStair(stair, from, dir);
    if (!first) return [];
    const ids: string[] = [];
    const prefix = opts.idPrefix ?? `responder-${stairId}`;
    for (let i = 0; i < count; i++) {
      const id = `${prefix}-${this.stairResponders.length + this.responderArrivals.length + 1}`;
      ids.push(id);
      this.stairResponders.push({
        id,
        stairId,
        dir,
        fromLevel: from,
        toLevel: first,
        finalLevel: to,
        phase: 'queue',
        source: 'floor',
        enqueuedAt: this.elapsed + i * 1e-6,
        travelStart: this.elapsed,
        travelDuration: 1,
      });
    }
    return ids;
  }

  /** Responders who have reached their storey, in arrival order. */
  getResponderArrivals(): ReadonlyArray<{ id: string; level: string; atS: number }> {
    return this.responderArrivals;
  }

  /** Every flight with someone on it or waiting for it. */
  getStairFlights(): StairFlightView[] {
    if (!this.levelPlan) return [];
    const loads = this.flightLoads();
    const out: StairFlightView[] = [];
    for (const stair of this.levelPlan.stairs) {
      if (stair.blocked || (stair.kind ?? 'stair') === 'lift') continue;
      for (const f of stairFlights(linkLevels(stair, this.levelDefs), levelIndex)) {
        const key = flightKey(stair.id, f.dir, f.from);
        const own = loads.get(key);
        if (!own) continue;
        const opp = loads.get(flightKey(stair.id, opposite(f.dir), f.to)) ?? NO_LOAD;
        const fromDef = this.levelDefs.find((l) => l.id === f.from);
        out.push({
          stairId: stair.id,
          dir: f.dir,
          fromLevel: f.from,
          toLevel: f.to,
          door: own.floor,
          landing: own.stream,
          moving: own.moving,
          responders: own.responders,
          flowPerS: flightFlowPerS(stair, demandOf(own), demandOf(opp)),
          storage: fromDef
            ? flightStorage(stair, fromDef, flightWidthM(stair, demandOf(own), demandOf(opp)))
            : 0,
          counterflow: demandOf(opp) > 0,
          full: this.flightFull.has(key),
        });
      }
    }
    return out;
  }

  /**
   * Where a queued person stands. The door queue packs outward from the
   * stair on the floor, nearest first, on places the person could reach
   * from the stair; the stair stream stands close round the stair point.
   */
  private queuePlace(stair: Stairwell, level: string, source: StairSource, rank: number): Vec2 {
    if (source === 'stream') {
      const r = Math.min(0.45, 0.15 + 0.08 * Math.sqrt(rank));
      const a = rank * 2.39996;
      return { x: stair.pos.x + Math.cos(a) * r, y: stair.pos.y + Math.sin(a) * r };
    }
    const slots = this.floorQueueSlots(stair, level);
    return slots[rank] ?? slots[slots.length - 1] ?? stair.pos;
  }

  private floorQueueSlots(stair: Stairwell, level: string): Vec2[] {
    const key = `${stair.id}:${level}`;
    const cached = this.queueSlots.get(key);
    if (cached) return cached;
    const regions = this.storeyRegions(level);
    const spacing = QUEUE_SPACING_M;
    const rowH = (spacing * Math.sqrt(3)) / 2;
    const reach = QUEUE_REACH_M;
    const out: Array<{ p: Vec2; d: number }> = [];
    for (let row = -Math.ceil(reach / rowH); row <= Math.ceil(reach / rowH); row++) {
      const y = stair.pos.y + row * rowH;
      const shift = row % 2 === 0 ? 0 : spacing / 2;
      for (let col = -Math.ceil(reach / spacing); col <= Math.ceil(reach / spacing); col++) {
        const x = stair.pos.x + col * spacing + shift;
        const d = Math.hypot(x - stair.pos.x, y - stair.pos.y);
        if (d < QUEUE_CLEAR_M || d > reach) continue;
        if (!isInsidePolygon(x, y, this.config.vertices)) continue;
        if (!regions.connects(stair.pos, { x, y })) continue;
        out.push({ p: { x, y }, d });
      }
    }
    out.sort((a, b) => a.d - b.d);
    const slots = out.map((o) => o.p);
    this.queueSlots.set(key, slots);
    return slots;
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
    const body = this.personBody(x, y, r);
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
        source: 'floor',
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
