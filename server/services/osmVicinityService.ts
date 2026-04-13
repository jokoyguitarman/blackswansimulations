/**
 * OSM Vicinity Service
 * Fetches POIs (hospitals, police, routes, CCTV/surveillance) from Overpass API
 * and updates scenario.insider_knowledge.osm_vicinity.
 */

import { logger } from '../lib/logger.js';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { resolveScenarioCenter } from './scenarioCenterService.js';

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.openstreetmap.ru/api/interpreter',
  'https://overpass.nchc.org.tw/api/interpreter',
];

export interface OsmVicinity {
  center?: { lat: number; lng: number };
  radius_meters?: number;
  hospitals?: Array<{ name: string; lat: number; lng: number; address?: string }>;
  police?: Array<{ name: string; lat: number; lng: number; address?: string }>;
  fire_stations?: Array<{ name: string; lat: number; lng: number; address?: string }>;
  emergency_routes?: Array<{
    description: string;
    highway_type?: string;
    one_way?: boolean;
  }>;
  cctv_or_surveillance?: Array<{ location: string; lat: number; lng: number }>;
  buildings?: OsmBuilding[];
  route_geometries?: OsmRouteGeometry[];
  building_footprints?: BuildingFootprint[];
}

function extractLatLng(element: {
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  bounds?: { minlat: number; minlon: number; maxlat: number; maxlon: number };
}): { lat: number; lng: number } | null {
  if (element.lat != null && element.lon != null) {
    return { lat: element.lat, lng: element.lon };
  }
  if (element.center) {
    return { lat: element.center.lat, lng: element.center.lon };
  }
  if (element.bounds) {
    const { minlat, minlon, maxlat, maxlon } = element.bounds;
    return {
      lat: (minlat + maxlat) / 2,
      lng: (minlon + maxlon) / 2,
    };
  }
  return null;
}

function getName(element: { tags?: Record<string, string> }): string {
  const t = element.tags;
  if (!t) return 'Unnamed';
  return t.name || t['addr:street'] || t.operator || 'Unnamed';
}

function getAddress(element: { tags?: Record<string, string> }): string | undefined {
  const t = element.tags;
  if (!t) return undefined;
  const parts = [
    t['addr:street'],
    t['addr:housenumber'],
    t['addr:city'],
    t['addr:postcode'],
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : undefined;
}

const RETRIES_PER_ENDPOINT = 2;
const BACKOFF_BASE_MS = 1500;

/**
 * Send a query to the Overpass API. Each endpoint is tried up to
 * RETRIES_PER_ENDPOINT times with exponential backoff. On exhaustion
 * of retries the next endpoint is attempted.
 */
async function queryOverpass(
  query: string,
  timeoutMs: number = 50_000,
): Promise<Array<Record<string, unknown>>> {
  let lastError: Error | null = null;

  for (let ep = 0; ep < OVERPASS_ENDPOINTS.length; ep++) {
    const endpoint = OVERPASS_ENDPOINTS[ep];

    for (let attempt = 0; attempt < RETRIES_PER_ENDPOINT; attempt++) {
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          body: query,
          headers: { 'Content-Type': 'text/plain' },
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (res.ok) {
          const json = (await res.json()) as {
            elements?: Array<Record<string, unknown>>;
            remark?: string;
          };
          if (
            json.remark &&
            (!json.elements || json.elements.length === 0) &&
            /runtime|timeout|exceeded/i.test(json.remark)
          ) {
            lastError = new Error(`Overpass server-side timeout: ${json.remark} (${endpoint})`);
            logger.warn({ endpoint, remark: json.remark }, 'Overpass server-side timeout detected');
            break;
          }
          return json.elements || [];
        }

        lastError = new Error(`Overpass API error: ${res.status} ${res.statusText} (${endpoint})`);

        if (res.status === 403) {
          logger.warn({ endpoint, status: 403 }, 'Overpass endpoint forbidden, skipping');
          break;
        }

        if (attempt < RETRIES_PER_ENDPOINT - 1) {
          const delay = BACKOFF_BASE_MS * Math.pow(2, attempt);
          logger.warn(
            { endpoint, status: res.status, attempt: attempt + 1, delayMs: delay },
            'Overpass request failed, retrying same endpoint',
          );
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < RETRIES_PER_ENDPOINT - 1) {
          const delay = BACKOFF_BASE_MS * Math.pow(2, attempt);
          logger.warn(
            { endpoint, attempt: attempt + 1, delayMs: delay, err: lastError.message },
            'Overpass request failed, retrying same endpoint',
          );
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
      }
    }

    if (ep < OVERPASS_ENDPOINTS.length - 1) {
      logger.warn(
        { failedEndpoint: endpoint, nextEndpoint: OVERPASS_ENDPOINTS[ep + 1] },
        'Overpass endpoint exhausted retries, trying next endpoint',
      );
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  throw lastError ?? new Error('Overpass API failed after all endpoints');
}

/**
 * Build and run Overpass query for a radius around (lat, lng).
 * Returns raw elements (nodes, ways) for hospitals, police, highways, surveillance.
 */
async function runOverpassQuery(
  lat: number,
  lng: number,
  radiusMeters: number,
): Promise<{ elements: Array<Record<string, unknown>> }> {
  const radius = Math.min(radiusMeters, 50000);
  const query = `
[out:json][timeout:45];
(
  node["amenity"="hospital"](around:${radius},${lat},${lng});
  way["amenity"="hospital"](around:${radius},${lat},${lng});
  node["healthcare"="hospital"](around:${radius},${lat},${lng});
  way["healthcare"="hospital"](around:${radius},${lat},${lng});
  node["amenity"="clinic"](around:${radius},${lat},${lng});
  way["amenity"="clinic"](around:${radius},${lat},${lng});
  node["healthcare"="centre"](around:${radius},${lat},${lng});
  way["healthcare"="centre"](around:${radius},${lat},${lng});
  node["building"="hospital"](around:${radius},${lat},${lng});
  way["building"="hospital"](around:${radius},${lat},${lng});
  node["amenity"="police"](around:${radius},${lat},${lng});
  way["amenity"="police"](around:${radius},${lat},${lng});
  node["amenity"="fire_station"](around:${radius},${lat},${lng});
  way["amenity"="fire_station"](around:${radius},${lat},${lng});
  way["highway"~"^(primary|secondary|tertiary|trunk|motorway)"](around:${radius},${lat},${lng});
  node["man_made"="surveillance"](around:${radius},${lat},${lng});
  node["surveillance:type"="camera"](around:${radius},${lat},${lng});
);
out body center;
`;
  const elements = await queryOverpass(query);
  return { elements };
}

/**
 * Hospital-only Overpass query for tiered radius expansion.
 * Only fetches hospital/clinic/healthcare facilities — lighter and faster.
 */
async function runHospitalOnlyOverpassQuery(
  lat: number,
  lng: number,
  radiusMeters: number,
): Promise<Array<Record<string, unknown>>> {
  const radius = Math.min(radiusMeters, 50000);
  const query = `
[out:json][timeout:30];
(
  node["amenity"="hospital"](around:${radius},${lat},${lng});
  way["amenity"="hospital"](around:${radius},${lat},${lng});
  node["healthcare"="hospital"](around:${radius},${lat},${lng});
  way["healthcare"="hospital"](around:${radius},${lat},${lng});
  node["amenity"="clinic"](around:${radius},${lat},${lng});
  way["amenity"="clinic"](around:${radius},${lat},${lng});
  node["healthcare"="centre"](around:${radius},${lat},${lng});
  way["healthcare"="centre"](around:${radius},${lat},${lng});
  node["building"="hospital"](around:${radius},${lat},${lng});
  way["building"="hospital"](around:${radius},${lat},${lng});
);
out body center;
`;
  return queryOverpass(query);
}

/**
 * Normalize Overpass elements into osm_vicinity shape.
 */
function normalizeToOsmVicinity(
  elements: Array<Record<string, unknown>>,
  center: { lat: number; lng: number },
  radiusMeters: number,
): OsmVicinity {
  const hospitals: OsmVicinity['hospitals'] = [];
  const police: OsmVicinity['police'] = [];
  const fire_stations: OsmVicinity['fire_stations'] = [];
  const emergency_routes: OsmVicinity['emergency_routes'] = [];
  const cctv_or_surveillance: OsmVicinity['cctv_or_surveillance'] = [];

  const seenHospitals = new Set<string>();
  const seenPolice = new Set<string>();
  const seenFireStations = new Set<string>();
  const seenRoutes = new Set<string>();
  const seenCctv = new Set<string>();

  for (const el of elements) {
    const tags = (el.tags as Record<string, string>) || {};
    const pos = extractLatLng(el as Parameters<typeof extractLatLng>[0]);
    if (!pos) continue;

    const key = `${pos.lat.toFixed(5)}-${pos.lng.toFixed(5)}`;

    const isHospital =
      tags.amenity === 'hospital' ||
      tags.healthcare === 'hospital' ||
      tags.amenity === 'clinic' ||
      tags.healthcare === 'centre' ||
      tags.building === 'hospital';
    if (isHospital) {
      if (!seenHospitals.has(key)) {
        seenHospitals.add(key);
        hospitals.push({
          name: getName(el as { tags?: Record<string, string> }),
          lat: pos.lat,
          lng: pos.lng,
          address: getAddress(el as { tags?: Record<string, string> }),
        });
      }
    } else if (tags.amenity === 'police') {
      if (!seenPolice.has(key)) {
        seenPolice.add(key);
        police.push({
          name: getName(el as { tags?: Record<string, string> }),
          lat: pos.lat,
          lng: pos.lng,
          address: getAddress(el as { tags?: Record<string, string> }),
        });
      }
    } else if (tags.amenity === 'fire_station') {
      if (!seenFireStations.has(key)) {
        seenFireStations.add(key);
        fire_stations.push({
          name: getName(el as { tags?: Record<string, string> }),
          lat: pos.lat,
          lng: pos.lng,
          address: getAddress(el as { tags?: Record<string, string> }),
        });
      }
    } else if (tags.highway) {
      const desc = tags.name || tags.ref || `${tags.highway} road`;
      const routeKey = `${desc}-${tags.highway}`;
      if (!seenRoutes.has(routeKey)) {
        seenRoutes.add(routeKey);
        emergency_routes.push({
          description: desc,
          highway_type: tags.highway,
          one_way: tags.oneway === 'yes',
        });
      }
    } else if (tags.man_made === 'surveillance' || tags['surveillance:type'] === 'camera') {
      if (!seenCctv.has(key)) {
        seenCctv.add(key);
        cctv_or_surveillance.push({
          location: getName(el as { tags?: Record<string, string> }),
          lat: pos.lat,
          lng: pos.lng,
        });
      }
    }
  }

  return {
    center: { lat: center.lat, lng: center.lng },
    radius_meters: radiusMeters,
    hospitals: hospitals.length > 0 ? hospitals : undefined,
    police: police.length > 0 ? police : undefined,
    fire_stations: fire_stations.length > 0 ? fire_stations : undefined,
    emergency_routes: emergency_routes.length > 0 ? emergency_routes : undefined,
    cctv_or_surveillance: cctv_or_surveillance.length > 0 ? cctv_or_surveillance : undefined,
  };
}

// ---------------------------------------------------------------------------
// Haversine helper (metres)
// ---------------------------------------------------------------------------

function haversine(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ---------------------------------------------------------------------------
// Generic Overpass runner (accepts arbitrary query text)
// ---------------------------------------------------------------------------

async function runRawOverpassQuery(
  query: string,
  timeoutMs?: number,
): Promise<Array<Record<string, unknown>>> {
  return queryOverpass(query, timeoutMs);
}

// ---------------------------------------------------------------------------
// Open Spaces query — parking, parks, fields, plazas within a radius
// ---------------------------------------------------------------------------

export interface OsmOpenSpace {
  name: string;
  lat: number;
  lng: number;
  type: string;
  osm_tag: string;
  area_m2: number | null;
  distance_from_center_m: number;
}

function estimateAreaM2(bounds: {
  minlat: number;
  minlon: number;
  maxlat: number;
  maxlon: number;
}): number {
  const dLat = (bounds.maxlat - bounds.minlat) * 111320;
  const midLatRad = (((bounds.minlat + bounds.maxlat) / 2) * Math.PI) / 180;
  const dLng = (bounds.maxlon - bounds.minlon) * 111320 * Math.cos(midLatRad);
  return Math.round(dLat * dLng);
}

export async function fetchOsmOpenSpaces(
  lat: number,
  lng: number,
  radiusMeters: number = 1500,
): Promise<OsmOpenSpace[]> {
  const radius = Math.min(radiusMeters, 5000);
  const query = `
[out:json][timeout:25];
(
  node["amenity"="parking"](around:${radius},${lat},${lng});
  way["amenity"="parking"](around:${radius},${lat},${lng});
  way["leisure"~"^(park|pitch|playground|garden|common|recreation_ground)$"](around:${radius},${lat},${lng});
  way["landuse"~"^(grass|meadow|recreation_ground|brownfield|commercial|retail|industrial)$"](around:${radius},${lat},${lng});
  way["place"="square"](around:${radius},${lat},${lng});
  way["highway"="pedestrian"](around:${radius},${lat},${lng});
  way["highway"="living_street"](around:${radius},${lat},${lng});
  way["highway"="service"]["service"="alley"](around:${radius},${lat},${lng});
  way["amenity"="marketplace"](around:${radius},${lat},${lng});
  way["covered"="yes"]["highway"~"^(footway|pedestrian|path)$"](around:${radius},${lat},${lng});
);
out body center;
`;

  const elements = await runRawOverpassQuery(query);
  const seen = new Set<string>();
  const results: OsmOpenSpace[] = [];

  for (const el of elements) {
    const tags = (el.tags as Record<string, string>) || {};
    const pos = extractLatLng(el as Parameters<typeof extractLatLng>[0]);
    if (!pos) continue;

    const dedup = `${pos.lat.toFixed(4)}-${pos.lng.toFixed(4)}`;
    if (seen.has(dedup)) continue;
    seen.add(dedup);

    let type: string;
    let osmTag: string;
    if (tags.amenity === 'parking') {
      type = 'parking';
      osmTag = 'amenity=parking';
    } else if (tags.amenity === 'marketplace') {
      type = 'marketplace';
      osmTag = 'amenity=marketplace';
    } else if (tags.leisure) {
      type = tags.leisure;
      osmTag = `leisure=${tags.leisure}`;
    } else if (tags.landuse) {
      type = tags.landuse;
      osmTag = `landuse=${tags.landuse}`;
    } else if (tags.place === 'square') {
      type = 'square';
      osmTag = 'place=square';
    } else if (tags.highway === 'pedestrian') {
      type = 'pedestrian_street';
      osmTag = 'highway=pedestrian';
    } else if (tags.highway === 'living_street') {
      type = 'living_street';
      osmTag = 'highway=living_street';
    } else if (tags.highway === 'service' && tags.service === 'alley') {
      type = 'alley';
      osmTag = 'highway=service+service=alley';
    } else if (tags.covered === 'yes' && tags.highway) {
      type = 'covered_walkway';
      osmTag = `highway=${tags.highway}+covered=yes`;
    } else {
      continue;
    }

    const bounds = (
      el as { bounds?: { minlat: number; minlon: number; maxlat: number; maxlon: number } }
    ).bounds;
    const area = bounds ? estimateAreaM2(bounds) : null;
    const dist = Math.round(haversine(lat, lng, pos.lat, pos.lng));

    results.push({
      name: getName(el as { tags?: Record<string, string> }),
      lat: pos.lat,
      lng: pos.lng,
      type,
      osm_tag: osmTag,
      area_m2: area,
      distance_from_center_m: dist,
    });
  }

  results.sort((a, b) => a.distance_from_center_m - b.distance_from_center_m);

  const MAX_RESULTS = 40;
  logger.info(
    { total: results.length, returned: Math.min(results.length, MAX_RESULTS), radius },
    'OSM open spaces fetched',
  );
  return results.slice(0, MAX_RESULTS);
}

// ---------------------------------------------------------------------------
// Venue Building query — building outlines near the incident center
// ---------------------------------------------------------------------------

export interface OsmBuilding {
  name: string | null;
  lat: number;
  lng: number;
  bounds: { minlat: number; minlon: number; maxlat: number; maxlon: number } | null;
  /** Actual building footprint polygon from OSM — array of [lat, lng] pairs tracing the outline. */
  footprint_polygon?: [number, number][];
  distance_from_center_m: number;
  building_levels?: number;
  building_levels_underground?: number;
  building_use?: string;
  height_m?: number;
}

// ---------------------------------------------------------------------------
// Route Geometry query — road polylines near the incident center
// ---------------------------------------------------------------------------

export interface OsmRouteGeometry {
  name: string;
  highway_type: string;
  one_way: boolean;
  coordinates: [number, number][];
  distance_from_center_m: number;
}

export async function fetchRouteGeometries(
  lat: number,
  lng: number,
  radiusMeters: number = 6000,
): Promise<OsmRouteGeometry[]> {
  const radius = Math.min(radiusMeters, 8000);
  const query = `
[out:json][timeout:60];
(
  way["highway"~"^(primary|secondary|tertiary|trunk|motorway|residential|unclassified)"](around:${radius},${lat},${lng});
);
out body geom;
`;

  const elements = await runRawOverpassQuery(query);
  const seen = new Set<string>();
  const results: OsmRouteGeometry[] = [];

  for (const el of elements) {
    const tags = (el.tags as Record<string, string>) || {};
    const geometry = el.geometry as Array<{ lat: number; lon: number }> | undefined;
    if (!geometry?.length) continue;

    const name = tags.name || tags.ref || `${tags.highway} road`;
    const dedup = `${name}-${tags.highway}`;
    if (seen.has(dedup)) continue;
    seen.add(dedup);

    const coordinates: [number, number][] = geometry.map((pt) => [pt.lat, pt.lon]);
    const midIdx = Math.floor(coordinates.length / 2);
    const midPt = coordinates[midIdx] ?? coordinates[0];
    const dist = Math.round(haversine(lat, lng, midPt[0], midPt[1]));

    results.push({
      name,
      highway_type: tags.highway,
      one_way: tags.oneway === 'yes',
      coordinates,
      distance_from_center_m: dist,
    });
  }

  results.sort((a, b) => a.distance_from_center_m - b.distance_from_center_m);

  const MAX_ROUTES = 40;
  logger.info(
    { total: results.length, returned: Math.min(results.length, MAX_ROUTES), radius },
    'OSM route geometries fetched',
  );
  return results.slice(0, MAX_ROUTES);
}

export interface FetchLogEntry {
  phase: string;
  status: 'ok' | 'timeout' | 'error' | 'skipped' | 'empty';
  latencyMs: number;
  detail: string;
}

export interface FetchVenueBuildingResult {
  buildings: OsmBuilding[];
  fetchLog: FetchLogEntry[];
}

export async function fetchVenueBuilding(
  lat: number,
  lng: number,
  radiusMeters?: number,
): Promise<OsmBuilding[]>;
export async function fetchVenueBuilding(
  lat: number,
  lng: number,
  radiusMeters: number,
  opts: { withLog: true },
): Promise<FetchVenueBuildingResult>;
export async function fetchVenueBuilding(
  lat: number,
  lng: number,
  radiusMeters?: number,
  opts?: { withLog?: boolean },
): Promise<OsmBuilding[] | FetchVenueBuildingResult> {
  const MAX_BUILDINGS = 5;
  const radius = Math.min(radiusMeters ?? 300, 1000);
  const fetchLog: FetchLogEntry[] = [];
  const wantLog = opts?.withLog === true;

  // Phase 1: try full geometry in a single query (best quality, but heavy)
  const p1Start = Date.now();
  try {
    const GEOM_TIMEOUT_S = 12;
    const geomQuery = `
[out:json][timeout:${GEOM_TIMEOUT_S}];
way["building"](around:${radius},${lat},${lng});
out body geom center bb;
`;
    const elements = await runRawOverpassQuery(geomQuery, GEOM_TIMEOUT_S * 1000 + 3000);
    if (elements.length > 0) {
      const results = elements
        .map((el) => parseOsmBuildingElement(el, lat, lng))
        .filter(Boolean) as OsmBuilding[];
      results.sort((a, b) => a.distance_from_center_m - b.distance_from_center_m);
      const slice = results.slice(0, MAX_BUILDINGS);
      const withPoly = slice.filter(
        (b) => b.footprint_polygon && b.footprint_polygon.length >= 3,
      ).length;

      if (withPoly > 0) {
        fetchLog.push({
          phase: 'phase1',
          status: 'ok',
          latencyMs: Date.now() - p1Start,
          detail: `Full geometry query returned ${elements.length} elements → ${slice.length} buildings (${withPoly} with polygon)`,
        });
        logger.info(
          { total: results.length, returned: slice.length, radius, mode: 'geom' },
          'OSM venue buildings fetched (full geometry)',
        );
        return wantLog ? { buildings: slice, fetchLog } : slice;
      }

      fetchLog.push({
        phase: 'phase1',
        status: 'empty',
        latencyMs: Date.now() - p1Start,
        detail: `Full geometry query returned ${elements.length} elements → ${slice.length} buildings but 0 with polygon — falling through to Phase 2/3`,
      });
      logger.warn(
        { total: results.length, returned: slice.length, radius },
        'OSM Phase 1 returned buildings without polygons; falling through to Phase 2/3',
      );
    } else {
      fetchLog.push({
        phase: 'phase1',
        status: 'empty',
        latencyMs: Date.now() - p1Start,
        detail: 'Full geometry query returned 0 elements',
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isTimeout = /timeout|abort|timed/i.test(msg);
    fetchLog.push({
      phase: 'phase1',
      status: isTimeout ? 'timeout' : 'error',
      latencyMs: Date.now() - p1Start,
      detail: `Full geometry query failed: ${msg.slice(0, 200)}`,
    });
    logger.warn(
      { err, radius },
      'OSM building full-geometry query failed; trying lightweight approach',
    );
  }

  // Phase 2: discover buildings — try with geometry first, fall back to bbox-only
  let bbElements: Array<Record<string, unknown>> = [];
  let phase2Mode = 'geom';
  const BB_TIMEOUT_S = 15;

  const p2Start = Date.now();
  try {
    const geom2Query = `
[out:json][timeout:${BB_TIMEOUT_S}];
way["building"](around:${radius},${lat},${lng});
out body geom center bb;
`;
    bbElements = await runRawOverpassQuery(geom2Query, BB_TIMEOUT_S * 1000 + 5000);
    fetchLog.push({
      phase: 'phase2_geom',
      status: bbElements.length > 0 ? 'ok' : 'empty',
      latencyMs: Date.now() - p2Start,
      detail: `Geom discovery returned ${bbElements.length} elements`,
    });
  } catch (err) {
    phase2Mode = 'bbox';
    const msg = err instanceof Error ? err.message : String(err);
    fetchLog.push({
      phase: 'phase2_geom',
      status: /timeout|abort|timed/i.test(msg) ? 'timeout' : 'error',
      latencyMs: Date.now() - p2Start,
      detail: `Geom discovery failed: ${msg.slice(0, 200)}`,
    });
  }

  if (bbElements.length === 0 && phase2Mode === 'geom') {
    phase2Mode = 'bbox';
  }

  if (bbElements.length === 0 && phase2Mode === 'bbox') {
    const p2bStart = Date.now();
    try {
      const bbQuery = `
[out:json][timeout:${BB_TIMEOUT_S}];
way["building"](around:${radius},${lat},${lng});
out body center bb;
`;
      bbElements = await runRawOverpassQuery(bbQuery, BB_TIMEOUT_S * 1000 + 5000);
      fetchLog.push({
        phase: 'phase2_bbox',
        status: bbElements.length > 0 ? 'ok' : 'empty',
        latencyMs: Date.now() - p2bStart,
        detail: `Bbox-only discovery returned ${bbElements.length} elements`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      fetchLog.push({
        phase: 'phase2_bbox',
        status: /timeout|abort|timed/i.test(msg) ? 'timeout' : 'error',
        latencyMs: Date.now() - p2bStart,
        detail: `Bbox-only discovery failed: ${msg.slice(0, 200)}`,
      });
    }
  }

  if (bbElements.length === 0) {
    fetchLog.push({
      phase: 'result',
      status: 'empty',
      latencyMs: 0,
      detail: 'All Overpass queries returned 0 buildings — no data available',
    });
    logger.info({ radius, phase2Mode }, 'OSM building Phase 2 returned 0 buildings');
    return wantLog ? { buildings: [], fetchLog } : [];
  }

  const candidates = bbElements
    .map((el) => ({ el, parsed: parseOsmBuildingElement(el, lat, lng) }))
    .filter((c) => c.parsed !== null)
    .sort((a, b) => a.parsed!.distance_from_center_m - b.parsed!.distance_from_center_m)
    .slice(0, MAX_BUILDINGS);

  const withGeomAlready = candidates.filter(
    (c) => c.parsed!.footprint_polygon && c.parsed!.footprint_polygon.length >= 3,
  ).length;
  const withBounds = candidates.filter((c) => c.parsed!.bounds != null).length;

  fetchLog.push({
    phase: 'phase2_parse',
    status: 'ok',
    latencyMs: 0,
    detail: `Parsed ${candidates.length} candidates: ${withGeomAlready} with geometry, ${withBounds} with bounds`,
  });

  logger.info(
    { phase2Mode, candidateCount: candidates.length, withGeomAlready, withBounds },
    'OSM building Phase 2 candidates',
  );

  // Phase 3: fetch polygon geometry for candidates that still lack it
  const needsGeom = candidates.filter(
    (c) => !c.parsed!.footprint_polygon || c.parsed!.footprint_polygon.length < 3,
  );
  const wayIds = needsGeom.map((c) => c.el.id as number).filter(Boolean);

  if (wayIds.length > 0) {
    const p3Start = Date.now();
    try {
      const ID_TIMEOUT_S = 10;
      const idQuery = `
[out:json][timeout:${ID_TIMEOUT_S}];
way(id:${wayIds.join(',')});
out geom;
`;
      const geomElements = await runRawOverpassQuery(idQuery, ID_TIMEOUT_S * 1000 + 3000);

      const geomById = new Map<number, Array<{ lat: number; lon: number }>>();
      for (const el of geomElements) {
        const geom = el.geometry as Array<{ lat: number; lon: number }> | undefined;
        if (geom?.length && geom.length >= 3 && el.id) {
          geomById.set(el.id as number, geom);
        }
      }

      for (const c of needsGeom) {
        const geom = geomById.get(c.el.id as number);
        if (geom && c.parsed) {
          c.parsed.footprint_polygon = geom.map((pt) => [pt.lat, pt.lon] as [number, number]);
        }
      }

      fetchLog.push({
        phase: 'phase3',
        status: 'ok',
        latencyMs: Date.now() - p3Start,
        detail: `Requested geometry for ${wayIds.length} IDs → got ${geomById.size} polygons`,
      });
      logger.info(
        { requested: wayIds.length, geomReturned: geomById.size, mode: 'id-geom' },
        'OSM building Phase 3 geometry fetch',
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      fetchLog.push({
        phase: 'phase3',
        status: /timeout|abort|timed/i.test(msg) ? 'timeout' : 'error',
        latencyMs: Date.now() - p3Start,
        detail: `ID geometry query failed for ${wayIds.length} IDs: ${msg.slice(0, 200)}`,
      });
      logger.warn({ err, wayIds }, 'OSM building Phase 3 ID-geometry query failed');
    }
  } else {
    fetchLog.push({
      phase: 'phase3',
      status: 'skipped',
      latencyMs: 0,
      detail: 'All candidates already have geometry — Phase 3 skipped',
    });
  }

  // Bbox rectangle fallback for buildings that still lack polygon geometry
  const results: OsmBuilding[] = [];
  let bboxFallbackCount = 0;
  let skippedNoBounds = 0;
  for (const c of candidates) {
    if (!c.parsed) continue;
    if (!c.parsed.footprint_polygon || c.parsed.footprint_polygon.length < 3) {
      if (c.parsed.bounds) {
        const { minlat, minlon, maxlat, maxlon } = c.parsed.bounds;
        c.parsed.footprint_polygon = [
          [minlat, minlon],
          [minlat, maxlon],
          [maxlat, maxlon],
          [maxlat, minlon],
          [minlat, minlon],
        ];
        bboxFallbackCount++;
        logger.debug(
          { name: c.parsed.name, id: c.el.id },
          'Building polygon from bbox rectangle fallback',
        );
      } else {
        skippedNoBounds++;
        logger.warn(
          { name: c.parsed.name, id: c.el.id },
          'Building has no polygon and no bounds — skipping',
        );
        continue;
      }
    }
    results.push(c.parsed);
  }

  if (bboxFallbackCount > 0 || skippedNoBounds > 0) {
    fetchLog.push({
      phase: 'fallback',
      status: skippedNoBounds > 0 ? 'error' : 'ok',
      latencyMs: 0,
      detail: `Bbox rectangle fallback: ${bboxFallbackCount} buildings used bbox, ${skippedNoBounds} skipped (no bounds)`,
    });
  }

  fetchLog.push({
    phase: 'result',
    status: results.length > 0 ? 'ok' : 'empty',
    latencyMs: 0,
    detail: `Final: ${results.length} buildings with polygon (mode: ${phase2Mode})`,
  });

  logger.info(
    { total: results.length, withPolygon: results.length, radius, phase2Mode },
    'OSM venue buildings fetched',
  );
  return wantLog ? { buildings: results, fetchLog } : results;
}

// ---------------------------------------------------------------------------
// Wide-area building footprints — lightweight polygons for stud classification
// ---------------------------------------------------------------------------

export interface BuildingFootprint {
  name: string | null;
  polygon: [number, number][];
}

/**
 * Fetch building footprint polygons within a large radius.
 * Unlike fetchVenueBuilding (which returns detailed data for ~5 nearest buildings),
 * this returns only polygon outlines for ALL buildings within the radius — used
 * by the stud classification system to tag studs as inside_building / open_air.
 */
export async function fetchBuildingFootprints(
  lat: number,
  lng: number,
  radiusMeters: number = 8000,
): Promise<BuildingFootprint[]> {
  const radius = Math.min(radiusMeters, 10000);
  const TIMEOUT_S = 90;
  const query = `
[out:json][timeout:${TIMEOUT_S}];
way["building"](around:${radius},${lat},${lng});
out body geom;
`;

  try {
    const elements = await runRawOverpassQuery(query, TIMEOUT_S * 1000 + 5000);
    const footprints: BuildingFootprint[] = [];

    for (const el of elements) {
      const geometry = el.geometry as Array<{ lat: number; lon: number }> | undefined;
      if (!geometry || geometry.length < 3) continue;

      const tags = (el.tags as Record<string, string>) || {};
      footprints.push({
        name: tags.name || null,
        polygon: geometry.map((pt) => [pt.lat, pt.lon] as [number, number]),
      });
    }

    logger.info(
      { total: footprints.length, radius },
      'OSM building footprints fetched (wide-area)',
    );
    return footprints;
  } catch (err) {
    logger.warn({ err, radius }, 'Wide-area building footprint fetch failed');
    return [];
  }
}

function parseOsmBuildingElement(
  el: Record<string, unknown>,
  centerLat: number,
  centerLng: number,
): OsmBuilding | null {
  const tags = (el.tags as Record<string, string>) || {};
  const pos = extractLatLng(el as Parameters<typeof extractLatLng>[0]);
  if (!pos) return null;

  const bounds =
    (el as { bounds?: { minlat: number; minlon: number; maxlat: number; maxlon: number } })
      .bounds ?? null;
  const dist = Math.round(haversine(centerLat, centerLng, pos.lat, pos.lng));

  const building: OsmBuilding = {
    name: tags.name || null,
    lat: pos.lat,
    lng: pos.lng,
    bounds,
    distance_from_center_m: dist,
  };

  const geometry = el.geometry as Array<{ lat: number; lon: number }> | undefined;
  if (geometry?.length && geometry.length >= 3) {
    building.footprint_polygon = geometry.map((pt) => [pt.lat, pt.lon] as [number, number]);
  } else {
    const members = (el as Record<string, unknown>).members as
      | Array<{ role?: string; type?: string; geometry?: Array<{ lat: number; lon: number }> }>
      | undefined;
    if (members?.length) {
      const outerPoints: [number, number][] = [];
      for (const m of members) {
        if (m.role === 'outer' && m.geometry?.length) {
          for (const pt of m.geometry) {
            outerPoints.push([pt.lat, pt.lon]);
          }
        }
      }
      if (outerPoints.length >= 3) {
        building.footprint_polygon = outerPoints;
      }
    }
  }

  if (tags['building:levels'])
    building.building_levels = parseInt(tags['building:levels'], 10) || undefined;
  if (tags['building:levels:underground'])
    building.building_levels_underground =
      parseInt(tags['building:levels:underground'], 10) || undefined;
  if (tags['building:use'] || tags.building)
    building.building_use =
      tags['building:use'] || (tags.building !== 'yes' ? tags.building : undefined);
  if (tags.height) building.height_m = parseFloat(tags.height) || undefined;

  return building;
}

/**
 * Fetch OSM vicinity by coordinates (no DB update).
 * Used by War Room to get facility data before scenario exists.
 */
export async function fetchOsmVicinityByCoordinates(
  lat: number,
  lng: number,
  radiusMeters: number = 3000,
): Promise<OsmVicinity> {
  const { elements } = await runOverpassQuery(lat, lng, radiusMeters);
  return normalizeToOsmVicinity(elements, { lat, lng }, radiusMeters);
}

const MIN_HOSPITAL_COUNT = 2;
const HOSPITAL_EXPANSION_TIERS_M = [15000, 25000, 40000];

/**
 * Tiered hospital expansion: if the initial vicinity has fewer than
 * MIN_HOSPITAL_COUNT hospitals, run progressively wider hospital-only
 * Overpass queries until we find enough or exhaust the tiers.
 * Merges results into the existing vicinity in place and returns it.
 */
export async function expandHospitalSearch(
  vicinity: OsmVicinity,
  lat: number,
  lng: number,
  initialRadiusM: number,
): Promise<OsmVicinity> {
  const currentCount = vicinity.hospitals?.length ?? 0;
  if (currentCount >= MIN_HOSPITAL_COUNT) return vicinity;

  const seenKeys = new Set<string>();
  for (const h of vicinity.hospitals ?? []) {
    seenKeys.add(`${h.lat.toFixed(5)}-${h.lng.toFixed(5)}`);
  }

  for (const tierRadius of HOSPITAL_EXPANSION_TIERS_M) {
    if (tierRadius <= initialRadiusM) continue;

    logger.info(
      { lat, lng, tierRadius, currentHospitals: vicinity.hospitals?.length ?? 0 },
      'Expanding hospital search radius',
    );

    try {
      await new Promise((r) => setTimeout(r, 2000));
      const elements = await runHospitalOnlyOverpassQuery(lat, lng, tierRadius);

      for (const el of elements) {
        const tags = (el.tags as Record<string, string>) || {};
        const pos = extractLatLng(el as Parameters<typeof extractLatLng>[0]);
        if (!pos) continue;

        const isHospital =
          tags.amenity === 'hospital' ||
          tags.healthcare === 'hospital' ||
          tags.amenity === 'clinic' ||
          tags.healthcare === 'centre' ||
          tags.building === 'hospital';
        if (!isHospital) continue;

        const key = `${pos.lat.toFixed(5)}-${pos.lng.toFixed(5)}`;
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);

        if (!vicinity.hospitals) vicinity.hospitals = [];
        vicinity.hospitals.push({
          name: getName(el as { tags?: Record<string, string> }),
          lat: pos.lat,
          lng: pos.lng,
          address: getAddress(el as { tags?: Record<string, string> }),
        });
      }

      logger.info(
        { tierRadius, hospitalsAfterExpansion: vicinity.hospitals?.length ?? 0 },
        'Hospital expansion tier complete',
      );

      if ((vicinity.hospitals?.length ?? 0) >= MIN_HOSPITAL_COUNT) break;
    } catch (err) {
      logger.warn({ err, tierRadius }, 'Hospital expansion tier failed; continuing');
    }
  }

  if ((vicinity.hospitals?.length ?? 0) === 0) {
    logger.warn(
      { lat, lng, maxRadius: HOSPITAL_EXPANSION_TIERS_M.at(-1) },
      'No hospitals found even after expanding to maximum tier',
    );
  }

  return vicinity;
}

/**
 * Fetch OSM vicinity for a scenario and update its insider_knowledge.osm_vicinity.
 * Requires scenario to have center_lat, center_lng, vicinity_radius_meters set.
 */
export async function refreshOsmVicinityForScenario(scenarioId: string): Promise<OsmVicinity> {
  const { data: scenario, error: fetchError } = await supabaseAdmin
    .from('scenarios')
    .select('center_lat, center_lng, vicinity_radius_meters, insider_knowledge')
    .eq('id', scenarioId)
    .single();

  if (fetchError || !scenario) {
    throw new Error(`Scenario not found: ${scenarioId}`);
  }

  let lat = scenario.center_lat as number | null;
  let lng = scenario.center_lng as number | null;
  const radius = scenario.vicinity_radius_meters as number | null;

  if (lat == null || lng == null) {
    const resolved = await resolveScenarioCenter(scenarioId);
    if (resolved) {
      lat = resolved.lat;
      lng = resolved.lng;
    }
  }

  if (lat == null || lng == null || radius == null || radius <= 0) {
    throw new Error('Scenario must have center_lat, center_lng, and vicinity_radius_meters set');
  }

  const { elements } = await runOverpassQuery(lat, lng, radius);
  const osmVicinity = normalizeToOsmVicinity(elements, { lat, lng }, radius);

  const existingKnowledge = (scenario.insider_knowledge as Record<string, unknown>) || {};
  const updatedKnowledge = {
    ...existingKnowledge,
    osm_vicinity: osmVicinity,
  };

  const { error: updateError } = await supabaseAdmin
    .from('scenarios')
    .update({ insider_knowledge: updatedKnowledge })
    .eq('id', scenarioId);

  if (updateError) {
    logger.error(
      { error: updateError, scenarioId },
      'Failed to update insider_knowledge with osm_vicinity',
    );
    throw new Error('Failed to save OSM vicinity to scenario');
  }

  logger.info(
    {
      scenarioId,
      hospitals: osmVicinity.hospitals?.length ?? 0,
      police: osmVicinity.police?.length ?? 0,
      fire_stations: osmVicinity.fire_stations?.length ?? 0,
      routes: osmVicinity.emergency_routes?.length ?? 0,
      cctv: osmVicinity.cctv_or_surveillance?.length ?? 0,
    },
    'OSM vicinity refreshed',
  );

  return osmVicinity;
}
