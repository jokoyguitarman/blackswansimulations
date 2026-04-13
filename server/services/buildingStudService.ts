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

import {
  polygonBoundingBox,
  pointInPolygon,
  haversineM,
  distToPolylineM,
  samplePolyline,
} from './geoUtils.js';
import type { OsmBuilding, OsmRouteGeometry } from './osmVicinityService.js';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BlastBand = 'kill' | 'critical' | 'serious' | 'minor' | 'outside';
export type OperationalZone = 'hot' | 'warm' | 'cold' | 'outside';

export type StudType = 'building' | 'outdoor' | 'street';

export interface BuildingStud {
  id: string;
  lat: number;
  lng: number;
  floor: string;
  buildingIndex: number;
  studType: StudType;
  blastBand?: BlastBand;
  operationalZone?: OperationalZone;
  distFromIncidentM?: number;
  /** True when this stud's building is the primary incident site. */
  isIncidentBuilding?: boolean;
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
  /** True when this grid belongs to the primary incident building. */
  isIncidentBuilding?: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_SPACING_M = 5;
const SNAP_MATCH_TOLERANCE_M = 2;
const ROAD_AVOIDANCE_M = 4;

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
          studType: 'building',
        });
      }
      col++;
    }
    row++;
  }

  return studs;
}

/**
 * Identify which building index contains or is nearest to the hazard center.
 * Returns the index into `osmBuildings`, or -1 if none found.
 */
function findIncidentBuildingIndex(
  osmBuildings: OsmBuilding[],
  hazardCenter: { lat: number; lng: number } | null,
): number {
  if (!hazardCenter) return -1;

  for (let i = 0; i < osmBuildings.length; i++) {
    const poly = osmBuildings[i].footprint_polygon;
    if (poly && poly.length >= 3 && pointInPolygon(hazardCenter.lat, hazardCenter.lng, poly)) {
      return i;
    }
  }

  let bestIdx = -1;
  let bestDist = Infinity;
  for (let i = 0; i < osmBuildings.length; i++) {
    const poly = osmBuildings[i].footprint_polygon;
    if (!poly || poly.length < 3) continue;
    const cLat = poly.reduce((s, p) => s + p[0], 0) / poly.length;
    const cLng = poly.reduce((s, p) => s + p[1], 0) / poly.length;
    const d = haversineM(hazardCenter.lat, hazardCenter.lng, cLat, cLng);
    if (d < bestDist && d < 50) {
      bestDist = d;
      bestIdx = i;
    }
  }
  return bestIdx;
}

/**
 * Generate stud grids for buildings.
 * - Interior studs are only generated for the incident building (the one
 *   containing or nearest to `hazardCenter`).
 * - Surrounding buildings are included as polygon-only grids (no studs)
 *   so the frontend can render their outlines as exclusion zones.
 */
export function generateStudGrids(
  osmBuildings: OsmBuilding[],
  spacingM = DEFAULT_SPACING_M,
  hazardCenter?: { lat: number; lng: number } | null,
): StudGrid[] {
  const grids: StudGrid[] = [];
  const incidentIdx = findIncidentBuildingIndex(osmBuildings, hazardCenter ?? null);

  for (let i = 0; i < osmBuildings.length; i++) {
    const b = osmBuildings[i];
    if (!b.footprint_polygon || b.footprint_polygon.length < 3) continue;

    const isIncident = i === incidentIdx;

    const aboveGround = b.building_levels ?? 1;
    const underground = b.building_levels_underground ?? 0;
    const floors: string[] = [];
    for (let u = underground; u > 0; u--) floors.push(`B${u}`);
    floors.push('G');
    for (let l = 1; l < aboveGround; l++) floors.push(`L${l}`);

    if (isIncident) {
      const allStuds: BuildingStud[] = [];
      for (const floor of floors) {
        const studs = generateStudsForPolygon(b.footprint_polygon, spacingM, floor, i);
        for (const s of studs) s.isIncidentBuilding = true;
        allStuds.push(...studs);
      }

      grids.push({
        buildingIndex: i,
        buildingName: b.name,
        polygon: b.footprint_polygon,
        floors,
        studs: allStuds,
        spacingM,
        isIncidentBuilding: true,
      });
    } else {
      grids.push({
        buildingIndex: i,
        buildingName: b.name,
        polygon: b.footprint_polygon,
        floors,
        studs: [],
        spacingM,
        isIncidentBuilding: false,
      });
    }
  }

  return grids;
}

// ---------------------------------------------------------------------------
// Blast radius stud generation — outdoor studs beyond building walls
// ---------------------------------------------------------------------------

const BAND_SPACING_MULTIPLIER: Record<BlastBand, number> = {
  kill: 1,
  critical: 1.6,
  serious: 2.4,
  minor: 3,
  outside: 3,
};

/**
 * Generate a grid of outdoor studs across the blast radius area.
 * Skips points inside any building polygon and points on road surfaces.
 * Uses adaptive spacing — finer near hazard center, coarser in outer bands.
 */
export function generateBlastRadiusStuds(
  hazardCenters: Array<{ lat: number; lng: number }>,
  blastBands: BlastBandConfig[],
  buildingGrids: StudGrid[],
  baseSpacingM = 5,
  roadPolylines: [number, number][][] = [],
): StudGrid | null {
  if (hazardCenters.length === 0 || blastBands.length === 0) return null;

  const sortedBands = [...blastBands].sort((a, b) => a.minM - b.minM);
  const maxRadiusM = Math.max(...sortedBands.map((b) => b.maxM));
  if (maxRadiusM <= 0) return null;

  const buildingPolygons = buildingGrids.map((g) => g.polygon);

  const studs: BuildingStud[] = [];
  const usedKeys = new Set<string>();

  for (let hi = 0; hi < hazardCenters.length; hi++) {
    const hc = hazardCenters[hi];

    // Use the finest spacing (kill zone) for the bounding box grid,
    // then skip points that fall in coarser bands if they don't align
    const dLatBase = baseSpacingM / 111_320;
    const dLngBase = baseSpacingM / (111_320 * Math.cos((hc.lat * Math.PI) / 180));

    const latExtent = maxRadiusM / 111_320;
    const lngExtent = maxRadiusM / (111_320 * Math.cos((hc.lat * Math.PI) / 180));

    let row = 0;
    for (let lat = hc.lat - latExtent; lat <= hc.lat + latExtent; lat += dLatBase) {
      let col = 0;
      for (let lng = hc.lng - lngExtent; lng <= hc.lng + lngExtent; lng += dLngBase) {
        const dist = haversineM(lat, lng, hc.lat, hc.lng);

        if (dist > maxRadiusM) {
          col++;
          continue;
        }

        // Determine which band this point falls in
        let band: BlastBand = 'outside';
        for (const bc of sortedBands) {
          if (dist >= bc.minM && dist < bc.maxM) {
            band = bc.band;
            break;
          }
        }
        if (band === 'outside') {
          col++;
          continue;
        }

        // Adaptive spacing: skip points in outer bands to thin the grid
        const multiplier = BAND_SPACING_MULTIPLIER[band];
        if (multiplier > 1) {
          const step = Math.round(multiplier);
          if (row % step !== 0 || col % step !== 0) {
            col++;
            continue;
          }
        }

        // Dedup across multiple hazard centers
        const key = `${lat.toFixed(7)},${lng.toFixed(7)}`;
        if (usedKeys.has(key)) {
          col++;
          continue;
        }

        // Skip points inside building polygons
        let insideBuilding = false;
        for (const poly of buildingPolygons) {
          if (pointInPolygon(lat, lng, poly)) {
            insideBuilding = true;
            break;
          }
        }
        if (insideBuilding) {
          col++;
          continue;
        }

        // Skip points on road surfaces (~4m from centerline)
        let onRoad = false;
        for (const roadLine of roadPolylines) {
          if (distToPolylineM(lat, lng, roadLine) < ROAD_AVOIDANCE_M) {
            onRoad = true;
            break;
          }
        }
        if (onRoad) {
          col++;
          continue;
        }

        usedKeys.add(key);
        studs.push({
          id: `blast-${hi}-${row}-${col}`,
          lat,
          lng,
          floor: 'G',
          buildingIndex: -1,
          studType: 'outdoor',
          blastBand: band,
          distFromIncidentM: Math.round(dist),
        });

        col++;
      }
      row++;
    }
  }

  if (studs.length === 0) return null;

  return {
    buildingIndex: -1,
    buildingName: 'Blast Radius',
    polygon: [],
    floors: ['G'],
    studs,
    spacingM: baseSpacingM,
  };
}

// ---------------------------------------------------------------------------
// Street stud generation — studs following road centerlines
// ---------------------------------------------------------------------------

const STREET_STUD_SPACING_M = 5;

/**
 * Generate studs along road centerlines within the given radius of a center
 * point. Skips points inside any building polygon.
 */
export function generateStreetStuds(
  center: { lat: number; lng: number },
  routeGeometries: OsmRouteGeometry[],
  buildingGrids: StudGrid[],
  radiusM: number = 300,
  spacingM: number = STREET_STUD_SPACING_M,
): StudGrid | null {
  if (routeGeometries.length === 0) return null;

  const buildingPolygons = buildingGrids.filter((g) => g.polygon.length >= 3).map((g) => g.polygon);

  const studs: BuildingStud[] = [];
  const usedKeys = new Set<string>();

  for (let ri = 0; ri < routeGeometries.length; ri++) {
    const route = routeGeometries[ri];
    if (!route.coordinates || route.coordinates.length < 2) continue;

    const samples = samplePolyline(route.coordinates, spacingM);

    for (let si = 0; si < samples.length; si++) {
      const [lat, lng] = samples[si];

      if (haversineM(lat, lng, center.lat, center.lng) > radiusM) continue;

      const key = `${lat.toFixed(6)},${lng.toFixed(6)}`;
      if (usedKeys.has(key)) continue;

      let insideBuilding = false;
      for (const poly of buildingPolygons) {
        if (pointInPolygon(lat, lng, poly)) {
          insideBuilding = true;
          break;
        }
      }
      if (insideBuilding) continue;

      usedKeys.add(key);
      studs.push({
        id: `street-${ri}-${si}`,
        lat,
        lng,
        floor: 'G',
        buildingIndex: -2,
        studType: 'street',
        distFromIncidentM: Math.round(haversineM(lat, lng, center.lat, center.lng)),
      });
    }
  }

  if (studs.length === 0) return null;

  return {
    buildingIndex: -2,
    buildingName: 'Street Network',
    polygon: [],
    floors: ['G'],
    studs,
    spacingM,
  };
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

const MAX_SNAP_DISTANCE_M = 300;

/**
 * Minimum distance from a point to a polygon edge (in metres).
 * For each consecutive pair of vertices, computes the distance from the
 * point to the closest position on that line segment.
 */
function pointToPolygonDistanceM(lat: number, lng: number, polygon: [number, number][]): number {
  let minDist = Infinity;
  for (let i = 0; i < polygon.length; i++) {
    const [aLat, aLng] = polygon[i];
    const [bLat, bLng] = polygon[(i + 1) % polygon.length];

    const dxAB = bLat - aLat;
    const dyAB = bLng - aLng;
    const lenSq = dxAB * dxAB + dyAB * dyAB;

    let closestLat: number;
    let closestLng: number;

    if (lenSq < 1e-14) {
      closestLat = aLat;
      closestLng = aLng;
    } else {
      const t = Math.max(0, Math.min(1, ((lat - aLat) * dxAB + (lng - aLng) * dyAB) / lenSq));
      closestLat = aLat + t * dxAB;
      closestLng = aLng + t * dyAB;
    }

    const d = haversineM(lat, lng, closestLat, closestLng);
    if (d < minDist) minDist = d;
  }
  return minDist;
}

/**
 * Find the nearest StudGrid to a point that is outside all building polygons.
 * Returns null if no building is within MAX_SNAP_DISTANCE_M.
 */
export function findNearestGrid(
  lat: number,
  lng: number,
  grids: StudGrid[],
  maxDistM: number = MAX_SNAP_DISTANCE_M,
): StudGrid | null {
  let best: StudGrid | null = null;
  let bestDist = Infinity;
  for (const grid of grids) {
    const d = pointToPolygonDistanceM(lat, lng, grid.polygon);
    if (d < bestDist) {
      bestDist = d;
      best = grid;
    }
  }
  return bestDist <= maxDistM ? best : null;
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
 * Convenience: find containing building (or nearest building within 300m),
 * then snap to nearest vacant stud.
 * Returns the original coordinates unchanged if no building is nearby.
 */
export interface SnapResult {
  lat: number;
  lng: number;
  studId: string | null;
  blastBand: BlastBand | null;
  operationalZone: OperationalZone | null;
  distFromIncidentM: number | null;
}

export function snapCoordinate(
  lat: number,
  lng: number,
  floor: string,
  grids: StudGrid[],
  occupiedStudIds: Set<string>,
): SnapResult {
  const grid = findContainingGrid(lat, lng, grids) ?? findNearestGrid(lat, lng, grids);
  if (!grid)
    return {
      lat,
      lng,
      studId: null,
      blastBand: null,
      operationalZone: null,
      distFromIncidentM: null,
    };

  const stud = snapToNearestStud(grid.studs, lat, lng, floor, occupiedStudIds);
  if (!stud)
    return {
      lat,
      lng,
      studId: null,
      blastBand: null,
      operationalZone: null,
      distFromIncidentM: null,
    };

  return {
    lat: stud.lat,
    lng: stud.lng,
    studId: stud.id,
    blastBand: stud.blastBand ?? null,
    operationalZone: stud.operationalZone ?? null,
    distFromIncidentM: stud.distFromIncidentM != null ? Math.round(stud.distFromIncidentM) : null,
  };
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
// Unified grid loader — builds building + outdoor studs, classifies zones
// ---------------------------------------------------------------------------

/**
 * Load fully classified stud grids for a scenario. On cache miss it:
 *  1. Reads buildings + routes from insider_knowledge.osm_vicinity
 *  2. Generates building stud grids (interior studs only for incident building)
 *  3. Reads hazard centers + weapon class from the DB
 *  4. Generates outdoor blast radius studs (avoiding buildings + roads)
 *  5. Generates street studs along road centerlines
 *  6. Classifies all studs with zone + blast band metadata
 *  7. Caches the result
 */
export async function loadClassifiedGrids(scenarioId: string): Promise<StudGrid[]> {
  const cached = getCachedGrids(scenarioId);
  if (cached) return cached;

  const { data: sc } = await supabaseAdmin
    .from('scenarios')
    .select('insider_knowledge')
    .eq('id', scenarioId)
    .single();

  if (!sc) return [];

  const ik = sc.insider_knowledge as Record<string, unknown> | null;
  const osmVicinity = ik?.osm_vicinity as Record<string, unknown> | undefined;
  const buildings = osmVicinity?.buildings as OsmBuilding[] | undefined;

  if (!buildings?.length) return [];

  const routeGeometries = (osmVicinity?.route_geometries ?? []) as OsmRouteGeometry[];

  const [hazRes, locRes] = await Promise.all([
    supabaseAdmin
      .from('scenario_hazards')
      .select('location_lat, location_lng, zones')
      .eq('scenario_id', scenarioId),
    supabaseAdmin
      .from('scenario_locations')
      .select('conditions')
      .eq('scenario_id', scenarioId)
      .eq('pin_category', 'incident_zone'),
  ]);

  const hazardCenters = (hazRes.data ?? [])
    .filter((h: Record<string, unknown>) => h.location_lat != null && h.location_lng != null)
    .map((h: Record<string, unknown>) => ({
      lat: h.location_lat as number,
      lng: h.location_lng as number,
    }));

  const primaryHazard = hazardCenters[0] ?? null;
  const grids = generateStudGrids(buildings, DEFAULT_SPACING_M, primaryHazard);

  const roadPolylines: [number, number][][] = routeGeometries
    .filter((r) => r.coordinates?.length >= 2)
    .map((r) => r.coordinates);

  if (hazardCenters.length > 0) {
    const threatProfile = ik?.threat_profile as Record<string, unknown> | undefined;
    const weaponClass = threatProfile?.weapon_class as string | undefined;
    const blastBands =
      weaponClass === 'explosive'
        ? BLAST_BANDS_EXPLOSIVE
        : weaponClass?.startsWith('melee_')
          ? BLAST_BANDS_MELEE
          : BLAST_BANDS_DEFAULT;

    const outdoorGrid = generateBlastRadiusStuds(
      hazardCenters,
      blastBands,
      grids,
      DEFAULT_SPACING_M,
      roadPolylines,
    );
    if (outdoorGrid) grids.push(outdoorGrid);

    const zonePolygons: Array<{ zone_type: string; polygon: [number, number][] }> = [];
    for (const loc of locRes.data ?? []) {
      const cond = loc.conditions as Record<string, unknown> | null;
      if (cond?.zone_type && cond?.polygon) {
        zonePolygons.push({
          zone_type: cond.zone_type as string,
          polygon: cond.polygon as [number, number][],
        });
      }
    }

    classifyStudZones(grids, hazardCenters, zonePolygons, blastBands);
  }

  // Street studs along road centerlines
  if (primaryHazard && routeGeometries.length > 0) {
    const streetGrid = generateStreetStuds(primaryHazard, routeGeometries, grids, 300);
    if (streetGrid) grids.push(streetGrid);
  }

  setCachedGrids(scenarioId, grids);
  return grids;
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

    const grid =
      findContainingGrid(item.location_lat, item.location_lng, grids) ??
      findNearestGrid(item.location_lat, item.location_lng, grids);
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

// ---------------------------------------------------------------------------
// Automated building backfill
// ---------------------------------------------------------------------------

export interface BackfillResult {
  status: 'already_populated' | 'backfilled' | 'no_buildings_found' | 'no_coordinates' | 'error';
  buildingCount: number;
  message: string;
}

/**
 * Retry building fetch for a scenario that has no buildings in
 * insider_knowledge, then patch them into the DB and invalidate caches.
 *
 * Retries `fetchVenueBuilding` up to `maxAttempts` times with exponential
 * backoff and an expanding search radius.
 */
export async function backfillBuildingsForScenario(
  scenarioId: string,
  opts: { maxAttempts?: number; baseRadiusM?: number } = {},
): Promise<BackfillResult> {
  const { fetchVenueBuilding } = await import('./osmVicinityService.js');
  const maxAttempts = opts.maxAttempts ?? 4;
  const baseRadius = opts.baseRadiusM ?? 300;

  const { data: sc, error: scErr } = await supabaseAdmin
    .from('scenarios')
    .select('center_lat, center_lng, insider_knowledge')
    .eq('id', scenarioId)
    .single();

  if (scErr || !sc) {
    return { status: 'error', buildingCount: 0, message: 'Scenario not found' };
  }

  const ik = (sc.insider_knowledge ?? {}) as Record<string, unknown>;
  const osmVicinity = (ik.osm_vicinity ?? {}) as Record<string, unknown>;

  const existingBuildings = osmVicinity.buildings as unknown[] | undefined;
  if (existingBuildings?.length) {
    return {
      status: 'already_populated',
      buildingCount: existingBuildings.length,
      message: 'Buildings already exist in insider_knowledge',
    };
  }

  let lat = sc.center_lat as number | null;
  let lng = sc.center_lng as number | null;

  if (lat == null || lng == null) {
    const { data: hazards } = await supabaseAdmin
      .from('scenario_hazards')
      .select('location_lat, location_lng')
      .eq('scenario_id', scenarioId)
      .limit(1);

    if (hazards?.length) {
      lat = hazards[0].location_lat as number;
      lng = hazards[0].location_lng as number;
    }
  }

  if (lat == null || lng == null) {
    return {
      status: 'no_coordinates',
      buildingCount: 0,
      message: 'No coordinates available — scenario has no center and no hazards',
    };
  }

  let buildings: import('./osmVicinityService.js').OsmBuilding[] = [];
  const radii = [baseRadius, baseRadius * 1.5, baseRadius * 2, baseRadius * 3];

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const radiusM = radii[Math.min(attempt, radii.length - 1)];
    const delayMs = 3000 * Math.pow(2, attempt);
    try {
      logger.info(
        { scenarioId, attempt: attempt + 1, radiusM },
        'Backfill: fetching buildings from Overpass',
      );
      buildings = await fetchVenueBuilding(lat, lng, radiusM);
      if (buildings.length > 0) break;
    } catch (err) {
      logger.warn(
        { scenarioId, attempt: attempt + 1, err },
        'Backfill: building fetch attempt failed',
      );
    }
    if (attempt < maxAttempts - 1) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  if (buildings.length === 0) {
    return {
      status: 'no_buildings_found',
      buildingCount: 0,
      message: `Overpass returned 0 buildings after ${maxAttempts} attempts`,
    };
  }

  const updatedOsmVicinity = { ...osmVicinity, buildings };
  const updatedIk = { ...ik, osm_vicinity: updatedOsmVicinity };

  const { error: updateErr } = await supabaseAdmin
    .from('scenarios')
    .update({ insider_knowledge: updatedIk })
    .eq('id', scenarioId);

  if (updateErr) {
    logger.error(
      { error: updateErr, scenarioId },
      'Backfill: failed to update insider_knowledge with buildings',
    );
    return { status: 'error', buildingCount: 0, message: 'DB update failed' };
  }

  invalidateGridCache(scenarioId);

  logger.info(
    { scenarioId, buildingCount: buildings.length },
    'Backfill: successfully patched buildings into scenario',
  );

  return {
    status: 'backfilled',
    buildingCount: buildings.length,
    message: `Backfilled ${buildings.length} buildings`,
  };
}
