import Matter from 'matter-js';
import type { ExitDef, SimConfig } from './types';

const WALL_THICKNESS = 1.0;
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

interface WallGap {
  exitId: string;
  wallSide: 'top' | 'bottom' | 'left' | 'right';
  gapStart: number;
  gapEnd: number;
}

export class EvacuationEngine {
  private engine: Matter.Engine;
  private pedestrians: Matter.Body[] = [];
  private wallBodies: Matter.Body[] = [];
  private exits: ExitDef[] = [];
  private config: SimConfig;
  private elapsed = 0;
  private exitCounts = new Map<string, number>();
  private pedIdCounter = 0;

  constructor(config: SimConfig, exits: ExitDef[]) {
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
    const { roomWidth: w, roomHeight: h } = this.config;
    const t = WALL_THICKNESS;

    const gaps = this.computeGaps();

    const sides: {
      side: 'top' | 'bottom' | 'left' | 'right';
      horizontal: boolean;
      fixedCoord: number;
      spanMin: number;
      spanMax: number;
    }[] = [
      { side: 'top', horizontal: true, fixedCoord: 0, spanMin: 0, spanMax: w },
      { side: 'bottom', horizontal: true, fixedCoord: h, spanMin: 0, spanMax: w },
      { side: 'left', horizontal: false, fixedCoord: 0, spanMin: 0, spanMax: h },
      { side: 'right', horizontal: false, fixedCoord: w, spanMin: 0, spanMax: h },
    ];

    for (const s of sides) {
      const sideGaps = gaps
        .filter((g) => g.wallSide === s.side)
        .sort((a, b) => a.gapStart - b.gapStart);

      const segments: { start: number; end: number }[] = [];
      let cursor = s.spanMin;

      for (const g of sideGaps) {
        if (g.gapStart > cursor) {
          segments.push({ start: cursor, end: g.gapStart });
        }
        cursor = Math.max(cursor, g.gapEnd);
      }
      if (cursor < s.spanMax) {
        segments.push({ start: cursor, end: s.spanMax });
      }

      for (const seg of segments) {
        const len = seg.end - seg.start;
        if (len < 0.01) continue;
        const mid = (seg.start + seg.end) / 2;

        let body: Matter.Body;
        if (s.horizontal) {
          body = Matter.Bodies.rectangle(mid, s.fixedCoord, len, t, { isStatic: true });
        } else {
          body = Matter.Bodies.rectangle(s.fixedCoord, mid, t, len, { isStatic: true });
        }
        body.collisionFilter = { group: 0, category: WALL_CATEGORY, mask: PED_CATEGORY };
        body.restitution = 0.1;
        body.friction = 0.05;
        this.wallBodies.push(body);
      }
    }

    Matter.Composite.add(this.engine.world, this.wallBodies);
  }

  private computeGaps(): WallGap[] {
    const { roomWidth: w, roomHeight: h } = this.config;
    const result: WallGap[] = [];

    for (const exit of this.exits) {
      const half = exit.width / 2;
      const cx = exit.center.x;
      const cy = exit.center.y;
      const tolerance = 0.5;

      if (cy <= tolerance) {
        result.push({ exitId: exit.id, wallSide: 'top', gapStart: cx - half, gapEnd: cx + half });
      } else if (cy >= h - tolerance) {
        result.push({
          exitId: exit.id,
          wallSide: 'bottom',
          gapStart: cx - half,
          gapEnd: cx + half,
        });
      } else if (cx <= tolerance) {
        result.push({ exitId: exit.id, wallSide: 'left', gapStart: cy - half, gapEnd: cy + half });
      } else if (cx >= w - tolerance) {
        result.push({ exitId: exit.id, wallSide: 'right', gapStart: cy - half, gapEnd: cy + half });
      }
    }
    return result;
  }

  private spawnPedestrians() {
    const { roomWidth: w, roomHeight: h, pedestrianCount, pedestrianRadius: r } = this.config;
    const margin = WALL_THICKNESS + r * 3;

    for (let i = 0; i < pedestrianCount; i++) {
      const x = margin + Math.random() * (w - 2 * margin);
      const y = margin + Math.random() * (h - 2 * margin);

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
    const tau = 0.4; // relaxation time — lower = snappier steering

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

      // Desired velocity in m/step (Matter.js Verlet units)
      const vDesX = nx * targetSpeed * dt;
      const vDesY = ny * targetSpeed * dt;

      // Blend current velocity toward desired (exponential relaxation)
      const blend = Math.min(1, dt / tau);
      const newVx = body.velocity.x + (vDesX - body.velocity.x) * blend;
      const newVy = body.velocity.y + (vDesY - body.velocity.y) * blend;

      Matter.Body.setVelocity(body, { x: newVx, y: newVy });

      // Safety speed clamp
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

    // Check evacuations after physics resolve
    for (const body of this.pedestrians) {
      const ped: PedLabel = (body as any).__ped;
      if (!ped.evacuated) this.checkEvacuated(body, ped);
    }

    this.elapsed += dt;
  }

  private checkEvacuated(body: Matter.Body, ped: PedLabel) {
    const { roomWidth: w, roomHeight: h } = this.config;
    const exit = this.exits.find((e) => e.id === ped.targetExitId);
    if (!exit) return;

    const x = body.position.x;
    const y = body.position.y;
    const pastWall = 0.6;

    const outside = x < -pastWall || x > w + pastWall || y < -pastWall || y > h + pastWall;
    if (!outside) return;

    // Verify pedestrian is near their target exit (within exit width + buffer)
    const dxe = Math.abs(x - exit.center.x);
    const dye = Math.abs(y - exit.center.y);
    const side = this.getExitSide(exit);
    const halfW = exit.width / 2 + 0.5;
    const nearExit =
      side === 'top' || side === 'bottom'
        ? dxe < halfW
        : side === 'left' || side === 'right'
          ? dye < halfW
          : true;

    if (outside && nearExit) {
      ped.evacuated = true;
      Matter.Composite.remove(this.engine.world, body);
      const count = this.exitCounts.get(ped.targetExitId) ?? 0;
      this.exitCounts.set(ped.targetExitId, count + 1);
    } else if (outside) {
      // Pushed outside but not through an exit — push back inside
      const cx = Math.max(0.5, Math.min(w - 0.5, x));
      const cy = Math.max(0.5, Math.min(h - 0.5, y));
      Matter.Body.setPosition(body, { x: cx, y: cy });
      Matter.Body.setVelocity(body, { x: 0, y: 0 });
    }
  }

  private getExitSide(exit: ExitDef): string {
    const { roomWidth: w, roomHeight: h } = this.config;
    if (exit.center.y <= 0.5) return 'top';
    if (exit.center.y >= h - 0.5) return 'bottom';
    if (exit.center.x <= 0.5) return 'left';
    if (exit.center.x >= w - 0.5) return 'right';
    return 'unknown';
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
        speed: Math.sqrt(body.velocity.x ** 2 + body.velocity.y ** 2),
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

  getWalls(): { x: number; y: number; width: number; height: number; angle: number }[] {
    return this.wallBodies.map((b) => ({
      x: b.position.x,
      y: b.position.y,
      width: b.bounds.max.x - b.bounds.min.x,
      height: b.bounds.max.y - b.bounds.min.y,
      angle: b.angle,
    }));
  }

  getExits() {
    return this.exits;
  }

  getConfig() {
    return this.config;
  }

  getElapsed() {
    return this.elapsed;
  }

  destroy() {
    Matter.Engine.clear(this.engine);
    Matter.Composite.clear(this.engine.world, false);
  }
}
