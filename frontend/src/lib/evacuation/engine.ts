import Matter from 'matter-js';
import type { ExitDef, PolygonSimConfig, Vec2 } from './types';
import { isInsidePolygon, polygonBounds } from './geometry';

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
}

export interface EvacMetrics {
  elapsed: number;
  totalPedestrians: number;
  evacuated: number;
  remaining: number;
  avgSpeed: number;
  exitFlows: { exitId: string; count: number }[];
}

interface PedLabel {
  kind: 'pedestrian';
  pedId: number;
  evacuated: boolean;
  targetExitId: string;
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

  constructor(config: PolygonSimConfig, exits: ExitDef[]) {
    this.config = config;
    this.exits = exits;

    this.engine = Matter.Engine.create({
      gravity: { x: 0, y: 0, scale: 1 },
    });
    this.engine.timing.timeScale = 1;

    this.buildWalls();
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

  private spawnPedestrians() {
    const { vertices, pedestrianCount, pedestrianRadius: r } = this.config;
    const bounds = polygonBounds(vertices);
    const margin = r * 2;

    let spawned = 0;
    let attempts = 0;
    const maxAttempts = pedestrianCount * 50;

    while (spawned < pedestrianCount && attempts < maxAttempts) {
      attempts++;
      const x = bounds.minX + margin + Math.random() * (bounds.width - 2 * margin);
      const y = bounds.minY + margin + Math.random() * (bounds.height - 2 * margin);

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

      const pedLabel: PedLabel = {
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
    let best = this.exits[0]?.id ?? '';
    let bestDist = Infinity;
    for (const e of this.exits) {
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

      const blend = Math.min(1, dt / tau);
      const newVx = body.velocity.x + (vDesX - body.velocity.x) * blend;
      const newVy = body.velocity.y + (vDesY - body.velocity.y) * blend;

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

  getSnapshots(): PedSnapshot[] {
    return this.pedestrians.map((body) => {
      const ped: PedLabel = (body as any).__ped;
      return {
        id: ped.pedId,
        x: body.position.x,
        y: body.position.y,
        vx: body.velocity.x,
        vy: body.velocity.y,
        speed: Math.sqrt(body.velocity.x ** 2 + body.velocity.y ** 2) / this.config.dt,
        evacuated: ped.evacuated,
      };
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

    return {
      elapsed: this.elapsed,
      totalPedestrians: snaps.length,
      evacuated,
      remaining: active.length,
      avgSpeed,
      exitFlows,
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
