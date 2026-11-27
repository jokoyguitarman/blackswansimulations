/**
 * Three-storey office block fire, for showing smoke and people moving
 * between floors. 60 m by 27 m, 3 m ceilings, the same plan on every
 * storey:
 *
 *   y 15–27  N1 | N2 (glazed) | hallway | N3 (glazed) | N4
 *   y 12–15  ─── west stair ── main corridor ── east stair ───
 *   y  0–12  S1 | S2          | hallway | S3          | S4
 *            x 0  12       27   27–33   33         48     60
 *
 * The 3 m main corridor runs west to east, with an open door at each end.
 * The 6 m hallway crosses it at x 27–33 from the south door to the north
 * door, and holds the central stair. The west and east stairs sit in the
 * corridor. All three join G, L1 and L2. Only the ground floor has doors
 * to the outside, so the upper floors walk down.
 *
 * Every room opens onto the main corridor by a 0.9 m door. Neighbouring
 * rooms share a connecting door, and the four rooms beside the hallway
 * also have a 1.8 m double door onto it. The indoor router walks toward
 * the target and turns at the first wall it meets, so a room whose
 * straight line out ends at a doorless wall corner on the shell pins its
 * people there. Partitions mix gypsum, timber panelling, glass, brick and
 * the concrete hallway core. Each storey has three or four furnished
 * rooms (upholstered seating, timber shelving and desks, paper) and the
 * rest are empty.
 *
 * Ignition is the S1 store room in the south-west corner of the ground
 * floor. The 6 m ignition circle reaches no other room and lights its contents
 * at once. Its corridor door opens beside the west stair, so smoke takes
 * that stair up, and a glazed screen with a door joins it to the
 * furnished S2 office, so the fire crosses into S2.
 *
 * Outdoor studs are copied onto the upper floors, as in the stair shaft
 * test, so every storey has an enclosure.
 *
 * Plan metres, south-west origin, +x east, +y north. The editor frame is
 * the centroid, +y south.
 */
import { entryById, matchFromEntry, type PlacedObject } from './materialLibrary';
import { stairShaftStuds } from './stairShaftTest';
import type { InteriorWall, LevelDef, Stairwell } from './types';

const WIDTH_M = 60;
const DEPTH_M = 27;
const CENTER_LAT = 1.306;
const CENTER_LNG = 103.788;
const LEVEL_IDS = ['G', 'L1', 'L2'] as const;
type LevelId = (typeof LEVEL_IDS)[number];

export type OfficeTowerFrame = 'plan' | 'editor';

export function officeTowerToPlan(
  point: { x: number; y: number },
  frame: OfficeTowerFrame,
): { x: number; y: number } {
  if (frame === 'plan') return { x: point.x, y: point.y };
  return { x: point.x + WIDTH_M / 2, y: DEPTH_M / 2 - point.y };
}

function fromPlan(point: { x: number; y: number }, frame: OfficeTowerFrame) {
  if (frame === 'plan') return { x: point.x, y: point.y };
  return { x: point.x - WIDTH_M / 2, y: DEPTH_M / 2 - point.y };
}

type Furnishing = 'store' | 'office' | 'lounge' | 'archive';

export interface OfficeTowerRoom {
  id: string;
  name: string;
  rect: { x0: number; y0: number; x1: number; y1: number };
  /** The row of cells against the corridor stays bare as the aisle. */
  aisleY: number;
}

const ROOMS: readonly OfficeTowerRoom[] = [
  { id: 'S1', name: 'S1', rect: { x0: 0, y0: 0, x1: 12, y1: 12 }, aisleY: 10.5 },
  { id: 'S2', name: 'S2', rect: { x0: 12, y0: 0, x1: 27, y1: 12 }, aisleY: 10.5 },
  { id: 'S3', name: 'S3', rect: { x0: 33, y0: 0, x1: 48, y1: 12 }, aisleY: 10.5 },
  { id: 'S4', name: 'S4', rect: { x0: 48, y0: 0, x1: 60, y1: 12 }, aisleY: 10.5 },
  { id: 'N1', name: 'N1', rect: { x0: 0, y0: 15, x1: 12, y1: 27 }, aisleY: 16.5 },
  { id: 'N2', name: 'N2', rect: { x0: 12, y0: 15, x1: 27, y1: 27 }, aisleY: 16.5 },
  { id: 'N3', name: 'N3', rect: { x0: 33, y0: 15, x1: 48, y1: 27 }, aisleY: 16.5 },
  { id: 'N4', name: 'N4', rect: { x0: 48, y0: 15, x1: 60, y1: 27 }, aisleY: 16.5 },
];

/** Furnished rooms by storey. Every other room is empty. */
const FURNISHED: Record<LevelId, Partial<Record<string, Furnishing>>> = {
  G: { S1: 'store', S2: 'office', N3: 'lounge', N4: 'archive' },
  L1: { N1: 'archive', S2: 'office', S4: 'lounge' },
  L2: { N2: 'lounge', S3: 'office', N4: 'archive' },
};

export function officeTowerRoomAt(point: { x: number; y: number }): OfficeTowerRoom | null {
  for (const room of ROOMS) {
    const r = room.rect;
    if (point.x > r.x0 && point.x < r.x1 && point.y > r.y0 && point.y < r.y1) return room;
  }
  return null;
}

interface PlanWall {
  id: string;
  start: { x: number; y: number };
  end: { x: number; y: number };
  doorPosition?: number;
  doorWidth?: number;
  description: string;
  material: string;
}

const ROOM_DOOR_M = 0.9;
const HALL_DOOR_M = 1.8;

/** Corridor walls with one door per room, then the partitions between rooms. */
function planWalls(level: LevelId): PlanWall[] {
  const timberWest = level === 'L2' ? null : 'N1 / N2 timber panelling, connecting door open.';
  return [
    {
      id: 'cs-s1',
      start: { x: 0, y: 12 },
      end: { x: 12, y: 12 },
      doorPosition: 0.375,
      description: 'S1 corridor wall and door, open, beside the west stair.',
      material: 'drywall',
    },
    {
      id: 'cs-s2',
      start: { x: 12, y: 12 },
      end: { x: 27, y: 12 },
      doorPosition: 0.5,
      description: 'S2 corridor wall and door, open.',
      material: 'drywall',
    },
    {
      id: 'cs-s3',
      start: { x: 33, y: 12 },
      end: { x: 48, y: 12 },
      doorPosition: 0.5,
      description: 'S3 corridor wall and door, open.',
      material: 'drywall',
    },
    {
      id: 'cs-s4',
      start: { x: 48, y: 12 },
      end: { x: 60, y: 12 },
      doorPosition: 0.25,
      description: 'S4 corridor wall and door, open.',
      material: 'drywall',
    },
    {
      id: 'cn-n1',
      start: { x: 0, y: 15 },
      end: { x: 12, y: 15 },
      doorPosition: 0.75,
      description: 'N1 corridor wall and door, open.',
      material: 'drywall',
    },
    {
      id: 'cn-n2',
      start: { x: 12, y: 15 },
      end: { x: 27, y: 15 },
      doorPosition: 0.5,
      description: 'N2 corridor wall and door, open.',
      material: 'drywall',
    },
    {
      id: 'cn-n3',
      start: { x: 33, y: 15 },
      end: { x: 48, y: 15 },
      doorPosition: 0.5,
      description: 'N3 corridor wall and door, open.',
      material: 'drywall',
    },
    {
      id: 'cn-n4',
      start: { x: 48, y: 15 },
      end: { x: 60, y: 15 },
      doorPosition: 0.25,
      description: 'N4 corridor wall and door, open.',
      material: 'drywall',
    },
    {
      id: 'p-s12',
      start: { x: 12, y: 0 },
      end: { x: 12, y: 12 },
      doorPosition: 0.375,
      description:
        level === 'G'
          ? 'Glazed screen between the S1 store and the S2 office, door open.'
          : 'S1 / S2 gypsum partition, connecting door open.',
      material: level === 'G' ? 'glass' : 'drywall',
    },
    {
      id: 'p-n12',
      start: { x: 12, y: 15 },
      end: { x: 12, y: 27 },
      doorPosition: 0.625,
      description: timberWest ?? 'N1 / N2 gypsum partition, connecting door open.',
      material: timberWest ? 'timber panelling' : 'drywall',
    },
    {
      id: 'core-sw',
      start: { x: 27, y: 0 },
      end: { x: 27, y: 12 },
      doorPosition: 0.25,
      doorWidth: HALL_DOOR_M,
      description: 'Concrete core wall between S2 and the hallway, with an open double door.',
      material: 'concrete',
    },
    {
      id: 'core-se',
      start: { x: 33, y: 0 },
      end: { x: 33, y: 12 },
      doorPosition: 0.25,
      doorWidth: HALL_DOOR_M,
      description: 'Concrete core wall between S3 and the hallway, with an open double door.',
      material: 'concrete',
    },
    {
      id: 'glaze-nw',
      start: { x: 27, y: 15 },
      end: { x: 27, y: 27 },
      doorPosition: 0.5,
      doorWidth: HALL_DOOR_M,
      description: 'Glazed screen between N2 and the hallway, with an open double door.',
      material: 'glass',
    },
    {
      id: 'glaze-ne',
      start: { x: 33, y: 15 },
      end: { x: 33, y: 27 },
      doorPosition: 0.5,
      doorWidth: HALL_DOOR_M,
      description: 'Glazed screen between N3 and the hallway, with an open double door.',
      material: 'glass',
    },
    {
      id: 'p-s34',
      start: { x: 48, y: 0 },
      end: { x: 48, y: 12 },
      doorPosition: 0.375,
      description: 'S3 / S4 brick wall, connecting door open.',
      material: 'brick',
    },
    {
      id: 'p-n34',
      start: { x: 48, y: 15 },
      end: { x: 48, y: 27 },
      doorPosition: 0.625,
      description:
        level === 'L2'
          ? 'N3 / N4 timber panelling, connecting door open.'
          : 'N3 / N4 brick wall, connecting door open.',
      material: level === 'L2' ? 'timber panelling' : 'brick',
    },
  ];
}

export function officeTowerWalls(frame: OfficeTowerFrame = 'editor'): InteriorWall[] {
  const out: InteriorWall[] = [];
  for (const level of LEVEL_IDS) {
    for (const wall of planWalls(level)) {
      const hasDoor = wall.doorPosition != null;
      out.push({
        id: `${level}-${wall.id}`,
        start: fromPlan(wall.start, frame),
        end: fromPlan(wall.end, frame),
        hasDoor,
        doorWidth: hasDoor ? (wall.doorWidth ?? ROOM_DOOR_M) : 0,
        doorPosition: wall.doorPosition ?? 0.5,
        description: wall.description,
        material: wall.material,
        photos: [],
        insideBuilding: true,
        spatialContext: 'inside_building',
        level,
      });
    }
  }
  return out;
}

type FuelKind = 'foam' | 'wood' | 'paper';

/** Fuel for one cell of a furnished room, by its column and row inside the room. */
function furnishingFuel(
  style: Furnishing,
  col: number,
  row: number,
): { kind: FuelKind; description: string } {
  switch (style) {
    case 'store':
      if (col === 0) return { kind: 'wood', description: 'Timber shelving' };
      if (row === 0) return { kind: 'paper', description: 'Cardboard boxes' };
      return { kind: 'foam', description: 'Upholstered sofas, stored' };
    case 'office':
      if ((col + row) % 3 === 0) return { kind: 'paper', description: 'Paper files' };
      return { kind: 'wood', description: 'Timber desks' };
    case 'lounge':
      if (col % 2 === 1 && row % 2 === 1) return { kind: 'wood', description: 'Timber table' };
      return { kind: 'foam', description: 'Upholstered seating' };
    case 'archive':
      if (row % 2 === 0) return { kind: 'wood', description: 'Timber shelving' };
      return { kind: 'paper', description: 'Boxed paper' };
  }
}

export interface OfficeTowerStud {
  id: string;
  simPos: { x: number; y: number };
  spatialContext?: string | null;
  level?: string;
}

/** Fuel in the furnished rooms only. The aisle row by each door stays bare. */
export function officeTowerFuelObjects(
  studs: readonly OfficeTowerStud[],
  frame: OfficeTowerFrame = 'editor',
): PlacedObject[] {
  const objects: PlacedObject[] = [];
  for (const stud of studs) {
    if (stud.spatialContext !== 'inside_building') continue;
    const level = (stud.level ?? 'G') as LevelId;
    const furnished = FURNISHED[level];
    if (!furnished) continue;
    const plan = officeTowerToPlan(stud.simPos, frame);
    const room = officeTowerRoomAt(plan);
    if (!room) continue;
    const style = furnished[room.id];
    if (!style) continue;
    if (Math.abs(plan.y - room.aisleY) < 0.1) continue;
    const col = Math.floor((plan.x - room.rect.x0) / 3);
    const row = Math.floor(Math.abs(plan.y - room.aisleY) / 3) - 1;
    const spec = furnishingFuel(style, col, row);
    const entry = entryById(spec.kind);
    if (!entry) continue;
    objects.push({
      id: `ot-${stud.id}`,
      studId: stud.id,
      pos: { x: stud.simPos.x, y: stud.simPos.y },
      level,
      description: `${room.name}: ${spec.description}`,
      matches: [matchFromEntry(entry, 'keyword')],
      confirmed: true,
    });
  }
  return objects;
}

export function officeTowerStuds(polygon: [number, number][]) {
  return stairShaftStuds(polygon, [...LEVEL_IDS]);
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
  { id: 'G', name: 'Ground', index: 0, heightM: 3, designed: true, pedestrianCount: 50 },
  { id: 'L1', name: 'Level 1', index: 1, heightM: 3, designed: true, pedestrianCount: 100 },
  { id: 'L2', name: 'Level 2', index: 2, heightM: 3, designed: true, pedestrianCount: 100 },
];

function stair(id: string, plan: { x: number; y: number }, label: string): Stairwell {
  return {
    id,
    pos: fromPlan(plan, 'editor'),
    connectsFloors: [0, 2],
    blocked: false,
    label,
    kind: 'stair',
    widthM: 1.2,
    levels: { from: 'G', to: 'L2' },
  };
}

function groundExit(
  id: string,
  plan: { x: number; y: number },
  width: number,
  edgeIndex: number,
  description: string,
) {
  return {
    id,
    center: fromPlan(plan, 'editor'),
    width,
    edgeIndex,
    description,
    status: 'open',
    photos: [] as string[],
    level: 'G',
    exitType: 'public',
  };
}

export const OFFICE_TOWER_IGNITION_PLAN = { x: 4.5, y: 4.5 };
export const OFFICE_TOWER_IGNITION_RADIUS_M = 6;
export const OFFICE_TOWER_SIZE_M = { width: WIDTH_M, depth: DEPTH_M };

export const officeTowerSample = {
  scene: {
    name: 'Three-storey office fire',
    buildingName: 'Three-storey office block',
    buildingPolygon: rectanglePolygon(CENTER_LAT, CENTER_LNG, WIDTH_M, DEPTH_M),
    centerLat: CENTER_LAT,
    centerLng: CENTER_LNG,
    locationDescription:
      'Three-storey office block, 60 m by 27 m, 3 m ceilings, the same plan on every floor. A 3 m corridor runs west to east with an open door at each end, and a 6 m hallway crosses it from the south door to the north door. Eight rooms per floor open off the corridor and share connecting doors; three or four are furnished and the rest are empty. Walls mix gypsum, timber panelling, glass, brick and concrete. Three stairs (west, centre, east) join all three floors, and only the ground floor has doors out. The fire starts in S1, the ground-floor store room in the south-west corner, whose door opens beside the west stair and whose glazed screen joins the furnished S2 office.',
    pedestrianCount: 0,
    hoodFanWhen: 'discharge' as const,
    levels: LEVELS,
    exits: [
      groundExit('exit-west', { x: 0, y: 13.5 }, 1.8, 3, 'West corridor door, open.'),
      groundExit('exit-east', { x: 60, y: 13.5 }, 1.8, 1, 'East corridor door, open.'),
      groundExit('exit-south', { x: 30, y: 0 }, 2.4, 2, 'South hallway entrance, open.'),
      groundExit('exit-north', { x: 30, y: 27 }, 2.4, 0, 'North hallway entrance, open.'),
    ],
    interiorWalls: officeTowerWalls('editor'),
    hazardZones: [],
    stairwells: [
      stair('stair-west', { x: 4.5, y: 13.5 }, 'West stair'),
      stair('stair-centre', { x: 30, y: 22.5 }, 'Centre stair'),
      stair('stair-east', { x: 55.5, y: 13.5 }, 'East stair'),
    ],
    blastSite: {
      ...fromPlan(OFFICE_TOWER_IGNITION_PLAN, 'editor'),
      radius: OFFICE_TOWER_IGNITION_RADIUS_M,
      manualRadius: true,
      manualRadiusM: OFFICE_TOWER_IGNITION_RADIUS_M,
      level: 'G',
      locationDescription: 'Ignition in S1, the ground-floor store room.',
    },
    casualtyPins: [],
    plantedItems: [],
    wallInspectionPoints: [],
  },
};
