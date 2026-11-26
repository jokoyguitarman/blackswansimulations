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
 * The gas yield follows the room's equivalence ratio. At Φ below 0.75,
 * ISO 19706 stage 2, it is the well-ventilated figure. At Φ of 1.5 and
 * above, the start of Purser's post-flashover band, it is the stored
 * under-ventilated figure. Between those two cited ends the yield moves
 * in a straight line. No curve was read for that interval, and the line
 * is not fitted. The flashover latch does not choose the yield. The soot
 * yield stays the well-ventilated figure: the under-ventilated soot row
 * is a placeholder, and K already bounds the soot mass.
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
 * makes the term zero in clean air. Clause 6.1.3 multiplies those two
 * terms by exp(%CO2 / 5). The oxygen term is Δt / exp[8.13 − 0.54(20.9 −
 * %O2)], and the clean-air value is subtracted so 20.9% adds nothing, the
 * same baseline as HCN. Oxygen is outside the carbon-dioxide factor.
 * Irritants (clause 6.2) are ppm / F, instantaneous: hydrogen chloride
 * 1000 ppm, acrolein 30 ppm. FED at 1 puts the person down, and that stays.
 * FEC at 1 makes them crawl while the smoke is that thick, and they walk
 * again once it falls below 1. The standard's 0.3 example is not the default.
 *
 * Heat is a second FED, ISO 13571:2012 clause 8. Eq. (10) is the convective
 * time for lightly clothed people. Eq. (9) is the fully clothed fit and is
 * not used: the head and the hands are bare. Eq. (7) is the radiant time to
 * second-degree burning. Below 2.5 kW/m² that term is zero. Eq. (8) is time
 * to pain and is not this dose. Eq. (11) adds the two reciprocals. The
 * asphyxiant FED is not added to it. Compromised tenability is whichever
 * FED reaches 1 first. The sum is the exposure already taken. It does not
 * fall if the gas cools.
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
 * ISO 13571:2012 Eq. (10), clause 8.3.2. Lightly clothed convective time,
 * minutes, is this coefficient times T to the power −HEAT_CONV_EXP.
 */
export const HEAT_CONV_COEFF = 5e7;
export const HEAT_CONV_EXP = 3.4;
/**
 * ISO 13571:2012 Eq. (7), clause 8.2. Radiant time to second-degree burning,
 * minutes, is this coefficient times q to the power −HEAT_RAD_EXP.
 */
export const HEAT_RAD_COEFF = 6.9;
export const HEAT_RAD_EXP = 1.56;
/** ISO 13571:2012 clause 8.2. Radiant flux below this does not enter the dose. */
export const HEAT_RAD_LIMIT_KW_M2 = 2.5;
/**
 * No convective dose at or below this. It is the zone ambient, 293 K.
 * The equation is a fire exposure, and room air is not one.
 */
export const HEAT_AMBIENT_C = 19.85;

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

/**
 * ISO 19706 stage 2 is well-ventilated flaming at Φ < 0.75. The other
 * end is Purser's post-flashover yield, measured in the ISO/TS 19700
 * tube furnace at Φ 1.5 to 2. Those values are the test condition for
 * the yield row. ISO 19706 gives post-flashover only as φ > 1, and
 * neither document caps a real compartment at 2.
 */
export const PHI_WELL_VENT = 0.75;
export const PHI_UNDER_VENT = 1.5;

/** 0 at the well-ventilated end, 1 at the under-ventilated end. */
export function ventilationBlend(phi: number): number {
  if (!(phi > PHI_WELL_VENT)) return 0;
  if (!Number.isFinite(phi) || phi >= PHI_UNDER_VENT) return 1;
  return (phi - PHI_WELL_VENT) / (PHI_UNDER_VENT - PHI_WELL_VENT);
}

/**
 * The yield set at this equivalence ratio. A straight line between the
 * stored well-ventilated and under-ventilated figures. Φ of 0, and a fire
 * with no layer, stays on the well-ventilated figure.
 */
export function gasYieldsFor(cell: FuelCell, phi = 0): ToxicYields | undefined {
  const well = cell.toxicYieldWellVentGPerG ?? cell.toxicYieldGPerG;
  const rich = cell.toxicYieldGPerG;
  if (!well && !rich) return undefined;
  const blend = ventilationBlend(phi);
  if (!(blend > 0) || !rich) return well;
  if (blend >= 1 || !well) return rich;
  const out: ToxicYields = {};
  for (const gas of TOXIC_PRODUCTS) {
    const calm = well[gas] ?? 0;
    const hot = rich[gas] ?? 0;
    const yieldG = calm + (hot - calm) * blend;
    if (yieldG > 0) out[gas] = yieldG;
  }
  return out;
}

/** Grams per second of each gas the cell emits at this release and equivalence ratio. */
export function speciesProductionGPerS(cell: FuelCell, heatKw: number, phi = 0): FumeGrams {
  const out: FumeGrams = {};
  const yields = gasYieldsFor(cell, phi);
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

/** Volume percent from a mass fraction. CFAST's 29 g/mol air and the species molar mass. */
export function volumePercent(massFraction: number, molarMassG: number): number {
  if (!(massFraction > 0) || !(molarMassG > 0)) return 0;
  return massFraction * (29 / molarMassG) * 100;
}

/** Ambient oxygen as a volume percent. 0.23 × 29/32 × 100. */
export const O2_AMBIENT_VOLUME_PERCENT = volumePercent(0.23, 32);

/**
 * ISO 13571 oxygen term, per minute. The rate at ambient is subtracted, so
 * ambient air and anything richer add nothing. Ambient here is the layer's
 * 0.23 mass fraction, 20.84% by volume, not the 20.9% written in the
 * formula. A head in untouched air must not accumulate a dose.
 */
export function oxygenFedPerMin(volumePercentO2: number): number {
  const ambient = O2_AMBIENT_VOLUME_PERCENT;
  if (!(volumePercentO2 < ambient)) return 0;
  const at = (percent: number) => 1 / Math.exp(8.13 - 0.54 * (20.9 - percent));
  return Math.max(0, at(volumePercentO2) - at(ambient));
}

/**
 * ISO 13571 clause 6.1.3. exp(%CO2 / 5). No carbon dioxide leaves it at 1.
 * The percent is the oxygen volume the layer has lost, one volume of CO2
 * for one volume of O2, the cellulose reaction (C6H10O5 + 6 O2 → 6 CO2 +
 * 5 H2O). That ratio is assumed. A plastic makes less CO2 per O2, and CO
 * takes a little of the carbon. It is not fitted.
 */
export function co2Hyperventilation(volumePercentCo2: number): number {
  if (!(volumePercentCo2 > 0)) return 1;
  return Math.exp(volumePercentCo2 / 5);
}

/** What a head in this layer breathes. The deficit from ambient oxygen is the CO2. */
export function layerBreath(o2MassFraction: number): {
  oxygenVolumePercent: number;
  co2VolumePercent: number;
} {
  const oxygen = volumePercent(o2MassFraction, 32);
  return {
    oxygenVolumePercent: oxygen,
    co2VolumePercent: Math.max(0, O2_AMBIENT_VOLUME_PERCENT - oxygen),
  };
}

/** ISO 13571 CO and HCN terms, per minute, then oxygen. CO2 multiplies the first two. */
export function fedPerMin(
  fumes: FumeGrams | undefined,
  oxygenVolumePercent?: number,
  co2VolumePercent?: number,
): number {
  let rate = 0;
  if (fumes) {
    const co = fumes.CO ?? 0;
    if (co > 0) rate += co / FED_CO_PPM_MIN;
    const hcn = fumes.HCN ?? 0;
    if (hcn > 0) rate += (Math.exp(hcn / FED_HCN_DIVISOR) - 1) / FED_HCN_PER_MIN;
  }
  rate *= co2Hyperventilation(co2VolumePercent ?? 0);
  rate += oxygenFedPerMin(oxygenVolumePercent ?? O2_AMBIENT_VOLUME_PERCENT);
  return rate;
}

/** Accumulate FED. `dtSec` is physical time. Constant concentration is exact in dt. */
export function advanceFed(
  fed: number,
  fumes: FumeGrams | undefined,
  dtSec: number,
  oxygenVolumePercent?: number,
  co2VolumePercent?: number,
): number {
  if (!(dtSec > 0)) return fed;
  return fed + fedPerMin(fumes, oxygenVolumePercent, co2VolumePercent) * (dtSec / 60);
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

/**
 * ISO 13571:2012 Eq. (11), per minute. Convection from the gas at the head,
 * radiation from the hot layer. Either argument may be absent.
 */
export function heatFedPerMin(tempC?: number, radiantKwM2?: number): number {
  let rate = 0;
  if (tempC != null && tempC > HEAT_AMBIENT_C) {
    rate += tempC ** HEAT_CONV_EXP / HEAT_CONV_COEFF;
  }
  const flux = radiantKwM2 ?? 0;
  if (flux >= HEAT_RAD_LIMIT_KW_M2) rate += flux ** HEAT_RAD_EXP / HEAT_RAD_COEFF;
  return rate;
}

/** Accumulate the heat FED. `dtSec` is physical time. Constant exposure is exact in dt. */
export function advanceHeatFed(
  fed: number,
  tempC: number | undefined,
  radiantKwM2: number | undefined,
  dtSec: number,
): number {
  if (!(dtSec > 0)) return fed;
  return fed + heatFedPerMin(tempC, radiantKwM2) * (dtSec / 60);
}

/** FED at 1 latches the person down. FEC does not. */
export function fedIncapacitates(fed: number): boolean {
  return fed >= INCAP_DOSE;
}

/**
 * ISO 13571 keeps the heat FED apart from the asphyxiant FED. Either one
 * at 1 is compromised tenability. The two doses are not added.
 */
export function exposureIncapacitates(asphyxiantFed: number, heatFed: number): boolean {
  return fedIncapacitates(asphyxiantFed) || fedIncapacitates(heatFed);
}

/** FEC at 1 stops the person while it lasts. It does not latch. */
export function fecImpairs(fec: number): boolean {
  return fec >= INCAP_DOSE;
}
