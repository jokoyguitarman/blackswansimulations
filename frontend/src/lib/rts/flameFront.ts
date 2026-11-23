/**
 * Flame-front numbers for a confirmed light or heavy entry.
 *
 * Ignition time is NUREG-1805 Eq. 6-2 (seed `ignition_time_thick`):
 * t_ig = (π/4) (TRP / (q − CHF))² while q is above CHF. Below CHF it never
 * ignites. Worked example: red oak at 20 kW/m² is 141 s, at 12.5 is 2256 s,
 * at 9 never.
 *
 * Flux is NUREG-1805 Eq. 5-1 (seed `point_source_radiation`):
 * q = χ_r Q / (4 π R²). χ_r is 0.35, the C/VM2 radiative fraction for
 * building contents. Worked example: Q 2000 kW at 4 m is 3.482 kW/m².
 *
 * Growth is Q = α t² (seed `t2_alpha_classes`). A liquid caps that at the
 * pool fire, NUREG-1805 Eq. 3-2 (seed `pool_fire_hrr`). Suppression does not
 * cut Q yet.
 *
 * The visible front is the room-scale speed on the entry, in metres per
 * minute (seed `flame_spread_rates`). Surface spread of a thick solid is the
 * lower bound, about 0.06 m/min, and is not what is drawn.
 *
 * Varying flux adds dt / t_ig. That sum is assumed; the formula is sourced.
 * The dose holds when q falls back under CHF. It does not decay.
 */

export interface FuelCell {
  category: 'light' | 'heavy';
  chfKwM2: number;
  trp: number;
  alphaKwS2: number;
  spreadMPerMin: number;
  fuelLoadKgM2: number;
  liquidPool: boolean;
}

/** C/VM2 radiative fraction for building contents. */
export const RADIATIVE_FRACTION = 0.35;

/**
 * Assumed standoff. The point-source formula is unbounded at R = 0, so the
 * burning stud itself is read at half a metre.
 */
export const FLAME_STANDOFF_M = 0.5;

/**
 * Floor flux at flashover. Peacock and others, 1999, the criterion noted in
 * the living-world fire section. Assumed choice: the spread seed says the
 * wall timer starts at flashover and does not give this threshold. The seed's
 * t_e scaling is not used.
 */
export const FLASHOVER_KW_M2 = 20;

/**
 * Assumed. One stud on the 3 m grid stands for 9 m² when a fuel load or a
 * pool is turned into a fire on that stud.
 */
export const STUD_AREA_M2 = 9;

/**
 * Assumed heat of combustion for light fuel. The pool table has no wood row.
 * 17.5 MJ/kg is a dry-wood figure used as that stand-in.
 */
export const WOOD_HEAT_KJ_KG = 17500;

/**
 * Transformer oil from the pool-fire row (0.039 kg/m²s, 46,400 kJ/kg, kβ 0.7).
 * Assumed stand-in for cooking oil. Diesel-like fuel oil is the other close row.
 */
export const COOKING_OIL_POOL = {
  mFluxKgM2S: 0.039,
  dHcKjKg: 46400,
  kBetaPerM: 0.7,
} as const;

/**
 * The drawn fireball lasts 3 s. Assumed: the blast's thermal pulse is that
 * long, and its heat release is set so red oak at the ignition radius reaches
 * t_ig as the pulse ends. The pulse is integrated when the blast event fires.
 */
export const FIREBALL_PULSE_S = 3;

/** NUREG-1805 Eq. 6-2. Null when q is at or below CHF, or TRP is missing. */
export function ignitionTimeSec(qKwM2: number, chfKwM2: number, trp: number): number | null {
  if (!(qKwM2 > chfKwM2) || !(trp > 0)) return null;
  const ratio = trp / (qKwM2 - chfKwM2);
  return (Math.PI / 4) * ratio * ratio;
}

/** Add dt / t_ig. Below CHF the dose is unchanged. */
export function addIgnitionDose(
  dose: number,
  qKwM2: number,
  chfKwM2: number,
  trp: number,
  dt: number,
): number {
  const tig = ignitionTimeSec(qKwM2, chfKwM2, trp);
  if (tig == null || !(tig > 0) || !(dt > 0)) return dose;
  return dose + dt / tig;
}

/** NUREG-1805 Eq. 5-1. */
export function pointSourceFluxKwM2(
  heatReleaseKw: number,
  radiusM: number,
  chi: number = RADIATIVE_FRACTION,
): number {
  if (!(heatReleaseKw > 0) || !(radiusM > 0) || !(chi > 0)) return 0;
  return (chi * heatReleaseKw) / (4 * Math.PI * radiusM * radiusM);
}

/** Q = α t². Seed worked example: fast α at 120 s is 675.4 kW. */
export function tSquaredKw(alphaKwS2: number, ageSec: number): number {
  if (!(alphaKwS2 > 0) || !(ageSec > 0)) return 0;
  return alphaKwS2 * ageSec * ageSec;
}

/** NUREG-1805 Eq. 3-2 for a circular pool of diameter D. */
export function poolFireKwFromDiameter(
  diameterM: number,
  mFluxKgM2S: number,
  dHcKjKg: number,
  kBetaPerM: number,
): number {
  if (!(diameterM > 0) || !(mFluxKgM2S > 0) || !(dHcKjKg > 0)) return 0;
  const area = Math.PI * (diameterM / 2) ** 2;
  const kBeta = kBetaPerM > 0 ? kBetaPerM : 0;
  return mFluxKgM2S * dHcKjKg * area * (1 - Math.exp(-kBeta * diameterM));
}

/** Pool fire on a stud-sized patch. The area is the stud, not a measured pan. */
export function poolFireKw(areaM2: number = STUD_AREA_M2): number {
  if (!(areaM2 > 0)) return 0;
  const diameter = Math.sqrt((4 * areaM2) / Math.PI);
  return poolFireKwFromDiameter(
    diameter,
    COOKING_OIL_POOL.mFluxKgM2S,
    COOKING_OIL_POOL.dHcKjKg,
    COOKING_OIL_POOL.kBetaPerM,
  );
}

/** α t², capped by the pool formula when the entry is a liquid. */
export function heatReleaseKw(cell: FuelCell, ageSec: number, areaM2: number = STUD_AREA_M2): number {
  const growing = tSquaredKw(cell.alphaKwS2, ageSec);
  if (!cell.liquidPool) return growing;
  const cap = poolFireKw(areaM2);
  if (!(cap > 0)) return growing;
  return Math.min(growing, cap);
}

/**
 * Seconds until the fuel load is spent. Light fuel integrates α t².
 * A liquid integrates α t² until the pool cap, then holds that cap.
 * The heat of combustion is the wood stand-in or the transformer-oil row.
 */
export function burnoutSec(cell: FuelCell, areaM2: number = STUD_AREA_M2): number {
  const dHc = cell.liquidPool ? COOKING_OIL_POOL.dHcKjKg : WOOD_HEAT_KJ_KG;
  const energyKj = cell.fuelLoadKgM2 * areaM2 * dHc;
  const alpha = cell.alphaKwS2;
  if (!(energyKj > 0) || !(alpha > 0)) return 300;
  const uncapped = Math.cbrt((3 * energyKj) / alpha);
  if (!cell.liquidPool) return uncapped;
  const cap = poolFireKw(areaM2);
  if (!(cap > 0)) return uncapped;
  const tCap = Math.sqrt(cap / alpha);
  const energyAtCap = (alpha * tCap ** 3) / 3;
  if (energyAtCap >= energyKj) return uncapped;
  return tCap + (energyKj - energyAtCap) / cap;
}

/** Age at which the stud's own flux reaches the flashover criterion. */
export function flashoverAgeSec(cell: FuelCell, areaM2: number = STUD_AREA_M2): number | null {
  const heatNeeded =
    (FLASHOVER_KW_M2 * 4 * Math.PI * FLAME_STANDOFF_M ** 2) / RADIATIVE_FRACTION;
  if (!(cell.alphaKwS2 > 0) || !(heatNeeded > 0)) return null;
  if (cell.liquidPool) {
    const cap = poolFireKw(areaM2);
    if (cap > 0 && heatNeeded > cap) return null;
  }
  return Math.sqrt(heatNeeded / cell.alphaKwS2);
}

/** Metres per second from the entry's room-scale speed. */
export function frontSpeedMps(spreadMPerMin: number): number {
  if (!(spreadMPerMin > 0)) return 0;
  return spreadMPerMin / 60;
}

/**
 * Flux at `distanceM` from a blast whose ignition radius is `radiusM`.
 * Zero outside that radius. At the radius, red oak's t_ig equals the pulse.
 */
export function fireballFluxKwM2(distanceM: number, radiusM: number): number {
  if (!(radiusM > 0) || distanceM > radiusM) return 0;
  const edge = fireballEdgeFluxKwM2();
  const r = Math.max(distanceM, FLAME_STANDOFF_M);
  return edge * (radiusM / r) ** 2;
}

/** Red-oak flux that finishes t_ig in one fireball pulse. */
export function fireballEdgeFluxKwM2(
  chfKwM2 = 10,
  trp = 134,
  pulseS = FIREBALL_PULSE_S,
): number {
  const denom = Math.sqrt(pulseS / (Math.PI / 4));
  if (!(denom > 0)) return chfKwM2;
  return chfKwM2 + trp / denom;
}
