import type { Vec2, ExitDef } from '../evacuation/types';
import type {
  RTSUnit,
  RTSEquipment,
  RTSGameState,
  GamePhase,
  UnitKind,
  EquipmentKind,
  TeamId,
  HeatEvent,
  InteractionMode,
} from './types';
import { UNIT_CATALOG, EQUIPMENT_CATALOG, PHASE_THRESHOLDS, createInitialGameState } from './types';
import { computePathThroughExits, clampToWallExterior } from './pathfinding';

let _idCounter = 0;
function nextId(prefix: string): string {
  return `${prefix}-${++_idCounter}`;
}

export class RTSEngine {
  state: RTSGameState;
  private buildingVerts: Vec2[] = [];
  private exits: ExitDef[] = [];

  constructor() {
    this.state = createInitialGameState();
  }

  setBuildingVertices(verts: Vec2[]) {
    this.buildingVerts = verts;
  }

  getBuildingVertices(): Vec2[] {
    return this.buildingVerts;
  }

  setExits(exits: ExitDef[]) {
    this.exits = exits;
  }

  getExits(): ExitDef[] {
    return this.exits;
  }

  // ── Clock ─────────────────────────────────────────────────────────────
  tick(dtReal: number) {
    const { clock } = this.state;

    // Units always move during setup (at real-time speed for positioning).
    // During active phases they move at game speed. Paused freezes everything.
    if (clock.phase === 'setup') {
      this.updateUnits(dtReal);
      return;
    }

    if (clock.paused) return;

    const dt = dtReal * clock.speed;
    clock.elapsed += dt;
    clock.phase = this.computePhase(clock.elapsed);
    this.updateUnits(dt);
  }

  private computePhase(t: number): GamePhase {
    if (t >= PHASE_THRESHOLDS.phase5) return 'phase5';
    if (t >= PHASE_THRESHOLDS.phase4) return 'phase4';
    if (t >= PHASE_THRESHOLDS.phase3) return 'phase3';
    if (t >= PHASE_THRESHOLDS.phase2) return 'phase2';
    if (t >= PHASE_THRESHOLDS.phase1) return 'phase1';
    return 'phase0';
  }

  // ── Detonation ────────────────────────────────────────────────────────
  startDetonation() {
    this.state.clock.paused = false;
    this.state.clock.elapsed = 0;
    this.state.clock.phase = 'phase0';
  }

  togglePause() {
    this.state.clock.paused = !this.state.clock.paused;
  }

  setSpeed(s: number) {
    this.state.clock.speed = s;
  }

  // ── Staging area ──────────────────────────────────────────────────────
  setStagingArea(pos: Vec2) {
    this.state.stagingArea = pos;
  }

  // ── Unit management ───────────────────────────────────────────────────
  spawnUnit(kind: UnitKind, pos: Vec2): RTSUnit {
    const def = UNIT_CATALOG[kind];
    const unit: RTSUnit = {
      id: nextId(kind),
      def,
      pos: { ...pos },
      waypoints: [],
      state: 'idle',
      workTimer: 0,
      selected: false,
      placedAt: this.state.clock.elapsed,
    };
    this.state.units.push(unit);
    return unit;
  }

  removeUnit(id: string) {
    this.state.units = this.state.units.filter((u) => u.id !== id);
    this.state.selection.selectedUnitIds.delete(id);
  }

  issueMove(unitIds: string[], target: Vec2, queue: boolean) {
    for (const uid of unitIds) {
      const u = this.state.units.find((un) => un.id === uid);
      if (!u) continue;

      // Compute path through exits if direct path crosses a wall
      const path = computePathThroughExits(u.pos, target, this.buildingVerts, this.exits);

      if (queue) {
        u.waypoints.push(...path);
      } else {
        u.waypoints = path;
      }
      u.state = 'moving';
    }
  }

  private updateUnits(dt: number) {
    for (const u of this.state.units) {
      if (u.state === 'working') {
        u.workTimer -= dt;
        if (u.workTimer <= 0) {
          u.workTimer = 0;
          u.state = u.waypoints.length > 0 ? 'moving' : 'idle';
        }
        continue;
      }

      if (u.waypoints.length === 0) {
        u.state = 'idle';
        continue;
      }

      u.state = 'moving';
      const wp = u.waypoints[0];
      const dx = wp.x - u.pos.x;
      const dy = wp.y - u.pos.y;
      const dist = Math.hypot(dx, dy);
      const step = u.def.speed * dt;

      const prevPos = { x: u.pos.x, y: u.pos.y };

      if (dist <= step) {
        u.pos.x = wp.x;
        u.pos.y = wp.y;
        u.waypoints.shift();
        if (u.waypoints.length === 0) u.state = 'idle';
      } else {
        u.pos.x += (dx / dist) * step;
        u.pos.y += (dy / dist) * step;
      }

      // Wall collision safety net: revert if we crossed a solid wall
      if (this.buildingVerts.length >= 3) {
        const clamped = clampToWallExterior(u.pos, prevPos, this.buildingVerts, this.exits);
        u.pos.x = clamped.x;
        u.pos.y = clamped.y;
      }
    }
  }

  // ── Equipment ─────────────────────────────────────────────────────────
  placeEquipment(kind: EquipmentKind, pos: Vec2, placedByUnitId: string): RTSEquipment {
    const def = EQUIPMENT_CATALOG[kind];
    const eq: RTSEquipment = {
      id: nextId(kind),
      def,
      pos: { ...pos },
      placedBy: placedByUnitId,
      placedAt: this.state.clock.elapsed,
      active: true,
    };
    this.state.equipment.push(eq);
    return eq;
  }

  removeEquipment(id: string) {
    this.state.equipment = this.state.equipment.filter((e) => e.id !== id);
  }

  // ── Selection helpers ─────────────────────────────────────────────────
  selectUnitsInBox(start: Vec2, end: Vec2) {
    const minX = Math.min(start.x, end.x);
    const maxX = Math.max(start.x, end.x);
    const minY = Math.min(start.y, end.y);
    const maxY = Math.max(start.y, end.y);

    const sel = this.state.selection;
    sel.selectedUnitIds.clear();

    for (const u of this.state.units) {
      const inside = u.pos.x >= minX && u.pos.x <= maxX && u.pos.y >= minY && u.pos.y <= maxY;
      u.selected = inside;
      if (inside) sel.selectedUnitIds.add(u.id);
    }
  }

  selectUnit(id: string, additive: boolean) {
    const sel = this.state.selection;
    if (!additive) {
      sel.selectedUnitIds.clear();
      for (const u of this.state.units) u.selected = false;
    }
    const u = this.state.units.find((un) => un.id === id);
    if (u) {
      u.selected = true;
      sel.selectedUnitIds.add(id);
    }
  }

  deselectAll() {
    this.state.selection.selectedUnitIds.clear();
    for (const u of this.state.units) u.selected = false;
  }

  getSelectedUnits(): RTSUnit[] {
    return this.state.units.filter((u) => u.selected);
  }

  findUnitAt(pos: Vec2, radius: number = 3.0): RTSUnit | null {
    let best: RTSUnit | null = null;
    let bestDist = radius;
    for (const u of this.state.units) {
      const d = Math.hypot(u.pos.x - pos.x, u.pos.y - pos.y);
      if (d < bestDist) {
        bestDist = d;
        best = u;
      }
    }
    return best;
  }

  findEquipmentAt(pos: Vec2, radius: number = 2.0): RTSEquipment | null {
    let best: RTSEquipment | null = null;
    let bestDist = radius;
    for (const eq of this.state.equipment) {
      const d = Math.hypot(eq.pos.x - pos.x, eq.pos.y - pos.y);
      if (d < bestDist) {
        bestDist = d;
        best = eq;
      }
    }
    return best;
  }

  // ── Heat meter ────────────────────────────────────────────────────────
  addHeat(delta: number, reason: string, team: TeamId) {
    const evt: HeatEvent = {
      time: this.state.clock.elapsed,
      delta,
      reason,
      team,
    };
    this.state.heat.events.push(evt);
    this.state.heat.value = Math.max(0, Math.min(10, this.state.heat.value + delta));
  }

  // ── Interaction mode ──────────────────────────────────────────────────
  setInteractionMode(mode: InteractionMode) {
    this.state.interactionMode = mode;
  }

  setActiveTeam(team: TeamId) {
    this.state.activeTeam = team;
  }

  // ── Serialization (for future save/load) ──────────────────────────────
  getSnapshot(): RTSGameState {
    return this.state;
  }

  // ── Format clock display ──────────────────────────────────────────────
  formatClock(): string {
    const t = Math.floor(this.state.clock.elapsed);
    const m = Math.floor(t / 60);
    const s = t % 60;
    return `T+${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  phaseLabel(): string {
    const labels: Record<GamePhase, string> = {
      setup: 'SETUP',
      phase0: 'PHASE 0 — DETONATION',
      phase1: 'PHASE 1 — COMMAND & CONTROL',
      phase2: 'PHASE 2 — INITIAL ASSESSMENT',
      phase3: 'PHASE 3 — ACTIVE OPERATIONS',
      phase4: 'PHASE 4 — COMPLICATIONS',
      phase5: 'PHASE 5 — RESOLUTION',
    };
    return labels[this.state.clock.phase];
  }
}
