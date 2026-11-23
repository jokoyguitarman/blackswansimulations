/**
 * Studs for a drawn or reloaded building. Outdoor studs are generated once.
 * Indoor studs are generated for every saved storey, so a reload does not
 * leave the upper floors empty.
 */

const STUD_SPACING_M = 3;
const EXTERIOR_PADDING_M = 150;

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
  const extPadLat = EXTERIOR_PADDING_M / 111_320;
  const extPadLng = EXTERIOR_PADDING_M / (111_320 * Math.cos((midLat * Math.PI) / 180));

  let row = 0;
  for (let lat = minLat - extPadLat + dLat / 2; lat <= maxLat + extPadLat; lat += dLat) {
    let col = 0;
    for (let lng = minLng - extPadLng + dLng / 2; lng <= maxLng + extPadLng; lng += dLng) {
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
      col++;
    }
    row++;
  }
  return studs;
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
