/**
 * Read one building footprint. Callers pass the readers in, so a test never
 * touches Supabase or the network. Neither reader is a write.
 */

export interface OsmBuildingFootprint {
  osmId: string;
  name: string | null;
  buildingType: string | null;
  /** Raw `building:levels` tag. Null when the map data has no count. */
  levels: number | null;
  underground: number | null;
  heightM: number | null;
  polygon: [number, number][];
  source: 'saved' | 'live_osm';
}

export interface SavedBuildingRow {
  osm_id: string;
  name: string | null;
  building_type: string | null;
  building_levels: number | null;
  building_levels_underground: number | null;
  height_m: number | null;
  footprint_polygon_json: unknown;
}

export interface OsmLookupDeps {
  readSaved: (osmId: string) => Promise<SavedBuildingRow | null>;
  readLive: (osmId: string) => Promise<unknown>;
}

export function parseOsmObjectId(osmId: string): { kind: 'way' | 'relation'; id: number } | null {
  const match = /^(way|relation)\/(\d+)$/.exec(osmId.trim());
  if (!match) return null;
  return { kind: match[1] as 'way' | 'relation', id: Number(match[2]) };
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const parsed = Number.parseFloat(value.trim().replace(/m$/i, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

/** Drop a repeated closing corner. An open ring is kept as given. */
export function openRing(points: [number, number][]): [number, number][] {
  if (points.length < 2) return points.slice();
  const first = points[0];
  const last = points[points.length - 1];
  const ring = first[0] === last[0] && first[1] === last[1] ? points.slice(0, -1) : points.slice();
  return ring;
}

function ringFromPairs(value: unknown): [number, number][] {
  if (!Array.isArray(value)) return [];
  const points: [number, number][] = [];
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length < 2) continue;
    const lat = Number(entry[0]);
    const lng = Number(entry[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    points.push([lat, lng]);
  }
  const ring = openRing(points);
  return ring.length >= 3 ? ring : [];
}

export function footprintFromSavedRow(row: SavedBuildingRow): OsmBuildingFootprint | null {
  const polygon = ringFromPairs(row.footprint_polygon_json);
  if (polygon.length < 3) return null;
  const buildingType = row.building_type && row.building_type !== 'yes' ? row.building_type : null;
  return {
    osmId: row.osm_id,
    name: row.name,
    buildingType,
    levels: finiteNumber(row.building_levels),
    underground: finiteNumber(row.building_levels_underground),
    heightM: finiteNumber(row.height_m),
    polygon,
    source: 'saved',
  };
}

interface OsmElement {
  type?: string;
  id?: number;
  lat?: number;
  lon?: number;
  nodes?: number[];
  tags?: Record<string, string>;
}

export function footprintFromOsmApi(doc: unknown, osmId: string): OsmBuildingFootprint | null {
  const parsed = parseOsmObjectId(osmId);
  if (!parsed || parsed.kind !== 'way') return null;
  const elements = (doc as { elements?: OsmElement[] } | null)?.elements;
  if (!Array.isArray(elements)) return null;

  const nodes = new Map<number, [number, number]>();
  let way: OsmElement | null = null;
  for (const element of elements) {
    if (element.type === 'node' && typeof element.id === 'number') {
      if (typeof element.lat === 'number' && typeof element.lon === 'number') {
        nodes.set(element.id, [element.lat, element.lon]);
      }
    } else if (element.type === 'way' && element.id === parsed.id) {
      way = element;
    }
  }
  if (!way?.nodes) return null;

  const ids = way.nodes;
  const uniqueIds = ids.length >= 2 && ids[0] === ids[ids.length - 1] ? ids.slice(0, -1) : ids;
  const polygon: [number, number][] = [];
  for (const id of uniqueIds) {
    const point = nodes.get(id);
    if (point) polygon.push(point);
  }
  if (polygon.length < 3) return null;

  const tags = way.tags ?? {};
  const building = tags.building;
  return {
    osmId,
    name: tags.name ?? null,
    buildingType: building && building !== 'yes' ? building : null,
    levels: finiteNumber(tags['building:levels']),
    underground: finiteNumber(tags['building:levels:underground']),
    heightM: finiteNumber(tags.height),
    polygon,
    source: 'live_osm',
  };
}

/**
 * Saved row first, and only when it has a usable ring. A failed or empty
 * read falls through to live OpenStreetMap. This function does not write.
 */
export async function lookupOsmBuilding(
  osmId: string,
  deps: OsmLookupDeps,
): Promise<OsmBuildingFootprint | null> {
  if (!parseOsmObjectId(osmId)) {
    throw new Error(`osmId must look like way/123 or relation/123, got ${osmId}`);
  }

  let saved: SavedBuildingRow | null = null;
  try {
    saved = await deps.readSaved(osmId);
  } catch {
    saved = null;
  }
  if (saved) {
    const footprint = footprintFromSavedRow(saved);
    if (footprint) return footprint;
  }

  return footprintFromOsmApi(await deps.readLive(osmId), osmId);
}
