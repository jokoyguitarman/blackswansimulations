/**
 * Curated materials for objects a trainer places on a stud.
 *
 * The trainer never picks a fuel category. They describe the object, the
 * keyword list matches library entries, and they confirm the names. The fire
 * sim reads only the category, and only after confirm. Toxic yields and the
 * ignition numbers are stored for later phases. Nothing in Phase 1 reads them.
 *
 * Light-fuel CHF 10 kW/m² and TRP 134 are the red-oak row, used as the stand-in
 * for ordinary wood. Heavy-fuel CHF, the shorter TRP, both room-scale speeds,
 * both fuel loads, and every yield are assumed.
 */

export type FuelCategory = 'non_combustible' | 'light' | 'heavy';

export type MaterialBehaviour = 'none' | 'pressurised_gas' | 'suppression' | 'electrical';

export type ToxicProduct = 'CO' | 'HCN' | 'HCl' | 'acrolein';

export interface MaterialEntry {
  id: string;
  /** Name shown to the trainer. Not the fuel category. */
  label: string;
  keywords: readonly string[];
  fuel: FuelCategory;
  behaviour: MaterialBehaviour;
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
  /** Room-scale front, metres per minute. Phase 1 does not move a front. */
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
    keywords: ['wet chemical', 'sprinkler', 'suppression', 'extinguisher'],
    behaviour: 'suppression',
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
];

export function entryById(id: string): MaterialEntry | undefined {
  return MATERIAL_LIBRARY.find((entry) => entry.id === id);
}

export function entryCanBurn(fuel: FuelCategory): boolean {
  return fuel === 'light' || fuel === 'heavy';
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

function keywordHits(haystack: string, keyword: string): boolean {
  const needle = normalize(keyword);
  if (!needle) return false;
  return ` ${haystack} `.includes(` ${needle} `);
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

/** Studs a confirmed light or heavy entry may burn. Unconfirmed objects are skipped. */
export function confirmedFuelStudIds(objects: readonly PlacedObject[]): Set<string> {
  const ids = new Set<string>();
  for (const obj of objects) {
    if (!obj.confirmed || !obj.studId) continue;
    if (obj.matches.some((match) => entryCanBurn(match.fuel))) ids.add(obj.studId);
  }
  return ids;
}
