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

/**
 * Build and run Overpass query for a radius around (lat, lng).
 * Returns raw elements (nodes, ways) for hospitals, police, highways, surveillance.
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
  way["highway"~"^(primary|secondary|tertiary|trunk|motorway)"](around:${radius},${lat},${lng});
  node["man_made"="surveillance"](around:${radius},${lat},${lng});
  node["surveillance:type"="camera"](around:${radius},${lat},${lng});
);
out body center;
`;
  const res = await fetch(OVERPASS_ENDPOINT, {
    method: 'POST',
    body: query,
    headers: { 'Content-Type': 'text/plain' },
  });
  if (!res.ok) {
    throw new Error(`Overpass API error: ${res.status} ${res.statusText}`);
  }
  const json = (await res.json()) as { elements?: Array<Record<string, unknown>> };
  return { elements: json.elements || [] };
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
  const emergency_routes: OsmVicinity['emergency_routes'] = [];
  const cctv_or_surveillance: OsmVicinity['cctv_or_surveillance'] = [];

  const seenHospitals = new Set<string>();
  const seenPolice = new Set<string>();
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
    emergency_routes: emergency_routes.length > 0 ? emergency_routes : undefined,
    cctv_or_surveillance: cctv_or_surveillance.length > 0 ? cctv_or_surveillance : undefined,
  };
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
      routes: osmVicinity.emergency_routes?.length ?? 0,
      cctv: osmVicinity.cctv_or_surveillance?.length ?? 0,
    },
    'OSM vicinity refreshed',
  );

  return osmVicinity;
}
