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
 * not the loss from the gas. Once a wall is thin enough to be one
 * temperature, that temperature is integrated: ρ c δ stores the heat,
 * the inside film and the fire's radiation warm the sheet, and CFAST's
 * exterior film cools the back. The steady film is that sheet after it
 * has warmed. Which wall counts as a sheet is this engine's choice.
 * CFAST applies the exterior film to every wall.
 * The lower layer stays at the ambient 293 K. That is the usual
 * pre-flashover assumption. The inverse door jet (CFAST TN 1889v1
 * Eq. 4.7) was tried and left out: at the Steckler interface it entrains
 * about 0.005 kg/s, and with the interface on the floor it over-entrains
 * and drops the enthalpy and the soot it would move. Mixing into the
 * lower layer is not in this step. The centre-burner door still carries
 * less mass than Steckler measured. NBSIR 82-2520 puts that on the plume:
 * a fire away from the walls entrains more once the doorway inflow tilts
 * it. Quintiere, Rinkinen and Jones (Combustion Science and Technology 26,
 * 1981) use an entrainment length Z/sin θ for that tilt. The angle was
 * not measured, so the plume stays the vertical Heskestad formula.
 *
 * Gas that leaves through a vent is not mixed back into this room. The
 * part that left the upper layer (the orifice slice whose midpoint is
 * above the interface) is returned as a door jet. The caller deposits
 * that mass in the neighbouring room's upper layer: enthalpy
 * m cp (T_jet − T). That is the vent flow of Eq. 4.1–4.5 changing rooms,
 * not Eq. 4.7. A vent that names the neighbour's layer uses that layer
 * in Eq. 4.1 instead of ambient. Inflow from above the neighbour's
 * interface is the same stream the jet deposits. A room that takes the
 * jet leaves that inflow out of the makeup air. The orifice already
 * includes it, so the interface takes jet volume only for the deposited
 * mass the orifice did not balance. A fire room does not deposit that
 * jet. The orifice stream still enters the upper layer, and it brings
 * its own oxygen, soot and fuel. The flame is credited with that oxygen
 * at the stream's fraction. CO is not a layer species: the stud dose
 * derives it from the soot this stream carries. Subtracting the whole jet volume as
 * well counts that volume twice. Outflow from below the interface is
 * booked in every room, including one that does not take the jet.
 * Unburned fuel and the spill plume stay on the jet.
 *
 * Pyrolysate the plume cannot burn is a species in the upper-layer mass,
 * the way CFAST puts fuel into the layer (`fire.f90` at b869597). The
 * kilograms are the unreleased prescribed heat divided by the wood net
 * heat, 17.5 MJ/kg (EN 1991-1-2 Table E.3), the same figure the flame
 * front uses for a solid. The fraction is those kilograms over ρ(T) A
 * depth, and the fractions of one layer sum with the rest of the
 * mixture, so the fuel cannot pass one kilogram per kilogram. New
 * pyrolysate is mixed in at the ambient temperature, CFAST's
 * `q_firemass`, and the same mass of mixture leaves through the hot
 * vent. A full room then holds a steady fraction instead of a second
 * ledger that grows without a bound. In the receiving room the jet
 * burns against the oxygen the spill plume entrains. The plume is
 * CFAST `poreh_plume` (`flowhorizontal.f90` at b869597): Cm = 0.44,
 * the (T_l/T_u)^(2/3) factor, and the rise from max(sill, source
 * interface) up to the receiving interface. A vent jet starts only
 * once the source layer reaches `tgignt`, ambient plus 200 K
 * (`initialization.f90`). The entrained air joins the receiving upper
 * layer. It is not applied in the room the fuel came from, and it is
 * not the inverse jet, so the source room's heat release stays the
 * oxygen the plume took. A room that already has a fire does not take
 * the jet's carrier mass. Its door is the return flow, so the orifice
 * is that exchange. It does take the fuel. That fuel burns on the oxygen the
 * room's own plume has not taken, and what that oxygen cannot burn
 * stays in the layer.
 *
 * The mass that is created is capped so the compartment equivalence
 * ratio stays at or below 2. φ is the prescribed heat over the
 * fresh-air oxygen supply this step already computes. 2 is an
 * engineering bound, the top of this model's yield blend. ISO/TS
 * 19700's 2 ± 0.2 is the tube-furnace test condition those yields
 * were measured at, and ISO 19706 gives post-flashover only as φ > 1.
 * Neither publishes 2 as a cap on a real compartment. Kawagoe's
 * 0.09 A√H and Eurocode EN 1991-1-2 Eq. E.6 are the oxygen-limited
 * heat release, so neither is the pyrolysis cap: either one would
 * remove the fuel the doorway still carries. CFAST does not reduce a
 * prescribed mass-loss rate when the room is starved, and its guides
 * say that prescription has to be the actual fire. The free-burn sum
 * of the fuel cells is not that prescription.
 *
 * Entrainment uses the part of the hot outflow that sits below the
 * receiving interface. The band runs from max(sill, source interface,
 * neutral plane) up to the soffit. CFAST `spill_plume` entrains a
 * slab only for the rise from that slab to the receiving interface,
 * and a slab entirely above the interface entrains nothing. One
 * aggregated jet uses that share of the jet mass in one poreh call.
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
import {
  CONTENTS_HRRPUA_KW_M2,
  RADIATIVE_FRACTION,
  STUD_AREA_M2,
  WOOD_HEAT_KJ_KG,
} from './flameFront';
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
 * A sheet is treated as one temperature when the Biot number is under
 * 0.1: the drop across the thickness is under a tenth of the drop across
 * the film (Incropera, the lumped-capacitance limit). The film in that
 * test is 4σT³ at ambient, about 5.7 W/m²K, the weakest the exterior
 * radiation can be. k/δ then has to be at least about 57 W/m²K. A fuller
 * film, with the convection and a warm back face, is stricter, and 6 mm
 * glass sits near 0.11 on that fuller film. It still crosses this gate.
 *
 * The gate is this engine's choice. CFAST applies the exterior film to
 * every wall (`iwbound = 3`). The boards that already match a test keep
 * NUREG's k/δ to ambient: the Steckler ceramic fibre and the BE#3
 * Marinite. A back face held at ambient, with no capacity, is the other
 * error. The sheet stores ρ c δ and warms.
 */
const ISOTHERMAL_BIOT = 0.1;

/** True when a penetrated sheet is thin enough to be isothermal. */
function backFaceExposed(lining: Lining, tS: number): boolean {
  if (Math.max(tS, HK_FLOOR_S) < penetrationTimeS(lining)) return false;
  const kOverD = lining.kKwMK / lining.thicknessM;
  return kOverD >= EXTERIOR_RAD_HK_KW_M2K / ISOTHERMAL_BIOT;
}

/** True when this lining is integrated as one temperature at this age. */
export function isothermalSheet(lining: Lining, tS: number): boolean {
  return backFaceExposed(lining, tS);
}

/** Stefan–Boltzmann, kW/m²K⁴. */
export const SIGMA_KW_M2K4 = 5.67e-11;

/**
 * Incident flux from a black upper layer, kW/m². σ T⁴. The gas is already
 * taken as black. ISO 13571:2012 clause 8.2 relates 2.5 kW/m² to a source
 * surface near 200 °C, and σ (473 K)⁴ is about 2.8 kW/m². No view factor:
 * the layer fills the view. That fill is this model's assumption.
 */
export function blackLayerRadiantKwM2(gasK: number): number {
  if (!(gasK > 0)) return 0;
  return SIGMA_KW_M2K4 * gasK ** 4;
}

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
 * reached, so hk runs to ambient. An isothermal sheet's long-time loss
 * conducts across k/δ onto the exterior film. While the sheet is still
 * warming, the step integrates ρ c δ instead of this flux. A board keeps
 * k/δ to ambient. The returned flux is only the
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

function convectionKwM2(gasK: number, sheetK: number): number {
  const across = gasK - sheetK;
  const hConv = (SURFACE_CONVECTION_C_W / 1000) * Math.pow(Math.abs(across), 1 / 3);
  return hConv * across;
}

function radiationKwM2(gasK: number, sheetK: number): number {
  const hRad =
    SURFACE_EMISSIVITY * SIGMA_KW_M2K4 * (gasK * gasK + sheetK * sheetK) * (gasK + sheetK);
  return hRad * (gasK - sheetK);
}

/**
 * A lower-layer surface. Convection is with the gas that touches it. The
 * lower layer is clear, so the upper gas still radiates to that face, and
 * the sheet temperature is the balance of those two films.
 */
type LowerFilms = { toUpperKwM2: number; toLowerKwM2: number };

/** Sheet temperature where lower-gas convection and upper-gas radiation balance the slab. */
function solveLowerFilms(
  hk: number,
  upperK: number,
  lowerK: number,
  radInKwM2: number,
  exposed: boolean,
): LowerFilms {
  if (!(hk > 0)) return { toUpperKwM2: 0, toLowerKwM2: 0 };
  if (!(upperK > AMBIENT_K + 0.05) && !(lowerK > AMBIENT_K + 0.05) && !(radInKwM2 > 0)) {
    return { toUpperKwM2: 0, toLowerKwM2: 0 };
  }
  const convC = SURFACE_CONVECTION_C_W / 1000;
  const sigmaE = SURFACE_EMISSIVITY * SIGMA_KW_M2K4;
  const upper2 = upperK * upperK;
  let lo = AMBIENT_K;
  let hi = Math.max(upperK, lowerK, AMBIENT_K) + 2000;
  for (let i = 0; i < 32; i++) {
    const surfaceK = 0.5 * (lo + hi);
    const convAcross = lowerK - surfaceK;
    const radAcross = upperK - surfaceK;
    const hConv = convC * Math.cbrt(Math.abs(convAcross));
    const hRad = sigmaE * (upper2 + surfaceK * surfaceK) * (upperK + surfaceK);
    const intoSlab = exposed ? sheetThroughKwM2(surfaceK, hk) : hk * (surfaceK - AMBIENT_K);
    const residual = hConv * convAcross + hRad * radAcross + radInKwM2 - intoSlab;
    if (residual > 0) lo = surfaceK;
    else hi = surfaceK;
  }
  const surfaceK = 0.5 * (lo + hi);
  return {
    toUpperKwM2: radiationKwM2(upperK, surfaceK),
    toLowerKwM2: convectionKwM2(lowerK, surfaceK),
  };
}

/**
 * Films versus upper-layer temperature, for one hk and one lower-layer
 * temperature. Knots the step never samples stay unsolved. A repeated wall
 * with the same lining reads the knot instead of bisecting again.
 */
function lowerFilmTable(
  hk: number,
  lowerK: number,
  radInKwM2: number,
  exposed: boolean,
): (upperK: number) => LowerFilms {
  const toUpper = new Float64Array(FLUX_TABLE_N + 1);
  const toLower = new Float64Array(FLUX_TABLE_N + 1);
  const ready = new Uint8Array(FLUX_TABLE_N + 1);
  const span = (FLUX_T_MAX - AMBIENT_K) / FLUX_TABLE_N;
  const knot = (i: number) => {
    if (ready[i] === 1) return;
    ready[i] = 1;
    const gas = AMBIENT_K + ((FLUX_T_MAX - AMBIENT_K) * i) / FLUX_TABLE_N;
    const y = solveLowerFilms(hk, gas, lowerK, radInKwM2, exposed);
    toUpper[i] = y.toUpperKwM2;
    toLower[i] = y.toLowerKwM2;
  };
  return (upperK: number) => {
    if (!(upperK > AMBIENT_K + 0.05) && !(lowerK > AMBIENT_K + 0.05) && !(radInKwM2 > 0)) {
      return { toUpperKwM2: 0, toLowerKwM2: 0 };
    }
    const x = (Math.min(Math.max(upperK, AMBIENT_K), FLUX_T_MAX) - AMBIENT_K) / span;
    const i = Math.min(FLUX_TABLE_N - 1, Math.floor(x));
    knot(i);
    knot(i + 1);
    const t = x - i;
    const up0 = toUpper[i] ?? 0;
    const up1 = toUpper[i + 1] ?? 0;
    const lo0 = toLower[i] ?? 0;
    const lo1 = toLower[i + 1] ?? 0;
    return { toUpperKwM2: up0 + (up1 - up0) * t, toLowerKwM2: lo0 + (lo1 - lo0) * t };
  };
}

/**
 * A lower-layer surface. Convection is with the gas that touches it. The
 * lower layer is clear, so the upper gas still radiates to that face, and
 * the sheet temperature is the balance of those two films. Inside a balance
 * the 32-step solve is tabulated on upper-layer temperature, one table per
 * lining, the way the single-gas film is.
 */
function lowerFilmLookup(
  hk: number,
  lowerK: number,
  radInKwM2: number,
  exposed: boolean,
): (upperK: number) => LowerFilms {
  if (!lowerFilmMemo) return (upperK) => solveLowerFilms(hk, upperK, lowerK, radInKwM2, exposed);
  const key = `${fluxGroup(hk)}|${fluxGroup(lowerK)}|${fluxGroup(radInKwM2)}|${exposed ? 1 : 0}`;
  let at = lowerFilmMemo.get(key);
  if (!at) {
    at = lowerFilmTable(hk, lowerK, radInKwM2, exposed);
    lowerFilmMemo.set(key, at);
  }
  return at;
}

function lowerSurfaceFilms(
  hk: number,
  upperK: number,
  lowerK: number,
  radInKwM2: number,
  exposed: boolean,
): LowerFilms {
  if (!(hk > 0)) return { toUpperKwM2: 0, toLowerKwM2: 0 };
  return lowerFilmLookup(hk, lowerK, radInKwM2, exposed)(upperK);
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
/**
 * Lower-surface films for one balance. Keyed by grouped hk, lower-layer
 * temperature, radiant flux and the exposed flag. The table is upper-layer
 * temperature, filled lazily, the same way `fluxAt` is.
 */
let lowerFilmMemo: Map<
  string,
  (upperK: number) => { toUpperKwM2: number; toLowerKwM2: number }
> | null = null;
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
  const prevLower = lowerFilmMemo;
  const prevRad = fireRadiantKwM2;
  const prevGen = fluxGen;
  fluxSerial += 1;
  fluxGen = fluxSerial;
  fluxMemo = new Map();
  lowerFilmMemo = new Map();
  fireRadiantKwM2 = 0;
  try {
    return body();
  } finally {
    fluxMemo = prevMemo;
    lowerFilmMemo = prevLower;
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

/**
 * The compartment on the other side of a door. Absent means that side is
 * ambient at every height. With a neighbour, the vent pressure is this
 * room's gauge minus the neighbour's gauge, CFAST Eq. 4.1 applied to both
 * layers. `floorPressurePa` is that neighbour's solved floor gauge.
 */
export interface VentOutside {
  interfaceM: number;
  upperK: number;
  floorPressurePa: number;
  /** Lower-layer temperature. Absent means that layer is ambient. */
  lowerK?: number;
  /**
   * Upper-layer oxygen mass fraction. Absent means ambient. The bare
   * stream is credited at this fraction, not as fresh air and not as none.
   */
  upperO2?: number;
  /** Soot in that layer, grams per kilogram of mixture. Absent means none. */
  sootGPerKg?: number;
  /** Unburned fuel mass fraction in that layer. Absent means none. */
  fuelY?: number;
}

/**
 * Pressure coefficient at zero incidence for a vertical wall of a low-rise
 * building. Swami and Chandra recommend 0.6; their fit then scales it by
 * the wind angle. ASHRAE Transactions 94(1), 1988.
 */
export const FACADE_CP_NORMAL = 0.6;

/**
 * Normalized wall coefficient, square plan. Swami and Chandra, FSEC-CR-163-86
 * Eq. 2.1, published as ASHRAE Transactions 94(1):243–266 (1988). α is the
 * angle between the outward normal and the direction the wind comes from,
 * 0 when the wind blows straight onto the face, π when it blows off it.
 * The side ratio is 1, so G = ln(S) is 0 and those terms drop out. The
 * result is 1 at α = 0, within the fit.
 */
export function swamiChandraNormalCp(incidenceRad: number): number {
  const alpha = Math.abs(incidenceRad);
  const half = alpha / 2;
  const s = Math.sin(alpha);
  const arg =
    1.248 -
    0.703 * Math.sin(half) -
    1.175 * s * s +
    0.769 * Math.cos(half) +
    0.717 * Math.cos(half) * Math.cos(half);
  if (!(arg > 0)) return 0;
  return Math.log(arg);
}

/**
 * Coefficient for one outdoor face. `windFaceRad` is the outward normal,
 * 0 along +x, counter-clockwise. `windToRad` is the direction the wind
 * travels, the same convention. The value follows the wind angle instead
 * of switching at 45°.
 */
export function facadeCp(windFaceRad: number, windToRad: number): number {
  const from = windToRad + Math.PI;
  const incidence = Math.atan2(Math.sin(from - windFaceRad), Math.cos(from - windFaceRad));
  return FACADE_CP_NORMAL * swamiChandraNormalCp(incidence);
}

/**
 * Wind pressure on an outdoor opening, Pa. p = Cp · ½ ρ∞ U², the form used
 * for a vent in smoke control (Klote and Milke, Handbook of Smoke Control
 * Engineering). U is the speed at the opening. There is no height profile.
 * Positive pressure is on the windward side, so flow enters that face.
 * Still air is 0.
 */
export function facadeWindPa(windFaceRad: number, windToRad: number, speedMs: number): number {
  if (!(speedMs > 0) || !Number.isFinite(speedMs) || !Number.isFinite(windFaceRad)) return 0;
  return facadeCp(windFaceRad, windToRad) * 0.5 * LEVEL.RHO_AIR * speedMs * speedMs;
}

export interface Vent {
  widthM: number;
  sillM: number;
  soffitM: number;
  /** The other compartment. Absent means the vent opens to ambient. */
  outside?: VentOutside;
  /**
   * A shaft between storeys. Its flow is internal: the building budget
   * counts the doors and the fans, and the shaft only when the two
   * storeys disagree.
   */
  shaft?: boolean;
  /**
   * Net added to this vent's orifice, kg/s. Positive enters the room.
   * A shaft uses it to cancel the gap between the two storeys' orifices
   * so the kilogram that leaves one arrives in the other. The orifice
   * itself still carries the hot stream.
   */
  imposedKgS?: number;
  /**
   * Gauge the ambient side holds because of wind, Pa. Subtracted from the
   * inside pressure only when `outside` is absent, so a neighbour room is
   * never overwritten. Positive is windward. Zero and absent are still air,
   * and that path is the one the goldens run.
   */
  windPa?: number;
  /**
   * Outward normal of an opening that sees the weather, radians, 0 along +x.
   * The engine turns this and the wind into `windPa`. An internal opening
   * leaves it unset, so wind does not cross a partition.
   */
  windFace?: number;
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

/**
 * Cm in the spill-plume entrainment. Poreh, Morgan, Marshall and
 * Harrison, Fire Safety Journal 30 (1998). CFAST `poreh_plume` uses
 * 0.44, the low end of the note's 0.44–0.66 range.
 */
export const SPILL_PLUME_CM = 0.44;

/**
 * CFAST `tgignt` (`initialization.f90` at b869597): `t_ref + 200`. A vent
 * jet does not burn until the source upper layer is this hot. Below it
 * the fuel is only carried.
 */
export const SPILL_IGNITION_K = AMBIENT_K + 200;

/**
 * Air the doorway spill entrains from the lower layer, kg/s. CFAST
 * `poreh_plume` (`flowhorizontal.f90` at b869597):
 * 0.44 (T_l/T_u)^(2/3) (g ρ_l² / (cp T_l))^(1/3) hdot^(1/3) w^(2/3) z,
 * with hdot = cp (T_u − T_l) m. The rise `z` is the receiving interface
 * minus max(sill, source interface). The jet's own mass is not included.
 */
export function spillPlumeEntrainmentKgS(
  jetKgS: number,
  jetTempK: number,
  widthM: number,
  riseM: number,
  lowerTempK = AMBIENT_K,
): number {
  if (!(jetKgS > 0) || !(widthM > 0) || !(riseM > 0) || !(jetTempK > lowerTempK)) return 0;
  const qKw = CP_KJ_KGK * (jetTempK - lowerTempK) * jetKgS;
  const rho = densityKgM3(lowerTempK);
  const factor = Math.pow((LEVEL.G * rho * rho) / (CP_KJ_KGK * lowerTempK), 1 / 3);
  const tFactor = Math.pow(lowerTempK / jetTempK, 2 / 3);
  return tFactor * SPILL_PLUME_CM * factor * Math.pow(qKw, 1 / 3) * Math.pow(widthM, 2 / 3) * riseM;
}

/**
 * Height the spill starts from. CFAST `spill_plume` uses
 * max(vent bottom, source interface) as the foot of `zd`.
 */
export function spillOriginM(sillM: number, sourceInterfaceM: number): number {
  const sill = sillM > 0 ? sillM : 0;
  const source = sourceInterfaceM > 0 ? sourceInterfaceM : 0;
  return Math.max(sill, source);
}

/**
 * Rise of a spill through the receiving lower layer, metres. CFAST
 * `zd = max(0, z_receiving − max(sill, z_source))`. At or below the
 * origin the flow is layer into layer and the plume does not entrain.
 */
export function spillRiseM(interfaceM: number, originM: number): number {
  if (!(interfaceM > originM)) return 0;
  return interfaceM - originM;
}

/**
 * Share of a hot outflow band that can still entrain. The band is the
 * gas that is leaving: from max(sill, source interface, neutral plane)
 * up to the soffit. CFAST entrains a slab only while the receiving
 * interface is above that slab. Above the soffit the whole band is in
 * the lower layer. At or below the bottom of the band, none of it is.
 * A missing or inverted band is the whole jet, so a caller that has
 * not measured the band does not silently drop the plume.
 */
export function spillBandShare(interfaceM: number, lowEdgeM: number, soffitM: number): number {
  if (!(soffitM > lowEdgeM)) return 1;
  if (interfaceM >= soffitM) return 1;
  if (interfaceM <= lowEdgeM) return 0;
  return (interfaceM - lowEdgeM) / (soffitM - lowEdgeM);
}

/** Upper-layer mixture mass, kg. Fuel is a species inside this, not beside it. */
export function upperMixtureKg(tempK: number, areaM2: number, depthM: number): number {
  if (!(areaM2 > 0) || !(depthM > 0) || !(tempK > 0)) return 0;
  return densityKgM3(tempK) * areaM2 * depthM;
}

/** Kilograms of fuel per kilogram of upper-layer mixture. Above 1 is not a fraction. */
export function layerFuelFraction(state: ZoneState, areaM2: number, ceilingM: number): number {
  const depth = ceilingM > state.interfaceM ? ceilingM - state.interfaceM : 0;
  const mass = upperMixtureKg(state.upperK, areaM2, depth);
  const fuel = state.fuelKg != null && state.fuelKg > 0 ? state.fuelKg : 0;
  if (!(mass > 0)) return 0;
  return fuel / mass;
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

/**
 * Engineering bound on the equivalence ratio of the mass that is
 * created. 2 is the top of this model's yield blend. ISO/TS 19700's
 * 2 ± 0.2 is the tube-furnace condition those yields were measured
 * at, not a bound on a compartment. ISO 19706 gives post-flashover
 * only as φ > 1. Above 2 the free-burn prescription is more mass
 * than a starved room pyrolyses.
 */
export const POST_FLASHOVER_PHI_MAX = 2;

/**
 * Pyrolysis heat whose mass is allowed into the layer, kW. The heat
 * the room releases is still the oxygen limit. This cap only bounds
 * the fuel species. No fresh-air supply means no new pyrolysate: a
 * sealed room does not keep the free-burn mass-loss rate.
 */
export function cappedPyrolysisKw(prescribedKw: number, supplyKw: number): number {
  if (!(prescribedKw > 0)) return 0;
  const supply = supplyKw > 0 && Number.isFinite(supplyKw) ? supplyKw : 0;
  return Math.min(prescribedKw, POST_FLASHOVER_PHI_MAX * supply);
}

/**
 * Share of a prescribed release that is actually pyrolysed. No recorded
 * ratio (φ of 0) keeps the prescription, which is also the first frame.
 * Above 2 the mass is 2/φ of the release. No fresh air (φ infinite)
 * pyrolyses nothing.
 */
export function pyrolysisFraction(phi: number): number {
  if (!(phi > 0)) return 1;
  if (!Number.isFinite(phi)) return 0;
  if (phi <= POST_FLASHOVER_PHI_MAX) return 1;
  return POST_FLASHOVER_PHI_MAX / phi;
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
 * of that and the oxygen. The unburned part is carried as pyrolysate and
 * does not burn in this room: the plume already took the oxygen the flame
 * can use. φ uses the fresh lower-layer air only. Upper-layer gas is
 * recirculated.
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

/**
 * Share of the upper-layer oxygen a flame on the clamp may burn. It is 1
 * on the floor and for the first 2 mm, which is as far as one full slice
 * lifts the interface, and 0 once the interface is 5 cm above the floor.
 * A smooth step covers the rest. A hard cut at the floor chatters: the
 * full slice lifts the interface by about a millimetre and the next
 * slice drops back to fresh air. Five centimetres is the sliver the
 * clamp book already treats as marginal. Above it a real lower layer
 * keeps the inflow-only sizing.
 */
function floorLayerWeight(interfaceM: number): number {
  const depth = interfaceM - INTERFACE_FLOOR_M;
  const holdM = 0.002;
  const bandM = 0.05;
  if (!(depth > holdM)) return 1;
  if (depth >= bandM) return 0;
  const x = (depth - holdM) / (bandM - holdM);
  return 1 - x * x * (3 - 2 * x);
}

/**
 * Oxygen a new floor flame would stand in. Inside the clamp fade the
 * flame stands in the upper layer once that credit is at least half.
 * Above that it stands in the lower air. A missing fraction is ambient.
 */
export function ignitionOxygenY(
  interfaceM: number,
  upperY: number | undefined,
  lowerY: number | undefined,
): number {
  const standsInUpper = floorLayerWeight(interfaceM) >= 0.5;
  return oxygenMassFraction(standsInUpper ? upperY : lowerY);
}

/**
 * A new stud may light when that oxygen is on the burning side of CFAST's
 * cutoff. The logistic is one half at the centre of the cutoff. At and
 * below that centre the sealed room's own flame has already gone out, and
 * the front must not light another stud in the room.
 */
export function oxygenAllowsFlame(yO2: number): boolean {
  return lowerOxygenCoefficient(yO2) > 0.5;
}

export interface LimitedBurn {
  burn: LayerBurn;
  plumeKgS: number;
  inKgS: number;
  outKgS: number;
  outByVentKgS: number[];
  /** Inflow of each vent, same order. Already inside `inKgS`. */
  inByVentKgS: number[];
  /** Upper-layer outflow of each vent, same order. The door jet. */
  hotOutByVentKgS: number[];
  /**
   * Inflow drawn from above a neighbour's interface, kg/s. It is already
   * inside `inKgS`. It is not fresh lower-layer air.
   */
  farUpperInKgS: number;
  /** Temperature of that inflow, kelvin. Ambient when there is none. */
  farUpperInK: number;
  /** Oxygen in that inflow, kg/s. Already inside `farUpperInKgS`. */
  farUpperO2KgS: number;
  /** Soot in that inflow, g/s. */
  farUpperSootGPerS: number;
  /** Unburned fuel in that inflow, kg/s. */
  farUpperFuelKgS: number;
  /** Inflow enthalpy, kg·K/s. Mass times the temperature it arrived at. */
  inKT: number;
  /** Outflow enthalpy, kg·K/s. Mass times the layer it left. */
  outKT: number;
  fanUpperKgS: number;
  fanLowerKgS: number;
  /** Inflow that enters the lower layer, kg/s. Already inside `inKgS`. */
  lowerInKgS: number;
  /** Temperature of that inflow, kelvin. */
  lowerInK: number;
  /** Neutral plane of this opening, m. The hot outflow starts here. */
  neutralM: number;
  /** Solved floor gauge of this room, Pa. A neighbour's door reads it. */
  floorPressurePa: number;
}

/** Vent and fan flows the pressure residual needs, kg/s. No per-vent split. */
interface PressureScalars {
  inKgS: number;
  outKgS: number;
  hotOutKgS: number;
  farUpperInKgS: number;
  fanUpperKgS: number;
  fanLowerKgS: number;
  /** Inflow below this room's interface, kg/s. Already inside `inKgS`. */
  lowerInKgS: number;
  /** That inflow times its temperature, kg·K/s. */
  lowerInKT: number;
  /**
   * Inflow from above a neighbour's interface, times its temperature,
   * kg·K/s. Already inside the mass of `farUpperInKgS`.
   */
  farUpperInKT: number;
  /** Oxygen in the far upper inflow, kg/s. Already inside `farUpperInKgS`. */
  farUpperInO2KgS: number;
}

/** A steady balance. Heating and cooling pass the mass the step actually gains. */
const ZERO_MASS_RATE: (flows: PressureScalars) => number = () => 0;

/**
 * The oxygen limit tied to the vents. Lower-layer air available this step
 * is the door inflow and fan makeup, plus the air the interface can still
 * descend through. At the floor the inflow is what the lower layer can
 * still give.
 *
 * That air is the flame. CFAST Eq. 3.13 limits the burning to the oxygen
 * the plume can take, and the plume has to be the fire that oxygen
 * supports. Above the floor the oxygen that counts is the lower-layer
 * air the plume entrains, already shared and capped by the supply. Air
 * the plume does not take, including the last centimetre of a large
 * floor, does not enlarge the flame. Sizing the flame on the prescribed
 * pyrolysis lets it entrain the oxygen stored in the upper layer and
 * burn the free-burn rate for a step, so above the floor that stored
 * oxygen only finishes a flame the inflow already accounts for. On the
 * floor the flame stands in the upper layer. The release walks down from
 * the prescribed fire to the oxygen that layer's plume can take, and the
 * inflow keeps its own fraction. It is taken out of the upper term, so
 * the same oxygen is not burned twice. The extra pyrolysis is carried as
 * fuel and can burn where a door jet meets oxygen. It is not a larger
 * flame in this room. The mass of that extra fuel is capped at twice the
 * fresh-air supply (`cappedPyrolysisKw`). φ = 2 there is an engineering
 * bound, the ceiling of the yield blend, not a published limit on a
 * compartment.
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
  /**
   * The caller is depositing the neighbour's upper gas as a door jet.
   * That inflow is then left out of the fresh-air supply. Absent, the
   * orifice keeps it, which is the fire room that does not take the carrier.
   */
  jetBringsUpper = false,
  /**
   * Gas mass the vents must carry, kg/s. Absent means a steady balance,
   * inflow equal to outflow. A heating step passes the mass change of
   * the upper volume m/ρ(T): the plume, the spill, a deposited jet and
   * stored fuel, at the new temperature, not only the gas already
   * upstairs. The candidate flows must not be fed back into that rate,
   * and the interface drop is applied after the root. Counting the drop
   * inside the root makes the outflow run away.
   */
  massRateKgS?: (flows: PressureScalars) => number,
  /** Lower-layer temperature. Absent means ambient, and the door keeps ρ(Ta). */
  lowerK = AMBIENT_K,
): LimitedBurn {
  const flows = balancedFlows(
    spec.vents,
    interfaceM,
    upperK,
    spec.fans ?? [],
    massRateKgS ?? ZERO_MASS_RATE,
    lowerK,
  );
  return limitedFrom(spec, interfaceM, upperK, yLower, yUpper, dt, jetBringsUpper, flows, lowerK);
}

function limitedFrom(
  spec: LayerSpec,
  interfaceM: number,
  upperK: number,
  yLower: number,
  yUpper: number,
  dt: number,
  jetBringsUpper: boolean,
  flows: Flows & { floorPressurePa: number },
  lowerK = AMBIENT_K,
): LimitedBurn {
  const supplied = flameSupply(spec, interfaceM, upperK, yLower, yUpper, dt, jetBringsUpper, flows);
  return {
    burn: supplied.burn,
    plumeKgS: supplied.plumeKgS,
    inKgS: flows.inKgS,
    outKgS: flows.outKgS,
    outByVentKgS: flows.outByVent,
    inByVentKgS: flows.inByVent,
    hotOutByVentKgS: flows.hotOutByVent,
    farUpperInKgS: flows.farUpperInKgS,
    farUpperInK: flows.farUpperInKgS > 0 ? flows.farUpperInKT / flows.farUpperInKgS : AMBIENT_K,
    farUpperO2KgS: flows.farUpperInO2KgS,
    farUpperSootGPerS: flows.farUpperInSootGPerS,
    farUpperFuelKgS: flows.farUpperInFuelKgS,
    inKT: flows.inKT,
    outKT: flows.outKT,
    fanUpperKgS: flows.fanUpperKgS,
    fanLowerKgS: flows.fanLowerKgS,
    lowerInKgS: flows.lowerInKgS,
    lowerInK: flows.lowerInKgS > 0 ? flows.lowerInKT / flows.lowerInKgS : AMBIENT_K,
    neutralM: neutralPlaneM(interfaceM, upperK, flows.floorPressurePa, lowerK),
    floorPressurePa: flows.floorPressurePa,
  };
}

/**
 * The last prescribed-plume sum and the inputs it was taken from. One
 * substep solves the pressure root several times at the same interface
 * and the same fires, and each solve reads this sum. A fire whose value
 * changes, in place or in a new array, misses on the field compare.
 */
const plumeGuessFires: { heatKw: number; diameterM: number; baseM: number | undefined }[] = [];
let plumeGuessCount = -1;
let plumeGuessZ = NaN;
let plumeGuessChi = NaN;
let plumeGuessKgS = 0;

/** Heskestad entrainment of the prescribed fires at the interface, kg/s. */
function prescribedPlumeKgS(fires: readonly FirePlume[], interfaceM: number, chi: number): number {
  if (interfaceM === plumeGuessZ && chi === plumeGuessChi && fires.length === plumeGuessCount) {
    let same = true;
    for (let i = 0; i < fires.length; i++) {
      const fire = fires[i]!;
      const kept = plumeGuessFires[i]!;
      if (
        fire.heatKw !== kept.heatKw ||
        fire.diameterM !== kept.diameterM ||
        fire.baseM !== kept.baseM
      ) {
        same = false;
        break;
      }
    }
    if (same) return plumeGuessKgS;
  }
  let plume = 0;
  for (const fire of fires) {
    if (!(fire.heatKw > 0) || !(fire.diameterM > 0)) continue;
    plume += heskestadEntrainmentKgS(
      fire.heatKw,
      heightAboveFuelM(interfaceM, fire.baseM),
      fire.diameterM,
      chi,
    );
  }
  for (let i = 0; i < fires.length; i++) {
    const fire = fires[i]!;
    const kept = plumeGuessFires[i];
    if (kept) {
      kept.heatKw = fire.heatKw;
      kept.diameterM = fire.diameterM;
      kept.baseM = fire.baseM;
    } else {
      plumeGuessFires.push({ heatKw: fire.heatKw, diameterM: fire.diameterM, baseM: fire.baseM });
    }
  }
  plumeGuessCount = fires.length;
  plumeGuessZ = interfaceM;
  plumeGuessChi = chi;
  plumeGuessKgS = plume;
  return plume;
}

function flameSupply(
  spec: LayerSpec,
  interfaceM: number,
  upperK: number,
  yLower: number,
  yUpper: number,
  dt: number,
  jetBringsUpper: boolean,
  flows: PressureScalars,
): { burn: LayerBurn; plumeKgS: number } {
  const chi = chiOf(spec);
  const slice = dt > 0 ? dt : SUBSTEP_S;
  const rho = densityKgM3(AMBIENT_K);
  // The air the interface can still descend through. A pyramidal section
  // uses that volume; a rectangular room is the floor area times the height.
  const sliverM = Math.max(0, interfaceM - INTERFACE_FLOOR_M);
  const descendM3 = spec.crossSection
    ? volumeBetweenM3(spec, INTERFACE_FLOOR_M, interfaceM)
    : Math.max(spec.areaM2, 0) * sliverM;
  const descendKgS = (rho * descendM3) / slice;
  const freshIn = jetBringsUpper ? Math.max(0, flows.inKgS - flows.farUpperInKgS) : flows.inKgS;
  // The whole sliver, credited as fresh air, is a period-2 once the
  // interface is on the floor. The flame grows, the plume consumes the
  // sliver, the next substep is back on the clamp, and the step after
  // grows the sliver again. The door reverses with it. The height the
  // prescribed plume can lower the interface in one substep is
  // plume·slice / (ρ·A) at the floor. A sliver no taller than that is
  // credited to its midpoint, the mean of the interface and the clamp.
  // A deeper layer cannot be consumed in one substep, and its full
  // height stands.
  const plumeGuess = sliverM > 0 ? prescribedPlumeKgS(spec.fires, interfaceM, chi) : 0;
  const floorArea = sectionAreaM2(spec, INTERFACE_FLOOR_M);
  const consumableM =
    floorArea > 0 && plumeGuess > 0 ? (plumeGuess * slice) / (rho * floorArea) : 0;
  const flameDescendKgS =
    sliverM > 0 && consumableM > 0 && sliverM <= consumableM ? 0.5 * descendKgS : descendKgS;
  const airCap = Math.max(0, freshIn - flows.fanLowerKgS) + flameDescendKgS;
  let prescribed = 0;
  for (const fire of spec.fires) if (fire.heatKw > 0) prescribed += fire.heatKw;
  const yL = yLower > 0 ? yLower : 0;
  // The cap's mass is unchanged. A fire room's far stream is part of it,
  // and that part is not lower-layer air: its oxygen is its own fraction.
  // A deposited jet has already left the stream out of `freshIn`.
  const stream = jetBringsUpper ? 0 : Math.max(0, flows.farUpperInKgS);
  const yStream =
    stream > 0 && flows.farUpperInKgS > 0
      ? Math.max(0, flows.farUpperInO2KgS) / flows.farUpperInKgS
      : yL;
  const streamInCap = Math.min(stream, airCap);
  const yMix = airCap > 1e-9 ? (yL * (airCap - streamInCap) + yStream * streamInCap) / airCap : yL;
  // lowerAirKgS is the lower-layer stream the prescribed plumes entrain,
  // shared down to airCap. The oxygen in it is the flame. The burned
  // kilowatts of this call are not used: they still include upper-layer gas.
  // On the floor that entrainment is only the last few centimetres, so a
  // neighbour stream sitting in the cap would not reach the flame. The part
  // of the stream the plume did not already entrain is still its air.
  const entrained = layerBurn(spec.fires, interfaceM, yMix, yUpper, chi, airCap);
  const extraMass = Math.max(0, streamInCap - entrained.lowerAirKgS);
  const freshKw =
    oxygenCapacityKw(entrained.lowerAirKgS, yMix) + oxygenCapacityKw(extraMass, yStream);
  const layerWeight = floorLayerWeight(interfaceM);
  const yU = yUpper > 0 ? yUpper : 0;
  // A zero flame entrains nothing, so the walk starts at the prescribed
  // fire and comes down to the oxygen the upper plume can actually take.
  // The inflow is already in freshKw. The upper term is the room's layer.
  // The logistic inside the oxygen capacity is the only switch on the
  // oxygen fraction. How much of that layer the flame may use fades with
  // the interface, so the release does not step as the clamp is crossed.
  const close = (
    rawIn: LayerBurn,
    flamesIn: typeof spec.fires,
  ): { burn: LayerBurn; plumeKgS: number } => {
    const extraAfter = Math.max(0, streamInCap - rawIn.lowerAirKgS);
    const streamKw = Math.min(
      oxygenCapacityKw(extraAfter, yStream),
      Math.max(0, rawIn.burnedKw - oxygenCapacityKw(rawIn.lowerAirKgS, yMix)),
    );
    const streamO2 = DELTA_H_O2_KJ_PER_KG > 0 ? streamKw / DELTA_H_O2_KJ_PER_KG : 0;
    const burn: LayerBurn = {
      prescribedKw: prescribed,
      burnedKw: rawIn.burnedKw,
      phi: equivalenceRatio(
        prescribed,
        oxygenSupplyKw(rawIn.lowerAirKgS, yMix) + oxygenSupplyKw(extraAfter, yStream),
      ),
      fraction: prescribed > 0 ? rawIn.burnedKw / prescribed : 1,
      lowerAirKgS: rawIn.lowerAirKgS,
      oxygenLowerKgS: rawIn.oxygenLowerKgS + streamO2,
      oxygenUpperKgS: Math.max(0, rawIn.oxygenUpperKgS - streamO2),
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
    for (const fire of flamesIn) {
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
    return { burn, plumeKgS: plume };
  };
  const freshSupply = () => {
    const freshFraction = prescribed > 0 ? Math.min(1, freshKw / prescribed) : 1;
    const flames =
      freshFraction < 1
        ? spec.fires.map((fire) => ({
            heatKw: fire.heatKw > 0 ? fire.heatKw * freshFraction : 0,
            diameterM: fire.diameterM,
            baseM: fire.baseM,
          }))
        : spec.fires;
    return close(layerBurn(flames, interfaceM, yMix, yUpper, chi, airCap), flames);
  };
  const floorSupply = () => {
    const at = (qKw: number) => {
      const fraction = Math.min(1, qKw / prescribed);
      const trial =
        fraction < 0.999
          ? spec.fires.map((fire) => ({
              heatKw: fire.heatKw > 0 ? fire.heatKw * fraction : 0,
              diameterM: fire.diameterM,
              baseM: fire.baseM,
            }))
          : spec.fires;
      const burned = layerBurn(trial, interfaceM, yMix, yU, chi, airCap);
      const upperKw = burned.oxygenUpperKgS * DELTA_H_O2_KJ_PER_KG;
      return { trial, burned, next: Math.min(prescribed, freshKw + upperKw) };
    };
    let flames = spec.fires;
    let raw = entrained;
    let q = prescribed;
    let step = at(q);
    for (let i = 0; i < 8; i++) {
      raw = step.burned;
      flames = step.trial;
      if (Math.abs(step.next - q) <= Math.max(1, 0.02 * Math.max(q, 1))) break;
      q = step.next;
      step = at(q);
    }
    // Land on the oxygen the last plume could take, then read that flame.
    if (Math.abs(step.next - q) > Math.max(1, 0.02 * Math.max(q, 1))) {
      step = at(step.next);
      raw = step.burned;
      flames = step.trial;
    }
    return close(raw, flames);
  };
  const wantsLayer = prescribed > freshKw + 1 && yU > 0;
  if (!(layerWeight > 0) || !wantsLayer) return freshSupply();
  if (layerWeight >= 1) return floorSupply();
  const floor = floorSupply();
  const fresh = freshSupply();
  const mix = (floorN: number, freshN: number) => layerWeight * floorN + (1 - layerWeight) * freshN;
  const burnedKw = mix(floor.burn.burnedKw, fresh.burn.burnedKw);
  const floorPhi = Number.isFinite(floor.burn.phi) ? floor.burn.phi : 1e6;
  const freshPhi = Number.isFinite(fresh.burn.phi) ? fresh.burn.phi : 1e6;
  return {
    burn: {
      prescribedKw: prescribed,
      burnedKw,
      phi: mix(floorPhi, freshPhi),
      fraction: prescribed > 0 ? burnedKw / prescribed : 1,
      lowerAirKgS: mix(floor.burn.lowerAirKgS, fresh.burn.lowerAirKgS),
      oxygenLowerKgS: mix(floor.burn.oxygenLowerKgS, fresh.burn.oxygenLowerKgS),
      oxygenUpperKgS: mix(floor.burn.oxygenUpperKgS, fresh.burn.oxygenUpperKgS),
    },
    plumeKgS: mix(floor.plumeKgS, fresh.plumeKgS),
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
  /**
   * Wall this face belongs to. An isothermal sheet's temperature is stored
   * under this id, so a later wall does not inherit it when the list changes.
   * A face with no id is not remembered.
   */
  id?: string;
  /**
   * Which part of the room this face is. The floor exchanges with the lower
   * layer, the ceiling with the upper layer, and a wall is split at the
   * interface. Absent means the whole face is charged to the upper gas.
   */
  place?: 'floor' | 'ceiling' | 'wall';
}

/** Area of one face in each layer, m². An untagged face is all upper. */
export function layerContactM2(
  boundary: Boundary,
  interfaceM: number,
  ceilingM: number,
): { upperM2: number; lowerM2: number } {
  const area = boundary.areaM2 > 0 ? boundary.areaM2 : 0;
  if (!(area > 0)) return { upperM2: 0, lowerM2: 0 };
  if (boundary.place === 'floor') return { upperM2: 0, lowerM2: area };
  if (boundary.place === 'ceiling') return { upperM2: area, lowerM2: 0 };
  if (boundary.place === 'wall') {
    const height = ceilingM > 1e-6 ? ceilingM : 0;
    const upperFrac = height > 0 ? Math.min(1, Math.max(0, (height - interfaceM) / height)) : 1;
    const upper = area * upperFrac;
    return { upperM2: upper, lowerM2: area - upper };
  }
  return { upperM2: area, lowerM2: 0 };
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
  /**
   * Horizontal area against height. Absent means a rectangular room of
   * `areaM2` from the floor to `ceilingM`. CFAST user's guide §4.4: between
   * two listed heights the section is a pyramid (the width-to-depth ratio
   * stays constant), and the layer height is the height whose volume above
   * it is the upper-layer volume.
   */
  crossSection?: CrossSection;
}

/**
 * Horizontal area at a list of heights. Heights ascend from the floor.
 * CFAST `CROSS_SECT_HEIGHTS` and `CROSS_SECT_AREAS`.
 */
export interface CrossSection {
  heightsM: readonly number[];
  areasM2: readonly number[];
}

export interface ZoneState {
  /** Height of the interface above the floor, metres. */
  interfaceM: number;
  upperK: number;
  /** Soot in the upper layer, grams. */
  sootG: number;
  /**
   * Unburned pyrolysate in the upper layer, kilograms. Absent on an old
   * state means none. This is a species inside the mixture mass
   * ρ(T) A depth, not a second ledger, so it stays at or below that mass.
   * The kilograms are unreleased prescribed heat divided by the wood net
   * heat, 17.5 MJ/kg.
   */
  fuelKg?: number;
  /** Seconds the fire has been burning, for the lining loss. */
  ageS: number;
  /** Oxygen mass fraction in the lower layer. Absent on an old state means ambient. */
  lowerO2?: number;
  /** Oxygen mass fraction in the upper layer. Absent on an old state means ambient. */
  upperO2?: number;
  /**
   * Lower-layer temperature, kelvin. Absent means ambient. The floor and
   * the wall below the interface exchange with this gas, and a door uses
   * its density.
   */
  lowerK?: number;
  /**
   * Temperature of each isothermal sheet, kelvin, keyed by wall id.
   * Absent means every such sheet is still at ambient. A board is not
   * stored. A wall that leaves the boundary list keeps the entry, so the
   * next face does not inherit it and a layer that forms again can read
   * the heat the wall still holds.
   */
  sheetK?: Readonly<Record<string, number>>;
  /**
   * Burned fraction of the previous slice. A flame that has gone out in a
   * layer past the oxygen cutoff must not relight for one slice. Absent
   * means the flame was not out.
   */
  lastBurnFraction?: number;
}

export interface SteadyLayer {
  interfaceM: number;
  upperK: number;
  depthM: number;
  outKgS: number;
  plumeKgS: number;
  /** Neutral plane of the balanced door, metres above the floor. */
  neutralM: number;
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
    fuelKg: 0,
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

interface BoundTerm {
  boundary: Boundary;
  at: FluxAt;
  hk: number;
  exposed: boolean;
  /** Lower-layer temperature the cached film table was built for. */
  filmLower: number;
  filmAt: ((upperK: number) => LowerFilms) | null;
  /** Interface and ceiling the cached contact split was taken at. */
  contactZ: number;
  contactCeiling: number;
  upperM2: number;
  lowerM2: number;
}

interface BoundLoss {
  boundaries: readonly Boundary[];
  tS: number;
  rad: number;
  gen: number;
  terms: BoundTerm[];
}

let boundLoss: BoundLoss | null = null;

/** Steady film of each layer's contact, kW. An untagged face is all upper. */
function contactLossKw(
  boundaries: readonly Boundary[],
  tS: number,
  upperK: number,
  lowerK: number,
  interfaceM: number,
  ceilingM: number,
): { upperKw: number; lowerKw: number; lowerM2: number } {
  const rad = fireRadiantKwM2;
  let bound = boundLoss;
  if (
    !bound ||
    bound.boundaries !== boundaries ||
    bound.tS !== tS ||
    bound.rad !== rad ||
    bound.gen !== fluxGen
  ) {
    const terms: BoundTerm[] = [];
    for (const boundary of boundaries) {
      if (!(boundary.areaM2 > 0)) continue;
      terms.push({
        boundary,
        at: fluxAt(boundary.lining, tS),
        hk: effectiveHeatLossKwM2K(boundary.lining, tS),
        exposed: backFaceExposed(boundary.lining, tS),
        filmLower: Number.NaN,
        filmAt: null,
        contactZ: Number.NaN,
        contactCeiling: Number.NaN,
        upperM2: 0,
        lowerM2: 0,
      });
    }
    bound = { boundaries, tS, rad, gen: fluxGen, terms };
    boundLoss = bound;
  }
  let upperKw = 0;
  let lowerKw = 0;
  let lowerM2 = 0;
  const terms = bound.terms;
  for (let i = 0; i < terms.length; i++) {
    const term = terms[i];
    if (!term) continue;
    // The balance bisects the rise at one interface, so the split is reused.
    if (term.contactZ !== interfaceM || term.contactCeiling !== ceilingM) {
      const split = layerContactM2(term.boundary, interfaceM, ceilingM);
      term.contactZ = interfaceM;
      term.contactCeiling = ceilingM;
      term.upperM2 = split.upperM2;
      term.lowerM2 = split.lowerM2;
    }
    if (term.upperM2 > 0) upperKw += term.upperM2 * term.at(upperK);
    if (term.lowerM2 > 0) {
      // The balance samples this face at dozens of upper temperatures.
      // The table is built once for the lower temperature; the later
      // samples read a knot, the same way `term.at` does.
      let filmAt = term.filmAt;
      if (!filmAt || term.filmLower !== lowerK) {
        filmAt = lowerFilmLookup(term.hk, lowerK, rad, term.exposed);
        term.filmAt = filmAt;
        term.filmLower = lowerK;
      }
      const parts = filmAt(upperK);
      upperKw += term.lowerM2 * parts.toUpperKwM2;
      lowerKw += term.lowerM2 * parts.toLowerKwM2;
      lowerM2 += term.lowerM2;
    }
  }
  return { upperKw, lowerKw, lowerM2 };
}

/**
 * Heat the gas loses on this slice, and the sheet temperatures after it.
 * A board uses the steady film. An isothermal sheet is one temperature:
 * ρ c δ dT/dt equals the inside film, plus the fire's radiation on the
 * area, minus the exterior film. The gas is charged only the inside film.
 * The radiation never entered the gas. The sheet starts at ambient, so a
 * cold sheet takes more from the gas than the steady film does. The
 * balance still uses that steady film. It is the same sheet once it has
 * warmed. Glass is taken as opaque: the part of a flame's short-wave
 * radiation that a real pane would transmit outdoors is absorbed here
 * with χQ/A. That transmission is not in this step.
 *
 * The temperature is kept under the wall id. A face with no id uses the
 * steady film, because a temperature stored by position is handed to the
 * next wall when a pane leaves the list.
 *
 * A wall in `hold` is one partition with a layer on the other side. This
 * room still loses the inside film. The temperature does not move here:
 * the other side is added once, and there is no outdoor film on that back
 * face. `gainKjM2` collects this side's film and radiation, kJ/m².
 */
function sheetFilmKwM2(gasK: number, sheetK: number): number {
  const across = gasK - sheetK;
  const hConv = (SURFACE_CONVECTION_C_W / 1000) * Math.pow(Math.abs(across), 1 / 3);
  const hRad =
    SURFACE_EMISSIVITY * SIGMA_KW_M2K4 * (gasK * gasK + sheetK * sheetK) * (gasK + sheetK);
  return (hConv + hRad) * across;
}

function stepSheetLoss(
  boundaries: readonly Boundary[],
  sheetK: Readonly<Record<string, number>> | undefined,
  tS: number,
  upperK: number,
  lowerK: number,
  interfaceM: number,
  ceilingM: number,
  slice: number,
  hold?: ReadonlySet<string>,
  gainKjM2?: Record<string, number>,
): {
  lossKw: number;
  lowerLossKw: number;
  lowerM2: number;
  sheetK?: Readonly<Record<string, number>>;
} {
  let exposed = false;
  for (const boundary of boundaries) {
    if (boundary.areaM2 > 0 && boundary.id && backFaceExposed(boundary.lining, tS)) {
      exposed = true;
      break;
    }
  }
  if (!exposed) {
    const steady = contactLossKw(boundaries, tS, upperK, lowerK, interfaceM, ceilingM);
    return { lossKw: steady.upperKw, lowerLossKw: steady.lowerKw, lowerM2: steady.lowerM2, sheetK };
  }
  const rad = fireRadiantKwM2;
  const next: Record<string, number> = sheetK ? { ...sheetK } : {};
  let upperKw = 0;
  let lowerKw = 0;
  let lowerM2 = 0;
  for (const boundary of boundaries) {
    if (!(boundary.areaM2 > 0)) continue;
    const contact = layerContactM2(boundary, interfaceM, ceilingM);
    const area = contact.upperM2 + contact.lowerM2;
    if (!(area > 0)) continue;
    lowerM2 += contact.lowerM2;
    if (!boundary.id || !backFaceExposed(boundary.lining, tS)) {
      const at = fluxAt(boundary.lining, tS);
      if (contact.upperM2 > 0) upperKw += contact.upperM2 * at(upperK);
      if (contact.lowerM2 > 0) {
        const parts = lowerSurfaceFilms(
          effectiveHeatLossKwM2K(boundary.lining, tS),
          upperK,
          lowerK,
          rad,
          backFaceExposed(boundary.lining, tS),
        );
        upperKw += contact.lowerM2 * parts.toUpperKwM2;
        lowerKw += contact.lowerM2 * parts.toLowerKwM2;
      }
      continue;
    }
    const stored = next[boundary.id];
    const ts = stored != null && stored > 0 ? stored : AMBIENT_K;
    const filmU = sheetFilmKwM2(upperK, ts);
    const convL = convectionKwM2(lowerK, ts);
    const radL = radiationKwM2(upperK, ts);
    const perM2 = (filmU * contact.upperM2 + (convL + radL) * contact.lowerM2) / area;
    upperKw += filmU * contact.upperM2 + radL * contact.lowerM2;
    lowerKw += convL * contact.lowerM2;
    if (hold?.has(boundary.id)) {
      if (gainKjM2) {
        gainKjM2[boundary.id] = (gainKjM2[boundary.id] ?? 0) + (perM2 + rad) * slice;
      }
      continue;
    }
    const store = boundary.lining.rhoKgM3 * boundary.lining.cKjKgK * boundary.lining.thicknessM;
    const warmed = ts + (slice * (perM2 + rad - exteriorFluxKwM2(ts))) / Math.max(store, 1e-6);
    next[boundary.id] = Math.min(1500, Math.max(AMBIENT_K, warmed));
  }
  return { lossKw: upperKw, lowerLossKw: lowerKw, lowerM2, sheetK: next };
}

/**
 * A sheet no layer is stepping. Both faces see ambient: the inside film
 * and the exterior film. A 6 mm pane stores about 13.6 kJ/m²K, so this is
 * several minutes, not a step. The slice is the layer's 0.1 s.
 */
export function coolUnclaimedSheet(tempK: number, lining: Lining, dtS: number): number {
  if (!(tempK > AMBIENT_K) || !(dtS > 0)) return Math.max(tempK, 0);
  const store = lining.rhoKgM3 * lining.cKjKgK * lining.thicknessM;
  if (!(store > 0)) return tempK;
  let ts = tempK;
  let left = dtS;
  while (left > 1e-9) {
    const slice = Math.min(0.1, left);
    const flux = sheetFilmKwM2(AMBIENT_K, ts) - exteriorFluxKwM2(ts);
    ts = Math.min(1500, Math.max(AMBIENT_K, ts + (slice * flux) / store));
    left -= slice;
  }
  return ts;
}

/**
 * Put temperatures the walls already hold onto a zone that does not have
 * them. A fresh layer would otherwise start those sheets at ambient. A
 * temperature the zone already has is left as it is. Walls with no id are
 * not copied.
 */
export function withRememberedSheets(
  zone: ZoneState,
  boundaries: readonly Boundary[],
  remembered: Readonly<Record<string, number>> | undefined,
): ZoneState {
  if (!remembered) return zone;
  let sheetK: Record<string, number> | undefined;
  let added = false;
  for (const boundary of boundaries) {
    const id = boundary.id;
    if (!id) continue;
    const have = zone.sheetK?.[id];
    if (have != null && have > AMBIENT_K) continue;
    const kept = remembered[id];
    if (!(kept > AMBIENT_K)) continue;
    if (!added) {
      sheetK = zone.sheetK ? { ...zone.sheetK } : {};
      added = true;
    }
    if (sheetK) sheetK[id] = kept;
  }
  return added && sheetK ? { ...zone, sheetK } : zone;
}

function densityKgM3(tempK: number): number {
  return RHO_T / Math.max(tempK, 1);
}

/**
 * Horizontal area at height z. Below the first listed height and above the
 * last, the area stays at the nearest listed value (CFAST user's guide §4.4).
 * Between two heights the section is a pyramid, so the linear scale
 * √A is linear in height and the area is the square of that scale.
 */
export function sectionAreaM2(spec: LayerSpec, zM: number): number {
  const cs = spec.crossSection;
  const floor = Math.max(spec.areaM2, 0);
  if (!cs) return floor;
  const n = Math.min(cs.heightsM.length, cs.areasM2.length);
  if (n <= 0) return floor;
  const z = Math.min(Math.max(zM, 0), spec.ceilingM);
  const h0 = cs.heightsM[0] ?? 0;
  const a0 = Math.max(cs.areasM2[0] ?? floor, 0);
  if (z <= h0) return a0;
  for (let i = 1; i < n; i++) {
    const h1 = cs.heightsM[i] ?? h0;
    const a1 = Math.max(cs.areasM2[i] ?? a0, 0);
    const hPrev = cs.heightsM[i - 1] ?? h0;
    const aPrev = Math.max(cs.areasM2[i - 1] ?? a0, 0);
    if (z <= h1) {
      if (!(h1 > hPrev)) return a1;
      const t = (z - hPrev) / (h1 - hPrev);
      const scale = Math.sqrt(aPrev) + (Math.sqrt(a1) - Math.sqrt(aPrev)) * t;
      return scale * scale;
    }
  }
  return Math.max(cs.areasM2[n - 1] ?? floor, 0);
}

/** Volume of a pyramidal band. Equal areas reduce to a prism. */
function frustumM3(heightM: number, area0M2: number, area1M2: number): number {
  if (!(heightM > 0)) return 0;
  const a0 = Math.max(area0M2, 0);
  const a1 = Math.max(area1M2, 0);
  return (heightM / 3) * (a0 + a1 + Math.sqrt(a0 * a1));
}

/** Gas volume from z0 up to z1. A rectangular room is area times height. */
function volumeBetweenM3(spec: LayerSpec, z0M: number, z1M: number): number {
  const z0 = Math.min(Math.max(z0M, 0), spec.ceilingM);
  const z1 = Math.min(Math.max(z1M, 0), spec.ceilingM);
  if (!(z1 > z0)) return 0;
  if (!spec.crossSection) return Math.max(spec.areaM2, 0) * (z1 - z0);
  const marks = [z0];
  const n = Math.min(spec.crossSection.heightsM.length, spec.crossSection.areasM2.length);
  for (let i = 0; i < n; i++) {
    const h = spec.crossSection.heightsM[i] ?? 0;
    if (h > z0 && h < z1) marks.push(h);
  }
  marks.push(z1);
  let volume = 0;
  for (let i = 0; i < marks.length - 1; i++) {
    const lo = marks[i] ?? z0;
    const hi = marks[i + 1] ?? z1;
    volume += frustumM3(hi - lo, sectionAreaM2(spec, lo), sectionAreaM2(spec, hi));
  }
  return volume;
}

/**
 * Upper-layer volume, from the interface to the ceiling. CFAST integrates
 * the cross-section from the ceiling down until the volume is filled.
 * A layer thinner than 0.02 m of floor area keeps that floor so the mass
 * used by the energy step does not vanish.
 */
export function upperLayerVolumeM3(spec: LayerSpec, interfaceM: number): number {
  const above = volumeBetweenM3(spec, interfaceM, spec.ceilingM);
  const floor = Math.max(spec.areaM2, 0) * 0.02;
  return Math.max(above, floor);
}

/**
 * Height where the inside-outside pressure difference is zero.
 * Below the interface the difference is the solved floor value. Above it
 * the hydrostatic slope is (ρ_lower − ρ_upper) g, CFAST Eq. 4.1. A floor
 * pressure below the outside air puts the plane above the interface.
 */
export function neutralPlaneM(
  interfaceM: number,
  upperK: number,
  floorPressurePa: number,
  lowerK = AMBIENT_K,
): number {
  const slope = (densityKgM3(lowerK) - densityKgM3(upperK)) * LEVEL.G;
  if (!(slope > 1e-9)) return interfaceM;
  return interfaceM - floorPressurePa / slope;
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
  /** Inflow from above a neighbour's interface, kg/s. Already inside `inKgS`. */
  farUpperInKgS: number;
  /** That inflow times its temperature, kg·K/s. */
  farUpperInKT: number;
  /** Oxygen in that inflow, kg/s. Already inside `farUpperInKgS`. */
  farUpperInO2KgS: number;
  /** Soot in that inflow, g/s. */
  farUpperInSootGPerS: number;
  /** Unburned fuel in that inflow, kg/s. */
  farUpperInFuelKgS: number;
  /** Inflow that enters below this room's interface, kg/s. Already inside `inKgS`. */
  lowerInKgS: number;
  /** That inflow times its temperature, kg·K/s. */
  lowerInKT: number;
  /** Every inflow times its temperature, kg·K/s. */
  inKT: number;
  /** Every outflow times its temperature, kg·K/s. */
  outKT: number;
}

interface Flows extends SliceFlows {
  /** Outflow of each vent, same order as the spec. */
  outByVent: number[];
  /** Inflow of each vent, same order as the spec. Already inside `inKgS`. */
  inByVent: number[];
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
 * layer, at that layer's temperature. The mass flow is that density
 * times the volume still moving at the room pressure. Soot leaves only with
 * the upper-layer stream. CFAST filtering starts off (TN 1889v1 §4.3), so
 * none of that soot is caught.
 */
export function mechanicalExtract(
  fans: readonly MechanicalVent[],
  interfaceM: number,
  upperK: number,
  floorPressurePa: number,
  lowerK = AMBIENT_K,
): { upperKgS: number; lowerKgS: number } {
  let upper = 0;
  let lower = 0;
  const rhoL = densityKgM3(lowerK);
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

const ventMarks = [0, 0, 0, 0];
const ventScratch: SliceFlows = {
  inKgS: 0,
  outKgS: 0,
  hotOutKgS: 0,
  farUpperInKgS: 0,
  farUpperInKT: 0,
  farUpperInO2KgS: 0,
  farUpperInSootGPerS: 0,
  farUpperInFuelKgS: 0,
  lowerInKgS: 0,
  lowerInKT: 0,
  inKT: 0,
  outKT: 0,
};

/** Species of a neighbour upper layer. Absent oxygen is ambient; soot and fuel are none. */
function farMix(outside: VentOutside | undefined): {
  yO2: number;
  sootGPerKg: number;
  fuelY: number;
} {
  const yO2 =
    outside?.upperO2 != null && outside.upperO2 >= 0
      ? Math.min(1, outside.upperO2)
      : O2_AMBIENT_MASS;
  const sootGPerKg = outside?.sootGPerKg != null && outside.sootGPerKg > 0 ? outside.sootGPerKg : 0;
  const fuelY = outside?.fuelY != null && outside.fuelY > 0 ? Math.min(1, outside.fuelY) : 0;
  return { yO2, sootGPerKg, fuelY };
}

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
  outside: VentOutside | undefined,
  upperK: number,
  lowerK: number,
  windPa: number,
): void {
  if (!(z1 > z0 + 1e-9)) return;
  const p0in = pressureAt(z0, interfaceM, dP0, rhoL, rhoU);
  const p1in = pressureAt(z1, interfaceM, dP0, rhoL, rhoU);
  const farLower =
    outside?.lowerK != null && outside.lowerK > 0 ? densityKgM3(outside.lowerK) : rhoA;
  const farUpper = outside ? densityKgM3(outside.upperK) : rhoU;
  // A neighbour owns the far gauge. Wind is only the ambient side, and a
  // zero is the same subtraction the vent made before wind existed.
  const p0 = outside
    ? p0in - pressureAt(z0, outside.interfaceM, outside.floorPressurePa, farLower, farUpper)
    : windPa !== 0
      ? p0in - windPa
      : p0in;
  const p1 = outside
    ? p1in - pressureAt(z1, outside.interfaceM, outside.floorPressurePa, farLower, farUpper)
    : windPa !== 0
      ? p1in - windPa
      : p1in;
  if (p0 * p1 < 0 && p1 !== p0) {
    const zN = z0 + ((z1 - z0) * (0 - p0)) / (p1 - p0);
    // Split whenever the neutral plane is strictly inside the slice.
    // A plane that falls within a micron of an end used to be left mixed,
    // and the slice was then called an outflow if either end was positive.
    // That dropped the inflow for one step and the burn followed it.
    const pad = Math.min(1e-6, (z1 - z0) * 0.25);
    if (zN > z0 + pad && zN < z1 - pad) {
      addSliceFlows(
        into,
        z0,
        zN,
        interfaceM,
        dP0,
        rhoL,
        rhoU,
        rhoA,
        widthM,
        outside,
        upperK,
        lowerK,
        windPa,
      );
      addSliceFlows(
        into,
        zN,
        z1,
        interfaceM,
        dP0,
        rhoL,
        rhoU,
        rhoA,
        widthM,
        outside,
        upperK,
        lowerK,
        windPa,
      );
      return;
    }
  }
  if (p0 === 0 && p1 === 0) return;
  // The end farther from the plane owns a slice that was not split.
  const outflow = Math.abs(p0) >= Math.abs(p1) ? p0 > 0 : p1 > 0;
  const mid = (z0 + z1) / 2;
  // Inflow from a neighbour is that room's layer. An opening to ambient
  // keeps the outside density.
  const rho = outflow
    ? mid > interfaceM
      ? rhoU
      : rhoL
    : outside
      ? mid > outside.interfaceM
        ? densityKgM3(outside.upperK)
        : farLower
      : rhoA;
  const mass = orificeSliceKgS(widthM, z1 - z0, p0, p1, rho);
  if (outflow) {
    into.outKgS += mass;
    // Above the interface the gas is the hot layer. Below it the outflow
    // is lower-layer air, and that is not a door jet.
    if (mid > interfaceM) {
      into.hotOutKgS += mass;
      into.outKT += mass * upperK;
    } else into.outKT += mass * lowerK;
  } else {
    into.inKgS += mass;
    if (outside && mid > outside.interfaceM) {
      into.farUpperInKgS += mass;
      into.farUpperInKT += mass * outside.upperK;
      const mix = farMix(outside);
      into.farUpperInO2KgS += mass * mix.yO2;
      into.farUpperInSootGPerS += mass * mix.sootGPerKg;
      into.farUpperInFuelKgS += mass * mix.fuelY;
      into.inKT += mass * outside.upperK;
    } else if (mid <= interfaceM) {
      into.lowerInKgS += mass;
      const tin = outside?.lowerK != null && outside.lowerK > 0 ? outside.lowerK : AMBIENT_K;
      into.lowerInKT += mass * tin;
      into.inKT += mass * tin;
    } else {
      const tin = outside?.lowerK != null && outside.lowerK > 0 ? outside.lowerK : AMBIENT_K;
      into.inKT += mass * tin;
    }
  }
}

function accumulateVent(
  into: SliceFlows,
  vent: Vent,
  interfaceM: number,
  dP0: number,
  rhoL: number,
  rhoU: number,
  rhoA: number,
  upperK: number,
  lowerK: number,
): void {
  if (vent.imposedKgS != null && Number.isFinite(vent.imposedKgS) && vent.imposedKgS !== 0) {
    const rate = vent.imposedKgS;
    if (rate >= 0) {
      into.inKgS += rate;
      into.farUpperInKgS += rate;
      const tin =
        vent.outside?.upperK != null && vent.outside.upperK > 0 ? vent.outside.upperK : AMBIENT_K;
      into.farUpperInKT += rate * tin;
      const mix = farMix(vent.outside);
      into.farUpperInO2KgS += rate * mix.yO2;
      into.farUpperInSootGPerS += rate * mix.sootGPerKg;
      into.farUpperInFuelKgS += rate * mix.fuelY;
      into.inKT += rate * tin;
    } else {
      into.outKgS += -rate;
      into.hotOutKgS += -rate;
      into.outKT += -rate * upperK;
    }
  }
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
  const far = vent.outside;
  if (far && far.interfaceM > sill && far.interfaceM < soffit) {
    ventMarks[count] = far.interfaceM;
    count += 1;
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
  if (count === 4) {
    for (let i = 1; i < 4; i++) {
      const key = ventMarks[i] ?? sill;
      let j = i;
      while (j > 0 && (ventMarks[j - 1] ?? sill) > key) {
        ventMarks[j] = ventMarks[j - 1] ?? sill;
        j -= 1;
      }
      ventMarks[j] = key;
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
      far,
      upperK,
      lowerK,
      vent.shaft || vent.outside || vent.windPa == null || vent.windPa === 0 ? 0 : vent.windPa,
    );
  }
}

function ventFlows(
  vents: readonly Vent[],
  interfaceM: number,
  upperK: number,
  dP0: number,
  lowerK = AMBIENT_K,
): Flows {
  const flows: Flows = {
    inKgS: 0,
    outKgS: 0,
    hotOutKgS: 0,
    farUpperInKgS: 0,
    farUpperInKT: 0,
    farUpperInO2KgS: 0,
    farUpperInSootGPerS: 0,
    farUpperInFuelKgS: 0,
    lowerInKgS: 0,
    lowerInKT: 0,
    inKT: 0,
    outKT: 0,
    outByVent: vents.map(() => 0),
    inByVent: vents.map(() => 0),
    hotOutByVent: vents.map(() => 0),
    fanUpperKgS: 0,
    fanLowerKgS: 0,
  };
  const rhoU = densityKgM3(upperK);
  const rhoL = densityKgM3(lowerK);
  const rhoA = LEVEL.RHO_AIR;
  for (let v = 0; v < vents.length; v++) {
    const vent = vents[v];
    if (!vent) continue;
    const before = flows.outKgS;
    const beforeIn = flows.inKgS;
    const beforeHot = flows.hotOutKgS;
    accumulateVent(flows, vent, interfaceM, dP0, rhoL, rhoU, rhoA, upperK, lowerK);
    flows.outByVent[v] = flows.outKgS - before;
    flows.inByVent[v] = flows.inKgS - beforeIn;
    flows.hotOutByVent[v] = flows.hotOutKgS - beforeHot;
  }
  return flows;
}

/**
 * Vent sums by floor pressure for one room state. One substep solves the
 * pressure root several times on the same vents, interface and
 * temperatures, with only the mass rate changed, and each bisection
 * starts on the same pressures. Active only inside `stepZone`.
 */
interface VentSumMemo {
  vents: readonly Vent[];
  fans: readonly MechanicalVent[];
  interfaceM: number;
  upperK: number;
  lowerK: number;
  rhoL: number;
  rhoU: number;
  rhoA: number;
  byPressure: Map<number, PressureScalars>;
}

let ventSumMemo: VentSumMemo | null = null;

function ventSumsFor(
  vents: readonly Vent[],
  interfaceM: number,
  upperK: number,
  fans: readonly MechanicalVent[],
  rhoL: number,
  rhoU: number,
  rhoA: number,
  lowerK: number,
): Map<number, PressureScalars> | null {
  const memo = ventSumMemo;
  if (!memo) return null;
  if (
    memo.vents !== vents ||
    (memo.fans !== fans && (memo.fans.length > 0 || fans.length > 0)) ||
    memo.interfaceM !== interfaceM ||
    memo.upperK !== upperK ||
    memo.lowerK !== lowerK ||
    memo.rhoL !== rhoL ||
    memo.rhoU !== rhoU ||
    memo.rhoA !== rhoA
  ) {
    memo.vents = vents;
    memo.fans = fans;
    memo.interfaceM = interfaceM;
    memo.upperK = upperK;
    memo.lowerK = lowerK;
    memo.rhoL = rhoL;
    memo.rhoU = rhoU;
    memo.rhoA = rhoA;
    memo.byPressure.clear();
  }
  return memo.byPressure;
}

function withVentSumMemo<T>(body: () => T): T {
  const prev = ventSumMemo;
  ventSumMemo = {
    vents: [],
    fans: [],
    interfaceM: Number.NaN,
    upperK: Number.NaN,
    lowerK: Number.NaN,
    rhoL: Number.NaN,
    rhoU: Number.NaN,
    rhoA: Number.NaN,
    byPressure: new Map(),
  };
  try {
    return body();
  } finally {
    ventSumMemo = prev;
  }
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
  massRateKgS: (flows: PressureScalars) => number,
  lowerK = AMBIENT_K,
): number {
  // A signed zero is left to the direct sum.
  const memo =
    dP0 !== 0 ? ventSumsFor(vents, interfaceM, upperK, fans, rhoL, rhoU, rhoA, lowerK) : null;
  // No mass-rate callback writes to the flows it is handed, so a memo
  // entry is handed over as it is.
  let scalars = memo?.get(dP0);
  if (!scalars) {
    scalars = ventSums(vents, interfaceM, upperK, dP0, fans, rhoL, rhoU, rhoA, lowerK);
    memo?.set(dP0, scalars);
  }
  // CFAST's pressure equation. in − out − fans = dM/dt. The caller
  // passes dM/dt, and it does not depend on this candidate. A steady
  // layer passes zero, so the root is the old inflow = outflow.
  return (
    scalars.inKgS -
    scalars.outKgS -
    scalars.fanUpperKgS -
    scalars.fanLowerKgS -
    massRateKgS(scalars)
  );
}

function ventSums(
  vents: readonly Vent[],
  interfaceM: number,
  upperK: number,
  dP0: number,
  fans: readonly MechanicalVent[],
  rhoL: number,
  rhoU: number,
  rhoA: number,
  lowerK: number,
): PressureScalars {
  ventScratch.inKgS = 0;
  ventScratch.outKgS = 0;
  ventScratch.hotOutKgS = 0;
  ventScratch.farUpperInKgS = 0;
  ventScratch.farUpperInKT = 0;
  ventScratch.farUpperInO2KgS = 0;
  ventScratch.farUpperInSootGPerS = 0;
  ventScratch.farUpperInFuelKgS = 0;
  ventScratch.lowerInKgS = 0;
  ventScratch.lowerInKT = 0;
  ventScratch.inKT = 0;
  ventScratch.outKT = 0;
  for (let v = 0; v < vents.length; v++) {
    const vent = vents[v];
    if (!vent) continue;
    accumulateVent(ventScratch, vent, interfaceM, dP0, rhoL, rhoU, rhoA, upperK, lowerK);
  }
  const extracted = mechanicalExtract(fans, interfaceM, upperK, dP0, lowerK);
  // Copy before the mass callback. It solves the burn and the sheet loss,
  // and a nested vent pass would reuse this scratch.
  return {
    inKgS: ventScratch.inKgS,
    outKgS: ventScratch.outKgS,
    hotOutKgS: ventScratch.hotOutKgS,
    farUpperInKgS: ventScratch.farUpperInKgS,
    fanUpperKgS: extracted.upperKgS,
    fanLowerKgS: extracted.lowerKgS,
    lowerInKgS: ventScratch.lowerInKgS,
    lowerInKT: ventScratch.lowerInKT,
    farUpperInKT: ventScratch.farUpperInKT,
    farUpperInO2KgS: ventScratch.farUpperInO2KgS,
  };
}

function balancedFlows(
  vents: readonly Vent[],
  interfaceM: number,
  upperK: number,
  fans: readonly MechanicalVent[] = [],
  massRateKgS: (flows: PressureScalars) => number = ZERO_MASS_RATE,
  lowerK = AMBIENT_K,
): Flows & { floorPressurePa: number } {
  const at = (p: number) => ({
    ...withFans(
      ventFlows(vents, interfaceM, upperK, p, lowerK),
      mechanicalExtract(fans, interfaceM, upperK, p, lowerK),
    ),
    floorPressurePa: p,
  });
  // No orifice to relieve the room. The fan is read at zero pressure
  // difference, so it stays at its nominal flow. A sealed volume would
  // climb until the fan stalled; this model does not grow that pressure.
  if (vents.length === 0) return at(0);
  const rhoU = densityKgM3(upperK);
  const rhoL = densityKgM3(lowerK);
  const rhoA = LEVEL.RHO_AIR;
  const netAt = (p: number) =>
    pressureNet(vents, interfaceM, upperK, p, fans, rhoL, rhoU, rhoA, massRateKgS, lowerK);
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
  // No pressure in the bracket carries this mass change. The jet correction
  // can ask for more inflow than any opening will pass. Keep the steady
  // balance for that step rather than a gauge of thousands of pascals.
  if ((nLo < 0 && nHi < 0) || (nLo > 0 && nHi > 0)) {
    if (massRateKgS !== ZERO_MASS_RATE) {
      return balancedFlows(vents, interfaceM, upperK, fans, ZERO_MASS_RATE);
    }
    return at(nLo < 0 ? lo : hi);
  }
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
  /** Neutral plane of this door balance, metres above the floor. */
  neutralM: number;
}

function energyKw(
  spec: LayerSpec,
  tS: number,
  plumeKgS: number,
  riseK: number,
  interfaceM: number,
): number {
  const gas = AMBIENT_K + Math.max(0, riseK);
  // The steady check has no lower temperature. Only the upper contact is
  // in this balance, and an untagged slab is still the whole face.
  const loss = contactLossKw(spec.boundaries, tS, gas, AMBIENT_K, interfaceM, spec.ceilingM);
  return plumeKgS * CP_KJ_KGK * Math.max(0, riseK) + loss.upperKw;
}

export function balanceAt(spec: LayerSpec, interfaceM: number, tS: number): Balance {
  const plume = plumeKgS(spec, interfaceM);
  const q = fireSplit(spec).convectedKw;
  // Loss rises with temperature, so the rise that spends the fire is unique.
  let lo = 0;
  let hi = 20;
  while (energyKw(spec, tS, plume, hi, interfaceM) < q && hi < 4000) hi *= 2;
  for (let i = 0; i < 32; i++) {
    const mid = 0.5 * (lo + hi);
    if (energyKw(spec, tS, plume, mid, interfaceM) < q) lo = mid;
    else hi = mid;
  }
  const rise = 0.5 * (lo + hi);
  const upperK = AMBIENT_K + rise;
  const flows = balancedFlows(spec.vents, interfaceM, upperK, spec.fans ?? []);
  return {
    plumeKgS: plume,
    outKgS: flows.outKgS,
    inKgS: flows.inKgS,
    fanUpperKgS: flows.fanUpperKgS,
    riseK: rise,
    neutralM: neutralPlaneM(interfaceM, upperK, flows.floorPressurePa),
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
        neutralM: spec.ceilingM,
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
    neutralM: at.neutralM,
  };
}

const SUBSTEP_S = 0.1;

/**
 * Upper-layer gas arriving from a neighbour's vent. Mass and enthalpy of
 * the door jet, not a fire in this room. `oxygenY` is the source layer's
 * oxygen mass fraction. `fuelY` is the unburned pyrolysate in that
 * mixture, kilograms of fuel per kilogram of mixture. Absent means none.
 * `originM` is max(sill, source interface) and `widthM` is the vent
 * width, both for the spill plume. `lowEdgeM` and `soffitM` are the
 * hot outflow band. Absent means the whole jet can entrain.
 * `fuelOnly` means the room already solves its door, so the carrier
 * mass is not added again and only the fuel is. The neighbour gauge on
 * that door is the return flow. A room with no fire of its own takes
 * the carrier, and then the gauge's upper-layer inflow is left out of
 * the orifice so the jet is the only copy.
 */
export interface DoorJetInflow {
  kgS: number;
  tempK: number;
  oxygenY: number;
  fuelY?: number;
  originM?: number;
  widthM?: number;
  lowEdgeM?: number;
  soffitM?: number;
  fuelOnly?: boolean;
}

/**
 * Gas in both layers, kg. Upper mass is ρ(T) times the layer volume the
 * energy step uses. The lower layer is at `lowerK`, and ambient when the
 * caller leaves it out. This is the mass the pressure balance conserves.
 */
export function gasMassKg(
  spec: LayerSpec,
  interfaceM: number,
  upperK: number,
  lowerK = AMBIENT_K,
): number {
  const upper = densityKgM3(upperK) * upperLayerVolumeM3(spec, interfaceM);
  const lower = spec.crossSection
    ? volumeBetweenM3(spec, 0, interfaceM)
    : Math.max(spec.areaM2, 0) * Math.max(interfaceM, 0);
  return upper + densityKgM3(lowerK) * lower;
}

/**
 * Upper temperature that makes the two-layer mass `massKg` at a fixed
 * interface. Returns null when the lower layer already weighs more than the
 * target. A room sitting on the floor clamp uses this so the stored
 * density matches the mass the vents actually moved: the pressure root
 * may stop short of the relief the clamp requires, and the clamped
 * volume would otherwise keep mass the vents did not move.
 */
function upperTemperatureForMassKg(
  spec: LayerSpec,
  interfaceM: number,
  lowerK: number,
  massKg: number,
): number | null {
  const upperVolume = upperLayerVolumeM3(spec, interfaceM);
  const lowerMass = densityKgM3(lowerK) * lowerVolumeM3(spec, interfaceM);
  const upperMass = massKg - lowerMass;
  if (!(upperVolume > 0) || !(upperMass > 0)) return null;
  const fitted = (RHO_T * upperVolume) / upperMass;
  if (!Number.isFinite(fitted)) return null;
  return Math.min(1500, Math.max(AMBIENT_K, fitted));
}

/** Lower-layer volume, m³. A rectangular room is the floor area times the height. */
function lowerVolumeM3(spec: LayerSpec, interfaceM: number): number {
  if (spec.crossSection) return volumeBetweenM3(spec, 0, Math.max(interfaceM, 0));
  return Math.max(spec.areaM2, 0) * Math.max(interfaceM, 0);
}

/** Height whose lower volume is `volumeM3`. Negative volume is a height below the floor. */
function interfaceForLowerVolume(spec: LayerSpec, volumeM3: number): number {
  const area = Math.max(spec.areaM2, 1e-9);
  if (!(volumeM3 > 0)) return volumeM3 / area;
  if (!spec.crossSection) return volumeM3 / area;
  let lo = 0;
  let hi = spec.ceilingM;
  for (let i = 0; i < 32; i++) {
    const mid = 0.5 * (lo + hi);
    if (volumeBetweenM3(spec, 0, mid) < volumeM3) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

interface LayerAdvance {
  massRateKgS: number;
  burnedFraction: number;
  phi: number;
  burn: LayerBurn;
  /** Convected heat of fuel that burned in the spill this slice, kW. */
  qDoorKw: number;
  plumeKgS: number;
  /** Inflow that fills the lower layer. The deposited jet's own inflow is out. */
  makeupKgS: number;
  inKgS: number;
  outKgS: number;
  hotOutKgS: number;
  farUpperInKgS: number;
  fanLowerKgS: number;
  fanUpperKgS: number;
  hotSum: number;
  yF: number;
  unburnedKgS: number;
  incomingFuelKgS: number;
  burnedFuelKgS: number;
  mEnt: number;
  extraKgS: number;
  storeKgS: number;
  mass: number;
  sheetK?: Readonly<Record<string, number>>;
  tempNext: number;
  zNext: number;
  lowerK: number;
  upperLossKw: number;
  lowerLossKw: number;
  /** Convected fire heat in the temperature step, kW. Door fuel is separate. */
  qFireKw: number;
  /** Upper-layer m cp, kJ/K. The denominator of the temperature step. */
  heatDenom: number;
  /** Temperature rate before the ±400 K/s clip, K/s. */
  dTUnclipped: number;
  /** Temperature rate after that clip, K/s. */
  dTApplied: number;
}

/**
 * Temperature and plume one substep produces from these vent flows. The
 * applied step calls it once, on the exchange (inflow = outflow), and
 * reads the temperature and the plume. The interface is not this height.
 * It is the lower-layer volume of the pressure root's own flows, at
 * ρ(T_L). Recomputing the rate on each pressure candidate, or feeding
 * that candidate's flows back into it, counts the same outflow twice
 * and the root runs away.
 */
function layerAdvance(
  scalars: PressureScalars,
  ctx: {
    spec: LayerSpec;
    z: number;
    temp: number;
    lowerK: number;
    yL: number;
    yU: number;
    slice: number;
    sheets: Readonly<Record<string, number>> | undefined;
    age: number;
    hold: ReadonlySet<string> | undefined;
    gain: Record<string, number> | undefined;
    q: number;
    radiantBase: number;
    boundaryArea: number;
    chi: number;
    fuelKg: number;
    depositKgS: number;
    jetKgS: number;
    jetT: number;
    jetFuelY: number;
    jetOrigin: number | null;
    jetWidth: number;
    jetLow: number | null;
    jetSoffit: number | null;
    fuelOnly: boolean;
  },
): LayerAdvance {
  const { spec, z, temp, slice } = ctx;
  const supplied = flameSupply(spec, z, temp, ctx.yL, ctx.yU, slice, ctx.depositKgS > 0, scalars);
  const burn = supplied.burn;
  const burnedFraction = burn.prescribedKw > 0 ? burn.fraction : 1;
  const plume = supplied.plumeKgS;
  const mass = densityKgM3(temp) * upperLayerVolumeM3(spec, z);
  const yF = mass > 1e-6 ? ctx.fuelKg / mass : 0;
  const supplyKw = burn.phi > 0 && Number.isFinite(burn.phi) ? burn.prescribedKw / burn.phi : 0;
  const pyrolysisKw = cappedPyrolysisKw(burn.prescribedKw, supplyKw);
  const unburnedKgS =
    pyrolysisKw > burn.burnedKw ? (pyrolysisKw - burn.burnedKw) / WOOD_HEAT_KJ_KG : 0;
  fireRadiantKwM2 = ctx.radiantBase * burnedFraction;
  const jetFuelKw = ctx.jetKgS * ctx.jetFuelY * WOOD_HEAT_KJ_KG;
  let mEnt = 0;
  let burnedFuelKgS = 0;
  let qDoorKw = 0;
  const rise = ctx.jetOrigin != null ? spillRiseM(z, ctx.jetOrigin) : 0;
  const band =
    ctx.jetLow != null && ctx.jetSoffit != null ? spillBandShare(z, ctx.jetLow, ctx.jetSoffit) : 1;
  const spillKgS = ctx.jetKgS * band;
  if (
    jetFuelKw >= MIN_LAYER_FIRE_KW &&
    ctx.jetT >= SPILL_IGNITION_K &&
    rise > 0 &&
    ctx.jetWidth > 0 &&
    spillKgS > 0
  ) {
    const lowerM3 = spec.crossSection ? volumeBetweenM3(spec, 0, z) : spec.areaM2 * Math.max(z, 0);
    const lowerKg = densityKgM3(ctx.lowerK) * lowerM3;
    const offered = spillPlumeEntrainmentKgS(spillKgS, ctx.jetT, ctx.jetWidth, rise);
    const busy = plume + scalars.fanLowerKgS;
    const free = Math.max(0, (slice > 0 ? lowerKg / slice : 0) - busy);
    mEnt = Math.min(offered, free);
    const airKw = oxygenCapacityKw(mEnt, ctx.yL);
    const burnedKw = Math.min(jetFuelKw, airKw);
    burnedFuelKgS = burnedKw / WOOD_HEAT_KJ_KG;
    if (ctx.boundaryArea > 0) {
      qDoorKw = (1 - ctx.chi) * burnedKw;
      fireRadiantKwM2 += (ctx.chi * burnedKw) / ctx.boundaryArea;
    } else {
      qDoorKw = burnedKw;
    }
  }
  const incomingFuelKgS = ctx.jetKgS * ctx.jetFuelY;
  const unburnedSpillKgS = Math.max(0, incomingFuelKgS - burnedFuelKgS);
  const newFuelKgS = unburnedKgS + (ctx.fuelOnly ? unburnedSpillKgS : 0);
  const hotSum = scalars.hotOutKgS;
  const extraKgS = hotSum > 0 ? newFuelKgS : 0;
  const storeKgS = hotSum > 0 ? 0 : newFuelKgS;
  const lowerK = ctx.lowerK;
  const loss = stepSheetLoss(
    spec.boundaries,
    ctx.sheets,
    ctx.age,
    temp,
    lowerK,
    z,
    spec.ceilingM,
    slice,
    ctx.hold,
    ctx.gain,
  );
  const qLoss = loss.lossKw;
  const denom = Math.max(mass * CP_KJ_KGK, 1e-3);
  const qGas = ctx.q * burnedFraction;
  const atInterface = Math.max(sectionAreaM2(spec, z), 1e-6);
  let dT = (qGas - plume * CP_KJ_KGK * (temp - lowerK) - qLoss) / denom;
  if (ctx.depositKgS > 0) dT += (ctx.depositKgS * CP_KJ_KGK * (ctx.jetT - temp)) / denom;
  // A fire room leaves the carrier jet to the orifice, so this inflow is
  // not deposited. It still arrives from the neighbour's upper layer, and
  // that enthalpy has to enter here. A jet already mixes its own mass, so
  // only the part of the orifice stream the jet does not cover is added.
  const bareUpperKgS = Math.max(0, scalars.farUpperInKgS - ctx.depositKgS);
  if (bareUpperKgS > 0) {
    const farT = scalars.farUpperInKT / scalars.farUpperInKgS;
    dT += (bareUpperKgS * CP_KJ_KGK * (farT - temp)) / denom;
  }
  if (mEnt > 0 || qDoorKw > 0) {
    dT += (qDoorKw - mEnt * CP_KJ_KGK * (temp - lowerK)) / denom;
  }
  if (extraKgS > 0) dT += (extraKgS * CP_KJ_KGK * (AMBIENT_K - temp)) / denom;
  if (storeKgS > 0) dT += (storeKgS * CP_KJ_KGK * (AMBIENT_K - temp)) / denom;
  const dTUnclipped = dT;
  if (dT > 400) dT = 400;
  if (dT < -400) dT = -400;
  const areaRho = Math.max(LEVEL.RHO_AIR * atInterface, 1e-3);
  // The neighbour's upper gas is not cool air filling the lower layer,
  // whether or not a jet already carries part of it.
  const skipFar = scalars.farUpperInKgS;
  const makeupKgS = Math.max(0, scalars.inKgS - skipFar);
  const lowerOutKgS = Math.max(0, scalars.outKgS - hotSum);
  let dZ = (makeupKgS - plume - scalars.fanLowerKgS - lowerOutKgS) / areaRho;
  if (ctx.depositKgS > 0) {
    const unmatchedKgS = ctx.depositKgS - skipFar;
    dZ -= unmatchedKgS / Math.max(densityKgM3(ctx.jetT) * atInterface, 1e-3);
  }
  if (mEnt > 0) dZ -= mEnt / areaRho;
  if (storeKgS > 0) dZ -= storeKgS / Math.max(densityKgM3(temp) * atInterface, 1e-3);
  if (dZ > 2) dZ = 2;
  if (dZ < -2) dZ = -2;
  const lowerM3 = spec.crossSection ? volumeBetweenM3(spec, 0, z) : spec.areaM2 * Math.max(z, 0);
  const mLower = densityKgM3(lowerK) * lowerM3;
  const denomL = Math.max(mLower * CP_KJ_KGK, 1e-3);
  const tin = scalars.lowerInKgS > 0 ? scalars.lowerInKT / scalars.lowerInKgS : lowerK;
  let dTl = (-loss.lowerLossKw + scalars.lowerInKgS * CP_KJ_KGK * (tin - lowerK)) / denomL;
  if (dTl > 400) dTl = 400;
  if (dTl < -400) dTl = -400;
  const lowerNext = Math.min(1500, Math.max(AMBIENT_K, lowerK + dTl * slice));
  const tempNext = Math.min(1500, Math.max(AMBIENT_K, temp + dT * slice));
  const zNext = Math.min(spec.ceilingM - 0.02, Math.max(0.05, z + dZ * slice));
  const gained =
    slice > 0
      ? (gasMassKg(spec, zNext, tempNext, lowerNext) - gasMassKg(spec, z, temp, lowerK)) / slice
      : 0;
  // The jet mass the orifice did not already count, and fuel that stays in
  // the layer, are sources. The vents carry the rest of the mass change.
  // Jet mass the orifice did not already import. Once the opening's upper
  // inflow exceeds the deposit, that stream is entirely inside `in`.
  const carried = ctx.depositKgS > 0 ? Math.max(0, ctx.depositKgS - scalars.farUpperInKgS) : 0;
  return {
    massRateKgS: gained - carried - storeKgS,
    burnedFraction,
    qDoorKw,
    phi: burn.phi,
    burn,
    plumeKgS: plume,
    makeupKgS,
    inKgS: scalars.inKgS,
    outKgS: scalars.outKgS,
    hotOutKgS: hotSum,
    farUpperInKgS: scalars.farUpperInKgS,
    fanLowerKgS: scalars.fanLowerKgS,
    fanUpperKgS: scalars.fanUpperKgS,
    hotSum,
    yF,
    unburnedKgS,
    incomingFuelKgS,
    burnedFuelKgS,
    mEnt,
    extraKgS,
    storeKgS,
    mass,
    sheetK: loss.sheetK,
    tempNext,
    zNext,
    lowerK: lowerNext,
    upperLossKw: qLoss,
    lowerLossKw: loss.lowerLossKw,
    qFireKw: qGas,
    heatDenom: denom,
    dTUnclipped,
    dTApplied: dT,
  };
}

/**
 * The same advance with a different convected fire heat. The plume, the
 * door fuel and the wall film stay. Only the temperature and the mass rate
 * that follows from it change, including the ±400 K/s clip.
 */
function advanceWithFireKw(
  advance: LayerAdvance,
  qFireKw: number,
  spec: LayerSpec,
  temp: number,
  slice: number,
): LayerAdvance {
  const denom = Math.max(advance.heatDenom, 1e-3);
  const dTUnclipped = advance.dTUnclipped + (qFireKw - advance.qFireKw) / denom;
  let dT = dTUnclipped;
  if (dT > 400) dT = 400;
  if (dT < -400) dT = -400;
  const tempNext = Math.min(1500, Math.max(AMBIENT_K, temp + dT * slice));
  const oldEnd = gasMassKg(spec, advance.zNext, advance.tempNext, advance.lowerK);
  const newEnd = gasMassKg(spec, advance.zNext, tempNext, advance.lowerK);
  const massRateKgS = advance.massRateKgS + (slice > 0 ? (newEnd - oldEnd) / slice : 0);
  return { ...advance, qFireKw, dTUnclipped, dTApplied: dT, tempNext, massRateKgS };
}

/** Upper-layer gas that left one vent over the step. */
export interface VentedHotGas {
  kg: number;
  tempK: number;
  oxygenY: number;
  /** Unburned pyrolysate, kg fuel per kg of mixture. */
  fuelY: number;
}

export function stepZone(
  state: ZoneState,
  spec: LayerSpec,
  dt: number,
  sootGPerS = 0,
  jet?: DoorJetInflow | null,
  /**
   * Walls whose temperature this step must not change. Each is a partition
   * with a layer on the other side. The gas is still charged the inside
   * film, and `sheetGainKjM2` is that film plus this room's radiation.
   */
  hold?: ReadonlySet<string>,
): {
  state: ZoneState;
  ventedSootG: number;
  /**
   * Soot the bare neighbour stream mixed into the layer this step, grams.
   * The vent grant moves the same soot. The caller subtracts this so the
   * layer does not receive it twice. CO follows this soot: the stud dose
   * derives it from extinction, and the layer does not store CO.
   */
  bareSootG: number;
  outByVentKgS: number[];
  /** Upper-layer outflow of each vent over the step, for the next room. */
  hotByVent: VentedHotGas[];
  /** Floor gauge of the last substep, Pa. A neighbour door reads it next step. */
  floorPressurePa: number;
  /** Share of the prescribed release the oxygen burned on the last substep. */
  burnedFraction: number;
  /**
   * Oxygen the flame took from the layers over the whole step, kg.
   * Huggett's 13,100 kJ/kg times this is the heat those removals released.
   * Door-fuel oxygen is not in it.
   */
  flameOxygenKg: number;
  /**
   * Lower and stream oxygen the sliver could not hand over, booked from
   * the upper layer, kg. Zero when that block does not run.
   */
  oxygenShortKg: number;
  /** True when a clamp slice scaled the burn down to the oxygen on hand. */
  burnScaled: boolean;
  /** Equivalence ratio on that substep, before the lower-oxygen cutoff. */
  phi: number;
  /** Energy into each held sheet this step, kJ/m². Absent when nothing is held. */
  sheetGainKjM2?: Readonly<Record<string, number>>;
  /** Last substep's orifice inflow, kg/s. Both layers. */
  inKgS: number;
  /** Last substep's orifice outflow, kg/s. Both layers. */
  outKgS: number;
  /** Last substep's upper-layer outflow of each vent, kg/s. */
  hotOutByVentKgS: number[];
  /** Last substep's upper-layer outflow, kg/s. */
  hotOutKgS: number;
  /** Last substep's inflow from above a neighbour interface, kg/s. Already in `inKgS`. */
  farUpperInKgS: number;
  /** Last substep's plume, kg/s. */
  plumeKgS: number;
  /** Last substep's lower-layer fan extract, kg/s. */
  fanLowerKgS: number;
  /** Last substep's upper-layer fan extract, kg/s. */
  fanUpperKgS: number;
  /** Mean upper-layer boundary loss over the step, kW. */
  upperLossKw: number;
  /** Mean lower-layer boundary loss over the step, kW. */
  lowerLossKw: number;
  /**
   * Last substep's inflow booked to the lower layer, kg/s. The root's vent
   * inflow, with upper-layer inflow left out. Already in `inKgS`.
   */
  lowerInKgS: number;
  /**
   * Integrated (in − out − fans) over the substeps, kilograms. The last
   * substep's rates are not this: a step longer than one substep would
   * miss the earlier slices.
   */
  bookedKg: number;
  /**
   * Integrated net through vents that are not shafts, minus the fans,
   * kilograms. A shaft is inside the building. The outdoor doors and the
   * fans are what the building exchanges with the outside.
   */
  shellKg: number;
  /** Orifice mass that left each vent over the step, kilograms. */
  outKgByVent: number[];
  /** Orifice mass that entered each vent over the step, kilograms. */
  inKgByVent: number[];
  /**
   * Inflow enthalpy over the step, kg·K. Each slice is its mass times the
   * temperature it arrived at, including a shaft correction.
   */
  inKT: number;
  /** Outflow enthalpy over the step, kg·K. Each slice leaves at its own layer. */
  outKT: number;
  /**
   * Convected heat given to the layer energy equation, kJ. The fire's
   * (1 − χ)Q at the oxygen-backed fraction, plus door fuel that burned in
   * the spill. The clamp book and the floor shortfall are applied before
   * this heat enters the temperature step.
   */
  convectedKj: number;
  /**
   * Energy the ±400 K/s temperature clip threw away, kJ. Positive when the
   * clip cut a rise. The convected heat above is what the equation was
   * given; this is the part that did not become temperature.
   */
  clippedKj: number;
  /**
   * Extra pressure-book evaluations the oxygen heat solve used, summed
   * over this step's slices. The first book is not counted. One starved
   * slice can take 20.
   */
  heatSolvePasses: number;
  /** Most extra books one slice of this step used. */
  heatSolvePeak: number;
  /**
   * Heat an oxygen-solve jump left out of the temperature step, kJ. The
   * low end of the bracket is what entered. This is the oxygen answer at
   * that end minus that heat, so it is heat the oxygen would still have
   * covered. Zero when every slice landed within 1%.
   */
  jumpUnbackedKj: number;
} {
  return withFluxMemo(() =>
    withVentSumMemo(() => stepZoneNow(state, spec, dt, sootGPerS, jet, hold)),
  );
}

function stepZoneNow(
  state: ZoneState,
  spec: LayerSpec,
  dt: number,
  sootGPerS = 0,
  jet?: DoorJetInflow | null,
  hold?: ReadonlySet<string>,
) {
  let z = state.interfaceM;
  let temp = state.upperK;
  let lower = state.lowerK != null && state.lowerK > 0 ? state.lowerK : AMBIENT_K;
  let soot = state.sootG;
  let fuel = state.fuelKg != null && state.fuelKg > 0 ? state.fuelKg : 0;
  let age = state.ageS;
  let yL = oxygenMassFraction(state.lowerO2);
  let yU = oxygenMassFraction(state.upperO2);
  let sheets = state.sheetK;
  let vented = 0;
  let bareSootG = 0;
  let outByVent = spec.vents.map(() => 0);
  const hotKg = spec.vents.map(() => 0);
  const hotT = spec.vents.map(() => 0);
  const hotY = spec.vents.map(() => 0);
  const hotF = spec.vents.map(() => 0);
  const outKg = spec.vents.map(() => 0);
  const inKg = spec.vents.map(() => 0);
  let bookedKg = 0;
  let shellKg = 0;
  let stepInKT = 0;
  let stepOutKT = 0;
  let burnedFraction = 1;
  let phi = 0;
  let flameOxygenKg = 0;
  let oxygenShortKg = 0;
  let burnScaled = false;
  let lastIn = 0;
  let lastOut = 0;
  let lastHot = 0;
  let lastHotByVent = spec.vents.map(() => 0);
  let lastFar = 0;
  let lastPlume = 0;
  let lastFanL = 0;
  let lastFanU = 0;
  let lastLowerIn = 0;
  let upperLossSum = 0;
  let lowerLossSum = 0;
  let lossSlices = 0;
  let convectedKj = 0;
  let clippedKj = 0;
  let heatSolvePasses = 0;
  let heatSolvePeak = 0;
  let jumpUnbackedKj = 0;
  let left = Math.max(0, dt);
  let lastFraction = state.lastBurnFraction ?? 1;
  const gainKjM2 = hold && hold.size > 0 ? ({} as Record<string, number>) : undefined;
  const split = fireSplit(spec);
  const q = split.convectedKw;
  const radiantBase = fireRadiantKwM2;
  const jetKgS = jet != null && jet.kgS > 0 ? jet.kgS : 0;
  const jetT = jet != null && jet.tempK > 0 ? jet.tempK : AMBIENT_K;
  const jetY = jet != null && jet.oxygenY > 0 ? jet.oxygenY : O2_AMBIENT_MASS;
  const jetFuelY = jet != null && jet.fuelY != null && jet.fuelY > 0 ? Math.min(1, jet.fuelY) : 0;
  const jetOrigin = jet != null && jet.originM != null && jet.originM >= 0 ? jet.originM : null;
  const jetWidth = jet != null && jet.widthM != null && jet.widthM > 0 ? jet.widthM : 0;
  const jetLow = jet != null && jet.lowEdgeM != null ? jet.lowEdgeM : null;
  const jetSoffit = jet != null && jet.soffitM != null ? jet.soffitM : null;
  const depositKgS = jet != null && jet.fuelOnly === true ? 0 : jetKgS;
  let neutralM = state.interfaceM;
  let floorPressurePa = 0;
  let boundaryArea = 0;
  for (const boundary of spec.boundaries) if (boundary.areaM2 > 0) boundaryArea += boundary.areaM2;
  const chi = chiOf(spec);
  while (left > 1e-9) {
    const slice = Math.min(SUBSTEP_S, left);
    if (split.totalKw > MIN_LAYER_FIRE_KW) age += slice;
    // Fuel left over from a step that stored it beside the gas is cut
    // back before the mass rate reads the mixture.
    const massBefore = densityKgM3(temp) * upperLayerVolumeM3(spec, z);
    if (fuel > massBefore) fuel = massBefore;
    const advanceOf = (scalars: PressureScalars, recordGain: boolean) =>
      layerAdvance(scalars, {
        spec,
        z,
        temp,
        lowerK: lower,
        yL,
        yU,
        slice,
        sheets,
        age,
        hold,
        gain: recordGain ? gainKjM2 : undefined,
        q,
        radiantBase,
        boundaryArea,
        chi,
        fuelKg: fuel,
        depositKgS,
        jetKgS,
        jetT,
        jetFuelY,
        jetOrigin,
        jetWidth,
        jetLow,
        jetSoffit,
        fuelOnly: jet != null && jet.fuelOnly === true,
      });
    // The exchange is inflow = outflow. It sets the temperature and the
    // plume. Its makeup is not the air that arrives: the pressure root
    // admits less whenever the room is expelling hot gas. The lower layer
    // is booked from that root: its inflow, the lower-layer outflow, the
    // plume and the spill, at ρ(T_L). The interface is the volume of that
    // mass. The root is solved again at the geometric
    // mass of that interface when the vents can carry it. On the floor the
    // rate still carries the unclipped volume. The candidate's own flows
    // stay out of the bisection: feeding them back in counts the outflow
    // twice and the root runs away. The first root can send more hot gas
    // than the exchange. That extra is taken out of the upper mass and the
    // root is solved once more, still at the exchange height.
    const exchange = oxygenLimitedBurn(
      spec,
      z,
      temp,
      yL,
      yU,
      slice,
      depositKgS > 0,
      undefined,
      lower,
    );
    let exchangeHot = 0;
    for (const rate of exchange.hotOutByVentKgS) exchangeHot += rate ?? 0;
    const advance = advanceOf(
      {
        inKgS: exchange.inKgS,
        outKgS: exchange.outKgS,
        hotOutKgS: exchangeHot,
        farUpperInKgS: exchange.farUpperInKgS,
        fanUpperKgS: exchange.fanUpperKgS,
        fanLowerKgS: exchange.fanLowerKgS,
        lowerInKgS: exchange.lowerInKgS,
        lowerInKT: exchange.lowerInKgS * exchange.lowerInK,
        farUpperInKT: exchange.farUpperInKgS * exchange.farUpperInK,
        farUpperInO2KgS: exchange.farUpperO2KgS,
      },
      true,
    );
    // The clamp scale and the floor shortfall are known only after the
    // pressure book. The temperature step has to be given that
    // oxygen-backed heat, so a slice the oxygen cuts is solved again.
    const backed = (fired: LayerAdvance) => {
    const rhoNew = densityKgM3(fired.tempNext);
    const vExchange = upperLayerVolumeM3(spec, fired.zNext);
    const lowerNext = fired.lowerK;
    const gained =
      slice > 0
        ? (gasMassKg(spec, fired.zNext, fired.tempNext, lowerNext) -
            gasMassKg(spec, z, temp, lower)) /
          slice
        : 0;
    // Jets the orifice missed, and fuel that stays in the layer, are
    // sources. They sit in the upper mass and are not a vent flow.
    const held = gained - fired.massRateKgS;
    const plan = (extraHotKgS: number) => {
      const upperGainKgS =
        fired.plumeKgS +
        fired.mEnt +
        (depositKgS > 0 ? depositKgS : 0) +
        Math.max(0, exchange.farUpperInKgS - (depositKgS > 0 ? depositKgS : 0)) +
        fired.storeKgS -
        exchangeHot -
        extraHotKgS -
        exchange.fanUpperKgS;
      const mUpperNew = Math.max(0, fired.mass + upperGainKgS * slice);
      const vTarget = rhoNew > 1e-9 ? mUpperNew / rhoNew : vExchange;
      const deltaV = vTarget - vExchange;
      const heating = deltaV > 0;
      let volumeRate = fired.massRateKgS;
      let zExp = fired.zNext;
      if (heating) {
        const area = Math.max(sectionAreaM2(spec, fired.zNext), 1e-6);
        zExp = fired.zNext - deltaV / area;
        const hitsClamp = zExp < 0.05 || zExp > spec.ceilingM - 0.02;
        let predicted = gained;
        if (slice > 0 && !hitsClamp) {
          predicted =
            (gasMassKg(spec, zExp, fired.tempNext, lowerNext) - gasMassKg(spec, z, temp, lower)) /
            slice;
        } else if (slice > 0) {
          // The floor clamp will stop the interface. The rate still carries
          // the unclipped volume, which is the known residual once the layer
          // is on the floor.
          const vStart = upperLayerVolumeM3(spec, z);
          const lowerStart = spec.crossSection
            ? volumeBetweenM3(spec, 0, z)
            : Math.max(spec.areaM2, 0) * Math.max(z, 0);
          const lowerFinal = lowerStart - (vTarget - vStart);
          const massFinal = mUpperNew + densityKgM3(lowerNext) * lowerFinal;
          predicted = (massFinal - gasMassKg(spec, z, temp, lower)) / slice;
        }
        volumeRate = predicted - held;
      }
      return { heating, volumeRate, zExp };
    };
    let planned = plan(0);
    let limited = oxygenLimitedBurn(
      spec,
      z,
      temp,
      yL,
      yU,
      slice,
      depositKgS > 0,
      () => planned.volumeRate,
      lower,
    );
    {
      let hot1 = 0;
      for (const rate of limited.hotOutByVentKgS) hot1 += rate ?? 0;
      const extra = Math.max(0, hot1 - exchangeHot);
      if (planned.heating && extra > 0) {
        planned = plan(extra);
        limited = oxygenLimitedBurn(
          spec,
          z,
          temp,
          yL,
          yU,
          slice,
          depositKgS > 0,
          () => planned.volumeRate,
          lower,
        );
      }
    }
    const solveAt = (rateKgS: number) =>
      oxygenLimitedBurn(spec, z, temp, yL, yU, slice, depositKgS > 0, () => rateKgS, lower);
    const hotOf = (flows: LimitedBurn) => {
      let hot = 0;
      for (const rate of flows.hotOutByVentKgS) hot += rate ?? 0;
      return hot;
    };
    const rootRelieved = (flows: LimitedBurn, rateKgS: number) => {
      const net = flows.inKgS - flows.outKgS - flows.fanUpperKgS - flows.fanLowerKgS;
      return Math.abs(net - rateKgS) <= 0.05 + 0.01 * Math.abs(rateKgS);
    };
    // Lower-layer volume after `flows`, and the mass the vents must carry
    // so the geometric total matches it. The inflow is the root's, with the
    // deposited jet left out: the same stream the exchange had been
    // crediting, which is larger than the slice that enters below the
    // interface whenever the neutral plane sits above it. On the floor the
    // plume may only take that inflow plus the mass still above the floor.
    // Heskestad with the virtual origin below the fuel still asks for the
    // whole flame at a 5 cm interface; the rest is upper gas recirculating,
    // and it moves no mass. Any other shortfall keeps the unclipped volume.
    const bookOf = (flows: LimitedBurn, hot: number) => {
      const lowerOut = Math.max(0, flows.outKgS - hot);
      const makeup = Math.max(0, flows.inKgS - flows.farUpperInKgS);
      const below = flows.lowerInKgS;
      const rho0 = densityKgM3(lower);
      const v0 = lowerVolumeM3(spec, z);
      const m0 = rho0 * v0;
      const aboveM3 = spec.crossSection
        ? volumeBetweenM3(spec, INTERFACE_FLOOR_M, z)
        : Math.max(spec.areaM2, 0) * Math.max(0, z - INTERFACE_FLOOR_M);
      const aboveKgS = slice > 0 ? (rho0 * aboveM3) / slice : 0;
      const plumeCap = Math.max(0, makeup) + aboveKgS;
      const plumeDraw = Math.min(fired.plumeKgS, plumeCap);
      const recirc = fired.plumeKgS - plumeDraw;
      // The exchange cooled the upper layer as if the whole plume were cold
      // lower air. Recirculated upper gas does not. The studs record only
      // the oxygen in the draw that remains.
      let tempNext = fired.tempNext;
      let burnScale = 1;
      let supplyKw = 0;
      if (recirc > 0 && fired.plumeKgS > 0) {
        const freshScale = plumeDraw / fired.plumeKgS;
        const y = yL > 0 ? yL : 0;
        // The plume cap is the lower layer. The bare far stream is not in
        // that layer, but the flame still takes its oxygen, at its own
        // fraction. Leaving it out of the cap is what starved the shop.
        const deposited = depositKgS > 0 ? depositKgS : 0;
        const bare = Math.max(0, flows.farUpperInKgS - deposited);
        const yStream =
          flows.farUpperInKgS > 1e-9 ? Math.max(0, flows.farUpperO2KgS) / flows.farUpperInKgS : y;
        const streamTaken = Math.min(bare, recirc);
        if (fired.burn.burnedKw > 0) {
          // Across the clamp fade the plume above the floor is still the
          // room's layer. That oxygen is already on the burn, with the
          // inflow taken out of it, so the stream term does not count it again.
          const layerKw =
            floorLayerWeight(z) > 0 ? fired.burn.oxygenUpperKgS * DELTA_H_O2_KJ_PER_KG : 0;
          const capacity =
            oxygenCapacityKw(fired.burn.lowerAirKgS * freshScale, y) +
            oxygenCapacityKw(streamTaken, yStream) +
            layerKw;
          const newBurned = Math.min(fired.burn.burnedKw, capacity);
          burnScale = newBurned / fired.burn.burnedKw;
          supplyKw =
            oxygenSupplyKw(fired.burn.lowerAirKgS * freshScale, y) +
            oxygenSupplyKw(streamTaken, yStream);
        }
        if (fired.mass > 1e-6) {
          tempNext += (recirc * Math.max(0, temp - lower) * slice) / fired.mass;
          if (tempNext > 1500) tempNext = 1500;
          if (tempNext < AMBIENT_K) tempNext = AMBIENT_K;
        }
      }
      const flowKgS = makeup - lowerOut - plumeDraw - flows.fanLowerKgS - fired.mEnt;
      const tin = below > 0 ? flows.lowerInK : lower;
      let dTl =
        (-fired.lowerLossKw + below * CP_KJ_KGK * (tin - lower)) /
        (Math.max(m0, 1e-6) * CP_KJ_KGK);
      if (dTl > 400) dTl = 400;
      if (dTl < -400) dTl = -400;
      const lowerNext = Math.min(1500, Math.max(AMBIENT_K, lower + dTl * slice));
      const rho1 = densityKgM3(lowerNext);
      let vEnd = (m0 + flowKgS * slice) / Math.max(rho1, 1e-9);
      if (depositKgS > 0) {
        const unmatched = Math.max(0, depositKgS - flows.farUpperInKgS);
        vEnd -= (unmatched * slice) / Math.max(densityKgM3(jetT), 1e-6);
      }
      if (fired.storeKgS > 0) {
        vEnd -= (fired.storeKgS * slice) / Math.max(densityKgM3(tempNext), 1e-6);
      }
      const area = Math.max(spec.areaM2, 1e-9);
      let zFlow = vEnd > 0 ? interfaceForLowerVolume(spec, vEnd) : vEnd / area;
      const capZ = 2 * slice;
      if (zFlow > z + capZ) zFlow = z + capZ;
      if (zFlow < z - capZ) zFlow = z - capZ;
      const floor = 0.05;
      const ceil = spec.ceilingM - 0.02;
      const zApplied = Math.min(ceil, Math.max(floor, zFlow));
      // A jet that would push the interface through the floor cannot store
      // that volume. The root balances the clamped room, and the inflow the
      // layer cannot hold leaves through the other vents.
      const throughFloor = depositKgS > 0 && zFlow < floor && spec.vents.some((vent) => vent.shaft);
      const vMass = throughFloor
        ? lowerVolumeM3(spec, zApplied)
        : zFlow < floor
          ? area * zFlow
          : lowerVolumeM3(spec, zApplied);
      const upperMass = densityKgM3(tempNext) * upperLayerVolumeM3(spec, zApplied);
      const lowerMass = densityKgM3(lowerNext) * vMass;
      const massRateKgS =
        (upperMass + lowerMass - gasMassKg(spec, z, temp, lower)) / Math.max(slice, 1e-9);
      return {
        z: zApplied,
        lowerK: lowerNext,
        lowerInKgS: makeup,
        lowerOutKgS: lowerOut,
        massRateKgS,
        plumeKgS: plumeDraw,
        tempNext,
        burnScale,
        supplyKw,
      };
    };
    let rate = planned.volumeRate;
    let hotSum = hotOf(limited);
    let book = bookOf(limited, hotSum);
    for (let pass = 0; pass < 3; pass++) {
      if (!rootRelieved(limited, rate)) break;
      if (Math.abs(book.massRateKgS - rate) <= 0.02) break;
      const next = solveAt(book.massRateKgS);
      if (!rootRelieved(next, book.massRateKgS)) break;
      rate = book.massRateKgS;
      limited = next;
      hotSum = hotOf(limited);
      book = bookOf(limited, hotSum);
    }
    const burn = fired.burn;
    burnedFraction = fired.burnedFraction * book.burnScale;
    if (book.burnScale < 1 && fired.plumeKgS > 0) {
      phi = equivalenceRatio(fired.burn.prescribedKw, book.supplyKw);
    } else {
      phi = fired.phi;
    }
    neutralM = limited.neutralM;
    floorPressurePa = limited.floorPressurePa;
    const mass = fired.mass;
    const plume = book.plumeKgS;
    // Oxygen, soot and fuel follow the root's flows. Hot gas and the
    // upper fan leave the upper layer. The lower layer gains the root's
    // vent inflow, with a deposited jet left out, and loses the outflow
    // from below the interface, the plume and the spill.
    const lowerOutKgS = book.lowerOutKgS;
    const lowerInKgS = book.lowerInKgS;
    outByVent = limited.outByVentKgS;
    const yF = fired.yF;
    let unburnedKgS = fired.unburnedKgS;
    const incomingFuelKgS = fired.incomingFuelKgS;
    const burnedFuelKgS = fired.burnedFuelKgS;
    const mEnt = fired.mEnt;
    let extraKgS = fired.extraKgS;
    let storeKgS = fired.storeKgS;
    // Pyrolysis follows the fresh air that remains. The exchange still
    // carries the larger plume's fuel, and that fuel is not in the room.
    if (book.burnScale < 1 && fired.plumeKgS > 0) {
      const pyrolysis = cappedPyrolysisKw(fired.burn.prescribedKw, book.supplyKw);
      const newBurned = fired.burn.burnedKw * book.burnScale;
      unburnedKgS = pyrolysis > newBurned ? (pyrolysis - newBurned) / WOOD_HEAT_KJ_KG : 0;
      extraKgS = hotSum > 0 ? unburnedKgS : 0;
      storeKgS = hotSum > 0 ? 0 : unburnedKgS;
    }
    const lowerVolF = spec.crossSection ? volumeBetweenM3(spec, 0, z) : spec.areaM2 * Math.max(z, 0);
    const mLF = densityKgM3(lower) * lowerVolF;
    const slicePlumeF = plume * slice;
    const farKgSF = limited.farUpperInKgS;
    const bareKgSF = Math.max(0, farKgSF - (depositKgS > 0 ? depositKgS : 0));
    const yFarF = farKgSF > 1e-9 ? Math.max(0, limited.farUpperO2KgS) / farKgSF : O2_AMBIENT_MASS;
    const o2StreamF = bareKgSF * slice * yFarF;
    const useWanted = burn.oxygenLowerKgS * book.burnScale * slice;
    const fromLower = Math.min(useWanted, slicePlumeF * yL, yL * mLF);
    const fromStream = Math.min(Math.max(0, useWanted - fromLower), o2StreamF);
    let useL = fromLower + fromStream;
    let useU = Math.min(burn.oxygenUpperKgS * book.burnScale * slice, Math.max(0, yU * mass));
    let shortKg = 0;
    let scaled = false;
    if (floorLayerWeight(z) > 0) {
      const short = Math.max(0, useWanted - useL);
      const room = Math.max(0, yU * mass - useU);
      const booked = Math.min(short, room);
      useU += booked;
      shortKg += booked;
      const demanded = useWanted + burn.oxygenUpperKgS * book.burnScale * slice;
      const covered = useL + useU;
      if (demanded > covered + 1e-9 && demanded > 0 && burnedFraction > 0) {
        burnedFraction *= covered / demanded;
        scaled = true;
      }
    }
    const yStand = floorLayerWeight(z) >= 0.5 ? yU : yL;
    if (lastFraction < 0.05 && burnedFraction > 0.05 && !oxygenAllowsFlame(yStand)) {
      const keep = 0.05 / burnedFraction;
      burnedFraction *= keep;
      useL *= keep;
      useU *= keep;
    }
    return {
      book,
      limited,
      hotSum,
      burnedFraction,
      phi,
      scaled,
      shortKg,
      useL,
      useU,
      unburnedKgS,
      extraKgS,
      storeKgS,
      mass,
      plume,
      lowerOutKgS,
      lowerInKgS,
      yF,
      incomingFuelKgS,
      burnedFuelKgS,
      mEnt,
    };
    };
    let fired = advance;
    let settled = backed(fired);
    let qTry = fired.qFireKw;
    let want = q * settled.burnedFraction;
    const close = (heat: number, asked: number) =>
      Math.abs(heat - asked) <= 0.01 * Math.max(Math.abs(heat), Math.abs(asked), 1);
    // More heat drives more air out, so the oxygen answer falls as the
    // heat rises. The root can sit below the first oxygen answer, so the
    // search keeps a real bracket: residual want − heat is positive at the
    // low end and negative at the pre-scale heat. The secant stays inside
    // that bracket. A stuck end is halved so a steep slope still moves.
    let slicePasses = 0;
    if (!close(qTry, want) && want < qTry) {
      let hi = qTry;
      let hiW = want;
      let lo = 0;
      let loW = 0;
      let loFired = fired;
      let loSettled = settled;
      let loKnown = false;
      let loStuck = 0;
      let hiStuck = 0;
      for (let redo = 0; redo < 12 && !close(qTry, want); redo++) {
        let next: number;
        if (!loKnown) next = redo === 0 ? Math.max(0, want) : 0;
        else {
          const loUse = hiStuck >= 2 ? lo + 0.5 * (loW - lo) : loW;
          const hiUse = loStuck >= 2 ? hi + 0.5 * (hiW - hi) : hiW;
          const slope = hi - lo > 1e-3 ? (hiUse - loUse) / (hi - lo) : 0;
          next = Math.abs(1 - slope) > 0.25 ? (loUse - slope * lo) / (1 - slope) : 0.5 * (lo + hi);
          if (!(next > lo && next < hi)) next = 0.5 * (lo + hi);
        }
        if (loKnown && !(next > lo && next < hi)) next = 0.5 * (lo + hi);
        if (!loKnown && !(next >= 0 && next < hi)) next = 0.5 * hi;
        fired = advanceWithFireKw(advance, next, spec, temp, slice);
        settled = backed(fired);
        slicePasses += 1;
        qTry = fired.qFireKw;
        want = q * settled.burnedFraction;
        if (want >= qTry) {
          lo = qTry;
          loW = want;
          loFired = fired;
          loSettled = settled;
          loKnown = true;
          loStuck += 1;
          hiStuck = 0;
        } else {
          hi = qTry;
          hiW = want;
          hiStuck += 1;
          loStuck = 0;
        }
      }
      if (!close(qTry, want) && loKnown && hi - lo > 0.01 * Math.max(hi, 1)) {
        for (let redo = 0; redo < 8 && !close(qTry, want); redo++) {
          const next = 0.5 * (lo + hi);
          fired = advanceWithFireKw(advance, next, spec, temp, slice);
          settled = backed(fired);
          slicePasses += 1;
          qTry = fired.qFireKw;
          want = q * settled.burnedFraction;
          if (want >= qTry) {
            lo = qTry;
            loW = want;
            loFired = fired;
            loSettled = settled;
          } else {
            hi = qTry;
            hiW = want;
          }
        }
      }
      // A jump in the oxygen answer can leave no heat within 1%. The low
      // end is still covered by oxygen. The high end is not, so the step
      // takes the low end rather than warming the layer with unpaid heat.
      if (!close(qTry, want) && loKnown) {
        fired = loFired;
        settled = loSettled;
        qTry = lo;
        want = loW;
        jumpUnbackedKj += Math.max(0, want - qTry) * slice;
      }
    }
    heatSolvePasses += slicePasses;
    if (slicePasses > heatSolvePeak) heatSolvePeak = slicePasses;
    oxygenShortKg += settled.shortKg;
    if (settled.scaled) burnScaled = true;
    burnedFraction = settled.burnedFraction;
    phi = settled.phi;
    const book = settled.book;
    const limited = settled.limited;
    const hotSum = settled.hotSum;
    const useL = settled.useL;
    const useU = settled.useU;
    let unburnedKgS = settled.unburnedKgS;
    let extraKgS = settled.extraKgS;
    let storeKgS = settled.storeKgS;
    const mass = settled.mass;
    const plume = settled.plume;
    const lowerOutKgS = settled.lowerOutKgS;
    const lowerInKgS = settled.lowerInKgS;
    const yF = settled.yF;
    const incomingFuelKgS = settled.incomingFuelKgS;
    const burnedFuelKgS = settled.burnedFuelKgS;
    const mEnt = settled.mEnt;
    sheets = advance.sheetK;
    upperLossSum += advance.upperLossKw;
    lowerLossSum += advance.lowerLossKw;
    lossSlices += 1;
    lastIn = limited.inKgS;
    lastOut = limited.outKgS;
    lastHot = hotSum;
    lastHotByVent = limited.hotOutByVentKgS.map((rate) => rate ?? 0);
    lastFar = limited.farUpperInKgS;
    stepInKT += limited.inKT * slice;
    stepOutKT += (limited.outKT + limited.fanUpperKgS * temp + limited.fanLowerKgS * lower) * slice;
    lastPlume = plume;
    lastFanL = limited.fanLowerKgS;
    lastFanU = limited.fanUpperKgS;
    lastLowerIn = lowerInKgS;
    bookedKg +=
      (limited.inKgS - limited.outKgS - limited.fanUpperKgS - limited.fanLowerKgS) * slice;
    let shaftNet = 0;
    const ventIn = limited.inByVentKgS;
    const ventOut = limited.outByVentKgS;
    for (let v = 0; v < spec.vents.length; v++) {
      if (!spec.vents[v]?.shaft) continue;
      shaftNet += (ventIn[v] ?? 0) - (ventOut[v] ?? 0);
    }
    shellKg +=
      (limited.inKgS - limited.outKgS - limited.fanUpperKgS - limited.fanLowerKgS - shaftNet) *
      slice;
    const outRates = limited.outByVentKgS;
    for (let v = 0; v < outKg.length; v++) outKg[v] = (outKg[v] ?? 0) + (outRates[v] ?? 0) * slice;
    for (let v = 0; v < inKg.length; v++) inKg[v] = (inKg[v] ?? 0) + (ventIn[v] ?? 0) * slice;
    const rates = limited.hotOutByVentKgS;
    for (let v = 0; v < hotKg.length; v++) {
      const doorDm = (rates[v] ?? 0) * slice;
      const extraDm = hotSum > 0 ? ((rates[v] ?? 0) / hotSum) * extraKgS * slice : 0;
      const dm = doorDm + extraDm;
      if (!(dm > 0)) continue;
      hotKg[v] = (hotKg[v] ?? 0) + dm;
      hotT[v] = (hotT[v] ?? 0) + dm * temp;
      hotY[v] = (hotY[v] ?? 0) + dm * yU;
      hotF[v] = (hotF[v] ?? 0) + dm * yF;
    }
    const lowerVol = spec.crossSection ? volumeBetweenM3(spec, 0, z) : spec.areaM2 * Math.max(z, 0);
    const mL = densityKgM3(lower) * lowerVol;
    const slicePlume = plume * slice;
    const sliceIn = lowerInKgS * slice;
    const sliceLowerOut = lowerOutKgS * slice;
    const sliceFanL = limited.fanLowerKgS * slice;
    const sliceHot = hotSum * slice;
    const sliceFanU = limited.fanUpperKgS * slice;
    const sliceEnt = mEnt * slice;
    const sliceExtra = extraKgS * slice;
    const sliceStore = storeKgS * slice;
    const farKgS = limited.farUpperInKgS;
    const bareKgS = Math.max(0, farKgS - (depositKgS > 0 ? depositKgS : 0));
    const bareSlice = bareKgS * slice;
    const yFar = farKgS > 1e-9 ? Math.max(0, limited.farUpperO2KgS) / farKgS : O2_AMBIENT_MASS;
    const o2Stream = bareSlice * yFar;
    lastFraction = burnedFraction;
    flameOxygenKg += useL + useU;
    const doorO2 = burnedFuelKgS * slice * (WOOD_HEAT_KJ_KG / DELTA_H_O2_KJ_PER_KG);
    const o2L =
      yL * mL -
      (slicePlume + sliceFanL + sliceEnt + sliceLowerOut) * yL +
      sliceIn * O2_AMBIENT_MASS;
    let o2U =
      yU * mass -
      (sliceHot + sliceFanU) * yU -
      useU +
      (slicePlume * yL - useL) +
      sliceEnt * yL -
      doorO2 -
      sliceExtra * yU;
    const mL2 = mL - slicePlume - sliceFanL - sliceEnt - sliceLowerOut + sliceIn;
    let mU2 = mass - sliceHot - sliceFanU + slicePlume + sliceEnt + sliceStore;
    if (depositKgS > 0) {
      const sliceJet = depositKgS * slice;
      o2U += sliceJet * jetY;
      mU2 += sliceJet;
    }
    if (bareSlice > 0 && farKgS > 0) {
      o2U += o2Stream;
      mU2 += bareSlice;
      // A hot jet already mixed its fuel. Only the part it did not cover
      // is still on the orifice stream. Soot is mixed after the outflow
      // of this slice, so the gas that just arrived is not vented in the
      // same slice. CO is not stored: the stud dose reads it from that soot.
      const streamFuel = (limited.farUpperFuelKgS / farKgS) * bareSlice;
      const already = incomingFuelKgS * slice;
      const extraFuel = streamFuel - already;
      if (extraFuel > 0) fuel += extraFuel;
    }
    yL = mL2 > 1e-4 ? Math.min(1, Math.max(0, o2L / mL2)) : 0;
    yU = mU2 > 1e-4 ? Math.min(1, Math.max(0, o2U / mU2)) : O2_AMBIENT_MASS;
    const zStart = z;
    const tempStart = temp;
    const lowerStart = lower;
    temp = book.tempNext;
    lower = book.lowerK;
    z = book.z;
    // A sliver a few millimetres deep is one substep of air. Burning it
    // drops the interface to the floor, the next substep grows it back,
    // and the door's hot flow follows. The midpoint is the steady height,
    // the same mean the floor gauge already publishes. That move does not
    // cross a vent, so the upper temperature is refit to the kilograms the
    // book had already balanced. A room that then sits on the floor,
    // including the tenth of a millimetre the midpoint can leave, still
    // cannot move the interface to the mass the vents balanced. The refit
    // below gives that mass to every such room, and it wins over the
    // midpoint temperature.
    const zBooked = z;
    if (
      zStart < INTERFACE_FLOOR_M + 0.003 &&
      zBooked < INTERFACE_FLOOR_M + 0.003 &&
      Math.abs(zBooked - zStart) > 1e-6
    ) {
      z = 0.5 * (zBooked + zStart);
      const kept = gasMassKg(spec, zBooked, temp, lower);
      const fitted = upperTemperatureForMassKg(spec, z, lower, kept);
      if (fitted != null) temp = fitted;
    }
    if (z <= INTERFACE_FLOOR_M + 1e-4) {
      const net =
        (limited.inKgS - limited.outKgS - limited.fanUpperKgS - limited.fanLowerKgS) * slice;
      const target = gasMassKg(spec, zStart, tempStart, lowerStart) + net;
      const fitted = upperTemperatureForMassKg(spec, z, lower, target);
      if (fitted != null) temp = fitted;
    }
    // qFireKw is the oxygen-backed convected heat. Door fuel is the spill's
    // convected part. The clip is what the ±400 K/s limit threw away.
    convectedKj += (fired.qFireKw + fired.qDoorKw) * slice;
    clippedKj += (fired.dTUnclipped - fired.dTApplied) * fired.heatDenom * slice;
    const carried = mass > 1e-6 ? (soot / mass) * hotSum * slice : 0;
    const extracted = mass > 1e-6 ? (soot / mass) * limited.fanUpperKgS * slice : 0;
    const displacedSoot = mass > 1e-6 ? (soot / mass) * sliceExtra : 0;
    const made = Math.max(0, sootGPerS) * slice;
    soot = Math.max(0, soot + made - carried - extracted - displacedSoot);
    if (bareSlice > 0 && farKgS > 0) {
      const sootIn = (limited.farUpperSootGPerS / farKgS) * bareSlice;
      if (sootIn > 0) {
        soot += sootIn;
        bareSootG += sootIn;
      }
    }
    const carriedF = yF * hotSum * slice;
    const extractedF = yF * limited.fanUpperKgS * slice;
    const displacedF = yF * sliceExtra;
    fuel = Math.max(
      0,
      fuel +
        unburnedKgS * slice +
        incomingFuelKgS * slice -
        carriedF -
        extractedF -
        displacedF -
        burnedFuelKgS * slice,
    );
    const massNow = densityKgM3(temp) * upperLayerVolumeM3(spec, z);
    if (fuel > massNow) {
      const excess = fuel - massNow;
      fuel = massNow;
      let share = 0;
      for (const kg of hotKg) share += kg;
      if (share > 0) {
        for (let v = 0; v < hotKg.length; v++) {
          const kg = hotKg[v] ?? 0;
          if (!(kg > 0)) continue;
          const part = excess * (kg / share);
          hotKg[v] = kg + part;
          hotT[v] = (hotT[v] ?? 0) + part * temp;
          hotF[v] = (hotF[v] ?? 0) + part;
        }
      }
    }
    vented += carried;
    left -= slice;
  }
  return {
    state: {
      interfaceM: z,
      upperK: temp,
      sootG: soot,
      fuelKg: fuel,
      ageS: age,
      lowerO2: yL,
      upperO2: yU,
      ...(lower > AMBIENT_K + 1e-3 ? { lowerK: lower } : {}),
      ...(sheets ? { sheetK: sheets } : {}),
      lastBurnFraction: lastFraction,
    },
    ventedSootG: vented,
    bareSootG,
    outByVentKgS: outByVent,
    hotByVent: hotKg.map((kg, v) => ({
      kg,
      tempK: kg > 0 ? (hotT[v] ?? 0) / kg : AMBIENT_K,
      oxygenY: kg > 0 ? (hotY[v] ?? 0) / kg : O2_AMBIENT_MASS,
      fuelY: kg > 0 ? (hotF[v] ?? 0) / kg : 0,
    })),
    burnedFraction,
    flameOxygenKg,
    oxygenShortKg,
    burnScaled,
    phi,
    neutralM,
    floorPressurePa,
    inKgS: lastIn,
    outKgS: lastOut,
    hotOutByVentKgS: lastHotByVent,
    hotOutKgS: lastHot,
    farUpperInKgS: lastFar,
    plumeKgS: lastPlume,
    fanLowerKgS: lastFanL,
    fanUpperKgS: lastFanU,
    upperLossKw: lossSlices > 0 ? upperLossSum / lossSlices : 0,
    lowerLossKw: lossSlices > 0 ? lowerLossSum / lossSlices : 0,
    lowerInKgS: lastLowerIn,
    bookedKg,
    shellKg,
    outKgByVent: outKg,
    inKgByVent: inKg,
    inKT: stepInKT,
    outKT: stepOutKT,
    convectedKj,
    clippedKj,
    heatSolvePasses,
    heatSolvePeak,
    jumpUnbackedKj,
    ...(gainKjM2 && Object.keys(gainKjM2).length > 0 ? { sheetGainKjM2: gainKjM2 } : {}),
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
  /**
   * Outward normal of the polygon edge this exit cuts, radians, 0 along +x.
   * An exit uses this instead of the direction from the room centroid to
   * the receivers, which skews on an L-shaped plan.
   */
  outwardRad?: number;
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
  const doorLinks = new Map<string, Array<{ id: string; t: number; from: string }>>();
  const faceLinks = new Map<string, string[]>();
  const spillReceivers: string[] = [];
  const exitSlots = new Map<string, { widthM: number; receivers: string[]; outwardRad?: number }>();
  const facadeWalls: number[] = [];
  const exteriorWalls = new Set<string>();
  let spillWidth = 0;
  let boundaryLinks = 0;
  let cx = 0;
  let cy = 0;
  let cn = 0;

  for (const id of memberIds) {
    const stud = studs.get(id);
    if (!stud || stud.level !== level) continue;
    cx += stud.x;
    cy += stud.y;
    cn += 1;
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
          const slot = exitSlots.get(diag.exitKey) ?? {
            widthM: diag.widthM ?? 0,
            receivers: [],
            outwardRad: diag.outwardRad,
          };
          if (slot.outwardRad == null && diag.outwardRad != null) slot.outwardRad = diag.outwardRad;
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
            across.push({ id: nId, t, from: id });
            doorLinks.set(wall.id, across);
          }
          const shell = facade?.(id, nId);
          if (shell?.kind === 'wall' || shell?.kind === 'exit') exteriorWalls.add(wall.id);
        }
      } else {
        const face = facade?.(id, nId) ?? null;
        if (face?.kind === 'wall') {
          // The outline, away from an exit. Concrete until the wall table
          // is the reader. The stud outside the wall is not a receiver.
          facadeWalls.push(reach * ceilingM);
        } else if (face?.kind === 'exit' && face.exitKey && (face.widthM ?? 0) > 0) {
          const slot = exitSlots.get(face.exitKey) ?? {
            widthM: face.widthM ?? 0,
            receivers: [],
            outwardRad: face.outwardRad,
          };
          if (slot.outwardRad == null && face.outwardRad != null) slot.outwardRad = face.outwardRad;
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
  boundaries.push({ areaM2: area, lining: LINING.concrete, place: 'floor' });
  boundaries.push({ areaM2: area, lining: LINING.concrete, place: 'ceiling' });
  for (const wallArea of facadeWalls) {
    if (wallArea > 0) boundaries.push({ areaM2: wallArea, lining: LINING.concrete, place: 'wall' });
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

  const outwardRad = (receivers: readonly string[]): number | undefined => {
    if (!(cn > 0)) return undefined;
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (const id of receivers) {
      const stud = studs.get(id);
      if (!stud) continue;
      sx += stud.x;
      sy += stud.y;
      n += 1;
    }
    if (n === 0) return undefined;
    const dx = sx / n - cx / cn;
    const dy = sy / n - cy / cn;
    if (dx * dx + dy * dy < 1e-8) return undefined;
    return Math.atan2(dy, dx);
  };
  const ventWithFace = (vent: Vent, receivers: readonly string[], exposed: boolean): Vent => {
    if (!exposed) return vent;
    const windFace = outwardRad(receivers);
    return windFace == null ? vent : { ...vent, windFace };
  };

  const pushHead = (widthM: number, receivers: readonly string[], edgeRad?: number) => {
    const soffit = Math.min(DOOR_SOFFIT_M, ceilingM);
    const bare: Vent =
      soffit < ceilingM - RESERVOIR_SOFFIT_GAP_M
        ? { widthM, sillM: 0, soffitM: soffit }
        : { widthM, sillM: 0, soffitM: ceilingM };
    const faced =
      edgeRad != null && Number.isFinite(edgeRad)
        ? { ...bare, windFace: edgeRad }
        : ventWithFace(bare, receivers, true);
    vents.push(faced);
    ventReceivers.push([...new Set(receivers)]);
  };

  for (const wall of wallHits.values()) {
    const length = Math.hypot(wall.x2 - wall.x1, wall.y2 - wall.y1);
    if (!(length > 0)) continue;
    if (openWallIds?.has(wall.id) && liningForMaterial(wall.material).name === 'glass') {
      const lining = liningForMaterial(wall.material);
      const openWidth = length * GLASS_FALLOUT_AREA_FRACTION;
      if (openWidth > 0) {
        const receivers = [...new Set(faceLinks.get(wall.id) ?? [])];
        vents.push(
          ventWithFace(
            { widthM: openWidth, sillM: 0, soffitM: ceilingM },
            receivers,
            exteriorWalls.has(wall.id) || facade == null,
          ),
        );
        ventReceivers.push(receivers);
      }
      const kept = (length - openWidth) * ceilingM;
      if (kept > 0) boundaries.push({ id: wall.id, areaM2: kept, lining, place: 'wall' });
      continue;
    }
    const soffit = Math.min(DOOR_SOFFIT_M, ceilingM);
    // A door belongs to the room whose links cross its gap. The same wall
    // can bound a room further along, and that room does not get the door.
    const across = wall.hasDoor ? receiversForDoor(wall) : [];
    const nominal = wall.doorWidth > 0 ? wall.doorWidth : 0.9;
    const doorWidth = across.length > 0 ? Math.min(length, nominal * doorOpenFraction(wall)) : 0;
    const lining = liningForMaterial(wall.material);
    const doorExposed = exteriorWalls.has(wall.id) || facade == null;
    if (doorWidth > 0 && soffit < ceilingM - RESERVOIR_SOFFIT_GAP_M) {
      vents.push(
        ventWithFace({ widthM: doorWidth, sillM: 0, soffitM: soffit }, across, doorExposed),
      );
      ventReceivers.push(across);
      const wallArea = Math.max(0, length * ceilingM - doorWidth * soffit);
      if (wallArea > 0) boundaries.push({ id: wall.id, areaM2: wallArea, lining, place: 'wall' });
    } else if (doorWidth > 0) {
      spillWidth += doorWidth;
      spillReceivers.push(...across);
      const wallArea = Math.max(0, (length - doorWidth) * ceilingM);
      if (wallArea > 0) boundaries.push({ id: wall.id, areaM2: wallArea, lining, place: 'wall' });
    } else {
      boundaries.push({ id: wall.id, areaM2: length * ceilingM, lining, place: 'wall' });
    }
  }
  if (spillWidth > 0) {
    const receivers = [...new Set(spillReceivers)];
    // A spill next to a shell is an internal opening. Without a shell the
    // open boundary is the weather, and it takes a facing.
    vents.push(
      ventWithFace({ widthM: spillWidth, sillM: 0, soffitM: ceilingM }, receivers, facade == null),
    );
    ventReceivers.push(receivers);
  }
  for (const slot of exitSlots.values()) pushHead(slot.widthM, slot.receivers, slot.outwardRad);

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
