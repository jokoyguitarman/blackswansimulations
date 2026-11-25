/**
 * Food-court table or fryer, with or without the wet-chemical hoods.
 * Ignition is at 10 s. A reported T+120 is simulation time 130 s. Steps are
 * 0.1 s, which is the loop the Decision 9 food-court figures were measured on.
 */
import { extinctionK } from '../../src/lib/evacuation/hazardSensing.ts';
import { projectPolygon } from '../../src/lib/evacuation/geometry.ts';
import { foodCourtPlacedObjects, foodCourtSample } from '../../src/lib/rts/foodCourtSample.ts';
import {
  confirmedFuelCells,
  confirmedSuppression,
  snapObjectsToStuds,
} from '../../src/lib/rts/materialLibrary.ts';
import { generateSceneStuds, projectSceneStuds } from '../../src/lib/rts/sceneStuds.ts';
import { SpatialEffectsEngine } from '../../src/lib/rts/spatialEffects.ts';
import { effectsView } from './effectsView.ts';
import { fixed } from './round.ts';

export interface FoodCourtMark {
  tSec: number;
  releaseKw: number;
  peakKw: number;
  hoodsOpen: Record<string, number>;
  layerActive: boolean;
  interfaceM: number;
  riseK: number;
  sootG: number;
  kAtFire: number;
  studsK15: number;
  reachM: number;
  acroleinPpm: number;
}

export interface FoodCourtResult {
  fire: 'table' | 'oil';
  hoods: boolean;
  sourceId: string;
  hoodCount: number;
  marks: FoodCourtMark[];
}

const MARKS = [120, 300, 600];

export function runFoodCourt(options: {
  fire: 'table' | 'oil';
  hoods: boolean;
  /** Reported seconds after ignition. The full figures stop at 600. */
  untilSec?: number;
}): FoodCourtResult {
  const untilSec = options.untilSec ?? 600;
  const polygon = foodCourtSample.scene.buildingPolygon.map(
    (point) => [point[0], point[1]] as [number, number],
  );
  const projected = projectSceneStuds(polygon, generateSceneStuds(polygon, 0, ['G']));
  const studs = projected.map((stud) => ({
    id: stud.id,
    simPos: stud.simPos,
    spatialContext: stud.spatialContext ?? 'inside_building',
    level: stud.floor ?? 'G',
  }));
  const byId = new Map(studs.map((stud) => [stud.id, stud]));
  const placed = snapObjectsToStuds(
    foodCourtPlacedObjects(),
    studs.map((stud) => ({ id: stud.id, simPos: stud.simPos, level: stud.level })),
  );
  const walls = foodCourtSample.scene.interiorWalls ?? [];
  const cells = confirmedFuelCells(placed, studs);
  const indoor = studs.filter((stud) => stud.spatialContext === 'inside_building');
  const effects = new SpatialEffectsEngine();
  effects.init(studs);
  effects.setBuildingEnvelope(projectPolygon(polygon), foodCourtSample.scene.exits ?? []);
  effects.setStoreyHeights({ G: 4 });
  effects.setFuelCells(cells);
  const heads = options.hoods ? confirmedSuppression(placed, { G: 4 }) : [];
  if (heads.length > 0) effects.setSuppression(heads);
  const table = placed.find((object) => object.id === 'pizza-table');
  if (!table) throw new Error('food court sample has no pizza table');
  const oil = [...cells.entries()].find(([, cell]) => cell.liquidPool)?.[0];
  if (options.fire === 'oil' && !oil) throw new Error('food court sample has no fryer pool');
  const sourceId = options.fire === 'oil' ? oil! : table.studId;
  const source = byId.get(sourceId);
  if (!source) throw new Error(`fire stud ${sourceId} is not on the grid`);

  const dt = 0.1;
  let peak = 0;
  const openAt: Record<string, number> = {};
  const marks: FoodCourtMark[] = [];
  const stop = untilSec + 10;
  for (let i = 1; i * dt <= stop + 1e-9; i += 1) {
    const t = i * dt;
    if (Math.abs(t - 10) < dt / 2) effectsView(effects).fireSim.ignite([sourceId]);
    effects.step(dt, walls, []);
    peak = Math.max(peak, effects.fuelReleaseKw(sourceId) ?? 0);
    for (const head of heads) {
      if (!(head.id in openAt) && effects.suppressionState(head.id)?.open) {
        openAt[head.id] = Math.round(t - 10);
      }
    }
    const reported = Math.round(t - 10);
    if (!MARKS.some((mark) => Math.abs(t - (mark + 10)) < dt / 2)) continue;
    if (reported > untilSec) continue;
    let studsK15 = 0;
    let reach = 0;
    for (const stud of indoor) {
      const smoke = effects.studStates.get(stud.id)?.smoke ?? 0;
      if (extinctionK(smoke) < 0.15) continue;
      studsK15 += 1;
      reach = Math.max(
        reach,
        Math.hypot(stud.simPos.x - source.simPos.x, stud.simPos.y - source.simPos.y),
      );
    }
    const layer = [...effectsView(effects).layerState.values()].find((live) =>
      live.members.includes(sourceId),
    );
    if (!layer) throw new Error(`no layer for ${sourceId} at T+${reported}`);
    const fireState = effects.studStates.get(sourceId);
    marks.push({
      tSec: reported,
      releaseKw: Math.round(effects.fuelReleaseKw(sourceId) ?? 0),
      peakKw: Math.round(peak),
      hoodsOpen: { ...openAt },
      layerActive: layer.active,
      interfaceM: fixed(layer.zone.interfaceM, 2),
      riseK: fixed(layer.zone.upperK - 293, 1),
      sootG: fixed(layer.zone.sootG, 1),
      kAtFire: fixed(extinctionK(fireState?.smoke ?? 0), 2),
      studsK15,
      reachM: fixed(reach, 1),
      acroleinPpm: fixed(fireState?.fumes?.acrolein ?? 0, 2),
    });
  }
  return {
    fire: options.fire,
    hoods: options.hoods,
    sourceId,
    hoodCount: heads.length,
    marks,
  };
}
