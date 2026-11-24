/**
 * Curated materials for objects a trainer places on a stud.
 *
 * The trainer never picks a fuel category. They describe the object, the
 * keyword list matches library entries, and they confirm the names. After
 * confirm, the fire sim reads the category, that entry's ignition numbers,
 * and that entry's toxic yields. The trainer does not pick a gas.
 *
 * Every number on an entry has a row in its `sources`, keyed by field, and
 * every wall row the same. A row is `cited` when the number comes from a
 * named table for that material or occupancy, `derived` when it is arithmetic
 * on cited numbers, and `assumed` otherwise. A cited number assigned to a
 * material it was not measured on (red oak for paper, transformer oil for
 * cooking oil) is assumed. A ref that says "not in the approved seeds" was
 * read from the handbook, not from `scripts/fieldops/seeds`, and should be
 * checked before a validation case uses it. Validation cases use cited rows
 * only.
 *
 * The flame front reads the category, ignition, growth, front speed, fuel
 * load, pan and yields. It does not read either heat of combustion, the
 * under-ventilated soot yield, the fire load in MJ/m², or the wall rows:
 * burnout and species still use `WOOD_HEAT_KJ_KG` for every solid and the
 * transformer-oil row for every liquid. Those columns are here for the
 * layer and the vent cap to read.
 */

import {
  FRYER_POOL_AREA_M2,
  HOOD_HEIGHT_M,
  SPRINKLER_CEILING_M,
  TOXIC_PRODUCTS,
  WOOD_HEAT_KJ_KG,
  type FuelCell,
  type ToxicProduct,
  type ToxicYields,
} from './flameFront';

export type { ToxicProduct };

export type SourceStatus = 'cited' | 'derived' | 'assumed';

export interface SourceNote {
  status: SourceStatus;
  ref: string;
}

export type MaterialField =
  | 'heatOfCombustion'
  | 'effectiveHeatOfCombustion'
  | 'sootYield'
  | 'sootYieldUnderVent'
  | `wellVent.${ToxicProduct}`
  | `underVent.${ToxicProduct}`
  | 'ignition'
  | 'growth'
  | 'spread'
  | 'fireLoad'
  | 'fuelLoad'
  | 'pool';

export type MaterialSources = Partial<Record<MaterialField, SourceNote>>;

export type FuelCategory = 'non_combustible' | 'light' | 'heavy';

export type MaterialBehaviour = 'none' | 'pressurised_gas' | 'suppression' | 'electrical';

/** Sprinkler and kitchen hood share the wet-zone behaviour. The RTI differs. */
export type SuppressionKind = 'sprinkler' | 'wet_chemical';

export interface MaterialEntry {
  id: string;
  /** Name shown to the trainer. Not the fuel category. */
  label: string;
  keywords: readonly string[];
  fuel: FuelCategory;
  behaviour: MaterialBehaviour;
  /** Set on a suppression entry. Absent on everything else. */
  suppression?: SuppressionKind;
  /** Gases this entry emits while it burns. A label, not a measurement. */
  toxicProducts: readonly ToxicProduct[];
  /**
   * Net heat of complete combustion, MJ/kg. The basis EN 1991-1-2 uses to
   * turn a fuel mass into a fire load. Null when it does not burn.
   */
  heatOfCombustionMjKg: number | null;
  /**
   * Heat released per kilogram lost in a well-ventilated flaming test, MJ/kg
   * (Tewarson's chemical heat). This is the ΔHc that turns Q into a burning
   * rate for yields. Null when no figure is cited and none is assumed.
   */
  effectiveHeatOfCombustionMjKg: number | null;
  /** Grams of soot per gram burned. Well-ventilated. Null when it does not burn. */
  sootYieldGPerG: number | null;
  /** Grams of soot per gram burned after flashover. Not read by the flame front. */
  sootYieldUnderVentGPerG: number | null;
  /**
   * Grams of gas per gram burned before flashover. Where this matches the
   * stored yield, no separate well-ventilated figure was available.
   */
  toxicYieldWellVentGPerG: ToxicYields;
  /** Grams of gas per gram burned after flashover. The stored label. */
  toxicYieldGPerG: ToxicYields;
  /** kW/m². Null does not ignite. */
  chfKwM2: number | null;
  /** Thermal response parameter. Null does not ignite. */
  trp: number | null;
  /** α in Q = α t², kW/s². Null does not grow a fire. */
  alphaKwS2: number | null;
  /** Room-scale front, metres per minute. */
  spreadMPerMin: number | null;
  /** Fire load density, MJ/m² of floor. */
  fireLoadMjM2: number | null;
  /**
   * kg/m² the flame front burns. The front multiplies this by
   * `WOOD_HEAT_KJ_KG` for a solid, so a solid's kg here is wood-equivalent:
   * the fire load divided by that heat.
   */
  fuelLoadKgM2: number | null;
  liquidPool: boolean;
  sources: MaterialSources;
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

const NOT_SEEDED =
  'Not in the approved seeds; check against the table before a validation case uses it.';

const REF = {
  sootTable:
    'NUREG-1805 Ch. 18 Table 18-3, small-scale flaming yields (Tewarson, via Klote and Milke 2002). Seed `soot_yield_by_material`.',
  ignitionTable:
    'NUREG-1805 Ch. 6 Table 6-3, critical heat flux and TRP (Tewarson 1995). Seed `critical_heat_flux_by_material`.',
  tewarson: `Tewarson, SFPE Handbook 3rd ed. Sec. 3 Ch. 4, Table 3-4.14, well-ventilated heats and yields. ${NOT_SEEDED}`,
  enNetHeat: `EN 1991-1-2:2002 Annex E Table E.3, net calorific value Hu. ${NOT_SEEDED}`,
  enFireLoad: 'EN 1991-1-2:2002 Annex E Table E.4. Seed `en1991_fire_load_density`.',
  alphaClasses: 'NFPA t-squared classes. Seed `t2_alpha_classes`.',
  underVentCo: `Gottuk and Lattimer, SFPE Handbook 3rd ed. Sec. 2 Ch. 5, "Effect of Combustion Conditions on Species Production": CO yield levels off near 0.2 g/g once the equivalence ratio is well past 1 (about 0.1 to 0.25 by fuel). Holds until yields follow the equivalence ratio. The C/VM2 2.3.3.4 design value, 0.40 (seed \`cvm2_post_flashover_co_yield\`), is the conservative alternative and is not used. ${NOT_SEEDED}`,
  underVentSoot:
    'C/VM2 2.3.3.4 design value, 0.14 (seed `cvm2_post_flashover_soot_yield`). No measured under-ventilated soot row was read, so it is a placeholder. The flame front does not read it.',
  purserPostFlashoverCo: `Purser, Polymers 8 (2016) 330, Table 6: ISO/TS 19700 tube furnace at 850 °C, Φ 1.5 to 2, the post-flashover yields Purser also gives in the SFPE Handbook 5th ed. combustion toxicity chapter. ${NOT_SEEDED}`,
  blomqvistFoam: `Blomqvist et al., Fire and Materials 31 (2007) 495, tube furnace, hospital-mattress flexible foam, as reviewed by McKenna and Hull, Fire Science Reviews 5 (2016) 3. ${NOT_SEEDED}`,
  stecNylon: `Stec, Hull, Purser and Purser, Fire Safety Journal 44 (2009) 62, ISO/TS 19700 tube furnace, as stated in Stec and Hull, Energy and Buildings 43 (2011) 498. ${NOT_SEEDED}`,
  stecGenericCo: `Stec, FIRESEAT 2010, typical CO yield: fuel lean 0.01, fuel rich 0.2. ${NOT_SEEDED}`,
  woolHcn: `Purser and Purser, Fire Safety Science 9 (2008) 1117, ISO 19700 tube furnace, Eq. 3 and Table 3, with untreated wool fabric at 13.25 % nitrogen (US Bureau of Mines RI 9367, 1991, Table 1). No wool-only tube-furnace row was found. ${NOT_SEEDED}`,
  pool: 'NUREG-1805 Ch. 3 Table 3-2, transformer oil 0.039 kg/m²s, 46,400 kJ/kg, kβ 0.7. Seed `pool_fire_hrr`.',
} as const;

const cited = (ref: string): SourceNote => ({ status: 'cited', ref });
const derived = (ref: string): SourceNote => ({ status: 'derived', ref });
const assumed = (ref: string): SourceNote => ({ status: 'assumed', ref });

/** Wood net heat, MJ/kg, the basis the front turns a solid's kg into energy with. */
const WOOD_HEAT_MJ_KG = WOOD_HEAT_KJ_KG / 1000;

/** EN 1991-1-2 Table E.4, shopping centre, mean, MJ/m². The 80 % fractile is 730. */
const SHOPPING_CENTRE_FIRE_LOAD_MJ_M2 = 600;

/** Untreated wool fabric, mass fraction of nitrogen (US Bureau of Mines RI 9367). */
const WOOL_NITROGEN = 0.1325;

const LIGHT_FUEL_LOAD_KG_M2 = 10;
const OIL_FUEL_LOAD_KG_M2 = 30;

const LIGHT_WOOD = {
  fuel: 'light' as const,
  chfKwM2: 10,
  trp: 134,
  alphaKwS2: 0.01172,
  spreadMPerMin: 0.5,
  fireLoadMjM2: LIGHT_FUEL_LOAD_KG_M2 * WOOD_HEAT_MJ_KG,
  fuelLoadKgM2: LIGHT_FUEL_LOAD_KG_M2,
  liquidPool: false,
};

/** Rows every light solid shares unless its entry overrides them. */
const LIGHT_SOURCES: MaterialSources = {
  ignition: cited(`Red oak, CHF 10 kW/m², TRP 134. ${REF.ignitionTable}`),
  growth: assumed(
    `Medium class α 0.01172 kW/s² is cited (${REF.alphaClasses}); its assignment to this material is assumed.`,
  ),
  spread: assumed('Room-scale front 0.5 m/min. No row.'),
  fireLoad: assumed(
    `${LIGHT_FUEL_LOAD_KG_M2} kg/m² at the wood heat. Table E.4 has occupancies, not loose furniture, and no food centre.`,
  ),
  fuelLoad: assumed(`${LIGHT_FUEL_LOAD_KG_M2} kg/m². No row.`),
  'underVent.CO': cited(REF.underVentCo),
  sootYieldUnderVent: assumed(REF.underVentSoot),
};

const HEAVY_SOLID = {
  fuel: 'heavy' as const,
  chfKwM2: 10,
  trp: 80,
  alphaKwS2: 0.0469,
  spreadMPerMin: 4,
  fireLoadMjM2: SHOPPING_CENTRE_FIRE_LOAD_MJ_M2,
  fuelLoadKgM2: SHOPPING_CENTRE_FIRE_LOAD_MJ_M2 / WOOD_HEAT_MJ_KG,
  liquidPool: false,
};

const COOKING_OIL = {
  fuel: 'heavy' as const,
  chfKwM2: 10,
  trp: 80,
  alphaKwS2: 0.0469,
  spreadMPerMin: 4,
  fireLoadMjM2: OIL_FUEL_LOAD_KG_M2 * 46.4,
  fuelLoadKgM2: OIL_FUEL_LOAD_KG_M2,
  liquidPool: true,
};

const HEAVY_IGNITION = assumed('CHF 10 kW/m², TRP 80. No row for mixed goods or hot oil.');

/** One measured row a mixed-goods entry is averaged from. */
interface Measured {
  value: number;
  note: SourceNote;
}

interface MixComponent {
  label: string;
  heat: Measured;
  effectiveHeat: Measured | null;
  soot: Measured;
  wellVentCo: Measured;
  underVentCo: Measured;
  wellVentHcn: Measured;
  underVentHcn: Measured;
}

const NO_FUEL_NITROGEN: Measured = {
  value: 0,
  note: derived('No fuel nitrogen, so no HCN.'),
};

const RED_OAK: MixComponent = {
  label: 'red oak',
  heat: { value: 17.5, note: cited(REF.enNetHeat) },
  effectiveHeat: { value: 12.4, note: cited(REF.tewarson) },
  soot: { value: 0.015, note: cited(REF.sootTable) },
  wellVentCo: { value: 0.004, note: cited(REF.tewarson) },
  underVentCo: { value: 0.2, note: cited(REF.underVentCo) },
  wellVentHcn: NO_FUEL_NITROGEN,
  underVentHcn: NO_FUEL_NITROGEN,
};

const POLYPROPYLENE: MixComponent = {
  label: 'polypropylene',
  heat: { value: 40, note: cited(REF.enNetHeat) },
  effectiveHeat: { value: 38.6, note: cited(REF.tewarson) },
  soot: { value: 0.059, note: cited(REF.sootTable) },
  wellVentCo: { value: 0.024, note: cited(REF.tewarson) },
  underVentCo: { value: 0.2, note: cited(REF.underVentCo) },
  wellVentHcn: NO_FUEL_NITROGEN,
  underVentHcn: NO_FUEL_NITROGEN,
};

const FLEXIBLE_PU_FOAM: MixComponent = {
  label: 'flexible polyurethane foam',
  heat: { value: 25, note: cited(REF.enNetHeat) },
  effectiveHeat: null,
  soot: { value: 0.188, note: cited(REF.sootTable) },
  wellVentCo: { value: 0.028, note: cited(`GM21 to GM27 mean. ${REF.tewarson}`) },
  underVentCo: { value: 0.28, note: cited(`FPU. ${REF.purserPostFlashoverCo}`) },
  wellVentHcn: { value: 0.004, note: cited(`ISO 19706 type 2, Φ < 0.75. ${REF.blomqvistFoam}`) },
  underVentHcn: { value: 0.009, note: cited(`ISO 19706 type 3b, Φ about 2. ${REF.blomqvistFoam}`) },
};

const NYLON: MixComponent = {
  label: 'nylon',
  heat: { value: 30, note: assumed('No polyamide row in Table E.3; the polyester row, 30 MJ/kg.') },
  effectiveHeat: { value: 27.1, note: cited(REF.tewarson) },
  soot: { value: 0.075, note: cited(REF.sootTable) },
  wellVentCo: { value: 0.038, note: cited(REF.tewarson) },
  underVentCo: { value: 0.26, note: cited(`PA6. ${REF.purserPostFlashoverCo}`) },
  wellVentHcn: {
    value: 0.001,
    note: cited(`Polyamide without fire retardant, about 0.001. ${REF.stecNylon}`),
  },
  underVentHcn: { value: 0.06, note: cited(`Polyamide, about 0.06. ${REF.stecNylon}`) },
};

/** HCN = 1.928 × fuel nitrogen × recovery (Purser and Purser Eq. 3). */
const woolHcn = (recovery: number) => 1.928 * WOOL_NITROGEN * recovery;

const WOOL: MixComponent = {
  label: 'wool',
  heat: { value: 20, note: cited(`Wool is in the cellulosic class, 20 MJ/kg. ${REF.enNetHeat}`) },
  effectiveHeat: null,
  soot: { value: 0.008, note: cited(REF.sootTable) },
  wellVentCo: {
    value: 0.01,
    note: assumed(`Generic fuel-lean flaming, about 0.01. ${REF.stecGenericCo} No wool row.`),
  },
  underVentCo: { value: 0.2, note: cited(REF.underVentCo) },
  wellVentHcn: {
    value: woolHcn(0.01),
    note: derived(`Recovery 0.010 at low Φ (high-recovery group, k1). ${REF.woolHcn}`),
  },
  underVentHcn: {
    value: woolHcn(0.15),
    note: derived(`Recovery about 0.15 at Φ ≥ 2, the wool-acrylic bouclé fabric. ${REF.woolHcn}`),
  },
};

interface MixPart {
  component: MixComponent;
  massFraction: number;
}

/**
 * Mass average of one column. Derived when every part is cited or derived,
 * assumed when any part is assumed. Null when a part has no value.
 */
function mixColumn(
  parts: readonly MixPart[],
  pick: (component: MixComponent) => Measured | null,
  basis: string,
): Measured | null {
  let value = 0;
  let anyAssumed = false;
  const terms: string[] = [];
  for (const { component, massFraction } of parts) {
    const row = pick(component);
    if (!row) return null;
    value += massFraction * row.value;
    if (row.note.status === 'assumed') anyAssumed = true;
    terms.push(
      `${component.label} ${Math.round(massFraction * 100)} %: ${row.value} (${row.note.ref})`,
    );
  }
  const ref = `Mass average. ${terms.join('; ')}. ${basis}`;
  return { value, note: anyAssumed ? assumed(ref) : derived(ref) };
}

function mixedGoods(parts: readonly MixPart[], basis: string, withHcn: boolean) {
  const col = (pick: (component: MixComponent) => Measured | null) => mixColumn(parts, pick, basis);
  const heat = col((c) => c.heat)!;
  const effectiveHeat = col((c) => c.effectiveHeat);
  const soot = col((c) => c.soot)!;
  const wellVentCo = col((c) => c.wellVentCo)!;
  const underVentCo = col((c) => c.underVentCo)!;
  const wellVentHcn = col((c) => c.wellVentHcn)!;
  const underVentHcn = col((c) => c.underVentHcn)!;
  const sources: MaterialSources = {
    heatOfCombustion: heat.note,
    effectiveHeatOfCombustion:
      effectiveHeat?.note ??
      assumed(`No cited chemical heat for every part (foam, wool). Left empty. ${basis}`),
    sootYield: soot.note,
    sootYieldUnderVent: assumed(REF.underVentSoot),
    'wellVent.CO': wellVentCo.note,
    'underVent.CO': underVentCo.note,
    ...(withHcn ? { 'wellVent.HCN': wellVentHcn.note, 'underVent.HCN': underVentHcn.note } : {}),
  };
  const fields = {
    heatOfCombustionMjKg: heat.value,
    effectiveHeatOfCombustionMjKg: effectiveHeat?.value ?? null,
    sootYieldGPerG: soot.value,
    sootYieldUnderVentGPerG: 0.14,
    toxicYieldWellVentGPerG: withHcn
      ? { CO: wellVentCo.value, HCN: wellVentHcn.value }
      : { CO: wellVentCo.value },
    toxicYieldGPerG: withHcn
      ? { CO: underVentCo.value, HCN: underVentHcn.value }
      : { CO: underVentCo.value },
  };
  return { fields, sources };
}

/**
 * Assumed composition of upholstered retail stock, by mass. Basis: an
 * upholstered piece is mostly a timber or board frame and foam with a
 * fabric cover, and the shelves around it add cardboard and polyolefin
 * packaging. Covers are taken as nylon and wool. No measured shop inventory
 * was read.
 */
export const SHOP_STOCK_MIX: readonly MixPart[] = [
  { component: RED_OAK, massFraction: 0.4 },
  { component: POLYPROPYLENE, massFraction: 0.25 },
  { component: FLEXIBLE_PU_FOAM, massFraction: 0.2 },
  { component: NYLON, massFraction: 0.1 },
  { component: WOOL, massFraction: 0.05 },
];

/** Wooden stalls, card and crates. Produce, fish and ice are not fuel. Assumed. */
export const WET_MARKET_MIX: readonly MixPart[] = [
  { component: RED_OAK, massFraction: 0.5 },
  { component: POLYPROPYLENE, massFraction: 0.5 },
];

const SHOP_STOCK = mixedGoods(
  SHOP_STOCK_MIX,
  'Composition assumed: 40 % cellulosic (frames, board, card), 25 % polyolefin packaging, 20 % flexible foam, 10 % nylon and 5 % wool covers, typical of upholstered retail stock.',
  true,
);

const WET_MARKET = mixedGoods(
  WET_MARKET_MIX,
  'Composition assumed: 50 % cellulosic (stalls, card), 50 % polyolefin crates. The polyethylene row (CO 0.024, soot 0.060) is within 0.001 of polypropylene.',
  false,
);

const INERT = {
  fuel: 'non_combustible' as const,
  heatOfCombustionMjKg: null,
  effectiveHeatOfCombustionMjKg: null,
  sootYieldGPerG: null,
  sootYieldUnderVentGPerG: null,
  toxicYieldWellVentGPerG: {},
  toxicYieldGPerG: {},
  chfKwM2: null,
  trp: null,
  alphaKwS2: null,
  spreadMPerMin: null,
  fireLoadMjM2: null,
  fuelLoadKgM2: null,
  liquidPool: false,
  sources: {},
};

export const MATERIAL_LIBRARY: readonly MaterialEntry[] = [
  {
    id: 'wood',
    label: 'Wood',
    keywords: ['wood', 'wooden', 'timber', 'plywood', 'oak'],
    behaviour: 'none',
    toxicProducts: ['CO'],
    heatOfCombustionMjKg: 17.5,
    effectiveHeatOfCombustionMjKg: 12.4,
    sootYieldGPerG: 0.015,
    sootYieldUnderVentGPerG: 0.14,
    toxicYieldWellVentGPerG: { CO: 0.004 },
    toxicYieldGPerG: { CO: 0.2 },
    ...LIGHT_WOOD,
    sources: {
      ...LIGHT_SOURCES,
      heatOfCombustion: cited(`Wood 17.5 MJ/kg. ${REF.enNetHeat}`),
      effectiveHeatOfCombustion: cited(`Red oak ΔHch 12.4 MJ/kg. ${REF.tewarson}`),
      sootYield: cited(`Red oak 0.015. ${REF.sootTable}`),
      'wellVent.CO': cited(`Red oak 0.004. ${REF.tewarson}`),
    },
  },
  {
    id: 'paper',
    label: 'Paper',
    keywords: ['paper', 'cardboard', 'newspaper'],
    behaviour: 'none',
    toxicProducts: ['CO'],
    heatOfCombustionMjKg: 20,
    effectiveHeatOfCombustionMjKg: 12.4,
    sootYieldGPerG: 0.015,
    sootYieldUnderVentGPerG: 0.14,
    toxicYieldWellVentGPerG: { CO: 0.004 },
    toxicYieldGPerG: { CO: 0.2 },
    ...LIGHT_WOOD,
    trp: 152,
    sources: {
      ...LIGHT_SOURCES,
      heatOfCombustion: cited(
        `Other cellulosic materials (paper, cardboard) 20 MJ/kg. ${REF.enNetHeat}`,
      ),
      effectiveHeatOfCombustion: assumed('Red oak 12.4 MJ/kg. No paper row was read.'),
      sootYield: assumed(`Red oak 0.015. Table 18-3 has no paper row.`),
      'wellVent.CO': assumed('Red oak 0.004. No paper row was read.'),
      ignition: cited(`Corrugated paper (light), CHF 10 kW/m², TRP 152. ${REF.ignitionTable}`),
    },
  },
  {
    id: 'foam',
    label: 'Foam upholstery',
    keywords: ['foam', 'upholstery', 'polyurethane', 'cushion'],
    behaviour: 'none',
    toxicProducts: ['CO', 'HCN'],
    heatOfCombustionMjKg: 25,
    effectiveHeatOfCombustionMjKg: null,
    sootYieldGPerG: 0.188,
    sootYieldUnderVentGPerG: 0.14,
    toxicYieldWellVentGPerG: {
      CO: FLEXIBLE_PU_FOAM.wellVentCo.value,
      HCN: FLEXIBLE_PU_FOAM.wellVentHcn.value,
    },
    toxicYieldGPerG: {
      CO: FLEXIBLE_PU_FOAM.underVentCo.value,
      HCN: FLEXIBLE_PU_FOAM.underVentHcn.value,
    },
    ...LIGHT_WOOD,
    sources: {
      ...LIGHT_SOURCES,
      heatOfCombustion: cited(`Polyisocyanurate and polyurethane 25 MJ/kg. ${REF.enNetHeat}`),
      effectiveHeatOfCombustion: assumed(
        'No chemical heat for flexible foam was read. Left empty.',
      ),
      sootYield: cited(`Flexible polyurethane foam 0.188. ${REF.sootTable}`),
      'wellVent.CO': cited(
        `Flexible polyurethane foams GM21 0.010, GM23 0.031, GM25 0.028, GM27 0.042; mean 0.028. ${REF.tewarson}`,
      ),
      'wellVent.HCN': FLEXIBLE_PU_FOAM.wellVentHcn.note,
      'underVent.CO': FLEXIBLE_PU_FOAM.underVentCo.note,
      'underVent.HCN': FLEXIBLE_PU_FOAM.underVentHcn.note,
      ignition: assumed('Red-oak CHF and TRP. Table 6-3 has no flexible-foam row.'),
    },
  },
  {
    id: 'pvc',
    label: 'PVC',
    keywords: ['pvc', 'vinyl'],
    behaviour: 'none',
    toxicProducts: ['HCl', 'CO'],
    heatOfCombustionMjKg: 20,
    effectiveHeatOfCombustionMjKg: 5.7,
    sootYieldGPerG: 0.172,
    sootYieldUnderVentGPerG: 0.14,
    toxicYieldWellVentGPerG: { HCl: 0.2, CO: 0.063 },
    toxicYieldGPerG: { HCl: 0.2, CO: 0.2 },
    ...LIGHT_WOOD,
    sources: {
      ...LIGHT_SOURCES,
      heatOfCombustion: cited(`Polyvinylchloride 20 MJ/kg. ${REF.enNetHeat}`),
      effectiveHeatOfCombustion: cited(`PVC ΔHch 5.7 MJ/kg. ${REF.tewarson}`),
      sootYield: cited(`PVC 0.172. ${REF.sootTable}`),
      sootYieldUnderVent: assumed(
        `${REF.underVentSoot} It is below the well-ventilated PVC figure.`,
      ),
      'wellVent.CO': cited(`PVC 0.063. ${REF.tewarson}`),
      'wellVent.HCl': assumed(
        '0.2. All the chlorine as HCl would be 0.58 (36.46 / 62.50); no measured row was read.',
      ),
      'underVent.HCl': assumed('0.2, the same label.'),
      ignition: assumed(
        'Red-oak CHF and TRP. Table 6-3 has PVC cable rows, not sheet or flooring.',
      ),
    },
  },
  {
    id: 'shop_contents',
    label: 'Shop stock and fittings',
    keywords: ['shop stock', 'merchandise', 'retail stock', 'shop fittings'],
    behaviour: 'none',
    toxicProducts: ['CO', 'HCN'],
    ...SHOP_STOCK.fields,
    ...HEAVY_SOLID,
    sources: {
      ...SHOP_STOCK.sources,
      ignition: HEAVY_IGNITION,
      growth: cited(
        `Shopping centre, fast growth (EN 1991-1-2 Table E.5); fast α 0.0469 kW/s². ${REF.alphaClasses}`,
      ),
      spread: assumed('Room-scale front 4 m/min. No row.'),
      fireLoad: cited(
        `Shopping centre mean, ${SHOPPING_CENTRE_FIRE_LOAD_MJ_M2} MJ/m². The 80 % fractile, 730 MJ/m², is the design (characteristic) value and is not used. ${REF.enFireLoad} The table averages over the whole compartment floor, aisles included; it is applied to each stocked stud. Where a scene stocks only part of a room, the per-stud load should be the room total over the stocked area.`,
      ),
      fuelLoad: derived(
        `Fire load ${SHOPPING_CENTRE_FIRE_LOAD_MJ_M2} MJ/m² over the wood heat the front burns solids at, so the front releases the cited energy.`,
      ),
    },
  },
  {
    id: 'wet_market',
    label: 'Wet-market goods',
    keywords: ['wet market', 'wet-market', 'market produce'],
    behaviour: 'none',
    toxicProducts: ['CO'],
    ...WET_MARKET.fields,
    ...LIGHT_WOOD,
    sources: {
      ...LIGHT_SOURCES,
      ...WET_MARKET.sources,
      ignition: assumed(
        'Red-oak CHF and TRP. No row for market goods. Produce, fish and ice are not fuel.',
      ),
    },
  },
  {
    id: 'cooking_oil',
    label: 'Cooking oil',
    keywords: ['cooking oil', 'deep fryer', 'fryer', 'oil', 'grease'],
    behaviour: 'none',
    toxicProducts: ['acrolein'],
    heatOfCombustionMjKg: 46.4,
    effectiveHeatOfCombustionMjKg: 46.4,
    sootYieldGPerG: 0.02,
    sootYieldUnderVentGPerG: null,
    toxicYieldWellVentGPerG: { acrolein: 0.01 },
    toxicYieldGPerG: { acrolein: 0.01 },
    ...COOKING_OIL,
    sources: {
      heatOfCombustion: assumed(
        `Transformer oil. ${REF.pool} No vegetable-oil row in Table 3-2 or Table E.3.`,
      ),
      effectiveHeatOfCombustion: assumed(
        `Transformer oil, the ΔHc the pan already burns at. ${REF.pool}`,
      ),
      sootYield: assumed('0.02. Table 18-3 has no cooking-oil row.'),
      'wellVent.acrolein': assumed('0.01. No acrolein row was read.'),
      'underVent.acrolein': assumed('0.01, the same label.'),
      ignition: HEAVY_IGNITION,
      growth: assumed(
        `Fast class α 0.0469 kW/s² is cited (${REF.alphaClasses}); its assignment to hot oil is assumed.`,
      ),
      spread: assumed('Room-scale front 4 m/min. No row.'),
      fireLoad: assumed(`${OIL_FUEL_LOAD_KG_M2} kg/m² of oil at 46.4 MJ/kg.`),
      fuelLoad: assumed(`${OIL_FUEL_LOAD_KG_M2} kg/m². No row.`),
      pool: assumed(`0.3 m² pan, and transformer oil standing in for cooking oil. ${REF.pool}`),
    },
  },
  {
    id: 'steel',
    label: 'Steel',
    keywords: ['steel', 'iron'],
    behaviour: 'none',
    toxicProducts: [],
    ...INERT,
  },
  {
    id: 'ceramic_tile',
    label: 'Ceramic tile',
    keywords: ['tile', 'ceramic', 'porcelain'],
    behaviour: 'none',
    toxicProducts: [],
    ...INERT,
  },
  {
    id: 'concrete',
    label: 'Concrete',
    keywords: ['concrete', 'masonry', 'brick'],
    behaviour: 'none',
    toxicProducts: [],
    ...INERT,
  },
  {
    id: 'gas_line',
    label: 'Gas line',
    keywords: ['gas line', 'gas', 'hob', 'cylinder', 'propane'],
    behaviour: 'pressurised_gas',
    toxicProducts: [],
    ...INERT,
  },
  {
    id: 'wet_chemical',
    label: 'Wet-chemical system',
    keywords: ['wet chemical', 'wet-chemical', 'ansul'],
    behaviour: 'suppression',
    suppression: 'wet_chemical',
    toxicProducts: [],
    ...INERT,
  },
  {
    id: 'sprinkler',
    label: 'Sprinklers',
    keywords: ['sprinkler', 'sprinklers'],
    behaviour: 'suppression',
    suppression: 'sprinkler',
    toxicProducts: [],
    ...INERT,
  },
  {
    id: 'electrical',
    label: 'Electrical appliance',
    keywords: ['fridge', 'refrigerator', 'electrical', 'socket', 'cable'],
    behaviour: 'electrical',
    toxicProducts: [],
    ...INERT,
  },
];

export type WallField = 'conductivity' | 'density' | 'specificHeat' | 'thickness';

/**
 * Inert lining for heat loss into a wall. Properties at room temperature.
 * Thickness is the building's, not the material's, so every thickness is
 * assumed until a scene stores one. The flame front does not read these.
 * The smoke layer reads `layerLiningFor`, not this table directly.
 */
export interface WallMaterial {
  id: string;
  label: string;
  /** Substrings of an interior wall's `material`, checked in library order. */
  keywords: readonly string[];
  conductivityWMK: number;
  densityKgM3: number;
  specificHeatJKgK: number;
  thicknessM: number;
  sources: Record<WallField, SourceNote>;
}

const NUREG_LINING =
  'NUREG-1805 Ch. 2 thermal properties of enclosing surfaces (p. 2-11). Seed `lining_thermal_properties`.';
const NUREG_LINING_UNSEEDED = `NUREG-1805 Ch. 2 thermal properties of enclosing surfaces (p. 2-11). ${NOT_SEEDED}`;

/** ρ = kρc / (k c), from the seed's k, c and thermal inertia. */
function densityFromInertia(krhocKw2: number, kWMK: number, cJKgK: number): number {
  return (krhocKw2 * 1e6) / (kWMK * cJKgK);
}

function seededLining(
  krhoc: number,
  k: number,
  c: number,
  thicknessNote: string,
): Pick<WallMaterial, 'conductivityWMK' | 'densityKgM3' | 'specificHeatJKgK' | 'sources'> {
  return {
    conductivityWMK: k,
    densityKgM3: densityFromInertia(krhoc, k, c),
    specificHeatJKgK: c,
    sources: {
      conductivity: cited(NUREG_LINING),
      specificHeat: cited(NUREG_LINING),
      density: derived(`kρc ${krhoc} (kW/m²K)²s over k and c. ${NUREG_LINING}`),
      thickness: assumed(thicknessNote),
    },
  };
}

export const WALL_MATERIALS: readonly WallMaterial[] = [
  {
    id: 'aerated_concrete',
    label: 'Aerated concrete',
    keywords: ['aerated', 'aac'],
    thicknessM: 0.2,
    ...seededLining(0.12, 0.26, 960, '200 mm block.'),
  },
  {
    id: 'gypsum',
    label: 'Gypsum board',
    keywords: ['gypsum', 'drywall', 'plaster'],
    thicknessM: 0.016,
    ...seededLining(0.18, 0.17, 1100, 'One 16 mm board. Decision 1.'),
  },
  {
    id: 'brick_block',
    label: 'Brick or concrete block',
    keywords: ['brick', 'masonry', 'block'],
    thicknessM: 0.15,
    ...seededLining(1.2, 0.73, 840, '150 mm wall. Decision 1.'),
  },
  {
    id: 'concrete',
    label: 'Concrete',
    keywords: ['concrete', 'reinforced'],
    thicknessM: 0.15,
    ...seededLining(2.9, 1.6, 750, '150 mm wall. Decision 1.'),
  },
  {
    id: 'glass',
    label: 'Glass',
    keywords: ['glass', 'window', 'glazing'],
    conductivityWMK: 0.76,
    densityKgM3: 2700,
    specificHeatJKgK: 840,
    thicknessM: 0.006,
    sources: {
      conductivity: cited(`Plate glass. ${NUREG_LINING_UNSEEDED}`),
      density: cited(`Plate glass. ${NUREG_LINING_UNSEEDED}`),
      specificHeat: cited(`Plate glass. ${NUREG_LINING_UNSEEDED}`),
      thickness: assumed('6 mm pane.'),
    },
  },
  {
    id: 'steel',
    label: 'Steel',
    keywords: ['steel', 'metal'],
    conductivityWMK: 54 - 3.33e-2 * 20,
    densityKgM3: 7850,
    specificHeatJKgK: 425 + 7.73e-1 * 20 - 1.69e-3 * 20 ** 2 + 2.22e-6 * 20 ** 3,
    thicknessM: 0.002,
    sources: {
      conductivity: cited(`λ = 54 − 3.33×10⁻² θ at 20 °C. EN 1993-1-2:2005 3.4.1.3. ${NOT_SEEDED}`),
      density: cited(`7850 kg/m³. EN 1993-1-2:2005 3.2.2. ${NOT_SEEDED}`),
      specificHeat: cited(
        `c = 425 + 7.73×10⁻¹ θ − 1.69×10⁻³ θ² + 2.22×10⁻⁶ θ³ at 20 °C. EN 1993-1-2:2005 3.4.1.2. ${NOT_SEEDED}`,
      ),
      thickness: assumed('2 mm sheet.'),
    },
  },
  {
    id: 'aluminium',
    label: 'Aluminium',
    keywords: ['aluminium', 'aluminum'],
    conductivityWMK: 0.07 * 20 + 190,
    densityKgM3: 2700,
    specificHeatJKgK: 0.41 * 20 + 903,
    thicknessM: 0.002,
    sources: {
      conductivity: cited(
        `λ = 0.07 θ + 190 at 20 °C, 3000 and 6000 series. EN 1999-1-2:2007 3.3.1. ${NOT_SEEDED}`,
      ),
      density: cited(`2700 kg/m³. EN 1999-1-2:2007 3.3.1. ${NOT_SEEDED}`),
      specificHeat: cited(`c = 0.41 θ + 903 at 20 °C. EN 1999-1-2:2007 3.3.1. ${NOT_SEEDED}`),
      thickness: assumed('2 mm sheet.'),
    },
  },
  {
    id: 'timber',
    label: 'Timber',
    keywords: ['wood', 'timber', 'plywood'],
    conductivityWMK: 0.12,
    densityKgM3: 420,
    specificHeatJKgK: 1530,
    thicknessM: 0.018,
    sources: {
      conductivity: cited(`0.12 W/mK at 20 °C. EN 1995-1-2:2004 Annex B. ${NOT_SEEDED}`),
      density: cited(`C24 mean density 420 kg/m³. EN 338. ${NOT_SEEDED}`),
      specificHeat: cited(`1530 J/kgK at 20 °C. EN 1995-1-2:2004 Annex B Table B.1. ${NOT_SEEDED}`),
      thickness: assumed('18 mm board.'),
    },
  },
];

/** The wall row for an interior wall's `material`. Null when nothing matches. */
export function wallMaterialFor(material: string | null | undefined): WallMaterial | null {
  const mat = (material ?? '').toLowerCase().trim();
  if (!mat) return null;
  return (
    WALL_MATERIALS.find((row) => row.keywords.some((keyword) => mat.includes(keyword))) ?? null
  );
}

/** Decision 1: the layer uses concrete, brick or gypsum, and concrete for anything else. */
const LAYER_LININGS = new Set(['concrete', 'brick_block', 'gypsum']);

/** The lining the smoke layer conducts into. Never null; glass and steel fall back to concrete. */
export function layerLiningFor(material: string | null | undefined): WallMaterial {
  const row = wallMaterialFor(material);
  if (row && LAYER_LININGS.has(row.id)) return row;
  return WALL_MATERIALS.find((item) => item.id === 'concrete') as WallMaterial;
}

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
  const toxicYieldGPerG = copyYields(entry.toxicYieldGPerG);
  const toxicYieldWellVentGPerG = copyYields(entry.toxicYieldWellVentGPerG);
  return {
    category: entry.fuel,
    chfKwM2: entry.chfKwM2,
    trp: entry.trp,
    alphaKwS2: entry.alphaKwS2,
    spreadMPerMin: entry.spreadMPerMin,
    fuelLoadKgM2: entry.fuelLoadKgM2,
    liquidPool: entry.liquidPool,
    ...(entry.liquidPool ? { poolAreaM2: FRYER_POOL_AREA_M2 } : {}),
    ...(entry.sootYieldGPerG != null && entry.sootYieldGPerG > 0
      ? { sootYieldGPerG: entry.sootYieldGPerG }
      : {}),
    ...(Object.keys(toxicYieldWellVentGPerG).length > 0 ? { toxicYieldWellVentGPerG } : {}),
    ...(Object.keys(toxicYieldGPerG).length > 0 ? { toxicYieldGPerG } : {}),
  };
}

function copyYields(yields: ToxicYields): ToxicYields {
  const out: ToxicYields = {};
  for (const gas of TOXIC_PRODUCTS) {
    const yieldG = yields[gas];
    if (yieldG != null && yieldG > 0) out[gas] = yieldG;
  }
  return out;
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
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
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
  zones: readonly {
    id: string;
    pos: { x: number; y: number };
    hazardType: string;
    level?: string;
  }[] = [],
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
    const storey =
      stored != null && Number.isFinite(stored) && stored > 0 ? stored : SPRINKLER_CEILING_M;
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
