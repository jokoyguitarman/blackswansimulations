/**
 * B2: Pre-generate vicinity and layout map images from scenario data.
 * Uses OSM tiles as base and Sharp + SVG overlay for markers/labels.
 */

import Sharp from 'sharp';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { resolveScenarioCenter } from './scenarioCenterService.js';

const OSM_TILE_BASE = 'https://tile.openstreetmap.org';
const TILE_SIZE = 256;
const USER_AGENT = 'BlackSwanSimulations/1.0 scenario-map-generator';

interface ScenarioRow {
  id: string;
  center_lat: number | null;
  center_lng: number | null;
  vicinity_radius_meters: number | null;
  insider_knowledge: Record<string, unknown> | null;
}

interface ScenarioLocationRow {
  location_type: string;
  label: string;
  coordinates: { lat?: number; lng?: number } | null;
}

interface MapBounds {
  latMin: number;
  latMax: number;
  lngMin: number;
  lngMax: number;
}

interface OverlayMark {
  lat: number;
  lng: number;
  label: string;
  type?:
    | 'blast'
    | 'cordon'
    | 'exit'
    | 'triage'
    | 'evac_holding'
    | 'hospital'
    | 'police'
    | 'cctv'
    | 'fire_station'
    | 'community_center';
}

/** Lat/lng to OSM tile indices (slippy map). */
function latLngToTile(lat: number, lng: number, zoom: number): { x: number; y: number } {
  const n = Math.pow(2, zoom);
  const x = Math.floor(((lng + 180) / 360) * n);
  const rad = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n);
  return { x, y };
}

/** Tile (tx, ty) at zoom z to lat/lng bounds of that tile. */
function tileToBounds(tx: number, ty: number, zoom: number): MapBounds {
  const n = Math.pow(2, zoom);
  const lngMin = (tx / n) * 360 - 180;
  const lngMax = ((tx + 1) / n) * 360 - 180;
  const latMax = (Math.atan(Math.sinh(Math.PI * (1 - (2 * ty) / n))) * 180) / Math.PI;
  const latMin = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (ty + 1)) / n))) * 180) / Math.PI;
  return { latMin, latMax, lngMin, lngMax };
}

/** Bounds of a 2x2 tile grid centered at (tx, ty). */
function grid2x2Bounds(tx: number, ty: number, zoom: number): MapBounds {
  const topLeft = tileToBounds(tx, ty, zoom);
  const bottomRight = tileToBounds(tx + 1, ty + 1, zoom);
  return {
    latMin: bottomRight.latMin,
    latMax: topLeft.latMax,
    lngMin: topLeft.lngMin,
    lngMax: bottomRight.lngMax,
  };
}

function latLngToPixel(
  lat: number,
  lng: number,
  bounds: MapBounds,
  width: number,
  height: number,
): { x: number; y: number } {
  const x = ((lng - bounds.lngMin) / (bounds.lngMax - bounds.lngMin)) * width;
  const y = (1 - (lat - bounds.latMin) / (bounds.latMax - bounds.latMin)) * height;
  return { x: Math.round(x), y: Math.round(y) };
}

async function fetchTile(z: number, x: number, y: number): Promise<Buffer> {
  const url = `${OSM_TILE_BASE}/${z}/${x}/${y}.png`;
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
  });
  if (!res.ok) {
    throw new Error(`OSM tile fetch failed: ${res.status} ${url}`);
  }
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/** Composite 2x2 tiles into one image. */
async function compositeTiles(tx: number, ty: number, zoom: number): Promise<Buffer> {
  const [t00, t10, t01, t11] = await Promise.all([
    fetchTile(zoom, tx, ty),
    fetchTile(zoom, tx + 1, ty),
    fetchTile(zoom, tx, ty + 1),
    fetchTile(zoom, tx + 1, ty + 1),
  ]);

  const size = TILE_SIZE * 2;
  return await Sharp({
    create: {
      width: size,
      height: size,
      channels: 3,
      background: { r: 230, g: 230, b: 230 },
    },
  })
    .composite([
      { input: t00, top: 0, left: 0 },
      { input: t10, top: 0, left: TILE_SIZE },
      { input: t01, top: TILE_SIZE, left: 0 },
      { input: t11, top: TILE_SIZE, left: TILE_SIZE },
    ])
    .png()
    .toBuffer();
}

/** Build SVG overlay: circles and text labels. */
function buildOverlaySvg(
  marks: OverlayMark[],
  bounds: MapBounds,
  width: number,
  height: number,
): string {
  const fontSize = Math.max(10, Math.min(14, width / 50));
  const r = Math.max(4, width / 100);
  const lines: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
  ];
  for (const m of marks) {
    const { x, y } = latLngToPixel(m.lat, m.lng, bounds, width, height);
    if (x < -20 || x > width + 20 || y < -20 || y > height + 20) continue;
    const fill =
      m.type === 'blast'
        ? '#c00'
        : m.type === 'cordon'
          ? '#f80'
          : m.type === 'hospital'
            ? '#0a0'
            : m.type === 'police'
              ? '#06c'
              : m.type === 'cctv'
                ? '#606'
                : m.type === 'fire_station'
                  ? '#ea580c'
                  : m.type === 'community_center'
                    ? '#0d9488'
                    : m.type === 'evac_holding'
                      ? '#0284c7'
                      : '#333';
    lines.push(
      `<circle cx="${x}" cy="${y}" r="${r}" fill="${fill}" stroke="#fff" stroke-width="1.5"/>`,
    );
    const textY = y + r + fontSize + 2;
    const escaped = m.label.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    lines.push(
      `<text x="${x}" y="${textY}" text-anchor="middle" font-size="${fontSize}" fill="#111" font-family="sans-serif">${escaped}</text>`,
    );
  }
  lines.push('</svg>');
  return lines.join('\n');
}

/** Short label for hospital/police (e.g. "Tan Tock Seng Hospital" -> "TTSH"). */
function shortLabel(name: string, used: Set<string>): string {
  const words = name.split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    const initials = words
      .map((w) => w[0])
      .join('')
      .toUpperCase()
      .slice(0, 4);
    if (!used.has(initials)) {
      used.add(initials);
      return initials;
    }
  }
  const base = name.slice(0, 8);
  let out = base;
  let i = 0;
  while (used.has(out)) {
    out = base + i++;
  }
  used.add(out);
  return out;
}

export interface GenerateMapsResult {
  vicinityPng: Buffer | null;
  layoutPng: Buffer | null;
  error?: string;
}

/**
 * Load scenario and locations from DB.
 */
async function loadScenarioData(scenarioId: string): Promise<{
  scenario: ScenarioRow;
  locations: ScenarioLocationRow[];
} | null> {
  const { data: scenario, error: scenarioErr } = await supabaseAdmin
    .from('scenarios')
    .select('id, center_lat, center_lng, vicinity_radius_meters, insider_knowledge')
    .eq('id', scenarioId)
    .single();

  if (scenarioErr || !scenario) {
    logger.debug({ scenarioId, error: scenarioErr }, 'Scenario not found for map generation');
    return null;
  }

  const { data: locations, error: locErr } = await supabaseAdmin
    .from('scenario_locations')
    .select('location_type, label, coordinates')
    .eq('scenario_id', scenarioId)
    .order('display_order', { ascending: true });

  if (locErr) {
    logger.warn({ scenarioId, error: locErr }, 'Failed to load scenario_locations');
  }

  return {
    scenario: scenario as ScenarioRow,
    locations: (locations ?? []) as ScenarioLocationRow[],
  };
}

/**
 * Generate vicinity map (wide): OSM base + osm_vicinity POIs + blast/cordon.
 */
async function generateVicinityMap(
  scenario: ScenarioRow,
  locations: ScenarioLocationRow[],
): Promise<Buffer | null> {
  const lat = scenario.center_lat!;
  const lng = scenario.center_lng!;
  const zoom = 15;
  const tx = latLngToTile(lat, lng, zoom).x;
  const ty = latLngToTile(lat, lng, zoom).y;
  const bounds = grid2x2Bounds(tx, ty, zoom);
  const size = 800;

  let base: Buffer;
  try {
    base = await compositeTiles(tx, ty, zoom);
  } catch (err) {
    logger.warn({ err, scenarioId: scenario.id }, 'Vicinity base tiles failed');
    return null;
  }

  const marks: OverlayMark[] = [];
  const labelUsed = new Set<string>();

  const osm = (scenario.insider_knowledge?.osm_vicinity ?? {}) as {
    hospitals?: Array<{ name: string; lat: number; lng: number }>;
    police?: Array<{ name: string; lat: number; lng: number }>;
    cctv_or_surveillance?: Array<{ location: string; lat: number; lng: number }>;
  };

  if (osm.hospitals) {
    for (const h of osm.hospitals) {
      if (h.lat != null && h.lng != null) {
        marks.push({
          lat: h.lat,
          lng: h.lng,
          label: shortLabel(h.name, labelUsed),
          type: 'hospital',
        });
      }
    }
  }
  if (osm.police) {
    for (const p of osm.police) {
      if (p.lat != null && p.lng != null) {
        marks.push({
          lat: p.lat,
          lng: p.lng,
          label: shortLabel(p.name, labelUsed),
          type: 'police',
        });
      }
    }
  }
  if (osm.cctv_or_surveillance) {
    osm.cctv_or_surveillance.forEach((c, i) => {
      if (c.lat != null && c.lng != null) {
        marks.push({
          lat: c.lat,
          lng: c.lng,
          label: `CCTV${i + 1}`,
          type: 'cctv',
        });
      }
    });
  }

  for (const loc of locations) {
    if (loc.location_type === 'blast_site') {
      const coords = loc.coordinates;
      if (!coords || coords.lat == null || coords.lng == null) continue;
      marks.push({
        lat: coords.lat,
        lng: coords.lng,
        label: loc.label.includes('Ground zero') ? 'GZ' : 'Blast',
        type: 'blast',
      });
      continue;
    }
    const coords = loc.coordinates;
    if (!coords || coords.lat == null || coords.lng == null) continue;
    const type =
      loc.location_type === 'hospital'
        ? 'hospital'
        : loc.location_type === 'police_station'
          ? 'police'
          : loc.location_type === 'fire_station'
            ? 'fire_station'
            : loc.location_type === 'cctv'
              ? 'cctv'
              : loc.location_type === 'community_center'
                ? 'community_center'
                : undefined;
    if (!type) continue;
    marks.push({
      lat: coords.lat,
      lng: coords.lng,
      label: shortLabel(loc.label, labelUsed),
      type,
    });
  }

  const svg = buildOverlaySvg(marks, bounds, size, size);
  const overlayBuf = Buffer.from(svg);

  const out = await Sharp(base)
    .resize(size, size)
    .composite([{ input: overlayBuf, top: 0, left: 0 }])
    .png()
    .toBuffer();

  return out;
}

/**
 * Generate layout map (tight): OSM base + all scenario_locations.
 */
async function generateLayoutMap(
  scenario: ScenarioRow,
  locations: ScenarioLocationRow[],
): Promise<Buffer | null> {
  const lat = scenario.center_lat!;
  const lng = scenario.center_lng!;
  const zoom = 18;
  const tx = latLngToTile(lat, lng, zoom).x;
  const ty = latLngToTile(lat, lng, zoom).y;
  const bounds = grid2x2Bounds(tx, ty, zoom);
  const size = 800;

  let base: Buffer;
  try {
    base = await compositeTiles(tx, ty, zoom);
  } catch (err) {
    logger.warn({ err, scenarioId: scenario.id }, 'Layout base tiles failed');
    return null;
  }

  const marks: OverlayMark[] = [];
  for (const loc of locations) {
    if (loc.location_type === 'cordon') continue;
    const coords = loc.coordinates;
    if (!coords || coords.lat == null || coords.lng == null) continue;
    const type =
      loc.location_type === 'blast_site'
        ? 'blast'
        : loc.location_type === 'exit'
          ? 'exit'
          : loc.location_type === 'triage_site'
            ? 'triage'
            : loc.location_type === 'evacuation_holding'
              ? 'evac_holding'
              : loc.location_type === 'area'
                ? undefined
                : loc.location_type === 'hospital'
                  ? 'hospital'
                  : loc.location_type === 'police_station'
                    ? 'police'
                    : loc.location_type === 'fire_station'
                      ? 'fire_station'
                      : loc.location_type === 'cctv'
                        ? 'cctv'
                        : loc.location_type === 'community_center'
                          ? 'community_center'
                          : undefined;
    marks.push({
      lat: coords.lat,
      lng: coords.lng,
      label: loc.label.length > 20 ? loc.label.slice(0, 18) + '…' : loc.label,
      type,
    });
  }

  const svg = buildOverlaySvg(marks, bounds, size, size);
  const overlayBuf = Buffer.from(svg);

  const out = await Sharp(base)
    .resize(size, size)
    .composite([{ input: overlayBuf, top: 0, left: 0 }])
    .png()
    .toBuffer();

  return out;
}

/**
 * Generate vicinity and layout map PNGs for a scenario.
 * Returns null if scenario has no center_lat/center_lng; otherwise returns buffers (possibly null for one map on failure).
 */
export async function generateScenarioMaps(scenarioId: string): Promise<GenerateMapsResult> {
  const data = await loadScenarioData(scenarioId);
  if (!data) {
    return { vicinityPng: null, layoutPng: null, error: 'Scenario not found' };
  }

  const { scenario, locations } = data;
  if (scenario.center_lat == null || scenario.center_lng == null) {
    const resolved = await resolveScenarioCenter(scenarioId);
    if (resolved) {
      scenario.center_lat = resolved.lat;
      scenario.center_lng = resolved.lng;
    } else {
      return {
        vicinityPng: null,
        layoutPng: null,
        error: 'Scenario has no center_lat/center_lng',
      };
    }
  }

  const [vicinityPng, layoutPng] = await Promise.all([
    generateVicinityMap(scenario, locations),
    generateLayoutMap(scenario, locations),
  ]);

  return { vicinityPng, layoutPng };
}
