/**
 * Places a hawker centre inside a footprint. Counts and the storey come from
 * fetched pages. Where those pages are silent, the piece is assumed and says so.
 */

import { edgeLength, isInsidePolygon, nearestEdge } from '../evacuation/geometry';
import type { ExitDef, Vec2 } from '../evacuation/types';
import { entryById, matchFromEntry, type PlacedObject } from './materialLibrary';
import type { InteriorWall } from './types';
import type { HawkerFacts, LayoutSource } from '@shared/hawkerFacts';

export interface LayoutLabel {
  id: string;
  origin: 'researched' | 'assumed';
  text: string;
  sources: LayoutSource[];
}

export interface HawkerLayout {
  walls: InteriorWall[];
  exits: ExitDef[];
  objects: PlacedObject[];
  labels: LayoutLabel[];
  /** Seating point the existing charge can open a cooked stall's gas line from. */
  bomb: Vec2 | null;
}

const COOKED_NORM =
  'A cooked-food stall has a gas line, cooking oil, a wet-chemical hood, and an electrical appliance.';
const EXIT_NORM = 'An assembly floor has two ways out, on separate sides.';
const SERVICE_NORM = 'A market and food centre has a service door besides the public exits.';
const MARKET_NORM =
  'A wet-market stall holds produce, fish, or meat, so the fuel load is light. The pages do not say where the stalls stand.';
const TABLE_NORM = 'The seating between the stall rows has a wooden table on alternate studs.';
const PLACE_NORM =
  'The pages do not give a floor plan, so the stalls are lined up in rows inside the footprint.';
const WALL_NORM =
  'A stall row has a steel back wall and steel side partitions, and an open front toward the seating.';
const NO_STAIR_NORM = 'No upper floor was found, so no stair or lift is drawn.';
const COPY_NORM = 'An upper floor with no plan of its own copies the ground walls and exits.';
const BOMB_NORM =
  'The pages do not say where a device would be, so the bomb sits in the seating, a few metres from a cooked-food stall.';

/** Distance from the stall to the bomb, the fireball used on this session, and the crowd. */
export const HOLLAND_BOMB = {
  fromStallM: 4,
  fireballM: 8,
  crowd: 120,
} as const;

/** One stud on the 3 m grid is one stall. */
const PITCH_M = 3;
const ASSUMED_ROW = 4;
/**
 * The counter is shallower than the grid. A full-depth stall on a 3 m pitch
 * puts the next row's back wall on this row's open front and closes the bay.
 * 1.2 m behind the stud, with 0.5 m fins, leaves the stud in the aisle and
 * about 1.7 m clear to the next row once the wall thickness is taken off.
 */
const COUNTER_BACK_M = 1.2;
const COUNTER_DEPTH_M = 0.5;
/** Keep this much open between a row end and the shell, so the aisle can reach an exit. */
const END_CLEAR_M = 2.4;

interface Stud {
  id: string;
  x: number;
  y: number;
}

function inside(verts: Vec2[], x: number, y: number): boolean {
  return isInsidePolygon(x, y, verts);
}

function segmentInside(verts: Vec2[], start: Vec2, end: Vec2): boolean {
  for (let step = 0; step <= 4; step += 1) {
    const t = step / 4;
    if (!inside(verts, start.x + (end.x - start.x) * t, start.y + (end.y - start.y) * t)) {
      return false;
    }
  }
  return true;
}

function insetStud(verts: Vec2[], stud: Stud): boolean {
  return (
    inside(verts, stud.x, stud.y) &&
    inside(verts, stud.x + 2, stud.y) &&
    inside(verts, stud.x - 2, stud.y) &&
    inside(verts, stud.x, stud.y + 2) &&
    inside(verts, stud.x, stud.y - 2)
  );
}

function rowsNorthToSouth(studs: readonly Stud[]): Stud[][] {
  const groups = new Map<number, Stud[]>();
  for (const stud of studs) {
    const key = Math.round(stud.y * 100);
    const row = groups.get(key);
    if (row) row.push(stud);
    else groups.set(key, [stud]);
  }
  return [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, row]) => row.sort((left, right) => left.x - right.x));
}

function takeStuds(rows: readonly Stud[][], count: number, used: Set<string>): Stud[] {
  const chosen: Stud[] = [];
  if (count <= 0) return chosen;
  for (const row of rows) {
    for (const stud of row) {
      if (used.has(stud.id)) continue;
      used.add(stud.id);
      chosen.push(stud);
      if (chosen.length >= count) return chosen;
    }
  }
  return chosen;
}

function alternateStuds(studs: readonly Stud[]): Stud[] {
  const chosen: Stud[] = [];
  rowsNorthToSouth(studs).forEach((row, rowIndex) => {
    row.forEach((stud, column) => {
      if ((rowIndex + column) % 2 === 0) chosen.push(stud);
    });
  });
  return chosen;
}

function runsOf(row: readonly Stud[]): Stud[][] {
  const runs: Stud[][] = [];
  for (const stud of row) {
    const last = runs[runs.length - 1];
    const prev = last?.[last.length - 1];
    if (!prev || Math.abs(stud.x - prev.x) > PITCH_M * 1.4) runs.push([stud]);
    else last.push(stud);
  }
  return runs;
}

function objectAt(id: string, stud: Stud, entryId: string, description: string): PlacedObject {
  const entry = entryById(entryId);
  if (!entry) throw new Error(`missing library entry ${entryId}`);
  return {
    id,
    studId: stud.id,
    pos: { x: stud.x, y: stud.y },
    level: 'G',
    description,
    matches: [matchFromEntry(entry, 'chosen')],
    confirmed: true,
  };
}

function partition(id: string, start: Vec2, end: Vec2, description: string): InteriorWall {
  return {
    id,
    start,
    end,
    hasDoor: false,
    doorWidth: 0,
    doorPosition: 0.5,
    description,
    material: 'steel',
    photos: [],
    level: 'G',
  };
}

/** Back wall on the closed side, side partitions between stalls, open toward the seating. */
function boundaryDistance(verts: Vec2[], x: number, y: number): number {
  let best = Infinity;
  for (let index = 0; index < verts.length; index += 1) {
    const a = verts[index];
    const b = verts[(index + 1) % verts.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;
    const t =
      lenSq < 1e-9 ? 0 : Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / lenSq));
    best = Math.min(best, Math.hypot(x - a.x - t * dx, y - a.y - t * dy));
  }
  return best;
}

/** Pull both ends in until each is clear of the shell. Too short to keep means no wall. */
function clearOfShell(verts: Vec2[], start: Vec2, end: Vec2): { start: Vec2; end: Vec2 } | null {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const len = Math.hypot(dx, dy);
  if (len < 1) return null;
  const ux = dx / len;
  const uy = dy / len;
  let lo = 0;
  let hi = len;
  const step = 0.25;
  while (lo < hi && boundaryDistance(verts, start.x + ux * lo, start.y + uy * lo) < END_CLEAR_M) {
    lo += step;
  }
  while (hi > lo && boundaryDistance(verts, start.x + ux * hi, start.y + uy * hi) < END_CLEAR_M) {
    hi -= step;
  }
  if (hi - lo < 1) return null;
  return {
    start: { x: start.x + ux * lo, y: start.y + uy * lo },
    end: { x: start.x + ux * hi, y: start.y + uy * hi },
  };
}

function addRowWalls(
  verts: Vec2[],
  walls: InteriorWall[],
  stalls: readonly Stud[],
  openSouth: boolean,
  idPrefix: string,
  description: string,
) {
  let runIndex = 0;
  for (const row of rowsNorthToSouth(stalls)) {
    for (const run of runsOf(row)) {
      const y = run[0].y;
      const backY = openSouth ? y - COUNTER_BACK_M : y + COUNTER_BACK_M;
      const lipY = openSouth ? backY + COUNTER_DEPTH_M : backY - COUNTER_DEPTH_M;
      const x0 = run[0].x - PITCH_M / 2;
      const x1 = run[run.length - 1].x + PITCH_M / 2;
      const back = clearOfShell(verts, { x: x0, y: backY }, { x: x1, y: backY });
      if (back && segmentInside(verts, back.start, back.end)) {
        walls.push(partition(`${idPrefix}-back-${runIndex}`, back.start, back.end, description));
      }
      const edges = [x0];
      for (let index = 0; index < run.length - 1; index += 1) {
        edges.push((run[index].x + run[index + 1].x) / 2);
      }
      edges.push(x1);
      edges.forEach((x, edge) => {
        const start = { x, y: backY };
        const end = { x, y: lipY };
        if (
          boundaryDistance(verts, start.x, start.y) < END_CLEAR_M ||
          boundaryDistance(verts, end.x, end.y) < END_CLEAR_M
        ) {
          return;
        }
        if (segmentInside(verts, start, end)) {
          walls.push(partition(`${idPrefix}-side-${runIndex}-${edge}`, start, end, description));
        }
      });
      runIndex += 1;
    }
  }
}

function chooseExits(verts: Vec2[]): ExitDef[] {
  const edges = verts.map((_, index) => {
    const a = verts[index];
    const b = verts[(index + 1) % verts.length];
    return {
      index,
      length: edgeLength(verts, index),
      mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
    };
  });
  const usable = edges.filter((edge) => edge.length >= 4);
  if (usable.length === 0) return [];
  const first = [...usable].sort((a, b) => b.length - a.length)[0];
  let second = usable.find((edge) => edge.index !== first.index) ?? null;
  let farthest = -1;
  for (const edge of usable) {
    if (edge.index === first.index) continue;
    const distance = Math.hypot(edge.mid.x - first.mid.x, edge.mid.y - first.mid.y);
    if (distance > farthest) {
      farthest = distance;
      second = edge;
    }
  }
  const exits: ExitDef[] = [];
  const place = (
    edge: { index: number; mid: Vec2; length: number },
    id: string,
    kind: 'public' | 'service',
    description: string,
  ) => {
    const snap = nearestEdge(edge.mid.x, edge.mid.y, verts);
    const width = kind === 'service' ? 1.5 : Math.min(3, Math.max(1.5, edge.length * 0.25));
    exits.push({
      id,
      center: snap.point,
      width,
      edgeIndex: snap.edgeIndex,
      description,
      status: 'open',
      photos: [],
      level: 'G',
      exitType: kind,
    });
  };
  place(first, 'exit-public-a', 'public', `Public exit. Assumed. ${EXIT_NORM}`);
  if (second) place(second, 'exit-public-b', 'public', `Public exit. Assumed. ${EXIT_NORM}`);
  const service = [...usable]
    .filter((edge) => edge.index !== first.index && edge.index !== second?.index)
    .sort((a, b) => b.length - a.length)[0];
  if (service) {
    place(service, 'exit-service', 'service', `Service door. Assumed. ${SERVICE_NORM}`);
  }
  return exits;
}

function gasLine(objects: readonly PlacedObject[]): PlacedObject | undefined {
  return objects.find((object) => object.matches.some((match) => match.entryId === 'gas_line'));
}

/** A point in the seating, toward the hall centre from the first cooked stall. */
export function seatingBomb(verts: Vec2[], objects: readonly PlacedObject[]): Vec2 | null {
  const gas = gasLine(objects);
  if (!gas || verts.length < 3) return null;
  let cx = 0;
  let cy = 0;
  for (const vert of verts) {
    cx += vert.x;
    cy += vert.y;
  }
  cx /= verts.length;
  cy /= verts.length;
  const dx = cx - gas.pos.x;
  const dy = cy - gas.pos.y;
  const len = Math.hypot(dx, dy);
  if (len < 1) return null;
  const step = Math.min(HOLLAND_BOMB.fromStallM, len - 0.5);
  for (let dist = step; dist >= 1; dist -= 0.5) {
    const x = gas.pos.x + (dx / len) * dist;
    const y = gas.pos.y + (dy / len) * dist;
    if (inside(verts, x, y)) return { x, y };
  }
  return null;
}

export function layoutHawkerCentre(input: {
  verts: Vec2[];
  studs: readonly Stud[];
  facts: HawkerFacts;
  upperFloorIds?: readonly string[];
}): HawkerLayout {
  const { verts, facts } = input;
  const labels: LayoutLabel[] = [];
  const objects: PlacedObject[] = [];
  const walls: InteriorWall[] = [];

  if (facts.cookedStalls) {
    labels.push({
      id: 'fact-cooked',
      origin: 'researched',
      text: `${facts.cookedStalls.value} cooked-food stalls.`,
      sources: facts.cookedStalls.sources,
    });
  }
  if (facts.marketStalls) {
    labels.push({
      id: 'fact-market',
      origin: 'researched',
      text: `${facts.marketStalls.value} market stalls.`,
      sources: facts.marketStalls.sources,
    });
  }
  if (facts.cookedStallAreaM2) {
    labels.push({
      id: 'fact-area',
      origin: 'researched',
      text: `A cooked-food stall is about ${facts.cookedStallAreaM2.value} m².`,
      sources: facts.cookedStallAreaM2.sources,
    });
  }
  for (const note of facts.disagreements) {
    labels.push({ id: `disagree-${labels.length}`, origin: 'assumed', text: note, sources: [] });
  }

  const room = input.studs.filter((stud) => insetStud(verts, stud));
  const used = new Set<string>();
  const cookedWanted = facts.cookedStalls?.value ?? ASSUMED_ROW;
  const marketWanted = facts.marketStalls?.value ?? ASSUMED_ROW;
  const cooked = takeStuds(rowsNorthToSouth(room), cookedWanted, used);
  const market = takeStuds([...rowsNorthToSouth(room)].reverse(), marketWanted, used);
  const tables = alternateStuds(room.filter((stud) => !used.has(stud.id)));

  const cookedFit =
    facts.cookedStalls && cooked.length < facts.cookedStalls.value
      ? ` ${cooked.length} of ${facts.cookedStalls.value} fit on the stud grid.`
      : '';
  const cookedText = facts.cookedStalls
    ? `${facts.cookedStalls.value} cooked-food stalls are on the fetched page.${cookedFit} They are drawn in rows. Assumed. ${PLACE_NORM} ${COOKED_NORM} ${WALL_NORM}`
    : `${cooked.length} cooked-food stalls are drawn in a row. Assumed. ${PLACE_NORM} ${COOKED_NORM} ${WALL_NORM}`;
  labels.push({
    id: 'row-cooked',
    origin: 'assumed',
    text: cookedText,
    sources: [],
  });
  cooked.forEach((stud, index) => {
    const stall = `Cooked-food stall ${index + 1}. Assumed. ${COOKED_NORM}`;
    objects.push(objectAt(`cooked-oil-${index}`, stud, 'cooking_oil', stall));
    objects.push(objectAt(`cooked-gas-${index}`, stud, 'gas_line', stall));
    objects.push(objectAt(`cooked-hood-${index}`, stud, 'wet_chemical', stall));
    objects.push(
      objectAt(
        `cooked-power-${index}`,
        stud,
        'electrical',
        `Cooked-food stall ${index + 1}. Assumed. The stall has an electrical appliance.`,
      ),
    );
  });
  addRowWalls(verts, walls, cooked, true, 'cooked', `Cooked-food row. Assumed. ${WALL_NORM}`);

  const marketFit =
    facts.marketStalls && market.length < facts.marketStalls.value
      ? ` ${market.length} of ${facts.marketStalls.value} fit on the stud grid.`
      : '';
  const marketText = facts.marketStalls
    ? `${facts.marketStalls.value} market stalls are on the fetched page.${marketFit} They are drawn in rows. Assumed. ${MARKET_NORM} ${WALL_NORM}`
    : `${market.length} market stalls are drawn in a row. Assumed. ${MARKET_NORM} ${WALL_NORM}`;
  labels.push({ id: 'row-market', origin: 'assumed', text: marketText, sources: [] });
  market.forEach((stud, index) => {
    objects.push(
      objectAt(
        `market-${index}`,
        stud,
        'wet_market',
        `Market stall ${index + 1}. Assumed. ${MARKET_NORM}`,
      ),
    );
  });
  addRowWalls(verts, walls, market, false, 'market', `Market row. Assumed. ${WALL_NORM}`);

  labels.push({
    id: 'row-tables',
    origin: 'assumed',
    text: `${tables.length} wooden tables in the seating. Assumed. ${TABLE_NORM}`,
    sources: [],
  });
  tables.forEach((stud, index) => {
    objects.push(objectAt(`table-${index}`, stud, 'wood', `Seating table. Assumed. ${TABLE_NORM}`));
  });

  const exits = chooseExits(verts);
  labels.push({
    id: 'exits',
    origin: 'assumed',
    text: `${exits.filter((exit) => exit.exitType !== 'service').length} public exits and ${exits.filter((exit) => exit.exitType === 'service').length} service door. Assumed. ${EXIT_NORM}`,
    sources: [],
  });

  if (facts.singleStorey) {
    labels.push({
      id: 'vertical',
      origin: 'researched',
      text: 'No stair and no lift. Researched from stall numbers: the fetched page lists 01- numbers and no higher storey.',
      sources: facts.singleStorey.sources,
    });
  } else {
    labels.push({
      id: 'vertical',
      origin: 'assumed',
      text: `No stair and no lift. Assumed. ${NO_STAIR_NORM}`,
      sources: [],
    });
  }

  const upper = input.upperFloorIds ?? [];
  if (upper.length > 0) {
    labels.push({
      id: 'upper-floors',
      origin: 'assumed',
      text: `${upper.join(', ')} ${upper.length === 1 ? 'copies' : 'copy'} the ground walls and exits. Assumed. ${COPY_NORM}`,
      sources: [],
    });
  }

  const bomb = seatingBomb(verts, objects);
  const gas = gasLine(objects);
  if (bomb && gas) {
    const metres = Math.round(Math.hypot(bomb.x - gas.pos.x, bomb.y - gas.pos.y) * 10) / 10;
    labels.push({
      id: 'bomb',
      origin: 'assumed',
      text: `The bomb is in the seating, ${metres} m from a cooked-food stall. Assumed. ${BOMB_NORM}`,
      sources: [],
    });
  }

  return { walls, exits, objects, labels, bomb };
}
