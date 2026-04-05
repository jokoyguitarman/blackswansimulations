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

// ---------------------------------------------------------------------------
// Random point-in-polygon with minimum spacing
// ---------------------------------------------------------------------------

/**
 * Generate a random point inside a polygon ([lat, lng][] convention),
 * ensuring it is at least `minSpacingM` meters from all `existing` points.
 * Falls back to centroid with jitter after `maxAttempts` failures.
 */
export function randomPointInPolygon(
  ring: [number, number][],
  existing: { lat: number; lng: number }[],
  minSpacingM = 15,
  maxAttempts = 60,
): { lat: number; lng: number } {
  const bbox = polygonBoundingBox(ring);

  for (let i = 0; i < maxAttempts; i++) {
    const lat = bbox.minLat + Math.random() * (bbox.maxLat - bbox.minLat);
    const lng = bbox.minLng + Math.random() * (bbox.maxLng - bbox.minLng);

    if (!pointInPolygon(lat, lng, ring)) continue;
    if (isTooClose(lat, lng, existing, minSpacingM)) continue;

    return { lat, lng };
  }

  const [cLat, cLng] = polygonCentroid(ring);
  const jitterLat = (Math.random() - 0.5) * 0.0002;
  const jitterLng = (Math.random() - 0.5) * 0.0002;
  return { lat: cLat + jitterLat, lng: cLng + jitterLng };
}

/**
 * Same as randomPointInPolygon but for GeoJSON [lng, lat][] rings
 * (used by placed_assets geometry).
 */
export function randomPointInGeoJSONPolygon(
  ring: number[][],
  existing: { lat: number; lng: number }[],
  minSpacingM = 15,
  maxAttempts = 60,
): { lat: number; lng: number } {
  const latLngRing: [number, number][] = ring.map((c) => [c[1], c[0]]);
  return randomPointInPolygon(latLngRing, existing, minSpacingM, maxAttempts);
}

function isTooClose(
  lat: number,
  lng: number,
  existing: { lat: number; lng: number }[],
  minM: number,
): boolean {
  for (const pt of existing) {
    if (haversineM(lat, lng, pt.lat, pt.lng) < minM) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Zone determination — reusable across services
// ---------------------------------------------------------------------------

export interface ZoneRadii {
  zone_type: string;
  radius_m: number;
  polygon?: [number, number][];
}

export interface PlacedZoneArea {
  asset_type: string;
  properties?: Record<string, unknown> | null;
  geometry: { type: string; coordinates: unknown };
}

export const ZONE_ORDER = ['hot', 'warm', 'cold'] as const;

export function nextZoneOutward(current: string): string | null {
  const idx = ZONE_ORDER.indexOf(current as (typeof ZONE_ORDER)[number]);
  if (idx < 0 || idx >= ZONE_ORDER.length - 1) return null;
  return ZONE_ORDER[idx + 1];
}

export function zoneDistance(from: string, to: string): number {
  const fi = ZONE_ORDER.indexOf(from as (typeof ZONE_ORDER)[number]);
  const ti = ZONE_ORDER.indexOf(to as (typeof ZONE_ORDER)[number]);
  if (fi < 0 || ti < 0) return 0;
  return ti - fi;
}

/**
 * Determine which zone a point falls in, checking player-drawn zones first,
 * then war-room ground-truth zones, then falling back to radius-based defaults.
 */
export function determineZone(
  lat: number,
  lng: number,
  playerZones: PlacedZoneArea[],
  warRoomZones: ZoneRadii[],
  incidentLat: number,
  incidentLng: number,
): string {
  // 1. Player-drawn hazard_zone polygons (most authoritative)
  for (const zone of playerZones) {
    if (zone.asset_type !== 'hazard_zone') continue;
    const classification = zone.properties?.zone_classification as string | undefined;
    if (!classification) continue;
    const geom = zone.geometry;
    if (geom.type === 'Polygon') {
      const ring = (geom.coordinates as number[][][])[0];
      if (pointInGeoJSONPolygon(lat, lng, ring)) return classification;
    }
  }

  // 2. War room ground-truth zones (sorted inner → outer)
  if (warRoomZones.length > 0) {
    const sorted = [...warRoomZones].sort((a, b) => a.radius_m - b.radius_m);
    for (const z of sorted) {
      if (z.polygon && z.polygon.length > 0) {
        if (pointInPolygon(lat, lng, z.polygon)) return z.zone_type;
      } else {
        const dist = haversineM(lat, lng, incidentLat, incidentLng);
        if (dist <= z.radius_m) return z.zone_type;
      }
    }
  }

  // 3. Fallback: radius-based defaults
  const dist = haversineM(lat, lng, incidentLat, incidentLng);
  if (dist <= 50) return 'hot';
  if (dist <= 150) return 'warm';
  if (dist <= 300) return 'cold';
  return 'outside';
}
