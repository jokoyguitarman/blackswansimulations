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

const RETRIES_PER_ENDPOINT = 1;
const BACKOFF_BASE_MS = 2000;

/**
 * Send a query to the Overpass API. Each endpoint is tried up to
 * RETRIES_PER_ENDPOINT times with exponential backoff. On exhaustion
 * of retries the next endpoint is attempted.
 */
async function queryOverpass(query: string): Promise<Array<Record<string, unknown>>> {
  let lastError: Error | null = null;

  for (let ep = 0; ep < OVERPASS_ENDPOINTS.length; ep++) {
    const endpoint = OVERPASS_ENDPOINTS[ep];

    for (let attempt = 0; attempt < RETRIES_PER_ENDPOINT; attempt++) {
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          body: query,
          headers: { 'Content-Type': 'text/plain' },
          signal: AbortSignal.timeout(15_000),
        });

        if (res.ok) {
          const json = (await res.json()) as { elements?: Array<Record<string, unknown>> };
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

async function runRawOverpassQuery(query: string): Promise<Array<Record<string, unknown>>> {
  return queryOverpass(query);
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

export async function fetchVenueBuilding(
  lat: number,
  lng: number,
  radiusMeters: number = 300,
): Promise<OsmBuilding[]> {
  const radius = Math.min(radiusMeters, 1000);
  const query = `
[out:json][timeout:15];
(
  way["building"](around:${radius},${lat},${lng});
  relation["building"](around:${radius},${lat},${lng});
);
out body geom center bb;
`;

  const elements = await runRawOverpassQuery(query);
  const results: OsmBuilding[] = [];

  for (const el of elements) {
    const tags = (el.tags as Record<string, string>) || {};
    const pos = extractLatLng(el as Parameters<typeof extractLatLng>[0]);
    if (!pos) continue;

    const bounds =
      (el as { bounds?: { minlat: number; minlon: number; maxlat: number; maxlon: number } })
        .bounds ?? null;
    const dist = Math.round(haversine(lat, lng, pos.lat, pos.lng));
    const name = tags.name || null;

    const building: OsmBuilding = {
      name,
      lat: pos.lat,
      lng: pos.lng,
      bounds,
      distance_from_center_m: dist,
    };

    // Extract building footprint polygon — ways have top-level geometry,
    // relations have members with role/geometry arrays.
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

    results.push(building);
  }

  results.sort((a, b) => a.distance_from_center_m - b.distance_from_center_m);

  const MAX_BUILDINGS = 5;
  logger.info(
    { total: results.length, returned: Math.min(results.length, MAX_BUILDINGS), radius },
    'OSM venue buildings fetched',
  );
  return results.slice(0, MAX_BUILDINGS);
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
