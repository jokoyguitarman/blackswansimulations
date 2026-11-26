/**
 * Smoke corridor test block: a single-storey office floor, 54 m by 30 m,
 * built to watch hot gas and smoke move through a building. One store room
 * holds furniture and is the fire. Every other room, the corridors and the
 * atrium hold nothing that burns, so anything they get is carried there by
 * the layer flow through the openings.
 *
 * Layout, plan metres, south-west origin, +x east, +y north:
 *
 *   y 21–30  Store (fire) | Office N2 | Office N3 | Meeting N4 (door shut) |
 *   y 18–21  West corridor ─ cross door ─ East corridor ──────────┐ Atrium
 *   y  9–18  Office S1 | Office S2 | Office S3 ← door ─ Junction leg │ x 36–54
 *   y  0– 9  Archive (through S2)   | Office S5 ← door ─ South corridor │
 *                                               South exit (open) ┘  East doors shut
 *
 * The east corridor turns south at x 33–36 and is one compartment with that
 * leg, an L. A held-open cross-corridor door at y = 9 splits off the south
 * corridor, which ends at the open south exit. The atrium opens off the
 * junction through a 2.4 m opening. Its east doors to the street are shut,
 * so it is a reservoir. The meeting room door is shut and pinned, so only
 * the wall leak reaches it.
 *
 * Walls sit on the 3 m stud lines, so each 3 m cell has one stud at its
 * centre and every corridor is one stud wide. Ceilings are 3 m throughout:
 * the engine takes one height per storey, so the atrium is not taller.
 * Partitions are plasterboard and inert, so no lining joins the fire.
 *
 * The editor frame is the centroid, +y south. Plan metres are the test frame.
 */

import { entryById, matchFromEntry, type PlacedObject } from './materialLibrary';
import type { InteriorWall } from './types';

const WIDTH_M = 54;
const DEPTH_M = 30;
const CENTER_LAT = 1.304;
const CENTER_LNG = 103.79;

export type SmokeCorridorFrame = 'plan' | 'editor';

export interface SmokeCorridorRoom {
  id: string;
  name: string;
  /** Plan rectangles, metres. The east corridor is an L, so it has two. */
  rects: Array<{ x0: number; y0: number; x1: number; y1: number }>;
  fuel: boolean;
}

export const SMOKE_CORRIDOR_ROOMS: readonly SmokeCorridorRoom[] = [
  { id: 'store', name: 'Store room (fire)', rects: [{ x0: 0, y0: 21, x1: 9, y1: 30 }], fuel: true },
  { id: 'office-n2', name: 'Office N2', rects: [{ x0: 9, y0: 21, x1: 18, y1: 30 }], fuel: false },
  { id: 'office-n3', name: 'Office N3', rects: [{ x0: 18, y0: 21, x1: 27, y1: 30 }], fuel: false },
  {
    id: 'meeting-n4',
    name: 'Meeting room N4 (door shut)',
    rects: [{ x0: 27, y0: 21, x1: 36, y1: 30 }],
    fuel: false,
  },
  {
    id: 'corridor-west',
    name: 'West corridor',
    rects: [{ x0: 0, y0: 18, x1: 18, y1: 21 }],
    fuel: false,
  },
  {
    id: 'corridor-junction',
    name: 'East corridor and junction',
    rects: [
      { x0: 18, y0: 18, x1: 36, y1: 21 },
      { x0: 33, y0: 9, x1: 36, y1: 18 },
    ],
    fuel: false,
  },
  {
    id: 'corridor-south',
    name: 'South corridor (exit)',
    rects: [{ x0: 33, y0: 0, x1: 36, y1: 9 }],
    fuel: false,
  },
  { id: 'office-s1', name: 'Office S1', rects: [{ x0: 0, y0: 9, x1: 12, y1: 18 }], fuel: false },
  { id: 'office-s2', name: 'Office S2', rects: [{ x0: 12, y0: 9, x1: 24, y1: 18 }], fuel: false },
  { id: 'office-s3', name: 'Office S3', rects: [{ x0: 24, y0: 9, x1: 33, y1: 18 }], fuel: false },
  {
    id: 'archive',
    name: 'Archive (via S2)',
    rects: [{ x0: 0, y0: 0, x1: 24, y1: 9 }],
    fuel: false,
  },
  { id: 'office-s5', name: 'Office S5', rects: [{ x0: 24, y0: 0, x1: 33, y1: 9 }], fuel: false },
  { id: 'atrium', name: 'Atrium', rects: [{ x0: 36, y0: 0, x1: 54, y1: 30 }], fuel: false },
];

/** Room id for a plan point, or null outside the footprint. */
export function smokeCorridorRoomAt(point: { x: number; y: number }): string | null {
  for (const room of SMOKE_CORRIDOR_ROOMS) {
    for (const r of room.rects) {
      if (point.x > r.x0 && point.x < r.x1 && point.y > r.y0 && point.y < r.y1) return room.id;
    }
  }
  return null;
}

export function smokeCorridorToPlan(
  point: { x: number; y: number },
  frame: SmokeCorridorFrame,
): { x: number; y: number } {
  if (frame === 'plan') return { x: point.x, y: point.y };
  return { x: point.x + WIDTH_M / 2, y: DEPTH_M / 2 - point.y };
}

function fromPlan(point: { x: number; y: number }, frame: SmokeCorridorFrame) {
  if (frame === 'plan') return { x: point.x, y: point.y };
  return { x: point.x - WIDTH_M / 2, y: DEPTH_M / 2 - point.y };
}

interface PlanWall {
  id: string;
  start: { x: number; y: number };
  end: { x: number; y: number };
  doorWidth?: number;
  doorPosition?: number;
  /** Leaf shut and pinned. */
  shut?: boolean;
  description: string;
  material: string;
}

const OFFICE_DOOR_M = 0.9;
const CROSS_DOOR_M = 1.8;

const PLAN_WALLS: PlanWall[] = [
  // North rooms onto the corridor, one door each.
  {
    id: 'w-store-door',
    start: { x: 0, y: 21 },
    end: { x: 9, y: 21 },
    doorWidth: OFFICE_DOOR_M,
    doorPosition: 0.5,
    description: 'Store room door, left open.',
    material: 'drywall',
  },
  {
    id: 'w-n2-door',
    start: { x: 9, y: 21 },
    end: { x: 18, y: 21 },
    doorWidth: OFFICE_DOOR_M,
    doorPosition: 0.5,
    description: 'Office N2 door, open.',
    material: 'drywall',
  },
  {
    id: 'w-n3-door',
    start: { x: 18, y: 21 },
    end: { x: 27, y: 21 },
    doorWidth: OFFICE_DOOR_M,
    doorPosition: 0.5,
    description: 'Office N3 door, open.',
    material: 'drywall',
  },
  {
    id: 'w-n4-door',
    start: { x: 27, y: 21 },
    end: { x: 36, y: 21 },
    doorWidth: OFFICE_DOOR_M,
    doorPosition: 0.5,
    shut: true,
    description: 'Meeting room N4 door, shut.',
    material: 'drywall',
  },
  {
    id: 'w-n-part-9',
    start: { x: 9, y: 21 },
    end: { x: 9, y: 30 },
    description: 'Store room / N2 partition.',
    material: 'drywall',
  },
  {
    id: 'w-n-part-18',
    start: { x: 18, y: 21 },
    end: { x: 18, y: 30 },
    description: 'N2 / N3 partition.',
    material: 'drywall',
  },
  {
    id: 'w-n-part-27',
    start: { x: 27, y: 21 },
    end: { x: 27, y: 30 },
    description: 'N3 / N4 partition.',
    material: 'drywall',
  },
  // Cross-corridor doors, held open.
  {
    id: 'w-cross-west',
    start: { x: 18, y: 18 },
    end: { x: 18, y: 21 },
    doorWidth: CROSS_DOOR_M,
    doorPosition: 0.5,
    description: 'Cross-corridor door, held open.',
    material: 'drywall',
  },
  {
    id: 'w-cross-south',
    start: { x: 33, y: 9 },
    end: { x: 36, y: 9 },
    doorWidth: CROSS_DOOR_M,
    doorPosition: 0.5,
    description: 'South corridor cross door, held open.',
    material: 'drywall',
  },
  // South side of the main corridor.
  {
    id: 'w-s1-door',
    start: { x: 0, y: 18 },
    end: { x: 12, y: 18 },
    doorWidth: OFFICE_DOOR_M,
    doorPosition: 0.5,
    description: 'Office S1 door, open.',
    material: 'drywall',
  },
  {
    id: 'w-s2-door',
    start: { x: 12, y: 18 },
    end: { x: 24, y: 18 },
    doorWidth: OFFICE_DOOR_M,
    doorPosition: 0.25,
    description: 'Office S2 door, open.',
    material: 'drywall',
  },
  {
    id: 'w-s3-back',
    start: { x: 24, y: 18 },
    end: { x: 33, y: 18 },
    description: 'Office S3 north wall.',
    material: 'drywall',
  },
  {
    id: 'w-s-part-12',
    start: { x: 12, y: 9 },
    end: { x: 12, y: 18 },
    description: 'S1 / S2 partition.',
    material: 'drywall',
  },
  {
    id: 'w-s-part-24',
    start: { x: 24, y: 0 },
    end: { x: 24, y: 18 },
    description: 'S2 and archive / S3 and S5 partition.',
    material: 'drywall',
  },
  {
    id: 'w-archive-door',
    start: { x: 0, y: 9 },
    end: { x: 24, y: 9 },
    doorWidth: OFFICE_DOOR_M,
    doorPosition: 0.75,
    description: 'Archive door from office S2, open.',
    material: 'drywall',
  },
  {
    id: 'w-s3-s5',
    start: { x: 24, y: 9 },
    end: { x: 33, y: 9 },
    description: 'S3 / S5 partition.',
    material: 'drywall',
  },
  // Rooms off the junction leg and the south corridor.
  {
    id: 'w-s3-door',
    start: { x: 33, y: 9 },
    end: { x: 33, y: 18 },
    doorWidth: OFFICE_DOOR_M,
    doorPosition: 0.5,
    description: 'Office S3 door onto the junction, open.',
    material: 'drywall',
  },
  {
    id: 'w-s5-door',
    start: { x: 33, y: 0 },
    end: { x: 33, y: 9 },
    doorWidth: OFFICE_DOOR_M,
    doorPosition: 0.5,
    description: 'Office S5 door onto the south corridor, open.',
    material: 'drywall',
  },
  {
    id: 'w-atrium',
    start: { x: 36, y: 0 },
    end: { x: 36, y: 30 },
    doorWidth: 2.4,
    doorPosition: 0.65,
    description: 'Atrium wall, 2.4 m opening off the corridor.',
    material: 'concrete',
  },
];

export function smokeCorridorWalls(frame: SmokeCorridorFrame = 'editor'): InteriorWall[] {
  return PLAN_WALLS.map((wall) => {
    const hasDoor = wall.doorWidth != null;
    const out: InteriorWall = {
      id: wall.id,
      start: fromPlan(wall.start, frame),
      end: fromPlan(wall.end, frame),
      hasDoor,
      doorWidth: wall.doorWidth ?? 0,
      doorPosition: wall.doorPosition ?? 0.5,
      description: wall.description,
      material: wall.material,
      photos: [],
      insideBuilding: true,
      spatialContext: 'inside_building',
      level: 'G',
    };
    if (wall.shut) {
      out.openFraction = 0;
      out.doorPinned = true;
    }
    return out;
  });
}

type StoreFuel = 'foam' | 'wood' | 'paper';

/** Store room studs by 3 m cell, column then row from the south-west corner. */
const STORE_FUEL: Record<string, { kind: StoreFuel; description: string }> = {
  '1,8': { kind: 'foam', description: 'Upholstered sofa' },
  '0,9': { kind: 'foam', description: 'Upholstered armchairs' },
  '2,9': { kind: 'foam', description: 'Upholstered sofa' },
  '0,8': { kind: 'wood', description: 'Timber shelving' },
  '2,8': { kind: 'wood', description: 'Timber desks, stacked' },
  '1,9': { kind: 'wood', description: 'Timber cabinets' },
  '0,7': { kind: 'paper', description: 'Boxed paper' },
  '2,7': { kind: 'paper', description: 'Cardboard boxes' },
};

export interface SmokeCorridorStud {
  id: string;
  simPos: { x: number; y: number };
  spatialContext?: string | null;
  level?: string;
}

/** Fuel only in the store room. The cell by its door is the aisle and stays bare. */
export function smokeCorridorFuelObjects(
  studs: readonly SmokeCorridorStud[],
  frame: SmokeCorridorFrame = 'editor',
): PlacedObject[] {
  const objects: PlacedObject[] = [];
  for (const stud of studs) {
    if (stud.spatialContext !== 'inside_building') continue;
    const plan = smokeCorridorToPlan(stud.simPos, frame);
    if (smokeCorridorRoomAt(plan) !== 'store') continue;
    const spec = STORE_FUEL[`${Math.floor(plan.x / 3)},${Math.floor(plan.y / 3)}`];
    if (!spec) continue;
    const entry = entryById(spec.kind);
    if (!entry) continue;
    objects.push({
      id: `sc-${stud.id}`,
      studId: stud.id,
      pos: { x: stud.simPos.x, y: stud.simPos.y },
      level: stud.level ?? 'G',
      description: spec.description,
      matches: [matchFromEntry(entry, 'keyword')],
      confirmed: true,
    });
  }
  return objects;
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

/** Ignition point: the sofa in the middle of the store room. */
export const SMOKE_CORRIDOR_IGNITION_PLAN = { x: 4.5, y: 25.5 };
export const SMOKE_CORRIDOR_IGNITION_RADIUS_M = 2;
export const SMOKE_CORRIDOR_SIZE_M = { width: WIDTH_M, depth: DEPTH_M };

export const smokeCorridorSample = {
  scene: {
    name: 'Smoke corridor test',
    buildingName: 'Smoke corridor test block',
    buildingPolygon: rectanglePolygon(CENTER_LAT, CENTER_LNG, WIDTH_M, DEPTH_M),
    centerLat: CENTER_LAT,
    centerLng: CENTER_LNG,
    locationDescription:
      'Single-storey office test block, 54 m by 30 m, 3 m ceilings. A furniture store room in the north-west corner is the only fuel. It opens onto a 3 m corridor that runs east past three offices and a meeting room with its door shut, through a held-open cross door, to a junction. There the corridor turns south past two offices, through a second cross door, to the open south exit, and a 2.4 m opening leads east into an atrium whose street doors are shut. Offices S1 and S2 open off the west corridor, and an archive is reached only through S2. Nothing outside the store room burns.',
    pedestrianCount: 0,
    hoodFanWhen: 'discharge' as const,
    levels: [
      {
        id: 'G',
        name: 'Ground',
        index: 0,
        heightM: 3,
        designed: true,
        pedestrianCount: 0,
      },
    ],
    exits: [
      {
        id: 'exit-south',
        center: fromPlan({ x: 34.5, y: 0 }, 'editor'),
        width: 1.8,
        edgeIndex: 2,
        description: 'South exit at the end of the corridor, open.',
        status: 'open',
        photos: [],
        level: 'G',
        exitType: 'public',
      },
      {
        id: 'exit-atrium-east',
        center: fromPlan({ x: 54, y: 15 }, 'editor'),
        width: 3,
        edgeIndex: 1,
        description: 'Atrium street doors, shut.',
        status: 'blocked',
        photos: [],
        level: 'G',
        exitType: 'public',
      },
    ],
    interiorWalls: smokeCorridorWalls('editor'),
    hazardZones: [],
    stairwells: [],
    blastSite: {
      ...fromPlan(SMOKE_CORRIDOR_IGNITION_PLAN, 'editor'),
      radius: SMOKE_CORRIDOR_IGNITION_RADIUS_M,
      manualRadius: true,
      manualRadiusM: SMOKE_CORRIDOR_IGNITION_RADIUS_M,
      level: 'G',
      locationDescription: 'Ignition on the sofa in the store room.',
    },
    casualtyPins: [],
    plantedItems: [],
    wallInspectionPoints: [],
  },
};
