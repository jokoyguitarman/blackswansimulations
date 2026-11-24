/**
 * Readers for one building. The saved read is a single SELECT. The live read
 * is the OpenStreetMap object API. Nothing here inserts, updates, or deletes.
 */

import { logger } from '../lib/logger.js';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import type { SavedBuildingRow } from './osmBuildingLookup.js';
import { parseOsmObjectId } from './osmBuildingLookup.js';

const SAVED_COLUMNS =
  'osm_id,name,building_type,building_levels,building_levels_underground,height_m,footprint_polygon_json';

export async function readSavedOsmBuilding(osmId: string): Promise<SavedBuildingRow | null> {
  try {
    const { data, error } = await supabaseAdmin
      .from('osm_sg_buildings')
      .select(SAVED_COLUMNS)
      .eq('osm_id', osmId)
      .maybeSingle();
    if (error) {
      logger.warn({ err: error, osmId }, 'Saved OSM building read failed; using live OSM');
      return null;
    }
    return (data as SavedBuildingRow | null) ?? null;
  } catch (err) {
    logger.warn({ err, osmId }, 'Saved OSM building read failed; using live OSM');
    return null;
  }
}

export async function readLiveOsmBuilding(osmId: string): Promise<unknown> {
  const parsed = parseOsmObjectId(osmId);
  if (!parsed) throw new Error(`bad osm id ${osmId}`);
  const url = `https://api.openstreetmap.org/api/0.6/${parsed.kind}/${parsed.id}/full.json`;
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'prophyion-blackswansimulations/1.0 (building footprint lookup)',
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new Error(`OpenStreetMap API ${response.status} for ${osmId}`);
  }
  return response.json();
}
