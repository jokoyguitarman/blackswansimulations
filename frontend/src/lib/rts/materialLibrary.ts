/**
 * Curated materials for objects a trainer places on a stud.
 *
 * The trainer never picks a fuel category. They describe the object, the
 * keyword list matches library entries, and they confirm the names. After
 * confirm, the fire sim reads the category and that entry's ignition numbers.
 * Toxic yields stay stored and unread.
 *
 * Light-fuel CHF 10 kW/m² and TRP 134 are the red-oak row, used as the stand-in
 * for ordinary wood. Heavy-fuel CHF, the shorter TRP, both room-scale speeds,
 * both fuel loads, the 0.3 m² pan, and every yield are assumed.
 */

import { FRYER_POOL_AREA_M2, HOOD_HEIGHT_M, SPRINKLER_CEILING_M, type FuelCell } from './flameFront';

export type FuelCategory = 'non_combustible' | 'light' | 'heavy';

export type MaterialBehaviour = 'none' | 'pressurised_gas' | 'suppression' | 'electrical';

/** Sprinkler and kitchen hood share the wet-zone behaviour. The RTI differs. */
export type SuppressionKind = 'sprinkler' | 'wet_chemical';

export type ToxicProduct = 'CO' | 'HCN' | 'HCl' | 'acrolein';

export interface MaterialEntry {
  id: string;
  /** Name shown to the trainer. Not the fuel category. */
  label: string;
  keywords: readonly string[];
  fuel: FuelCategory;
  behaviour: MaterialBehaviour;
  /** Set on a suppression entry. Absent on everything else. */
  suppression?: SuppressionKind;
  /** Stored for a later phase. The fire sim does not read this. */
  toxicProducts: readonly ToxicProduct[];
  /** Grams of gas per gram burned. Assumed. The fire sim does not read this. */
  toxicYieldGPerG: Partial<Record<ToxicProduct, number>>;
  /** kW/m². Null does not ignite. */
  chfKwM2: number | null;
  /** Thermal response parameter. Null does not ignite. */
  trp: number | null;
  /** α in Q = α t², kW/s². Null does not grow a fire. */
  alphaKwS2: number | null;
  /** Room-scale front, metres per minute. */
  spreadMPerMin: number | null;
  fuelLoadKgM2: number | null;
  liquidPool: boolean;
}

export interface MaterialMatch {
  entryId: string;
  label: string;
  fuel: FuelCategory;
  behaviour: MaterialBehaviour;
  source: 'keyword' | 'common' | 'ai' | 'chosen';
}

export interface PlacedObject {
  id: string;
  studId: string;
  pos: { x: number; y: number };
  level: string;
  description: string;
  matches: MaterialMatch[];
  confirmed: boolean;
  /**
   * Legacy circle radius, metres. Confirmed fuel then covers every stud
   * inside it. A point object leaves this unset and fuels only its stud.
   */
  coverRadiusM?: number;
  /** Centre of that circle. Snap moves `pos` onto a stud and leaves this. */
  coverCenter?: { x: number; y: number };
  /**
   * Seconds a ruptured gas jet burns before an automatic valve closes.
   * Absent, or not a positive number, means it stays open until someone shuts it off.
   */
  valveSec?: number | null;
}

/** A confirmed pressurised-gas object, at the marker the trainer sees. */
export interface GasLinePlacement {
  id: string;
  pos: { x: number; y: number };
  level: string;
  autoShutoffSec: number | null;
}

/**
 * A confirmed sprinkler or wet-chemical head. It does not burn.
 * For a sprinkler, `ceilingM` is the storey height when the building has
 * one, else the worked-example 3 m. For a wet-chemical hood it is the
 * assumed link height over the appliance, not the storey height.
 */
export interface SuppressionPlacement {
  id: string;
  pos: { x: number; y: number };
  level: string;
  kind: SuppressionKind;
  ceilingM: number;
}

/** A confirmed electrical object, or an electrical hazard circle. */
export interface ElectricalPlacement {
  id: string;
  pos: { x: number; y: number };
  level: string;
}

export interface CommonPick {
  label: string;
  entryId: string;
}

const LIGHT_WOOD = {
  fuel: 'light' as const,
  chfKwM2: 10,
  trp: 134,
  alphaKwS2: 0.01172,
  spreadMPerMin: 0.5,
  fuelLoadKgM2: 10,
  liquidPool: false,
};

/** Same shape as wood. The assignment to these materials is assumed. */
const LIGHT_ASSUMED = { ...LIGHT_WOOD };

const HEAVY_ASSUMED = {
  fuel: 'heavy' as const,
  chfKwM2: 10,
  trp: 80,
  alphaKwS2: 0.0469,
  spreadMPerMin: 4,
  fuelLoadKgM2: 30,
  liquidPool: true,
};

/** Same heavy numbers as a liquid, without a pan. Shop goods are solid. */
const HEAVY_SOLID = { ...HEAVY_ASSUMED, liquidPool: false };

const INERT = {
  fuel: 'non_combustible' as const,
  chfKwM2: null,
  trp: null,
  alphaKwS2: null,
  spreadMPerMin: null,
  fuelLoadKgM2: null,
  liquidPool: false,
};

export const MATERIAL_LIBRARY: readonly MaterialEntry[] = [
  {
    id: 'wood',
    label: 'Wood',
    keywords: ['wood', 'wooden', 'timber', 'plywood', 'oak'],
    behaviour: 'none',
    toxicProducts: ['CO'],
    toxicYieldGPerG: { CO: 0.1 },
    ...LIGHT_WOOD,
  },
  {
    id: 'paper',
    label: 'Paper',
    keywords: ['paper', 'cardboard', 'newspaper'],
    behaviour: 'none',
    toxicProducts: ['CO'],
    toxicYieldGPerG: { CO: 0.1 },
    ...LIGHT_ASSUMED,
  },
  {
    id: 'foam',
    label: 'Foam upholstery',
    keywords: ['foam', 'upholstery', 'polyurethane', 'cushion'],
    behaviour: 'none',
    toxicProducts: ['CO', 'HCN'],
    toxicYieldGPerG: { CO: 0.1, HCN: 0.01 },
    ...LIGHT_ASSUMED,
  },
  {
    id: 'pvc',
    label: 'PVC',
    keywords: ['pvc', 'vinyl'],
    behaviour: 'none',
    toxicProducts: ['HCl', 'CO'],
    toxicYieldGPerG: { HCl: 0.2, CO: 0.1 },
    ...LIGHT_ASSUMED,
  },
  {
    id: 'shop_contents',
    label: 'Shop stock and fittings',
    keywords: ['shop stock', 'merchandise', 'retail stock', 'shop fittings'],
    behaviour: 'none',
    toxicProducts: ['CO', 'HCN'],
    toxicYieldGPerG: { CO: 0.1, HCN: 0.01 },
    ...HEAVY_SOLID,
  },
  {
    id: 'cooking_oil',
    label: 'Cooking oil',
    keywords: ['cooking oil', 'deep fryer', 'fryer', 'oil', 'grease'],
    behaviour: 'none',
    toxicProducts: ['acrolein'],
    toxicYieldGPerG: { acrolein: 0.01 },
    ...HEAVY_ASSUMED,
  },
  {
    id: 'steel',
    label: 'Steel',
    keywords: ['steel', 'iron'],
    behaviour: 'none',
    toxicProducts: [],
    toxicYieldGPerG: {},
    ...INERT,
  },
  {
    id: 'ceramic_tile',
    label: 'Ceramic tile',
    keywords: ['tile', 'ceramic', 'porcelain'],
    behaviour: 'none',
    toxicProducts: [],
    toxicYieldGPerG: {},
    ...INERT,
  },
  {
    id: 'concrete',
    label: 'Concrete',
    keywords: ['concrete', 'masonry', 'brick'],
    behaviour: 'none',
    toxicProducts: [],
    toxicYieldGPerG: {},
    ...INERT,
  },
  {
    id: 'gas_line',
    label: 'Gas line',
    keywords: ['gas line', 'gas', 'hob', 'cylinder', 'propane'],
    behaviour: 'pressurised_gas',
    toxicProducts: [],
    toxicYieldGPerG: {},
    ...INERT,
  },
  {
    id: 'wet_chemical',
    label: 'Wet-chemical system',
    keywords: ['wet chemical', 'wet-chemical', 'ansul'],
    behaviour: 'suppression',
    suppression: 'wet_chemical',
    toxicProducts: [],
    toxicYieldGPerG: {},
    ...INERT,
  },
  {
    id: 'sprinkler',
    label: 'Sprinklers',
    keywords: ['sprinkler', 'sprinklers'],
    behaviour: 'suppression',
    suppression: 'sprinkler',
    toxicProducts: [],
    toxicYieldGPerG: {},
    ...INERT,
  },
  {
    id: 'electrical',
    label: 'Electrical appliance',
    keywords: ['fridge', 'refrigerator', 'electrical', 'socket', 'cable'],
    behaviour: 'electrical',
    toxicProducts: [],
    toxicYieldGPerG: {},
    ...INERT,
  },
];

export const COMMON_PICKS: readonly CommonPick[] = [
  { label: 'Wooden table', entryId: 'wood' },
  { label: 'Deep fryer', entryId: 'cooking_oil' },
  { label: 'Gas line', entryId: 'gas_line' },
  { label: 'Ceramic tile', entryId: 'ceramic_tile' },
  { label: 'Wet-chemical system', entryId: 'wet_chemical' },
  { label: 'Sprinklers', entryId: 'sprinkler' },
];

export function entryById(id: string): MaterialEntry | undefined {
  return MATERIAL_LIBRARY.find((entry) => entry.id === id);
}

export function entryCanBurn(fuel: FuelCategory): boolean {
  return fuel === 'light' || fuel === 'heavy';
}

/** The entry's ignition numbers, or null when that entry cannot burn. */
export function fuelCellFromEntry(entry: MaterialEntry): FuelCell | null {
  if (entry.fuel !== 'light' && entry.fuel !== 'heavy') return null;
  if (
    entry.chfKwM2 == null ||
    entry.trp == null ||
    entry.alphaKwS2 == null ||
    entry.spreadMPerMin == null ||
    entry.fuelLoadKgM2 == null
  ) {
    return null;
  }
  return {
    category: entry.fuel,
    chfKwM2: entry.chfKwM2,
    trp: entry.trp,
    alphaKwS2: entry.alphaKwS2,
    spreadMPerMin: entry.spreadMPerMin,
    fuelLoadKgM2: entry.fuelLoadKgM2,
    liquidPool: entry.liquidPool,
    ...(entry.liquidPool ? { poolAreaM2: FRYER_POOL_AREA_M2 } : {}),
  };
}

/** Wood, used when a scene names no fuel. Assumed stand-in for an ordinary interior. */
export function defaultLightFuel(): FuelCell {
  const cell = fuelCellFromEntry(entryById('wood') as MaterialEntry);
  if (!cell) {
    throw new Error('wood entry is missing its ignition numbers');
  }
  return cell;
}

function worstFuelCell(matches: readonly MaterialMatch[]): FuelCell | null {
  let best: FuelCell | null = null;
  for (const match of matches) {
    const entry = entryById(match.entryId);
    const cell = entry ? fuelCellFromEntry(entry) : null;
    if (!cell) continue;
    if (!best || (cell.category === 'heavy' && best.category === 'light')) best = cell;
  }
  return best;
}

export function matchFromEntry(
  entry: MaterialEntry,
  source: MaterialMatch['source'],
): MaterialMatch {
  return {
    entryId: entry.id,
    label: entry.label,
    fuel: entry.fuel,
    behaviour: entry.behaviour,
    source,
  };
}

export type MaterialSuggester = (text: string) => string | null;

/**
 * No live model is wired. The editor passes this only when AI enrichment is
 * switched on, and a miss still has to be confirmed before it counts.
 */
export function suggestLibraryEntry(_text: string): string | null {
  return null;
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Plural of one word. "gas" stays matchable as "gas"; "gases" is extra. */
function pluralWord(word: string): string {
  if (/(?:s|x|z|ch|sh)$/.test(word)) return `${word}es`;
  if (/[^aeiou]y$/.test(word)) return `${word.slice(0, -1)}ies`;
  return `${word}s`;
}

function keywordHits(haystack: string, keyword: string): boolean {
  const needle = normalize(keyword);
  if (!needle) return false;
  const padded = ` ${haystack} `;
  if (padded.includes(` ${needle} `)) return true;
  const parts = needle.split(' ');
  const plural = [...parts.slice(0, -1), pluralWord(parts[parts.length - 1] ?? '')].join(' ');
  return plural !== needle && padded.includes(` ${plural} `);
}

export function matchMaterials(
  text: string,
  options?: { suggest?: MaterialSuggester | null },
): MaterialMatch[] {
  const haystack = normalize(text);
  if (!haystack) return [];

  const matches: MaterialMatch[] = [];
  for (const entry of MATERIAL_LIBRARY) {
    if (entry.keywords.some((keyword) => keywordHits(haystack, keyword))) {
      matches.push(matchFromEntry(entry, 'keyword'));
    }
  }
  if (matches.length > 0 || !options?.suggest) return matches;

  let suggested: string | null = null;
  try {
    suggested = options.suggest(text);
  } catch {
    suggested = null;
  }
  const entry = suggested ? entryById(suggested) : undefined;
  return entry ? [matchFromEntry(entry, 'ai')] : [];
}

/**
 * Confirmed light or heavy fuel, one cell per stud. Heavy wins when two
 * objects cover the same stud. A legacy circle covers every indoor stud
 * inside its old radius. A stud with no spatial context still counts; outdoor
 * and road studs do not. Without the stud list the circle falls back to its
 * own stud. Unconfirmed objects are skipped.
 */
export function confirmedFuelCells(
  objects: readonly PlacedObject[],
  studs?: readonly SnapStud[],
): Map<string, FuelCell> {
  const cells = new Map<string, FuelCell>();
  const add = (id: string, cell: FuelCell) => {
    if (!id) return;
    const prev = cells.get(id);
    if (!prev || (cell.category === 'heavy' && prev.category === 'light')) cells.set(id, cell);
  };
  for (const obj of objects) {
    if (!obj.confirmed) continue;
    const cell = worstFuelCell(obj.matches);
    if (!cell) continue;
    if (obj.coverRadiusM && obj.coverRadiusM > 0 && studs && studs.length > 0) {
      const center = obj.coverCenter ?? obj.pos;
      const level = obj.level || 'G';
      for (const stud of studs) {
        if ((stud.level || 'G') !== level) continue;
        if (stud.spatialContext != null && stud.spatialContext !== 'inside_building') continue;
        const dist = Math.hypot(stud.simPos.x - center.x, stud.simPos.y - center.y);
        if (dist <= obj.coverRadiusM + 1e-6) add(stud.id, cell);
      }
      continue;
    }
    if (obj.studId) add(obj.studId, cell);
  }
  return cells;
}

function positiveSeconds(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value) || !(value > 0)) return null;
  return value;
}

/**
 * Confirmed gas lines. One per object whose matches include pressurised gas,
 * including a fryer that is also fuel. Unconfirmed objects are skipped.
 * The jet sits on the marker (`pos`), which snap has put on a stud.
 */
export function confirmedGasLines(objects: readonly PlacedObject[]): GasLinePlacement[] {
  const lines: GasLinePlacement[] = [];
  for (const obj of objects) {
    if (!obj.confirmed) continue;
    if (!obj.matches.some((match) => match.behaviour === 'pressurised_gas')) continue;
    lines.push({
      id: obj.id,
      pos: { x: obj.pos.x, y: obj.pos.y },
      level: obj.level || 'G',
      autoShutoffSec: positiveSeconds(obj.valveSec),
    });
  }
  return lines;
}

/**
 * Confirmed electrical objects, then electrical hazard circles that are not
 * already one of those objects. An arc is an ignition source. It is not fuel.
 */
export function confirmedElectricalSources(
  objects: readonly PlacedObject[],
  zones: readonly { id: string; pos: { x: number; y: number }; hazardType: string; level?: string }[] = [],
): ElectricalPlacement[] {
  const sources: ElectricalPlacement[] = [];
  for (const obj of objects) {
    if (!obj.confirmed) continue;
    if (!obj.matches.some((match) => match.behaviour === 'electrical')) continue;
    sources.push({
      id: obj.id,
      pos: { x: obj.pos.x, y: obj.pos.y },
      level: obj.level || 'G',
    });
  }
  for (const zone of zones) {
    if (zone.hazardType !== 'electrical') continue;
    if (sources.some((source) => source.id === zone.id)) continue;
    sources.push({
      id: zone.id,
      pos: { x: zone.pos.x, y: zone.pos.y },
      level: zone.level || 'G',
    });
  }
  return sources;
}

/**
 * Confirmed suppression heads. A chemical circle is not one of these, and
 * an unconfirmed object is not either. The head sits on the marker.
 */
export function confirmedSuppression(
  objects: readonly PlacedObject[],
  ceilingByLevel: Readonly<Record<string, number>> = {},
): SuppressionPlacement[] {
  const heads: SuppressionPlacement[] = [];
  for (const obj of objects) {
    if (!obj.confirmed) continue;
    const match = obj.matches.find((item) => item.behaviour === 'suppression');
    if (!match) continue;
    const entry = entryById(match.entryId);
    const kind = entry?.suppression ?? 'wet_chemical';
    const level = obj.level || 'G';
    const stored = ceilingByLevel[level];
    const storey = stored != null && Number.isFinite(stored) && stored > 0 ? stored : SPRINKLER_CEILING_M;
    // A hood link hangs over the pan. The storey height is the sprinkler ceiling.
    const ceilingM = kind === 'wet_chemical' ? HOOD_HEIGHT_M : storey;
    heads.push({
      id: obj.id,
      pos: { x: obj.pos.x, y: obj.pos.y },
      level,
      kind,
      ceilingM,
    });
  }
  return heads;
}

/** Stud ids from `confirmedFuelCells`. */
export function confirmedFuelStudIds(
  objects: readonly PlacedObject[],
  studs?: readonly SnapStud[],
): Set<string> {
  return new Set(confirmedFuelCells(objects, studs).keys());
}

const LEGACY_FUEL_CIRCLES = new Set(['combustible', 'ignitable']);

export interface LegacyFuelCircle {
  id: string;
  pos: { x: number; y: number };
  hazardType: string;
  label?: string;
  description?: string;
  studId?: string;
  level?: string;
  /** Old circle radius, metres. Every stud inside it becomes fuel. */
  radius?: number;
}

/**
 * Combustible and ignitable circles become placed objects. The blast marker
 * and every other hazard type stay circles. A description with no library
 * word guesses wood, which can catch fire once the trainer confirms it.
 */
export function absorbLegacyFuelCircles<T extends LegacyFuelCircle>(
  zones: readonly T[],
  existing: readonly PlacedObject[] = [],
  options?: { confirmed?: boolean },
): { zones: T[]; objects: PlacedObject[] } {
  const taken = new Set(existing.map((obj) => obj.id));
  const kept: T[] = [];
  const created: PlacedObject[] = [];
  for (const zone of zones) {
    if (zone.id === 'blast-direct' || !LEGACY_FUEL_CIRCLES.has(zone.hazardType)) {
      kept.push(zone);
      continue;
    }
    const id = `legacy-${zone.id}`;
    if (taken.has(id)) continue;
    const text = `${zone.description ?? ''} ${zone.label ?? ''}`.trim();
    let matches = matchMaterials(text);
    if (matches.length === 0) {
      const wood = entryById('wood');
      if (wood) matches = [matchFromEntry(wood, 'keyword')];
    }
    created.push({
      id,
      studId: zone.studId ?? '',
      pos: { x: zone.pos.x, y: zone.pos.y },
      level: zone.level ?? 'G',
      description: zone.description?.trim() || zone.label?.trim() || 'Furnishing',
      matches,
      confirmed: options?.confirmed ?? false,
      ...(zone.radius && zone.radius > 0
        ? { coverRadiusM: zone.radius, coverCenter: { x: zone.pos.x, y: zone.pos.y } }
        : {}),
    });
    taken.add(id);
  }
  return { zones: kept, objects: [...existing, ...created] };
}

export interface SnapStud {
  id: string;
  simPos: { x: number; y: number };
  level?: string;
  /** Outdoor and road studs are left out of a legacy circle. Absent still counts. */
  spatialContext?: string | null;
}

/** Move an object onto the stud under it. The editor snaps within 8 m. */
export function snapObjectsToStuds(
  objects: readonly PlacedObject[],
  studs: readonly SnapStud[],
): PlacedObject[] {
  return objects.map((obj) => {
    const level = obj.level || 'G';
    let best: SnapStud | null = null;
    let bestDist = Infinity;
    for (const stud of studs) {
      if ((stud.level || 'G') !== level) continue;
      const dist = Math.hypot(stud.simPos.x - obj.pos.x, stud.simPos.y - obj.pos.y);
      if (dist < bestDist) {
        bestDist = dist;
        best = stud;
      }
    }
    if (!best || bestDist >= 8) return obj;
    return {
      ...obj,
      studId: best.id,
      pos: { x: best.simPos.x, y: best.simPos.y },
    };
  });
}
