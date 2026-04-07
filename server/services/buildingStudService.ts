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

export type BlastBand = 'kill' | 'critical' | 'serious' | 'minor' | 'outside';
export type OperationalZone = 'hot' | 'warm' | 'cold' | 'outside';

export interface BuildingStud {
  id: string;
  lat: number;
  lng: number;
  floor: string;
  buildingIndex: number;
  blastBand?: BlastBand;
  operationalZone?: OperationalZone;
  distFromIncidentM?: number;
}

export interface BlastBandConfig {
  band: BlastBand;
  minM: number;
  maxM: number;
}

export const BLAST_BANDS_EXPLOSIVE: BlastBandConfig[] = [
  { band: 'kill', minM: 0, maxM: 50 },
  { band: 'critical', minM: 50, maxM: 100 },
  { band: 'serious', minM: 100, maxM: 150 },
  { band: 'minor', minM: 150, maxM: 200 },
];

export const BLAST_BANDS_MELEE: BlastBandConfig[] = [
  { band: 'kill', minM: 0, maxM: 15 },
  { band: 'critical', minM: 15, maxM: 40 },
  { band: 'serious', minM: 40, maxM: 80 },
  { band: 'minor', minM: 80, maxM: 150 },
];

export const BLAST_BANDS_DEFAULT: BlastBandConfig[] = [
  { band: 'kill', minM: 0, maxM: 30 },
  { band: 'critical', minM: 30, maxM: 75 },
  { band: 'serious', minM: 75, maxM: 120 },
  { band: 'minor', minM: 120, maxM: 200 },
];

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
// Zone classification — tag studs with blast band & operational zone
// ---------------------------------------------------------------------------

/**
 * Tag every stud in the grids with its blast band (distance from nearest
 * hazard center) and operational zone (polygon containment in hot/warm/cold).
 * Mutates studs in place.
 */
export function classifyStudZones(
  grids: StudGrid[],
  hazardCenters: Array<{ lat: number; lng: number }>,
  zonePolygons: Array<{ zone_type: string; polygon: [number, number][] }>,
  blastBands: BlastBandConfig[],
): void {
  if (hazardCenters.length === 0 && zonePolygons.length === 0) return;

  const sortedBands = [...blastBands].sort((a, b) => a.minM - b.minM);

  const hotPoly = zonePolygons.find((z) => z.zone_type === 'hot')?.polygon;
  const warmPoly = zonePolygons.find((z) => z.zone_type === 'warm')?.polygon;
  const coldPoly = zonePolygons.find((z) => z.zone_type === 'cold')?.polygon;

  for (const grid of grids) {
    for (const stud of grid.studs) {
      // Distance to nearest hazard center
      let minDist = Infinity;
      for (const hc of hazardCenters) {
        const d = haversineM(stud.lat, stud.lng, hc.lat, hc.lng);
        if (d < minDist) minDist = d;
      }
      stud.distFromIncidentM = minDist;

      // Blast band classification
      let band: BlastBand = 'outside';
      for (const bc of sortedBands) {
        if (minDist >= bc.minM && minDist < bc.maxM) {
          band = bc.band;
          break;
        }
      }
      stud.blastBand = band;

      // Operational zone classification (most restrictive first)
      if (hotPoly && pointInPolygon(stud.lat, stud.lng, hotPoly)) {
        stud.operationalZone = 'hot';
      } else if (warmPoly && pointInPolygon(stud.lat, stud.lng, warmPoly)) {
        stud.operationalZone = 'warm';
      } else if (coldPoly && pointInPolygon(stud.lat, stud.lng, coldPoly)) {
        stud.operationalZone = 'cold';
      } else {
        stud.operationalZone = 'outside';
      }
    }
  }
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
 * Find the nearest vacant stud matching an optional zone filter.
 * Only considers studs on the specified floor whose blastBand and/or
 * operationalZone match the filter (if provided). Returns null if no match.
 */
export function snapToNearestStudInZone(
  studs: BuildingStud[],
  lat: number,
  lng: number,
  floor: string,
  occupiedStudIds: Set<string>,
  filter: { blastBand?: string; operationalZone?: string },
): BuildingStud | null {
  let best: BuildingStud | null = null;
  let bestDist = Infinity;

  for (const stud of studs) {
    if (stud.floor !== floor) continue;
    if (occupiedStudIds.has(stud.id)) continue;
    if (filter.blastBand && stud.blastBand !== filter.blastBand) continue;
    if (filter.operationalZone && stud.operationalZone !== filter.operationalZone) continue;
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

const BLAST_BAND_LABELS: Record<string, string> = {
  kill: 'KILL ZONE — BLACK casualties',
  critical: 'CRITICAL ZONE — RED casualties',
  serious: 'SERIOUS ZONE — YELLOW casualties',
  minor: 'MINOR ZONE — GREEN casualties',
  outside: 'OUTSIDE blast radii',
};

const OP_ZONE_LABELS: Record<string, string> = {
  hot: 'HOT ZONE',
  warm: 'WARM ZONE (triage/staging)',
  cold: 'COLD ZONE (command/transport)',
  outside: 'OUTSIDE zones',
};

/**
 * Format stud positions as a numbered list suitable for inclusion in AI prompts.
 * When studs have zone classification, groups by blast band within each
 * building/floor. Falls back to flat listing if studs are unclassified.
 */
export function formatStudsForPrompt(
  grids: StudGrid[],
  occupiedStudIds: Set<string>,
  maxStudsPerFloor = 60,
): string {
  if (grids.length === 0) return '';

  const hasClassification = grids.some((g) => g.studs.some((s) => s.blastBand != null));

  const lines: string[] = [
    '\nAVAILABLE PLACEMENT SLOTS (snap points inside buildings):',
    'When placing a pin INSIDE a building, use the nearest slot coordinate.',
  ];

  if (hasClassification) {
    lines.push(
      'Slots are grouped by blast-radius zone — pick from the zone matching the casualty triage color.',
    );
  }

  for (const grid of grids) {
    const nameLabel = grid.buildingName
      ? `"${grid.buildingName}"`
      : `Building ${grid.buildingIndex + 1}`;

    for (const floor of grid.floors) {
      const floorStuds = grid.studs.filter((s) => s.floor === floor && !occupiedStudIds.has(s.id));
      if (floorStuds.length === 0) continue;

      if (hasClassification) {
        lines.push(`\n${nameLabel} — Floor ${floor}:`);

        const bandOrder: BlastBand[] = ['kill', 'critical', 'serious', 'minor', 'outside'];
        for (const band of bandOrder) {
          const bandStuds = floorStuds.filter((s) => s.blastBand === band);
          if (bandStuds.length === 0) continue;

          const label = BLAST_BAND_LABELS[band] ?? band;
          const opZone = bandStuds[0]?.operationalZone;
          const opLabel =
            opZone && opZone !== 'outside' ? ` [${OP_ZONE_LABELS[opZone] ?? opZone}]` : '';
          lines.push(`  ${label}${opLabel} (${bandStuds.length} vacant):`);

          const limited = bandStuds.slice(0, Math.ceil(maxStudsPerFloor / bandOrder.length));
          for (const s of limited) {
            lines.push(
              `    ${s.id}: (${s.lat.toFixed(6)}, ${s.lng.toFixed(6)}) ~${Math.round(s.distFromIncidentM ?? 0)}m`,
            );
          }
          if (bandStuds.length > limited.length) {
            lines.push(`    ... and ${bandStuds.length - limited.length} more`);
          }
        }
      } else {
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

// ---------------------------------------------------------------------------
// Triage-aware casualty snap — respects blast band zones
// ---------------------------------------------------------------------------

const TRIAGE_TO_BLAST_BAND: Record<string, BlastBand> = {
  black: 'kill',
  red: 'critical',
  yellow: 'serious',
  green: 'minor',
};

const TRIAGE_SEVERITY_ORDER: string[] = ['black', 'red', 'yellow', 'green'];

const BLAST_BAND_FALLBACK_CHAIN: Record<BlastBand, BlastBand[]> = {
  kill: ['critical', 'serious', 'minor'],
  critical: ['serious', 'minor', 'kill'],
  serious: ['minor', 'critical', 'kill'],
  minor: ['serious', 'critical', 'kill'],
  outside: ['minor', 'serious', 'critical', 'kill'],
};

/**
 * Snap casualties to building studs respecting blast-band zones.
 * Processes BLACK casualties first (most spatially constrained),
 * then RED, YELLOW, GREEN. Each victim snaps to a stud within its
 * designated blast band; if that band is full, falls back outward.
 */
export function batchSnapCasualties<
  T extends {
    location_lat: number;
    location_lng: number;
    floor_level?: string;
    conditions: Record<string, unknown>;
  },
>(items: T[], grids: StudGrid[], occupiedStudIds: Set<string>): Set<string> {
  const newlyOccupied = new Set<string>();

  const sorted = [...items].sort((a, b) => {
    const aColor = ((a.conditions?.triage_color as string) ?? 'green').toLowerCase();
    const bColor = ((b.conditions?.triage_color as string) ?? 'green').toLowerCase();
    const aIdx = TRIAGE_SEVERITY_ORDER.indexOf(aColor);
    const bIdx = TRIAGE_SEVERITY_ORDER.indexOf(bColor);
    return (aIdx === -1 ? 99 : aIdx) - (bIdx === -1 ? 99 : bIdx);
  });

  for (const item of sorted) {
    const floor = item.floor_level ?? 'G';
    const triageColor = ((item.conditions?.triage_color as string) ?? '').toLowerCase();
    const targetBand = TRIAGE_TO_BLAST_BAND[triageColor];

    const grid = findContainingGrid(item.location_lat, item.location_lng, grids);
    if (!grid) continue;

    const studsClassified = grid.studs.some((s) => s.blastBand != null);
    if (!studsClassified || !targetBand) {
      const stud = snapToNearestStud(
        grid.studs,
        item.location_lat,
        item.location_lng,
        floor,
        occupiedStudIds,
      );
      if (stud) {
        item.location_lat = stud.lat;
        item.location_lng = stud.lng;
        occupiedStudIds.add(stud.id);
        newlyOccupied.add(stud.id);
      }
      continue;
    }

    // Try target band first, then fallback chain
    const bandsToTry: BlastBand[] = [targetBand, ...(BLAST_BAND_FALLBACK_CHAIN[targetBand] ?? [])];
    let snapped = false;
    for (const band of bandsToTry) {
      const stud = snapToNearestStudInZone(
        grid.studs,
        item.location_lat,
        item.location_lng,
        floor,
        occupiedStudIds,
        { blastBand: band },
      );
      if (stud) {
        item.location_lat = stud.lat;
        item.location_lng = stud.lng;
        occupiedStudIds.add(stud.id);
        newlyOccupied.add(stud.id);
        snapped = true;
        break;
      }
    }

    // Last resort: any vacant stud in the building
    if (!snapped) {
      const stud = snapToNearestStud(
        grid.studs,
        item.location_lat,
        item.location_lng,
        floor,
        occupiedStudIds,
      );
      if (stud) {
        item.location_lat = stud.lat;
        item.location_lng = stud.lng;
        occupiedStudIds.add(stud.id);
        newlyOccupied.add(stud.id);
      }
    }
  }

  return newlyOccupied;
}
