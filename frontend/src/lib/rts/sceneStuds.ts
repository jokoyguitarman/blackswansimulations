/**
 * Studs for a drawn or reloaded building. Outdoor studs are generated once.
 * Indoor studs are generated for every saved storey, so a reload does not
 * leave the upper floors empty.
 */

const STUD_SPACING_M = 3;
/**
 * Outdoor studs stop this far past the footprint. The row and column numbers
 * still count from the old 150 m grid, so an indoor stud keeps its id.
 */
export const SCENE_STUD_MARGIN_M = 48;
const STUD_INDEX_PAD_M = 150;

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

  let row = 0;
  for (let lat = minLat - indexPadLat + dLat / 2; lat <= maxLat + indexPadLat; lat += dLat) {
    let col = 0;
    const latIn = lat >= latLo && lat <= latHi;
    for (let lng = minLng - indexPadLng + dLng / 2; lng <= maxLng + indexPadLng; lng += dLng) {
      if (latIn && lng >= lngLo && lng <= lngHi) {
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
        } else {
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
        }
      }
      col++;
    }
    row++;
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
