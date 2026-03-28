/**
 * Shared geospatial utilities — single source of truth for point-in-polygon,
 * haversine distance, circle-to-polygon conversion, and polygon scaling.
 *
 * Coordinate convention for zone polygons: [lat, lng][]
 * GeoJSON rings from placed_assets use [lng, lat][] — use pointInGeoJSONPolygon
 * for those callers.
 */

// ---------------------------------------------------------------------------
// Haversine distance (meters)
// ---------------------------------------------------------------------------

export function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ---------------------------------------------------------------------------
// Point-in-polygon  (ray-casting)
// ---------------------------------------------------------------------------

/** Ring uses [lat, lng][] convention (same as OSM building footprints). */
export function pointInPolygon(lat: number, lng: number, ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [latI, lngI] = ring[i];
    const [latJ, lngJ] = ring[j];
    if (lngI > lng !== lngJ > lng && lat < ((latJ - latI) * (lng - lngI)) / (lngJ - lngI) + latI) {
      inside = !inside;
    }
  }
  return inside;
}

/** Ring uses GeoJSON [lng, lat][] convention (placed_assets geometry). */
export function pointInGeoJSONPolygon(lat: number, lng: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const lngI = ring[i][0],
      latI = ring[i][1];
    const lngJ = ring[j][0],
      latJ = ring[j][1];
    if (lngI > lng !== lngJ > lng && lat < ((latJ - latI) * (lng - lngI)) / (lngJ - lngI) + latI) {
      inside = !inside;
    }
  }
  return inside;
}

// ---------------------------------------------------------------------------
// Polygon helpers
// ---------------------------------------------------------------------------

/** Average of vertices — works well for convex or mildly concave shapes. */
export function polygonCentroid(ring: [number, number][]): [number, number] {
  let sLat = 0;
  let sLng = 0;
  for (const [lat, lng] of ring) {
    sLat += lat;
    sLng += lng;
  }
  const n = ring.length || 1;
  return [sLat / n, sLng / n];
}

/**
 * Approximate a circle as a closed polygon ring.
 * Uses a destination-point formula so the polygon is geographically accurate.
 */
export function circleToPolygon(
  centerLat: number,
  centerLng: number,
  radiusM: number,
  segments = 32,
): [number, number][] {
  const ring: [number, number][] = [];
  const R = 6371000;
  const latRad = (centerLat * Math.PI) / 180;
  const lngRad = (centerLng * Math.PI) / 180;
  const angDist = radiusM / R;

  for (let i = 0; i < segments; i++) {
    const bearing = (2 * Math.PI * i) / segments;
    const destLat = Math.asin(
      Math.sin(latRad) * Math.cos(angDist) +
        Math.cos(latRad) * Math.sin(angDist) * Math.cos(bearing),
    );
    const destLng =
      lngRad +
      Math.atan2(
        Math.sin(bearing) * Math.sin(angDist) * Math.cos(latRad),
        Math.cos(angDist) - Math.sin(latRad) * Math.sin(destLat),
      );
    ring.push([(destLat * 180) / Math.PI, (destLng * 180) / Math.PI]);
  }
  ring.push(ring[0]);
  return ring;
}

/**
 * Scale a polygon outward from a centroid by a given factor.
 * factor > 1 expands, factor < 1 shrinks.
 * Operates in lat/lng space — acceptable for small-area polygons.
 */
export function scalePolygonFromCentroid(
  ring: [number, number][],
  centroidLat: number,
  centroidLng: number,
  scaleFactor: number,
): [number, number][] {
  return ring.map(([lat, lng]) => [
    centroidLat + (lat - centroidLat) * scaleFactor,
    centroidLng + (lng - centroidLng) * scaleFactor,
  ]);
}

/**
 * Compute a bounding box from a polygon ring ([lat, lng][] convention).
 * Returns { minLat, maxLat, minLng, maxLng }.
 */
export function polygonBoundingBox(ring: [number, number][]): {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
} {
  let minLat = Infinity,
    maxLat = -Infinity,
    minLng = Infinity,
    maxLng = -Infinity;
  for (const [lat, lng] of ring) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
  }
  return { minLat, maxLat, minLng, maxLng };
}
