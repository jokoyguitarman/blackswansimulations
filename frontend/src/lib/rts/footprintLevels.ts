/**
 * Storeys for a footprint that was just read. Ground keeps its own plan.
 * An upper floor with no plan of its own is not designed, so the sim copies
 * the floor below and the level list marks that copy assumed.
 */

import { LEVEL } from '../evacuation/levelConstants';
import { levelIndex, levelName } from './levels';
import type { LevelDef } from './types';

export const HOLLAND_VILLAGE_OSM_ID = 'way/152752628';

export interface OsmBuildingFootprint {
  osmId: string;
  name: string | null;
  buildingType: string | null;
  levels: number | null;
  underground: number | null;
  heightM: number | null;
  polygon: [number, number][];
  source: 'saved' | 'live_osm';
}

/** A missing or sub-1 count is one storey. A fraction is floored. */
export function floorCount(raw: number | null | undefined): number {
  if (raw == null || !Number.isFinite(raw) || raw < 1) return 1;
  return Math.floor(raw);
}

export function levelsForFootprint(input: {
  aboveGround: number | null;
  underground: number | null;
  /** Upper or basement floors that have a plan of their own. Ground always does. */
  plannedFloorIds?: readonly string[];
}): LevelDef[] {
  const above = floorCount(input.aboveGround);
  let upper = above - 1;
  let under =
    input.underground == null || !Number.isFinite(input.underground) || input.underground < 1
      ? 0
      : Math.floor(input.underground);
  while (1 + upper + under > LEVEL.MAX_LEVELS) {
    if (upper > 0) upper -= 1;
    else under -= 1;
  }

  const ids: string[] = [];
  for (let u = under; u >= 1; u -= 1) ids.push(`B${u}`);
  ids.push('G');
  for (let level = 1; level <= upper; level += 1) ids.push(`L${level}`);

  const planned = new Set(input.plannedFloorIds ?? []);
  return ids.map((id) => ({
    id,
    name: levelName(id),
    index: levelIndex(id),
    heightM: id.startsWith('B') ? LEVEL.DEFAULT_BASEMENT_HEIGHT_M : LEVEL.DEFAULT_STOREY_HEIGHT_M,
    designed: id === 'G' || planned.has(id),
    pedestrianCount: 0,
  }));
}

export function footprintSessionNote(building: OsmBuildingFootprint): string {
  const source = building.source === 'saved' ? 'the saved map data' : 'live OpenStreetMap';
  const name = building.name ?? 'Building';
  let storeys: string;
  if (building.levels == null) {
    storeys = 'No storey count in the map data, so this is the ground floor only.';
  } else {
    const used = floorCount(building.levels);
    storeys =
      used <= 1
        ? 'The map data has one storey.'
        : `The map data says ${building.levels} storeys above ground, so this uses ${used}. Upper floors with no plan are a copy of the floor below and are marked assumed.`;
  }
  const height = building.heightM != null ? ` Tagged height ${building.heightM} m.` : '';
  return `${name} (${building.osmId}). Outline from ${source}. ${storeys}${height} This session is not saved.`;
}
