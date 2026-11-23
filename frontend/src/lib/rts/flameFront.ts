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
 * Growth is Q = α t² (seed `t2_alpha_classes`). A solid, light or heavy,
 * then stops at 250 kW/m² of contents. A liquid caps at the pool fire on
 * its pan, NUREG-1805 Eq. 3-2 (seed `pool_fire_hrr`). After a spray opens
 * on solid fuel it can reach, that release decays as
 * Q(t) = Q(t_act) exp(−(t − t_act) / τ) (seed `sprinkler_suppression_decay`).
 * A pressurised gas jet is not decayed. A water sprinkler does not decay
 * cooking oil. Wet chemical on oil uses the same τ, and that use is assumed.
 *
 * The visible front is the room-scale speed on the entry, in metres per
 * minute (seed `flame_spread_rates`). Surface spread of a thick solid is the
 * lower bound, about 0.06 m/min, and is not what is drawn.
 *
 * Varying flux adds dt / t_ig. That sum is assumed; the formula is sourced.
 * The dose holds when q falls back under CHF. It does not decay.
 */

/** Gases a confirmed material can put into the smoke. The trainer does not pick these. */
export const TOXIC_PRODUCTS = ['CO', 'HCN', 'HCl', 'acrolein'] as const;
export type ToxicProduct = (typeof TOXIC_PRODUCTS)[number];
/** Grams of gas per gram of fuel burned. Every library value is assumed. */
export type ToxicYields = Partial<Record<ToxicProduct, number>>;

export interface FuelCell {
  category: 'light' | 'heavy';
  chfKwM2: number;
  trp: number;
  alphaKwS2: number;
  spreadMPerMin: number;
  fuelLoadKgM2: number;
  liquidPool: boolean;
  /** Liquid surface, m². Absent on a solid. */
  poolAreaM2?: number;
  /**
   * Grams of each gas per gram burned. Copied from the confirmed entry.
   * Absent on a cell that has no yield. The fire reads this only while the
   * cell is burning.
   */
  toxicYieldGPerG?: ToxicYields;
}

/** C/VM2 radiative fraction for building contents. */
export const RADIATIVE_FRACTION = 0.35;

/**
 * Assumed standoff. The point-source formula is unbounded at R = 0, so the
 * burning stud itself is read at half a metre.
 */
export const FLAME_STANDOFF_M = 0.5;

/**
 * Heat release per unit area for ordinary contents. EN 1991-1-2:2002 Annex E
 * Table E.5 gives 250 kW/m² for office, retail, and shopping centres, and
 * that is the figure the spread seed stores. A solid, light or heavy, does
 * not grow past this times the stud area. Shopping centres in that table
 * are also the fast t-squared class, which is the heavy α already in use.
 */
export const CONTENTS_HRRPUA_KW_M2 = 250;

/**
 * Room heat release at which a compartment flashes over.
 *
 * Babrauskas, NUREG-1805 Eq. 13-3 (seed `flashover_hrr_babrauskas`):
 * Q_fo = 750 Ao √Ho. The seed's 0.9 by 2.0 m door in a 4 by 5 by 2.6 m room
 * is 1909 kW. Thomas, Eq. 13-4 (seed `flashover_hrr_thomas`), is 1625 kW for
 * that room. MQH, Eq. 13-2 (seed `flashover_hrr_mqh`), is 2366 kW.
 * Peacock and others, 1999, put flashover at a 20 kW/m² floor flux from the
 * hot layer. That is not the flux one stud reads off its own flame.
 *
 * Assumed floor: 1 MW. The grid has no vent size per room, and a megawatt is
 * the low end of those worked examples. Sum the burning fuel in the room.
 * At that sum a room of at most FLASHOVER_MAX_AREA_M2 ignites its fuelled
 * studs, and the barrier timers start. The seed's t_e scaling is not used.
 */
export const FLASHOVER_ROOM_KW = 1000;

/**
 * EN 1991-1-2:2002 Annex A limits a parametric compartment fire to 500 m²
 * of floor and 4 m of height. Above that, the space is a travelling fire
 * (Stern-Gottfried and Rein, 2012): the front and the flux carry it, and
 * the whole floor does not ignite in one step. Floor area here is the
 * stud count times STUD_AREA_M2.
 */
export const FLASHOVER_MAX_AREA_M2 = 500;

/**
 * Radius of a 500 m² disc, about 12.6 m. Assumed. In a room above the area
 * limit, a barrier starts its rating when the burning fuel within this
 * distance of the source stud sums to the 1 MW floor. The grid has no
 * resolved hot layer, so the disc stands in for that local region.
 */
export const LOCAL_FLASHOVER_RADIUS_M = Math.sqrt(FLASHOVER_MAX_AREA_M2 / Math.PI);

/**
 * Assumed. One stud on the 3 m grid stands for 9 m² when a fuel load is
 * turned into a fire on that stud. A liquid does not burn on that whole patch.
 */
export const STUD_AREA_M2 = 9;

/**
 * Assumed pan. A fryer's oil surface is well under a square metre, and the
 * library has no measured area, so each liquid cell burns as 0.3 m².
 */
export const FRYER_POOL_AREA_M2 = 0.3;

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

/** Pool fire on `areaM2`. The default is one assumed pan, not the 9 m² stud. */
export function poolFireKw(areaM2: number = FRYER_POOL_AREA_M2): number {
  if (!(areaM2 > 0)) return 0;
  const diameter = Math.sqrt((4 * areaM2) / Math.PI);
  return poolFireKwFromDiameter(
    diameter,
    COOKING_OIL_POOL.mFluxKgM2S,
    COOKING_OIL_POOL.dHcKjKg,
    COOKING_OIL_POOL.kBetaPerM,
  );
}

/**
 * The highest Q this cell is allowed. A solid uses the 250 kW/m² contents
 * cap, light or heavy. A liquid uses its pan. Null means the t-squared
 * curve is not capped.
 */
function releaseCapKw(cell: FuelCell, areaM2: number): number | null {
  let cap: number | null = null;
  if (!cell.liquidPool) {
    const contents = CONTENTS_HRRPUA_KW_M2 * areaM2;
    if (contents > 0) cap = contents;
  }
  if (cell.liquidPool) {
    const pool = poolFireKw(cell.poolAreaM2 ?? FRYER_POOL_AREA_M2);
    if (pool > 0) cap = cap == null ? pool : Math.min(cap, pool);
  }
  return cap;
}

/** α t², then the contents cap or the pan, whichever applies. */
export function heatReleaseKw(cell: FuelCell, ageSec: number, areaM2: number = STUD_AREA_M2): number {
  const growing = tSquaredKw(cell.alphaKwS2, ageSec);
  const cap = releaseCapKw(cell, areaM2);
  if (cap == null || !(cap > 0)) return growing;
  return Math.min(growing, cap);
}

/**
 * Seconds until the fuel load is spent. A solid integrates α t² until the
 * contents cap, then holds that cap. A liquid does the same up to its pan.
 * The heat of combustion is the wood stand-in or the transformer-oil row.
 */
export function burnoutSec(cell: FuelCell, areaM2: number = STUD_AREA_M2): number {
  const dHc = cell.liquidPool ? COOKING_OIL_POOL.dHcKjKg : WOOD_HEAT_KJ_KG;
  const energyKj = cell.fuelLoadKgM2 * areaM2 * dHc;
  const alpha = cell.alphaKwS2;
  if (!(energyKj > 0) || !(alpha > 0)) return 300;
  const uncapped = Math.cbrt((3 * energyKj) / alpha);
  const cap = releaseCapKw(cell, areaM2);
  if (cap == null || !(cap > 0)) return uncapped;
  const tCap = Math.sqrt(cap / alpha);
  const energyAtCap = (alpha * tCap ** 3) / 3;
  if (energyAtCap >= energyKj) return uncapped;
  return tCap + (energyKj - energyAtCap) / cap;
}

/**
 * Age at which one cell, alone, reaches the room flashover floor.
 * Null when its cap stays under that floor, so one pan never flashes a room.
 */
export function flashoverAgeSec(cell: FuelCell, areaM2: number = STUD_AREA_M2): number | null {
  if (!(cell.alphaKwS2 > 0) || !(FLASHOVER_ROOM_KW > 0)) return null;
  const cap = releaseCapKw(cell, areaM2);
  if (cap != null && cap < FLASHOVER_ROOM_KW) return null;
  return Math.sqrt(FLASHOVER_ROOM_KW / cell.alphaKwS2);
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

/**
 * Overpressure that opens a pressurised-gas object.
 *
 * Clancey (1972), as tabulated in IOGP Report 434-15 Table 2.8
 * (seed `clancey_damage_table`): 20.7–27.6 kPa is "Frameless, self-framing
 * steel panel building demolished; rupture of oil storage tanks". The onset
 * of that band is 20.7 kPa. The seed lists the table as incident overpressure.
 *
 * That row is a storage tank, not a building gas pipe. The seeds have no
 * pipe-failure pressure, so this onset is the cited figure applied to a
 * confirmed gas line. Compare it with incident overpressure (`psKpa`), the
 * measure the table is written in. Reflected pressure is for injuries.
 */
export const GAS_RUPTURE_KPA = 20.7;

/**
 * Assumed cap for one open building gas supply after the line ruptures.
 * It does not grow with time. The jet only heats nearby fuel through the
 * point-source flux, and it is not added to the room-heat sum.
 *
 * An orifice estimate for a full-bore break of a low-pressure natural-gas
 * service (about 2 kPa gauge) is roughly 0.8 MW at 25 mm and 3 MW at 50 mm.
 * Medium-pressure supplies can reach 10 MW. 8000 kW is the upper end of that
 * span, kept so one stud of light fuel still sits above its critical flux.
 *
 * The flux uses the shared radiative fraction 0.35. A natural-gas jet flame
 * is nearer 0.2, so this flux is about one and a half times a jet-specific
 * fraction. The jet stays on the same fraction as the flame front.
 *
 * Kept out of the room sum on purpose. Counting 8 MW against the 1 MW
 * flashover floor would light the stall in one step and skip the flux path.
 * An open stall front about 6 m by 2.5 m can vent on the order of 18 MW
 * (750·A₀·√H₀), so this jet would not flash that opening. One kitchen door
 * is nearer 1.9 MW and would. Rooms have no vent-based flashover threshold
 * yet, so the jet stays a local flux only.
 *
 * At 3 m, one stud away, the flux is about 25 kW/m², so red oak reaches
 * t_ig in about 65 s. At 6 m the flux is under the 10 kW/m² critical flux,
 * so the jet does not cross the court.
 */
export const GAS_JET_KW = 8000;

/**
 * How far a jet or an arc is worth scanning. Past this, the capped jet is
 * far under the critical flux, so a stud cannot ignite from it.
 */
export const GAS_JET_REACH_M = 12;

/**
 * Assumed arc flux at the flame standoff. 20 kW/m² is the NUREG red-oak
 * worked example, t_ig 141 s. There is no arc-flux row. The equivalent
 * point source is that flux at FLAME_STANDOFF_M. At 3 m the flux is under
 * the critical flux, so an arc does not spread across a stud.
 */
export const ELECTRICAL_ARC_FLUX_KW_M2 = 20;

/** One stud. An arc lights a ruptured line this close, and not the next one. */
export const ELECTRICAL_IGNITE_M = 3;

/**
 * Assumed incident overpressure that faults an appliance so it arcs.
 * There is no equipment-damage row. It is not the 20.7 kPa tank figure.
 * An appliance inside the fireball radius is also faulted, below this
 * pressure. A working fitting does not arc.
 */
export const ELECTRICAL_DAMAGE_KPA = 30;

/**
 * Assumed time a faulted arc burns unless someone shuts the power off
 * sooner. Longer than the 141 s red-oak t_ig at the standoff, so fuel on
 * the appliance's own stud can still catch.
 */
export const ELECTRICAL_ARC_SEC = 180;

/** Point-source heat release that delivers the arc flux at the standoff. */
export function electricalHeatReleaseKw(
  fluxKwM2 = ELECTRICAL_ARC_FLUX_KW_M2,
  standoffM = FLAME_STANDOFF_M,
): number {
  if (!(fluxKwM2 > 0) || !(standoffM > 0)) return 0;
  return (fluxKwM2 * 4 * Math.PI * standoffM * standoffM) / RADIATIVE_FRACTION;
}

/**
 * Sprinkler and kitchen-hood links. One behaviour, two parameter sets.
 *
 * The ceiling jet is Alpert's dimensional correlation, NUREG-1805 Eq. 10-3
 * to 10-6 (seed `alpert_ceiling_jet_dimensional`). Q is kW, H is metres
 * from the fire to the ceiling, r is metres along the ceiling. The fit was
 * made on fires from 668 kW to 98 MW. A smaller fire still uses the same
 * equations; that is outside the fit.
 *
 * The link is the RTI equation, CFAST Eq. 6.1 and the steady form NUREG-1805
 * Eq. 10-2 (seed `sprinkler_activation`):
 * dT_L/dt = √u / RTI · (T_g − T_L). The C-factor is ignored, as in the
 * worked example. Ambient is 20 °C. A sprinkler opens at 68 °C, the
 * temperature in that example. A hood's 68 °C is assumed.
 *
 * A ceiling sprinkler uses RTI 50 (m·s)^½, the C/VM2 quick-response value
 * in the worked example. A kitchen wet-chemical head uses RTI 135, the
 * C/VM2 standard-response value named next to it in `sprinkler_rti_generic`.
 * The seeds have no hood-link temperature. 68 °C on a hood is assumed.
 *
 * A sprinkler link sits in the ceiling jet. H is the storey height, or 3 m
 * when the building does not say. A hood link sits over the appliance, so
 * its H is an assumed 1.1 m and not the storey height. r is the plan
 * distance. A hood on the appliance stud is the r = 0 branch.
 *
 * Decay uses the NIST IR 5254 bound, τ = 435 s, for solid fuel. The crib
 * fit at 0.07 mm/s is 410 s; 435 s is the bound the spec quotes. A gas jet
 * keeps burning at the release its supply feeds until the valve closes.
 * NIST IR 5254 does not describe that jet, and it does not describe water
 * on a deep-fat fryer. Wet chemical on oil still uses τ, as an assumed
 * stand-in: the agent saponifies the oil, and the seeds have no oil row.
 *
 * NFPA 17A and NFPA 96 require a cooking-equipment extinguishing system, on
 * discharge, to shut off the fuel and the electric power that heat the
 * equipment it protects. The fittings inside this head's throw are that
 * set. The throw itself is assumed. A sprinkler does not shut them off.
 *
 * The throw, 4.5 m, is assumed. A 6 m stall's corner is 4.24 m from its
 * centre, so a head on a stud in the stall reaches that stall and not the
 * next stall's centre. A wall still blocks the spray.
 *
 * Wet footing is assumed. The movement seeds have no wet-floor speed.
 * Walking speed on a sprayed stud is multiplied by 0.75.
 *
 * While a spray is open, the flux used for t_ig on a stud it reaches is
 * held at that stud's critical flux, so the dose does not advance. Holding
 * it exactly at the critical flux is assumed. The decay formula is the
 * sourced part.
 */

/** C/VM2 quick-response RTI, the worked example. (m·s)^½. */
export const SPRINKLER_RTI = 50;

/** C/VM2 standard-response RTI, from the note on `sprinkler_rti_generic`. */
export const WET_CHEMICAL_RTI = 135;

/** Link opens at this gas temperature. The worked example, °C. */
export const SPRINKLER_ACT_C = 68;

/**
 * Assumed hood-link temperature, °C. The seeds have no fusible-link rating
 * for a kitchen hood, so this reuses the sprinkler example and is labelled
 * assumed. It is not a measured hood link.
 */
export const HOOD_LINK_C = 68;

/** Room temperature in the worked example, °C. */
export const SPRINKLER_AMBIENT_C = 20;

/**
 * NIST IR 5254 bound on the heat-release decay of solid fuel, seconds.
 * Q(t) = Q(t_act) exp(−(t − t_act) / τ). The crib value at 0.07 mm/s is
 * about 410 s. Using this τ for cooking oil under wet chemical is assumed.
 */
export const SUPPRESSION_TAU_S = 435;

/**
 * Assumed spray radius, metres. Covers a 6 m stall from a head inside it
 * and stops short of the next stall's centre. A wall blocks it anyway.
 */
export const SUPPRESSION_REACH_M = 4.5;

/**
 * Assumed ceiling height when the storey does not say. The worked example
 * is 3 m. A saved storey height is used instead, as fire-to-ceiling.
 * A wet-chemical hood does not use this. Its link is HOOD_HEIGHT_M.
 */
export const SPRINKLER_CEILING_M = 3;

/**
 * Assumed height of a wet-chemical link above the cooking surface, metres.
 * A hood's detectors sit about a metre over the appliance, not at the
 * storey ceiling. 1.1 m is that assumption. The plan distance is still r,
 * so a hood on the appliance stud uses Alpert's r = 0 branch.
 */
export const HOOD_HEIGHT_M = 1.1;

/**
 * Assumed walking-speed factor on a floor the spray has wetted.
 * No wet-floor row exists in the movement seeds.
 */
export const WET_FLOOR_SPEED = 0.75;

/**
 * Link samples of a growing fire, seconds. The steady equation is exact
 * for a constant jet, so the step size does not matter then. A growing
 * fire is sampled on this grid, and a short remainder uses the same
 * equation, so 0.1 s and 1 s steps agree.
 */
export const LINK_QUANTUM_S = 0.1;

export interface CeilingJet {
  /** Temperature rise of the jet above ambient, K. */
  riseK: number;
  /** Ceiling-jet speed, m/s. */
  speedMps: number;
}

/** Alpert, NUREG-1805 Eq. 10-3 to 10-6. Zero when there is no fire. */
export function ceilingJet(heatKw: number, ceilingM: number, radiusM: number): CeilingJet {
  if (!(heatKw > 0) || !(ceilingM > 0)) return { riseK: 0, speedMps: 0 };
  const r = Math.max(0, radiusM);
  const rOverH = r / ceilingM;
  const q23 = heatKw ** (2 / 3);
  const q13 = heatKw ** (1 / 3);
  const riseK =
    rOverH <= 0.18
      ? (16.9 * q23) / ceilingM ** (5 / 3)
      : (5.38 * (heatKw / Math.max(r, 1e-6)) ** (2 / 3)) / ceilingM;
  const speedMps =
    rOverH <= 0.15
      ? 0.96 * (heatKw / ceilingM) ** (1 / 3)
      : (0.195 * q13 * Math.sqrt(ceilingM)) / Math.max(r, 1e-6) ** (5 / 6);
  return {
    riseK: Number.isFinite(riseK) && riseK > 0 ? riseK : 0,
    speedMps: Number.isFinite(speedMps) && speedMps > 0 ? speedMps : 0,
  };
}

/**
 * One step of the RTI equation. Exact while the jet temperature and speed
 * stay constant through `dt`. A still jet (u = 0) does not move the link.
 */
export function linkTemperatureC(
  linkC: number,
  gasC: number,
  speedMps: number,
  rti: number,
  dt: number,
): number {
  if (!(dt > 0) || !(rti > 0) || !(speedMps > 0)) return linkC;
  const k = Math.sqrt(speedMps) / rti;
  return gasC - (gasC - linkC) * Math.exp(-k * dt);
}

/**
 * Seconds for a steady jet to bring the link from `linkC` to `actC`.
 * Null when the jet is cooler than the link's opening temperature, or still.
 * NUREG-1805 Eq. 10-2.
 */
export function steadyActivationSec(
  linkC: number,
  gasC: number,
  speedMps: number,
  rti: number,
  actC = SPRINKLER_ACT_C,
): number | null {
  if (!(rti > 0) || !(speedMps > 0) || !(gasC > actC)) return null;
  const span = gasC - linkC;
  const remain = gasC - actC;
  if (!(span > 0) || !(remain > 0)) return 0;
  if (span <= remain) return 0;
  return (rti / Math.sqrt(speedMps)) * Math.log(span / remain);
}

/**
 * One slice of the link. Exact for a constant jet over `dt`. `openedAt` is
 * seconds into the slice when the link reaches 68 °C, or null when it does
 * not open in this slice. A still jet leaves the link where it is.
 */
export function advanceSprinklerLink(
  linkC: number,
  gasC: number,
  speedMps: number,
  rti: number,
  dt: number,
  actC = SPRINKLER_ACT_C,
): { linkC: number; openedAt: number | null } {
  if (!(dt > 0) || !(rti > 0) || !(speedMps > 0)) return { linkC, openedAt: null };
  const hit = steadyActivationSec(linkC, gasC, speedMps, rti, actC);
  if (hit != null && hit <= dt + 1e-9) {
    return { linkC: actC, openedAt: Math.max(0, Math.min(hit, dt)) };
  }
  return { linkC: linkTemperatureC(linkC, gasC, speedMps, rti, dt), openedAt: null };
}

/** Q(t_act) exp(−age / τ). Age 0 is the release at the moment the spray opens. */
export function suppressedHeatKw(qActKw: number, ageSec: number, tauS = SUPPRESSION_TAU_S): number {
  if (!(qActKw > 0)) return 0;
  if (!(ageSec > 0) || !(tauS > 0)) return qActKw;
  return qActKw * Math.exp(-ageSec / tauS);
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
