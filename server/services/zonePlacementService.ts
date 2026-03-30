/**
 * Zone-aware pin placement — places spawned pins relative to player-drawn
 * hazard zones so that pins whose narrative says "outside" don't land inside
 * the hot zone, perimeter breach pins appear at zone boundaries, etc.
 *
 * Falls back to simple jitter around a reference point when no zones exist.
 */

import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { polygonBoundingBox, haversineM } from './geoUtils.js';
import { logger } from '../lib/logger.js';

/* ── Types ── */

interface ZonePolygon {
  classification: 'hot' | 'warm' | 'cold';
  ring: [number, number][]; // [lat, lng][]
}

interface Coord {
  lat: number;
  lng: number;
}

/* Zone severity ordering (innermost → outermost) */
const ZONE_ORDER: Record<string, number> = { hot: 0, warm: 1, cold: 2 };

/* ── Fetch player-drawn zones ── */

async function fetchSessionZones(sessionId: string): Promise<ZonePolygon[]> {
  const { data } = await supabaseAdmin
    .from('placed_assets')
    .select('asset_type, geometry, properties')
    .eq('session_id', sessionId)
    .eq('asset_type', 'hazard_zone')
    .eq('status', 'active');

  if (!data || data.length === 0) return [];

  const zones: ZonePolygon[] = [];
  for (const row of data) {
    const geom = row.geometry as { type: string; coordinates: unknown };
    if (geom.type !== 'Polygon') continue;

    const classification = (row.properties as Record<string, unknown>)?.zone_classification as
      | string
      | undefined;
    if (!classification || !['hot', 'warm', 'cold'].includes(classification)) continue;

    const geoRing = (geom.coordinates as number[][][])[0];
    if (!geoRing || geoRing.length < 3) continue;

    // Convert GeoJSON [lng, lat] to our [lat, lng] convention
    const ring: [number, number][] = geoRing.map((c) => [c[1], c[0]]);

    zones.push({ classification: classification as 'hot' | 'warm' | 'cold', ring });
  }

  // Sort innermost first (hot < warm < cold)
  zones.sort((a, b) => (ZONE_ORDER[a.classification] ?? 9) - (ZONE_ORDER[b.classification] ?? 9));
  return zones;
}

/* ── Helpers ── */

function isInsideAnyZone(lat: number, lng: number, zones: ZonePolygon[]): boolean {
  for (const z of zones) {
    if (pointInLatLngRing(lat, lng, z.ring)) return true;
  }
  return false;
}

function isInsideZone(lat: number, lng: number, zone: ZonePolygon): boolean {
  return pointInLatLngRing(lat, lng, zone.ring);
}

function pointInLatLngRing(lat: number, lng: number, ring: [number, number][]): boolean {
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

function jitter(ref: Coord, radiusM: number): Coord {
  const offsetDeg = radiusM / 111_320;
  return {
    lat: ref.lat + (Math.random() - 0.5) * 2 * offsetDeg,
    lng: ref.lng + (Math.random() - 0.5) * 2 * offsetDeg,
  };
}

/* ── Public API ── */

/**
 * Place a pin OUTSIDE all player-drawn zones.
 * Ideal for convergent crowds, perimeter bystanders, etc.
 * If no zones exist, falls back to a jittered offset from `ref`.
 */
export async function placeOutsideAllZones(
  sessionId: string,
  ref: Coord,
  fallbackRadiusM = 30,
  maxAttempts = 80,
): Promise<Coord> {
  try {
    const zones = await fetchSessionZones(sessionId);
    if (zones.length === 0) return jitter(ref, fallbackRadiusM);

    // Build a bounding box from the outermost zone expanded by ~60m
    const outermost = zones[zones.length - 1];
    const bbox = polygonBoundingBox(outermost.ring);
    const pad = 0.001; // ~110m padding
    const expandedBbox = {
      minLat: bbox.minLat - pad,
      maxLat: bbox.maxLat + pad,
      minLng: bbox.minLng - pad,
      maxLng: bbox.maxLng + pad,
    };

    for (let i = 0; i < maxAttempts; i++) {
      const lat = expandedBbox.minLat + Math.random() * (expandedBbox.maxLat - expandedBbox.minLat);
      const lng = expandedBbox.minLng + Math.random() * (expandedBbox.maxLng - expandedBbox.minLng);

      if (!isInsideAnyZone(lat, lng, zones)) {
        // Ensure it's not too far from the scene (within ~200m of ref)
        if (haversineM(lat, lng, ref.lat, ref.lng) < 200) {
          return { lat, lng };
        }
      }
    }

    // Fallback: push outward from outermost zone centroid
    const cLat = outermost.ring.reduce((s, p) => s + p[0], 0) / outermost.ring.length;
    const cLng = outermost.ring.reduce((s, p) => s + p[1], 0) / outermost.ring.length;
    const angle = Math.random() * 2 * Math.PI;
    const pushM = 120;
    const dLat = (pushM * Math.cos(angle)) / 111_320;
    const dLng = (pushM * Math.sin(angle)) / (111_320 * Math.cos((cLat * Math.PI) / 180));
    return { lat: cLat + dLat, lng: cLng + dLng };
  } catch (err) {
    logger.warn({ err, sessionId }, 'Zone placement failed, using jitter fallback');
    return jitter(ref, fallbackRadiusM);
  }
}

/**
 * Place a pin OUTSIDE a specific zone type.
 * E.g., "outside hot zone" means NOT inside the hot zone but possibly inside warm/cold.
 * If the target zone doesn't exist, falls back to jitter.
 */
export async function placeOutsideZoneType(
  sessionId: string,
  zoneType: 'hot' | 'warm' | 'cold',
  ref: Coord,
  fallbackRadiusM = 30,
  maxAttempts = 80,
): Promise<Coord> {
  try {
    const zones = await fetchSessionZones(sessionId);
    const targetZones = zones.filter((z) => z.classification === zoneType);
    if (targetZones.length === 0) return jitter(ref, fallbackRadiusM);

    const target = targetZones[0];
    const bbox = polygonBoundingBox(target.ring);
    const pad = 0.0008;
    const expandedBbox = {
      minLat: bbox.minLat - pad,
      maxLat: bbox.maxLat + pad,
      minLng: bbox.minLng - pad,
      maxLng: bbox.maxLng + pad,
    };

    for (let i = 0; i < maxAttempts; i++) {
      const lat = expandedBbox.minLat + Math.random() * (expandedBbox.maxLat - expandedBbox.minLat);
      const lng = expandedBbox.minLng + Math.random() * (expandedBbox.maxLng - expandedBbox.minLng);

      if (!isInsideZone(lat, lng, target)) {
        if (haversineM(lat, lng, ref.lat, ref.lng) < 250) {
          return { lat, lng };
        }
      }
    }

    return jitter(ref, fallbackRadiusM);
  } catch (err) {
    logger.warn({ err, sessionId }, 'Zone placement (outside type) failed, using jitter');
    return jitter(ref, fallbackRadiusM);
  }
}

/**
 * Place a pin INSIDE a specific zone type.
 * E.g., hazard deterioration casualties should appear inside the hot zone.
 * If the target zone doesn't exist, falls back to jitter around `ref`.
 */
export async function placeInsideZoneType(
  sessionId: string,
  zoneType: 'hot' | 'warm' | 'cold',
  ref: Coord,
  fallbackRadiusM = 40,
  maxAttempts = 60,
): Promise<Coord> {
  try {
    const zones = await fetchSessionZones(sessionId);
    const targetZones = zones.filter((z) => z.classification === zoneType);
    if (targetZones.length === 0) return jitter(ref, fallbackRadiusM);

    const target = targetZones[0];
    const bbox = polygonBoundingBox(target.ring);

    for (let i = 0; i < maxAttempts; i++) {
      const lat = bbox.minLat + Math.random() * (bbox.maxLat - bbox.minLat);
      const lng = bbox.minLng + Math.random() * (bbox.maxLng - bbox.minLng);

      if (isInsideZone(lat, lng, target)) {
        return { lat, lng };
      }
    }

    // Fallback to centroid of the zone
    const cLat = target.ring.reduce((s, p) => s + p[0], 0) / target.ring.length;
    const cLng = target.ring.reduce((s, p) => s + p[1], 0) / target.ring.length;
    return { lat: cLat, lng: cLng };
  } catch (err) {
    logger.warn({ err, sessionId }, 'Zone placement (inside) failed, using jitter');
    return jitter(ref, fallbackRadiusM);
  }
}

/**
 * Place a pin ON or NEAR the boundary of the outermost zone.
 * Ideal for perimeter breach events.
 */
export async function placeOnZoneBoundary(
  sessionId: string,
  ref: Coord,
  fallbackRadiusM = 30,
): Promise<Coord> {
  try {
    const zones = await fetchSessionZones(sessionId);
    if (zones.length === 0) return jitter(ref, fallbackRadiusM);

    const outermost = zones[zones.length - 1];
    const ring = outermost.ring;

    // Pick a random edge segment and place the pin on it with slight outward push
    const segIdx = Math.floor(Math.random() * (ring.length - 1));
    const [lat1, lng1] = ring[segIdx];
    const [lat2, lng2] = ring[(segIdx + 1) % ring.length];
    const t = 0.2 + Math.random() * 0.6;
    const lat = lat1 + t * (lat2 - lat1);
    const lng = lng1 + t * (lng2 - lng1);

    // Slight outward push (~5m)
    const cLat = ring.reduce((s, p) => s + p[0], 0) / ring.length;
    const cLng = ring.reduce((s, p) => s + p[1], 0) / ring.length;
    const dLat = lat - cLat;
    const dLng = lng - cLng;
    const dist = Math.sqrt(dLat * dLat + dLng * dLng) || 0.0001;
    const pushDeg = 5 / 111_320;
    return {
      lat: lat + (dLat / dist) * pushDeg,
      lng: lng + (dLng / dist) * pushDeg,
    };
  } catch (err) {
    logger.warn({ err, sessionId }, 'Zone boundary placement failed, using jitter');
    return jitter(ref, fallbackRadiusM);
  }
}
