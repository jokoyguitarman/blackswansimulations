import { logger } from '../lib/logger.js';

/**
 * Query Microsoft's Global ML Building Footprints via the Planetary Computer
 * STAC API. Returns building polygons within a bounding box.
 *
 * No API key required. No rate limiting. Free and open data.
 * Source: https://planetarycomputer.microsoft.com/dataset/ms-buildings
 */

const STAC_SEARCH_URL = 'https://planetarycomputer.microsoft.com/api/stac/v1/search';

interface BuildingFootprint {
  lat: number;
  lng: number;
  polygon: [number, number][];
}

/**
 * Determine if a polygon looks like a crude rectangle (4 vertices, roughly axis-aligned).
 * Used to detect low-quality OSM data that should be replaced with Microsoft footprints.
 */
export function isLikelyCrudeRectangle(polygon: [number, number][]): boolean {
  if (polygon.length < 4 || polygon.length > 5) return false;

  const verts =
    polygon.length === 5 && polygon[0][0] === polygon[4][0] && polygon[0][1] === polygon[4][1]
      ? polygon.slice(0, 4)
      : polygon;

  if (verts.length !== 4) return false;

  // Check if edges are roughly axis-aligned (within 10 degrees of horizontal/vertical)
  const THRESHOLD = Math.sin((15 * Math.PI) / 180);
  let axisAligned = 0;
  for (let i = 0; i < 4; i++) {
    const a = verts[i];
    const b = verts[(i + 1) % 4];
    const dx = Math.abs(b[1] - a[1]);
    const dy = Math.abs(b[0] - a[0]);
    const len = Math.hypot(dx, dy);
    if (len < 1e-8) continue;
    const minComponent = Math.min(dx, dy) / len;
    if (minComponent < THRESHOLD) axisAligned++;
  }

  return axisAligned >= 3;
}

/**
 * Query Microsoft Building Footprints for a given bounding box.
 * Returns footprint polygons that fall within the bbox.
 */
export async function queryMsBuildingFootprints(
  lat: number,
  lng: number,
  radiusMeters: number,
): Promise<BuildingFootprint[]> {
  // Convert radius to approximate bbox in degrees
  const latDelta = radiusMeters / 111320;
  const lngDelta = radiusMeters / (111320 * Math.cos((lat * Math.PI) / 180));

  const bbox = [lng - lngDelta, lat - latDelta, lng + lngDelta, lat + latDelta];

  try {
    const resp = await fetch(STAC_SEARCH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        collections: ['ms-buildings'],
        bbox,
        limit: 10,
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!resp.ok) {
      logger.warn({ status: resp.status }, 'MS Buildings STAC search failed');
      return [];
    }

    const data = (await resp.json()) as {
      features?: Array<{
        assets?: Record<string, { href?: string }>;
      }>;
    };

    if (!data.features || data.features.length === 0) {
      logger.info({ lat, lng, radiusMeters }, 'No MS Building Footprint tiles found for area');
      return [];
    }

    // Download the first matching GeoJSON asset
    const feature = data.features[0];
    const dataAsset = feature.assets?.['data'] ?? Object.values(feature.assets ?? {})[0];
    if (!dataAsset?.href) {
      logger.warn('MS Buildings tile found but no data asset href');
      return [];
    }

    const geoResp = await fetch(dataAsset.href, {
      signal: AbortSignal.timeout(30000),
    });
    if (!geoResp.ok) {
      logger.warn(
        { status: geoResp.status, href: dataAsset.href },
        'Failed to download MS Buildings GeoJSON',
      );
      return [];
    }

    const geoData = (await geoResp.json()) as {
      type?: string;
      features?: Array<{
        geometry?: {
          type?: string;
          coordinates?: number[][][];
        };
      }>;
    };

    if (!geoData.features) return [];

    // Filter to buildings within our radius and convert to our format
    const results: BuildingFootprint[] = [];

    for (const f of geoData.features) {
      if (f.geometry?.type !== 'Polygon' || !f.geometry.coordinates?.[0]) continue;

      const ring = f.geometry.coordinates[0];

      // Compute centroid to check if within radius
      let cLat = 0;
      let cLng = 0;
      for (const [rLng, rLat] of ring) {
        cLat += rLat;
        cLng += rLng;
      }
      cLat /= ring.length;
      cLng /= ring.length;

      const dist = haversineM(lat, lng, cLat, cLng);
      if (dist > radiusMeters) continue;

      // Convert GeoJSON [lng, lat] to our [lat, lng] format
      const polygon: [number, number][] = ring.map(([rLng, rLat]) => [rLat, rLng]);

      results.push({ lat: cLat, lng: cLng, polygon });
    }

    logger.info(
      { lat, lng, radiusMeters, totalFeatures: geoData.features.length, matched: results.length },
      'MS Building Footprints queried',
    );

    return results;
  } catch (err) {
    logger.warn({ err, lat, lng }, 'MS Building Footprints query failed');
    return [];
  }
}

/**
 * Find the best matching Microsoft building footprint for a specific building
 * based on its center point.
 */
export function findBestMatch(
  buildingLat: number,
  buildingLng: number,
  footprints: BuildingFootprint[],
  maxDistM: number = 50,
): BuildingFootprint | null {
  let best: BuildingFootprint | null = null;
  let bestDist = maxDistM;

  for (const fp of footprints) {
    const d = haversineM(buildingLat, buildingLng, fp.lat, fp.lng);
    if (d < bestDist) {
      bestDist = d;
      best = fp;
    }
  }

  return best;
}

function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
