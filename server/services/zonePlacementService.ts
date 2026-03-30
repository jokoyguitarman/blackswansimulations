/**
 * Zone-aware pin placement — places spawned pins relative to player-drawn
 * hazard zones so that pins whose narrative says "outside" don't land inside
 * the hot zone, perimeter breach pins appear at zone boundaries, etc.
 *
 * Falls back to simple jitter around a reference point when no zones exist.
 */

import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { polygonBoundingBox, haversineM, circleToPolygon } from './geoUtils.js';
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

interface WarRoomZone {
  zone_type: string;
  radius_m: number;
  polygon?: [number, number][];
}

/* Zone severity ordering (innermost → outermost) */
const ZONE_ORDER: Record<string, number> = { hot: 0, warm: 1, cold: 2 };
const VALID_CLASSIFICATIONS = ['hot', 'warm', 'cold'];

const MIN_PIN_SPACING_M = 20;

/* ── Fetch zones (player-drawn first, war room fallback) ── */

async function fetchSessionZones(sessionId: string, scenarioId?: string): Promise<ZonePolygon[]> {
  // 1. Try player-drawn zones first (most authoritative)
  const playerZones = await fetchPlayerDrawnZones(sessionId);
  if (playerZones.length > 0) return playerZones;

  // 2. Fall back to war room ground-truth zones stored on hazards
  if (scenarioId) {
    const warRoomZones = await fetchWarRoomZones(sessionId, scenarioId);
    if (warRoomZones.length > 0) return warRoomZones;
  }

  return [];
}

async function fetchPlayerDrawnZones(sessionId: string): Promise<ZonePolygon[]> {
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
    if (!classification || !VALID_CLASSIFICATIONS.includes(classification)) continue;

    const geoRing = (geom.coordinates as number[][][])[0];
    if (!geoRing || geoRing.length < 3) continue;

    const ring: [number, number][] = geoRing.map((c) => [c[1], c[0]]);
    zones.push({ classification: classification as 'hot' | 'warm' | 'cold', ring });
  }

  zones.sort((a, b) => (ZONE_ORDER[a.classification] ?? 9) - (ZONE_ORDER[b.classification] ?? 9));
  return zones;
}

async function fetchWarRoomZones(sessionId: string, scenarioId: string): Promise<ZonePolygon[]> {
  const { data: hazards } = await supabaseAdmin
    .from('scenario_hazards')
    .select('location_lat, location_lng, zones')
    .eq('scenario_id', scenarioId)
    .eq('session_id', sessionId);

  if (!hazards?.length) return [];

  const rawZones: WarRoomZone[] =
    hazards.map((h) => (h.zones ?? []) as WarRoomZone[]).find((z) => z.length > 0) ?? [];
  if (!rawZones.length) return [];

  // Compute incident centroid for radius-based zones
  let cLat = 0,
    cLng = 0;
  for (const h of hazards) {
    cLat += Number(h.location_lat);
    cLng += Number(h.location_lng);
  }
  cLat /= hazards.length;
  cLng /= hazards.length;

  const zones: ZonePolygon[] = [];
  for (const wz of rawZones) {
    if (!VALID_CLASSIFICATIONS.includes(wz.zone_type)) continue;

    let ring: [number, number][];
    if (wz.polygon?.length && wz.polygon.length >= 3) {
      ring = wz.polygon;
    } else if (wz.radius_m > 0) {
      ring = circleToPolygon(cLat, cLng, wz.radius_m);
    } else {
      continue;
    }

    zones.push({ classification: wz.zone_type as 'hot' | 'warm' | 'cold', ring });
  }

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

function jitterSpaced(ref: Coord, radiusM: number, existing: Coord[], maxAttempts = 30): Coord {
  const degPerM = 1 / 111_320;
  const cosLat = Math.cos((ref.lat * Math.PI) / 180);
  for (let i = 0; i < maxAttempts; i++) {
    const angle = Math.random() * 2 * Math.PI;
    const dist = (Math.random() * 0.7 + 0.3) * radiusM;
    const lat = ref.lat + dist * Math.cos(angle) * degPerM;
    const lng = ref.lng + (dist * Math.sin(angle) * degPerM) / cosLat;
    if (!isTooCloseToExisting(lat, lng, existing)) return { lat, lng };
  }
  return jitter(ref, radiusM);
}

async function fetchExistingPins(sessionId: string): Promise<Coord[]> {
  const { data } = await supabaseAdmin
    .from('scenario_casualties')
    .select('location_lat, location_lng')
    .eq('session_id', sessionId)
    .not('status', 'in', '("resolved","transported","deceased")');

  return (data ?? []).map((r) => ({ lat: r.location_lat, lng: r.location_lng }));
}

function isTooCloseToExisting(lat: number, lng: number, existing: Coord[]): boolean {
  for (const p of existing) {
    if (haversineM(lat, lng, p.lat, p.lng) < MIN_PIN_SPACING_M) return true;
  }
  return false;
}

/* ── Public API ── */

/**
 * Place a pin OUTSIDE all zones (player-drawn, or war room fallback).
 * Ideal for convergent crowds, perimeter bystanders, etc.
 * If no zones exist, falls back to a jittered offset from `ref`.
 */
export async function placeOutsideAllZones(
  sessionId: string,
  ref: Coord,
  fallbackRadiusM = 30,
  maxAttempts = 80,
  scenarioId?: string,
): Promise<Coord> {
  try {
    const zones = await fetchSessionZones(sessionId, scenarioId);
    const existing = await fetchExistingPins(sessionId);
    if (zones.length === 0) return jitterSpaced(ref, fallbackRadiusM, existing);

    const outermost = zones[zones.length - 1];
    const bbox = polygonBoundingBox(outermost.ring);
    const pad = 0.001;
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
        if (
          haversineM(lat, lng, ref.lat, ref.lng) < 200 &&
          !isTooCloseToExisting(lat, lng, existing)
        ) {
          return { lat, lng };
        }
      }
    }

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
  scenarioId?: string,
): Promise<Coord> {
  try {
    const zones = await fetchSessionZones(sessionId, scenarioId);
    const existing = await fetchExistingPins(sessionId);
    const targetZones = zones.filter((z) => z.classification === zoneType);
    if (targetZones.length === 0) return jitterSpaced(ref, fallbackRadiusM, existing);

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
        if (
          haversineM(lat, lng, ref.lat, ref.lng) < 250 &&
          !isTooCloseToExisting(lat, lng, existing)
        ) {
          return { lat, lng };
        }
      }
    }

    return jitterSpaced(ref, fallbackRadiusM, existing);
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
  scenarioId?: string,
): Promise<Coord> {
  try {
    const zones = await fetchSessionZones(sessionId, scenarioId);
    const existing = await fetchExistingPins(sessionId);
    const targetZones = zones.filter((z) => z.classification === zoneType);
    if (targetZones.length === 0) return jitterSpaced(ref, fallbackRadiusM, existing);

    const target = targetZones[0];
    const bbox = polygonBoundingBox(target.ring);

    for (let i = 0; i < maxAttempts; i++) {
      const lat = bbox.minLat + Math.random() * (bbox.maxLat - bbox.minLat);
      const lng = bbox.minLng + Math.random() * (bbox.maxLng - bbox.minLng);

      if (isInsideZone(lat, lng, target) && !isTooCloseToExisting(lat, lng, existing)) {
        return { lat, lng };
      }
    }

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
  scenarioId?: string,
): Promise<Coord> {
  try {
    const zones = await fetchSessionZones(sessionId, scenarioId);
    const existing = await fetchExistingPins(sessionId);
    if (zones.length === 0) return jitterSpaced(ref, fallbackRadiusM, existing);

    const outermost = zones[zones.length - 1];
    const ring = outermost.ring;
    const cLat = ring.reduce((s, p) => s + p[0], 0) / ring.length;
    const cLng = ring.reduce((s, p) => s + p[1], 0) / ring.length;

    // Try multiple segments to find one that doesn't overlap existing pins
    const segments = ring.length - 1;
    for (let attempt = 0; attempt < Math.min(segments * 2, 30); attempt++) {
      const segIdx = Math.floor(Math.random() * segments);
      const [lat1, lng1] = ring[segIdx];
      const [lat2, lng2] = ring[(segIdx + 1) % ring.length];
      const t = 0.2 + Math.random() * 0.6;
      const lat = lat1 + t * (lat2 - lat1);
      const lng = lng1 + t * (lng2 - lng1);

      const dLat = lat - cLat;
      const dLng = lng - cLng;
      const dist = Math.sqrt(dLat * dLat + dLng * dLng) || 0.0001;
      const pushDeg = 5 / 111_320;
      const finalLat = lat + (dLat / dist) * pushDeg;
      const finalLng = lng + (dLng / dist) * pushDeg;

      if (!isTooCloseToExisting(finalLat, finalLng, existing)) {
        return { lat: finalLat, lng: finalLng };
      }
    }

    // Fallback: accept whatever spot we get
    const segIdx = Math.floor(Math.random() * segments);
    const [lat1, lng1] = ring[segIdx];
    const [lat2, lng2] = ring[(segIdx + 1) % ring.length];
    const t = 0.5;
    const lat = lat1 + t * (lat2 - lat1);
    const lng = lng1 + t * (lng2 - lng1);
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
