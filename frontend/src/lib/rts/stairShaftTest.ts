/**
 * Two-storey shaft test. One room on each floor, 12 m by 9 m, ceilings
 * 3 m. The ground floor is furnished. The upper floor is bare, so anything
 * up there came through the stair or the lift. Each floor has one door to
 * the outside, below the ceiling, so a layer can form. Detonate on the
 * ground floor.
 *
 * Outdoor studs are copied onto the upper floor. The generator only builds
 * them on the ground, and a storey with no outside neighbour has no
 * enclosure.
 *
 * Plan metres, south-west origin, +x east, +y north. The editor frame is
 * the centroid, +y south.
 */
import { entryById, matchFromEntry, type PlacedObject } from './materialLibrary';
import { generateSceneStuds, type SceneStud } from './sceneStuds';
import type { LevelDef, Stairwell } from './types';

const WIDTH_M = 12;
const DEPTH_M = 9;
const CENTER_LAT = 1.302;
const CENTER_LNG = 103.792;

export type StairShaftFrame = 'plan' | 'editor';

export function stairShaftToPlan(
  point: { x: number; y: number },
  frame: StairShaftFrame,
): { x: number; y: number } {
  if (frame === 'plan') return { x: point.x, y: point.y };
  return { x: point.x + WIDTH_M / 2, y: DEPTH_M / 2 - point.y };
}

function fromPlan(point: { x: number; y: number }, frame: StairShaftFrame) {
  if (frame === 'plan') return { x: point.x, y: point.y };
  return { x: point.x - WIDTH_M / 2, y: DEPTH_M / 2 - point.y };
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

const LEVELS: LevelDef[] = [
  { id: 'G', name: 'Ground', index: 0, heightM: 3, designed: true, pedestrianCount: 0 },
  { id: 'L1', name: 'Level 1', index: 1, heightM: 3, designed: true, pedestrianCount: 0 },
];

function shaftLink(
  id: string,
  plan: { x: number; y: number },
  kind: 'stair' | 'lift',
  label: string,
): Stairwell {
  return {
    id,
    pos: fromPlan(plan, 'editor'),
    connectsFloors: [0, 1],
    blocked: false,
    label,
    kind,
    widthM: 1.2,
    levels: { from: 'G', to: 'L1' },
  };
}

/** Ground floor plus a copy of every outdoor stud on each upper storey. */
export function stairShaftStuds(polygon: [number, number][], levelIds: string[]): SceneStud[] {
  const studs = generateSceneStuds(polygon, 0, levelIds);
  const extra: SceneStud[] = [];
  const outdoor = studs.filter((stud) => stud.studType === 'outdoor');
  for (const level of levelIds) {
    if (level === 'G' || level === 'Ground') continue;
    for (const stud of outdoor) {
      extra.push({ ...stud, id: `${stud.id}-${level}`, floor: level });
    }
  }
  return [...studs, ...extra];
}

export interface StairShaftStud {
  id: string;
  simPos: { x: number; y: number };
  spatialContext?: string | null;
  level?: string;
}

/** Wood on the ground floor only. The upper floor stays bare. */
export function stairShaftFuelObjects(
  studs: readonly StairShaftStud[],
  frame: StairShaftFrame = 'editor',
): PlacedObject[] {
  const entry = entryById('wood');
  if (!entry) return [];
  const objects: PlacedObject[] = [];
  for (const stud of studs) {
    if (stud.spatialContext !== 'inside_building') continue;
    if ((stud.level ?? 'G') !== 'G') continue;
    const plan = stairShaftToPlan(stud.simPos, frame);
    if (plan.x < 0 || plan.x > WIDTH_M || plan.y < 0 || plan.y > DEPTH_M) continue;
    objects.push({
      id: `shaft-${stud.id}`,
      studId: stud.id,
      pos: { x: stud.simPos.x, y: stud.simPos.y },
      level: 'G',
      description: 'Ground-floor furniture',
      matches: [matchFromEntry(entry, 'keyword')],
      confirmed: true,
    });
  }
  return objects;
}

const polygon = rectanglePolygon(CENTER_LAT, CENTER_LNG, WIDTH_M, DEPTH_M);

export const stairShaftSample = {
  scene: {
    name: 'Stair shaft test',
    buildingName: 'Two-storey shaft block',
    buildingPolygon: polygon,
    centerLat: CENTER_LAT,
    centerLng: CENTER_LNG,
    locationDescription:
      'Two storeys, 12 m by 9 m, 3 m ceilings. The ground floor is furnished and the upper floor is empty. A stair at the north-west and a lift at the north-east connect them. Each floor has one open door to the outside. Detonate on the ground floor, then switch to Level 1: smoke in the bare room came up the shaft.',
    pedestrianCount: 0,
    hoodFanWhen: 'discharge' as const,
    levels: LEVELS,
    exits: [
      {
        id: 'exit-ground-south',
        center: fromPlan({ x: 6, y: 0 }, 'editor'),
        width: 1.2,
        edgeIndex: 2,
        description: 'Ground floor south door, open.',
        status: 'open',
        photos: [],
        level: 'G',
        exitType: 'public',
      },
      {
        id: 'exit-upper-north',
        center: fromPlan({ x: 6, y: 9 }, 'editor'),
        width: 1.2,
        edgeIndex: 0,
        description: 'Upper floor north door, open.',
        status: 'open',
        photos: [],
        level: 'L1',
        exitType: 'public',
      },
    ],
    interiorWalls: [],
    hazardZones: [],
    stairwells: [
      shaftLink('stair-nw', { x: 3, y: 6.5 }, 'stair', 'Stair'),
      shaftLink('lift-ne', { x: 9, y: 6.5 }, 'lift', 'Lift'),
    ],
    blastSite: {
      ...fromPlan({ x: 6, y: 3 }, 'editor'),
      radius: 4,
      manualRadius: true,
      manualRadiusM: 4,
      level: 'G',
      locationDescription: 'Ignition on the ground floor.',
    },
    casualtyPins: [],
    plantedItems: [],
    wallInspectionPoints: [],
  },
};
