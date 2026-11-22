import Matter from 'matter-js';
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
  doorSqueeze,
  exitGapSlot,
  exitRouteHazardous,
  extinctionK,
  mulberry32,
  steerToTarget,
  nextPosture,
  outdoorSpeed,
  samplePremovementS,
  routeAroundOutline,
  walkedRouteHazard,
  smokeAheadAction,
  walkingSpeed,
  type ExitChoice,
  type Familiarity,
  type Posture,
} from './hazardSensing';
import { SHOWCASE } from './showcaseConstants';
import { blastInjuryBand } from './showcase';

export type { Posture } from './hazardSensing';

const WALL_THICKNESS = 0.8;
const PED_CATEGORY = 0x0001;
const WALL_CATEGORY = 0x0002;

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
  zoneId?: string | null;
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
  minorInjured: number;
  reroutes: number;
  /** Set when every zone was unsafe and people were sent to the farthest one. */
  unsafeZoneNote?: string | null;
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
  reactAt?: number;
  exitCost?: number;
  nextCheckAt?: number;
  waypoints?: Vec2[];
  zoneId?: string | null;
  wanderTarget?: Vec2 | null;
  wanderUntil?: number;
  spawn?: Vec2;
  smokeRollDone?: boolean;
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
  exitUsed?: Vec2 | null;
  jitterTarget?: Vec2 | null;
  jitterUntil?: number;
  disperse?: boolean;
  lastDir?: Vec2 | null;
}

export interface ObstaclePoint {
  x: number;
  y: number;
  radius: number;
}

export interface InteriorWallDef {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  hasDoor: boolean;
  doorWidth: number;
  doorPosition: number;
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
  private zones: ShowcaseZone[] = [];
  private blast: { site: Vec2; radius: number } | null = null;
  private turnedBackCount = 0;
  private rerouteCount = 0;
  private unsafeZoneNote: string | null = null;
  private leftMapCount = 0;
  private arrivedCounts = new Map<string, number>();
  private buildingHeightM: number = SHOWCASE.BUILDING_STOREY_HEIGHT_M;

  constructor(
    config: PolygonSimConfig,
    exits: ExitDef[],
    interiorWalls?: InteriorWallDef[],
    obstacles?: ObstaclePoint[],
    showcase?: EvacShowcaseOptions,
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

    this.buildWalls();
    if (interiorWalls) this.buildInteriorWalls(interiorWalls);
    this.spawnPedestrians();
  }

  private buildWalls() {
    const { vertices } = this.config;
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
      const edgeExits = this.exits
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
        });
        body.collisionFilter = { group: 0, category: WALL_CATEGORY, mask: PED_CATEGORY };
        body.restitution = 0.1;
        body.friction = 0.05;
        this.wallBodies.push(body);
      }
    }

    Matter.Composite.add(this.engine.world, this.wallBodies);
  }

  private buildInteriorWalls(walls: InteriorWallDef[]) {
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
          const body = Matter.Bodies.rectangle(mx, my, seg1Len, t, { isStatic: true, angle });
          body.collisionFilter = { group: 0, category: WALL_CATEGORY, mask: PED_CATEGORY };
          body.restitution = 0.1;
          interiorBodies.push(body);
        }
        if (seg2Len > 0.1) {
          const mid2 = seg2Start + seg2Len / 2;
          const mx = wall.startX + (dx / len) * mid2;
          const my = wall.startY + (dy / len) * mid2;
          const body = Matter.Bodies.rectangle(mx, my, seg2Len, t, { isStatic: true, angle });
          body.collisionFilter = { group: 0, category: WALL_CATEGORY, mask: PED_CATEGORY };
          body.restitution = 0.1;
          interiorBodies.push(body);
        }
      } else {
        const mx = (wall.startX + wall.endX) / 2;
        const my = (wall.startY + wall.endY) / 2;
        const body = Matter.Bodies.rectangle(mx, my, len, t, { isStatic: true, angle });
        body.collisionFilter = { group: 0, category: WALL_CATEGORY, mask: PED_CATEGORY };
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
    if (this.showcase) {
      this.stepShowcase();
      return;
    }
    const { dt, desiredSpeed, panicFactor } = this.config;
    const targetSpeed = desiredSpeed * (1 + panicFactor * 0.6);
    const tau = 0.4;

    for (const body of this.pedestrians) {
      const ped: PedLabel = (body as any).__ped;
      if (ped.evacuated) continue;

      const exit = this.exits.find((e) => e.id === ped.targetExitId);
      if (!exit) continue;

      const dx = exit.center.x - body.position.x;
      const dy = exit.center.y - body.position.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist < 0.01) continue;

      const nx = dx / dist;
      const ny = dy / dist;

      const vDesX = nx * targetSpeed * dt;
      const vDesY = ny * targetSpeed * dt;

      // Repulsion from obstacles (hazards, casualties)
      let repX = 0;
      let repY = 0;
      for (const obs of this.obstacles) {
        const odx = body.position.x - obs.x;
        const ody = body.position.y - obs.y;
        const oDist = Math.hypot(odx, ody);
        if (oDist < obs.radius && oDist > 0.01) {
          const strength = ((obs.radius - oDist) / obs.radius) * targetSpeed * dt * 2;
          repX += (odx / oDist) * strength;
          repY += (ody / oDist) * strength;
        }
      }

      const blend = Math.min(1, dt / tau);
      const newVx = body.velocity.x + (vDesX + repX - body.velocity.x) * blend;
      const newVy = body.velocity.y + (vDesY + repY - body.velocity.y) * blend;

      Matter.Body.setVelocity(body, { x: newVx, y: newVy });

      const currentSpeed = Math.sqrt(body.velocity.x ** 2 + body.velocity.y ** 2);
      const maxSpeed = targetSpeed * dt * 1.3;
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
    if (exit) {
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
    if (!this.showcase) return;
    this.hazardField = field;
  }

  setInteriorWalls(walls: InteriorWallDef[]) {
    if (!this.showcase) return;
    this.interiorWalls = walls.map((w) => ({ ...w }));
  }

  syncExits(exits: ExitDef[]) {
    if (!this.showcase) return;
    for (const incoming of exits) {
      const cur = this.exits.find((e) => e.id === incoming.id);
      if (cur) cur.status = incoming.status;
    }
  }

  setZones(zones: ShowcaseZone[]) {
    if (!this.showcase) return;
    this.zones = zones.map((z) => ({ ...z, pos: { ...z.pos } }));
  }

  /** Illustrative blast. A second call does nothing. */
  triggerBlast(site: Vec2, radius: number) {
    if (!this.showcase || this.blast) return;
    this.blast = { site: { x: site.x, y: site.y }, radius };
    const dt = this.config.dt;
    for (const body of this.pedestrians) {
      const ped = this.pedOf(body);
      if (ped.state === 'down' || ped.state === 'left_map' || ped.state === 'arrived') continue;
      const dx = body.position.x - site.x;
      const dy = body.position.y - site.y;
      const dist = Math.hypot(dx, dy);
      const band = blastInjuryBand(dist, radius);
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
      ped.state = 'reacting';
      ped.reactAt = this.elapsed + samplePremovementS(this.rng!);
    }
  }

  private pedOf(body: Matter.Body): PedLabel {
    return (body as Matter.Body & { __ped: PedLabel }).__ped;
  }

  private field(): HazardField {
    if (!this.hazardField) this.hazardField = new HazardField([]);
    return this.hazardField;
  }

  private stepShowcase() {
    const dt = this.config.dt;
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
        this.stepEvacuating(body, ped);
        continue;
      }
      if (ped.state === 'outside') {
        this.stepOutside(body, ped, this.localDensity(outside, body.position.x, body.position.y, ped.pedId));
      }
    }

    Matter.Engine.update(this.engine, dt * 1000);
    this.unstickFromWalls();
    this.releaseExitJams();
    this.releaseDoorJams();

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

    this.elapsed += dt;
  }

  private posOf(body: Matter.Body): Vec2 {
    return { x: body.position.x, y: body.position.y };
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
    const pos = this.posOf(body);
    const field = this.field();
    const sample = field.sample(pos.x, pos.y);
    const fam = ped.familiarity ?? 'visitor';
    if (!ped.forcedCrawl && !ped.sheltering) {
      ped.posture = nextPosture(ped.posture ?? 'stand', sample.smoke, fam);
    } else {
      ped.posture = 'crawl';
    }
    const injuryFactor = ped.injury === 'minor' ? SHOWCASE.MINOR_INJURY_SPEED_FACTOR : 1;
    const speed = walkingSpeed(extinctionK(sample.smoke), ped.posture ?? 'stand', SHOWCASE.SHOWCASE_PANIC, injuryFactor);

    const exit = this.exits.find((e) => e.id === ped.targetExitId);
    const provisional = ped.sheltering && ped.shelterTarget
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
      };
      if (burningAhead) {
        const alt = chooseExit(pos, this.exits, this.config.vertices, field, this.currentChoice(ped), exitOpts);
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
            const alt = chooseExit(pos, this.exits, this.config.vertices, field, this.currentChoice(ped), {
              ...exitOpts,
              ignoreHysteresis: true,
            });
            this.assignChoice(ped, pos, alt, false);
            this.noteAvoid(ped, fromId, true);
          }
        }
        if (!turned) {
          const alt = chooseExit(pos, this.exits, this.config.vertices, field, this.currentChoice(ped), exitOpts);
          const altCost = alt && !alt.forced ? alt.cost : null;
          if (smokeAheadAction(ka, ped.exitCost ?? Infinity, altCost) === 'switch' && alt) {
            this.assignChoice(ped, pos, alt, true);
            if (ped.targetExitId !== fromId) this.noteAvoid(ped, fromId);
          }
        }
      }
    }

    if (this.elapsed + 1e-9 >= (ped.nextCheckAt ?? 0)) {
      this.pruneAvoid(ped, pos);
      const choice = chooseExit(
        pos,
        this.exits,
        this.config.vertices,
        field,
        ped.targetExitId ? this.currentChoice(ped) : null,
        { avoidIds: ped.avoidExitIds, walls: this.interiorWalls },
      );
      ped.nextCheckAt = this.elapsed + SHOWCASE.REROUTE_CHECK_S;
      this.assignChoice(ped, pos, choice, true);
    }

    if (ped.sheltering) {
      ped.shelterTarget = field.lowestKWithin(pos.x, pos.y, 6) ?? ped.shelterTarget ?? null;
      ped.posture = 'crawl';
    }

    const liveExit = this.exits.find((e) => e.id === ped.targetExitId);
    const target =
      ped.sheltering && ped.shelterTarget
        ? steerToTarget(pos, ped.shelterTarget, this.interiorWalls)
        : liveExit
          ? this.exitSteerTarget(pos, liveExit)
          : provisional;
    this.steer(body, target, speed, field);
  }

  /**
   * A crowd pressed into a narrow opening locks solid. Move the person
   * nearest the outside of each exit just past the line, once the jam has
   * actually stopped them, so the opening can drain.
   */
  private releaseExitJams() {
    const best = new Map<string, { body: Matter.Body; gap: NonNullable<ReturnType<typeof exitGapSlot>> }>();
    for (const body of this.pedestrians) {
      const ped = this.pedOf(body);
      if (ped.state !== 'evacuating' || !ped.targetExitId) continue;
      const speed = Math.hypot(body.velocity.x, body.velocity.y) / this.config.dt;
      if (speed > 0.45) continue;
      const pos = this.posOf(body);
      const exit = this.exits.find((e) => e.id === ped.targetExitId);
      if (!exit) continue;
      const gap = exitGapSlot(pos, exit, this.config.vertices);
      if (!gap || gap.planeDist > 0.95 || gap.planeDist < -0.2) continue;
      if (gap.clamped) {
        const lx = pos.x - gap.slot.x - gap.inward.x * gap.planeDist;
        const ly = pos.y - gap.slot.y - gap.inward.y * gap.planeDist;
        if (Math.hypot(lx, ly) > 0.45) continue;
      }
      const prev = best.get(exit.id);
      if (!prev || gap.planeDist < prev.gap.planeDist) best.set(exit.id, { body, gap });
    }
    for (const { body, gap } of best.values()) {
      Matter.Body.setPosition(body, {
        x: gap.slot.x - gap.inward.x * 0.35,
        y: gap.slot.y - gap.inward.y * 0.35,
      });
      Matter.Body.setVelocity(body, { x: 0, y: 0 });
    }
  }

  /** Bodies left overlapping a wall cannot slide. Ease them clear of the solid parts. */
  private unstickFromWalls() {
    for (const body of this.pedestrians) {
      const ped = this.pedOf(body);
      if (ped.state !== 'evacuating') continue;
      const speed = Math.hypot(body.velocity.x, body.velocity.y) / this.config.dt;
      if (speed > 0.2) continue;
      let pos = this.posOf(body);
      for (const wall of this.interiorWalls) {
        const dx = wall.endX - wall.startX;
        const dy = wall.endY - wall.startY;
        const len = Math.hypot(dx, dy) || 1;
        const ux = dx / len;
        const uy = dy / len;
        const along = (pos.x - wall.startX) * ux + (pos.y - wall.startY) * uy;
        if (along < -0.2 || along > len + 0.2) continue;
        if (wall.hasDoor) {
          const centre = wall.doorPosition * len;
          const half = wall.doorWidth / 2;
          if (along > centre - half - 0.15 && along < centre + half + 0.15) continue;
        }
        const t = Math.max(0, Math.min(len, along));
        const cx = wall.startX + ux * t;
        const cy = wall.startY + uy * t;
        const ox = pos.x - cx;
        const oy = pos.y - cy;
        const d = Math.hypot(ox, oy);
        if (d > 0.55 || d < 1e-4) continue;
        const nx = ox / d;
        const ny = oy / d;
        pos = { x: pos.x + nx * (0.7 - d), y: pos.y + ny * (0.7 - d) };
        Matter.Body.setPosition(body, pos);
        Matter.Body.setVelocity(body, { x: 0, y: 0 });
      }
    }
  }

  /** Same release for an interior door: the stopped person nearest the gap steps through. */
  private releaseDoorJams() {
    for (const wall of this.interiorWalls) {
      if (!wall.hasDoor) continue;
      let pick: { body: Matter.Body; at: Vec2; dist: number } | null = null;
      for (const body of this.pedestrians) {
        const ped = this.pedOf(body);
        if (ped.state !== 'evacuating' || !ped.targetExitId) continue;
        const speed = Math.hypot(body.velocity.x, body.velocity.y) / this.config.dt;
        if (speed > 0.45) continue;
        const pos = this.posOf(body);
        const exit = this.exits.find((e) => e.id === ped.targetExitId);
        if (!exit) continue;
        const at = doorSqueeze(pos, wall, exit.center);
        if (!at) continue;
        const dist = Math.hypot(pos.x - at.x, pos.y - at.y);
        if (!pick || dist < pick.dist) pick = { body, at, dist };
      }
      if (!pick) continue;
      Matter.Body.setPosition(pick.body, pick.at);
      Matter.Body.setVelocity(pick.body, { x: 0, y: 0 });
    }
  }

  /**
   * Line up on the nearest point of the opening, on this side of the wall,
   * and walk through once in the mouth. Interior doors on the way use the
   * same slot, so people don't all steer at one centre.
   */
  private exitSteerTarget(pos: Vec2, exit: ExitDef): Vec2 {
    const verts = this.config.vertices;
    const gap = exitGapSlot(pos, exit, verts);
    if (!gap) {
      return steerToTarget(pos, exitApproachInside(exit, verts), this.interiorWalls);
    }
    const goal =
      !gap.clamped && gap.planeDist < 1.05 && gap.planeDist > -0.4
        ? {
            x: gap.slot.x - gap.inward.x * 1.5,
            y: gap.slot.y - gap.inward.y * 1.5,
          }
        : {
            x: gap.slot.x + gap.inward.x * 0.7,
            y: gap.slot.y + gap.inward.y * 0.7,
          };
    return steerToTarget(pos, goal, this.interiorWalls);
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
    const field = this.field();
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

  private pickInitialExit(pos: Vec2): ExitChoice | null {
    return chooseExit(pos, this.exits, this.config.vertices, this.field(), null, {
      walls: this.interiorWalls,
    });
  }

  private assignChoice(ped: PedLabel, pos: Vec2, choice: ExitChoice | null, count: boolean) {
    if (!choice) {
      const changed = !ped.sheltering;
      ped.sheltering = true;
      ped.forcedCrawl = true;
      ped.posture = 'crawl';
      ped.shelterTarget = this.field().lowestKWithin(pos.x, pos.y, 6) ?? ped.shelterTarget ?? null;
      if (count && changed) this.rerouteCount++;
      return;
    }
    const changed = choice.id !== ped.targetExitId;
    ped.targetExitId = choice.id;
    ped.exitCost = choice.cost;
    ped.sheltering = false;
    ped.forcedCrawl = choice.forced;
    if (choice.forced) ped.posture = 'crawl';
    if (count && changed) this.rerouteCount++;
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
      this.unsafeZoneNote =
        'All assembly zones are unsafe; using the one farthest from the blast.';
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
      if (d <= SHOWCASE.ZONE_UNSAFE_FACTOR * this.blast.radius) return false;
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

  private steer(body: Matter.Body, target: Vec2, targetSpeed: number, fireField: HazardField | null) {
    const dt = this.config.dt;
    const dx = target.x - body.position.x;
    const dy = target.y - body.position.y;
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
      const odx = body.position.x - obs.x;
      const ody = body.position.y - obs.y;
      const oDist = Math.hypot(odx, ody);
      if (oDist < obs.radius && oDist > 0.01) {
        const strength = ((obs.radius - oDist) / obs.radius) * targetSpeed * dt * 2;
        repX += (odx / oDist) * strength;
        repY += (ody / oDist) * strength;
      }
    }
    if (fireField) {
      for (const f of fireField.firesNear(body.position.x, body.position.y, SHOWCASE.FIRE_AVOID_RADIUS_M)) {
        const r = f.state === 'burning' ? SHOWCASE.FIRE_AVOID_RADIUS_M : SHOWCASE.HEAT_AVOID_RADIUS_M;
        const odx = body.position.x - f.pos.x;
        const ody = body.position.y - f.pos.y;
        const oDist = Math.hypot(odx, ody);
        if (oDist < r && oDist > 0.01) {
          const strength = ((r - oDist) / r) * targetSpeed * dt * 2;
          repX += (odx / oDist) * strength;
          repY += (ody / oDist) * strength;
        }
      }
    }
    const blend = Math.min(1, dt / 0.4);
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
    return this.pedestrians.map((body) => {
      const ped: PedLabel = (body as any).__ped;
      const snap: PedSnapshot = {
        id: ped.pedId,
        x: body.position.x,
        y: body.position.y,
        vx: body.velocity.x,
        vy: body.velocity.y,
        speed: Math.sqrt(body.velocity.x ** 2 + body.velocity.y ** 2) / this.config.dt,
        evacuated: ped.evacuated,
      };
      if (ped.state) {
        snap.state = ped.state;
        snap.posture = ped.posture;
        snap.familiarity = ped.familiarity;
        snap.injury = ped.injury;
        snap.zoneId = ped.zoneId ?? null;
      }
      return snap;
    });
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
    for (const s of snaps) {
      if (s.state === 'idle') idle++;
      else if (s.state === 'reacting') reacting++;
      else if (s.state === 'evacuating') evacuating++;
      else if (s.state === 'outside') outside++;
      if (s.state === 'evacuating' && s.posture === 'crouch') crouching++;
      if (s.state === 'evacuating' && s.posture === 'crawl') crawling++;
      if (s.injury === 'minor') minorInjured++;
      if (s.state === 'down' && s.injury === 'lethal') lethal++;
      if (s.state === 'down' && s.injury === 'serious') serious++;
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
      minorInjured,
      reroutes: this.rerouteCount,
      unsafeZoneNote: this.unsafeZoneNote,
    };
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
