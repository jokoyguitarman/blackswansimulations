/**
 * Floor Plan SVG Service
 * Generates SVG floor plan images from real OSM building polygons + AI-generated features.
 * The building outline is the real shape; internal layout is an informed approximation.
 */

import { logger } from '../lib/logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FloorFeature {
  id: string;
  type: string;
  label: string;
  /** Normalised position within building bounds: x 0-1, y 0-1 */
  position_x: number;
  position_y: number;
  /** Optional width/height as fraction of building size */
  size_x?: number;
  size_y?: number;
  properties?: Record<string, unknown>;
}

export interface FloorSvgInput {
  floor_level: string;
  floor_label: string;
  building_use: string;
  features: FloorFeature[];
  environmental_factors: Array<Record<string, unknown>>;
}

interface SvgBounds {
  minLat: number;
  minLng: number;
  maxLat: number;
  maxLng: number;
  width: number;
  height: number;
}

// ---------------------------------------------------------------------------
// Coordinate helpers
// ---------------------------------------------------------------------------

function computeBounds(polygon: [number, number][]): SvgBounds {
  let minLat = Infinity,
    maxLat = -Infinity,
    minLng = Infinity,
    maxLng = -Infinity;
  for (const [lat, lng] of polygon) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
  }
  return {
    minLat,
    maxLat,
    minLng,
    maxLng,
    width: maxLng - minLng,
    height: maxLat - minLat,
  };
}

/**
 * Convert geo coordinates to SVG pixel space.
 * SVG Y axis is inverted relative to latitude.
 */
function geoToSvg(
  lat: number,
  lng: number,
  bounds: SvgBounds,
  svgWidth: number,
  svgHeight: number,
  padding: number,
): { x: number; y: number } {
  const usableW = svgWidth - padding * 2;
  const usableH = svgHeight - padding * 2;

  const x = padding + ((lng - bounds.minLng) / (bounds.width || 1)) * usableW;
  const y = padding + ((bounds.maxLat - lat) / (bounds.height || 1)) * usableH;
  return { x, y };
}

/**
 * Convert normalised 0-1 position to SVG pixel space within the building polygon bounding box.
 */
function normToSvg(
  nx: number,
  ny: number,
  bounds: SvgBounds,
  svgWidth: number,
  svgHeight: number,
  padding: number,
): { x: number; y: number } {
  const lat = bounds.maxLat - ny * bounds.height;
  const lng = bounds.minLng + nx * bounds.width;
  return geoToSvg(lat, lng, bounds, svgWidth, svgHeight, padding);
}

// ---------------------------------------------------------------------------
// Feature rendering
// ---------------------------------------------------------------------------

const FEATURE_COLORS: Record<string, { fill: string; stroke: string; emoji: string }> = {
  emergency_exit: { fill: '#166534', stroke: '#22c55e', emoji: '🚪' },
  exit: { fill: '#166534', stroke: '#22c55e', emoji: '🚪' },
  entrance: { fill: '#1e3a5f', stroke: '#3b82f6', emoji: '🚶' },
  escalator: { fill: '#312e81', stroke: '#6366f1', emoji: '↕' },
  elevator: { fill: '#312e81', stroke: '#818cf8', emoji: '⬍' },
  stairs: { fill: '#44403c', stroke: '#a8a29e', emoji: '⊞' },
  corridor: { fill: '#1c1917', stroke: '#57534e', emoji: '' },
  food_court: { fill: '#431407', stroke: '#f97316', emoji: '🍽' },
  retail: { fill: '#1e1b4b', stroke: '#a78bfa', emoji: '🏪' },
  restroom: { fill: '#164e63', stroke: '#22d3ee', emoji: 'WC' },
  fire_extinguisher: { fill: '#7f1d1d', stroke: '#ef4444', emoji: '🧯' },
  fire_alarm: { fill: '#7f1d1d', stroke: '#f87171', emoji: '🔔' },
  first_aid: { fill: '#14532d', stroke: '#4ade80', emoji: '⚕' },
  electrical_panel: { fill: '#422006', stroke: '#fbbf24', emoji: '⚡' },
  ventilation: { fill: '#0c4a6e', stroke: '#38bdf8', emoji: '≋' },
  water_supply: { fill: '#0c4a6e', stroke: '#0ea5e9', emoji: '💧' },
  room: { fill: '#1a1a2e', stroke: '#4a4a6a', emoji: '' },
  parking: { fill: '#1c1917', stroke: '#78716c', emoji: 'P' },
  office: { fill: '#1e1b4b', stroke: '#6366f1', emoji: '' },
  storage: { fill: '#1c1917', stroke: '#57534e', emoji: '' },
};

function getFeatureStyle(type: string) {
  return FEATURE_COLORS[type] ?? { fill: '#1a1a2e', stroke: '#4a4a6a', emoji: '•' };
}

function renderFeatureSvg(
  feature: FloorFeature,
  bounds: SvgBounds,
  svgW: number,
  svgH: number,
  padding: number,
): string {
  const style = getFeatureStyle(feature.type);
  const pos = normToSvg(feature.position_x, feature.position_y, bounds, svgW, svgH, padding);

  const isArea = [
    'corridor',
    'food_court',
    'retail',
    'room',
    'parking',
    'office',
    'storage',
  ].includes(feature.type);
  const isSmallItem = [
    'fire_extinguisher',
    'fire_alarm',
    'first_aid',
    'electrical_panel',
    'ventilation',
    'water_supply',
  ].includes(feature.type);

  if (isArea) {
    const sw = (feature.size_x ?? 0.15) * (svgW - padding * 2);
    const sh = (feature.size_y ?? 0.1) * (svgH - padding * 2);
    const rx = pos.x - sw / 2;
    const ry = pos.y - sh / 2;

    return `
    <g>
      <rect x="${rx}" y="${ry}" width="${sw}" height="${sh}"
        fill="${style.fill}" stroke="${style.stroke}" stroke-width="1.5" rx="3" opacity="0.7"/>
      <text x="${pos.x}" y="${pos.y + 4}" text-anchor="middle"
        fill="${style.stroke}" font-family="monospace" font-size="10" opacity="0.9">${escapeXml(feature.label)}</text>
    </g>`;
  }

  if (isSmallItem) {
    return `
    <g>
      <circle cx="${pos.x}" cy="${pos.y}" r="6"
        fill="${style.fill}" stroke="${style.stroke}" stroke-width="1.5"/>
      <text x="${pos.x}" y="${pos.y + 3.5}" text-anchor="middle"
        fill="${style.stroke}" font-family="monospace" font-size="7" font-weight="bold">${style.emoji}</text>
    </g>`;
  }

  // Point features: exits, escalators, elevators, stairs, entrance
  const r = 10;
  return `
  <g>
    <rect x="${pos.x - r}" y="${pos.y - r}" width="${r * 2}" height="${r * 2}"
      fill="${style.fill}" stroke="${style.stroke}" stroke-width="2" rx="4"/>
    <text x="${pos.x}" y="${pos.y + 4}" text-anchor="middle"
      fill="white" font-family="monospace" font-size="11" font-weight="bold">${style.emoji}</text>
    <text x="${pos.x}" y="${pos.y + r + 12}" text-anchor="middle"
      fill="${style.stroke}" font-family="monospace" font-size="8" opacity="0.85">${escapeXml(feature.label)}</text>
  </g>`;
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Main SVG generator
// ---------------------------------------------------------------------------

const SVG_WIDTH = 800;
const SVG_HEIGHT = 600;
const SVG_PADDING = 40;

/**
 * Generate an SVG floor plan from a building polygon + AI features.
 * Falls back to a rectangle if no polygon is available.
 */
export function generateFloorPlanSvg(
  polygon: [number, number][] | undefined,
  rectBounds: { minlat: number; minlon: number; maxlat: number; maxlon: number } | null,
  floor: FloorSvgInput,
): string {
  // Determine the outline to use
  let outlinePoints: [number, number][];
  if (polygon?.length && polygon.length >= 3) {
    outlinePoints = polygon;
  } else if (rectBounds) {
    outlinePoints = [
      [rectBounds.minlat, rectBounds.minlon],
      [rectBounds.minlat, rectBounds.maxlon],
      [rectBounds.maxlat, rectBounds.maxlon],
      [rectBounds.maxlat, rectBounds.minlon],
    ];
  } else {
    logger.warn({ floor_level: floor.floor_level }, 'No polygon or bounds for floor plan SVG');
    return '';
  }

  const bounds = computeBounds(outlinePoints);

  // Convert polygon to SVG path
  const svgPoints = outlinePoints
    .map(([lat, lng]) => {
      const { x, y } = geoToSvg(lat, lng, bounds, SVG_WIDTH, SVG_HEIGHT, SVG_PADDING);
      return `${x},${y}`;
    })
    .join(' ');

  // Environmental factor styling
  const envOverlays = renderEnvironmentalOverlays(
    floor.environmental_factors,
    SVG_WIDTH,
    SVG_HEIGHT,
  );

  // Render each feature
  const featuresSvg = floor.features
    .map((f) => renderFeatureSvg(f, bounds, SVG_WIDTH, SVG_HEIGHT, SVG_PADDING))
    .join('\n');

  // Floor label
  const floorLabel = escapeXml(`${floor.floor_label} — ${floor.building_use}`);

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SVG_WIDTH} ${SVG_HEIGHT}" width="${SVG_WIDTH}" height="${SVG_HEIGHT}">
  <defs>
    <filter id="glow-${floor.floor_level}">
      <feGaussianBlur stdDeviation="2" result="blur"/>
      <feMerge>
        <feMergeNode in="blur"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
    <pattern id="grid-${floor.floor_level}" width="20" height="20" patternUnits="userSpaceOnUse">
      <path d="M 20 0 L 0 0 0 20" fill="none" stroke="rgba(234,179,8,0.06)" stroke-width="0.5"/>
    </pattern>
  </defs>

  <!-- Background -->
  <rect width="${SVG_WIDTH}" height="${SVG_HEIGHT}" fill="#0a0a0f"/>

  <!-- Building outline (real shape from OSM) -->
  <polygon points="${svgPoints}"
    fill="#0f0f1a" stroke="#eab308" stroke-width="2.5" opacity="0.95"
    filter="url(#glow-${floor.floor_level})"/>

  <!-- Grid overlay inside building -->
  <polygon points="${svgPoints}"
    fill="url(#grid-${floor.floor_level})" stroke="none"/>

  ${envOverlays}

  <!-- Internal features -->
  ${featuresSvg}

  <!-- Floor label -->
  <text x="15" y="22" fill="#eab308" font-family="monospace" font-size="13" font-weight="bold" opacity="0.8">${floorLabel}</text>
  <text x="15" y="38" fill="rgba(234,179,8,0.4)" font-family="monospace" font-size="9">FLOOR PLAN — APPROXIMATE LAYOUT</text>
</svg>`;
}

function renderEnvironmentalOverlays(
  factors: Array<Record<string, unknown>>,
  svgW: number,
  svgH: number,
): string {
  const parts: string[] = [];

  for (const f of factors) {
    const factor = f.factor as string;
    const severity = f.severity as string;

    if (factor === 'smoke_accumulation') {
      const opacity = severity === 'high' ? 0.2 : severity === 'medium' ? 0.1 : 0.04;
      parts.push(`<rect x="0" y="0" width="${svgW}" height="${svgH * 0.4}"
        fill="rgba(120,120,120,${opacity})" rx="0">
        <animate attributeName="opacity" values="${opacity};${opacity * 1.5};${opacity}" dur="4s" repeatCount="indefinite"/>
      </rect>`);
    }

    if (factor === 'crowd_density') {
      const opacity = severity === 'high' ? 0.12 : severity === 'medium' ? 0.06 : 0;
      if (opacity > 0) {
        parts.push(`<rect x="${svgW * 0.2}" y="${svgH * 0.3}" width="${svgW * 0.6}" height="${svgH * 0.4}"
          fill="rgba(234,179,8,${opacity})" rx="10"/>`);
      }
    }
  }

  return parts.join('\n');
}

/**
 * Convert the AI's normalised feature positions to actual lat/lng coordinates
 * within the building footprint, and return both the SVG and the geo-referenced features.
 */
export function convertFeaturesToGeoJson(
  features: FloorFeature[],
  bounds: { minlat: number; minlon: number; maxlat: number; maxlon: number },
): Array<{
  id: string;
  type: string;
  label: string;
  geometry: { type: 'Point'; coordinates: [number, number] };
  properties?: Record<string, unknown>;
}> {
  return features.map((f) => {
    const lat = bounds.maxlat - f.position_y * (bounds.maxlat - bounds.minlat);
    const lng = bounds.minlon + f.position_x * (bounds.maxlon - bounds.minlon);
    return {
      id: f.id,
      type: f.type,
      label: f.label,
      geometry: { type: 'Point' as const, coordinates: [lng, lat] },
      properties: f.properties,
    };
  });
}
