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
}

const COOKED_NORM = 'A cooked-food stall has a gas line, cooking oil, and a wet-chemical hood.';
const EXIT_NORM = 'An assembly floor has two ways out, on separate sides.';
const SERVICE_NORM = 'A market and food centre has a service door besides the public exits.';
const MARKET_NORM = 'A market stall holds shop stock. The pages do not say where the stalls stand.';
const TABLE_NORM = 'The seating between the stalls has wooden tables.';
const PLACE_NORM =
  'The pages do not give a floor plan, so the stalls are lined up inside the footprint.';
const NO_STAIR_NORM = 'No upper floor was found, so no stair or lift is drawn.';
const COPY_NORM = 'An upper floor with no plan of its own copies the ground walls and exits.';

const MAX_COOKED_DRAWN = 8;
const MAX_MARKET_DRAWN = 6;
const MAX_TABLES = 4;

interface Stud {
  id: string;
  x: number;
  y: number;
}

function cited(sources: LayoutSource[]): string {
  return sources.map((source) => `${source.title}: “${source.quote}”`).join(' ');
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

function spread(studs: readonly Stud[], limit: number, spacing: number): Stud[] {
  const chosen: Stud[] = [];
  for (const stud of studs) {
    if (chosen.every((kept) => Math.hypot(kept.x - stud.x, kept.y - stud.y) >= spacing)) {
      chosen.push(stud);
    }
    if (chosen.length >= limit) break;
  }
  return chosen;
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

function wall(id: string, start: Vec2, end: Vec2, description: string): InteriorWall {
  return {
    id,
    start,
    end,
    hasDoor: true,
    doorWidth: 1.2,
    doorPosition: 0.5,
    description,
    material: 'concrete',
    photos: [],
    level: 'G',
  };
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
  const northBand = [...room].sort((a, b) => a.y - b.y);
  const northCut = Math.max(1, Math.ceil(northBand.length * 0.4));
  const cookedLimit = Math.min(MAX_COOKED_DRAWN, facts.cookedStalls?.value ?? 4);
  const cooked = spread(
    northBand.slice(0, northCut).sort((a, b) => a.x - b.x),
    cookedLimit,
    5,
  );
  const cookedIds = new Set(cooked.map((stud) => stud.id));

  const southBand = [...room].filter((stud) => !cookedIds.has(stud.id)).sort((a, b) => b.y - a.y);
  const southCut = Math.max(1, Math.ceil(southBand.length * 0.4));
  const marketLimit = Math.min(MAX_MARKET_DRAWN, facts.marketStalls ? MAX_MARKET_DRAWN : 4);
  const market = spread(
    southBand
      .slice(0, southCut)
      .filter((stud) =>
        cooked.every((stall) => Math.hypot(stall.x - stud.x, stall.y - stud.y) >= 6),
      ),
    marketLimit,
    5,
  );
  const used = new Set([...cooked, ...market].map((stud) => stud.id));
  const centre = [...room].sort((a, b) => Math.hypot(a.x, a.y) - Math.hypot(b.x, b.y));
  const tables = spread(
    centre.filter((stud) => !used.has(stud.id)),
    MAX_TABLES,
    6,
  );

  const cookedText = facts.cookedStalls
    ? `${facts.cookedStalls.value} cooked-food stalls are on the fetched page (${cited(facts.cookedStalls.sources)}). ${cooked.length} are drawn. Assumed. ${PLACE_NORM} ${COOKED_NORM}`
    : `${cooked.length} cooked-food stalls are drawn. Assumed. ${PLACE_NORM} ${COOKED_NORM}`;
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
    if (index < 4) {
      objects.push(
        objectAt(
          `cooked-power-${index}`,
          stud,
          'electrical',
          `Cooked-food stall ${index + 1}. Assumed. The stall has an electrical appliance.`,
        ),
      );
    }
    let cx = 0;
    let cy = 0;
    for (const vert of verts) {
      cx += vert.x;
      cy += vert.y;
    }
    cx /= verts.length;
    cy /= verts.length;
    const dx = cx - stud.x;
    const dy = cy - stud.y;
    const len = Math.hypot(dx, dy) || 1;
    const px = -dy / len;
    const py = dx / len;
    const front = { x: stud.x + (dx / len) * 1.6, y: stud.y + (dy / len) * 1.6 };
    const start = { x: front.x - px * 1.6, y: front.y - py * 1.6 };
    const end = { x: front.x + px * 1.6, y: front.y + py * 1.6 };
    if (segmentInside(verts, start, end)) {
      walls.push(
        wall(
          `stall-front-${index}`,
          start,
          end,
          `Front of cooked-food stall ${index + 1}. Assumed. ${PLACE_NORM}`,
        ),
      );
    }
  });

  const marketText = facts.marketStalls
    ? `${facts.marketStalls.value} market stalls are on the fetched page (${cited(facts.marketStalls.sources)}). ${market.length} are drawn. Assumed. ${MARKET_NORM}`
    : `${market.length} market stalls are drawn. Assumed. ${MARKET_NORM}`;
  labels.push({ id: 'row-market', origin: 'assumed', text: marketText, sources: [] });
  market.forEach((stud, index) => {
    objects.push(
      objectAt(
        `market-${index}`,
        stud,
        'shop_contents',
        `Market stall ${index + 1}. Assumed. ${MARKET_NORM}`,
      ),
    );
  });

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
      text: 'No stair and no lift. The fetched page lists 01- stall numbers and no higher storey.',
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

  return { walls, exits, objects, labels };
}
