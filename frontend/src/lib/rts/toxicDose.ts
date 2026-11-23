/**
 * Toxic gases in the smoke of a burning confirmed material.
 *
 * Production is the soot-mass form (NUREG-1805 Eq. 18-2): grams of gas per
 * second = yield × (Q / ΔHc) × 1000. Q is the heat release the fire is
 * actually putting out, so a spray that has decayed Q produces less gas.
 * ΔHc is the wood stand-in or the transformer-oil row already used for
 * burnout. The yield is the library row, grams per gram, and every yield
 * is assumed. A gas jet and an electrical arc have no yield, so they add
 * none of these gases.
 *
 * The smoke number already on the stud is the carrier. It is split across
 * the gases of the burning objects whose smoke has reached that stud,
 * weighted by this production. That split is assumed: this is not a species
 * solver. Smoke that has not arrived, a solid wall, and another storey
 * with no shaft contribute nothing. A door gap does not block, and a shaft
 * carries fumes only upward, with the smoke.
 *
 * Concentration at smoke = 1 is that production diluted into one stud of
 * breathing air. The floor is the 9 m² stud. The 2 m depth is the height
 * tenability is read at (NZ C/VM2, seed `nz_tenability_limits`), used here
 * as a layer thickness, which the seed does not state. The volume is assumed
 * to turn over once every STUD_TURNOVER_S. The seeds have leakage areas and
 * no food-court ventilation rate, so those five minutes are assumed still
 * indoor air, not an extract rate. ppm = (mg/m³) × Vm / M. Vm is the ideal
 * gas at the 20 °C sprinkler ambient and 1 atm. Molar masses are the
 * chemical values.
 *
 * The dose is ISO 13571 only. Asphyxiants (clause 6.1): CO is ppm·min /
 * 35 000, and HCN is exp(ppm / 43) / 220 per minute while any HCN is
 * present. At 0 ppm that HCN expression is not zero, so clean air does not
 * use it. CO2 is not tracked, so the clause 6.1.3 factor is not applied.
 * Oxygen is not tracked and stays out of the sum. Irritants (clause 6.2)
 * are ppm / F: hydrogen chloride 1000 ppm, acrolein 30 ppm. A person is
 * incapacitated when either sum reaches 1. The standard's 0.3 example is
 * not the default.
 */

import {
  COOKING_OIL_POOL,
  SPRINKLER_AMBIENT_C,
  STUD_AREA_M2,
  TOXIC_PRODUCTS,
  WOOD_HEAT_KJ_KG,
  type FuelCell,
  type ToxicProduct,
  type ToxicYields,
} from './flameFront';

export type FumeGrams = ToxicYields;

/** ISO 13571 clause 6.1.2: incapacitating CO dose, ppm·min. */
export const FED_CO_PPM_MIN = 35000;
/** ISO 13571 clause 6.1.2: HCN term exp(ppm / 43) / 220, per minute. */
export const FED_HCN_DIVISOR = 43;
export const FED_HCN_PER_MIN = 220;
/**
 * ISO 13571 clause 6.2 F values, ppm. Hydrogen chloride and acrolein are
 * the two irritants the library emits. The uncertainty on F is about ±50 %.
 */
export const FEC_F_PPM: Record<'HCl' | 'acrolein', number> = {
  HCl: 1000,
  acrolein: 30,
};
/** Same threshold for FED and FEC. Not the 0.3 susceptible-population example. */
export const INCAP_DOSE = 1;

/**
 * Height tenability is read at, used as the assumed depth of the breathing
 * layer. The seed records the height, not this depth.
 */
export const BREATH_LAYER_M = 2;
/**
 * Assumed time for one stud of breathing air to be replaced. Five minutes
 * of still indoor air. Not a kitchen extract rate.
 */
export const STUD_TURNOVER_S = 300;
/**
 * Ideal-gas molar volume at the sprinkler ambient and 1 atm, litres per
 * mole. 22.414 × (293.15 / 273.15).
 */
export const MOLAR_VOLUME_L = 22.414 * ((SPRINKLER_AMBIENT_C + 273.15) / 273.15);

/** Chemical molar masses, g/mol. */
export const MOLAR_MASS_G: Record<ToxicProduct, number> = {
  CO: 28.01,
  HCN: 27.03,
  HCl: 36.46,
  acrolein: 56.06,
};

/** kJ/kg already used for that cell's burnout. */
export function heatOfCombustionKjKg(cell: FuelCell): number {
  return cell.liquidPool ? COOKING_OIL_POOL.dHcKjKg : WOOD_HEAT_KJ_KG;
}

/** Kilograms of fuel per second at this heat release. */
export function massLossKgPerS(heatKw: number, dHcKjKg: number): number {
  if (!(heatKw > 0) || !(dHcKjKg > 0)) return 0;
  return heatKw / dHcKjKg;
}

/** Grams per second of each gas the cell's yield emits at this release. */
export function speciesProductionGPerS(cell: FuelCell, heatKw: number): FumeGrams {
  const out: FumeGrams = {};
  const yields = cell.toxicYieldGPerG;
  if (!yields || !(heatKw > 0)) return out;
  const burnedGPerS = massLossKgPerS(heatKw, heatOfCombustionKjKg(cell)) * 1000;
  if (!(burnedGPerS > 0)) return out;
  for (const gas of TOXIC_PRODUCTS) {
    const yieldG = yields[gas];
    if (yieldG == null || !(yieldG > 0)) continue;
    const grams = yieldG * burnedGPerS;
    if (grams > 0) out[gas] = grams;
  }
  return out;
}

export function fumesPresent(grams: FumeGrams | undefined): boolean {
  if (!grams) return false;
  for (const gas of TOXIC_PRODUCTS) {
    if ((grams[gas] ?? 0) > 0) return true;
  }
  return false;
}

/** Add `extra` into `into`. */
export function addFumeGrams(into: FumeGrams, extra: FumeGrams): void {
  for (const gas of TOXIC_PRODUCTS) {
    const grams = extra[gas];
    if (grams == null || !(grams > 0)) continue;
    into[gas] = (into[gas] ?? 0) + grams;
  }
}

/**
 * ppm of each gas when `smoke` (0–1) of this production has reached the stud.
 * Smoke of 0 is clean air whatever is burning elsewhere.
 */
export function fumesPpm(gramsPerS: FumeGrams, smoke: number): FumeGrams {
  const out: FumeGrams = {};
  if (!(smoke > 0)) return out;
  const carried = Math.min(1, smoke);
  const volumeM3 = STUD_AREA_M2 * BREATH_LAYER_M;
  const replacedM3PerS = volumeM3 / STUD_TURNOVER_S;
  if (!(replacedM3PerS > 0)) return out;
  for (const gas of TOXIC_PRODUCTS) {
    const grams = gramsPerS[gas];
    if (grams == null || !(grams > 0)) continue;
    const mgPerM3 = (grams * 1000) / replacedM3PerS;
    const ppm = carried * mgPerM3 * (MOLAR_VOLUME_L / MOLAR_MASS_G[gas]);
    if (ppm > 0) out[gas] = ppm;
  }
  return out;
}

/** ISO 13571 CO and HCN terms, per minute, at this concentration. */
export function fedPerMin(fumes: FumeGrams | undefined): number {
  if (!fumes) return 0;
  let rate = 0;
  const co = fumes.CO ?? 0;
  if (co > 0) rate += co / FED_CO_PPM_MIN;
  const hcn = fumes.HCN ?? 0;
  if (hcn > 0) rate += Math.exp(hcn / FED_HCN_DIVISOR) / FED_HCN_PER_MIN;
  return rate;
}

/** Accumulate FED. `dtSec` is physical time. Constant concentration is exact in dt. */
export function advanceFed(fed: number, fumes: FumeGrams | undefined, dtSec: number): number {
  if (!(dtSec > 0)) return fed;
  return fed + fedPerMin(fumes) * (dtSec / 60);
}

/** ISO 13571 irritant sum. Instantaneous: it is not integrated. */
export function fecOf(fumes: FumeGrams | undefined): number {
  if (!fumes) return 0;
  let fec = 0;
  const hcl = fumes.HCl ?? 0;
  if (hcl > 0) fec += hcl / FEC_F_PPM.HCl;
  const acrolein = fumes.acrolein ?? 0;
  if (acrolein > 0) fec += acrolein / FEC_F_PPM.acrolein;
  return fec;
}

export function doseIncapacitates(fed: number, fec: number): boolean {
  return fed >= INCAP_DOSE || fec >= INCAP_DOSE;
}
