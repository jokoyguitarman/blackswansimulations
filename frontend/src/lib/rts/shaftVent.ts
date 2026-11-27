/**
 * Stair and lift shaft as a vent between two storeys.
 *
 * The shaft is not its own room. Two landing doors in series join the
 * layers, and the gas column between the floors adds the stack head
 * (ρ_ambient − ρ_shaft) g H. CFAST's wall vent is the orifice (C = 0.7,
 * the same coefficient as a door). Flow is upward when the lower floor
 * is the hot one, and downward when the upper floor's gauge at the door
 * exceeds that draft. A fixed 400 K and an upward-only mix are not used.
 *
 * The door is the 2 m landing door. Smoke enters only once the upper
 * layer has reached that head. Blocked is a crowd flag: the vent stays
 * open.
 */
import { LEVEL } from '../evacuation/levelConstants';
import { AMBIENT_K, DOOR_SOFFIT_M } from './twoZone';

/** ρ T = 353, the same identity as the door vent. */
const RHO_T = 353;

/** Two equal doors in series. 1/A² + 1/A². */
const SERIES_DOORS = 2;

/**
 * A shaft with no flow cools toward the stair air. Assumed. Thirty
 * seconds is long enough that one quiet step does not forget a hot column.
 */
const SHAFT_RELAX_S = 30;

/**
 * Plan depth of the air column, metres. A flight plus a half landing.
 * The scene does not measure the well, and the column only exists so the
 * stack warms as gas actually passes through it.
 */
const SHAFT_RUN_M = 3;

/** Thinnest upper layer the vent will leave behind, metres. */
const MIN_UPPER_DEPTH_M = 0.02;

export function shaftDensityKgM3(tempK: number): number {
  return RHO_T / Math.max(tempK, 1);
}

/** Landing door height. A short storey cuts the door at the ceiling. */
export function shaftOpeningM(storeyHeightM: number): number {
  if (!(storeyHeightM > 0)) return 0;
  return Math.min(DOOR_SOFFIT_M, storeyHeightM);
}

/**
 * Inside-minus-outside gauge at height z. Below the interface the gauge
 * is the floor value. Above it the slope is (ρ_lower − ρ_upper) g, the
 * same split the door solver uses.
 */
export function shaftGaugePa(
  zM: number,
  interfaceM: number,
  floorPressurePa: number,
  lowerK: number,
  upperK: number,
): number {
  if (!(zM > interfaceM)) return floorPressurePa;
  const slope = (shaftDensityKgM3(lowerK) - shaftDensityKgM3(upperK)) * LEVEL.G;
  return floorPressurePa + slope * (zM - interfaceM);
}

export interface ShaftEnd {
  /** False is a storey with no layer: ambient, gauge zero, no upper gas. */
  active: boolean;
  interfaceM: number;
  upperK: number;
  lowerK: number;
  floorPressurePa: number;
  ceilingM: number;
}

/**
 * Pressure that drives flow from the lower storey into the upper one,
 * pascals. Positive is up the shaft.
 *
 * Each gauge is inside minus the outside air at that floor. The outside
 * column between the floors is ρ_ambient g H, and the shaft column is
 * ρ_shaft g H, so the difference is the stack. The door gauges sit on
 * top of that, which is what lets a deep upper layer push gas back down.
 */
export function shaftDrivePa(
  lower: ShaftEnd,
  upper: ShaftEnd,
  shaftK: number,
  storeyHeightM: number,
): number {
  if (!(storeyHeightM > 0) || !(shaftK > 0)) return 0;
  const zDoor = shaftOpeningM(storeyHeightM);
  const gaugeL = lower.active
    ? shaftGaugePa(zDoor, lower.interfaceM, lower.floorPressurePa, lower.lowerK, lower.upperK)
    : 0;
  const gaugeU = upper.active
    ? shaftGaugePa(zDoor, upper.interfaceM, upper.floorPressurePa, upper.lowerK, upper.upperK)
    : 0;
  return gaugeL - gaugeU + shaftStackPa(shaftK, storeyHeightM);
}

/** (ρ_ambient − ρ_shaft) g H. Positive when the column is buoyant. */
export function shaftStackPa(shaftK: number, storeyHeightM: number): number {
  if (!(storeyHeightM > 0) || !(shaftK > 0)) return 0;
  // The same 353/T as the layers. A constant 1.2 would leave a draft
  // between two ambient floors.
  return (shaftDensityKgM3(AMBIENT_K) - shaftDensityKgM3(shaftK)) * LEVEL.G * storeyHeightM;
}

/**
 * Width of one orifice standing in for the two landing doors. Two equal
 * openings in series pass A/√2.
 */
export function shaftEquivalentWidthM(doorWidthM: number): number {
  if (!(doorWidthM > 0)) return 0;
  return doorWidthM / Math.sqrt(SERIES_DOORS);
}

/** Air in the shaft, kg. The width is the landing door; the run is assumed. */
export function shaftColumnMassKg(tempK: number, widthM: number, heightM: number): number {
  if (!(tempK > 0) || !(widthM > 0) || !(heightM > 0)) return 0;
  return shaftDensityKgM3(tempK) * widthM * SHAFT_RUN_M * heightM;
}

/**
 * Signed mass flow through the two landing doors, kg/s. Positive is
 * upward. The upwind density is the gas that would enter the shaft.
 */
export function shaftMassFlowKgS(
  drivePa: number,
  widthM: number,
  openingM: number,
  upwindK: number,
): number {
  if (!(widthM > 0) || !(openingM > 0) || !(upwindK > 0)) return 0;
  const area = widthM * openingM;
  const equivalent = area / Math.sqrt(SERIES_DOORS);
  const rho = shaftDensityKgM3(upwindK);
  const magnitude = LEVEL.ORIFICE_C * equivalent * Math.sqrt(2 * rho * Math.abs(drivePa));
  if (!(magnitude > 0)) return 0;
  return drivePa >= 0 ? magnitude : -magnitude;
}

/** The door head is inside the upper layer, so the vent takes that gas. */
export function doorHeadInUpper(interfaceM: number, openingM: number): boolean {
  return openingM > 0 && interfaceM < openingM - 1e-4;
}

/**
 * Shaft temperature after this step. Inflow replaces only its share of
 * the column, so one parcel does not turn the whole well into a chimney.
 * A quiet step relaxes toward ambient. The column cools on a flowing
 * step too: the walls are still there.
 */
export function nextShaftK(
  shaftK: number,
  dt: number,
  inflowKg: number,
  inflowK: number | null,
  columnMassKg: number,
): number {
  const prev = shaftK > 0 ? shaftK : AMBIENT_K;
  let temp = prev;
  if (inflowK != null && inflowK > 0 && inflowKg > 0 && columnMassKg > 0) {
    const replaced = Math.min(1, inflowKg / columnMassKg);
    temp = prev + replaced * (inflowK - prev);
  }
  if (!(dt > 0)) return temp;
  const kept = Math.exp(-dt / SHAFT_RELAX_S);
  return AMBIENT_K + (temp - AMBIENT_K) * kept;
}

export interface UpperGas {
  interfaceM: number;
  upperK: number;
  sootG: number;
  fuelKg: number;
  upperO2: number;
  areaM2: number;
  ceilingM: number;
}

function upperMassKg(gas: UpperGas): number {
  const depth = Math.max(0, gas.ceilingM - gas.interfaceM);
  if (!(gas.areaM2 > 0) || !(gas.upperK > 0) || !(depth > 0)) return 0;
  return shaftDensityKgM3(gas.upperK) * gas.areaM2 * depth;
}

function clampInterface(ceilingM: number, depthM: number): number {
  const floor = 0.05;
  const top = Math.max(floor, ceilingM - MIN_UPPER_DEPTH_M);
  const z = ceilingM - Math.max(0, depthM);
  if (z < floor) return floor;
  if (z > top) return top;
  return z;
}

/**
 * Move `kg` of the source upper layer into the destination upper layer.
 * Soot, fuel and oxygen go with that mass. The interface on each side
 * moves by the parcel's volume. Nothing is taken from below the 2 cm
 * sliver the energy step keeps.
 */
export function moveUpperGas(
  source: UpperGas,
  dest: UpperGas,
  kg: number,
): { source: UpperGas; dest: UpperGas; movedKg: number } {
  const mass = upperMassKg(source);
  const keep =
    source.areaM2 > 0 && source.upperK > 0
      ? shaftDensityKgM3(source.upperK) * source.areaM2 * MIN_UPPER_DEPTH_M
      : 0;
  const moved = Math.min(Math.max(kg, 0), Math.max(0, mass - keep));
  if (!(moved > 0) || !(mass > 0) || !(dest.areaM2 > 0) || !(dest.ceilingM > 0)) {
    return { source, dest, movedKg: 0 };
  }
  const fraction = moved / mass;
  const soot = source.sootG * fraction;
  const fuel = source.fuelKg * fraction;
  const destMass = upperMassKg(dest);
  const destTemp =
    destMass + moved > 0
      ? (destMass * dest.upperK + moved * source.upperK) / (destMass + moved)
      : source.upperK;
  const destO2 =
    destMass + moved > 0
      ? (destMass * dest.upperO2 + moved * source.upperO2) / (destMass + moved)
      : source.upperO2;
  const sourceDepth = (mass - moved) / (shaftDensityKgM3(source.upperK) * source.areaM2);
  const destDepth = (destMass + moved) / (shaftDensityKgM3(destTemp) * dest.areaM2);
  return {
    source: {
      ...source,
      interfaceM: clampInterface(source.ceilingM, sourceDepth),
      sootG: Math.max(0, source.sootG - soot),
      fuelKg: Math.max(0, source.fuelKg - fuel),
    },
    dest: {
      ...dest,
      interfaceM: clampInterface(dest.ceilingM, destDepth),
      upperK: destTemp,
      sootG: dest.sootG + soot,
      fuelKg: dest.fuelKg + fuel,
      upperO2: Math.min(1, Math.max(0, destO2)),
    },
    movedKg: moved,
  };
}
