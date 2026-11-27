/**
 * Building wiring shared by every SpatialEffectsEngine the editor builds:
 * the live engine and the setup preview. Both must see the same stairs,
 * lifts, storey heights and shell, or the preview shows smoke that cannot
 * leave its storey.
 */
import type { ExitDef, Vec2 } from '../evacuation/types';
import { linkLevels, normaliseStairwell, type ShaftLink } from './levels';
import type { SpatialEffectsEngine } from './spatialEffects';
import type { LevelDef, Stairwell } from './types';

/** Saved floor name to level id. A missing floor or 'Ground' is G. */
export function storeyId(floor: string | undefined): string {
  if (!floor || floor === 'Ground') return 'G';
  return floor;
}

export function storeyHeights(levels: readonly LevelDef[]): Record<string, number> {
  return Object.fromEntries(levels.map((l) => [l.id, l.heightM]));
}

export function shaftLinksFor(
  stairwells: readonly Stairwell[],
  levels: readonly LevelDef[],
): ShaftLink[] {
  const defs = [...levels];
  const heightByLevel = storeyHeights(defs);
  return stairwells.map((sw) => {
    const norm = normaliseStairwell(sw, defs);
    return {
      id: norm.id,
      pos: norm.pos,
      levels: linkLevels(norm, defs),
      kind: norm.kind ?? 'stair',
      blocked: norm.blocked,
      widthM: norm.widthM,
      heightByLevel,
    };
  });
}

export interface EffectsBuilding {
  stairwells: readonly Stairwell[];
  levels: readonly LevelDef[];
  vertices: readonly Vec2[];
  exits: readonly ExitDef[];
}

/** Stairs and lifts, storey heights and the outside wall. Call after `init`. */
export function attachBuilding(engine: SpatialEffectsEngine, building: EffectsBuilding): void {
  engine.setVerticalLinks(shaftLinksFor(building.stairwells, building.levels));
  engine.setStoreyHeights(storeyHeights(building.levels));
  engine.setBuildingEnvelope(building.vertices, building.exits);
}
