/**
 * Stair shaft test, offline, with the crowd reading smoke and fire.
 *
 * Mirrors the review page in showcase mode: the scene loader, one hazard
 * field per storey, the effects engine with both shafts, crowd at 1/60 s,
 * effects in 0.1 s slices, blast at one minute on the ground floor. Every
 * frame the crowd is pointed at the live stud states, as the page does.
 */
import Matter from 'matter-js';
import { projectPolygon } from '../../src/lib/evacuation/geometry.ts';
import { PolygonEvacuationEngine } from '../../src/lib/evacuation/engine.ts';
import { DEFAULT_POLYGON_CONFIG, type ExitDef, type Vec2 } from '../../src/lib/evacuation/types.ts';
import { HazardField } from '../../src/lib/evacuation/hazardSensing.ts';
import { blastEffectsTriggerSec } from '../../src/lib/evacuation/showcase.ts';
import { SHOWCASE } from '../../src/lib/evacuation/showcaseConstants.ts';
import { FX } from '../../src/lib/rts/fx/fxConstants.ts';
import { createAccumulator, stepEffectsFixed } from '../../src/lib/rts/fx/simClock.ts';
import { SpatialEffectsEngine, blastSmokeStudIds } from '../../src/lib/rts/spatialEffects.ts';
import { DEFAULT_FIRE_PARAMS } from '../../src/lib/rts/fireSimulation.ts';
import { confirmedFuelCells } from '../../src/lib/rts/materialLibrary.ts';
import { projectSceneStuds } from '../../src/lib/rts/sceneStuds.ts';
import { linkLevels, normaliseStairwell } from '../../src/lib/rts/levels.ts';
import {
  stairShaftFuelObjects,
  stairShaftSample,
  stairShaftStuds,
} from '../../src/lib/rts/stairShaftTest.ts';
import type { HazardZone, LevelDef } from '../../src/lib/rts/types.ts';

export interface StairShaftMark {
  tSec: number;
  /** Person states by storey, e.g. { G: { evacuating: 3 }, L1: { ... } }. */
  byLevel: Record<string, Record<string, number>>;
  out: number;
  sheltering: number;
  /** Burning studs, every storey. */
  burning: number;
}

export interface StairShaftResult {
  site: Vec2;
  marks: StairShaftMark[];
  /** Seconds after the blast each person first sheltered, by pedId. */
  shelteredAt: Map<number, number>;
  outIds: Set<number>;
}

interface Label {
  pedId: number;
  state?: string;
  level?: string;
  sheltering?: boolean;
}

/**
 * `groundOnly` drops the upper storey and runs the ground floor as a single
 * floor, with no level plan: the same room, door and fire.
 */
export function runStairShaft(
  opts: { site?: Vec2; durationS?: number; groundOnly?: boolean } = {},
): StairShaftResult {
  const scene = stairShaftSample.scene;
  const polygon = scene.buildingPolygon.map((pair) => [pair[0], pair[1]] as [number, number]);
  const levels = scene.levels
    .filter((level) => !opts.groundOnly || level.id === 'G')
    .map((level) => ({ ...level })) as LevelDef[];
  const levelIds = levels.map((level) => level.id);
  const verts = projectPolygon(polygon);
  const projected = projectSceneStuds(polygon, stairShaftStuds(polygon, levelIds));
  const fireStuds = projected.map((stud) => ({
    id: stud.id,
    simPos: stud.simPos,
    spatialContext: stud.spatialContext,
    level: stud.floor === 'Ground' || !stud.floor ? 'G' : stud.floor,
  }));
  const objects = stairShaftFuelObjects(fireStuds);
  const exits = scene.exits
    .filter((exit) => levelIds.includes(exit.level))
    .map((exit) => ({ ...exit, photos: [] })) as unknown as ExitDef[];
  const stairs = opts.groundOnly
    ? []
    : scene.stairwells.map((shaft) => normaliseStairwell(shaft, levels));
  const site = opts.site ?? { x: scene.blastSite.x, y: scene.blastSite.y };
  const radius = scene.blastSite.manualRadiusM;

  const evac = new PolygonEvacuationEngine(
    {
      ...DEFAULT_POLYGON_CONFIG,
      vertices: verts,
      pedestrianCount: opts.groundOnly ? levels[0].pedestrianCount : 0,
      dt: FX.FIXED_DT,
    },
    exits,
    [],
    [],
    { afterExit: 'zone', zones: [], seed: SHOWCASE.RNG_SEED },
    opts.groundOnly
      ? undefined
      : {
          ids: levelIds,
          exitsByLevel: Object.fromEntries(
            levelIds.map((id) => [id, exits.filter((exit) => exit.level === id)]),
          ),
          wallsByLevel: Object.fromEntries(levelIds.map((id) => [id, []])),
          stairs,
          counts: Object.fromEntries(levels.map((level) => [level.id, level.pedestrianCount])),
          heights: Object.fromEntries(levels.map((level) => [level.id, level.heightM])),
        },
  );
  if (!opts.groundOnly) evac.setBlastLevel('G');

  const heights = Object.fromEntries(levels.map((level) => [level.id, level.heightM]));
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
  const cells = confirmedFuelCells(objects, fireStuds);
  effects.setHoodFanWhen(scene.hoodFanWhen);
  effects.setFuelCells(cells);
  effects.setStoreyHeights(heights);
  effects.setBuildingEnvelope(verts, exits);
  const trigger = blastEffectsTriggerSec(effects.timeScale);
  effects.registerHazard(
    'blast-direct',
    [
      {
        triggerTimeSec: trigger,
        eventType: 'explode',
        spreadType: 'fire',
        spreadRadius: radius,
        spreadRate: 10,
        description: 'Direct blast ignition',
        severity: 'critical',
        smokeGeneration: 'heavy',
        affectedStuds: blastSmokeStudIds(
          fireStuds
            .filter(
              (stud) =>
                stud.level === 'G' &&
                Math.hypot(stud.simPos.x - site.x, stud.simPos.y - site.y) <= radius,
            )
            .map((stud) => stud.id),
          new Set(cells.keys()),
        ),
      },
    ],
    { initial: 'a', triggered: 'b', worsening: 'c', critical: 'd' },
  );
  const zone: HazardZone = {
    id: 'blast-direct',
    pos: site,
    radius,
    hazardType: 'ignitable',
    severity: 'high',
    label: 'Blast',
    description: 'Direct blast ignition',
    photos: [],
    level: 'G',
  };

  const grouped = new Map<string, Array<{ id: string; simPos: Vec2; indoor: boolean }>>();
  for (const stud of fireStuds) {
    const list = grouped.get(stud.level) ?? [];
    list.push({
      id: stud.id,
      simPos: stud.simPos,
      indoor: stud.spatialContext === 'inside_building',
    });
    grouped.set(stud.level, list);
  }
  const fields = new Map<string, HazardField>();
  for (const [id, list] of grouped) fields.set(id, new HazardField(list, 3));
  evac.setHazardFields(fields);
  evac.setHazardField(fields.get('G') ?? new HazardField([], 3));

  const acc = createAccumulator();
  const fps = 60;
  const blastStep = Math.round(SHOWCASE.BLAST_AT_GAME_S / FX.FIXED_DT);
  const bodies = (evac as unknown as { pedestrians: Matter.Body[] }).pedestrians;
  const labelOf = (body: Matter.Body) => (body as Matter.Body & { __ped: Label }).__ped;
  const marks: StairShaftMark[] = [];
  const shelteredAt = new Map<number, number>();
  const outIds = new Set<number>();
  const durationS = opts.durationS ?? 180;
  for (let step = 1; step <= durationS * fps; step += 1) {
    evac.setHazardStates(effects.studStates);
    evac.syncExits(exits);
    if (step === blastStep) evac.triggerBlast(site, radius);
    evac.step();
    effects.setHoodFanWhen(scene.hoodFanWhen);
    effects.setFuelCells(cells);
    effects.setStoreyHeights(heights);
    effects.setBuildingEnvelope(verts, exits);
    stepEffectsFixed(effects, acc, FX.FIXED_DT, 1, [], [zone]);
    const sinceBlast = (step - blastStep) / fps;
    for (const body of bodies) {
      const ped = labelOf(body);
      if (ped.sheltering && !shelteredAt.has(ped.pedId)) shelteredAt.set(ped.pedId, sinceBlast);
      if (ped.state === 'outside' || ped.state === 'left_map' || ped.state === 'arrived') {
        outIds.add(ped.pedId);
      }
    }
    if (step % (15 * fps) !== 0) continue;
    const byLevel: Record<string, Record<string, number>> = {};
    let sheltering = 0;
    for (const body of bodies) {
      const ped = labelOf(body);
      const level = ped.level ?? 'G';
      const state = ped.sheltering ? 'sheltering' : (ped.state ?? 'unknown');
      if (ped.sheltering) sheltering++;
      const row = byLevel[level] ?? {};
      row[state] = (row[state] ?? 0) + 1;
      byLevel[level] = row;
    }
    marks.push({
      tSec: step / fps,
      byLevel,
      out: outIds.size,
      sheltering,
      burning: effects.getStats().fire.burning,
    });
  }
  evac.destroy();
  return { site, marks, shelteredAt, outIds };
}
