/**
 * Studs for a drawn or reloaded building. Outdoor studs are generated once.
 * Indoor studs are generated for every saved storey, so a reload does not
 * leave the upper floors empty.
 */

const STUD_SPACING_M = 3;
/**
 * Outdoor studs stop this far past the footprint, and past every placement.
 * The row and column numbers still count from the old 150 m grid, so an
 * indoor stud keeps its id.
 */
export const SCENE_STUD_MARGIN_M = 48;
const STUD_INDEX_PAD_M = 150;

/** A blast, a hazard, or a placed object, in the scene's metre frame. */
export interface SceneCoverPoint {
  x: number;
  y: number;
  /** Metres of the placement itself. The outdoor margin is added outside this. */
  radiusM?: number;
}

export interface SceneStud {
  id: string;
  lat: number;
  lng: number;
  floor: string;
  studType: 'building' | 'outdoor' | 'street';
  blastBand: string | null;
  operationalZone: string | null;
  distFromIncidentM: number | null;
  spatialContext: 'inside_building' | 'road' | 'open_air' | null;
}

export function generateSceneStuds(
  polygon: [number, number][],
  buildingIndex: number,
  levelIds: string[] = ['G'],
  cover: readonly SceneCoverPoint[] = [],
  include: readonly (readonly [number, number])[] = [],
): SceneStud[] {
  if (polygon.length < 3) return [];
  const floors = levelIds.length > 0 ? levelIds.map((id) => (id === 'Ground' ? 'G' : id)) : ['G'];

  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;
  for (const [la, ln] of polygon) {
    if (la < minLat) minLat = la;
    if (la > maxLat) maxLat = la;
    if (ln < minLng) minLng = ln;
    if (ln > maxLng) maxLng = ln;
  }

  const midLat = (minLat + maxLat) / 2;
  const studs: SceneStud[] = [];
  const dLat = STUD_SPACING_M / 111_320;
  const dLng = STUD_SPACING_M / (111_320 * Math.cos((midLat * Math.PI) / 180));
  const indexPadLat = STUD_INDEX_PAD_M / 111_320;
  const indexPadLng = STUD_INDEX_PAD_M / (111_320 * Math.cos((midLat * Math.PI) / 180));
  const emitPadLat = SCENE_STUD_MARGIN_M / 111_320;
  const emitPadLng = SCENE_STUD_MARGIN_M / (111_320 * Math.cos((midLat * Math.PI) / 180));
  const latLo = minLat - emitPadLat;
  const latHi = maxLat + emitPadLat;
  const lngLo = minLng - emitPadLng;
  const lngHi = maxLng + emitPadLng;
  let extLatLo = latLo;
  let extLatHi = latHi;
  let extLngLo = lngLo;
  let extLngHi = lngHi;
  if (cover.length > 0 || include.length > 0) {
    let sumLat = 0;
    let sumLng = 0;
    for (const [lat, lng] of polygon) {
      sumLat += lat;
      sumLng += lng;
    }
    const refLat = sumLat / polygon.length;
    const refLng = sumLng / polygon.length;
    const mPerDegLat = 111_320;
    const mPerDegLng = 111_320 * Math.cos((refLat * Math.PI) / 180);
    for (const [lat, lng] of include) {
      if (lat < extLatLo) extLatLo = lat;
      if (lat > extLatHi) extLatHi = lat;
      if (lng < extLngLo) extLngLo = lng;
      if (lng > extLngHi) extLngHi = lng;
    }
    for (const point of cover) {
      const lat = refLat - point.y / mPerDegLat;
      const lng = refLng + point.x / mPerDegLng;
      const radius = point.radiusM ?? 0;
      const rLat = radius / mPerDegLat;
      const rLng = radius / mPerDegLng;
      const loLat = lat - rLat - emitPadLat;
      const hiLat = lat + rLat + emitPadLat;
      const loLng = lng - rLng - emitPadLng;
      const hiLng = lng + rLng + emitPadLng;
      if (loLat < extLatLo) extLatLo = loLat;
      if (hiLat > extLatHi) extLatHi = hiLat;
      if (loLng < extLngLo) extLngLo = loLng;
      if (hiLng > extLngHi) extLngHi = hiLng;
    }
  }

  const pushCell = (lat: number, lng: number, row: number, col: number) => {
    const inside = pointInPolygonLatLng(lat, lng, polygon);
    if (!inside) {
      studs.push({
        id: `ext-${buildingIndex}-${row}-${col}`,
        lat,
        lng,
        floor: 'G',
        studType: 'outdoor',
        blastBand: null,
        operationalZone: null,
        distFromIncidentM: null,
        spatialContext: 'open_air',
      });
      return;
    }
    for (const floor of floors) {
      studs.push({
        id: `bldg-${buildingIndex}-${floor}-${row}-${col}`,
        lat,
        lng,
        floor,
        studType: 'building',
        blastBand: null,
        operationalZone: null,
        distFromIncidentM: null,
        spatialContext: 'inside_building',
      });
    }
  };

  const originLat = minLat - indexPadLat + dLat / 2;
  const originLng = minLng - indexPadLng + dLng / 2;
  const indexLatHi = maxLat + indexPadLat;
  const indexLngHi = maxLng + indexPadLng;
  let row = 0;
  for (let lat = originLat; lat <= indexLatHi; lat += dLat) {
    let col = 0;
    const latIn = lat >= extLatLo && lat <= extLatHi;
    for (let lng = originLng; lng <= indexLngHi; lng += dLng) {
      if (latIn && lng >= extLngLo && lng <= extLngHi) pushCell(lat, lng, row, col);
      col++;
    }
    row++;
  }

  // A placement past the 150 m index still gets studs. Rows stay on the same
  // lattice, so the cells the loop already emitted keep their ids.
  if (
    extLatLo < originLat ||
    extLatHi > indexLatHi ||
    extLngLo < originLng ||
    extLngHi > indexLngHi
  ) {
    const row0 = Math.ceil((extLatLo - originLat) / dLat - 1e-8);
    const row1 = Math.floor((extLatHi - originLat) / dLat + 1e-8);
    const col0 = Math.ceil((extLngLo - originLng) / dLng - 1e-8);
    const col1 = Math.floor((extLngHi - originLng) / dLng + 1e-8);
    for (let extraRow = row0; extraRow <= row1; extraRow++) {
      const lat = originLat + extraRow * dLat;
      if (lat < extLatLo - 1e-9 || lat > extLatHi + 1e-9) continue;
      if (lat >= originLat - 1e-9 && lat <= indexLatHi + 1e-9) continue;
      for (let extraCol = col0; extraCol <= col1; extraCol++) {
        const lng = originLng + extraCol * dLng;
        if (lng < extLngLo - 1e-9 || lng > extLngHi + 1e-9) continue;
        pushCell(lat, lng, extraRow, extraCol);
      }
    }
    for (let extraRow = row0; extraRow <= row1; extraRow++) {
      const lat = originLat + extraRow * dLat;
      if (lat < originLat - 1e-9 || lat > indexLatHi + 1e-9) continue;
      if (lat < extLatLo - 1e-9 || lat > extLatHi + 1e-9) continue;
      for (let extraCol = col0; extraCol <= col1; extraCol++) {
        const lng = originLng + extraCol * dLng;
        if (lng >= originLng - 1e-9 && lng <= indexLngHi + 1e-9) continue;
        if (lng < extLngLo - 1e-9 || lng > extLngHi + 1e-9) continue;
        pushCell(lat, lng, extraRow, extraCol);
      }
    }
  }
  return studs;
}

/** Same metre frame as the editor: origin at the polygon centroid, +x east, +y south. */
export function projectSceneStuds<T extends { lat: number; lng: number }>(
  polygon: [number, number][],
  studs: readonly T[],
): Array<T & { simPos: { x: number; y: number } }> {
  if (polygon.length === 0) return [];
  let sumLat = 0;
  let sumLng = 0;
  for (const [lat, lng] of polygon) {
    sumLat += lat;
    sumLng += lng;
  }
  const refLat = sumLat / polygon.length;
  const refLng = sumLng / polygon.length;
  const mPerDegLat = 111_320;
  const mPerDegLng = 111_320 * Math.cos((refLat * Math.PI) / 180);
  return studs.map((stud) => ({
    ...stud,
    simPos: {
      x: (stud.lng - refLng) * mPerDegLng,
      y: (refLat - stud.lat) * mPerDegLat,
    },
  }));
}

function pointInPolygonLatLng(lat: number, lng: number, polygon: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [yi, xi] = polygon[i];
    const [yj, xj] = polygon[j];
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}
