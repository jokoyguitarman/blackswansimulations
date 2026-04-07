/**
 * Building Stud Service
 *
 * Pre-computes a regular grid of "snap points" (studs) inside building footprint
 * polygons, then provides snap-to-nearest-vacant-stud logic for pin placement.
 * Think Lego studs — each building gets a uniform grid of valid placement slots
 * that respect the building's real outline.
 *
 * Coordinate convention: [lat, lng][] — same as OSM building footprints and geoUtils.
 */

import { polygonBoundingBox, pointInPolygon, haversineM } from './geoUtils.js';
import type { OsmBuilding } from './osmVicinityService.js';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BuildingStud {
  id: string;
  lat: number;
  lng: number;
  floor: string;
  buildingIndex: number;
}

export interface StudGrid {
  buildingIndex: number;
  buildingName: string | null;
  polygon: [number, number][];
  floors: string[];
  studs: BuildingStud[];
  spacingM: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_SPACING_M = 5;
const SNAP_MATCH_TOLERANCE_M = 2;

// ---------------------------------------------------------------------------
// Stud generation
// ---------------------------------------------------------------------------

/**
 * Generate a uniform grid of studs inside a building footprint polygon.
 * The bounding box is filled with a regular grid, then each point is tested
 * with pointInPolygon — only points inside the actual building outline are kept.
 */
export function generateStudsForPolygon(
  polygon: [number, number][],
  spacingM: number,
  floor: string,
  buildingIndex: number,
): BuildingStud[] {
  if (polygon.length < 3) return [];

  const bbox = polygonBoundingBox(polygon);
  const midLat = (bbox.minLat + bbox.maxLat) / 2;
  const dLat = spacingM / 111_320;
  const dLng = spacingM / (111_320 * Math.cos((midLat * Math.PI) / 180));

  const studs: BuildingStud[] = [];
  let row = 0;

  for (let lat = bbox.minLat + dLat / 2; lat <= bbox.maxLat; lat += dLat) {
    let col = 0;
    for (let lng = bbox.minLng + dLng / 2; lng <= bbox.maxLng; lng += dLng) {
      if (pointInPolygon(lat, lng, polygon)) {
        studs.push({
          id: `bldg-${buildingIndex}-${floor}-${row}-${col}`,
          lat,
          lng,
          floor,
          buildingIndex,
        });
      }
      col++;
    }
    row++;
  }

  return studs;
}

/**
 * Generate stud grids for all buildings with footprint polygons.
 * For multi-floor buildings, each floor gets its own copy of the grid
 * (same XY positions, different floor label and stud IDs).
 */
export function generateStudGrids(
  osmBuildings: OsmBuilding[],
  spacingM = DEFAULT_SPACING_M,
): StudGrid[] {
  const grids: StudGrid[] = [];

  for (let i = 0; i < osmBuildings.length; i++) {
    const b = osmBuildings[i];
    if (!b.footprint_polygon || b.footprint_polygon.length < 3) continue;

    const aboveGround = b.building_levels ?? 1;
    const underground = b.building_levels_underground ?? 0;

    const floors: string[] = [];
    for (let u = underground; u > 0; u--) floors.push(`B${u}`);
    floors.push('G');
    for (let l = 1; l < aboveGround; l++) floors.push(`L${l}`);

    const allStuds: BuildingStud[] = [];
    for (const floor of floors) {
      allStuds.push(...generateStudsForPolygon(b.footprint_polygon, spacingM, floor, i));
    }

    if (allStuds.length > 0) {
      grids.push({
        buildingIndex: i,
        buildingName: b.name,
        polygon: b.footprint_polygon,
        floors,
        studs: allStuds,
        spacingM,
      });
    }
  }

  return grids;
}

// ---------------------------------------------------------------------------
// Containment check
// ---------------------------------------------------------------------------

/**
 * Find which StudGrid contains a given point (on a specific floor).
 * Returns null if the point is not inside any building.
 */
export function findContainingGrid(lat: number, lng: number, grids: StudGrid[]): StudGrid | null {
  for (const grid of grids) {
    if (pointInPolygon(lat, lng, grid.polygon)) return grid;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Snap logic
// ---------------------------------------------------------------------------

/**
 * Find the nearest vacant stud to a given point.
 * Only considers studs on the specified floor. Returns null if no vacant stud
 * exists or the point is not inside any building.
 */
export function snapToNearestStud(
  studs: BuildingStud[],
  lat: number,
  lng: number,
  floor: string,
  occupiedStudIds: Set<string>,
): BuildingStud | null {
  let best: BuildingStud | null = null;
  let bestDist = Infinity;

  for (const stud of studs) {
    if (stud.floor !== floor) continue;
    if (occupiedStudIds.has(stud.id)) continue;
    const d = haversineM(lat, lng, stud.lat, stud.lng);
    if (d < bestDist) {
      bestDist = d;
      best = stud;
    }
  }

  return best;
}

/**
 * Convenience: find containing building, then snap to nearest vacant stud.
 * Returns the original coordinates unchanged if the point is not inside any building.
 */
export function snapCoordinate(
  lat: number,
  lng: number,
  floor: string,
  grids: StudGrid[],
  occupiedStudIds: Set<string>,
): { lat: number; lng: number; studId: string | null } {
  const grid = findContainingGrid(lat, lng, grids);
  if (!grid) return { lat, lng, studId: null };

  const stud = snapToNearestStud(grid.studs, lat, lng, floor, occupiedStudIds);
  if (!stud) return { lat, lng, studId: null };

  return { lat: stud.lat, lng: stud.lng, studId: stud.id };
}

// ---------------------------------------------------------------------------
// Occupancy — determine which studs are taken by existing pins
// ---------------------------------------------------------------------------

/**
 * Match a coordinate against stud positions to find the closest stud
 * within tolerance. Returns the stud ID or null.
 */
function matchStudByCoord(
  lat: number,
  lng: number,
  floor: string,
  studs: BuildingStud[],
): string | null {
  let bestId: string | null = null;
  let bestDist = SNAP_MATCH_TOLERANCE_M;

  for (const stud of studs) {
    if (stud.floor !== floor) continue;
    const d = haversineM(lat, lng, stud.lat, stud.lng);
    if (d < bestDist) {
      bestDist = d;
      bestId = stud.id;
    }
  }

  return bestId;
}

/**
 * Query existing scenario pins, hazards, casualties, and (optionally) session
 * placed_assets, then match each coordinate against the stud grids to build
 * the set of occupied stud IDs.
 */
export async function getOccupiedStudIds(
  scenarioId: string,
  grids: StudGrid[],
  sessionId?: string,
): Promise<Set<string>> {
  const occupied = new Set<string>();
  const allStuds = grids.flatMap((g) => g.studs);
  if (allStuds.length === 0) return occupied;

  const markIfMatched = (lat: number, lng: number, floor: string) => {
    const sid = matchStudByCoord(lat, lng, floor, allStuds);
    if (sid) occupied.add(sid);
  };

  try {
    const [locRes, hazRes, casRes] = await Promise.all([
      supabaseAdmin.from('scenario_locations').select('coordinates').eq('scenario_id', scenarioId),
      supabaseAdmin
        .from('scenario_hazards')
        .select('location_lat, location_lng, floor_level')
        .eq('scenario_id', scenarioId),
      supabaseAdmin
        .from('scenario_casualties')
        .select('location_lat, location_lng, floor_level')
        .eq('scenario_id', scenarioId),
    ]);

    for (const row of locRes.data ?? []) {
      const c = row.coordinates as { lat?: number; lng?: number } | null;
      if (c?.lat != null && c?.lng != null) markIfMatched(c.lat, c.lng, 'G');
    }

    for (const row of hazRes.data ?? []) {
      if (row.location_lat != null && row.location_lng != null) {
        markIfMatched(row.location_lat, row.location_lng, row.floor_level ?? 'G');
      }
    }

    for (const row of casRes.data ?? []) {
      if (row.location_lat != null && row.location_lng != null) {
        markIfMatched(row.location_lat, row.location_lng, row.floor_level ?? 'G');
      }
    }

    if (sessionId) {
      const { data: assets } = await supabaseAdmin
        .from('placed_assets')
        .select('geometry, properties')
        .eq('session_id', sessionId)
        .eq('status', 'active');

      for (const row of assets ?? []) {
        const geom = row.geometry as { type?: string; coordinates?: number[] } | null;
        if (geom?.type === 'Point' && geom.coordinates?.length === 2) {
          const [gLng, gLat] = geom.coordinates;
          const floor =
            ((row.properties as Record<string, unknown> | null)?.floor_level as string) ?? 'G';
          markIfMatched(gLat, gLng, floor);
        }
      }
    }
  } catch (err) {
    logger.warn(
      { err, scenarioId, sessionId },
      'Failed to query occupied studs; returning empty set',
    );
  }

  return occupied;
}

// ---------------------------------------------------------------------------
// In-memory cache (per scenario)
// ---------------------------------------------------------------------------

const gridCache = new Map<string, { grids: StudGrid[]; ts: number }>();
const CACHE_TTL_MS = 10 * 60 * 1000;

export function getCachedGrids(scenarioId: string): StudGrid[] | null {
  const entry = gridCache.get(scenarioId);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    gridCache.delete(scenarioId);
    return null;
  }
  return entry.grids;
}

export function setCachedGrids(scenarioId: string, grids: StudGrid[]): void {
  gridCache.set(scenarioId, { grids, ts: Date.now() });
}

export function invalidateGridCache(scenarioId: string): void {
  gridCache.delete(scenarioId);
}

// ---------------------------------------------------------------------------
// Prompt helper — format studs as a menu for AI prompts
// ---------------------------------------------------------------------------

/**
 * Format stud positions as a numbered list suitable for inclusion in AI prompts.
 * Groups studs by building and floor. Limits output to avoid prompt bloat.
 */
export function formatStudsForPrompt(
  grids: StudGrid[],
  occupiedStudIds: Set<string>,
  maxStudsPerFloor = 60,
): string {
  if (grids.length === 0) return '';

  const lines: string[] = [
    '\nAVAILABLE PLACEMENT SLOTS (snap points inside buildings):',
    'When placing a pin INSIDE a building, use the nearest slot coordinate.',
  ];

  for (const grid of grids) {
    const nameLabel = grid.buildingName
      ? `"${grid.buildingName}"`
      : `Building ${grid.buildingIndex + 1}`;

    for (const floor of grid.floors) {
      const floorStuds = grid.studs.filter((s) => s.floor === floor && !occupiedStudIds.has(s.id));

      if (floorStuds.length === 0) continue;

      const limited = floorStuds.slice(0, maxStudsPerFloor);
      lines.push(`\n${nameLabel} — Floor ${floor} (${floorStuds.length} vacant slots):`);

      for (const s of limited) {
        lines.push(`  ${s.id}: (${s.lat.toFixed(6)}, ${s.lng.toFixed(6)})`);
      }

      if (floorStuds.length > maxStudsPerFloor) {
        lines.push(`  ... and ${floorStuds.length - maxStudsPerFloor} more slots`);
      }
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Batch snap — post-process an array of coordinates
// ---------------------------------------------------------------------------

/**
 * Snap an array of items with location_lat / location_lng to studs.
 * Mutates the items in place and returns the set of newly occupied stud IDs.
 */
export function batchSnap<
  T extends { location_lat: number; location_lng: number; floor_level?: string },
>(items: T[], grids: StudGrid[], occupiedStudIds: Set<string>): Set<string> {
  const newlyOccupied = new Set<string>();

  for (const item of items) {
    const floor = item.floor_level ?? 'G';
    const result = snapCoordinate(
      item.location_lat,
      item.location_lng,
      floor,
      grids,
      occupiedStudIds,
    );
    if (result.studId) {
      item.location_lat = result.lat;
      item.location_lng = result.lng;
      occupiedStudIds.add(result.studId);
      newlyOccupied.add(result.studId);
    }
  }

  return newlyOccupied;
}

/**
 * Snap an array of location pin objects (coordinates stored as { lat, lng }).
 * Mutates items in place.
 */
export function batchSnapLocations<T extends { coordinates: { lat: number; lng: number } }>(
  items: T[],
  grids: StudGrid[],
  occupiedStudIds: Set<string>,
): Set<string> {
  const newlyOccupied = new Set<string>();

  for (const item of items) {
    const result = snapCoordinate(
      item.coordinates.lat,
      item.coordinates.lng,
      'G',
      grids,
      occupiedStudIds,
    );
    if (result.studId) {
      item.coordinates.lat = result.lat;
      item.coordinates.lng = result.lng;
      occupiedStudIds.add(result.studId);
      newlyOccupied.add(result.studId);
    }
  }

  return newlyOccupied;
}
