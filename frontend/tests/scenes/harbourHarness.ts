/**
 * Headless Harbour House loop from the review harness.
 *
 * The crowd steps at 1/60 s. The effects also step at that frame, not in the
 * page's 0.1 s slices. The Decision 9 Harbour figures were measured on this
 * loop. The walls are `harbourHouseWalls('plan')`.
 */
import { PolygonEvacuationEngine, type InteriorWallDef } from '../../src/lib/evacuation/engine.ts';
import type { ExitDef, ShowcaseZone, Vec2, ZoneKind } from '../../src/lib/evacuation/types.ts';
import { DEFAULT_POLYGON_CONFIG } from '../../src/lib/evacuation/types.ts';
import { HazardField } from '../../src/lib/evacuation/hazardSensing.ts';
import { SHOWCASE } from '../../src/lib/evacuation/showcaseConstants.ts';
import { blastEffectsTriggerSec, isBlastDue } from '../../src/lib/evacuation/showcase.ts';
import { RTSEngine } from '../../src/lib/rts/engine.ts';
import { SpatialEffectsEngine, type HazardEvent } from '../../src/lib/rts/spatialEffects.ts';
import { DEFAULT_FIRE_PARAMS } from '../../src/lib/rts/fireSimulation.ts';
import type { HazardZone, InteriorWall } from '../../src/lib/rts/types.ts';
import { isInsidePolygon } from '../../src/lib/evacuation/geometry.ts';
import { harbourHouseWalls } from '../../src/lib/rts/harbourHouseShowcase.ts';

export interface SceneOpts {
  afterExit: 'zone' | 'disperse' | 'mixed';
  zones?: Array<{ pos: Vec2; kind: ZoneKind }>;
  blastSite?: Vec2;
  blastR?: number;
  peds?: number;
  floors?: string[];
}

export const HARBOUR_VERTS: Vec2[] = [
  { x: 0, y: 0 },
  { x: 60, y: 0 },
  { x: 60, y: 40 },
  { x: 0, y: 40 },
];

export function harbourExits(): ExitDef[] {
  const base = { width: 2, photos: [] as string[], exitType: 'public' as const };
  return [
    {
      ...base,
      id: 'E1-west',
      center: { x: 0, y: 20 },
      edgeIndex: 3,
      description: 'west',
      status: 'open',
    },
    {
      ...base,
      id: 'E2-east',
      center: { x: 60, y: 12 },
      edgeIndex: 1,
      description: 'east',
      status: 'open',
    },
    {
      ...base,
      id: 'E3-north',
      center: { x: 30, y: 40 },
      edgeIndex: 2,
      description: 'north',
      status: 'congested',
    },
  ];
}

export const HARBOUR_WALLS: InteriorWall[] = harbourHouseWalls('plan');

export const HARBOUR_WALL_DEFS: InteriorWallDef[] = HARBOUR_WALLS.map((wall) => ({
  startX: wall.start.x,
  startY: wall.start.y,
  endX: wall.end.x,
  endY: wall.end.y,
  hasDoor: wall.hasDoor,
  doorWidth: wall.doorWidth,
  doorPosition: wall.doorPosition,
}));

export interface HarnessStud {
  id: string;
  simPos: Vec2;
  spatialContext: 'inside_building' | 'open_air';
}

export function harbourStuds(): HarnessStud[] {
  const out: HarnessStud[] = [];
  for (let x = -15; x <= 75; x += 3) {
    for (let y = -15; y <= 55; y += 3) {
      const inside = isInsidePolygon(x + 0.5, y + 0.5, HARBOUR_VERTS);
      out.push({
        id: `s_${x}_${y}`,
        simPos: { x: x + 0.5, y: y + 0.5 },
        spatialContext: inside ? 'inside_building' : 'open_air',
      });
    }
  }
  return out;
}

function aboveGroundHeightM(floors: string[] | undefined): number {
  const list = floors && floors.length > 0 ? floors : ['G'];
  const count = list.filter((floor) => floor === 'G' || floor.startsWith('L')).length;
  return Math.max(1, count) * SHOWCASE.BUILDING_STOREY_HEIGHT_M;
}

export class HarbourRun {
  readonly rts = new RTSEngine();
  exits = harbourExits();
  readonly studs = harbourStuds();
  evac!: PolygonEvacuationEngine;
  effects!: SpatialEffectsEngine;
  field!: HazardField;
  hazardZones: HazardZone[] = [];
  blastFired = false;
  readonly blastSite: Vec2;
  readonly blastR: number;
  private readonly zoneKinds: Record<string, ZoneKind> = {};

  constructor(readonly opts: SceneOpts) {
    this.blastSite = opts.blastSite ?? { x: 10, y: 20 };
    this.blastR = opts.blastR ?? 15;
    this.rts.setBuildingVertices(HARBOUR_VERTS);
    this.rts.setExits(this.exits);
    for (const zone of opts.zones ?? []) {
      const placed = this.rts.placeEquipment('assembly_point', zone.pos, 'system');
      this.zoneKinds[placed.id] = zone.kind;
    }
  }

  private currentZones(): ShowcaseZone[] {
    return this.rts.state.equipment
      .filter((item) => item.def.kind === 'assembly_point' && item.active)
      .map((item) => ({
        id: item.id,
        pos: item.pos,
        radius: item.def.radius,
        label: item.def.label,
        kind: this.zoneKinds[item.id] ?? 'assembly',
      }));
  }

  start(): void {
    this.blastFired = false;
    const config = {
      ...DEFAULT_POLYGON_CONFIG,
      vertices: HARBOUR_VERTS,
      pedestrianCount: this.opts.peds ?? 120,
    };
    this.evac = new PolygonEvacuationEngine(config, this.exits, HARBOUR_WALL_DEFS, [], {
      afterExit: this.opts.afterExit,
      zones: this.currentZones(),
      seed: SHOWCASE.RNG_SEED,
      buildingHeightM: aboveGroundHeightM(this.opts.floors),
    });
    this.evac.setInteriorWalls(HARBOUR_WALL_DEFS);
    this.rts.startDetonation();

    const engine = new SpatialEffectsEngine({
      ...DEFAULT_FIRE_PARAMS,
      ambientSpread: true,
      ambientHeatSec: SHOWCASE.AMBIENT_HEAT_S,
    });
    engine.init(this.studs);
    const trigger = blastEffectsTriggerSec(engine.timeScale);
    const affectedStuds = this.studs
      .filter(
        (stud) =>
          Math.hypot(stud.simPos.x - this.blastSite.x, stud.simPos.y - this.blastSite.y) <=
          this.blastR,
      )
      .map((stud) => stud.id);
    const event: HazardEvent = {
      triggerTimeSec: trigger,
      eventType: 'explode',
      spreadType: 'fire',
      spreadRadius: this.blastR,
      spreadRate: 10,
      description: 'Direct blast ignition',
      severity: 'critical',
      smokeGeneration: 'heavy',
      affectedStuds,
    };
    engine.registerHazard('blast-direct', [event], {
      initial: 'a',
      triggered: 'b',
      worsening: 'c',
      critical: 'd',
    });
    this.hazardZones = [
      {
        id: 'blast-direct',
        pos: this.blastSite,
        radius: this.blastR,
        hazardType: 'ignitable',
        severity: 'high',
        label: 'Blast',
        description: 'Direct blast ignition',
        photos: [],
      },
    ];
    this.field = new HazardField(
      this.studs.map((stud) => ({
        id: stud.id,
        simPos: stud.simPos,
        indoor: stud.spatialContext === 'inside_building',
      })),
      3,
    );
    this.evac.setHazardField(this.field);
    this.effects = engine;
  }

  setExitStatus(id: string, status: ExitDef['status']): void {
    this.exits = this.exits.map((exit) => (exit.id === id ? { ...exit, status } : exit));
    this.rts.setExits(this.exits);
  }

  /** One animation frame. The effects step is this frame's dt, not a 0.1 s slice. */
  frame(dt: number): boolean {
    const rts = this.rts;
    rts.tick(dt);
    let fired = false;
    if (rts.state.clock.phase !== 'setup' && isBlastDue(rts.state.clock.elapsed, this.blastFired)) {
      this.blastFired = true;
      this.evac.triggerBlast(this.blastSite, this.blastR);
      fired = true;
    }
    if (!rts.state.clock.paused && rts.state.clock.phase !== 'setup') {
      this.field.setStates(this.effects.studStates);
      this.evac.syncExits(this.exits);
      this.evac.setZones(this.currentZones());
      const steps = Math.max(1, Math.round(rts.state.clock.speed));
      for (let i = 0; i < steps; i++) this.evac.step();
      this.effects.setBuildingEnvelope(HARBOUR_VERTS, this.exits);
      this.effects.step(dt * rts.state.clock.speed, HARBOUR_WALLS, this.hazardZones);
    }
    return fired;
  }

  meanIndoorSmoke(): number {
    let sum = 0;
    let count = 0;
    for (const stud of this.studs) {
      if (stud.spatialContext !== 'inside_building') continue;
      sum += this.effects.studStates.get(stud.id)?.smoke ?? 0;
      count += 1;
    }
    return count > 0 ? sum / count : 0;
  }
}
