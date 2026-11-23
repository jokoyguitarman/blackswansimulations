/**
 * Harbour House is the evacuation showcase floor: 60 m by 40 m, three exits,
 * two drywall partitions, and a sealed concrete room. The repo had no scene
 * under this name. This is that floor, with confirmed wood on every indoor
 * stud so the house burns again and a stud with no object stays dark.
 *
 * Local metres match the editor: origin at the building centre, +x east, +y south.
 * The review harness used the same plan with its origin at the south-west corner
 * and +y north. Distances match after that mirror.
 */

import { entryById, matchFromEntry, type PlacedObject } from './materialLibrary';

export interface FurnishingStud {
  id: string;
  simPos: { x: number; y: number };
  spatialContext?: string | null;
  level?: string;
}

export function harbourHouseFuelObjects(studs: readonly FurnishingStud[]): PlacedObject[] {
  const wood = entryById('wood');
  if (!wood) return [];
  return studs
    .filter((stud) => stud.spatialContext === 'inside_building')
    .map((stud) => ({
      id: `hh-${stud.id}`,
      studId: stud.id,
      pos: { x: stud.simPos.x, y: stud.simPos.y },
      level: stud.level ?? 'G',
      description: 'Wooden furnishings',
      matches: [matchFromEntry(wood, 'keyword')],
      confirmed: true,
    }));
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
      'Harbour House showcase floor. Confirmed wooden furnishings cover the indoor studs. A stud with no object, including the ground outside, stays dark.',
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
