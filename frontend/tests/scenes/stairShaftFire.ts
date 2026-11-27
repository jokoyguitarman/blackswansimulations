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
import { LEVEL } from '../../src/lib/evacuation/levelConstants.ts';
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
import type { HazardZone, InteriorWall, LevelDef } from '../../src/lib/rts/types.ts';

export interface StairShaftMark {
  tSec: number;
  /**
   * Person states by the storey each person started on, e.g.
   * { G: { left_map: 3, down: 1 }, L1: { ... } }. Down and out win over
   * sheltering, and people in a stair flight count as `stair`.
   */
  byLevel: Record<string, Record<string, number>>;
  out: number;
  sheltering: number;
  /** Burning studs, every storey. */
  burning: number;
}

export interface FloorTally {
  out: number;
  down: number;
  heatDown: number;
  fumeDown: number;
  sheltering: number;
}

export interface StairShaftResult {
  site: Vec2;
  /** End of run, by the storey each person started on. */
  perFloor: Record<string, FloorTally>;
  /** Everyone at the end: start floor, state, and the larger FED carried. */
  people: Array<{ pedId: number; home: string; state: string; sheltering: boolean; dose: number }>;
  /** Steps on which someone's move crossed a wall on their own storey. */
  wallCrossings: number;
  /**
   * Everyone who took a dead-end crawl down a stair: the FED projected when
   * they took it, and the larger FED they carried when they got out or went down.
   */
  crawlers: Array<{
    pedId: number;
    projected: number;
    realised: number;
    outcome: string;
    frozen: boolean;
  }>;
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
  heatDown?: boolean;
  fumeDown?: boolean;
  fed?: number;
  heatFed?: number;
  frozen?: boolean;
  crawlProjection?: number;
  reactAt?: number;
}

const OUT_STATES = new Set(['outside', 'left_map', 'arrived']);

function segmentsCross(p: Vec2, q: Vec2, a: Vec2, b: Vec2): boolean {
  const side = (u: Vec2, v: Vec2, w: Vec2) => (v.x - u.x) * (w.y - u.y) - (v.y - u.y) * (w.x - u.x);
  return side(a, b, p) * side(a, b, q) < 0 && side(p, q, a) * side(p, q, b) < 0;
}

function stateOf(ped: Label, inStair: boolean): string {
  if (ped.state === 'down') return 'down';
  if (OUT_STATES.has(ped.state ?? '')) return ped.state!;
  if (inStair) return 'stair';
  if (ped.sheltering) return 'sheltering';
  return ped.state ?? 'unknown';
}

/**
 * `groundOnly` drops the upper storey and runs the ground floor as a single
 * floor, with no level plan: the same room, door and fire. `walls` are
 * editor-frame partitions, each on its own storey.
 */
export function runStairShaft(
  opts: {
    site?: Vec2;
    durationS?: number;
    groundOnly?: boolean;
    walls?: InteriorWall[];
    /** Sim seconds when the upper floor hears the alarm. Default: with the blast. */
    upperAlarmAtS?: number;
    /**
     * Smoke-tight but walkable: the effects engine gets no vertical link for
     * these shafts, while the crowd still uses them. Not the same as
     * `blocked` (doors shut), which also closes the shaft to people.
     */
    closedShafts?: string[];
    /** Override for LEVEL.DEAD_END_CRAWL_MAX_FED, for a counterfactual run. */
    crawlMaxFed?: number;
  } = {},
): StairShaftResult {
  const limits = LEVEL as { DEAD_END_CRAWL_MAX_FED: number };
  const savedLimit = limits.DEAD_END_CRAWL_MAX_FED;
  if (opts.crawlMaxFed != null) limits.DEAD_END_CRAWL_MAX_FED = opts.crawlMaxFed;
  try {
    return runScene(opts);
  } finally {
    limits.DEAD_END_CRAWL_MAX_FED = savedLimit;
  }
}

function runScene(opts: Parameters<typeof runStairShaft>[0] & object): StairShaftResult {
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
  const walls = (opts.walls ?? []).filter((wall) => levelIds.includes(wall.level ?? 'G'));
  const wallDefs = (level?: string) =>
    walls
      .filter((wall) => level == null || (wall.level ?? 'G') === level)
      .map((wall) => ({
        id: wall.id,
        startX: wall.start.x,
        startY: wall.start.y,
        endX: wall.end.x,
        endY: wall.end.y,
        hasDoor: wall.hasDoor,
        doorWidth: wall.doorWidth,
        doorPosition: wall.doorPosition,
        level: wall.level ?? 'G',
      }));

  const evac = new PolygonEvacuationEngine(
    {
      ...DEFAULT_POLYGON_CONFIG,
      vertices: verts,
      pedestrianCount: opts.groundOnly ? levels[0].pedestrianCount : 0,
      dt: FX.FIXED_DT,
    },
    exits,
    wallDefs(),
    [],
    { afterExit: 'zone', zones: [], seed: SHOWCASE.RNG_SEED },
    opts.groundOnly
      ? undefined
      : {
          ids: levelIds,
          exitsByLevel: Object.fromEntries(
            levelIds.map((id) => [id, exits.filter((exit) => exit.level === id)]),
          ),
          wallsByLevel: Object.fromEntries(levelIds.map((id) => [id, wallDefs(id)])),
          stairs,
          counts: Object.fromEntries(levels.map((level) => [level.id, level.pedestrianCount])),
          heights: Object.fromEntries(levels.map((level) => [level.id, level.heightM])),
        },
  );
  if (!opts.groundOnly) evac.setBlastLevel('G');
  evac.setInteriorWalls(wallDefs());

  const heights = Object.fromEntries(levels.map((level) => [level.id, level.heightM]));
  const effects = new SpatialEffectsEngine(DEFAULT_FIRE_PARAMS);
  effects.init(fireStuds);
  effects.setVerticalLinks(
    stairs
      .filter((sw) => !(opts.closedShafts ?? []).includes(sw.id))
      .map((sw) => ({
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
  const inner = evac as unknown as {
    pedestrians: Matter.Body[];
    stairPeople: Array<{ label: Label }>;
  };
  const labelOf = (body: Matter.Body) => (body as Matter.Body & { __ped: Label }).__ped;
  const home = new Map<number, string>();
  for (const body of inner.pedestrians) {
    const ped = labelOf(body);
    home.set(ped.pedId, ped.level ?? 'G');
  }
  const everyone = (): Array<{ ped: Label; inStair: boolean }> => [
    ...inner.pedestrians.map((body) => ({ ped: labelOf(body), inStair: false })),
    ...inner.stairPeople.map((occ) => ({ ped: occ.label, inStair: true })),
  ];
  const marks: StairShaftMark[] = [];
  const shelteredAt = new Map<number, number>();
  const outIds = new Set<number>();
  const durationS = opts.durationS ?? 180;
  const last = new Map<number, { level: string; x: number; y: number }>();
  let wallCrossings = 0;
  const crawlers: StairShaftResult['crawlers'] = [];
  const settled = new Set<number>();
  for (let step = 1; step <= durationS * fps; step += 1) {
    evac.setHazardStates(effects.studStates);
    evac.setShaftColumns(effects.shaftColumns());
    evac.syncExits(exits);
    if (step === blastStep) {
      evac.triggerBlast(site, radius);
      if (opts.upperAlarmAtS != null) {
        const late = opts.upperAlarmAtS - SHOWCASE.BLAST_AT_GAME_S;
        for (const { ped } of everyone()) {
          if (ped.level === 'G' || ped.state !== 'reacting') continue;
          ped.reactAt = (ped.reactAt ?? 0) + late;
        }
      }
    }
    evac.step();
    effects.setHoodFanWhen(scene.hoodFanWhen);
    effects.setFuelCells(cells);
    effects.setStoreyHeights(heights);
    effects.setBuildingEnvelope(verts, exits);
    stepEffectsFixed(effects, acc, FX.FIXED_DT, 1, walls, [zone]);
    for (const body of inner.pedestrians) {
      const ped = labelOf(body);
      const level = ped.level ?? 'G';
      const prev = last.get(ped.pedId);
      const now = { level, x: body.position.x, y: body.position.y };
      last.set(ped.pedId, now);
      if (!prev || prev.level !== level) continue;
      for (const wall of walls) {
        if ((wall.level ?? 'G') !== level) continue;
        if (segmentsCross(prev, now, wall.start, wall.end)) wallCrossings++;
      }
    }
    const sinceBlast = (step - blastStep) / fps;
    for (const { ped } of everyone()) {
      if (ped.sheltering && !shelteredAt.has(ped.pedId)) shelteredAt.set(ped.pedId, sinceBlast);
      if (OUT_STATES.has(ped.state ?? '')) outIds.add(ped.pedId);
      const done = OUT_STATES.has(ped.state ?? '') || ped.state === 'down';
      if (!done || settled.has(ped.pedId)) continue;
      settled.add(ped.pedId);
      if (ped.crawlProjection == null) continue;
      crawlers.push({
        pedId: ped.pedId,
        projected: ped.crawlProjection,
        realised: Math.max(ped.fed ?? 0, ped.heatFed ?? 0),
        outcome: ped.state ?? 'unknown',
        frozen: ped.frozen === true,
      });
    }
    if (step % (15 * fps) !== 0) continue;
    const byLevel: Record<string, Record<string, number>> = {};
    let sheltering = 0;
    for (const { ped, inStair } of everyone()) {
      const level = home.get(ped.pedId) ?? 'G';
      const state = stateOf(ped, inStair);
      if (state === 'sheltering') sheltering++;
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
  const perFloor: Record<string, FloorTally> = {};
  for (const { ped } of everyone()) {
    const level = home.get(ped.pedId) ?? 'G';
    const row = (perFloor[level] ??= { out: 0, down: 0, heatDown: 0, fumeDown: 0, sheltering: 0 });
    if (OUT_STATES.has(ped.state ?? '')) row.out++;
    if (ped.state === 'down') row.down++;
    if (ped.heatDown) row.heatDown++;
    if (ped.fumeDown) row.fumeDown++;
    if (ped.sheltering && ped.state !== 'down') row.sheltering++;
  }
  const people = everyone().map(({ ped }) => ({
    pedId: ped.pedId,
    home: home.get(ped.pedId) ?? 'G',
    state: ped.state ?? 'unknown',
    sheltering: ped.sheltering === true,
    dose: Math.max(ped.fed ?? 0, ped.heatFed ?? 0),
  }));
  evac.destroy();
  return { site, perFloor, people, wallCrossings, crawlers, marks, shelteredAt, outIds };
}
