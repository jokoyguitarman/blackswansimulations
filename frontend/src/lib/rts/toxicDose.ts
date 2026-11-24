/**
 * Toxic gases in the smoke of a burning confirmed material.
 *
 * Production is the soot-mass form (NUREG-1805 Eq. 18-2): grams per second
 * = yield × (Q / ΔHc) × 1000. Q is the heat release the fire is actually
 * putting out, so a spray that has decayed Q produces less of that gas.
 * ΔHc is the wood stand-in or the transformer-oil row already used for
 * burnout. A gas jet and an electrical arc have no yield, so they add none
 * of these gases.
 *
 * Concentration comes from the smoke already on the stud, not from diluting
 * the whole production into one stud. Soot mass is K / σₘ. σₘ is 8.7 m²/g,
 * the Mulholland and Croarkin mass extinction (seed `smoke_mass_extinction`;
 * FDS uses 8700 m²/kg for flaming wood and plastics). K is the extinction
 * the smoke number already maps to. Each gas is that soot mass times
 * y_gas / y_soot. Where several fires have reached the stud, the ratio is
 * their production added up: total gas grams per second over total soot
 * grams per second. That split is assumed. This is not a species solver.
 *
 * Before the stud's flashover latch the gas yield is the well-ventilated
 * figure. After it, the stored under-ventilated label. The soot yield stays
 * the well-ventilated figure, because K already bounds the soot mass.
 * Smoke that has not arrived, a solid wall, and another storey with no
 * shaft contribute nothing. A door gap does not block, and a shaft carries
 * fumes only upward, with the smoke.
 *
 * ppm = (mg/m³) × Vm / M. Vm is the ideal gas at the 20 °C sprinkler
 * ambient and 1 atm. Molar masses are the chemical values.
 *
 * The dose is ISO 13571 only. Asphyxiants (clause 6.1): CO is ppm·min /
 * 35 000. HCN is (exp(ppm / 43) − 1) / 220 per minute. The standard writes
 * exp(ppm / 43) / 220, which is 1/220 at zero; subtracting that baseline
 * makes the term zero in clean air. CO2 is not tracked, so the clause 6.1.3
 * factor is not applied. Oxygen is not tracked and stays out of the sum.
 * Irritants (clause 6.2) are ppm / F, instantaneous: hydrogen chloride
 * 1000 ppm, acrolein 30 ppm. FED at 1 puts the person down, and that stays.
 * FEC at 1 stops them while the smoke is that thick, and they move again
 * once it falls below 1. The standard's 0.3 example is not the default.
 */

import { extinctionK } from '../evacuation/hazardSensing';
import {
  COOKING_OIL_POOL,
  SPRINKLER_AMBIENT_C,
  TOXIC_PRODUCTS,
  WOOD_HEAT_KJ_KG,
  type FuelCell,
  type ToxicProduct,
  type ToxicYields,
} from './flameFront';

export type FumeGrams = ToxicYields;

/** ISO 13571 clause 6.1.2: incapacitating CO dose, ppm·min. */
export const FED_CO_PPM_MIN = 35000;
/** ISO 13571 clause 6.1.2: HCN scale exp(ppm / 43). */
export const FED_HCN_DIVISOR = 43;
/** ISO 13571 clause 6.1.2: HCN term per minute. The zero baseline is subtracted. */
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
 * Mass-specific extinction of flaming soot, m²/g. Mulholland and Croarkin
 * (seed `smoke_mass_extinction`). FDS's flaming default is the same 8.7.
 */
export const SOOT_EXTINCTION_M2_PER_G = 8.7;

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

/** The yield set for this ventilation state. Well-ventilated until flashover. */
export function gasYieldsFor(cell: FuelCell, flashed: boolean): ToxicYields | undefined {
  if (flashed) return cell.toxicYieldGPerG;
  return cell.toxicYieldWellVentGPerG ?? cell.toxicYieldGPerG;
}

/** Grams per second of each gas the cell emits at this release. */
export function speciesProductionGPerS(cell: FuelCell, heatKw: number, flashed = false): FumeGrams {
  const out: FumeGrams = {};
  const yields = gasYieldsFor(cell, flashed);
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

/** Grams of soot per second. The yield is the well-ventilated figure. */
export function sootProductionGPerS(cell: FuelCell, heatKw: number): number {
  const yieldG = cell.sootYieldGPerG;
  if (yieldG == null || !(yieldG > 0) || !(heatKw > 0)) return 0;
  return yieldG * massLossKgPerS(heatKw, heatOfCombustionKjKg(cell)) * 1000;
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
 * ppm of each gas in this smoke. Soot mass is K / σₘ. The gas mass is that
 * times gas production over soot production. Smoke of 0 is clean air.
 */
export function fumesFromSmoke(smoke: number, gasGPerS: FumeGrams, sootGPerS: number): FumeGrams {
  const out: FumeGrams = {};
  if (!(smoke > 0) || !(sootGPerS > 0)) return out;
  const sootGPerM3 = extinctionK(smoke) / SOOT_EXTINCTION_M2_PER_G;
  if (!(sootGPerM3 > 0)) return out;
  for (const gas of TOXIC_PRODUCTS) {
    const grams = gasGPerS[gas];
    if (grams == null || !(grams > 0)) continue;
    const mgPerM3 = sootGPerM3 * (grams / sootGPerS) * 1000;
    const ppm = mgPerM3 * (MOLAR_VOLUME_L / MOLAR_MASS_G[gas]);
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
  if (hcn > 0) rate += (Math.exp(hcn / FED_HCN_DIVISOR) - 1) / FED_HCN_PER_MIN;
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

/** FED at 1 latches the person down. FEC does not. */
export function fedIncapacitates(fed: number): boolean {
  return fed >= INCAP_DOSE;
}

/** FEC at 1 stops the person while it lasts. It does not latch. */
export function fecImpairs(fec: number): boolean {
  return fec >= INCAP_DOSE;
}
