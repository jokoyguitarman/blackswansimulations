/**
 * Three-storey office fire, offline, driven frame by frame the way the RTS
 * page drives it in showcase mode: the game clock ticks on the frame's real
 * time, and the crowd, the door leaves and the effects field advance through
 * the shared sim clock. A frame list stands in for requestAnimationFrame, so
 * a run can be played at any speed and frame rate.
 */
import Matter from 'matter-js';
import { projectPolygon } from '../../src/lib/evacuation/geometry.ts';
import { PolygonEvacuationEngine } from '../../src/lib/evacuation/engine.ts';
import { DEFAULT_POLYGON_CONFIG, type ExitDef, type Vec2 } from '../../src/lib/evacuation/types.ts';
import { HazardField, MOUTH_APPROACH_M } from '../../src/lib/evacuation/hazardSensing.ts';
import { blastEffectsTriggerSec } from '../../src/lib/evacuation/showcase.ts';
import { SHOWCASE } from '../../src/lib/evacuation/showcaseConstants.ts';
import { stepDoorLeaves } from '../../src/lib/rts/doorLeaf.ts';
import { RTSEngine } from '../../src/lib/rts/engine.ts';
import { FX } from '../../src/lib/rts/fx/fxConstants.ts';
import {
  advanceSharedFrame,
  cappedFrameDt,
  createSharedClock,
} from '../../src/lib/rts/fx/simClock.ts';
import { SpatialEffectsEngine, blastSmokeStudIds } from '../../src/lib/rts/spatialEffects.ts';
import { DEFAULT_FIRE_PARAMS } from '../../src/lib/rts/fireSimulation.ts';
import { confirmedFuelCells } from '../../src/lib/rts/materialLibrary.ts';
import { projectSceneStuds } from '../../src/lib/rts/sceneStuds.ts';
import { effectiveLevelPlan, linkLevels, normaliseStairwell } from '../../src/lib/rts/levels.ts';
import {
  officeTowerFuelObjects,
  officeTowerSample,
  officeTowerStuds,
} from '../../src/lib/rts/officeTowerFire.ts';
import type { HazardZone, InteriorWall, LevelDef } from '../../src/lib/rts/types.ts';

export interface OfficeFrameResult {
  /** Game clock at the end, seconds. */
  clockS: number;
  crowdS: number;
  effectsS: number;
  frames: number;
  out: number;
  down: number;
  sheltering: number;
  /** Burning studs, every storey. */
  burning: number;
}

interface PedLabel {
  state?: string;
  sheltering?: boolean;
}

/**
 * Play the office scene until the game clock reaches `untilS`, giving the
 * page `frameDt` real seconds per frame at `speed`.
 */
export function runOfficeFrames(speed: number, frameDt: number, untilS: number): OfficeFrameResult {
  const scene = officeTowerSample.scene;
  const polygon = scene.buildingPolygon.map((p) => [p[0], p[1]] as [number, number]);
  const levels = scene.levels.map((l) => ({ ...l })) as LevelDef[];
  const verts = projectPolygon(polygon);
  const fireStuds = projectSceneStuds(polygon, officeTowerStuds(polygon)).map((s) => ({
    id: s.id,
    simPos: s.simPos,
    spatialContext: s.spatialContext,
    level: s.floor === 'Ground' || !s.floor ? 'G' : s.floor,
  }));
  const exits = scene.exits.map((e) => ({ ...e, photos: [] })) as unknown as ExitDef[];
  const walls: InteriorWall[] = scene.interiorWalls.map((w) => ({ ...w }));
  const stairs = scene.stairwells.map((s) => normaliseStairwell(s, levels));
  const site = { x: scene.blastSite.x, y: scene.blastSite.y };
  const radius = scene.blastSite.manualRadiusM;
  const heights = Object.fromEntries(levels.map((l) => [l.id, l.heightM]));
  const toDef = (w: InteriorWall, level?: string) => ({
    id: w.id,
    startX: w.start.x,
    startY: w.start.y,
    endX: w.end.x,
    endY: w.end.y,
    hasDoor: w.hasDoor,
    doorWidth: w.doorWidth,
    doorPosition: w.doorPosition,
    level: level ?? w.level,
    openFraction: w.openFraction,
    doorPinned: w.doorPinned,
  });
  const exitsByLevel: Record<string, ExitDef[]> = {};
  const wallsByLevel: Record<string, ReturnType<typeof toDef>[]> = {};
  for (const level of levels) {
    const plan = effectiveLevelPlan(level.id, levels, { walls, exits });
    exitsByLevel[level.id] = plan.exits;
    wallsByLevel[level.id] = plan.walls.map((w) => toDef(w, level.id));
  }
  const evac = new PolygonEvacuationEngine(
    { ...DEFAULT_POLYGON_CONFIG, vertices: verts, pedestrianCount: 0, dt: FX.FIXED_DT },
    exits,
    walls.map((w) => toDef(w)),
    [],
    { afterExit: 'zone', zones: [], seed: SHOWCASE.RNG_SEED },
    {
      ids: levels.map((l) => l.id),
      exitsByLevel,
      wallsByLevel,
      stairs,
      counts: Object.fromEntries(levels.map((l) => [l.id, l.pedestrianCount])),
      heights,
    },
  );
  evac.setBlastLevel('G');
  evac.setInteriorWalls(walls.map((w) => toDef(w)));

  const effects = new SpatialEffectsEngine(DEFAULT_FIRE_PARAMS);
  effects.init(fireStuds);
  effects.setVerticalLinks(
    stairs.map((sw) => ({
      id: sw.id,
      pos: sw.pos,
      levels: linkLevels(sw, levels),
      kind: sw.kind ?? 'stair',
      blocked: sw.blocked,
      widthM: sw.widthM,
      heightByLevel: heights,
    })),
  );
  const cells = confirmedFuelCells(officeTowerFuelObjects(fireStuds), fireStuds);
  effects.setHoodFanWhen(scene.hoodFanWhen);
  effects.setFuelCells(cells);
  effects.setStoreyHeights(heights);
  effects.setBuildingEnvelope(verts, exits);
  const inRadius = fireStuds.filter(
    (s) => s.level === 'G' && Math.hypot(s.simPos.x - site.x, s.simPos.y - site.y) <= radius,
  );
  effects.registerHazard(
    'blast-direct',
    [
      {
        triggerTimeSec: blastEffectsTriggerSec(effects.timeScale),
        eventType: 'explode',
        spreadType: 'fire',
        spreadRadius: radius,
        spreadRate: 10,
        description: 'Direct blast ignition',
        severity: 'critical',
        smokeGeneration: 'heavy',
        affectedStuds: blastSmokeStudIds(
          inRadius.map((s) => s.id),
          new Set(cells.keys()),
        ),
      },
    ],
    { initial: 'a', triggered: 'b', worsening: 'c', critical: 'd' },
  );
  const hazards: HazardZone[] = [
    {
      id: 'blast-direct',
      pos: site,
      radius,
      hazardType: 'ignitable',
      severity: 'high',
      label: 'Blast',
      description: '',
      photos: [],
      level: 'G',
    },
  ];
  const grouped = new Map<string, Array<{ id: string; simPos: Vec2; indoor: boolean }>>();
  for (const s of fireStuds) {
    const list = grouped.get(s.level) ?? [];
    list.push({ id: s.id, simPos: s.simPos, indoor: s.spatialContext === 'inside_building' });
    grouped.set(s.level, list);
  }
  const fields = new Map<string, HazardField>();
  for (const [id, list] of grouped) fields.set(id, new HazardField(list, 3));
  evac.setHazardFields(fields);
  evac.setHazardField(fields.get('G') ?? new HazardField([], 3));

  const rts = new RTSEngine();
  rts.startDetonation();
  rts.setSpeed(speed);
  const shared = createSharedClock();
  const blastStep = Math.round(SHOWCASE.BLAST_AT_GAME_S / FX.FIXED_DT);
  let blastFired = false;
  let snaps = evac.getSnapshots();
  let frames = 0;
  while (rts.state.clock.elapsed < untilS) {
    frames++;
    rts.tick(cappedFrameDt(frameDt, speed));
    evac.setHazardStates(effects.studStates);
    evac.syncExits(exits);
    effects.setFuelCells(cells);
    effects.setStoreyHeights(heights);
    effects.setBuildingEnvelope(verts, exits);
    advanceSharedFrame(shared, frameDt, speed, {
      beforeSteps: (doorDt) => {
        const bodies = snaps
          .filter((p) => p.state !== 'left_map')
          .map((p) => ({ x: p.x, y: p.y, level: p.level }));
        stepDoorLeaves(walls, bodies, effects.exposedDoorIds(), doorDt, MOUTH_APPROACH_M);
        evac.syncDoorLeaves(walls);
      },
      crowdStep: (stepNo) => {
        evac.step();
        if (!blastFired && stepNo >= blastStep) {
          blastFired = true;
          evac.triggerBlast(site, radius);
        }
      },
      effectsStep: () => effects.step(FX.EFFECTS_DT, walls, hazards),
    });
    rts.syncElapsed(shared.crowdSteps * FX.FIXED_DT);
    snaps = evac.getSnapshots();
  }

  const bodies = (evac as unknown as { pedestrians: Matter.Body[] }).pedestrians;
  const label = (b: Matter.Body) => (b as Matter.Body & { __ped: PedLabel }).__ped;
  let out = 0;
  let down = 0;
  let sheltering = 0;
  for (const b of bodies) {
    const p = label(b);
    if (p.state === 'outside' || p.state === 'arrived' || p.state === 'left_map') out++;
    else if (p.state === 'down') down++;
    else if (p.sheltering) sheltering++;
  }
  let burning = 0;
  for (const st of effects.studStates.values()) if (st.fire.state === 'burning') burning++;
  evac.destroy();
  return {
    clockS: rts.state.clock.elapsed,
    crowdS: shared.crowdSteps * FX.FIXED_DT,
    effectsS: shared.effectSteps * FX.EFFECTS_DT,
    frames,
    out,
    down,
    sheltering,
    burning,
  };
}
