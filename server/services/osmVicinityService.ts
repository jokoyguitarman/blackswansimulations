/**
 * OSM Vicinity Service
 * Fetches POIs (hospitals, police, routes, CCTV/surveillance) from Overpass API
 * and updates scenario.insider_knowledge.osm_vicinity.
 */

import { logger } from '../lib/logger.js';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';

const OVERPASS_ENDPOINT = 'https://overpass-api.de/api/interpreter';

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

const OVERPASS_MAX_RETRIES = 3;
const OVERPASS_BACKOFF_MS = 2000;

/**
 * Build and run Overpass query for a radius around (lat, lng).
 * Returns raw elements (nodes, ways) for hospitals, police, highways, surveillance.
 * Retries up to 3 times with exponential backoff on 5xx errors.
 */
async function runOverpassQuery(
  lat: number,
  lng: number,
  radiusMeters: number,
): Promise<{ elements: Array<Record<string, unknown>> }> {
  const radius = Math.min(radiusMeters, 10000); // cap 10km for API sanity
  const query = `
[out:json][timeout:30];
(
  node["amenity"="hospital"](around:${radius},${lat},${lng});
  way["amenity"="hospital"](around:${radius},${lat},${lng});
  node["healthcare"="hospital"](around:${radius},${lat},${lng});
  way["healthcare"="hospital"](around:${radius},${lat},${lng});
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
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < OVERPASS_MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(OVERPASS_ENDPOINT, {
        method: 'POST',
        body: query,
        headers: { 'Content-Type': 'text/plain' },
      });
      if (res.ok) {
        const json = (await res.json()) as { elements?: Array<Record<string, unknown>> };
        return { elements: json.elements || [] };
      }
      lastError = new Error(`Overpass API error: ${res.status} ${res.statusText}`);
      if (res.status >= 500 && attempt < OVERPASS_MAX_RETRIES - 1) {
        const delay = OVERPASS_BACKOFF_MS * Math.pow(2, attempt);
        logger.warn(
          { attempt: attempt + 1, maxRetries: OVERPASS_MAX_RETRIES, delayMs: delay },
          'Overpass API 5xx, retrying',
        );
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw lastError;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < OVERPASS_MAX_RETRIES - 1) {
        const delay = OVERPASS_BACKOFF_MS * Math.pow(2, attempt);
        logger.warn(
          { attempt: attempt + 1, maxRetries: OVERPASS_MAX_RETRIES, delayMs: delay, err },
          'Overpass API request failed, retrying',
        );
        await new Promise((r) => setTimeout(r, delay));
      } else {
        throw lastError;
      }
    }
  }
  throw lastError ?? new Error('Overpass API failed after retries');
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

    if (tags.amenity === 'hospital' || tags.healthcare === 'hospital') {
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
      const routeKey = `${desc}-${key}`;
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
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < OVERPASS_MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(OVERPASS_ENDPOINT, {
        method: 'POST',
        body: query,
        headers: { 'Content-Type': 'text/plain' },
      });
      if (res.ok) {
        const json = (await res.json()) as { elements?: Array<Record<string, unknown>> };
        return json.elements || [];
      }
      lastError = new Error(`Overpass API error: ${res.status} ${res.statusText}`);
      if (res.status >= 500 && attempt < OVERPASS_MAX_RETRIES - 1) {
        const delay = OVERPASS_BACKOFF_MS * Math.pow(2, attempt);
        logger.warn({ attempt: attempt + 1, delayMs: delay }, 'Overpass 5xx, retrying');
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw lastError;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < OVERPASS_MAX_RETRIES - 1) {
        const delay = OVERPASS_BACKOFF_MS * Math.pow(2, attempt);
        logger.warn(
          { attempt: attempt + 1, delayMs: delay, err },
          'Overpass request failed, retrying',
        );
        await new Promise((r) => setTimeout(r, delay));
      } else {
        throw lastError;
      }
    }
  }
  throw lastError ?? new Error('Overpass API failed after retries');
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
    } else if (tags.leisure) {
      type = tags.leisure;
      osmTag = `leisure=${tags.leisure}`;
    } else if (tags.landuse) {
      type = tags.landuse;
      osmTag = `landuse=${tags.landuse}`;
    } else if (tags.place === 'square') {
      type = 'square';
      osmTag = 'place=square';
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
  distance_from_center_m: number;
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
out body center bb;
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

    results.push({ name, lat: pos.lat, lng: pos.lng, bounds, distance_from_center_m: dist });
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

  const lat = scenario.center_lat as number | null;
  const lng = scenario.center_lng as number | null;
  const radius = scenario.vicinity_radius_meters as number | null;

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
