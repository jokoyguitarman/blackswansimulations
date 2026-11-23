/**
 * Harbour House is the evacuation showcase floor: 60 m by 40 m, three exits,
 * two drywall partitions, and a sealed concrete room. The repo had no scene
 * under this name. This is that floor dressed as a mall.
 *
 * Shops carry upholstery, stock and fittings (heavy, solid). The south-west
 * kitchen is cooking oil, with gas lines that do not burn. Corridors and the
 * atrium are ceramic tile, with a few wooden benches and a kiosk. The sealed
 * room is concrete. An empty outdoor stud stays dark.
 *
 * Plan metres start at the south-west corner, +x east, +y north. The editor
 * frame is the centroid, +y south. The review harness is the plan frame.
 * Which one a stud list uses is read from where the indoor studs sit.
 */

import { entryById, matchFromEntry, type MaterialEntry, type PlacedObject } from './materialLibrary';

export interface FurnishingStud {
  id: string;
  simPos: { x: number; y: number };
  spatialContext?: string | null;
  level?: string;
}

type MallKind = 'shop' | 'oil' | 'gas' | 'bench' | 'kiosk' | 'tile' | 'concrete';

const MALL_TEXT: Record<MallKind, { entryId: string; description: string }> = {
  shop: { entryId: 'shop_contents', description: 'Upholstery, stock and fittings' },
  oil: { entryId: 'cooking_oil', description: 'Cooking oil' },
  gas: { entryId: 'gas_line', description: 'Gas line' },
  bench: { entryId: 'wood', description: 'Wooden bench' },
  kiosk: { entryId: 'wood', description: 'Wooden kiosk' },
  tile: { entryId: 'ceramic_tile', description: 'Ceramic tile' },
  concrete: { entryId: 'concrete', description: 'Concrete' },
};

/** Benches and the kiosk, in plan metres. One stud on either grid. */
const LIGHT_SPOTS: Array<{ x: number; y: number; kind: 'bench' | 'kiosk' }> = [
  { x: 30.5, y: 12.5, kind: 'bench' },
  { x: 30.5, y: 21.5, kind: 'bench' },
  { x: 30.5, y: 30.5, kind: 'bench' },
  { x: 33.5, y: 21.5, kind: 'kiosk' },
];

/**
 * West wing shop, south-west kitchen, central tile mall, east shop.
 * The concrete box is the south-east corner. Gas sits in the kitchen,
 * inside the usual blast, and does not spread.
 */
function mallKind(x: number, y: number): MallKind {
  if (x >= 46 && y <= 8) return 'concrete';
  if (x < 22 && y <= 8) {
    if (x >= 8 && x <= 14 && y >= 5) return 'gas';
    return 'oil';
  }
  if (x < 22 && y < 34) return 'shop';
  if (x >= 40 && y > 8) return 'shop';
  for (const spot of LIGHT_SPOTS) {
    if (Math.hypot(spot.x - x, spot.y - y) <= 1.6) return spot.kind;
  }
  return 'tile';
}

function planMetres(
  stud: FurnishingStud,
  editorFrame: boolean,
): { x: number; y: number } {
  if (editorFrame) return { x: stud.simPos.x + 30, y: 20 - stud.simPos.y };
  return { x: stud.simPos.x, y: stud.simPos.y };
}

export function harbourHouseFuelObjects(studs: readonly FurnishingStud[]): PlacedObject[] {
  const indoor = studs.filter((stud) => stud.spatialContext === 'inside_building');
  if (indoor.length === 0) return [];
  let cx = 0;
  let cy = 0;
  for (const stud of indoor) {
    cx += stud.simPos.x;
    cy += stud.simPos.y;
  }
  cx /= indoor.length;
  cy /= indoor.length;
  const editorFrame = Math.hypot(cx, cy) < 15;
  const objects: PlacedObject[] = [];
  for (const stud of indoor) {
    const plan = planMetres(stud, editorFrame);
    const kind = mallKind(plan.x, plan.y);
    const spec = MALL_TEXT[kind];
    const entry = entryById(spec.entryId);
    if (!entry) continue;
    objects.push(mallObject(stud, entry, spec.description));
  }
  return objects;
}

function mallObject(stud: FurnishingStud, entry: MaterialEntry, description: string): PlacedObject {
  return {
    id: `hh-${stud.id}`,
    studId: stud.id,
    pos: { x: stud.simPos.x, y: stud.simPos.y },
    level: stud.level ?? 'G',
    description,
    matches: [matchFromEntry(entry, 'keyword')],
    confirmed: true,
  };
}

function rectanglePolygon(
  centerLat: number,
  centerLng: number,
  widthM: number,
  heightM: number,
): [number, number][] {
  const mPerDegLat = 111_320;
  const mPerDegLng = 111_320 * Math.cos((centerLat * Math.PI) / 180);
  const dLat = heightM / 2 / mPerDegLat;
  const dLng = widthM / 2 / mPerDegLng;
  return [
    [centerLat + dLat, centerLng - dLng],
    [centerLat + dLat, centerLng + dLng],
    [centerLat - dLat, centerLng + dLng],
    [centerLat - dLat, centerLng - dLng],
  ];
}

const CENTER_LAT = 1.302;
const CENTER_LNG = 103.8;

export const harbourHouseSample = {
  scene: {
    name: 'Harbour House',
    buildingName: 'Harbour House',
    buildingPolygon: rectanglePolygon(CENTER_LAT, CENTER_LNG, 60, 40),
    centerLat: CENTER_LAT,
    centerLng: CENTER_LNG,
    locationDescription:
      'Harbour House showcase floor, dressed as a mall. Shops are upholstery, stock and fittings. The kitchen is cooking oil. Gas lines do not burn. Corridors are tile, with a few benches. The sealed room is concrete.',
    pedestrianCount: 120,
    levels: [
      {
        id: 'G',
        name: 'Ground',
        index: 0,
        heightM: 4,
        designed: true,
        pedestrianCount: 120,
      },
    ],
    exits: [
      {
        id: 'exit-west',
        center: { x: -30, y: 0 },
        width: 2,
        edgeIndex: 3,
        description: 'West public exit.',
        status: 'open',
        photos: [],
        level: 'G',
        exitType: 'public',
      },
      {
        id: 'exit-east',
        center: { x: 30, y: 8 },
        width: 2,
        edgeIndex: 1,
        description: 'East public exit.',
        status: 'open',
        photos: [],
        level: 'G',
        exitType: 'public',
      },
      {
        id: 'exit-north',
        center: { x: 0, y: -20 },
        width: 2,
        edgeIndex: 0,
        description: 'North public exit.',
        status: 'congested',
        photos: [],
        level: 'G',
        exitType: 'public',
      },
    ],
    interiorWalls: [
      {
        id: 'w1',
        start: { x: -8, y: 20 },
        end: { x: -8, y: -14 },
        hasDoor: true,
        doorWidth: 1.6,
        doorPosition: 0.5,
        description: 'Drywall partition.',
        material: 'drywall',
        photos: [],
        insideBuilding: true,
        spatialContext: 'inside_building',
        level: 'G',
      },
      {
        id: 'w2',
        start: { x: 10, y: 14 },
        end: { x: 10, y: -20 },
        hasDoor: true,
        doorWidth: 1.6,
        doorPosition: 0.4,
        description: 'Drywall partition.',
        material: 'drywall',
        photos: [],
        insideBuilding: true,
        spatialContext: 'inside_building',
        level: 'G',
      },
      {
        id: 'w3',
        start: { x: 16, y: 20 },
        end: { x: 16, y: 12 },
        hasDoor: false,
        doorWidth: 1.6,
        doorPosition: 0.5,
        description: 'Sealed concrete room, west wall.',
        material: 'concrete',
        photos: [],
        insideBuilding: true,
        spatialContext: 'inside_building',
        level: 'G',
      },
      {
        id: 'w4',
        start: { x: 16, y: 12 },
        end: { x: 30, y: 12 },
        hasDoor: false,
        doorWidth: 1.6,
        doorPosition: 0.5,
        description: 'Sealed concrete room, north wall.',
        material: 'concrete',
        photos: [],
        insideBuilding: true,
        spatialContext: 'inside_building',
        level: 'G',
      },
    ],
    hazardZones: [],
    stairwells: [],
    blastSite: {
      x: -20,
      y: 0,
      radius: 15,
      manualRadius: true,
      manualRadiusM: 15,
      level: 'G',
      locationDescription: 'Showcase blast, 15 m, inside the west room.',
    },
    casualtyPins: [],
    plantedItems: [],
    wallInspectionPoints: [],
  },
};
