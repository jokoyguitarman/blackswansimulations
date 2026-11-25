/**
 * Two-zone layer for one ceiling-bounded space.
 *
 * The hot layer is the CFAST control volume: plume mass in (Heskestad,
 * CFAST Technical Reference, Eq. 3.15 and 3.17; seed
 * `heskestad_plume_entrainment`), vent mass out (orifice slices, CFAST
 * Eq. 4.1–4.5, C = 0.7; seed `vent_flow_orifice`). The linings take heat
 * through a surface film and then the slab: convection is CFAST Technical
 * Reference Eq. 5.23, radiation is the grey exchange, and the slab is
 * NUREG-1805 Eq. 2-2 to 2-5 (seed `mqh_hot_layer_temperature`). The film
 * and the slab are in series. hk on its own is the conduction coefficient,
 * not the loss from the gas. Once the slab is thermally thin, the back
 * face is CFAST's exterior film (the default boundary, ambient air), not
 * a face held at the initial temperature.
 * The lower layer stays at the ambient 293 K. That is the usual
 * pre-flashover assumption. The inverse door jet (CFAST TN 1889v1
 * Eq. 4.7) was tried and left out: at the Steckler interface it entrains
 * about 0.005 kg/s, and with the interface on the floor it over-entrains
 * and drops the enthalpy and the soot it would move. Mixing into the
 * lower layer is not in this step.
 *
 * Gas that leaves through a vent is not mixed back into this room. The
 * part that left the upper layer (the orifice slice whose midpoint is
 * above the interface) is returned as a door jet. The caller deposits
 * that mass in the neighbouring room's upper layer: enthalpy
 * m cp (T_jet − T), and the interface falls by m / (ρ(T_jet) A). That is
 * the vent flow of Eq. 4.1–4.5 changing rooms, not Eq. 4.7.
 *
 * A layer is kept only where that balance can hold a reservoir: smoke
 * deeper than a ceiling jet, hotter than a distinct-layer rise, and a spill
 * edge below the ceiling (a door head, or no opening at all). The jet
 * thickness is 12% of the ceiling height, the top of the 5–12% band Evans
 * gives for the ceiling jet in the SFPE Handbook. The 20 K rise is about a
 * 7% density difference. Both numbers are assumed. A space whose only
 * openings reach the ceiling has no spill edge, so it stays a travelling
 * front even when the balance is warm. A fire under 1 kW is not a plume;
 * that cutoff is assumed.
 *
 * The steady temperature is compared with the MQH correlation,
 * NUREG-1805 Eq. 2-1, ΔT = 6.85 [Q² / (Ao √Ho · AT hk)]^(1/3). CFAST
 * Technical Reference Eq. 3.9–3.10 split the fire into χQ radiated to the
 * surfaces and (1 − χ)Q convected into the gas. The radiated part is shared
 * across the boundaries by area. It does not heat the gas. Only the
 * convected part entrains. χ is the contents radiative fraction already
 * used for the point source. The gas-to-surface radiation still treats the
 * gas as black; a clear layer would radiate less, and that is not in this step.
 */

import { LEVEL } from '../evacuation/levelConstants';
import { doorOpenFraction } from './doorLeaf';
import { CONTENTS_HRRPUA_KW_M2, RADIATIVE_FRACTION, STUD_AREA_M2 } from './flameFront';
import { GLASS_FALLOUT_AREA_FRACTION } from './liningFire';
import { layerLiningFor, type WallMaterial } from './materialLibrary';

/** 20 °C, the ambient the sprinkler link and the gas molar volume already use. */
export const AMBIENT_K = 293;
const CP_KJ_KGK = 1;
/** ρ T, so a hot gas is 353 / T. The same identity as the shaft vent. */
const RHO_T = 353;
const HK_FLOOR_S = 1;

/**
 * Standing head height, metres. Assumed. The layer smokes a stud only when
 * the interface has come down to this height. The old column mixed the
 * whole storey, so a high interface now leaves the head in clear air.
 */
export const HEAD_HEIGHT_M = 1.7;

/**
 * Door head when a wall does not carry one. Assumed from the 2.0 m door in
 * the NUREG MQH worked example. A door that would be taller than the
 * storey is an opening to the ceiling.
 */
export const DOOR_SOFFIT_M = 2;

/**
 * A soffit this close to the ceiling is not a spill edge. Assumed. The same
 * gap decides that a door which would be taller than the storey is an
 * opening to the ceiling.
 */
export const RESERVOIR_SOFFIT_GAP_M = 0.05;

/** Assumed. Evans's ceiling-jet thickness is about 5–12% of the ceiling height. */
export const CEILING_JET_DEPTH_FRACTION = 0.12;

/**
 * Assumed. Once a layer exists it stays until the steady depth falls below
 * half the jet thickness, or the rise falls below half the distinct-layer
 * rise, so a small wobble in the fire does not blink it. Losing the spill
 * edge drops it at once.
 */
export const LAYER_OFF_FRACTION = 0.5;

/** Assumed. Below this there is no plume to fill a layer. */
export const MIN_LAYER_FIRE_KW = 1;

/**
 * Assumed. A balance cooler than this is not a distinct hot layer: the
 * heat has been spread over too much surface, which is an open hall. The
 * smoke there stays on the travelling front. 20 K is about a 7% density
 * difference.
 */
export const DISTINCT_LAYER_RISE_K = 20;

export interface Lining {
  name: string;
  /** kW/m·K */
  kKwMK: number;
  rhoKgM3: number;
  /** kJ/kg·K */
  cKjKgK: number;
  thicknessM: number;
}

/**
 * The layer's copy of a wall row. `WALL_MATERIALS` stores W/m·K and J/kg·K.
 * hk is in kW, so both are divided by 1000. Which rows conduct as themselves
 * stays in `layerLiningFor`.
 */
function liningOf(row: WallMaterial): Lining {
  return {
    name: row.id,
    kKwMK: row.conductivityWMK / 1000,
    rhoKgM3: row.densityKgM3,
    cKjKgK: row.specificHeatJKgK / 1000,
    thicknessM: row.thicknessM,
  };
}

/** Concrete, brick, and gypsum, the inert rows `layerLiningFor` names. */
export const LINING = {
  concrete: liningOf(layerLiningFor('concrete')),
  brick: liningOf(layerLiningFor('brick')),
  gypsum: liningOf(layerLiningFor('gypsum')),
} as const satisfies Record<string, Lining>;

/**
 * The lining a named wall conducts into. Timber and glass use their own
 * rows. Steel and an unnamed finish come back as concrete.
 */
export function liningForMaterial(material: string): Lining {
  return liningOf(layerLiningFor(material));
}

export function thermalInertia(lining: Lining): number {
  return lining.kKwMK * lining.rhoKgM3 * lining.cKjKgK;
}

/** NUREG Eq. 2-5. tp = (ρ c / k) (δ/2)². */
export function penetrationTimeS(lining: Lining): number {
  const half = lining.thicknessM / 2;
  return ((lining.rhoKgM3 * lining.cKjKgK) / lining.kKwMK) * half * half;
}

/**
 * Conduction coefficient, kW/m²K. Thick: √(kρc / t). Thin, after the
 * penetration time: k / δ. The 1 s floor only keeps the square root finite.
 * While the wall is thick this is the semi-infinite slab, and the back
 * face has not been reached. Once it is thin, k / δ is the conduction
 * resistance. An isothermal sheet then loses heat from the back face
 * through the exterior film. A board keeps k / δ to ambient.
 */
export function effectiveHeatLossKwM2K(lining: Lining, tS: number): number {
  const t = Math.max(tS, HK_FLOOR_S);
  const thick = Math.sqrt(thermalInertia(lining) / t);
  const thin = lining.kKwMK / lining.thicknessM;
  return t < penetrationTimeS(lining) ? thick : thin;
}

/**
 * A sheet is isothermal when the Biot number is under 0.1: the drop
 * across the thickness is under a tenth of the drop across the film
 * (Incropera, the lumped-capacitance limit). k/δ is then at least ten
 * times the exterior radiation coefficient. A back face held at ambient
 * overstates the loss, because the sheet cannot stay cold. A board, where
 * k/δ is the loss, keeps the NUREG thin limit. That limit is what the
 * Steckler blanket uses.
 */
const ISOTHERMAL_BIOT = 0.1;

/** True when a penetrated sheet is thin enough to be isothermal. */
function backFaceExposed(lining: Lining, tS: number): boolean {
  if (Math.max(tS, HK_FLOOR_S) < penetrationTimeS(lining)) return false;
  const kOverD = lining.kKwMK / lining.thicknessM;
  return kOverD >= EXTERIOR_RAD_HK_KW_M2K / ISOTHERMAL_BIOT;
}

/** Stefan–Boltzmann, kW/m²K⁴. */
export const SIGMA_KW_M2K4 = 5.67e-11;

/**
 * 4 σ T³ at ambient, kW/m²K. Radiation to outdoor air cannot be weaker
 * than this, so it is the floor of the exterior film.
 */
const EXTERIOR_RAD_HK_KW_M2K = 4 * SIGMA_KW_M2K4 * AMBIENT_K * AMBIENT_K * AMBIENT_K;

/**
 * CFAST Technical Reference Eq. 5.23, the wall value, in W/m²K per K^{1/3}.
 * The ceiling and floor use 1.52 in that equation. One coefficient for every
 * face is assumed.
 */
export const SURFACE_CONVECTION_C_W = 1.31;

/**
 * Assumed. CFAST treats a surface as grey and notes that ordinary finishes
 * sit in a narrow band. 0.9 is that band, not a measured lining. The gas is
 * taken as black, so a thin or clear layer radiates as much as a smoky one.
 */
export const SURFACE_EMISSIVITY = 0.9;

/**
 * Heat the back face gives to outdoor air, kW/m². CFAST's default wall
 * boundary (iwbound = 3 in cfast_data.f90) is this flux, not a face held
 * at the initial temperature. conduction.f90 adds the same natural
 * convection the interior uses, then σ(T_amb⁴ − T_ext⁴) with no emissivity.
 * One coefficient, the wall value, is used on both faces.
 */
function exteriorFluxKwM2(backK: number): number {
  if (!(backK > AMBIENT_K)) return 0;
  const across = backK - AMBIENT_K;
  const hConv = (SURFACE_CONVECTION_C_W / 1000) * Math.pow(across, 1 / 3);
  const amb4 = AMBIENT_K * AMBIENT_K * AMBIENT_K * AMBIENT_K;
  return hConv * across + SIGMA_KW_M2K4 * (backK * backK * backK * backK - amb4);
}

/**
 * Conduction through a thin sheet, kW/m². `hk` is k/δ. The back temperature
 * is the one where that conduction equals the exterior film.
 */
function sheetThroughKwM2(frontK: number, hk: number): number {
  let lo = AMBIENT_K;
  let hi = Math.max(frontK, AMBIENT_K);
  if (!(hi > lo + 1e-6) || !(hk > 0)) return 0;
  for (let i = 0; i < 24; i++) {
    const backK = 0.5 * (lo + hi);
    const conducted = hk * (frontK - backK);
    if (conducted > exteriorFluxKwM2(backK)) lo = backK;
    else hi = backK;
  }
  return exteriorFluxKwM2(0.5 * (lo + hi));
}

/**
 * Heat the gas gives a lining, kW/m². The fire's χQ arrives at the surface
 * as `radInKwM2` and does not pass through the gas. Convection and the grey
 * exchange then run between the gas and that surface, in series with the
 * slab. A thick slab conducts on toward a back face the heat has not
 * reached, so hk runs to ambient. An isothermal sheet conducts across k/δ
 * and the back face loses heat by the exterior film. A board keeps k/δ
 * to ambient. The returned flux is only the
 * inside film, so the gas is not charged for radiation that never entered it.
 */
function surfaceFluxKwM2(hk: number, gasK: number, radInKwM2: number, exposed: boolean): number {
  if (!(hk > 0)) return 0;
  if (!(gasK > AMBIENT_K + 0.05) && !(radInKwM2 > 0)) return 0;
  // Same film and the same 32 bisections as the closure form. The coefficients
  // are invariant for this gas temperature, so they are read once.
  const convC = SURFACE_CONVECTION_C_W / 1000;
  const sigmaE = SURFACE_EMISSIVITY * SIGMA_KW_M2K4;
  const gas2 = gasK * gasK;
  let lo = AMBIENT_K;
  let hi = Math.max(gasK, AMBIENT_K) + 2000;
  for (let i = 0; i < 32; i++) {
    const surfaceK = 0.5 * (lo + hi);
    const across = gasK - surfaceK;
    // cbrt agrees with pow(x, 1/3) on the sign of this residual across the
    // temperatures the table samples, and the film below still uses pow.
    const hConv = convC * Math.cbrt(Math.abs(across));
    const hRad = sigmaE * (gas2 + surfaceK * surfaceK) * (gasK + surfaceK);
    const intoSlab = exposed ? sheetThroughKwM2(surfaceK, hk) : hk * (surfaceK - AMBIENT_K);
    const residual = (hConv + hRad) * across + radInKwM2 - intoSlab;
    if (residual > 0) lo = surfaceK;
    else hi = surfaceK;
  }
  const surfaceK = 0.5 * (lo + hi);
  const across = gasK - surfaceK;
  const hConv = convC * Math.pow(Math.abs(across), 1 / 3);
  const hRad = sigmaE * (gas2 + surfaceK * surfaceK) * (gasK + surfaceK);
  return (hConv + hRad) * across;
}

const FLUX_TABLE_N = 96;
const FLUX_T_MAX = 1500;

/** One lining at one age and one fire flux. The balance samples it dozens of times. */
function fluxTable(hk: number, radInKwM2: number, exposed: boolean): (gasK: number) => number {
  const ys = new Float64Array(FLUX_TABLE_N + 1);
  const ready = new Uint8Array(FLUX_TABLE_N + 1);
  const span = (FLUX_T_MAX - AMBIENT_K) / FLUX_TABLE_N;
  // Knots the balance never samples stay unsolved. A solved knot matches the
  // full table, so the interpolation is the same.
  const knot = (i: number) => {
    if (ready[i] === 1) return ys[i] ?? 0;
    ready[i] = 1;
    const gas = AMBIENT_K + ((FLUX_T_MAX - AMBIENT_K) * i) / FLUX_TABLE_N;
    const y = surfaceFluxKwM2(hk, gas, radInKwM2, exposed);
    ys[i] = y;
    return y;
  };
  return (gasK: number) => {
    if (!(gasK > AMBIENT_K + 0.05)) return 0;
    const x = (Math.min(gasK, FLUX_T_MAX) - AMBIENT_K) / span;
    const i = Math.min(FLUX_TABLE_N - 1, Math.floor(x));
    const lo = knot(i);
    const hi = knot(i + 1);
    return lo + (hi - lo) * (x - i);
  };
}

type FluxAt = (gasK: number) => number;

/**
 * Six significant figures, the same bins as `Number(n.toExponential(5))`.
 * The balance used to build that string on every sample.
 */
function fluxGroup(n: number): number {
  if (n === 0 || !Number.isFinite(n)) return 0;
  const neg = n < 0;
  const abs = Math.abs(n);
  let exp = Math.floor(Math.log10(abs));
  let scale = 10 ** (5 - exp);
  let scaled = abs * scale;
  if (scaled >= 1e6 - 1e-8) {
    exp += 1;
    scale = 10 ** (5 - exp);
    scaled = abs * scale;
  } else if (scaled < 1e5) {
    exp -= 1;
    scale = 10 ** (5 - exp);
    scaled = abs * scale;
  }
  const grouped = Math.round(scaled) / scale;
  return neg ? -grouped : grouped;
}

interface HotFlux {
  gen: number;
  hk: number;
  rad: number;
  exposed: boolean;
  at: FluxAt;
}

/** Last exact table for this lining inside the current balance. */
const hotFlux = new WeakMap<Lining, HotFlux>();
/** Lining name, then grouped hk, then 1 once the back face is exposed, then grouped radiant flux. */
let fluxMemo: Map<string, Map<number, Map<number, Map<number, FluxAt>>>> | null = null;
let fluxSerial = 0;
let fluxGen = 0;
/** χQ / AT for the fire currently being solved, kW/m². Zero outside a balance. */
let fireRadiantKwM2 = 0;

const zeroFlux: FluxAt = () => 0;

function fluxAt(lining: Lining, tS: number): FluxAt {
  const hk = effectiveHeatLossKwM2K(lining, tS);
  const radIn = fireRadiantKwM2;
  const exposed = backFaceExposed(lining, tS);
  if (!(hk > 0)) return zeroFlux;
  if (!fluxMemo) return (gasK: number) => surfaceFluxKwM2(hk, gasK, radIn, exposed);
  const hot = hotFlux.get(lining);
  if (hot && hot.gen === fluxGen && hot.hk === hk && hot.rad === radIn && hot.exposed === exposed) {
    return hot.at;
  }
  const hkQ = fluxGroup(hk);
  const radQ = fluxGroup(radIn);
  const face = exposed ? 1 : 0;
  let byHk = fluxMemo.get(lining.name);
  if (!byHk) {
    byHk = new Map();
    fluxMemo.set(lining.name, byHk);
  }
  let byFace = byHk.get(hkQ);
  if (!byFace) {
    byFace = new Map();
    byHk.set(hkQ, byFace);
  }
  let byRad = byFace.get(face);
  if (!byRad) {
    byRad = new Map();
    byFace.set(face, byRad);
  }
  let at = byRad.get(radQ);
  if (!at) {
    at = fluxTable(hk, radIn, exposed);
    byRad.set(radQ, at);
  }
  hotFlux.set(lining, { gen: fluxGen, hk, rad: radIn, exposed, at });
  return at;
}

/**
 * Flux a surface at ambient takes from gas at `gasK`, kW/m². Convection is
 * the wall coefficient and the radiation is the grey exchange. This is the
 * imposed flux on a cold lining, not the film the gas is charged for once
 * the surface has warmed.
 */
export function coldSurfaceIncidentKwM2(gasK: number): number {
  if (!(gasK > AMBIENT_K)) return 0;
  const across = gasK - AMBIENT_K;
  const qConv = (SURFACE_CONVECTION_C_W / 1000) * Math.pow(across, 1 / 3) * across;
  const qRad = SURFACE_EMISSIVITY * SIGMA_KW_M2K4 * (gasK ** 4 - AMBIENT_K ** 4);
  return qConv + qRad;
}

export function liningFluxKwM2(lining: Lining, tS: number, gasK: number): number {
  return fluxAt(lining, tS)(gasK);
}

function withFluxMemo<T>(body: () => T): T {
  const prevMemo = fluxMemo;
  const prevRad = fireRadiantKwM2;
  const prevGen = fluxGen;
  fluxSerial += 1;
  fluxGen = fluxSerial;
  fluxMemo = new Map();
  fireRadiantKwM2 = 0;
  try {
    return body();
  } finally {
    fluxMemo = prevMemo;
    fireRadiantKwM2 = prevRad;
    fluxGen = prevGen;
  }
}

/** NUREG Eq. 2-1. Q is kW, areas are m², Ho is m, hk is kW/m²K. */
export function mqhRiseK(
  qKw: number,
  ventAreaM2: number,
  ventHeightM: number,
  atM2: number,
  hk: number,
): number {
  const vent = ventAreaM2 * Math.sqrt(ventHeightM);
  const loss = atM2 * hk;
  if (!(qKw > 0) || !(vent > 0) || !(loss > 0)) return 0;
  return 6.85 * Math.cbrt((qKw * qKw) / (vent * loss));
}

/** NUREG Eq. 13-2. The heat release that drives the MQH rise to flashover. */
export function mqhFlashoverKw(
  hk: number,
  atM2: number,
  ventAreaM2: number,
  ventHeightM: number,
): number {
  const group = hk * atM2 * ventAreaM2 * Math.sqrt(ventHeightM);
  if (!(group > 0)) return 0;
  return 610 * Math.sqrt(group);
}

export interface Vent {
  widthM: number;
  sillM: number;
  soffitM: number;
}

/**
 * A fan. CFAST Technical Reference, NIST TN 1889v1 §4.3, specifies a volume
 * flow, not a duct and not a fan curve. NIST TN 1889v2 §6.2 then holds that
 * flow constant up to 200 Pa of backwards pressure and cuts it off at 300 Pa.
 * Those two pressures are the CFAST defaults. Between them the flow falls
 * in a straight line.
 */
export const FAN_FULL_FLOW_PA = 200;
export const FAN_ZERO_FLOW_PA = 300;

/**
 * 2021 IMC Section 507.5, a wall-mounted canopy over a medium-duty appliance.
 * A fryer is medium duty (IMC Section 202). 300 cubic feet per minute per
 * linear foot. The code's own SI note is 1.55 L/s per metre for each cfm
 * per foot, so 300 × 1.55 = 465 L/s per metre of hood.
 */
export const HOOD_EXHAUST_M3_PER_S_PER_M = (300 * 1.55) / 1000;

/**
 * Assumed. The hood length is not stored on the appliance. 1.22 m is a 4 ft
 * canopy over one appliance. It is not the width of the stall.
 */
export const HOOD_LENGTH_M = 1.22;

/** One discharging hood, m³/s. The IMC rate times the assumed length. */
export const HOOD_EXTRACT_M3_PER_S = HOOD_EXHAUST_M3_PER_S_PER_M * HOOD_LENGTH_M;

/**
 * Centre of the canopy intake above the floor, metres. CFAST TN 1889v2
 * §6.1 reads the centre height of the duct opening above the floor.
 * Greenheck Document 452413, the installation manual for its UL 710 canopy,
 * gives a typical hanging height of 80 in (203.2 cm) from the finished
 * floor to the front lower edge. The opening centre is taken as that lip.
 * The filter sits just above it, and that offset is not in the manual.
 * This is not the link height above the cooking surface.
 */
export const HOOD_INTAKE_M = 80 * 0.0254;

/**
 * When a hood fan runs. `discharge` is the default, and it is an assumption
 * the user has not settled: the fan runs only while the wet-chemical system
 * is discharging. NFPA 96 §8.2.3.1 keeps it running after that discharge.
 * `appliances` also starts it when a heat-producing appliance under the hood
 * is on, which this model takes as the hood being placed. NFPA 96 §8.2.3.3.
 */
export type HoodFanWhen = 'discharge' | 'appliances';

/** The unsettled default. A scene may set the other value. */
export const HOOD_FAN_WHEN: HoodFanWhen = 'discharge';

/**
 * Ambient oxygen, as a mass fraction. CFAST Technical Reference (NIST TN
 * 1889v1 §2.2): 23% by mass, which is 21% by volume. Nitrogen makes up the
 * rest. Water vapour is not split out.
 */
export const O2_AMBIENT_MASS = 0.23;

/**
 * Lower oxygen limit, mass fraction. CFAST TN 1889v1 §3.2, the default
 * Y_O2,l. Below it a flame in that layer does not burn. It is not a
 * function of temperature.
 */
export const O2_LIMIT_MASS = 0.15;

/**
 * Heat released per kilogram of oxygen consumed, kJ/kg. Huggett, Fire and
 * Materials 4 (1980), the value CFAST TN 1889v1 §3.2 footnote 1 uses for a
 * typical hydrocarbon. 13.1 MJ/kg.
 */
export const DELTA_H_O2_KJ_PER_KG = 13100;

/**
 * Ventilation-limited heat release, kW per m²√m. Kawagoe's 0.5 A√H kg/s of
 * air, times the ambient oxygen mass fraction, times Huggett's heat, is
 * 0.5 × 0.23 × 13100 = 1506.5. The rounded correlation used with that
 * derivation is 1500 A√H. NUREG-1805 writes the same cap. It is not fitted.
 */
export const KAWAGOE_KW = 1500;

/** CFAST TN 1889v1 §2.2 takes the mixture as air, 29 g/mol. */
export const AIR_MOLAR_MASS_G = 29;
export const O2_MOLAR_MASS_G = 32;

export function oxygenMassFraction(value: number | undefined): number {
  if (value == null || !Number.isFinite(value)) return O2_AMBIENT_MASS;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * CFAST Eq. 3.14. The burning fraction falls from 1 to 0 across a few
 * thousandths of mass fraction at the lower oxygen limit. The 800 and the
 * 4 are the published smoothing, not a fit to a scene.
 */
export function lowerOxygenCoefficient(yO2: number): number {
  if (!(yO2 > 0)) return 0;
  const x = 800 * (yO2 - O2_LIMIT_MASS) - 4;
  return (Math.tanh(x) + 1) / 2;
}

/** kW the oxygen in this entrainment stream can support, after the cutoff. */
export function oxygenCapacityKw(entrainmentKgS: number, yO2: number): number {
  if (!(entrainmentKgS > 0) || !(yO2 > 0)) return 0;
  return entrainmentKgS * yO2 * lowerOxygenCoefficient(yO2) * DELTA_H_O2_KJ_PER_KG;
}

/** kW the same stream could support if the cutoff were not applied. The equivalence ratio uses this. */
export function oxygenSupplyKw(entrainmentKgS: number, yO2: number): number {
  if (!(entrainmentKgS > 0) || !(yO2 > 0)) return 0;
  return entrainmentKgS * yO2 * DELTA_H_O2_KJ_PER_KG;
}

/**
 * Global equivalence ratio. CFAST TN 1889v3: fuel mass flux over oxygen
 * mass flux, divided by the stoichiometric ratio. Stoichiometry here is
 * Huggett's heat, so φ = Q_prescribed / (ṁ_O2 ΔH_O2).
 */
export function equivalenceRatio(prescribedKw: number, supplyKw: number): number {
  if (!(prescribedKw > 0)) return 0;
  if (!(supplyKw > 0)) return Number.POSITIVE_INFINITY;
  return prescribedKw / supplyKw;
}

/** 1500 A√H, kW. A is the vent area, m², and H is the vent height, m. */
export function ventilationLimitedKw(areaM2: number, heightM: number): number {
  if (!(areaM2 > 0) || !(heightM > 0)) return 0;
  return KAWAGOE_KW * areaM2 * Math.sqrt(heightM);
}

export interface LayerBurn {
  prescribedKw: number;
  burnedKw: number;
  /**
   * Prescribed release over the fresh-air oxygen supply, before the cutoff.
   * Fresh air is the lower-layer stream. Recirculated upper-layer gas is
   * not in it.
   */
  phi: number;
  /** Burned over prescribed. 1 when the plume can still feed the fire. */
  fraction: number;
  /** Lower-layer air the plumes were allowed to entrain, kg/s. */
  lowerAirKgS: number;
  oxygenLowerKgS: number;
  oxygenUpperKgS: number;
}

interface PlumeAir {
  heatKw: number;
  eLower: number;
  eUpper: number;
}

/**
 * CFAST Eq. 3.13 for every plume in the room. Entrainment up to the flame
 * tip, from the lower layer below the interface and from the upper layer
 * above it. The plumes share one lower-layer air supply: `lowerAirCapKgS`
 * is the door inflow, the fan makeup, and the air the interface can still
 * give up. A sum of stud plumes cannot burn more than that. The prescribed
 * release is the pyrolysis the fire is asking for. What burns is the lesser
 * of that and the oxygen. Unburned fuel is not carried on; this model does
 * not have that stream, so the heat release itself is the limited one.
 * φ uses the fresh lower-layer air only. Upper-layer gas is recirculated.
 */
export function layerBurn(
  fires: readonly FirePlume[],
  interfaceM: number,
  yLower: number,
  yUpper: number,
  chi = RADIATIVE_FRACTION,
  lowerAirCapKgS = Number.POSITIVE_INFINITY,
): LayerBurn {
  const yL = yLower > 0 ? yLower : 0;
  const yU = yUpper > 0 ? yUpper : 0;
  const pieces: PlumeAir[] = [];
  let prescribed = 0;
  let wanted = 0;
  for (const fire of fires) {
    if (!(fire.heatKw > 0) || !(fire.diameterM > 0)) continue;
    prescribed += fire.heatKw;
    const flame = heskestadFlameHeightM(fire.heatKw, fire.diameterM);
    const z = heightAboveFuelM(interfaceM, fire.baseM);
    const lowerH = Math.min(flame, z);
    const eLower = heskestadEntrainmentKgS(fire.heatKw, lowerH, fire.diameterM, chi);
    const eFlame = heskestadEntrainmentKgS(fire.heatKw, flame, fire.diameterM, chi);
    const eUpper = Math.max(0, eFlame - eLower);
    pieces.push({ heatKw: fire.heatKw, eLower, eUpper });
    wanted += eLower;
  }
  const cap = Number.isFinite(lowerAirCapKgS) ? Math.max(0, lowerAirCapKgS) : wanted;
  const scale = wanted > cap ? cap / wanted : 1;
  const lowerAir = wanted * scale;
  let fromLowerKw = 0;
  let fromUpperKw = 0;
  for (const piece of pieces) {
    const capL = oxygenCapacityKw(piece.eLower * scale, yL);
    const capU = oxygenCapacityKw(piece.eUpper, yU);
    const burned = Math.min(piece.heatKw, capL + capU);
    const lowerKw = Math.min(burned, capL);
    fromLowerKw += lowerKw;
    fromUpperKw += burned - lowerKw;
  }
  const burnedKw = fromLowerKw + fromUpperKw;
  return {
    prescribedKw: prescribed,
    burnedKw,
    phi: equivalenceRatio(prescribed, oxygenSupplyKw(lowerAir, yL)),
    fraction: prescribed > 0 ? burnedKw / prescribed : 1,
    lowerAirKgS: lowerAir,
    oxygenLowerKgS: DELTA_H_O2_KJ_PER_KG > 0 ? fromLowerKw / DELTA_H_O2_KJ_PER_KG : 0,
    oxygenUpperKgS: DELTA_H_O2_KJ_PER_KG > 0 ? fromUpperKw / DELTA_H_O2_KJ_PER_KG : 0,
  };
}

/** The interface cannot fall through this. The same clamp the stepper uses. */
const INTERFACE_FLOOR_M = 0.05;

export interface LimitedBurn {
  burn: LayerBurn;
  plumeKgS: number;
  inKgS: number;
  outKgS: number;
  outByVentKgS: number[];
  /** Upper-layer outflow of each vent, same order. The door jet. */
  hotOutByVentKgS: number[];
  fanUpperKgS: number;
  fanLowerKgS: number;
}

/**
 * The oxygen limit tied to the vents. Lower-layer air available this step
 * is the door inflow and fan makeup, plus the air the interface can still
 * descend through. At the floor only the inflow remains.
 *
 * That fresh air is the flame. CFAST Eq. 3.13 limits the burning to the
 * oxygen the plume can take, and the plume has to be the fire that oxygen
 * supports. The oxygen that counts is the lower-layer air the plume
 * entrains, already shared and capped by the supply. Air the plume does
 * not take, including the last centimetre of a large floor, does not
 * enlarge the flame. Sizing the flame on the prescribed pyrolysis lets it
 * entrain the oxygen stored in the upper layer and burn the free-burn
 * rate for a step. The extra pyrolysis is not a larger flame: this model
 * does not carry unburned fuel. Upper-layer gas can still finish a flame
 * the fresh air already accounts for. It cannot raise the release above
 * that air.
 *
 * The mass the zone moves is Heskestad entrainment of that flame at the
 * interface. It cannot exceed the air the vents and the layer can give
 * this step, and it cannot exceed the enthalpy the released heat can
 * carry (CFAST Eq. 3.18). Each cap is applied once. Feeding either back
 * into the air supply collapses the burn onto a second, much smaller
 * root for a single step.
 */
export function oxygenLimitedBurn(
  spec: LayerSpec,
  interfaceM: number,
  upperK: number,
  yLower: number,
  yUpper: number,
  dt: number,
): LimitedBurn {
  const chi = chiOf(spec);
  const flows = balancedFlows(spec.vents, interfaceM, upperK, spec.fans ?? []);
  const slice = dt > 0 ? dt : SUBSTEP_S;
  const rho = densityKgM3(AMBIENT_K);
  const descendKgS =
    (rho * Math.max(spec.areaM2, 0) * Math.max(0, interfaceM - INTERFACE_FLOOR_M)) / slice;
  const airCap = Math.max(0, flows.inKgS - flows.fanLowerKgS) + descendKgS;
  let prescribed = 0;
  for (const fire of spec.fires) if (fire.heatKw > 0) prescribed += fire.heatKw;
  const yL = yLower > 0 ? yLower : 0;
  // lowerAirKgS is the lower-layer stream the prescribed plumes entrain,
  // shared down to airCap. The oxygen in it is the flame. The burned
  // kilowatts of this call are not used: they still include upper-layer gas.
  const entrained = layerBurn(spec.fires, interfaceM, yLower, yUpper, chi, airCap);
  const freshKw = oxygenCapacityKw(entrained.lowerAirKgS, yL);
  const freshFraction = prescribed > 0 ? Math.min(1, freshKw / prescribed) : 1;
  const flames =
    freshFraction < 1
      ? spec.fires.map((fire) => ({
          heatKw: fire.heatKw > 0 ? fire.heatKw * freshFraction : 0,
          diameterM: fire.diameterM,
          baseM: fire.baseM,
        }))
      : spec.fires;
  const raw = layerBurn(flames, interfaceM, yLower, yUpper, chi, airCap);
  const burn: LayerBurn = {
    prescribedKw: prescribed,
    burnedKw: raw.burnedKw,
    phi: equivalenceRatio(prescribed, oxygenSupplyKw(raw.lowerAirKgS, yL)),
    fraction: prescribed > 0 ? raw.burnedKw / prescribed : 1,
    lowerAirKgS: raw.lowerAirKgS,
    oxygenLowerKgS: raw.oxygenLowerKgS,
    oxygenUpperKgS: raw.oxygenUpperKgS,
  };
  // Mass taken from the lower layer. Heskestad at the interface, for
  // the flame the fresh air can support. It cannot exceed the air the
  // vents and the layer can give this step: a thin layer would otherwise
  // be stripped of oxygen in one substep. Eq. 3.18 caps the enthalpy
  // once. Neither cap is fed back into the oxygen supply.
  const qGas = Math.max(0, (1 - chi) * burn.burnedKw);
  const riseNow = Math.max(upperK - AMBIENT_K, 1);
  const enthalpyCap = qGas > 0 ? qGas / (CP_KJ_KGK * riseNow) : 0;
  let plume = 0;
  for (const fire of flames) {
    if (!(fire.heatKw > 0) || !(fire.diameterM > 0)) continue;
    plume += heskestadEntrainmentKgS(
      fire.heatKw,
      heightAboveFuelM(interfaceM, fire.baseM),
      fire.diameterM,
      chi,
    );
  }
  if (plume > airCap) plume = airCap;
  if (!(qGas > 0)) plume = 0;
  else if (plume > enthalpyCap) plume = enthalpyCap;
  return {
    burn,
    plumeKgS: plume,
    inKgS: flows.inKgS,
    outKgS: flows.outKgS,
    outByVentKgS: flows.outByVent,
    hotOutByVentKgS: flows.hotOutByVent,
    fanUpperKgS: flows.fanUpperKgS,
    fanLowerKgS: flows.fanLowerKgS,
  };
}

export interface MechanicalVent {
  /** Nominal extract while the fan is on, m³/s. Positive leaves the room. */
  flowM3PerS: number;
  /** Centre of the intake above the floor, m. CFAST TN 1889v2 §6.1. */
  intakeM: number;
}

/**
 * Volume still moving against a backwards pressure. At or below 200 Pa the
 * fan is at its nominal flow. At or above 300 Pa it is stopped.
 */
export function fanVolumeM3PerS(nominalM3PerS: number, backPressurePa: number): number {
  if (!(nominalM3PerS > 0)) return 0;
  const back = Math.max(0, backPressurePa);
  if (back <= FAN_FULL_FLOW_PA) return nominalM3PerS;
  if (back >= FAN_ZERO_FLOW_PA) return 0;
  const span = FAN_ZERO_FLOW_PA - FAN_FULL_FLOW_PA;
  return (nominalM3PerS * (FAN_ZERO_FLOW_PA - back)) / span;
}

export interface Boundary {
  areaM2: number;
  lining: Lining;
}

export interface FirePlume {
  heatKw: number;
  diameterM: number;
  /**
   * Fuel surface above the floor, metres. Heskestad's z is above this,
   * not above the floor. Absent means the fuel is on the floor.
   */
  baseM?: number;
}

export interface LayerSpec {
  areaM2: number;
  ceilingM: number;
  vents: readonly Vent[];
  boundaries: readonly Boundary[];
  fires: readonly FirePlume[];
  /**
   * Fans. Absent means none. Each one extracts from the layer that contains
   * its intake: above the interface, the upper layer; at or below it, the
   * lower layer.
   */
  fans?: readonly MechanicalVent[];
  /** Radiative fraction. Defaults to the contents value. */
  chi?: number;
}

export interface ZoneState {
  /** Height of the interface above the floor, metres. */
  interfaceM: number;
  upperK: number;
  /** Soot in the upper layer, grams. */
  sootG: number;
  /** Seconds the fire has been burning, for the lining loss. */
  ageS: number;
  /** Oxygen mass fraction in the lower layer. Absent on an old state means ambient. */
  lowerO2?: number;
  /** Oxygen mass fraction in the upper layer. Absent on an old state means ambient. */
  upperO2?: number;
}

export interface SteadyLayer {
  interfaceM: number;
  upperK: number;
  depthM: number;
  outKgS: number;
  plumeKgS: number;
}

/**
 * Burning area from the contents cap, as a circle. Assumed when the fire
 * has no measured diameter. A known burner should pass its own diameter.
 */
export function diameterForReleaseKw(qKw: number): number {
  const area = Math.max(qKw, 0) / CONTENTS_HRRPUA_KW_M2;
  return Math.sqrt((4 * Math.max(area, 0.05)) / Math.PI);
}

/**
 * True when something can hold smoke down from the ceiling: no opening, or
 * a vent whose head is below the ceiling. Full-height openings only are an
 * open side. The spill edge is the idea in smoke-reservoir design (the
 * volume above the soffit); the gap under the ceiling is RESERVOIR_SOFFIT_GAP_M.
 */
export function hasSmokeReservoir(vents: readonly Vent[], ceilingM: number): boolean {
  if (!(ceilingM > 0)) return false;
  if (vents.length === 0) return true;
  for (const vent of vents) {
    const top = Math.max(vent.sillM, vent.soffitM);
    if (top < ceilingM - RESERVOIR_SOFFIT_GAP_M) return true;
  }
  return false;
}

export function formsSustainedLayer(
  depthM: number,
  ceilingM: number,
  riseK: number,
  reservoir: boolean,
): boolean {
  return (
    reservoir &&
    ceilingM > 0 &&
    riseK >= DISTINCT_LAYER_RISE_K &&
    depthM > CEILING_JET_DEPTH_FRACTION * ceilingM
  );
}

export function freshLayer(ceilingM: number): ZoneState {
  const depth = Math.max(0.05, CEILING_JET_DEPTH_FRACTION * ceilingM);
  return {
    interfaceM: Math.max(0.05, ceilingM - depth),
    upperK: AMBIENT_K + 1,
    sootG: 0,
    ageS: HK_FLOOR_S,
    lowerO2: O2_AMBIENT_MASS,
    upperO2: O2_AMBIENT_MASS,
  };
}

/**
 * CFAST Eq. 3.9–3.10. χQ is laid on the boundaries by area and (1 − χ)Q is
 * what the gas receives. The by-area share is the surface part of that
 * split; the layer itself does not absorb any of the fire's radiation.
 */
function fireSplit(spec: LayerSpec): { totalKw: number; convectedKw: number } {
  let total = 0;
  for (const fire of spec.fires) if (fire.heatKw > 0) total += fire.heatKw;
  let at = 0;
  for (const boundary of spec.boundaries) if (boundary.areaM2 > 0) at += boundary.areaM2;
  const chi = chiOf(spec);
  fireRadiantKwM2 = at > 0 && total > 0 ? (chi * total) / at : 0;
  return { totalKw: total, convectedKw: Math.max(0, (1 - chi) * total) };
}

function chiOf(spec: LayerSpec): number {
  const chi = spec.chi ?? RADIATIVE_FRACTION;
  if (!(chi >= 0) || chi >= 1) return RADIATIVE_FRACTION;
  return chi;
}

/**
 * Heskestad mean flame height, metres. CFAST Eq. 3.17 written as
 * L = 0.235 Q^0.4 − 1.02 D, the form already used for entrainment.
 */
export function heskestadFlameHeightM(qKw: number, diameterM: number): number {
  if (!(qKw > 0) || !(diameterM > 0)) return 0;
  return Math.max(0.05, 0.235 * Math.pow(qKw, 0.4) - 1.02 * diameterM);
}

/**
 * Metres of plume above the fuel. Heskestad's z (CFAST Eq. 3.15) is
 * measured from the fuel surface. A pan on a stand is not on the floor.
 */
function heightAboveFuelM(interfaceM: number, baseM: number | undefined): number {
  const base = baseM !== undefined && baseM > 0 ? baseM : 0;
  return interfaceM > base ? interfaceM - base : 0;
}

/**
 * Heskestad entrainment at `heightM` above the fuel, kg/s.
 * Below the flame tip the seed scales the tip value by z / L.
 */
export function heskestadEntrainmentKgS(
  qKw: number,
  heightM: number,
  diameterM: number,
  chi = RADIATIVE_FRACTION,
): number {
  if (!(qKw > 0) || !(heightM > 0) || !(diameterM > 0)) return 0;
  const qPow = Math.pow(qKw, 0.4);
  const z0 = 0.083 * qPow - 1.02 * diameterM;
  const flame = heskestadFlameHeightM(qKw, diameterM);
  const qc = Math.max(0, (1 - chi) * qKw);
  const at = (z: number) => {
    const dz = Math.max(z - z0, 0.05);
    const rho = LEVEL.RHO_AIR;
    const group = Math.pow((LEVEL.G * rho * rho) / (CP_KJ_KGK * AMBIENT_K), 1 / 3);
    const dz53 = Math.pow(dz, 5 / 3);
    const denom = Math.pow(Math.sqrt(LEVEL.G) * CP_KJ_KGK * rho * AMBIENT_K, 2 / 3) * dz53;
    const bracket = 1 + (2.9 * Math.pow(qc, 2 / 3)) / Math.max(denom, 1e-9);
    return 0.196 * group * Math.pow(qc, 1 / 3) * dz53 * bracket;
  };
  if (heightM >= flame) return at(heightM);
  return at(flame) * (heightM / flame);
}

interface PreparedPlume {
  heatKw: number;
  diameterM: number;
  baseM: number;
  at: (heightM: number) => number;
}

let preparedFires: readonly FirePlume[] | null = null;
let preparedChi = Number.NaN;
let preparedPlumes: PreparedPlume[] = [];

function plumeCurve(qKw: number, diameterM: number, chi: number): (heightM: number) => number {
  const qPow = Math.pow(qKw, 0.4);
  const z0 = 0.083 * qPow - 1.02 * diameterM;
  const flame = heskestadFlameHeightM(qKw, diameterM);
  const qc = Math.max(0, (1 - chi) * qKw);
  const rho = LEVEL.RHO_AIR;
  const group = Math.pow((LEVEL.G * rho * rho) / (CP_KJ_KGK * AMBIENT_K), 1 / 3);
  const qc13 = Math.pow(qc, 1 / 3);
  const qc23 = Math.pow(qc, 2 / 3);
  const denomScale = Math.pow(Math.sqrt(LEVEL.G) * CP_KJ_KGK * rho * AMBIENT_K, 2 / 3);
  const atHeight = (z: number) => {
    const dz = Math.max(z - z0, 0.05);
    const dz53 = Math.pow(dz, 5 / 3);
    const denom = denomScale * dz53;
    const bracket = 1 + (2.9 * qc23) / Math.max(denom, 1e-9);
    return 0.196 * group * qc13 * dz53 * bracket;
  };
  return (heightM: number) => {
    if (!(heightM > 0)) return 0;
    if (heightM >= flame) return atHeight(heightM);
    return atHeight(flame) * (heightM / flame);
  };
}

function plumeKgS(spec: LayerSpec, interfaceM: number): number {
  const chi = chiOf(spec);
  if (spec.fires !== preparedFires || chi !== preparedChi) {
    preparedFires = spec.fires;
    preparedChi = chi;
    preparedPlumes = [];
    for (const fire of spec.fires) {
      if (!(fire.heatKw > 0) || !(fire.diameterM > 0)) continue;
      preparedPlumes.push({
        heatKw: fire.heatKw,
        diameterM: fire.diameterM,
        baseM: fire.baseM ?? 0,
        at: plumeCurve(fire.heatKw, fire.diameterM, chi),
      });
    }
  }
  let mass = 0;
  for (const fire of preparedPlumes) mass += fire.at(heightAboveFuelM(interfaceM, fire.baseM));
  return mass;
}

interface BoundLoss {
  boundaries: readonly Boundary[];
  tS: number;
  rad: number;
  gen: number;
  terms: Array<{ area: number; at: FluxAt }>;
}

let boundLoss: BoundLoss | null = null;

function lossPowerKw(boundaries: readonly Boundary[], tS: number, gasK: number): number {
  const rad = fireRadiantKwM2;
  let bound = boundLoss;
  if (
    !bound ||
    bound.boundaries !== boundaries ||
    bound.tS !== tS ||
    bound.rad !== rad ||
    bound.gen !== fluxGen
  ) {
    const terms: Array<{ area: number; at: FluxAt }> = [];
    for (const boundary of boundaries) {
      if (!(boundary.areaM2 > 0)) continue;
      terms.push({ area: boundary.areaM2, at: fluxAt(boundary.lining, tS) });
    }
    bound = { boundaries, tS, rad, gen: fluxGen, terms };
    boundLoss = bound;
  }
  let sum = 0;
  const terms = bound.terms;
  for (let i = 0; i < terms.length; i++) {
    const term = terms[i];
    if (term) sum += term.area * term.at(gasK);
  }
  return sum;
}

function densityKgM3(tempK: number): number {
  return RHO_T / Math.max(tempK, 1);
}

/**
 * One horizontal slice of an orifice, kg/s. CFAST Eq. 4.3. Pressures are
 * the inside-minus-outside values at the bottom and top of the slice, and
 * they must not change sign. `rho` is the gas that is flowing.
 */
export function orificeSliceKgS(
  widthM: number,
  heightM: number,
  pBotPa: number,
  pTopPa: number,
  rhoKgM3: number,
): number {
  if (!(widthM > 0) || !(heightM > 0) || !(rhoKgM3 > 0)) return 0;
  const a = Math.abs(pBotPa);
  const b = Math.abs(pTopPa);
  if (a < 1e-10 && b < 1e-10) return 0;
  const c = LEVEL.ORIFICE_C;
  if (Math.abs(b - a) < 1e-6 * Math.max(1, a, b)) {
    return c * widthM * heightM * Math.sqrt(2 * rhoKgM3 * Math.max(a, b));
  }
  return (
    ((2 / 3) *
      c *
      Math.sqrt(2 * rhoKgM3) *
      widthM *
      heightM *
      (Math.pow(b, 1.5) - Math.pow(a, 1.5))) /
    (b - a)
  );
}

interface SliceFlows {
  inKgS: number;
  outKgS: number;
  /** Outflow whose slice sits in the upper layer, kg/s. */
  hotOutKgS: number;
}

interface Flows extends SliceFlows {
  /** Outflow of each vent, same order as the spec. */
  outByVent: number[];
  /** Upper-layer outflow of each vent. This is the door jet. */
  hotOutByVent: number[];
  /** Fan extract from the upper layer, kg/s. It leaves through the duct. */
  fanUpperKgS: number;
  /** Fan extract from the lower layer, kg/s. Clear air, in this model. */
  fanLowerKgS: number;
}

function pressureAt(
  z: number,
  interfaceM: number,
  dP0: number,
  rhoL: number,
  rhoU: number,
): number {
  if (z <= interfaceM) return dP0;
  return dP0 + (rhoL - rhoU) * LEVEL.G * (z - interfaceM);
}

/**
 * Which layer a fan draws, and the mass that leaves. The intake centre is
 * CFAST TN 1889v2 §6.1. Above the interface it is in the upper layer, so the
 * density is the hot gas. At or below the interface it is in the lower
 * layer, which this model keeps at ambient. The mass flow is that density
 * times the volume still moving at the room pressure. Soot leaves only with
 * the upper-layer stream. CFAST filtering starts off (TN 1889v1 §4.3), so
 * none of that soot is caught.
 */
export function mechanicalExtract(
  fans: readonly MechanicalVent[],
  interfaceM: number,
  upperK: number,
  floorPressurePa: number,
): { upperKgS: number; lowerKgS: number } {
  let upper = 0;
  let lower = 0;
  const rhoL = densityKgM3(AMBIENT_K);
  const rhoU = densityKgM3(upperK);
  for (const fan of fans) {
    if (!(fan.flowM3PerS > 0) || !(fan.intakeM >= 0)) continue;
    const atIntake = pressureAt(fan.intakeM, interfaceM, floorPressurePa, rhoL, rhoU);
    const volume = fanVolumeM3PerS(fan.flowM3PerS, -atIntake);
    if (!(volume > 0)) continue;
    if (fan.intakeM > interfaceM) upper += volume * rhoU;
    else lower += volume * rhoL;
  }
  return { upperKgS: upper, lowerKgS: lower };
}

function withFans(door: Flows, fans: { upperKgS: number; lowerKgS: number }): Flows {
  return { ...door, fanUpperKgS: fans.upperKgS, fanLowerKgS: fans.lowerKgS };
}

const ventMarks = [0, 0, 0];
const ventScratch: SliceFlows = { inKgS: 0, outKgS: 0, hotOutKgS: 0 };

function addSliceFlows(
  into: SliceFlows,
  z0: number,
  z1: number,
  interfaceM: number,
  dP0: number,
  rhoL: number,
  rhoU: number,
  rhoA: number,
  widthM: number,
): void {
  if (!(z1 > z0 + 1e-9)) return;
  const p0 = pressureAt(z0, interfaceM, dP0, rhoL, rhoU);
  const p1 = pressureAt(z1, interfaceM, dP0, rhoL, rhoU);
  if (p0 * p1 < 0 && p1 !== p0) {
    const zN = z0 + ((z1 - z0) * (0 - p0)) / (p1 - p0);
    // Split whenever the neutral plane is strictly inside the slice.
    // A plane that falls within a micron of an end used to be left mixed,
    // and the slice was then called an outflow if either end was positive.
    // That dropped the inflow for one step and the burn followed it.
    const pad = Math.min(1e-6, (z1 - z0) * 0.25);
    if (zN > z0 + pad && zN < z1 - pad) {
      addSliceFlows(into, z0, zN, interfaceM, dP0, rhoL, rhoU, rhoA, widthM);
      addSliceFlows(into, zN, z1, interfaceM, dP0, rhoL, rhoU, rhoA, widthM);
      return;
    }
  }
  if (p0 === 0 && p1 === 0) return;
  // The end farther from the plane owns a slice that was not split.
  const outflow = Math.abs(p0) >= Math.abs(p1) ? p0 > 0 : p1 > 0;
  const mid = (z0 + z1) / 2;
  const rho = outflow ? (mid > interfaceM ? rhoU : rhoL) : rhoA;
  const mass = orificeSliceKgS(widthM, z1 - z0, p0, p1, rho);
  if (outflow) {
    into.outKgS += mass;
    // Above the interface the gas is the hot layer. Below it the outflow
    // is lower-layer air at ambient, and that is not a door jet.
    if (mid > interfaceM) into.hotOutKgS += mass;
  } else into.inKgS += mass;
}

function accumulateVent(
  into: SliceFlows,
  vent: Vent,
  interfaceM: number,
  dP0: number,
  rhoL: number,
  rhoU: number,
  rhoA: number,
): void {
  const sill = Math.min(vent.sillM, vent.soffitM);
  const soffit = Math.max(vent.sillM, vent.soffitM);
  if (!(vent.widthM > 0) || !(soffit > sill)) return;
  let count = 2;
  ventMarks[0] = sill;
  ventMarks[1] = soffit;
  if (interfaceM > sill && interfaceM < soffit) {
    ventMarks[2] = interfaceM;
    count = 3;
  }
  if (ventMarks[0] > ventMarks[1]) {
    const swap = ventMarks[0];
    ventMarks[0] = ventMarks[1];
    ventMarks[1] = swap;
  }
  if (count === 3 && ventMarks[1] > ventMarks[2]) {
    const swap = ventMarks[1];
    ventMarks[1] = ventMarks[2];
    ventMarks[2] = swap;
    if (ventMarks[0] > ventMarks[1]) {
      const again = ventMarks[0];
      ventMarks[0] = ventMarks[1];
      ventMarks[1] = again;
    }
  }
  for (let i = 0; i < count - 1; i++) {
    addSliceFlows(
      into,
      ventMarks[i] ?? sill,
      ventMarks[i + 1] ?? soffit,
      interfaceM,
      dP0,
      rhoL,
      rhoU,
      rhoA,
      vent.widthM,
    );
  }
}

function ventFlows(vents: readonly Vent[], interfaceM: number, upperK: number, dP0: number): Flows {
  const flows: Flows = {
    inKgS: 0,
    outKgS: 0,
    hotOutKgS: 0,
    outByVent: vents.map(() => 0),
    hotOutByVent: vents.map(() => 0),
    fanUpperKgS: 0,
    fanLowerKgS: 0,
  };
  const rhoU = densityKgM3(upperK);
  const rhoL = densityKgM3(AMBIENT_K);
  const rhoA = LEVEL.RHO_AIR;
  for (let v = 0; v < vents.length; v++) {
    const vent = vents[v];
    if (!vent) continue;
    const before = flows.outKgS;
    const beforeHot = flows.hotOutKgS;
    accumulateVent(flows, vent, interfaceM, dP0, rhoL, rhoU, rhoA);
    flows.outByVent[v] = flows.outKgS - before;
    flows.hotOutByVent[v] = flows.hotOutKgS - beforeHot;
  }
  return flows;
}

function pressureNet(
  vents: readonly Vent[],
  interfaceM: number,
  upperK: number,
  dP0: number,
  fans: readonly MechanicalVent[],
  rhoL: number,
  rhoU: number,
  rhoA: number,
): number {
  ventScratch.inKgS = 0;
  ventScratch.outKgS = 0;
  ventScratch.hotOutKgS = 0;
  for (let v = 0; v < vents.length; v++) {
    const vent = vents[v];
    if (!vent) continue;
    accumulateVent(ventScratch, vent, interfaceM, dP0, rhoL, rhoU, rhoA);
  }
  const extracted = mechanicalExtract(fans, interfaceM, upperK, dP0);
  return ventScratch.inKgS - ventScratch.outKgS - extracted.upperKgS - extracted.lowerKgS;
}

function balancedFlows(
  vents: readonly Vent[],
  interfaceM: number,
  upperK: number,
  fans: readonly MechanicalVent[] = [],
): Flows {
  const at = (p: number) =>
    withFans(
      ventFlows(vents, interfaceM, upperK, p),
      mechanicalExtract(fans, interfaceM, upperK, p),
    );
  // No orifice to relieve the room. The fan is read at zero pressure
  // difference, so it stays at its nominal flow. A sealed volume would
  // climb until the fan stalled; this model does not grow that pressure.
  if (vents.length === 0) return at(0);
  const rhoU = densityKgM3(upperK);
  const rhoL = densityKgM3(AMBIENT_K);
  const rhoA = LEVEL.RHO_AIR;
  const netAt = (p: number) => pressureNet(vents, interfaceM, upperK, p, fans, rhoL, rhoU, rhoA);
  let lo = -80;
  let hi = 20;
  let nLo = netAt(lo);
  let nHi = netAt(hi);
  for (let i = 0; i < 6 && nLo < 0; i++) {
    lo = lo * 2 - 10;
    nLo = netAt(lo);
  }
  for (let i = 0; i < 6 && nHi > 0; i++) {
    hi = hi * 2 + 10;
    nHi = netAt(hi);
  }
  if (nLo < 0 && nHi < 0) return at(lo);
  if (nLo > 0 && nHi > 0) return at(hi);
  let bestP = Math.abs(nLo) < Math.abs(nHi) ? lo : hi;
  let bestAbs = Math.abs(bestP === lo ? nLo : nHi);
  for (let i = 0; i < 28; i++) {
    const midP = 0.5 * (lo + hi);
    const nMid = netAt(midP);
    const absMid = Math.abs(nMid);
    if (absMid < bestAbs) {
      bestP = midP;
      bestAbs = absMid;
    }
    if (nMid > 0) lo = midP;
    else hi = midP;
  }
  return at(bestP);
}

interface Balance {
  plumeKgS: number;
  outKgS: number;
  inKgS: number;
  fanUpperKgS: number;
  riseK: number;
}

function energyKw(spec: LayerSpec, tS: number, plumeKgS: number, riseK: number): number {
  const gas = AMBIENT_K + Math.max(0, riseK);
  return plumeKgS * CP_KJ_KGK * Math.max(0, riseK) + lossPowerKw(spec.boundaries, tS, gas);
}

export function balanceAt(spec: LayerSpec, interfaceM: number, tS: number): Balance {
  const plume = plumeKgS(spec, interfaceM);
  const q = fireSplit(spec).convectedKw;
  // Loss rises with temperature, so the rise that spends the fire is unique.
  let lo = 0;
  let hi = 20;
  while (energyKw(spec, tS, plume, hi) < q && hi < 4000) hi *= 2;
  for (let i = 0; i < 32; i++) {
    const mid = 0.5 * (lo + hi);
    if (energyKw(spec, tS, plume, mid) < q) lo = mid;
    else hi = mid;
  }
  const rise = 0.5 * (lo + hi);
  const flows = balancedFlows(spec.vents, interfaceM, AMBIENT_K + rise, spec.fans ?? []);
  return {
    plumeKgS: plume,
    outKgS: flows.outKgS,
    inKgS: flows.inKgS,
    fanUpperKgS: flows.fanUpperKgS,
    riseK: rise,
  };
}

/**
 * Steady interface, where the plume into the layer equals the vent flow
 * out of it. No root, and the plume is still the larger flow at the floor,
 * means the room fills. No root, and the vent is the larger flow even for
 * a thin layer, means the smoke never pools.
 */
export function steadyLayer(spec: LayerSpec, tS: number): SteadyLayer | null {
  return withFluxMemo(() => steadyLayerNow(spec, tS));
}

function steadyLayerNow(spec: LayerSpec, tS: number): SteadyLayer | null {
  const q = fireSplit(spec).totalKw;
  if (!(q > MIN_LAYER_FIRE_KW) || !(spec.areaM2 > 0) || !(spec.ceilingM > 0.5)) return null;
  const zMin = 0.08;
  const zMax = spec.ceilingM - 0.02;
  if (!(zMax > zMin)) return null;
  const residual = (z: number) => {
    const row = balanceAt(spec, z, tS);
    // The plume replaces what the door and an upper-layer fan carry out.
    // A fan in the lower layer does not take smoke, so it is not in this.
    return row.plumeKgS - row.outKgS - row.fanUpperKgS;
  };
  const samples = 36;
  let zPrev = zMin;
  let rPrev = residual(zMin);
  let root: number | null = null;
  for (let i = 1; i <= samples; i++) {
    const z = zMin + ((zMax - zMin) * i) / samples;
    const r = residual(z);
    if (rPrev < 0 && r >= 0) {
      let lo = zPrev;
      let hi = z;
      for (let k = 0; k < 24; k++) {
        const mid = 0.5 * (lo + hi);
        if (residual(mid) < 0) lo = mid;
        else hi = mid;
      }
      root = 0.5 * (lo + hi);
      break;
    }
    zPrev = z;
    rPrev = r;
  }
  if (root == null) {
    if (residual(zMin) > 0) root = zMin;
    else {
      return {
        interfaceM: spec.ceilingM,
        upperK: AMBIENT_K,
        depthM: 0,
        outKgS: 0,
        plumeKgS: 0,
      };
    }
  }
  const at = balanceAt(spec, root, tS);
  return {
    interfaceM: root,
    upperK: AMBIENT_K + at.riseK,
    depthM: spec.ceilingM - root,
    outKgS: at.outKgS,
    plumeKgS: at.plumeKgS,
  };
}

const SUBSTEP_S = 0.1;

/**
 * Upper-layer gas arriving from a neighbour's vent. Mass and enthalpy of
 * the door jet, not a fire in this room. `oxygenY` is the source layer's
 * oxygen mass fraction.
 */
export interface DoorJetInflow {
  kgS: number;
  tempK: number;
  oxygenY: number;
}

/** Upper-layer gas that left one vent over the step. */
export interface VentedHotGas {
  kg: number;
  tempK: number;
  oxygenY: number;
}

export function stepZone(
  state: ZoneState,
  spec: LayerSpec,
  dt: number,
  sootGPerS = 0,
  jet?: DoorJetInflow | null,
): {
  state: ZoneState;
  ventedSootG: number;
  outByVentKgS: number[];
  /** Upper-layer outflow of each vent over the step, for the next room. */
  hotByVent: VentedHotGas[];
  /** Share of the prescribed release the oxygen burned on the last substep. */
  burnedFraction: number;
  /** Equivalence ratio on that substep, before the lower-oxygen cutoff. */
  phi: number;
} {
  return withFluxMemo(() => stepZoneNow(state, spec, dt, sootGPerS, jet));
}

function stepZoneNow(
  state: ZoneState,
  spec: LayerSpec,
  dt: number,
  sootGPerS = 0,
  jet?: DoorJetInflow | null,
) {
  let z = state.interfaceM;
  let temp = state.upperK;
  let soot = state.sootG;
  let age = state.ageS;
  let yL = oxygenMassFraction(state.lowerO2);
  let yU = oxygenMassFraction(state.upperO2);
  let vented = 0;
  let outByVent = spec.vents.map(() => 0);
  const hotKg = spec.vents.map(() => 0);
  const hotT = spec.vents.map(() => 0);
  const hotY = spec.vents.map(() => 0);
  let burnedFraction = 1;
  let phi = 0;
  let left = Math.max(0, dt);
  const split = fireSplit(spec);
  const q = split.convectedKw;
  const radiantBase = fireRadiantKwM2;
  const jetKgS = jet != null && jet.kgS > 0 ? jet.kgS : 0;
  const jetT = jet != null && jet.tempK > 0 ? jet.tempK : AMBIENT_K;
  const jetY = jet != null && jet.oxygenY > 0 ? jet.oxygenY : O2_AMBIENT_MASS;
  while (left > 1e-9) {
    const slice = Math.min(SUBSTEP_S, left);
    if (split.totalKw > MIN_LAYER_FIRE_KW) age += slice;
    const limited = oxygenLimitedBurn(spec, z, temp, yL, yU, slice);
    const burn = limited.burn;
    burnedFraction = burn.prescribedKw > 0 ? burn.fraction : 1;
    phi = burn.phi;
    const qGas = q * burnedFraction;
    fireRadiantKwM2 = radiantBase * burnedFraction;
    const depth = Math.max(0.02, spec.ceilingM - z);
    const mass = densityKgM3(temp) * spec.areaM2 * depth;
    const plume = limited.plumeKgS;
    const flows = {
      inKgS: limited.inKgS,
      outKgS: limited.outKgS,
      fanLowerKgS: limited.fanLowerKgS,
      fanUpperKgS: limited.fanUpperKgS,
    };
    outByVent = limited.outByVentKgS;
    const rates = limited.hotOutByVentKgS;
    for (let v = 0; v < hotKg.length; v++) {
      const dm = (rates[v] ?? 0) * slice;
      if (!(dm > 0)) continue;
      hotKg[v] = (hotKg[v] ?? 0) + dm;
      hotT[v] = (hotT[v] ?? 0) + dm * temp;
      hotY[v] = (hotY[v] ?? 0) + dm * yU;
    }
    const qLoss = lossPowerKw(spec.boundaries, age, temp);
    const denom = Math.max(mass * CP_KJ_KGK, 1e-3);
    let dT = (qGas - plume * CP_KJ_KGK * (temp - AMBIENT_K) - qLoss) / denom;
    // The jet is already hot. It does not have to be warmed from ambient
    // the way plume air does. m cp (T_jet − T) is the mixing term.
    if (jetKgS > 0) dT += (jetKgS * CP_KJ_KGK * (jetT - temp)) / denom;
    if (dT > 400) dT = 400;
    if (dT < -400) dT = -400;
    const areaRho = Math.max(LEVEL.RHO_AIR * spec.areaM2, 1e-3);
    // Makeup air fills the lower layer. The plume and a fan in that clear
    // air both drain it, so the interface falls. A fan in the smoke is
    // balanced by extra inflow, which lifts the interface. A door jet
    // joins the upper layer, so its volume lowers the interface.
    let dZ = (flows.inKgS - plume - flows.fanLowerKgS) / areaRho;
    if (jetKgS > 0) {
      dZ -= jetKgS / Math.max(densityKgM3(jetT) * spec.areaM2, 1e-3);
    }
    if (dZ > 2) dZ = 2;
    if (dZ < -2) dZ = -2;
    const mL = densityKgM3(AMBIENT_K) * spec.areaM2 * Math.max(z, 0);
    const slicePlume = plume * slice;
    const sliceIn = flows.inKgS * slice;
    const sliceFanL = flows.fanLowerKgS * slice;
    const sliceOut = flows.outKgS * slice;
    const sliceFanU = flows.fanUpperKgS * slice;
    const useL = Math.min(burn.oxygenLowerKgS * slice, slicePlume * yL, yL * mL);
    const useU = Math.min(burn.oxygenUpperKgS * slice, yU * mass);
    const o2L = yL * mL - (slicePlume + sliceFanL) * yL + sliceIn * O2_AMBIENT_MASS;
    let o2U = yU * mass - (sliceOut + sliceFanU) * yU - useU + (slicePlume * yL - useL);
    const mL2 = mL - slicePlume - sliceFanL + sliceIn;
    let mU2 = mass - sliceOut - sliceFanU + slicePlume;
    if (jetKgS > 0) {
      const sliceJet = jetKgS * slice;
      o2U += sliceJet * jetY;
      mU2 += sliceJet;
    }
    yL = mL2 > 1e-4 ? Math.min(1, Math.max(0, o2L / mL2)) : 0;
    yU = mU2 > 1e-4 ? Math.min(1, Math.max(0, o2U / mU2)) : O2_AMBIENT_MASS;
    temp = Math.min(1500, Math.max(AMBIENT_K, temp + dT * slice));
    z = Math.min(spec.ceilingM - 0.02, Math.max(0.05, z + dZ * slice));
    const carried = mass > 1e-6 ? (soot / mass) * flows.outKgS * slice : 0;
    const extracted = mass > 1e-6 ? (soot / mass) * flows.fanUpperKgS * slice : 0;
    const made = Math.max(0, sootGPerS) * slice;
    soot = Math.max(0, soot + made - carried - extracted);
    vented += carried;
    left -= slice;
  }
  return {
    state: { interfaceM: z, upperK: temp, sootG: soot, ageS: age, lowerO2: yL, upperO2: yU },
    ventedSootG: vented,
    outByVentKgS: outByVent,
    hotByVent: hotKg.map((kg, v) => ({
      kg,
      tempK: kg > 0 ? (hotT[v] ?? 0) / kg : AMBIENT_K,
      oxygenY: kg > 0 ? (hotY[v] ?? 0) / kg : O2_AMBIENT_MASS,
    })),
    burnedFraction,
    phi,
  };
}

export interface GridStud {
  id: string;
  x: number;
  y: number;
  level: string;
}

export interface GridWall {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  hasDoor: boolean;
  doorWidth: number;
  /** 0–1 along the wall. Absent means the middle. */
  doorPosition?: number;
  /** Leaf, 0 shut to 1 open. Absent means fully open. */
  openFraction?: number;
  material: string;
  level: string;
}

/** What the building shell does to one indoor–outdoor link. */
export interface FacadeOpening {
  /**
   * A wall has no vent. An exit is one opening: every link that crosses it
   * shares `exitKey`, and the width is counted once.
   */
  kind: 'wall' | 'exit';
  exitKey?: string;
  widthM?: number;
}

export interface Enclosure {
  spec: LayerSpec;
  /**
   * Studs just outside each vent, same order as `spec.vents`. Empty means
   * the soot leaves the building instead of being painted on a stud.
   */
  ventReceivers: string[][];
  /** Walls that bound this room, including shut doors. */
  wallIds: string[];
}

const FACE_MIN_M = 2;
const FACE_MAX_M = 3.4;
/** One diagonal of the 3 m stud grid is 4.24 m. Assumed. A longer link is not a face. */
const DIAGONAL_FACE_MAX_M = 4.5;

/** Where the stud link crosses the wall, 0–1 along the wall. Null when it misses. */
function paramAlongWall(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  wall: GridWall,
): number | null {
  const d1x = bx - ax;
  const d1y = by - ay;
  const d2x = wall.x2 - wall.x1;
  const d2y = wall.y2 - wall.y1;
  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < 1e-10) return null;
  const t = ((wall.x1 - ax) * d2y - (wall.y1 - ay) * d2x) / denom;
  const u = ((wall.x1 - ax) * d1y - (wall.y1 - ay) * d1x) / denom;
  // u includes the wall's ends. A stud row that lands on a junction is still
  // that wall; leaving the ends out turned the food-court corridor into a
  // full-height opening.
  if (t <= 0.01 || t >= 0.99 || u < -0.01 || u > 1.01) return null;
  return u;
}

function segmentsCross(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
): boolean {
  const d1x = bx - ax;
  const d1y = by - ay;
  const d2x = dx - cx;
  const d2y = dy - cy;
  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < 1e-10) return false;
  const t = ((cx - ax) * d2y - (cy - ay) * d2x) / denom;
  const u = ((cx - ax) * d1y - (cy - ay) * d1x) / denom;
  return t > 0.01 && t < 0.99 && u >= -0.01 && u <= 1.01;
}

/**
 * The ceiling, the floor, the walls that actually separate this set of
 * studs, and the openings. No boundary at all (a bare grid, nothing
 * modelled around it) is not an enclosure: the caller keeps the travelling
 * front. A link to a stud outside the set, with no wall and no facade, is
 * a full-height opening. A facade link is a concrete wall unless it
 * crosses an exit, which is one vent of that exit's width with its head
 * at DOOR_SOFFIT_M. A glass wall in `openWallIds` has fallen out, not
 * merely cracked. The vent is GLASS_FALLOUT_AREA_FRACTION of the wall
 * width, still full height, because no hole rectangle is stored. The rest
 * of the face stays glass. A door in that wall is not a second opening.
 */
export function enclosureFromGrid(
  memberIds: readonly string[],
  studs: ReadonlyMap<string, GridStud>,
  neighbors: ReadonlyMap<string, readonly string[]>,
  walls: readonly GridWall[],
  ceilingM: number,
  facade?: (memberId: string, outsideId: string) => FacadeOpening | null,
  openWallIds?: ReadonlySet<string>,
): Enclosure | null {
  if (memberIds.length === 0 || !(ceilingM > 0.5)) return null;
  const members = new Set(memberIds);
  const level = studs.get(memberIds[0] ?? '')?.level ?? 'G';
  const seenPairs = new Set<string>();
  const wallHits = new Map<string, GridWall>();
  const doorLinks = new Map<string, Array<{ id: string; t: number }>>();
  const faceLinks = new Map<string, string[]>();
  const spillReceivers: string[] = [];
  const exitSlots = new Map<string, { widthM: number; receivers: string[] }>();
  const facadeWalls: number[] = [];
  let spillWidth = 0;
  let boundaryLinks = 0;

  for (const id of memberIds) {
    const stud = studs.get(id);
    if (!stud || stud.level !== level) continue;
    for (const nId of neighbors.get(id) ?? []) {
      if (members.has(nId)) continue;
      const other = studs.get(nId);
      if (!other || other.level !== level) continue;
      const reach = Math.hypot(other.x - stud.x, other.y - stud.y);
      // An exit the orthogonal rows miss. The diagonal still carries its soot.
      // It is not a wall area: only the exit slot is recorded.
      if (reach > FACE_MAX_M && reach <= DIAGONAL_FACE_MAX_M) {
        const diag = facade?.(id, nId) ?? null;
        if (diag?.kind === 'exit' && diag.exitKey && (diag.widthM ?? 0) > 0) {
          const slot = exitSlots.get(diag.exitKey) ?? { widthM: diag.widthM ?? 0, receivers: [] };
          slot.receivers.push(nId);
          exitSlots.set(diag.exitKey, slot);
        }
        continue;
      }
      if (reach < FACE_MIN_M || reach > FACE_MAX_M) continue;
      const pair = id < nId ? `${id}|${nId}` : `${nId}|${id}`;
      if (seenPairs.has(pair)) continue;
      seenPairs.add(pair);
      boundaryLinks += 1;
      let wall: GridWall | null = null;
      for (const candidate of walls) {
        if (candidate.level !== level) continue;
        if (
          segmentsCross(
            stud.x,
            stud.y,
            other.x,
            other.y,
            candidate.x1,
            candidate.y1,
            candidate.x2,
            candidate.y2,
          )
        ) {
          wall = candidate;
          break;
        }
      }
      if (wall) {
        wallHits.set(wall.id, wall);
        const t = paramAlongWall(stud.x, stud.y, other.x, other.y, wall);
        if (t != null) {
          const faces = faceLinks.get(wall.id) ?? [];
          faces.push(nId);
          faceLinks.set(wall.id, faces);
          if (wall.hasDoor) {
            const across = doorLinks.get(wall.id) ?? [];
            across.push({ id: nId, t });
            doorLinks.set(wall.id, across);
          }
        }
      } else {
        const face = facade?.(id, nId) ?? null;
        if (face?.kind === 'wall') {
          // The outline, away from an exit. Concrete until the wall table
          // is the reader. The stud outside the wall is not a receiver.
          facadeWalls.push(reach * ceilingM);
        } else if (face?.kind === 'exit' && face.exitKey && (face.widthM ?? 0) > 0) {
          const slot = exitSlots.get(face.exitKey) ?? { widthM: face.widthM ?? 0, receivers: [] };
          slot.receivers.push(nId);
          exitSlots.set(face.exitKey, slot);
        } else {
          spillWidth += reach;
          spillReceivers.push(nId);
        }
      }
    }
  }
  if (boundaryLinks === 0) return null;

  const vents: Vent[] = [];
  const ventReceivers: string[][] = [];
  const boundaries: Boundary[] = [];
  const area = memberIds.length * STUD_AREA_M2;
  // Floor and ceiling. Assumed to be the concrete row: the slab, not the finish.
  boundaries.push({ areaM2: area, lining: LINING.concrete });
  boundaries.push({ areaM2: area, lining: LINING.concrete });
  for (const wallArea of facadeWalls) {
    if (wallArea > 0) boundaries.push({ areaM2: wallArea, lining: LINING.concrete });
  }

  const receiversForDoor = (wall: GridWall): string[] => {
    const links = doorLinks.get(wall.id) ?? [];
    const len = Math.hypot(wall.x2 - wall.x1, wall.y2 - wall.y1);
    if (!(len > 0)) return [];
    const nominal = wall.doorWidth > 0 ? wall.doorWidth : 0.9;
    const doorWidth = nominal * doorOpenFraction(wall);
    const center = wall.doorPosition ?? 0.5;
    const half = doorWidth / (2 * len);
    const inGap = links.filter((link) => Math.abs(link.t - center) <= half + 1e-4);
    if (inGap.length > 0) return [...new Set(inGap.map((link) => link.id))];
    // The opening falls between studs. The nearest link within one stud
    // takes the soot. The rest of the wall does not.
    let best: { id: string; dist: number } | null = null;
    for (const link of links) {
      const dist = Math.abs(link.t - center) * len;
      if (dist > FACE_MAX_M) continue;
      if (!best || dist < best.dist) best = { id: link.id, dist };
    }
    return best ? [best.id] : [];
  };

  const pushHead = (widthM: number, receivers: readonly string[]) => {
    const soffit = Math.min(DOOR_SOFFIT_M, ceilingM);
    if (soffit < ceilingM - RESERVOIR_SOFFIT_GAP_M) {
      vents.push({ widthM, sillM: 0, soffitM: soffit });
    } else {
      vents.push({ widthM, sillM: 0, soffitM: ceilingM });
    }
    ventReceivers.push([...new Set(receivers)]);
  };

  for (const wall of wallHits.values()) {
    const length = Math.hypot(wall.x2 - wall.x1, wall.y2 - wall.y1);
    if (!(length > 0)) continue;
    if (openWallIds?.has(wall.id) && liningForMaterial(wall.material).name === 'glass') {
      const lining = liningForMaterial(wall.material);
      const openWidth = length * GLASS_FALLOUT_AREA_FRACTION;
      if (openWidth > 0) {
        vents.push({ widthM: openWidth, sillM: 0, soffitM: ceilingM });
        ventReceivers.push([...new Set(faceLinks.get(wall.id) ?? [])]);
      }
      const kept = (length - openWidth) * ceilingM;
      if (kept > 0) boundaries.push({ areaM2: kept, lining });
      continue;
    }
    const soffit = Math.min(DOOR_SOFFIT_M, ceilingM);
    // A door belongs to the room whose links cross its gap. The same wall
    // can bound a room further along, and that room does not get the door.
    const across = wall.hasDoor ? receiversForDoor(wall) : [];
    const nominal = wall.doorWidth > 0 ? wall.doorWidth : 0.9;
    const doorWidth = across.length > 0 ? Math.min(length, nominal * doorOpenFraction(wall)) : 0;
    const lining = liningForMaterial(wall.material);
    if (doorWidth > 0 && soffit < ceilingM - RESERVOIR_SOFFIT_GAP_M) {
      vents.push({ widthM: doorWidth, sillM: 0, soffitM: soffit });
      ventReceivers.push(across);
      const wallArea = Math.max(0, length * ceilingM - doorWidth * soffit);
      if (wallArea > 0) boundaries.push({ areaM2: wallArea, lining });
    } else if (doorWidth > 0) {
      spillWidth += doorWidth;
      spillReceivers.push(...across);
      const wallArea = Math.max(0, (length - doorWidth) * ceilingM);
      if (wallArea > 0) boundaries.push({ areaM2: wallArea, lining });
    } else {
      boundaries.push({ areaM2: length * ceilingM, lining });
    }
  }
  if (spillWidth > 0) {
    vents.push({ widthM: spillWidth, sillM: 0, soffitM: ceilingM });
    ventReceivers.push([...new Set(spillReceivers)]);
  }
  for (const slot of exitSlots.values()) pushHead(slot.widthM, slot.receivers);

  return {
    spec: {
      areaM2: area,
      ceilingM,
      vents,
      boundaries,
      fires: [],
    },
    ventReceivers,
    wallIds: [...wallHits.keys()],
  };
}
