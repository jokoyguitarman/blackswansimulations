/**
 * Combustible linings and glass that breaks.
 *
 * Timber is the only lining that burns. Its row in `WALL_MATERIALS` is an
 * 18 mm board whose keywords include plywood, so the charring rate is the
 * panel rate, not the solid-timber rate. EN 1995-1-2:2004 Table 3.1 gives
 * β0 = 1.0 mm/min for wood panelling and plywood, and 0.65 mm/min for solid
 * softwood at 290 kg/m³ or more. The 0.65 figure is not used. The density
 * is the C24 figure already on that row. The heat the flame releases is the
 * wood entry's effective heat, Tewarson's red oak 12.4 MJ/kg, times the
 * char mass. The net 17.5 MJ/kg is the complete-combustion figure the fuel
 * load uses, and it is not this rate.
 *
 * Ignition is the same thick-solid dose as the contents (NUREG-1805 Eq. 6-2)
 * with the wood entry's critical flux and thermal response. The flux on the
 * base of the wall is the contents' point source (Eq. 5-1), the far-field
 * stand-in. The strip in the hot layer sees that point source plus the flux
 * a cold surface would take from the upper-layer gas.
 *
 * Upward spread is Cleary and Quintiere, Fire Safety Science 3 (1991)
 * 647-656, in the form stated by Quintiere, Torero, Long, Dillon, Wu and
 * Heater, "Material Fire Properties": the flame length is k_f Q'' y_p with
 * k_f = 0.01 m²/kW, and the front advances at (y_f − y_p) / t_ig. They use
 * 30 kW/m² as the flame flux for that t_ig. The 60 kW/m² in the same paper
 * is the flux they used for the pyrolysis-zone energy release in a
 * room-corner correlation. This model does not use 60. The energy release
 * is the charring rate, about 86.8 kW/m², so k_f Q'' is under 1 and the
 * front does not run ahead of the height that first ignited. That height
 * is the Heskestad flame of the stud with the greatest flux on the wall,
 * their ignitor region y_0. There is no separate ignitor here. There is
 * also no early peak-HRR period. A peak above 100 kW/m² would make the
 * flame taller than the pyrolysis zone. This model does not have one, so
 * that upward spread is not represented.
 *
 * Opposed spread is Quintiere and Harkleroad, NBSIR 84-2943:
 * V = Φ / [kρc (T_ig − T_s)²]. Table 2 of that report lists flame-spread
 * properties, including Φ, for plain plywood (0.635 cm) and fire-retardant
 * plywood (1.27 cm). The formula is not applied. Those specimens are not
 * this 18 mm board, and a well-mixed layer has no horizontal gradient, so
 * the immersed strip ignites together rather than as an opposed front.
 *
 * Glass cracks by Keski-Rahkonen, Fire and Materials 12 (1988), "Breaking
 * of Window Glass Close to Fire". The pane is thermally thin, the edge
 * stays at the initial temperature because the frame shades it, and it
 * cracks when the centre is hotter than the edge by σ_b / (E β). His
 * properties are σ_b = 50 MPa, β = 8×10⁻⁶ K⁻¹, E = 80 GPa. Pagni (IAFSS
 * symposium 7, "Thermal Glass Breakage") is clear that the first crack is
 * not a vent. The crack changes nothing in the opening.
 *
 * Fallout is Babrauskas, "Glass Breakage in Fires". For 4–6 mm single
 * glazing the mean gas temperature at which glass falls out enough to
 * affect the air flow is about 450 °C. This pane is 6 mm. The 3 mm mean,
 * about 360 °C, and double glazing, about 600 °C, are not used. Hassani,
 * Shields and Silcock recorded first cracks at 323–467 °C gas and fallout
 * in 1 of 6 panes by about 450–500 °C. That 1/6 is a probability of any
 * fallout, not an area, so it is not the opening. Shields later found that
 * 6 mm fallout needed about 35 kW/m². The trigger here is Babrauskas's
 * 450 °C, not that flux.
 *
 * The area is Wang and Rush, Fire Safety Journal (2018): ordinary float
 * glass "falls out gradually with a significantly smaller fallout fraction
 * (~20%)" than tempered glass, which falls out completely. This row is
 * float glass. The tilde is theirs, and the opening is that 20%. Wong, Li
 * and Spearpoint, Fire Safety Science 11 (2014) 444-457, never recorded
 * 100% for 6 mm glass. The piece is that fraction of the wall width, still
 * full height, because no hole rectangle is stored.
 */

import {
  FLAME_STANDOFF_M,
  TOXIC_PRODUCTS,
  addIgnitionDose,
  ignitionTimeSec,
  pointSourceFluxKwM2,
} from './flameFront';
import { entryById, fuelCellFromEntry, layerLiningFor, wallMaterialFor } from './materialLibrary';
import { gasYieldsFor, type FumeGrams } from './toxicDose';
import {
  AMBIENT_K,
  SURFACE_CONVECTION_C_W,
  SURFACE_EMISSIVITY,
  SIGMA_KW_M2K4,
  coldSurfaceIncidentKwM2,
} from './twoZone';

/**
 * EN 1995-1-2:2004 Table 3.1, β0 for wood panelling and plywood, 1.0 mm/min.
 * The table is for a 20 mm board at 450 kg/m³. Eq. 3.7 would raise an 18 mm
 * board at 420 kg/m³ by about √(450/420) × √(20/18), about 1.09 mm/min.
 * That correction is not applied. The 0.65 mm/min solid-softwood rate is
 * not used. The density on the timber row is C24, 420 kg/m³ (EN 338), not
 * plywood. NBSIR 84-2943 Table 3 lists plywood at 540 kg/m³. The plywood
 * keyword still uses this row.
 */
export const PLYWOOD_CHAR_MM_PER_MIN = 1;

/**
 * Cleary and Quintiere (1991) as stated in "Material Fire Properties":
 * y_f = k_f Q'' y_p. At 100 kW/m² the flame is exactly as tall as the
 * pyrolysis zone. This board's char rate is under that, and there is no
 * early peak-HRR period that would put it over.
 */
export const UPWARD_FLAME_K_M2_PER_KW = 0.01;

/**
 * Flame flux on the surface ahead of an upward front. "Material Fire
 * Properties" uses 30 kW/m² to compute t_ig for that front.
 */
export const FLAME_AHEAD_FLUX_KW_M2 = 30;

/** Keski-Rahkonen (1988). The cracking stress, the expansion, and the modulus. */
export const GLASS_BREAK_STRESS_PA = 50e6;
export const GLASS_EXPANSION_PER_K = 8e-6;
export const GLASS_MODULUS_PA = 80e9;

/**
 * A lumped pane has one temperature. It is heated by the upper layer only
 * when the hot gas covers at least half the face. Below that it sees
 * ambient gas plus the point source. Fallout reads that same gas, so a
 * shallow layer does not count as Babrauskas's room gas. The half is assumed.
 */
export const GLASS_LAYER_COVER = 0.5;

/**
 * Babrauskas, "Glass Breakage in Fires": mean gas temperature for fallout
 * of 4–6 mm single glazing, about 450 °C. The stored pane is 6 mm.
 */
export const GLASS_FALLOUT_GAS_C = 450;

/**
 * Wang and Rush (Fire Safety Journal, 2018): float glass falls out at about
 * 20% of the pane. Tempered glass, which falls out completely, is not this
 * row. The tilde in "~20%" is theirs.
 */
export const GLASS_FALLOUT_AREA_FRACTION = 0.2;

export type LiningKind = 'timber' | 'glass' | 'inert';

/** Timber burns. Glass can break. Everything else, including gypsum, only conducts. */
export function liningKind(material: string | null | undefined): LiningKind {
  const row = wallMaterialFor(material);
  if (row?.id === 'timber') return 'timber';
  if (row?.id === 'glass') return 'glass';
  return 'inert';
}

/** Keski-Rahkonen's centre-to-edge difference, kelvin. About 78 K with his properties. */
export function glassBreakDeltaK(): number {
  return GLASS_BREAK_STRESS_PA / (GLASS_EXPANSION_PER_K * GLASS_MODULUS_PA);
}

/** Babrauskas's 450 °C, in kelvin. About, so 273.15 is the usual offset, not a fit. */
export function glassFalloutGasK(): number {
  return GLASS_FALLOUT_GAS_C + 273.15;
}

/** β0 for the plywood board, metres per second. */
export function charRateMPerS(): number {
  return PLYWOOD_CHAR_MM_PER_MIN / 1000 / 60;
}

/** Seconds for the board to char through at β0, one face. */
export function charThroughS(thicknessM: number): number {
  const rate = charRateMPerS();
  if (!(thicknessM > 0) || !(rate > 0)) return Infinity;
  return thicknessM / rate;
}

/**
 * Heat release of a charring face, kW/m². β ρ ΔH_eff. Zero when the wood
 * entry has no effective heat.
 */
export function timberHeatReleaseKwM2(): number {
  const wood = entryById('wood');
  const dH = wood?.effectiveHeatOfCombustionMjKg ?? 0;
  if (!(dH > 0)) return 0;
  return charRateMPerS() * layerLiningFor('timber').densityKgM3 * dH * 1000;
}

/** y_f = k_f Q'' y_p, metres. */
export function upwardFlameLengthM(hrrKwM2: number, pyrolysisM: number): number {
  if (!(hrrKwM2 > 0) || !(pyrolysisM > 0)) return 0;
  return UPWARD_FLAME_K_M2_PER_KW * hrrKwM2 * pyrolysisM;
}

/** (y_f − y_p) / t_ig. Zero when the flame is no taller than the pyrolysis zone. */
export function concurrentSpreadMPerS(
  flameM: number,
  pyrolysisM: number,
  ignitionS: number | null,
): number {
  if (ignitionS == null || !(ignitionS > 0) || !(flameM > pyrolysisM)) return 0;
  return (flameM - pyrolysisM) / ignitionS;
}

/**
 * Opposed-flow speed, m/s. Φ is (kW)²/m³ and kρc is (kW/m²K)² s, the
 * thermally thick form in NBSIR 84-2943. Table 2 lists Φ for plain and
 * fire-retardant plywood. Not applied: those specimens are not this board,
 * and the immersed strip ignites together.
 */
export function opposedSpreadMPerS(
  phiKw2PerM3: number,
  kRhoC: number,
  tIgniteK: number,
  tSurfaceK: number,
): number {
  const rise = tIgniteK - tSurfaceK;
  if (!(phiKw2PerM3 > 0) || !(kRhoC > 0) || !(rise > 0)) return 0;
  return phiKw2PerM3 / (kRhoC * rise * rise);
}

/** Share of this step's char demand the remaining board can still supply. */
export function fuelScale(charM: number, thicknessM: number, demandM: number): number {
  const left = thicknessM - charM;
  if (!(left > 0) || !(demandM > 0)) return 0;
  return Math.min(1, left / demandM);
}

/**
 * True when the stud link crosses the wall. The same end margins as the
 * enclosure: a link that only clips a corner is not a face of that wall.
 */
export function linkCrossesWall(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): boolean {
  const d1x = bx - ax;
  const d1y = by - ay;
  const d2x = x2 - x1;
  const d2y = y2 - y1;
  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < 1e-10) return false;
  const t = ((x1 - ax) * d2y - (y1 - ay) * d2x) / denom;
  const u = ((x1 - ax) * d1y - (y1 - ay) * d1x) / denom;
  return t > 0.01 && t < 0.99 && u >= -0.01 && u <= 1.01;
}

/** Distance from a point to a segment, metres. */
export function distanceToSegmentM(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  if (!(len2 > 0)) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / len2;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/**
 * Point-source flux on a wall from one fire, kW/m². The standoff is the
 * contents' own floor, so a stud on the wall line does not make an
 * infinite flux.
 */
export function wallPointFluxKwM2(heatKw: number, distanceM: number): number {
  return pointSourceFluxKwM2(heatKw, Math.max(distanceM, FLAME_STANDOFF_M));
}

export interface TimberFace {
  /** Dose from the point source, at the base. */
  baseDose: number;
  /** Dose on the strip the hot layer covers. */
  layerDose: number;
  /** Burning height up from the floor, metres. */
  fromFloorM: number;
  /** Burning height down from the ceiling, metres. It does not shrink. */
  fromCeilingM: number;
}

export function freshTimberFace(): TimberFace {
  return { baseDose: 0, layerDose: 0, fromFloorM: 0, fromCeilingM: 0 };
}

export interface TimberFaceInput {
  /** Point-source flux from the room's burning studs, kW/m². */
  flameKwM2: number;
  /** Upper-layer temperature. Ambient when that room has no layer. */
  gasK: number;
  /** Hot-layer depth, metres. */
  hotDepthM: number;
  ceilingM: number;
  /** Heskestad height of the stud that dominates the point source. */
  igniterFlameM: number;
  lengthM: number;
  /** Door hole. Zero when this face has no opening. */
  doorWidthM: number;
  doorHeadM: number;
  dt: number;
}

/**
 * Burning area of one face. The floor front and the ceiling strip are
 * united, and the door hole is not lining.
 */
export function liningBurnAreaM2(
  lengthM: number,
  ceilingM: number,
  doorWidthM: number,
  doorHeadM: number,
  fromFloorM: number,
  fromCeilingM: number,
): number {
  if (!(lengthM > 0) || !(ceilingM > 0)) return 0;
  const floor = Math.min(ceilingM, Math.max(0, fromFloorM));
  const fromTop = Math.min(ceilingM, Math.max(0, fromCeilingM));
  const union = Math.min(ceilingM, floor + fromTop);
  const head = Math.min(ceilingM, Math.max(0, doorHeadM));
  const door = Math.min(lengthM, Math.max(0, doorWidthM));
  const holeOnFloor = Math.min(floor, head);
  const ceilBottom = ceilingM - fromTop;
  const holeOnTop = ceilBottom < head ? Math.max(0, head - Math.max(ceilBottom, 0)) : 0;
  const countedTwice = floor + fromTop > ceilingM ? Math.max(0, head - (ceilingM - fromTop)) : 0;
  const hole = door * Math.max(0, holeOnFloor + holeOnTop - countedTwice);
  return Math.max(0, lengthM * union - hole);
}

function woodIgnition(): { chf: number; trp: number } | null {
  const wood = entryById('wood');
  if (wood?.chfKwM2 == null || wood.trp == null) return null;
  if (!(wood.chfKwM2 > 0) || !(wood.trp > 0)) return null;
  return { chf: wood.chfKwM2, trp: wood.trp };
}

/** One face for one step. The char depth stays with the caller: two faces share the board. */
export function advanceTimberFace(face: TimberFace, input: TimberFaceInput): TimberFaceAdvance {
  const next: TimberFace = { ...face };
  const ign = woodIgnition();
  if (!ign || !(input.dt > 0) || !(input.ceilingM > 0)) {
    return { face: next, areaM2: 0 };
  }
  next.baseDose = addIgnitionDose(next.baseDose, input.flameKwM2, ign.chf, ign.trp, input.dt);
  if (next.baseDose >= 1 && !(next.fromFloorM > 0)) {
    next.fromFloorM = Math.min(input.ceilingM, Math.max(0, input.igniterFlameM));
  }
  const layerFlux = input.hotDepthM > 0 ? coldSurfaceIncidentKwM2(input.gasK) : 0;
  if (input.hotDepthM > 0) {
    next.layerDose = addIgnitionDose(
      next.layerDose,
      layerFlux + Math.max(0, input.flameKwM2),
      ign.chf,
      ign.trp,
      input.dt,
    );
  }
  if (next.layerDose >= 1) {
    const immersed = Math.min(input.ceilingM, input.hotDepthM);
    if (immersed > next.fromCeilingM) next.fromCeilingM = immersed;
  }
  if (next.fromFloorM > 0 && next.fromFloorM < input.ceilingM) {
    const qArea = timberHeatReleaseKwM2();
    const flame = Math.min(input.ceilingM, upwardFlameLengthM(qArea, next.fromFloorM));
    const frontInLayer = next.fromFloorM >= input.ceilingM - Math.max(0, input.hotDepthM);
    const ahead = FLAME_AHEAD_FLUX_KW_M2 + (frontInLayer ? layerFlux : 0);
    const tig = ignitionTimeSec(ahead, ign.chf, ign.trp);
    const speed = concurrentSpreadMPerS(flame, next.fromFloorM, tig);
    if (speed > 0) next.fromFloorM = Math.min(input.ceilingM, next.fromFloorM + speed * input.dt);
  }
  return {
    face: next,
    areaM2: liningBurnAreaM2(
      input.lengthM,
      input.ceilingM,
      input.doorWidthM,
      input.doorHeadM,
      next.fromFloorM,
      next.fromCeilingM,
    ),
  };
}

export interface TimberFaceAdvance {
  face: TimberFace;
  areaM2: number;
}

export interface TimberRelease {
  heatKw: number;
  sootGPerS: number;
  fumes: FumeGrams;
}

/**
 * Heat, soot, and gases from a burning area. The mass is β ρ A, not the
 * heat divided by the net calorific value. Soot is the wood entry's
 * well-ventilated yield. The gases follow the same equivalence-ratio blend
 * the contents use. φ of 0 stays on the well-ventilated row.
 */
export function timberRelease(areaM2: number, phi: number): TimberRelease {
  const none: TimberRelease = { heatKw: 0, sootGPerS: 0, fumes: {} };
  if (!(areaM2 > 0)) return none;
  const wood = entryById('wood');
  const dH = wood?.effectiveHeatOfCombustionMjKg ?? 0;
  if (!wood || !(dH > 0)) return none;
  const massKgS = charRateMPerS() * layerLiningFor('timber').densityKgM3 * areaM2;
  if (!(massKgS > 0)) return none;
  const grams = massKgS * 1000;
  const sootYield = wood.sootYieldGPerG ?? 0;
  const fumes: FumeGrams = {};
  const cell = fuelCellFromEntry(wood);
  const yields = cell ? gasYieldsFor(cell, phi) : undefined;
  if (yields) {
    for (const gas of TOXIC_PRODUCTS) {
      const yieldG = yields[gas];
      if (yieldG != null && yieldG > 0) fumes[gas] = yieldG * grams;
    }
  }
  return {
    heatKw: massKgS * dH * 1000,
    sootGPerS: sootYield > 0 ? sootYield * grams : 0,
    fumes,
  };
}

/** Gas the lumped pane sees. Ambient until the hot layer covers half the face. */
export function glassGasTemperatureK(upperK: number, hotDepthM: number, ceilingM: number): number {
  if (!(ceilingM > 0) || !(hotDepthM >= GLASS_LAYER_COVER * ceilingM)) return AMBIENT_K;
  if (!(upperK > 0)) return AMBIENT_K;
  return upperK;
}

function convectionKwM2(fromK: number, toK: number): number {
  const across = fromK - toK;
  if (across === 0) return 0;
  const film = (SURFACE_CONVECTION_C_W / 1000) * Math.pow(Math.abs(across), 1 / 3);
  return film * across;
}

/**
 * Net flux on a thermally thin pane, kW/m². The fire side takes the point
 * source, the grey exchange with the gas, and the wall convection. The
 * back loses the same film to ambient. One coefficient for every face is
 * the layer's existing assumption.
 */
export function paneNetKwM2(paneK: number, gasK: number, flameKwM2: number): number {
  const flame = Math.max(0, flameKwM2);
  const gasRad = SURFACE_EMISSIVITY * SIGMA_KW_M2K4 * (gasK ** 4 - paneK ** 4);
  const backRad = SURFACE_EMISSIVITY * SIGMA_KW_M2K4 * (AMBIENT_K ** 4 - paneK ** 4);
  return flame + gasRad + convectionKwM2(gasK, paneK) + backRad + convectionKwM2(AMBIENT_K, paneK);
}

export interface GlassPaneInput {
  paneK: number;
  /** Already chosen: ambient, or the upper layer when it covers half the face. */
  gasK: number;
  flameKwM2: number;
  dt: number;
  rhoKgM3: number;
  cJKgK: number;
  thicknessM: number;
}

export interface GlassPaneState {
  cracked: boolean;
  fallen: boolean;
}

export interface GlassPaneStep {
  paneK: number;
  cracked: boolean;
  fallen: boolean;
}

/**
 * One lumped step. The pane starts at ambient, and that ambient is the
 * shaded edge for the whole fire. Crossing the Keski-Rahkonen difference
 * cracks it. The crack is not an opening. Fallout is the gas the pane
 * sees reaching Babrauskas's 450 °C, and only after the crack. Neither
 * heals. Once the pane has cracked, its temperature stays: fallout does
 * not need a hotter pane, only the gas.
 */
export function stepGlassPane(input: GlassPaneInput, already: GlassPaneState): GlassPaneStep {
  const gasK = input.gasK > 0 ? input.gasK : AMBIENT_K;
  if (already.fallen) return { paneK: input.paneK, cracked: true, fallen: true };
  let paneK = input.paneK > 0 ? input.paneK : AMBIENT_K;
  let cracked = already.cracked;
  if (!cracked) {
    const cap = input.rhoKgM3 * (input.cJKgK / 1000) * input.thicknessM;
    if (cap > 0 && input.dt > 0) {
      const q = paneNetKwM2(paneK, gasK, input.flameKwM2);
      paneK = Math.min(1500, Math.max(AMBIENT_K, paneK + (q / cap) * input.dt));
      cracked = paneK - AMBIENT_K >= glassBreakDeltaK();
    }
  }
  return { paneK, cracked, fallen: cracked && gasK >= glassFalloutGasK() };
}
