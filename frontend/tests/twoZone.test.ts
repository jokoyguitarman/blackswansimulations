import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extinctionK } from '../src/lib/evacuation/hazardSensing.ts';
import type { ExitDef, Vec2 } from '../src/lib/evacuation/types.ts';
import {
  HOOD_HEIGHT_M,
  RADIATIVE_FRACTION,
  STUD_AREA_M2,
  poolFireKw,
  WOOD_HEAT_KJ_KG,
  type FuelCell,
} from '../src/lib/rts/flameFront.ts';
import { GLASS_FALLOUT_AREA_FRACTION } from '../src/lib/rts/liningFire.ts';
import { defaultLightFuel } from '../src/lib/rts/materialLibrary.ts';
import { SOOT_EXTINCTION_M2_PER_G, sootProductionGPerS } from '../src/lib/rts/toxicDose.ts';
import {
  DOOR_JET_MIN_KGS,
  SMOKE_LEAK_PER_S,
  SpatialEffectsEngine,
  advanceSootK,
  assignDoorJet,
  neighbourVentOutside,
  queueDoorJets,
  type DoorJetBook,
  type DoorJetParcel,
} from '../src/lib/rts/spatialEffects.ts';
import type { InteriorWall } from '../src/lib/rts/types.ts';
import {
  AMBIENT_K,
  SIGMA_KW_M2K4,
  SURFACE_CONVECTION_C_W,
  SURFACE_EMISSIVITY,
  CEILING_JET_DEPTH_FRACTION,
  DISTINCT_LAYER_RISE_K,
  LINING,
  hasSmokeReservoir,
  DOOR_SOFFIT_M,
  balanceAt,
  diameterForReleaseKw,
  effectiveHeatLossKwM2K,
  enclosureFromGrid,
  formsSustainedLayer,
  FAN_FULL_FLOW_PA,
  FAN_ZERO_FLOW_PA,
  HEAD_HEIGHT_M,
  MIN_LAYER_FIRE_KW,
  HOOD_EXHAUST_M3_PER_S_PER_M,
  HOOD_EXTRACT_M3_PER_S,
  HOOD_FAN_WHEN,
  HOOD_INTAKE_M,
  HOOD_LENGTH_M,
  freshLayer,
  gasMassKg,
  layerContactM2,
  upperLayerVolumeM3,
  fanVolumeM3PerS,
  coldSurfaceIncidentKwM2,
  heskestadEntrainmentKgS,
  liningFluxKwM2,
  DELTA_H_O2_KJ_PER_KG,
  KAWAGOE_KW,
  O2_AMBIENT_MASS,
  O2_LIMIT_MASS,
  POST_FLASHOVER_PHI_MAX,
  cappedPyrolysisKw,
  equivalenceRatio,
  layerBurn,
  lowerOxygenCoefficient,
  oxygenCapacityKw,
  ventilationLimitedKw,
  mechanicalExtract,
  mqhFlashoverKw,
  mqhRiseK,
  orificeSliceKgS,
  steadyLayer,
  oxygenLimitedBurn,
  SPILL_PLUME_CM,
  SPILL_IGNITION_K,
  spillBandShare,
  spillOriginM,
  spillPlumeEntrainmentKgS,
  spillRiseM,
  layerFuelFraction,
  upperMixtureKg,
  coolUnclaimedSheet,
  isothermalSheet,
  liningForMaterial,
  stepZone,
  withRememberedSheets,
  type GridStud,
  type GridWall,
  type LayerSpec,
  type ZoneState,
  type Lining,
} from '../src/lib/rts/twoZone.ts';

/**
 * Steckler walls and ceiling are 12.7 mm ceramic fibre board (NIST TN
 * 1889v3). k, ρ and c are the 96 kg/m³ alumina-silica blanket at 260 °C
 * (Zircar ASB-2300). That blanket is not the Armstrong board in the test;
 * the thickness is.
 */
const CERAMIC_FIBRE: Lining = {
  name: 'ceramic fibre board',
  kKwMK: 0.00006,
  rhoKgM3: 96,
  cKjKgK: 1.13,
  thicknessM: 0.0127,
};

function close(actual: number, expected: number, tol: number, label: string) {
  assert.ok(Math.abs(actual - expected) <= tol, `${label}: ${actual} vs ${expected} ± ${tol}`);
}

function concreteRoom(qKw: number, diameterM: number): LayerSpec {
  // 4 × 5 × 2.6 m, door 0.9 × 2.0. AT excludes the vent and is 85 m².
  const door = 0.9 * 2;
  const walls = 2 * (4 + 5) * 2.6 - door;
  return {
    areaM2: 20,
    ceilingM: 2.6,
    vents: [{ widthM: 0.9, sillM: 0, soffitM: 2 }],
    boundaries: [
      { areaM2: 20, lining: LINING.concrete },
      { areaM2: 20, lining: LINING.concrete },
      { areaM2: walls, lining: LINING.concrete },
    ],
    fires: [{ heatKw: qKw, diameterM }],
  };
}

test('MQH worked example and the lining loss', () => {
  const hk = effectiveHeatLossKwM2K(LINING.concrete, 600);
  close(hk, 0.0695, 0.0007, 'hk');
  const rise = mqhRiseK(500, 1.8, 2, 85, hk);
  close(rise, 174.8, 174.8 * 0.01, 'MQH rise');
  const flash = mqhFlashoverKw(hk, 85, 1.8, 2);
  close(flash, 2366, 2366 * 0.01, 'MQH flashover');
  assert.ok(Math.abs(rise - 174.8) / 174.8 < 0.05);
});

test('orifice slice matches the 400 K door example', () => {
  // Seed vent_flow_orifice: 0.5 m of 400 K gas, 0.9 m wide, dP from 0 to 1.557 Pa.
  const rho = 353 / 400;
  const mass = orificeSliceKgS(0.9, 0.5, 0, 1.557, rho);
  close(mass, 0.3482, 0.3482 * 0.01, 'door flow');
});

test('a deposited jet keeps the lower-layer air budget', () => {
  // The inflow is the neighbour's upper layer, and the jet is that stream.
  // The lower layer keeps the root's own inflow and loses the jet volume
  // the orifice did not match.
  const outside = { interfaceM: 0.3, upperK: 700, floorPressurePa: 0 };
  const spec: LayerSpec = {
    areaM2: 20,
    ceilingM: 3,
    vents: [{ widthM: 1.5, sillM: 0, soffitM: 2, outside }],
    boundaries: [
      { areaM2: 20, lining: LINING.concrete },
      { areaM2: 20, lining: LINING.concrete },
      { areaM2: 40, lining: LINING.concrete },
    ],
    fires: [],
  };
  const start = { ...freshLayer(3), interfaceM: 1.4, upperK: AMBIENT_K + 80 };
  const far = oxygenLimitedBurn(spec, start.interfaceM, start.upperK, 0.23, 0.23, 0.1, true);
  assert.ok(far.farUpperInKgS > 1, `far inflow ${far.farUpperInKgS}`);
  assert.ok(
    far.inKgS - far.farUpperInKgS < 0.05,
    'the inflow was not all from the neighbour layer',
  );
  const jet = { kgS: far.farUpperInKgS, tempK: 700, oxygenY: 0.12 };
  const rhoAt = (tempK: number) => 353 / tempK;
  let state = start;
  const dt = 0.1;
  let residualKg = 0;
  for (let i = 0; i < 20; i++) {
    // The lower layer is the root's inflow, its own outflow and the plume,
    // at the lower-layer density. The jet's unmatched volume comes out of
    // that layer and is not a second copy of the exchange makeup.
    const z0 = state.interfaceM;
    const lower0 = state.lowerK ?? AMBIENT_K;
    const m0 = rhoAt(lower0) * spec.areaM2 * z0;
    const stepped = stepZone(state, spec, dt, 0, jet);
    const lower1 = stepped.state.lowerK ?? AMBIENT_K;
    const m1 = rhoAt(lower1) * spec.areaM2 * stepped.state.interfaceM;
    const lowerOut = Math.max(0, stepped.outKgS - stepped.hotOutKgS);
    const flow = stepped.lowerInKgS - lowerOut - stepped.plumeKgS - stepped.fanLowerKgS;
    const unmatched = Math.max(0, jet.kgS - stepped.farUpperInKgS);
    const jetVolume = (unmatched * dt) / rhoAt(jet.tempK);
    residualKg += m1 - (m0 + flow * dt - rhoAt(lower1) * jetVolume);
    state = stepped.state;
  }
  assert.ok(Math.abs(start.interfaceM - state.interfaceM) > 0.05, 'the interface did not move');
  assert.ok(
    Math.abs(residualKg) < 0.05,
    `lower-layer budget residual ${residualKg.toFixed(3)} kg at ${state.interfaceM.toFixed(3)} m`,
  );
});

test('a single vent expels the gas mass the step adds', () => {
  // Otherwise closed. The pressure root is in − out = dM/dt, so the vent
  // carries the expansion instead of the layer mass simply disappearing.
  const spec: LayerSpec = {
    areaM2: 40,
    ceilingM: 3,
    vents: [{ widthM: 2, sillM: 0, soffitM: 2 }],
    boundaries: [
      { areaM2: 40, lining: LINING.concrete },
      { areaM2: 40, lining: LINING.concrete },
      { areaM2: 48, lining: LINING.concrete },
    ],
    fires: [{ heatKw: 500, diameterM: 0.6 }],
  };
  let state = freshLayer(spec.ceilingM);
  const dt = 0.1;
  let worst = 0;
  let expelled = false;
  for (let i = 0; i < 80; i++) {
    const before = gasMassKg(spec, state.interfaceM, state.upperK);
    const stepped = stepZone(state, spec, dt);
    const after = gasMassKg(spec, stepped.state.interfaceM, stepped.state.upperK);
    const net = stepped.inKgS - stepped.outKgS - stepped.fanUpperKgS - stepped.fanLowerKgS;
    worst = Math.max(worst, Math.abs(net - (after - before) / dt));
    if (net < -0.05) expelled = true;
    state = stepped.state;
  }
  assert.ok(state.upperK > AMBIENT_K + 5, `rise ${(state.upperK - AMBIENT_K).toFixed(2)} K`);
  assert.ok(expelled, 'the vent did not carry the expansion out');
  assert.ok(worst < 0.02, `vent net missed the mass change by ${worst.toFixed(4)} kg/s`);
});

test('expansion above the soffit leaves with the lower layer', () => {
  // The opening is entirely in the lower layer, so the displaced volume
  // is lower-layer air. The lower layer loses that air and the whole
  // plume mass. The upper layer gains the whole plume mass: entrained
  // air is heated, and the extra volume leaves downstairs.
  const spec: LayerSpec = {
    areaM2: 40,
    ceilingM: 3,
    vents: [{ widthM: 2, sillM: 0, soffitM: 2 }],
    boundaries: [
      { areaM2: 40, lining: LINING.concrete },
      { areaM2: 40, lining: LINING.concrete },
      { areaM2: 48, lining: LINING.concrete },
    ],
    fires: [{ heatKw: 500, diameterM: 0.6 }],
  };
  const rhoAt = (tempK: number) => 353 / tempK;
  const split = (z: number, tempK: number) => {
    const upper = rhoAt(tempK) * upperLayerVolumeM3(spec, z);
    const lower = rhoAt(AMBIENT_K) * spec.areaM2 * z;
    return { upper, lower };
  };
  let state = freshLayer(spec.ceilingM);
  const dt = 0.1;
  const soffit = 2;
  let checked = 0;
  let worstLower = 0;
  let worstUpper = 0;
  for (let i = 0; i < 80; i++) {
    const z0 = state.interfaceM;
    if (!(z0 > soffit)) break;
    const before = split(z0, state.upperK);
    const stepped = stepZone(state, spec, dt);
    const z1 = stepped.state.interfaceM;
    const t1 = stepped.state.upperK;
    if (!(z1 > soffit) || stepped.hotOutKgS > 0.01) break;
    const after = split(z1, t1);
    const ventLower = stepped.inKgS - stepped.outKgS - stepped.fanLowerKgS;
    const dLower = (after.lower - before.lower) / dt;
    const dUpper = (after.upper - before.upper) / dt;
    // The plume mass itself changes layers. Heating does not add a
    // second, smaller copy at the upper density.
    const plumeMass = stepped.plumeKgS;
    worstLower = Math.max(worstLower, Math.abs(dLower - (ventLower - plumeMass)));
    worstUpper = Math.max(worstUpper, Math.abs(dUpper - plumeMass));
    state = stepped.state;
    checked += 1;
  }
  assert.ok(checked >= 10, `only ${checked} steps stayed above the soffit`);
  assert.ok(
    worstLower < 0.02,
    `lower layer missed the expelled air by ${worstLower.toFixed(4)} kg/s`,
  );
  assert.ok(worstUpper < 0.02, `upper layer missed the plume by ${worstUpper.toFixed(4)} kg/s`);
});

test('a burning room books outflow from below its interface', () => {
  // No jet is deposited. The door faces a warm neighbour, and about half
  // the outflow leaves the lower layer. The height change includes that
  // flow in every room. Leaving it out holds this 216 m² layer up.
  const spec: LayerSpec = {
    areaM2: 216,
    ceilingM: 2.6,
    vents: [
      {
        widthM: 2.4,
        sillM: 0,
        soffitM: 2,
        outside: { interfaceM: 0.2, upperK: 350, floorPressurePa: 0 },
      },
    ],
    boundaries: [{ areaM2: 400, lining: LINING.concrete }],
    fires: [{ heatKw: 4000, diameterM: 1 }],
  };
  const start = { ...freshLayer(spec.ceilingM), interfaceM: 1.2, upperK: AMBIENT_K + 300 };
  const opened = oxygenLimitedBurn(
    spec,
    start.interfaceM,
    start.upperK,
    start.lowerO2,
    start.upperO2,
    0.1,
    false,
  );
  const openedHot = opened.hotOutByVentKgS.reduce((sum, rate) => sum + (rate ?? 0), 0);
  const openedLower = Math.max(0, opened.outKgS - openedHot);
  assert.ok(opened.outKgS > 1, `outflow ${opened.outKgS}`);
  assert.ok(
    openedLower / opened.outKgS > 0.45 && openedLower / opened.outKgS < 0.6,
    `lower share ${(openedLower / opened.outKgS).toFixed(2)}`,
  );
  assert.ok(opened.burn.burnedKw > 1000, 'the room is burning');
  let state = start;
  let omittedZ = start.interfaceM;
  const dt = 0.1;
  const rhoAt = (tempK: number) => 353 / tempK;
  let residualKg = 0;
  for (let i = 0; i < 80; i++) {
    // The interface follows the root's inflow, the lower-layer outflow and
    // the plume. The parallel height credits the same inflow and drops the
    // lower outflow, which is the booking this test exists to keep.
    const z0 = state.interfaceM;
    const lower0 = state.lowerK ?? AMBIENT_K;
    const m0 = rhoAt(lower0) * spec.areaM2 * z0;
    const stepped = stepZone(state, spec, dt, 0, null);
    const lower1 = stepped.state.lowerK ?? AMBIENT_K;
    const m1 = rhoAt(lower1) * spec.areaM2 * stepped.state.interfaceM;
    const lowerOut = Math.max(0, stepped.outKgS - stepped.hotOutKgS);
    const flow = stepped.lowerInKgS - lowerOut - stepped.plumeKgS - stepped.fanLowerKgS;
    residualKg += m1 - (m0 + flow * dt);
    const clamp = (dZ: number) => Math.max(-2, Math.min(2, dZ));
    const areaRho = rhoAt(lower0) * spec.areaM2;
    omittedZ = Math.min(
      spec.ceilingM - 0.02,
      Math.max(
        0.05,
        omittedZ +
          clamp((stepped.lowerInKgS - stepped.plumeKgS - stepped.fanLowerKgS) / areaRho) * dt,
      ),
    );
    state = stepped.state;
  }
  assert.ok(
    Math.abs(residualKg) < 0.05,
    `lower-layer budget residual ${residualKg.toFixed(3)} kg at ${state.interfaceM.toFixed(3)} m`,
  );
  const omittedKg = rhoAt(state.lowerK ?? AMBIENT_K) * spec.areaM2 * (omittedZ - state.interfaceM);
  assert.ok(omittedKg > 1, `leaving the lower outflow out only moves ${omittedKg.toFixed(3)} kg`);
});

test('a floor-clamped layer entrains only the air the floor can give', () => {
  // A wide fire puts Heskestad's virtual origin below the fuel, so a 5 cm
  // interface still asks for a tall plume. The draw stops at the root's
  // lower inflow plus the mass above the floor. The rest recirculates in
  // the upper gas, and both the lower layer and the room total close.
  const spec: LayerSpec = {
    areaM2: 120,
    ceilingM: 3,
    vents: [{ widthM: 1.6, sillM: 0, soffitM: 2 }],
    boundaries: [
      { areaM2: 120, lining: LINING.concrete },
      { areaM2: 120, lining: LINING.concrete },
      { areaM2: 80, lining: LINING.concrete },
    ],
    fires: [{ heatKw: 4000, diameterM: 8 }],
  };
  const asked = heskestadEntrainmentKgS(4000, 0.05, 8);
  assert.ok(asked > 10, `Heskestad at the floor only asked ${asked.toFixed(1)} kg/s`);
  const rhoAt = (tempK: number) => 353 / tempK;
  let state = { ...freshLayer(spec.ceilingM), interfaceM: 2.2, upperK: AMBIENT_K + 30 };
  const dt = 0.1;
  let clamped = 0;
  let lowerKg = 0;
  let totalKg = 0;
  let plumeKg = 0;
  let inflowKg = 0;
  let maxPlume = 0;
  for (let i = 0; i < 400; i++) {
    const z0 = state.interfaceM;
    const lower0 = state.lowerK ?? AMBIENT_K;
    const before = gasMassKg(spec, z0, state.upperK, lower0);
    const m0 = rhoAt(lower0) * spec.areaM2 * z0;
    const stepped = stepZone(state, spec, dt);
    const z1 = stepped.state.interfaceM;
    const lower1 = stepped.state.lowerK ?? AMBIENT_K;
    const after = gasMassKg(spec, z1, stepped.state.upperK, lower1);
    const m1 = rhoAt(lower1) * spec.areaM2 * z1;
    const lowerOut = Math.max(0, stepped.outKgS - stepped.hotOutKgS);
    const net = stepped.inKgS - stepped.outKgS - stepped.fanUpperKgS - stepped.fanLowerKgS;
    if (z1 <= 0.0501) {
      clamped += 1;
      lowerKg +=
        m1 - (m0 + (stepped.lowerInKgS - lowerOut - stepped.plumeKgS - stepped.fanLowerKgS) * dt);
      totalKg += after - (before + net * dt);
      plumeKg += stepped.plumeKgS * dt;
      inflowKg += stepped.lowerInKgS * dt;
      maxPlume = Math.max(maxPlume, stepped.plumeKgS);
    }
    state = stepped.state;
  }
  assert.ok(clamped >= 200, `only ${clamped} steps sat on the floor`);
  assert.ok(
    maxPlume < asked / 2,
    `clamped plume ${maxPlume.toFixed(2)} kg/s against Heskestad ${asked.toFixed(1)}`,
  );
  // The difference is the mass above the floor taken as the interface arrives.
  // An uncapped Heskestad plume is hundreds of kilograms over this run.
  assert.ok(
    Math.abs(plumeKg - inflowKg) < 6,
    `plume drew ${plumeKg.toFixed(2)} kg from ${inflowKg.toFixed(2)} kg of inflow`,
  );
  assert.ok(Math.abs(lowerKg) < 2, `lower-layer residual ${lowerKg.toFixed(3)} kg`);
  assert.ok(Math.abs(totalKg) < 2, `total residual ${totalKg.toFixed(3)} kg`);
});

test('a burning room that takes a jet does not burn the neighbour upper layer', () => {
  // The door inflow is the neighbour's hot layer. Depositing that jet
  // leaves it out of the fresh-air supply. Counting it as lower-layer air
  // lets the flame burn on gas that is not fresh.
  const spec: LayerSpec = {
    areaM2: 20,
    ceilingM: 3,
    vents: [
      {
        widthM: 1.2,
        sillM: 0,
        soffitM: 2,
        outside: { interfaceM: 0.05, upperK: 900, floorPressurePa: -2 },
      },
    ],
    boundaries: [{ areaM2: 80, lining: LINING.concrete }],
    fires: [{ heatKw: 5000, diameterM: 1 }],
  };
  const state = { ...freshLayer(3), interfaceM: 0.05, upperK: AMBIENT_K + 150 };
  const limited = oxygenLimitedBurn(spec, state.interfaceM, state.upperK, 0.23, 0.12, 0.1, true);
  assert.ok(limited.farUpperInKgS > 1, `far inflow ${limited.farUpperInKgS}`);
  assert.ok(
    limited.inKgS - limited.farUpperInKgS < 0.05,
    'the inflow was not all from the neighbour layer',
  );
  const asFresh = oxygenLimitedBurn(spec, state.interfaceM, state.upperK, 0.23, 0.12, 0.1, false);
  assert.ok(
    asFresh.burn.burnedKw > 100,
    `keeping the far inflow as fresh air only burned ${asFresh.burn.burnedKw.toFixed(0)} kW`,
  );
  const jet = { kgS: limited.farUpperInKgS, tempK: 900, oxygenY: 0.05 };
  // The room's own layer is spent as well. The jet is then the only gas,
  // and it is not fresh air.
  const spent = { ...state, upperO2: 0.05, lowerO2: 0.05 };
  const stepped = stepZone(spent, spec, 0.1, 0, jet);
  assert.ok(
    stepped.burnedFraction < 0.01,
    `the flame burned ${(stepped.burnedFraction * 5000).toFixed(0)} kW on the neighbour layer`,
  );
  const own = stepZone(state, spec, 0.1, 0, jet);
  assert.ok(
    own.burnedFraction > 0.2,
    `the room's own layer released ${(own.burnedFraction * 5000).toFixed(0)} kW`,
  );
});

test('a fire room keeps the enthalpy of a neighbour upper inflow', () => {
  // No deposited jet: this is the fire-room path, where the orifice carries
  // the neighbour's upper gas. That inflow used to enter as cool makeup.
  const spec: LayerSpec = {
    areaM2: 20,
    ceilingM: 3,
    vents: [
      {
        widthM: 1.2,
        sillM: 0,
        soffitM: 2,
        outside: { interfaceM: 0.2, upperK: 900, floorPressurePa: 4 },
      },
    ],
    boundaries: [{ areaM2: 80, lining: LINING.concrete }],
    fires: [{ heatKw: 200, diameterM: 0.5 }],
  };
  let state = { ...freshLayer(3), interfaceM: 1.5, upperK: AMBIENT_K + 80 };
  let energy = 0;
  for (let i = 0; i < 20; i++) {
    const stepped = stepZone(state, spec, 0.5);
    energy += stepped.inKT - stepped.outKT - (stepped.upperLossKw + stepped.lowerLossKw) * 0.5;
    state = stepped.state;
  }
  const rise = state.upperK - AMBIENT_K;
  // Without the inflow enthalpy the layer stays near its 80 K rise.
  assert.ok(rise > 150, `upper rise ${rise.toFixed(0)} K after 10 s of 900 K inflow`);
  assert.ok(energy / 1000 < 1, `energy residual ${(energy / 1000).toFixed(1)} MJ`);
});

test('a clamped fire room fed near-fresh air keeps burning', () => {
  // The neighbour layer is only slightly warm, so the door inflow is that
  // layer. On the floor the plume cap used to drop it, and its oxygen never
  // reached the flame, so the fire collapsed. Near-fresh air should burn
  // close to the model's fresh 0.23, and a vitiated stream should not.
  const fires = [{ heatKw: 15000, diameterM: 1.4 }];
  const room = {
    areaM2: 40,
    ceilingM: 3,
    boundaries: [{ areaM2: 140, lining: LINING.concrete }],
  };
  const door = { widthM: 2, sillM: 0, soffitM: 2 };
  const spec = (upperO2: number): LayerSpec => ({
    ...room,
    fires,
    vents: [
      {
        ...door,
        outside: { interfaceM: 0.1, upperK: AMBIENT_K + 35, floorPressurePa: 0, upperO2 },
      },
    ],
  });
  const start = { ...freshLayer(3), interfaceM: 0.05, upperK: 500 };
  const released = (upperO2: number, layerY = O2_AMBIENT_MASS) => {
    let state = { ...start, upperO2: layerY, lowerO2: layerY };
    let kw = 0;
    for (let i = 0; i < 20; i++) {
      const stepped = stepZone(state, spec(upperO2), 0.5);
      kw += stepped.burnedFraction * 15000;
      state = stepped.state;
    }
    return kw;
  };
  const near = released(0.21);
  const fresh = released(0.23);
  // The room's own layer is spent too. A vitiated inflow is then not a fire.
  const vitiated = released(0.05, 0.05);
  assert.ok(fresh > 50000, `fresh stream only released ${fresh.toFixed(0)} kW·s`);
  assert.ok(
    near > fresh * 0.8,
    `near-fresh released ${near.toFixed(0)} kW·s against fresh ${fresh.toFixed(0)}`,
  );
  assert.ok(
    near < fresh * 1.02,
    `near-fresh released ${near.toFixed(0)} kW·s, above the fresh stream ${fresh.toFixed(0)}`,
  );
  assert.ok(
    near > vitiated * 3,
    `near-fresh released ${near.toFixed(0)} kW·s against vitiated ${vitiated.toFixed(0)}`,
  );
});

test('a clamped fire room burns the oxygen in its own layer', () => {
  // The inflow is below the extinction limit. The upper layer is not.
  // The flame stands in that layer, so it keeps burning. The same inflow
  // into a spent layer does not, and the two oxygen pools are not added
  // twice: the burn is the sum of the stream and the layer, not twice either.
  const fires = [{ heatKw: 4000, diameterM: 1.2 }];
  const room = {
    areaM2: 30,
    ceilingM: 2.6,
    boundaries: [{ areaM2: 110, lining: LINING.concrete }],
  };
  const spec = (upperO2: number): LayerSpec => ({
    ...room,
    fires,
    vents: [
      {
        widthM: 1.5,
        sillM: 0,
        soffitM: 2,
        outside: {
          interfaceM: 0.05,
          upperK: AMBIENT_K + 90,
          floorPressurePa: 3,
          upperO2,
        },
      },
    ],
  });
  const start = (y: number) => ({
    ...freshLayer(2.6),
    interfaceM: 0.05,
    upperK: AMBIENT_K + 120,
    upperO2: y,
    lowerO2: y,
  });
  const released = (layerY: number, inY: number) => {
    let state = start(layerY);
    let kwS = 0;
    for (let i = 0; i < 8; i++) {
      const stepped = stepZone(state, spec(inY), 0.5);
      kwS += stepped.burnedFraction * 4000 * 0.5;
      state = stepped.state;
    }
    return { kwS, y: state.upperO2 ?? 0 };
  };
  const burning = released(0.19, 0.12);
  const spent = released(0.12, 0.12);
  assert.ok(burning.kwS > 1500, `own layer released ${burning.kwS.toFixed(0)} kW·s`);
  assert.ok(
    spent.kwS * 3 < burning.kwS,
    `spent layer ${spent.kwS.toFixed(0)} kW·s against the live layer ${burning.kwS.toFixed(0)}`,
  );
  assert.ok(burning.y < 0.19, `layer oxygen stayed ${burning.y.toFixed(3)}`);
  const limited = oxygenLimitedBurn(spec(0.12), 0.05, AMBIENT_K + 120, 0.19, 0.19, 0.5);
  const parts = (limited.burn.oxygenLowerKgS + limited.burn.oxygenUpperKgS) * DELTA_H_O2_KJ_PER_KG;
  assert.ok(
    Math.abs(parts - limited.burn.burnedKw) < Math.max(50, 0.05 * limited.burn.burnedKw),
    `oxygen pools ${parts.toFixed(0)} kW against the burn ${limited.burn.burnedKw.toFixed(0)} kW`,
  );
  assert.ok(
    limited.burn.oxygenUpperKgS > limited.burn.oxygenLowerKgS,
    'the layer was not the supply',
  );
  const spentBurn = oxygenLimitedBurn(spec(0.12), 0.05, AMBIENT_K + 120, 0.12, 0.12, 0.5);
  assert.ok(
    spentBurn.burn.burnedKw < limited.burn.burnedKw * 0.25,
    `spent layer still burned ${spentBurn.burn.burnedKw.toFixed(0)} kW`,
  );
  // The walk's flame is a fixed point: the same oxygen supports it again.
  const q = limited.burn.burnedKw;
  const again = oxygenLimitedBurn(
    { ...spec(0.12), fires: [{ heatKw: q, diameterM: 1.2 }] },
    0.05,
    AMBIENT_K + 120,
    0.19,
    0.19,
    0.5,
  );
  assert.ok(
    Math.abs(again.burn.burnedKw - q) <= Math.max(50, 0.02 * q),
    `the walk moved from ${q.toFixed(0)} kW to ${again.burn.burnedKw.toFixed(0)} kW`,
  );
});

test('a clamped fire releases 13100 kJ per kilogram of oxygen it removes', () => {
  // The floor walk counts the inflow and the layer. The sliver and the
  // stream cannot always hand over the inflow's share. That share is
  // booked against the layer, so the heat and the oxygen removed stay
  // on Huggett's 13,100 kJ/kg through the burst.
  const fires = [{ heatKw: 8000, diameterM: 1.2 }];
  const spec: LayerSpec = {
    areaM2: 80,
    ceilingM: 3,
    boundaries: [{ areaM2: 200, lining: LINING.concrete }],
    fires,
    vents: [
      {
        widthM: 2,
        sillM: 0,
        soffitM: 2,
        outside: {
          interfaceM: 0.05,
          upperK: AMBIENT_K + 80,
          floorPressurePa: 4,
          upperO2: 0.12,
        },
      },
    ],
  };
  let state = {
    ...freshLayer(3),
    interfaceM: 0.05,
    upperK: AMBIENT_K + 150,
    upperO2: 0.2,
    lowerO2: 0.2,
  };
  let heatKj = 0;
  let oxygenKg = 0;
  for (let i = 0; i < 200; i++) {
    const stepped = stepZone(state, spec, 0.1);
    heatKj += 8000 * stepped.burnedFraction * 0.1;
    oxygenKg += stepped.flameOxygenKg;
    state = stepped.state;
  }
  assert.ok(heatKj > 50000, `the burst released ${heatKj.toFixed(0)} kJ`);
  assert.ok((state.upperO2 ?? 1) < 0.2, `layer oxygen stayed ${state.upperO2}`);
  const perKg = oxygenKg > 0 ? heatKj / oxygenKg : 0;
  assert.ok(
    Math.abs(perKg - DELTA_H_O2_KJ_PER_KG) <= 0.01 * DELTA_H_O2_KJ_PER_KG,
    `${perKg.toFixed(0)} kJ/kg from ${heatKj.toFixed(0)} kJ and ${oxygenKg.toFixed(3)} kg`,
  );
});

test('a fire just off the clamp burns within a few percent of the floor', () => {
  // The upper-layer credit fades over the first 5 cm. A hard cut at
  // 0.05 m drops this flame to the fresh air in the sliver, which is
  // almost none. Two millimetres of interface motion must not do that.
  const fires = [{ heatKw: 8000, diameterM: 1.2 }];
  const spec: LayerSpec = {
    areaM2: 30,
    ceilingM: 2.6,
    boundaries: [{ areaM2: 110, lining: LINING.concrete }],
    fires,
    vents: [],
  };
  const burnAt = (z: number) =>
    oxygenLimitedBurn(spec, z, AMBIENT_K + 200, 0.2, 0.2, 0.1).burn.burnedKw;
  const heights = [0.05, 0.052, 0.054, 0.056];
  const kw = heights.map(burnAt);
  assert.ok(kw[0]! > 0.95 * 8000, `floor burn ${kw[0]!.toFixed(0)} kW`);
  for (let i = 1; i < kw.length; i++) {
    const swing = Math.abs(kw[i]! - kw[i - 1]!) / kw[i - 1]!;
    assert.ok(swing < 0.05, `${heights[i]} m moved the burn by ${(swing * 100).toFixed(1)}%`);
  }
  let state = {
    ...freshLayer(2.6),
    interfaceM: 0.052,
    upperK: AMBIENT_K + 200,
    upperO2: 0.2,
    lowerO2: 0.2,
  };
  let prev = kw[1]! / 8000;
  for (let i = 0; i < 20; i++) {
    const stepped = stepZone(state, spec, 0.1);
    const swing = Math.abs(stepped.burnedFraction - prev);
    assert.ok(swing < 0.05, `slice ${i} swung by ${swing.toFixed(3)}`);
    assert.ok(
      stepped.burnedFraction > 0.9,
      `slice ${i} burned ${stepped.burnedFraction.toFixed(3)}`,
    );
    prev = stepped.burnedFraction;
    state = stepped.state;
  }
});

test('a clamp shortfall is booked against the upper layer', () => {
  // The sliver's oxygen is almost gone, and the door's fresh inflow is
  // counted in the flame before the sliver can hand it over. That gap is
  // non-zero, so dropping the booking block fails this, and the heat per
  // kilogram removed stays on 13,100.
  const heatKw = 8000;
  const spec: LayerSpec = {
    areaM2: 8,
    ceilingM: 2.6,
    boundaries: [{ areaM2: 40, lining: LINING.concrete }],
    fires: [{ heatKw, diameterM: 1.2 }],
    vents: [
      {
        widthM: 1.2,
        sillM: 0,
        soffitM: 2,
        outside: {
          interfaceM: 0.05,
          upperK: AMBIENT_K + 40,
          floorPressurePa: 8,
          upperO2: 0.23,
        },
      },
    ],
  };
  const state = {
    ...freshLayer(2.6),
    interfaceM: 0.05,
    upperK: AMBIENT_K + 150,
    upperO2: 0.2,
    lowerO2: 0.02,
  };
  const stepped = stepZone(state, spec, 0.1);
  assert.ok(stepped.oxygenShortKg > 0.005, `shortfall ${stepped.oxygenShortKg.toFixed(5)} kg`);
  assert.ok(stepped.flameOxygenKg > stepped.oxygenShortKg);
  const heatKj = heatKw * stepped.burnedFraction * 0.1;
  const perKg = heatKj / stepped.flameOxygenKg;
  assert.ok(
    Math.abs(perKg - DELTA_H_O2_KJ_PER_KG) <= 0.01 * DELTA_H_O2_KJ_PER_KG,
    `${perKg.toFixed(0)} kJ/kg`,
  );
  assert.ok((stepped.state.upperO2 ?? 1) < 0.2, `layer oxygen ${stepped.state.upperO2}`);
});

test('a clamp slice scales the burn to the oxygen the layer holds', () => {
  // One slice of this flame asks for more oxygen than the room holds.
  // The burn has to shrink to that oxygen, or the heat per kilogram
  // removed leaves 13,100.
  const heatKw = 200000;
  const spec: LayerSpec = {
    areaM2: 1.2,
    ceilingM: 2,
    boundaries: [{ areaM2: 12, lining: LINING.concrete }],
    fires: [{ heatKw, diameterM: 1.2 }],
    vents: [],
  };
  const state = {
    ...freshLayer(2),
    interfaceM: 0.05,
    upperK: AMBIENT_K + 800,
    upperO2: 0.18,
    lowerO2: 0.18,
  };
  const stepped = stepZone(state, spec, 0.1);
  assert.equal(stepped.burnScaled, true);
  assert.ok(stepped.burnedFraction < 0.5, `fraction ${stepped.burnedFraction.toFixed(3)}`);
  assert.ok(stepped.flameOxygenKg > 0.05, `oxygen ${stepped.flameOxygenKg.toFixed(4)} kg`);
  const perKg = (heatKw * stepped.burnedFraction * 0.1) / stepped.flameOxygenKg;
  assert.ok(
    Math.abs(perKg - DELTA_H_O2_KJ_PER_KG) <= 0.01 * DELTA_H_O2_KJ_PER_KG,
    `${perKg.toFixed(0)} kJ/kg`,
  );
});

test('a midpoint publish keeps the gas the book already balanced', () => {
  // The published height is the mean of the two ends. Moving the
  // interface without a matching temperature left 0.03 kg on the step
  // that settled this room. The upper temperature is refit so the
  // published height weighs what the booked height weighed.
  const spec: LayerSpec = {
    areaM2: 120,
    ceilingM: 3,
    boundaries: [
      { areaM2: 120, lining: LINING.concrete },
      { areaM2: 120, lining: LINING.concrete },
      { areaM2: 80, lining: LINING.concrete },
    ],
    fires: [{ heatKw: 4000, diameterM: 8 }],
    vents: [{ widthM: 1.6, sillM: 0, soffitM: 2 }],
  };
  let state = {
    ...freshLayer(3),
    interfaceM: 0.052,
    upperK: AMBIENT_K + 180,
    upperO2: 0.19,
    lowerO2: 0.22,
  };
  const dt = 1 / 60;
  let worst = 0;
  let moved = 0;
  for (let i = 0; i < 300; i++) {
    const lower0 = state.lowerK ?? AMBIENT_K;
    const before = gasMassKg(spec, state.interfaceM, state.upperK, lower0);
    const z0 = state.interfaceM;
    const stepped = stepZone(state, spec, dt);
    const lower1 = stepped.state.lowerK ?? AMBIENT_K;
    const after = gasMassKg(spec, stepped.state.interfaceM, stepped.state.upperK, lower1);
    worst = Math.max(worst, Math.abs(after - before - stepped.bookedKg));
    if (
      Math.abs(stepped.state.interfaceM - z0) > 1e-5 &&
      z0 < 0.053 &&
      stepped.state.interfaceM < 0.053
    )
      moved += 1;
    state = stepped.state;
  }
  assert.ok(moved > 0, 'the interface never moved inside the publish band');
  assert.ok(state.interfaceM <= 0.051, `interface finished at ${state.interfaceM.toFixed(4)} m`);
  assert.ok(worst < 0.005, `worst midpoint residual ${worst.toFixed(4)} kg`);
});

test('a flame that has gone out does not relight past the oxygen cutoff', () => {
  // The kitchen's extinction is one sub-second period-3. The slice
  // fraction falls below 0.05, the next slice jumps back above 0.5, and
  // the layer is still at about 0.154. The cutoff is steep and the door
  // inflow twitches. Hold the flame out until the oxygen is on the
  // burning side again. A layer that still has oxygen may relight, and a
  // flame that has not gone out is not clipped.
  const spec: LayerSpec = {
    areaM2: 100,
    ceilingM: 3,
    boundaries: [
      { areaM2: 100, lining: LINING.concrete },
      { areaM2: 100, lining: LINING.concrete },
      { areaM2: 70, lining: LINING.concrete },
    ],
    fires: [{ heatKw: 4200, diameterM: 3 }],
    vents: [
      {
        widthM: 1.5,
        sillM: 0,
        soffitM: 2,
        outside: {
          interfaceM: 0.05,
          upperK: AMBIENT_K + 60,
          floorPressurePa: 2,
          upperO2: 0.12,
        },
      },
    ],
  };
  const at = (y: number, last: number | undefined) => {
    const stepped = stepZone(
      {
        ...freshLayer(3),
        interfaceM: 0.05,
        upperK: AMBIENT_K + 140,
        upperO2: y,
        lowerO2: 0.2,
        ...(last != null ? { lastBurnFraction: last } : {}),
      },
      spec,
      1 / 60,
    );
    return stepped.burnedFraction;
  };
  const held = at(0.154, 0);
  assert.ok(held <= 0.05, `an extinguished slice relit to ${held.toFixed(3)}`);
  const recovered = at(0.17, 0);
  assert.ok(recovered > 0.5, `a layer with oxygen stayed at ${recovered.toFixed(3)}`);
  const stillBurning = at(0.154, 1);
  assert.ok(stillBurning > 0.5, `a flame still burning was cut to ${stillBurning.toFixed(3)}`);

  // The same jump, carried across slices, is the period-3. The limit from
  // one slice is the next slice's release, which is what makes a zero
  // slice report a full fraction and light the fire again.
  let state = {
    ...freshLayer(3),
    interfaceM: 0.05,
    upperK: AMBIENT_K + 140,
    upperO2: 0.156,
    lowerO2: 0.2,
  };
  let prev = 1;
  let flips = 0;
  for (let i = 0; i < 4000; i++) {
    const stepped = stepZone(
      state,
      { ...spec, fires: [{ heatKw: 4200 * prev, diameterM: 3 }] },
      1 / 60,
    );
    const f = stepped.burnedFraction;
    if ((f > 0.5 && prev < 0.05) || (f < 0.05 && prev > 0.5)) flips += 1;
    prev = f;
    state = stepped.state;
    if ((state.upperO2 ?? 1) < 0.14 && i > 200) break;
  }
  assert.equal(flips, 0, `the extinction period-3 returned, ${flips} strict flips`);
});

test('a bare neighbour stream carries its oxygen, soot and fuel', () => {
  // No fire, so the stream is not consumed. Its oxygen, soot and fuel
  // arrive with the mass. CO is not a layer species; the stud dose reads
  // it from this soot.
  const door = { widthM: 2, sillM: 0, soffitM: 2 };
  const spec = (upperO2?: number): LayerSpec => ({
    areaM2: 8,
    ceilingM: 2.5,
    vents: [
      {
        ...door,
        outside: {
          interfaceM: 0.05,
          upperK: AMBIENT_K + 30,
          floorPressurePa: -4,
          sootGPerKg: 2,
          fuelY: 0.05,
          ...(upperO2 != null ? { upperO2 } : {}),
        },
      },
    ],
    boundaries: [{ areaM2: 40, lining: LINING.concrete }],
    fires: [],
  });
  const start = { ...freshLayer(2.5), interfaceM: 0.05, upperK: AMBIENT_K + 30 };
  let lean = start;
  let fresh = start;
  for (let i = 0; i < 40; i++) {
    lean = stepZone(lean, spec(0.21), 0.5).state;
    fresh = stepZone(fresh, spec(), 0.5).state;
  }
  const yLean = lean.upperO2 ?? 0;
  const yFresh = fresh.upperO2 ?? 0;
  assert.ok(yFresh - yLean > 0.003, `lean ${yLean.toFixed(3)} fresh ${yFresh.toFixed(3)}`);
  assert.ok(yLean > 0.18, `upper oxygen fell to ${yLean.toFixed(3)}`);
  assert.ok(lean.sootG > 1, `soot ${lean.sootG.toFixed(3)} g`);
  assert.ok((lean.fuelKg ?? 0) > 0.05, `fuel ${lean.fuelKg ?? 0}`);
});

test('a hot neighbour on the door cuts the outflow', () => {
  // CFAST Eq. 4.1 on both sides. The same hot layer opening onto ambient
  // drives a door. Opening onto a neighbour at the same temperature does not.
  const layer = { ...freshLayer(2.5), interfaceM: 1, upperK: 500 };
  const spec = (hot: boolean): LayerSpec => ({
    areaM2: 10,
    ceilingM: 2.5,
    vents: [
      {
        widthM: 0.8,
        sillM: 0,
        soffitM: 2,
        ...(hot ? { outside: { interfaceM: 1, upperK: 500, floorPressurePa: 0 } } : {}),
      },
    ],
    boundaries: [{ areaM2: 50, lining: LINING.concrete }],
    fires: [],
  });
  const ambient = stepZone(layer, spec(false), 0.1).outByVentKgS[0] ?? 0;
  const neighbour = stepZone(layer, spec(true), 0.1).outByVentKgS[0] ?? 0;
  assert.ok(ambient > 0.2, `ambient door ${ambient}`);
  assert.ok(neighbour < ambient * 0.25, `neighbour door ${neighbour} against ambient ${ambient}`);
});

test('Heskestad flame height matches the 1 MW worked example', () => {
  // L = 0.235 Q^0.4 − 1.02 D = 2.70 m. Entrainment at the tip is positive.
  const atTip = heskestadEntrainmentKgS(1000, 2.7, 1);
  assert.ok(atTip > 1 && atTip < 8, `entrainment at the flame tip is ${atTip}`);
});

test('Heskestad height is measured from the fuel, and a floor fire is unchanged', () => {
  // A 5 K layer leaves the enthalpy cap near 26 kg/s, above either plume,
  // so the height is what the mass follows.
  const spec = (baseM?: number): LayerSpec => ({
    areaM2: 100,
    ceilingM: 10,
    chi: 0.35,
    vents: [{ widthM: 1, sillM: 0, soffitM: 2 }],
    boundaries: [{ areaM2: 400, lining: LINING.concrete }],
    fires: [{ heatKw: 200, diameterM: 0.5, baseM }],
  });
  const floor = oxygenLimitedBurn(spec(), 4, AMBIENT_K + 5, 0.23, 0.23, 1);
  const stand = oxygenLimitedBurn(spec(1), 4, AMBIENT_K + 5, 0.23, 0.23, 1);
  close(floor.plumeKgS, heskestadEntrainmentKgS(200, 4, 0.5), 1e-6, 'floor plume');
  close(stand.plumeKgS, heskestadEntrainmentKgS(200, 3, 0.5), 1e-6, 'stand plume');
  assert.ok(stand.plumeKgS < floor.plumeKgS);
});

test('an isothermal sheet loses heat through the exterior film, and a board keeps k/δ', () => {
  // 1 mm steel, the VTT shell. k/δ is 54 kW/m²K, so a back face held at
  // ambient made the gas see a cold wall. The exterior film is CFAST's
  // default boundary. The ceramic board is the Steckler blanket: past its
  // penetration time, and still conduction-limited.
  const steel: Lining = {
    name: 'steel sheet',
    kKwMK: 0.054,
    rhoKgM3: 7850,
    cKjKgK: 0.425,
    thicknessM: 0.001,
  };
  const gasK = 400;
  const sheet = liningFluxKwM2(steel, 60, gasK);
  const sink = coldSurfaceIncidentKwM2(gasK);
  assert.ok(sheet < 0.6 * sink, `sheet ${sheet.toFixed(3)} cold wall ${sink.toFixed(3)}`);
  assert.ok(sheet > 0.2 * sink, `sheet ${sheet.toFixed(3)} cold wall ${sink.toFixed(3)}`);
  const board = liningFluxKwM2(CERAMIC_FIBRE, 600, gasK);
  assert.ok(board < sheet, `board ${board.toFixed(3)} sheet ${sheet.toFixed(3)}`);
});

test('an isothermal sheet stores its heat and starts cold on every run', () => {
  // 1 mm steel stores about 3.3 kJ/m²K. Against the two films that is on
  // the order of two minutes, so a short fire still sees a cold sheet.
  // A heat-free sheet has no temperature to carry, and a temperature left
  // on the boundary would make the second run hotter than the first.
  const steel: Lining = {
    name: 'steel sheet',
    kKwMK: 0.054,
    rhoKgM3: 7850,
    cKjKgK: 0.425,
    thicknessM: 0.001,
  };
  const floor: Lining = {
    name: 'concrete floor',
    kKwMK: 0.0014,
    rhoKgM3: 2300,
    cKjKgK: 0.88,
    thicknessM: 0.15,
  };
  const spec: LayerSpec = {
    areaM2: 36,
    ceilingM: 2.6,
    chi: 0.35,
    vents: [{ widthM: 0.9, sillM: 0, soffitM: 2 }],
    boundaries: [
      { areaM2: 36, lining: floor },
      { id: 'sheet', areaM2: 60, lining: steel },
    ],
    fires: [{ heatKw: 200, diameterM: 0.5 }],
  };
  const run = () => {
    let state = freshLayer(2.6);
    const sheet: number[] = [];
    for (let t = 1; t <= 400; t++) {
      state = stepZone(state, spec, 1).state;
      if (t === 30 || t === 130 || t === 400) sheet.push((state.sheetK?.sheet ?? 0) - AMBIENT_K);
    }
    return { rise: state.upperK - AMBIENT_K, sheet };
  };
  const first = run();
  const second = run();
  assert.ok(
    Math.abs(first.rise - second.rise) < 0.05,
    `second run ${second.rise} first ${first.rise}`,
  );
  assert.ok(first.sheet[0]! > 5, `sheet at 30 s ${first.sheet[0]}`);
  assert.ok(first.sheet[1]! > first.sheet[0]! + 20, `sheet at 130 s ${first.sheet[1]}`);
  assert.ok(first.sheet[2]! > first.sheet[1]! + 20, `sheet at 400 s ${first.sheet[2]}`);
});

test('a sheet keeps its own temperature when an earlier wall leaves the list', () => {
  // Positional sheetK hands the removed wall's temperature to the next
  // face, or starts that face at ambient. The two sheets have different
  // capacities, so the numbers are not the same.
  const sheet = (thicknessM: number): Lining => ({
    name: 'steel sheet',
    kKwMK: 0.054,
    rhoKgM3: 7850,
    cKjKgK: 0.425,
    thicknessM,
  });
  const floor: Lining = {
    name: 'concrete floor',
    kKwMK: 0.0014,
    rhoKgM3: 2300,
    cKjKgK: 0.88,
    thicknessM: 0.15,
  };
  const walls = (ids: readonly ('early' | 'late')[]): LayerSpec => ({
    areaM2: 36,
    ceilingM: 2.6,
    chi: 0.35,
    vents: [{ widthM: 0.9, sillM: 0, soffitM: 2 }],
    boundaries: [
      { id: 'floor', areaM2: 36, lining: floor },
      ...ids.map((id) => ({
        id,
        areaM2: 30,
        lining: sheet(id === 'early' ? 0.001 : 0.008),
      })),
    ],
    fires: [{ heatKw: 400, diameterM: 0.5 }],
  });
  let state = freshLayer(2.6);
  for (let t = 0; t < 90; t++) state = stepZone(state, walls(['early', 'late']), 1).state;
  const early = state.sheetK?.early ?? 0;
  const late = state.sheetK?.late ?? 0;
  assert.ok(early > late + 15, `early ${early.toFixed(1)} late ${late.toFixed(1)}`);
  // The early wall is first. Dropping it, or listing the late wall first,
  // used to read sheetK[0] as whichever face now occupies that slot.
  const reversed = stepZone(state, walls(['late', 'early']), 1).state;
  assert.ok(
    Math.abs((reversed.sheetK?.late ?? 0) - late) < 5,
    `reversed late ${(reversed.sheetK?.late ?? 0).toFixed(1)} from ${late.toFixed(1)}`,
  );
  assert.ok(
    Math.abs((reversed.sheetK?.early ?? 0) - early) < 5,
    `reversed early ${(reversed.sheetK?.early ?? 0).toFixed(1)} from ${early.toFixed(1)}`,
  );
  const dropped = stepZone(state, walls(['late']), 1).state;
  const kept = dropped.sheetK?.late ?? 0;
  assert.ok(
    Math.abs(kept - late) < 5,
    `late jumped from ${late.toFixed(1)} to ${kept.toFixed(1)}; early was ${early.toFixed(1)}`,
  );
  assert.ok((dropped.sheetK?.early ?? 0) > early - 1, 'the wall that left keeps its heat');
  // A layer that forms again has a fresh zone. The walls are still warm.
  const again = withRememberedSheets(freshLayer(2.6), walls(['late']).boundaries, state.sheetK);
  const reformed = stepZone(again, walls(['late']), 1).state;
  assert.ok(
    Math.abs((reformed.sheetK?.late ?? 0) - late) < 5,
    `re-formed late ${(reformed.sheetK?.late ?? 0).toFixed(1)} from ${late.toFixed(1)}`,
  );
});

test('a sheet held for both rooms keeps one temperature and takes both films', () => {
  const glass = liningForMaterial('glass');
  assert.equal(isothermalSheet(glass, 120), true);
  const spec = (heatKw: number): LayerSpec => ({
    areaM2: 20,
    ceilingM: 2.6,
    vents: [{ widthM: 0.9, sillM: 0, soffitM: 2 }],
    boundaries: [
      { areaM2: 20, lining: LINING.concrete },
      { areaM2: 20, lining: LINING.concrete },
      { id: 'pane', areaM2: 12, lining: glass },
    ],
    fires: heatKw > 0 ? [{ heatKw, diameterM: 0.5 }] : [],
  });
  const start: ZoneState = {
    ...freshLayer(2.6),
    ageS: 120,
    upperK: 600,
    sheetK: { pane: 360 },
  };
  const other: ZoneState = { ...start, upperK: 450 };
  const hold = new Set(['pane']);
  const hot = stepZone(start, spec(80), 30, 0, null, hold);
  const cool = stepZone(other, spec(0), 30, 0, null, hold);
  assert.equal(hot.state.sheetK?.pane, 360, 'the hot room moved a shared sheet on its own');
  assert.equal(cool.state.sheetK?.pane, 360, 'the cool room moved a shared sheet on its own');
  const store = glass.rhoKgM3 * glass.cKjKgK * glass.thicknessM;
  const both = 360 + ((hot.sheetGainKjM2?.pane ?? 0) + (cool.sheetGainKjM2?.pane ?? 0)) / store;
  const alone = stepZone(start, spec(80), 30).state.sheetK?.pane ?? 0;
  // The outdoor film is gone and the other room's gas is on the back face.
  // One room against outdoor air finishes cooler.
  assert.ok(
    both > alone + 1,
    `both ${(both - AMBIENT_K).toFixed(1)} K, one side ${(alone - AMBIENT_K).toFixed(1)} K`,
  );
});

test('the concrete room holds a layer and the stepper reaches it', () => {
  const spec = concreteRoom(500, diameterForReleaseKw(500));
  const steady = steadyLayer(spec, 600);
  assert.ok(steady, 'no steady layer');
  const steadyRise = (steady?.upperK ?? AMBIENT_K) - AMBIENT_K;
  let state = freshLayer(2.6);
  for (let t = 0; t < 600; t += 1) state = stepZone(state, spec, 1).state;
  const runRise = state.upperK - AMBIENT_K;
  assert.ok(
    formsSustainedLayer(steady?.depthM ?? 0, 2.6, steadyRise, hasSmokeReservoir(spec.vents, 2.6)),
    `depth ${steady?.depthM} rise ${steadyRise}`,
  );
  assert.ok(
    Math.abs(runRise - steadyRise) / steadyRise < 0.2,
    `run ${runRise.toFixed(1)} steady ${steadyRise.toFixed(1)}`,
  );
  assert.equal(state.sheetK, undefined);
  assert.ok(Math.abs(state.interfaceM - (steady?.interfaceM ?? 0)) < 0.2);
});

test('the MQH room at 10 minutes is within 20% of the correlation', () => {
  // The film is in series with the slab, so the gas can actually reach the
  // correlation. hk alone, applied to the gas, held this room near 74 K.
  const spec = concreteRoom(500, diameterForReleaseKw(500));
  const hk = effectiveHeatLossKwM2K(LINING.concrete, 600);
  const mqh = mqhRiseK(500, 1.8, 2, 85, hk);
  let state = freshLayer(2.6);
  for (let t = 0; t < 600; t += 1) state = stepZone(state, spec, 1).state;
  const rise = state.upperK - AMBIENT_K;
  assert.ok(
    Math.abs(rise - mqh) / mqh <= 0.2,
    `rise ${rise.toFixed(1)} K, MQH ${mqh.toFixed(1)} K`,
  );
});

test('a small fire in the concrete room is a layer within a minute', () => {
  for (const qKw of [50, 100]) {
    const spec = concreteRoom(qKw, diameterForReleaseKw(qKw));
    let state = freshLayer(2.6);
    let crossed = 0;
    for (let t = 1; t <= 60; t += 1) {
      state = stepZone(state, spec, 1).state;
      if (crossed === 0 && state.upperK - AMBIENT_K >= DISTINCT_LAYER_RISE_K) crossed = t;
    }
    assert.ok(crossed > 0 && crossed <= 60, `${qKw} kW crossed 20 K at ${crossed}s`);
    const steady = steadyLayer(spec, 600);
    const rise = (steady?.upperK ?? AMBIENT_K) - AMBIENT_K;
    assert.ok(
      steady && formsSustainedLayer(steady.depthM, 2.6, rise, hasSmokeReservoir(spec.vents, 2.6)),
      `${qKw} kW steady rise ${rise.toFixed(1)}`,
    );
  }
});

test('Steckler center door reports the coupled flow', () => {
  // NBSIR 82-2520, full 0.74 m by 1.83 m door, 62.9 kW, burner in the centre:
  // outflow 0.571 kg/s. Johansson and van Hees (IAFSS 2014, Table 3) put the
  // interface at 0.91–1.03 m (mean 0.985) and Tg/Ta at 1.33–1.34 (mean 1.335).
  // Room height 2.13 m (NIST TN 1889v3; the report's 2.18 m is the misprint).
  // Burner diameter 0.30 m. Methane's radiative fraction is about 0.2; the
  // contents value 0.35 is for the building, not this burner.
  const width = 2.8;
  const height = 2.13;
  const floor = width * width;
  const doorW = 0.74;
  const doorH = 1.83;
  const walls = 2 * (width + width) * height - doorW * doorH;
  // CFAST's guide records the floor as 19 mm calcium silicate on plywood.
  // The plywood is not a second layer. k, ρ and c are assumed handbook
  // values, not the Armstrong report. Walls and ceiling stay the blanket.
  const calciumSilicate: Lining = {
    name: 'calcium silicate 19 mm',
    kKwMK: 0.00012,
    rhoKgM3: 720,
    cKjKgK: 0.84,
    thicknessM: 0.019,
  };
  const spec: LayerSpec = {
    areaM2: floor,
    ceilingM: height,
    chi: 0.2,
    vents: [{ widthM: doorW, sillM: 0, soffitM: doorH }],
    boundaries: [
      { areaM2: floor, lining: calciumSilicate },
      { areaM2: floor, lining: CERAMIC_FIBRE },
      { areaM2: walls, lining: CERAMIC_FIBRE },
    ],
    fires: [{ heatKw: 62.9, diameterM: 0.3 }],
  };
  const measuredZ = 0.985;
  const measuredRise = (1.335 - 1) * AMBIENT_K;
  const measuredFlow = 0.571;
  const zTol = Math.max(0.2, 0.15 * height);
  let state = freshLayer(height);
  for (let t = 0; t < 600; t += 1) state = stepZone(state, spec, 1).state;
  const steady = steadyLayer(spec, 600);
  assert.ok(steady);
  const rise = state.upperK - AMBIENT_K;
  const atDoor = balanceAt(spec, measuredZ, Math.max(state.ageS, 600));
  const coupled = steady?.outKgS ?? 0;
  assert.ok(
    Math.abs(state.interfaceM - measuredZ) <= zTol,
    `interface ${state.interfaceM.toFixed(3)} m, measured ${measuredZ} ± ${zTol.toFixed(3)}`,
  );
  assert.ok(
    Math.abs((steady?.interfaceM ?? 0) - measuredZ) <= zTol,
    `steady interface ${steady?.interfaceM}`,
  );
  // χQ goes to the surfaces, so the rise is inside 20%. The emissivity
  // is not adjusted to put it there.
  const riseRatio = rise / measuredRise;
  assert.ok(
    Math.abs(riseRatio - 1) <= 0.2,
    `rise ${rise.toFixed(1)} K is ${riseRatio.toFixed(3)} of the measured ${measuredRise.toFixed(1)} K`,
  );
  // The model's own doorway flow. Heskestad at the measured height entrains
  // about 0.30 kg/s and McCaffrey about 0.36; the coupled points are about
  // 0.39 and 0.42 kg/s. Neither is inside 25% of 0.571 (the floor is 0.428).
  // The inverse door jet (Eq. 4.7) was tried in this balance. At this
  // interface it entrains about 0.005 kg/s, and with the interface on the
  // floor it over-entrains and drops the heat and soot it carries, so it
  // is not included. The orifice held at 0.985 m only checks the vent formula.
  // NBSIR 82-2520 measured the neutral plane at 1.027 m on this door. The
  // coupled plane is about 1.23 m, inside the 0.32 m height band. The same
  // orifice at 0.985 m puts the plane at about 1.09 m.
  assert.ok(
    coupled < measuredFlow * 0.75,
    `coupled ${coupled.toFixed(3)} kg/s was reported as inside 25%`,
  );
  assert.ok(
    Math.abs(coupled - 0.392) < 0.03,
    `coupled outflow ${coupled.toFixed(3)} kg/s, measured ${measuredFlow}`,
  );
  assert.ok(
    Math.abs(atDoor.outKgS - measuredFlow) <= 0.25 * measuredFlow,
    `orifice at ${measuredZ} m is ${atDoor.outKgS.toFixed(3)} kg/s`,
  );
  assert.ok(steady);
  assert.ok(
    Math.abs(steady.neutralM - 1.229) < 0.02,
    `coupled neutral plane ${steady.neutralM.toFixed(3)} m`,
  );
  assert.ok(
    Math.abs(steady.neutralM - 1.027) <= zTol,
    `neutral plane ${steady.neutralM.toFixed(3)} m, measured 1.027 ± ${zTol.toFixed(3)}`,
  );
  assert.ok(
    Math.abs(atDoor.neutralM - 1.094) < 0.02,
    `neutral plane at ${measuredZ} m is ${atDoor.neutralM.toFixed(3)} m`,
  );
});

test('a door holds a distinct layer and a wide open hall does not', () => {
  const door = concreteRoom(500, diameterForReleaseKw(500));
  const walled = steadyLayer(door, 600);
  const walledRise = (walled?.upperK ?? AMBIENT_K) - AMBIENT_K;
  assert.ok(hasSmokeReservoir(door.vents, door.ceilingM));
  assert.ok(
    walled && formsSustainedLayer(walled.depthM, door.ceilingM, walledRise, true),
    `door depth ${walled?.depthM} rise ${walledRise}`,
  );
  // A food-centre floor with the long sides open to the ceiling. A gas-jet
  // sized fire can warm a shallow balance past the distinct-layer rise, and
  // there is still no spill edge, so the travelling front keeps the smoke.
  const openVents = [{ widthM: 80, sillM: 0, soffitM: 4 }];
  const hall = steadyLayer(
    {
      areaM2: 1500,
      ceilingM: 4,
      vents: openVents,
      boundaries: [
        { areaM2: 1500, lining: LINING.concrete },
        { areaM2: 1500, lining: LINING.concrete },
      ],
      fires: [{ heatKw: 8000, diameterM: diameterForReleaseKw(8000) }],
    },
    600,
  );
  const hallRise = (hall?.upperK ?? AMBIENT_K) - AMBIENT_K;
  assert.ok(hall);
  assert.ok(!hasSmokeReservoir(openVents, 4));
  assert.ok(!formsSustainedLayer(hall.depthM, 4, hallRise, false));
  // The same floor, shut. A few hundred kilowatts spread over it stay
  // below the distinct-layer rise. A megawatt does not: the film lets the
  // layer warm, so a sealed hall is a layer when the rise says so.
  const shutOf = (qKw: number) =>
    steadyLayer(
      {
        areaM2: 1500,
        ceilingM: 4,
        vents: [],
        boundaries: [
          { areaM2: 1500, lining: LINING.concrete },
          { areaM2: 1500, lining: LINING.concrete },
          { areaM2: 4 * Math.sqrt(1500) * 4, lining: LINING.concrete },
        ],
        fires: [{ heatKw: qKw, diameterM: diameterForReleaseKw(qKw) }],
      },
      600,
    );
  const shut = shutOf(400);
  const shutRise = (shut?.upperK ?? AMBIENT_K) - AMBIENT_K;
  assert.ok(shut && hasSmokeReservoir([], 4));
  assert.ok(shutRise < DISTINCT_LAYER_RISE_K, `shut rise ${shutRise}`);
  assert.ok(!formsSustainedLayer(shut.depthM, 4, shutRise, true));
  const warm = shutOf(1000);
  const warmRise = (warm?.upperK ?? AMBIENT_K) - AMBIENT_K;
  assert.ok(warmRise > DISTINCT_LAYER_RISE_K, `1 MW shut rise ${warmRise}`);
  assert.ok(CEILING_JET_DEPTH_FRACTION > 0);
});

test('a fan takes the layer that contains its intake', () => {
  // CFAST TN 1889v2 §6.2. Full flow through 200 Pa, none at 300 Pa.
  assert.equal(FAN_FULL_FLOW_PA, 200);
  assert.equal(FAN_ZERO_FLOW_PA, 300);
  assert.equal(fanVolumeM3PerS(1, 0), 1);
  assert.equal(fanVolumeM3PerS(1, FAN_FULL_FLOW_PA), 1);
  assert.ok(Math.abs(fanVolumeM3PerS(1, 250) - 0.5) < 1e-12);
  assert.equal(fanVolumeM3PerS(1, FAN_ZERO_FLOW_PA), 0);
  assert.equal(fanVolumeM3PerS(1, 400), 0);

  // 2021 IMC 507.5. 300 cfm/ft, and the code's 1.55 L/s per metre.
  assert.ok(Math.abs(HOOD_EXHAUST_M3_PER_S_PER_M - 0.465) < 1e-12);
  assert.equal(HOOD_LENGTH_M, 1.22);
  assert.ok(Math.abs(HOOD_EXTRACT_M3_PER_S - 0.465 * 1.22) < 1e-12);
  // Greenheck 452413: 80 in from the floor to the canopy's front lower edge.
  // That lip is the intake centre. It is not the link height over the pan.
  assert.ok(Math.abs(HOOD_INTAKE_M - 80 * 0.0254) < 1e-12);
  assert.ok(HOOD_INTAKE_M > HOOD_HEIGHT_M);
  assert.equal(HOOD_FAN_WHEN, 'discharge');

  // Mass is density times the volume still moving. 353 / T is the density
  // already used for the orifice. The intake above the interface is hot.
  const hot = mechanicalExtract([{ flowM3PerS: 1, intakeM: 3 }], 1.5, 400, 0);
  assert.ok(Math.abs(hot.upperKgS - 353 / 400) < 1e-9, `upper ${hot.upperKgS}`);
  assert.equal(hot.lowerKgS, 0);
  const clear = mechanicalExtract([{ flowM3PerS: 1, intakeM: 1.1 }], 2, 400, 0);
  assert.equal(clear.upperKgS, 0);
  assert.ok(Math.abs(clear.lowerKgS - 353 / 293) < 1e-9, `lower ${clear.lowerKgS}`);
  const halved = mechanicalExtract([{ flowM3PerS: 1, intakeM: 1.1 }], 2, 400, -250);
  assert.ok(Math.abs(halved.lowerKgS - 0.5 * (353 / 293)) < 1e-9);

  // Same room, three fans. The one in the smoke holds the interface up and
  // takes soot. The one in the clear air pulls the interface down and
  // leaves the soot in the layer.
  const area = 20;
  const height = 2.6;
  const walls = 2 * (4 + 5) * height - 0.9 * 2;
  const base: LayerSpec = {
    areaM2: area,
    ceilingM: height,
    vents: [{ widthM: 0.9, sillM: 0, soffitM: 2 }],
    boundaries: [
      { areaM2: area, lining: LINING.concrete },
      { areaM2: area, lining: LINING.concrete },
      { areaM2: walls, lining: LINING.concrete },
    ],
    fires: [{ heatKw: 200, diameterM: diameterForReleaseKw(200) }],
  };
  const run = (fans: LayerSpec['fans']) => {
    let state = freshLayer(height);
    for (let t = 0; t < 120; t++) state = stepZone(state, { ...base, fans }, 1, 1).state;
    return state;
  };
  const none = run(undefined);
  const upper = run([{ flowM3PerS: HOOD_EXTRACT_M3_PER_S, intakeM: 2.4 }]);
  const lower = run([{ flowM3PerS: HOOD_EXTRACT_M3_PER_S, intakeM: 0.3 }]);
  assert.ok(
    upper.interfaceM > none.interfaceM,
    `smoke fan ${upper.interfaceM}, none ${none.interfaceM}`,
  );
  assert.ok(
    lower.interfaceM < none.interfaceM,
    `clear fan ${lower.interfaceM}, none ${none.interfaceM}`,
  );
  assert.ok(upper.interfaceM < 2.4, `intake left the smoke ${upper.interfaceM}`);
  assert.ok(lower.interfaceM > 0.3, `clear intake was swallowed ${lower.interfaceM}`);
  assert.ok(upper.sootG < none.sootG, `smoke fan soot ${upper.sootG}, none ${none.sootG}`);
  assert.ok(lower.sootG >= none.sootG * 0.9, `clear fan soot ${lower.sootG}, none ${none.sootG}`);

  // A 40 kW pan in the NUREG room. The canopy is in the smoke, so the
  // interface stays higher than the same room with no fan, and less soot
  // is held.
  const small: LayerSpec = {
    areaM2: 20,
    ceilingM: 2.6,
    vents: [{ widthM: 0.9, sillM: 0, soffitM: 2 }],
    boundaries: [
      { areaM2: 20, lining: LINING.concrete },
      { areaM2: 20, lining: LINING.concrete },
      { areaM2: 2 * 9 * 2.6 - 1.8, lining: LINING.concrete },
    ],
    fires: [{ heatKw: 40, diameterM: diameterForReleaseKw(40) }],
  };
  const pan = (fans: LayerSpec['fans']) => {
    let state = freshLayer(small.ceilingM);
    for (let t = 0; t < 300; t++) state = stepZone(state, { ...small, fans }, 1, 1).state;
    return state;
  };
  const open = pan(undefined);
  const canopy = pan([{ flowM3PerS: HOOD_EXTRACT_M3_PER_S, intakeM: HOOD_INTAKE_M }]);
  assert.ok(
    canopy.interfaceM > open.interfaceM,
    `canopy ${canopy.interfaceM}, open ${open.interfaceM}`,
  );
  assert.ok(canopy.interfaceM > 1.7, `canopy dropped through head height ${canopy.interfaceM}`);
  assert.ok(canopy.sootG < open.sootG, `canopy soot ${canopy.sootG}, open ${open.sootG}`);
});

test('the building outline is a wall except at an exit', () => {
  const studs = new Map([
    ['a', { id: 'a', x: 0, y: 0, level: 'G' }],
    ['b', { id: 'b', x: 3, y: 0, level: 'G' }],
    ['door', { id: 'door', x: 6, y: 0, level: 'G' }],
    ['side', { id: 'side', x: 0, y: 3, level: 'G' }],
  ]);
  const neighbors = new Map<string, readonly string[]>([
    ['a', ['b', 'side']],
    ['b', ['a', 'door']],
    ['door', ['b']],
    ['side', ['a']],
  ]);
  const facade = (member: string, outside: string) => {
    if (member === 'b' && outside === 'door')
      return { kind: 'exit' as const, exitKey: 'west', widthM: 1.6 };
    if (member === 'a' && outside === 'side') return { kind: 'wall' as const };
    return null;
  };
  const enc = enclosureFromGrid(['a', 'b'], studs, neighbors, [], 4, facade);
  assert.ok(enc);
  assert.equal(enc?.spec.vents.length, 1);
  assert.equal(enc?.spec.vents[0]?.widthM, 1.6);
  assert.equal(enc?.spec.vents[0]?.soffitM, DOOR_SOFFIT_M);
  assert.deepEqual(enc?.ventReceivers, [['door']]);
  const wall = enc?.spec.boundaries.find((boundary) => boundary.areaM2 === 3 * 4);
  assert.ok(wall, 'the blocked outline is a wall');
  // The same studs with no facade are one full-height opening, the old spill.
  const open = enclosureFromGrid(['a', 'b'], studs, neighbors, [], 4);
  assert.equal(open?.spec.vents.length, 1);
  assert.equal(open?.spec.vents[0]?.soffitM, 4);
  assert.equal(open?.spec.vents[0]?.widthM, 6);

  const doorWall = {
    id: 'partition',
    x1: 1.5,
    y1: -6,
    x2: 1.5,
    y2: 6,
    hasDoor: true,
    doorWidth: 1.6,
    doorPosition: 0.5,
    material: 'concrete',
    level: 'G',
  };
  const through = enclosureFromGrid(
    ['a'],
    new Map([
      ['a', { id: 'a', x: 0, y: 0, level: 'G' }],
      ['gap', { id: 'gap', x: 3, y: 0, level: 'G' }],
      ['solid', { id: 'solid', x: 3, y: 3, level: 'G' }],
    ]),
    new Map<string, readonly string[]>([
      ['a', ['gap', 'solid']],
      ['gap', ['a']],
      ['solid', ['a']],
    ]),
    [doorWall],
    4,
  );
  assert.deepEqual(through?.ventReceivers, [['gap']]);
});

test('the food-court corridor is a wall, including at its junctions', () => {
  // The service-corridor segments end on the stud rows. A link through
  // that junction used to miss the wall and open a full-height side.
  const corridor = (id: string, y0: number, y1: number, door: boolean) => ({
    id,
    x1: -14.5,
    y1: y0,
    x2: -14.5,
    y2: y1,
    hasDoor: door,
    doorWidth: 1.5,
    doorPosition: 0.5,
    material: 'concrete',
    level: 'G',
  });
  const ys = [-11.5, -8.5, -5.5, -2.5, 0.5, 3.5, 6.5, 9.5, 12.5];
  const studs = new Map<string, { id: string; x: number; y: number; level: string }>();
  const neighbors = new Map<string, readonly string[]>();
  const members: string[] = [];
  for (const y of ys) {
    const court = `c${y}`;
    const service = `s${y}`;
    studs.set(court, { id: court, x: -13, y, level: 'G' });
    studs.set(service, { id: service, x: -16, y, level: 'G' });
    neighbors.set(court, [service]);
    neighbors.set(service, [court]);
    members.push(court);
  }
  const enc = enclosureFromGrid(
    members,
    studs,
    neighbors,
    [
      corridor('kitchen', -11.5, -5.5, true),
      corridor('seating', -5.5, 3.5, false),
      corridor('tile', 3.5, 12.5, true),
    ],
    4,
  );
  assert.ok(enc);
  const fullHeight = enc?.spec.vents.filter((vent) => vent.soffitM > 3.9) ?? [];
  assert.equal(
    fullHeight.length,
    0,
    `full-height width ${fullHeight.map((vent) => vent.widthM).join(',')}`,
  );
  const doors = enc?.spec.vents.filter((vent) => Math.abs(vent.widthM - 1.5) < 0.05) ?? [];
  assert.equal(doors.length, 2);
  assert.ok(doors.every((vent) => vent.soffitM === DOOR_SOFFIT_M));
});

test("Harbour's kitchen keeps its own door and the west shop keeps its exit", () => {
  const shopDoor = {
    id: 'w1',
    x1: 22,
    y1: 0,
    x2: 22,
    y2: 40,
    hasDoor: true,
    doorWidth: 1.6,
    doorPosition: 0.5,
    material: 'drywall',
    level: 'G',
  };
  const kitchenDoor = {
    id: 'w-kitchen',
    x1: 0,
    y1: 8,
    x2: 22,
    y2: 8,
    hasDoor: true,
    doorWidth: 1.6,
    doorPosition: 0.5,
    material: 'drywall',
    level: 'G',
  };
  const kitchen = enclosureFromGrid(
    ['near', 'byDoor'],
    new Map([
      ['near', { id: 'near', x: 19.5, y: 3, level: 'G' }],
      ['mall', { id: 'mall', x: 22.5, y: 3, level: 'G' }],
      ['byDoor', { id: 'byDoor', x: 11, y: 6.5, level: 'G' }],
      ['past', { id: 'past', x: 11, y: 9.5, level: 'G' }],
    ]),
    new Map<string, readonly string[]>([
      ['near', ['mall']],
      ['mall', ['near']],
      ['byDoor', ['past']],
      ['past', ['byDoor']],
    ]),
    [shopDoor, kitchenDoor],
    4,
  );
  assert.equal(kitchen?.spec.vents.length, 1);
  assert.equal(kitchen?.spec.vents[0]?.widthM, 1.6);
  assert.deepEqual(kitchen?.ventReceivers, [['past']]);

  const engine = new SpatialEffectsEngine(undefined, 1);
  const at = (id: string, x: number, y: number, inside = true) => ({
    id,
    simPos: { x, y },
    spatialContext: inside ? ('inside_building' as const) : ('open_air' as const),
    level: 'G',
  });
  engine.init([
    at('shopA', 0.5, 18.5),
    at('shopB', 0.5, 21.5),
    at('outA', -2.5, 18.5, false),
    at('outB', -2.5, 21.5, false),
    at('outWall', -2.5, 27, false),
  ]);
  const verts: Vec2[] = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 40 },
    { x: 0, y: 40 },
  ];
  const west: ExitDef = {
    id: 'E1-west',
    center: { x: 0, y: 20 },
    width: 2,
    edgeIndex: 3,
    description: 'west',
    status: 'open',
    photos: [],
    level: 'G',
  };
  engine.setBuildingEnvelope(verts, [west]);
  const shop = (
    engine as unknown as {
      enclosureOf: (
        room: string,
        members: string[],
        walls: InteriorWall[],
        ceiling: number,
      ) => {
        spec: { vents: { widthM: number; soffitM: number }[] };
        ventReceivers: string[][];
      } | null;
    }
  ).enclosureOf('shopA', ['shopA', 'shopB'], [], 4);
  assert.ok(shop);
  const exits = shop?.spec.vents.filter((vent) => Math.abs(vent.widthM - 2) < 0.05) ?? [];
  assert.equal(exits.length, 1);
  assert.equal(exits[0]?.soffitM, DOOR_SOFFIT_M);
  const receivers = shop?.ventReceivers[shop.spec.vents.indexOf(exits[0]!)] ?? [];
  assert.ok(
    receivers.includes('outA') && receivers.includes('outB'),
    `receivers ${receivers.join(',')}`,
  );
  assert.ok(!receivers.includes('outWall'));
  assert.equal(
    shop?.spec.vents.some((vent) => vent.soffitM > 3.9),
    false,
  );
});

test('the smoke step layers a closed room and leaves an open side alone', () => {
  const wood = defaultLightFuel();
  const stud = (id: string, x: number, y: number, inside = true) => ({
    id,
    simPos: { x, y },
    spatialContext: inside ? ('inside_building' as const) : ('open_air' as const),
    level: 'G',
  });
  const barrier = (
    id: string,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    door: boolean,
  ): InteriorWall => ({
    id,
    start: { x: x1, y: y1 },
    end: { x: x2, y: y2 },
    hasDoor: door,
    doorWidth: 0.9,
    doorPosition: 0.5,
    description: '',
    material: 'concrete',
    photos: [],
    level: 'G',
  });
  const closed = new SpatialEffectsEngine(undefined, 1);
  closed.init([stud('a', 0, 0), stud('b', 3, 0), stud('out', 6, 0)]);
  closed.setStoreyHeights({ G: 2.6 });
  closed.setFuelCells(new Map([['a', wood]]));
  const walls = [
    barrier('n', -1.5, 1.5, 4.5, 1.5, false),
    barrier('s', -1.5, -1.5, 4.5, -1.5, false),
    barrier('w', -1.5, -1.5, -1.5, 1.5, false),
    barrier('e', 4.5, -1.5, 4.5, 1.5, true),
  ];
  (closed as unknown as { fireSim: { ignite: (ids: string[]) => void } }).fireSim.ignite(['a']);
  for (let t = 0; t < 400; t++) closed.step(1, walls, []);
  const ka = extinctionK(closed.studStates.get('a')?.smoke ?? 0);
  const kb = extinctionK(closed.studStates.get('b')?.smoke ?? 0);
  assert.ok(ka > 1 && Math.abs(ka - kb) < 1e-9, `room K ${ka} and ${kb}`);
  const live = [
    ...(
      closed as unknown as {
        layerState: Map<
          string,
          { active: boolean; ceilingM: number; zone: { interfaceM: number } }
        >;
      }
    ).layerState.values(),
  ].find((row) => row.active);
  assert.equal(live?.ceilingM, 2.6);
  assert.ok(live != null && live.zone.interfaceM < 1.7, `interface ${live?.zone.interfaceM}`);

  // No building, so there is no facade and no room. The front still travels.
  const open = new SpatialEffectsEngine(undefined, 1);
  open.init([
    stud('s0', 0, 0, false),
    stud('s1', 3, 0, false),
    stud('s2', 6, 0, false),
    stud('air', 9, 0, false),
  ]);
  open.setFuelCells(new Map([['s0', wood]]));
  (open as unknown as { fireSim: { ignite: (ids: string[]) => void } }).fireSim.ignite(['s0']);
  for (let t = 0; t < 200; t++) open.step(1, [], []);
  const active = [
    ...(open as unknown as { layerState: Map<string, { active: boolean }> }).layerState.values(),
  ].some((row) => row.active);
  const near = extinctionK(open.studStates.get('s1')?.smoke ?? 0);
  const src = extinctionK(open.studStates.get('s0')?.smoke ?? 0);
  assert.equal(active, false);
  assert.ok(src > near && near > 0, `open front ${src} to ${near}`);

  // The outline is a wall. Soot leaves only through the exit, onto the stud
  // that link crosses, not onto the stud outside the blank wall.
  const shell = new SpatialEffectsEngine(undefined, 1);
  shell.init([
    stud('in0', 0, 0),
    stud('in1', 3, 0),
    stud('atExit', -3, 0, false),
    stud('atWall', 3, 6, false),
  ]);
  shell.setStoreyHeights({ G: 4 });
  shell.setFuelCells(new Map([['in0', wood]]));
  const verts: Vec2[] = [
    { x: -1.5, y: -1.5 },
    { x: 4.5, y: -1.5 },
    { x: 4.5, y: 1.5 },
    { x: -1.5, y: 1.5 },
  ];
  const exit: ExitDef = {
    id: 'west',
    center: { x: -1.5, y: 0 },
    width: 1.6,
    edgeIndex: 3,
    description: '',
    status: 'open',
    photos: [],
    level: 'G',
  };
  shell.setBuildingEnvelope(verts, [exit]);
  (shell as unknown as { fireSim: { ignite: (ids: string[]) => void } }).fireSim.ignite(['in0']);
  for (let t = 0; t < 400; t++) shell.step(1, [], []);
  const layered = [
    ...(shell as unknown as { layerState: Map<string, { active: boolean }> }).layerState.values(),
  ].some((row) => row.active);
  const atExit = extinctionK(shell.studStates.get('atExit')?.smoke ?? 0);
  const atWall = extinctionK(shell.studStates.get('atWall')?.smoke ?? 0);
  assert.equal(layered, true);
  assert.ok(atExit > 0.05, `exit stud K ${atExit}`);
  assert.ok(atWall * 5 < atExit, `wall stud K ${atWall} took a share of the exit's soot`);
});

test('oxygen limits the fire at the CFAST cutoff, and 1500 A√H is that cap', () => {
  // CFAST Eq. 3.14. Full burn well above the limit, half on the step, off at the limit.
  assert.ok(lowerOxygenCoefficient(O2_AMBIENT_MASS) > 0.99);
  assert.ok(Math.abs(lowerOxygenCoefficient(O2_LIMIT_MASS + 0.005) - 0.5) < 1e-6);
  assert.ok(lowerOxygenCoefficient(O2_LIMIT_MASS) < 0.01);
  assert.equal(lowerOxygenCoefficient(0), 0);
  assert.equal(O2_LIMIT_MASS, 0.15);
  assert.equal(DELTA_H_O2_KJ_PER_KG, 13100);

  // 0.5 A√H kg/s of air, times 0.23, times 13.1 MJ/kg, against the rounded 1500.
  const derived = 0.5 * O2_AMBIENT_MASS * DELTA_H_O2_KJ_PER_KG;
  assert.ok(Math.abs(derived - KAWAGOE_KW) / KAWAGOE_KW < 0.05, `derived ${derived}`);
  assert.equal(ventilationLimitedKw(0.9, 2), 1500 * 0.9 * Math.sqrt(2));
  const door = oxygenCapacityKw(0.5 * Math.sqrt(2), O2_AMBIENT_MASS);
  assert.ok(Math.abs(door - derived * Math.sqrt(2)) / (KAWAGOE_KW * Math.sqrt(2)) < 0.05);

  // A small prescribed fire in fresh air is not cut. φ is the prescribed release over the oxygen supply.
  const easy = layerBurn([{ heatKw: 62.9, diameterM: 0.3 }], 1.2, O2_AMBIENT_MASS, O2_AMBIENT_MASS);
  assert.ok(easy.fraction > 0.99, `steckler fraction ${easy.fraction}`);
  assert.ok(easy.phi < 0.75, `steckler φ ${easy.phi}`);
  assert.ok(Math.abs(equivalenceRatio(100, 200) - 0.5) < 1e-12);
  assert.equal(equivalenceRatio(100, 0), Number.POSITIVE_INFINITY);

  // No vent. The upper layer loses oxygen and the fire falls below the prescribed release.
  const sealed = concreteRoom(2000, diameterForReleaseKw(2000));
  sealed.vents = [];
  let state = freshLayer(sealed.ceilingM);
  let limited = 1;
  let phiSealed = 0;
  for (let t = 0; t < 120; t++) {
    const step = stepZone(state, sealed, 1);
    state = step.state;
    limited = step.burnedFraction;
    phiSealed = step.phi;
  }
  assert.ok((state.upperO2 ?? 1) < O2_AMBIENT_MASS, `upper oxygen ${state.upperO2}`);
  assert.ok(limited < 0.5, `sealed fraction ${limited}, oxygen ${state.upperO2}`);
  assert.ok(phiSealed > 1, `sealed φ ${phiSealed}`);
  // An emptied lower layer stays empty. It does not refill with ambient air.
  state.lowerO2 = 0.05;
  state.interfaceM = 0.05;
  const held = stepZone(state, sealed, 1);
  assert.ok((held.state.lowerO2 ?? 1) <= 0.05, `lower oxygen refilled to ${held.state.lowerO2}`);
});

test('a single door holds a large fire near 1500 A√H', () => {
  const width = 0.9;
  const height = 2;
  const prescribed = 20000;
  const spec = concreteRoom(prescribed, diameterForReleaseKw(prescribed));
  // Ten studs, one door. The sum of the plumes wants more air than the door admits.
  spec.fires = Array.from({ length: 10 }, () => ({
    heatKw: prescribed / 10,
    diameterM: diameterForReleaseKw(prescribed / 10),
  }));
  let state = freshLayer(spec.ceilingM);
  const burned: number[] = [];
  const phi: number[] = [];
  for (let t = 0; t < 600; t++) {
    const step = stepZone(state, spec, 1);
    state = step.state;
    burned.push(step.burnedFraction * prescribed);
    phi.push(step.phi);
  }
  const tail = burned.slice(480);
  const mean = tail.reduce((sum, value) => sum + value, 0) / tail.length;
  const meanPhi = phi.slice(480).reduce((sum, value) => sum + value, 0) / tail.length;
  const cap = ventilationLimitedKw(width * height, height);
  // The room, not the algebra. The formula itself is within 5%. This is the
  // doorway the stepper actually runs, averaged over the last two minutes.
  assert.ok(Math.abs(mean - cap) / cap < 0.15, `mean ${mean.toFixed(0)} kW vs ${cap.toFixed(0)}`);
  assert.ok(meanPhi > 1, `φ ${meanPhi}`);
  assert.ok(mean / prescribed < 0.5, `fraction ${mean / prescribed}`);
});

test('ten floor seconds stay near 1500 A√H', () => {
  const width = 0.9;
  const height = 2;
  const prescribed = 20000;
  const spec = concreteRoom(prescribed, diameterForReleaseKw(prescribed));
  spec.fires = Array.from({ length: 10 }, () => ({
    heatKw: prescribed / 10,
    diameterM: diameterForReleaseKw(prescribed / 10),
  }));
  const cap = ventilationLimitedKw(width * height, height);
  let state = freshLayer(spec.ceilingM);
  const lines: string[] = [];
  const afterFloor: number[] = [];
  for (let t = 1; t <= 90; t++) {
    const step = stepZone(state, spec, 1);
    state = step.state;
    const burnedKw = step.burnedFraction * prescribed;
    lines.push(`${t} ${burnedKw.toFixed(0)} kW z ${state.interfaceM.toFixed(3)}`);
    if (afterFloor.length > 0 || state.interfaceM <= 0.051) afterFloor.push(burnedKw);
  }
  // The second the interface arrives still holds the lower air it
  // descended through. The upper layer then feeds the flame as well,
  // until that oxygen is gone. The vent limit is the seconds after.
  const shown = lines.join('\n');
  const settled = afterFloor.slice(20, 30);
  assert.equal(settled.length, 10, shown);
  for (const value of settled) {
    assert.ok(
      Math.abs(value - cap) / cap < 0.15,
      `${value.toFixed(0)} kW vs ${cap.toFixed(0)}\n${shown}`,
    );
  }
  assert.ok(
    Math.max(...afterFloor.slice(0, 5)) > cap * 1.15,
    `the layer added nothing above ${cap.toFixed(0)} kW\n${shown}`,
  );
  // One bad doorway root, or the enthalpy cap fed back into the air, used
  // to drop a single second far below the vent limit.
  for (const value of afterFloor) {
    assert.ok(value > cap * 0.5, `collapse ${value.toFixed(0)} kW\n${shown}`);
  }
  // The layer's oxygen is a supply on the floor. At the extinction limit
  // the same door stays on the vent cap, so the door is not counted twice.
  const stored = oxygenLimitedBurn(spec, 0.05, AMBIENT_K + 300, O2_AMBIENT_MASS, 0.177, 0.1);
  const atLimit = oxygenLimitedBurn(
    spec,
    0.05,
    AMBIENT_K + 300,
    O2_AMBIENT_MASS,
    O2_LIMIT_MASS,
    0.1,
  );
  assert.ok(
    stored.burn.burnedKw > cap * 1.15,
    `stored oxygen ${stored.burn.burnedKw.toFixed(0)} kW vs ${cap.toFixed(0)}`,
  );
  assert.ok(
    Math.abs(atLimit.burn.burnedKw - cap) / cap < 0.15,
    `limit ${atLimit.burn.burnedKw.toFixed(0)} kW vs ${cap.toFixed(0)}`,
  );
  const extra = stored.burn.burnedKw - atLimit.burn.burnedKw;
  const layerKw = stored.burn.oxygenUpperKgS * DELTA_H_O2_KJ_PER_KG;
  assert.ok(
    extra < layerKw * 1.05 + 100,
    `extra ${extra.toFixed(0)} kW above the layer's ${layerKw.toFixed(0)} kW`,
  );
});

test('the spill plume is the Poreh doorway term', () => {
  assert.equal(SPILL_PLUME_CM, 0.44);
  assert.equal(SPILL_IGNITION_K, AMBIENT_K + 200);
  // CFAST poreh_plume. ρ = 353/293, hdot = (500 − 293) × 0.4 = 82.8 kW,
  // w = 2 m, rise = 3 m, and (293/500)^(2/3) = 0.7003.
  // 0.44 × 0.7003 × (g ρ² / (cp T))^(1/3) × hdot^(1/3) × w^(2/3) × z = 2.334 kg/s.
  const entrained = spillPlumeEntrainmentKgS(0.4, 500, 2, 3);
  close(entrained, 2.334, 0.002, 'entrainment');
  assert.equal(spillPlumeEntrainmentKgS(0.4, 500, 2, 0), 0);
  assert.equal(spillPlumeEntrainmentKgS(0, 500, 2, 3), 0);
  // The rise starts at max(sill, source interface), not at the soffit.
  assert.equal(spillOriginM(0, 1.4), 1.4);
  assert.equal(spillOriginM(0.8, 0.3), 0.8);
  close(spillRiseM(2.2, 1.4), 0.8, 1e-12, 'rise');
  assert.equal(spillRiseM(1.2, 1.4), 0);
  // The shop's hot band is about 0.9–2.0 m. Above the soffit the whole
  // band entrains. Below the neutral plane, none of it does.
  assert.equal(spillBandShare(2.5, 0.9, 2), 1);
  assert.equal(spillBandShare(0.5, 0.9, 2), 0);
  close(spillBandShare(1.45, 0.9, 2), 0.5, 1e-12, 'half the band');
  assert.equal(spillBandShare(1.2, 2, 1), 1);
  assert.equal(cappedPyrolysisKw(20000, 3800), POST_FLASHOVER_PHI_MAX * 3800);
  assert.equal(cappedPyrolysisKw(1000, 3800), 1000);
  assert.equal(cappedPyrolysisKw(20000, 0), 0);
});

test('a jet whose outflow band is above the interface does not entrain', () => {
  const hall: LayerSpec = {
    areaM2: 20,
    ceilingM: 4,
    vents: [],
    boundaries: [
      { areaM2: 20, lining: LINING.concrete },
      { areaM2: 20, lining: LINING.concrete },
    ],
    fires: [],
  };
  const state = freshLayer(hall.ceilingM);
  state.interfaceM = 1.2;
  state.upperK = 400;
  const jet = {
    kgS: 1.5,
    tempK: 700,
    oxygenY: 0.05,
    fuelY: 0.15,
    originM: 0.2,
    widthM: 2,
  };
  const open = stepZone(state, hall, 0.1, 0, jet);
  const above = stepZone(state, hall, 0.1, 0, { ...jet, lowEdgeM: 1.6, soffitM: 2 });
  const partial = stepZone(state, hall, 0.1, 0, { ...jet, lowEdgeM: 0.8, soffitM: 2 });
  assert.ok(
    (above.state.fuelKg ?? 0) > (open.state.fuelKg ?? 0) + 0.005,
    `band above the layer burned the fuel: above ${(above.state.fuelKg ?? 0).toFixed(4)} kg, open ${(open.state.fuelKg ?? 0).toFixed(4)} kg`,
  );
  assert.ok(
    above.state.interfaceM > open.state.interfaceM + 0.001,
    `band above the layer still entrained: above ${above.state.interfaceM.toFixed(4)} m, open ${open.state.interfaceM.toFixed(4)} m`,
  );
  assert.ok(
    partial.state.interfaceM > open.state.interfaceM + 0.0005 &&
      partial.state.interfaceM < above.state.interfaceM - 0.0005,
    `half band ${partial.state.interfaceM.toFixed(4)} m was not between open ${open.state.interfaceM.toFixed(4)} and above ${above.state.interfaceM.toFixed(4)}`,
  );
});

test('oxygen-starved pyrolysis is carried and burns in the doorway spill', () => {
  const prescribed = 20000;
  const spec = concreteRoom(prescribed, diameterForReleaseKw(prescribed));
  spec.fires = Array.from({ length: 10 }, () => ({
    heatKw: prescribed / 10,
    diameterM: diameterForReleaseKw(prescribed / 10),
  }));
  let state = freshLayer(spec.ceilingM);
  let made = 0;
  let vented = 0;
  const burned: number[] = [];
  for (let t = 0; t < 60; t++) {
    const step = stepZone(state, spec, 1);
    const burnedKw = step.burnedFraction * prescribed;
    const supplyKw = step.phi > 0 && Number.isFinite(step.phi) ? prescribed / step.phi : 0;
    const pyrolysisKw = cappedPyrolysisKw(prescribed, supplyKw);
    made += Math.max(0, pyrolysisKw - burnedKw) / WOOD_HEAT_KJ_KG;
    for (const hot of step.hotByVent) vented += hot.kg * hot.fuelY;
    burned.push(step.burnedFraction * prescribed);
    state = step.state;
  }
  const kept = (state.fuelKg ?? 0) + vented;
  assert.ok(made > 1, `pyrolysate ${made.toFixed(3)} kg`);
  // The added mass uses the last substep's φ, so the integral is a few
  // percent off the sum of the substeps. Removing the cap makes the vent
  // carry several times this.
  close(kept, made, Math.max(0.05, made * 0.05), 'fuel left the layer');
  assert.ok(vented > 0.1, `the door carried ${vented.toFixed(3)} kg`);
  const tail = burned.slice(-10);
  const mean = tail.reduce((sum, value) => sum + value, 0) / tail.length;
  const cap = ventilationLimitedKw(0.9 * 2, 2);
  // The source room still burns only the oxygen its plume took.
  assert.ok(Math.abs(mean - cap) / cap < 0.15, `mean ${mean.toFixed(0)} kW vs ${cap.toFixed(0)}`);
  assert.ok(mean / prescribed < 0.5, `fraction ${mean / prescribed}`);

  // A tall hall. The soffit is below the fresh interface, so the jet
  // spills through the lower layer and entrains its oxygen.
  const hall: LayerSpec = {
    areaM2: 36,
    ceilingM: 6,
    vents: [{ widthM: 2, sillM: 0, soffitM: 2 }],
    boundaries: [
      { areaM2: 36, lining: LINING.concrete },
      { areaM2: 36, lining: LINING.concrete },
      { areaM2: 4 * 6 * 6, lining: LINING.concrete },
    ],
    fires: [],
  };
  // 0.4 kg/s at a fuel mass fraction of 0.1 is 700 kW. The origin is the
  // source interface, here level with the soffit, so the spill still has
  // a rise through the lower layer. A jet with no fuel is the control.
  const jet = {
    kgS: 0.4,
    tempK: 500,
    oxygenY: 0.12,
    fuelY: 0.1,
    originM: 2,
    widthM: 2,
  };
  let rich = freshLayer(hall.ceilingM);
  let plain = freshLayer(hall.ceilingM);
  let arrived = 0;
  let forwarded = 0;
  for (let t = 0; t < 10; t++) {
    const step = stepZone(rich, hall, 1, 0, jet);
    arrived += jet.kgS * jet.fuelY;
    for (const hot of step.hotByVent) forwarded += hot.kg * hot.fuelY;
    rich = step.state;
    plain = stepZone(plain, hall, 1, 0, {
      kgS: jet.kgS,
      tempK: jet.tempK,
      oxygenY: jet.oxygenY,
    }).state;
  }
  const burnedKg = arrived - (rich.fuelKg ?? 0) - forwarded;
  assert.ok(
    burnedKg > arrived * 0.9,
    `burned ${burnedKg.toFixed(4)} kg of ${arrived.toFixed(4)} kg, stored ${rich.fuelKg}`,
  );
  assert.ok(
    rich.upperK > plain.upperK + 30,
    `doorway burn rose to ${(rich.upperK - AMBIENT_K).toFixed(1)} K, the sensible jet to ${(plain.upperK - AMBIENT_K).toFixed(1)} K`,
  );

  // The interface is already below the origin, so the jet enters the
  // upper layer and the spill does not entrain. The fuel is stored, not
  // burned.
  const deep = freshLayer(spec.ceilingM);
  deep.interfaceM = 1;
  const closed: LayerSpec = { ...spec, fires: [] };
  const held = stepZone(deep, closed, 1, 0, jet);
  let heldOut = 0;
  for (const hot of held.hotByVent) heldOut += hot.kg * hot.fuelY;
  close((held.state.fuelKg ?? 0) + heldOut, jet.kgS * jet.fuelY, 1e-6, 'no spill, no burn');
});

test('new pyrolysate leaves on the hot vent while the fuel still fits in the layer', () => {
  // One short step after the room is developed. The new mass is a few
  // hundredths of a kilogram and the layer holds tens, so the end clamp
  // does not fire. A side ledger that keeps the pyrolysate off the vent
  // still satisfies fuel ≤ mass, and this step does not.
  const prescribed = 20000;
  const spec = concreteRoom(prescribed, diameterForReleaseKw(prescribed));
  spec.fires = Array.from({ length: 10 }, () => ({
    heatKw: prescribed / 10,
    diameterM: diameterForReleaseKw(prescribed / 10),
  }));
  let state = freshLayer(spec.ceilingM);
  for (let t = 0; t < 25; t++) state = stepZone(state, spec, 1).state;
  const yF = layerFuelFraction(state, spec.areaM2, spec.ceilingM);
  assert.ok(
    yF > 0.02 && yF < 0.85,
    `fraction ${yF.toFixed(3)} is not a developed layer below the clamp`,
  );
  const limited = oxygenLimitedBurn(
    spec,
    state.interfaceM,
    state.upperK,
    state.lowerO2 ?? O2_AMBIENT_MASS,
    state.upperO2 ?? O2_AMBIENT_MASS,
    0.1,
  );
  const supplyKw =
    limited.burn.phi > 0 && Number.isFinite(limited.burn.phi)
      ? limited.burn.prescribedKw / limited.burn.phi
      : 0;
  const pyrolysisKw = cappedPyrolysisKw(limited.burn.prescribedKw, supplyKw);
  const expectKg = (Math.max(0, pyrolysisKw - limited.burn.burnedKw) * 0.1) / WOOD_HEAT_KJ_KG;
  const freeKg =
    (Math.max(0, limited.burn.prescribedKw - limited.burn.burnedKw) * 0.1) / WOOD_HEAT_KJ_KG;
  const step = stepZone(state, spec, 0.1);
  const depth = Math.max(0.02, spec.ceilingM - step.state.interfaceM);
  const endY = (step.state.fuelKg ?? 0) / upperMixtureKg(step.state.upperK, spec.areaM2, depth);
  assert.ok(endY < 0.9, `the clamp fired at ${endY.toFixed(3)}, so the vent is not the witness`);
  // The extra mass leaves as mixture at the layer fraction, so the vent's
  // fuel fraction does not show it. The vent's mass does: it is the
  // orifice plus the pyrolysate. A side ledger leaves the orifice mass.
  let hotKg = 0;
  const orificeHot = limited.hotOutByVentKgS.reduce((sum, rate) => sum + rate, 0) * 0.1;
  for (const hot of step.hotByVent) {
    if (!(hot.tempK > AMBIENT_K + 1)) continue;
    hotKg += hot.kg;
  }
  const carriedMass = hotKg - orificeHot;
  assert.ok(expectKg > 0.005, `capped pyrolysate ${expectKg.toFixed(4)} kg`);
  assert.ok(
    freeKg > expectKg * 2,
    `free-burn excess ${freeKg.toFixed(4)} kg is not above the cap ${expectKg.toFixed(4)} kg`,
  );
  close(carriedMass, expectKg, Math.max(0.002, expectKg * 0.25), 'pyrolysate on the vent');
  assert.ok(
    carriedMass < freeKg * 0.45,
    `vent took ${carriedMass.toFixed(4)} kg, the free-burn excess is ${freeKg.toFixed(4)} kg`,
  );
});

test('a long vent-limited run keeps the fuel fraction inside the mixture', () => {
  const prescribed = 20000;
  const spec = concreteRoom(prescribed, diameterForReleaseKw(prescribed));
  spec.fires = Array.from({ length: 10 }, () => ({
    heatKw: prescribed / 10,
    diameterM: diameterForReleaseKw(prescribed / 10),
  }));
  let state = freshLayer(spec.ceilingM);
  const fraction: number[] = [];
  for (let t = 0; t < 300; t++) {
    state = stepZone(state, spec, 1).state;
    const y = layerFuelFraction(state, spec.areaM2, spec.ceilingM);
    fraction.push(y);
    const mass = upperMixtureKg(state.upperK, spec.areaM2, spec.ceilingM - state.interfaceM);
    assert.ok(y < 1, `fuel fraction ${y.toFixed(3)} at ${t + 1} s`);
    assert.ok(
      (state.fuelKg ?? 0) <= mass + 1e-6,
      `fuel ${(state.fuelKg ?? 0).toFixed(3)} kg above ${mass.toFixed(3)} kg`,
    );
  }
  const early = fraction[239] ?? 0;
  const late = fraction[299] ?? 0;
  assert.ok(late > 0.05, `the layer held only ${late.toFixed(3)}`);
  assert.ok(
    Math.abs(late - early) < 0.03,
    `fraction still moving, ${early.toFixed(3)} to ${late.toFixed(3)}`,
  );
});

test('a vent jet cooler than tgignt does not burn', () => {
  const hall: LayerSpec = {
    areaM2: 36,
    ceilingM: 6,
    vents: [{ widthM: 2, sillM: 0, soffitM: 2 }],
    boundaries: [
      { areaM2: 36, lining: LINING.concrete },
      { areaM2: 36, lining: LINING.concrete },
      { areaM2: 4 * 6 * 6, lining: LINING.concrete },
    ],
    fires: [],
  };
  const cool = {
    kgS: 0.4,
    tempK: SPILL_IGNITION_K - 1,
    oxygenY: 0.12,
    fuelY: 0.1,
    originM: 2,
    widthM: 2,
  };
  let coolState = freshLayer(hall.ceilingM);
  let hotState = freshLayer(hall.ceilingM);
  let coolVent = 0;
  let hotVent = 0;
  for (let t = 0; t < 5; t++) {
    const coolStep = stepZone(coolState, hall, 1, 0, cool);
    const hotStep = stepZone(hotState, hall, 1, 0, { ...cool, tempK: SPILL_IGNITION_K });
    for (const hot of coolStep.hotByVent) coolVent += hot.kg * hot.fuelY;
    for (const hot of hotStep.hotByVent) hotVent += hot.kg * hot.fuelY;
    coolState = coolStep.state;
    hotState = hotStep.state;
  }
  const arrived = 5 * cool.kgS * cool.fuelY;
  const coolKept = (coolState.fuelKg ?? 0) + coolVent;
  const hotKept = (hotState.fuelKg ?? 0) + hotVent;
  close(coolKept, arrived, 1e-4, 'below tgignt the fuel is only carried');
  assert.ok(
    hotKept < arrived * 0.5,
    `at tgignt ${hotKept.toFixed(4)} kg of ${arrived.toFixed(4)} kg was still unburned`,
  );
});

test('fuel sent into a burning room burns on the oxygen that room left', () => {
  const hall: LayerSpec = {
    areaM2: 36,
    ceilingM: 6,
    vents: [{ widthM: 2, sillM: 0, soffitM: 2 }],
    boundaries: [
      { areaM2: 36, lining: LINING.concrete },
      { areaM2: 36, lining: LINING.concrete },
      { areaM2: 4 * 6 * 6, lining: LINING.concrete },
    ],
    fires: [{ heatKw: 50, diameterM: diameterForReleaseKw(50) }],
  };
  const jet = {
    kgS: 0.4,
    tempK: 500,
    oxygenY: 0.12,
    fuelY: 0.1,
    originM: 2,
    widthM: 2,
    fuelOnly: true,
  };
  let state = freshLayer(hall.ceilingM);
  let arrived = 0;
  let vented = 0;
  for (let t = 0; t < 10; t++) {
    const step = stepZone(state, hall, 1, 0, jet);
    arrived += jet.kgS * jet.fuelY;
    for (const hot of step.hotByVent) vented += hot.kg * hot.fuelY;
    assert.ok(
      step.burnedFraction > 0.9,
      `the room's own fire fell to ${step.burnedFraction.toFixed(3)}`,
    );
    state = step.state;
  }
  const kept = (state.fuelKg ?? 0) + vented;
  const burned = arrived - kept;
  assert.ok(burned > arrived * 0.5, `burned ${burned.toFixed(4)} of ${arrived.toFixed(4)} kg`);

  // The same fuel entering a room already at its door limit does not
  // get a second oxygen supply, and it is not dropped. The interface is
  // on the floor, below the origin, so the spill does not entrain.
  const prescribed = 20000;
  const tight = concreteRoom(prescribed, diameterForReleaseKw(prescribed));
  tight.fires = Array.from({ length: 10 }, () => ({
    heatKw: prescribed / 10,
    diameterM: diameterForReleaseKw(prescribed / 10),
  }));
  let starved = freshLayer(tight.ceilingM);
  for (let t = 0; t < 90; t++) starved = stepZone(starved, tight, 1).state;
  const cap = ventilationLimitedKw(0.9 * 2, 2);
  const richJet = { ...jet, fuelY: 0.2 };
  let quiet = structuredClone(starved);
  let fed = structuredClone(starved);
  const own: number[] = [];
  let jetIn = 0;
  let quietVent = 0;
  let fedVent = 0;
  for (let t = 0; t < 10; t++) {
    const plainStep = stepZone(quiet, tight, 1);
    const fedStep = stepZone(fed, tight, 1, 0, richJet);
    own.push(fedStep.burnedFraction * prescribed);
    jetIn += richJet.kgS * richJet.fuelY;
    for (const hot of plainStep.hotByVent) quietVent += hot.kg * hot.fuelY;
    for (const hot of fedStep.hotByVent) fedVent += hot.kg * hot.fuelY;
    quiet = plainStep.state;
    fed = fedStep.state;
  }
  const mean = own.reduce((sum, value) => sum + value, 0) / own.length;
  assert.ok(
    Math.abs(mean - cap) / cap < 0.2,
    `own fire ${mean.toFixed(0)} kW vs cap ${cap.toFixed(0)}`,
  );
  const keptFromJet = (fed.fuelKg ?? 0) + fedVent - ((quiet.fuelKg ?? 0) + quietVent);
  assert.ok(
    keptFromJet > jetIn * 0.8,
    `the vent-limited room kept ${keptFromJet.toFixed(3)} kg of ${jetIn.toFixed(3)} kg`,
  );
});

test('the spill burn debits oxygen, splits chi, lowers the interface, and cannot take air the layer does not hold', () => {
  const hall: LayerSpec = {
    areaM2: 36,
    ceilingM: 6,
    vents: [{ widthM: 2, sillM: 0, soffitM: 2 }],
    boundaries: [
      { areaM2: 36, lining: LINING.concrete },
      { areaM2: 36, lining: LINING.concrete },
      { areaM2: 4 * 6 * 6, lining: LINING.concrete },
    ],
    fires: [],
  };
  const jet = { kgS: 0.4, tempK: 500, oxygenY: 0.12, fuelY: 0.1, originM: 2, widthM: 2 };
  const start = freshLayer(hall.ceilingM);
  const one = stepZone(start, hall, 0.1, 0, jet);
  const depth0 = hall.ceilingM - start.interfaceM;
  const mass0 = upperMixtureKg(start.upperK, hall.areaM2, depth0);
  const rise = spillRiseM(start.interfaceM, jet.originM);
  const offered = spillPlumeEntrainmentKgS(jet.kgS, jet.tempK, jet.widthM, rise);
  const lowerKg = (353 / AMBIENT_K) * hall.areaM2 * start.interfaceM;
  const mEnt = Math.min(offered, lowerKg / 0.1);
  let kept = one.state.fuelKg ?? 0;
  for (const hot of one.hotByVent) kept += hot.kg * hot.fuelY;
  const burned = jet.kgS * 0.1 * jet.fuelY - kept;
  const doorO2 = burned * (WOOD_HEAT_KJ_KG / DELTA_H_O2_KJ_PER_KG);
  const sliceJet = jet.kgS * 0.1;
  const o2U =
    O2_AMBIENT_MASS * mass0 + mEnt * 0.1 * O2_AMBIENT_MASS - doorO2 + sliceJet * jet.oxygenY;
  const mU2 = mass0 + mEnt * 0.1 + sliceJet;
  close(one.state.upperO2 ?? 0, o2U / mU2, 2e-5, 'upper oxygen after the debit');

  let rich = freshLayer(hall.ceilingM);
  let plain = freshLayer(hall.ceilingM);
  let arrived = 0;
  let ventedFuel = 0;
  for (let t = 0; t < 5; t++) {
    const step = stepZone(rich, hall, 1, 0, jet);
    arrived += jet.kgS * jet.fuelY;
    for (const hot of step.hotByVent) ventedFuel += hot.kg * hot.fuelY;
    rich = step.state;
    plain = stepZone(plain, hall, 1, 0, {
      kgS: jet.kgS,
      tempK: jet.tempK,
      oxygenY: jet.oxygenY,
      originM: jet.originM,
      widthM: jet.widthM,
    }).state;
  }
  const burnedKg = arrived - ((rich.fuelKg ?? 0) + ventedFuel);
  const mass = upperMixtureKg(rich.upperK, hall.areaM2, hall.ceilingM - rich.interfaceM);
  const enthalpy = mass * (rich.upperK - AMBIENT_K);
  const jetSensible = jet.kgS * 5 * (jet.tempK - AMBIENT_K);
  const convected = (1 - RADIATIVE_FRACTION) * burnedKg * WOOD_HEAT_KJ_KG;
  assert.ok(
    enthalpy < jetSensible + convected,
    `gas held ${enthalpy.toFixed(0)} kJ above a convected budget of ${(jetSensible + convected).toFixed(0)} kJ`,
  );
  assert.ok(
    enthalpy > convected * 0.4,
    `the doorway barely warmed the gas, ${enthalpy.toFixed(0)} kJ`,
  );
  assert.ok(
    rich.interfaceM < plain.interfaceM - 0.25,
    `spill air left the interface at ${rich.interfaceM.toFixed(3)} m, the plain jet at ${plain.interfaceM.toFixed(3)} m`,
  );

  const tiny: LayerSpec = {
    areaM2: 0.02,
    ceilingM: 4,
    vents: [],
    boundaries: [
      { areaM2: 1, lining: LINING.concrete },
      { areaM2: 1, lining: LINING.concrete },
      { areaM2: 1, lining: LINING.concrete },
    ],
    fires: [],
  };
  const thin = freshLayer(tiny.ceilingM);
  thin.interfaceM = 3;
  const heavy = { kgS: 1, tempK: 800, oxygenY: 0.05, fuelY: 0.3, originM: 0, widthM: 4 };
  const capped = stepZone(thin, tiny, 0.1, 0, heavy);
  let stored = capped.state.fuelKg ?? 0;
  for (const hot of capped.hotByVent) stored += hot.kg * hot.fuelY;
  const used = heavy.kgS * 0.1 * heavy.fuelY - stored;
  const inventory = (353 / AMBIENT_K) * tiny.areaM2 * thin.interfaceM * O2_AMBIENT_MASS;
  const demand = used * (WOOD_HEAT_KJ_KG / DELTA_H_O2_KJ_PER_KG);
  assert.ok(demand > inventory * 0.5, `the spill burned only ${demand.toFixed(4)} kg of oxygen`);
  assert.ok(
    demand <= inventory * 1.05,
    `the spill took ${demand.toFixed(4)} kg of oxygen from a layer that held ${inventory.toFixed(4)} kg`,
  );
});

test('fallen glass opens a labelled fraction, and a concrete id does not', () => {
  const studs = new Map([
    ['a', { id: 'a', x: 0, y: 0, level: 'G' }],
    ['out', { id: 'out', x: 0, y: 3, level: 'G' }],
  ]);
  const neighbors = new Map<string, readonly string[]>([
    ['a', ['out']],
    ['out', ['a']],
  ]);
  const glass = {
    id: 'pane',
    x1: -2,
    y1: 1.5,
    x2: 4,
    y2: 1.5,
    hasDoor: false,
    doorWidth: 0,
    material: 'glass',
    level: 'G',
  };
  const shut = enclosureFromGrid(['a'], studs, neighbors, [glass], 4);
  assert.ok(shut);
  assert.equal(shut?.spec.vents.length, 0);
  const pane = shut?.spec.boundaries.find((boundary) => boundary.lining.name === 'glass');
  assert.ok(pane);
  assert.equal(pane?.id, 'pane');
  assert.equal(pane?.areaM2, 6 * 4);

  const open = enclosureFromGrid(['a'], studs, neighbors, [glass], 4, undefined, new Set(['pane']));
  assert.equal(open?.spec.vents.length, 1);
  assert.equal(open?.spec.vents[0]?.widthM, 6 * GLASS_FALLOUT_AREA_FRACTION);
  assert.equal(open?.spec.vents[0]?.soffitM, 4);
  assert.equal(open?.spec.vents[0]?.sillM, 0);
  assert.deepEqual(open?.ventReceivers, [['out']]);
  const kept = open?.spec.boundaries.find((boundary) => boundary.lining.name === 'glass');
  assert.ok(kept);
  assert.equal(kept?.id, 'pane');
  assert.ok(Math.abs((kept?.areaM2 ?? 0) - 6 * 4 * (1 - GLASS_FALLOUT_AREA_FRACTION)) < 1e-9);

  const concrete = { ...glass, id: 'slab', material: 'concrete' };
  const stay = enclosureFromGrid(
    ['a'],
    studs,
    neighbors,
    [concrete],
    4,
    undefined,
    new Set(['slab']),
  );
  assert.equal(stay?.spec.vents.length, 0);
  assert.equal(
    stay?.spec.boundaries.some(
      (boundary) => boundary.lining.name === 'concrete' && boundary.areaM2 === 24,
    ),
    true,
  );
});

test('a new layer keeps the glass sheet the wall already holds', () => {
  const wood = defaultLightFuel();
  const stud = (id: string, x: number, y: number, inside = true) => ({
    id,
    simPos: { x, y },
    spatialContext: inside ? ('inside_building' as const) : ('open_air' as const),
    level: 'G',
  });
  const barrier = (
    id: string,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    material: string,
    door: boolean,
  ): InteriorWall => ({
    id,
    start: { x: x1, y: y1 },
    end: { x: x2, y: y2 },
    hasDoor: door,
    doorWidth: 0.9,
    doorPosition: 0.5,
    description: '',
    material,
    photos: [],
    level: 'G',
  });
  const engine = new SpatialEffectsEngine(undefined, 1);
  engine.init([
    stud('a', 0, 0),
    stud('b', 3, 0),
    stud('out', 6, 0, false),
    stud('north', 0, 3, false),
  ]);
  engine.setStoreyHeights({ G: 2.6 });
  engine.setFuelCells(new Map([['a', wood]]));
  const walls = [
    barrier('glass', -1.5, 1.5, 4.5, 1.5, 'glass', false),
    barrier('s', -1.5, -1.5, 4.5, -1.5, 'concrete', false),
    barrier('w', -1.5, -1.5, -1.5, 1.5, 'concrete', false),
    barrier('e', 4.5, -1.5, 4.5, 1.5, 'concrete', true),
  ];
  (engine as unknown as { fireSim: { ignite: (ids: string[]) => void } }).fireSim.ignite(['a']);
  for (let t = 0; t < 180; t++) engine.step(1, walls, []);
  const view = engine as unknown as {
    layerState: Map<
      string,
      {
        active: boolean;
        ceilingM: number;
        zone: ZoneState;
      }
    >;
  };
  const live = [...view.layerState.values()].find((row) => row.active);
  assert.ok(live, 'no layer');
  const sheet = live.zone.sheetK?.glass ?? 0;
  assert.ok(sheet > AMBIENT_K + 8, `sheet ${(sheet - AMBIENT_K).toFixed(1)} K`);
  // The layer is replaced. The wall is still warm, so the new layer must
  // not start that sheet at ambient. A temperature stored by position
  // cannot be copied onto a fresh zone once the boundary list has moved.
  live.zone = freshLayer(live.ceilingM);
  engine.step(1, walls, []);
  const next = [...view.layerState.values()].find((row) => row.zone.sheetK?.glass != null);
  const restored = next?.zone.sheetK?.glass ?? 0;
  assert.ok(
    Math.abs(restored - sheet) < 3,
    `restored ${(restored - AMBIENT_K).toFixed(1)} K from ${(sheet - AMBIENT_K).toFixed(1)} K`,
  );
});

test('an unclaimed sheet cools toward ambient', () => {
  const wood = defaultLightFuel();
  const glass = liningForMaterial('glass');
  const stud = (id: string, x: number, y: number, inside = true) => ({
    id,
    simPos: { x, y },
    spatialContext: inside ? ('inside_building' as const) : ('open_air' as const),
    level: 'G',
  });
  const barrier = (
    id: string,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    material: string,
    door: boolean,
  ): InteriorWall => ({
    id,
    start: { x: x1, y: y1 },
    end: { x: x2, y: y2 },
    hasDoor: door,
    doorWidth: 0.9,
    doorPosition: 0.5,
    description: '',
    material,
    photos: [],
    level: 'G',
  });
  const engine = new SpatialEffectsEngine(undefined, 1);
  engine.init([
    stud('a', 0, 0),
    stud('b', 3, 0),
    stud('out', 6, 0, false),
    stud('north', 0, 3, false),
  ]);
  engine.setStoreyHeights({ G: 2.6 });
  engine.setFuelCells(new Map([['a', wood]]));
  const walls = [
    barrier('glass', -1.5, 1.5, 4.5, 1.5, 'glass', false),
    barrier('s', -1.5, -1.5, 4.5, -1.5, 'concrete', false),
    barrier('w', -1.5, -1.5, -1.5, 1.5, 'concrete', false),
    barrier('e', 4.5, -1.5, 4.5, 1.5, 'concrete', true),
  ];
  (engine as unknown as { fireSim: { ignite: (ids: string[]) => void } }).fireSim.ignite(['a']);
  for (let t = 0; t < 180; t++) engine.step(1, walls, []);
  const view = engine as unknown as {
    fireSim: { states: Map<string, { state: string }> };
    wallSheetK: Map<string, number>;
    layerState: Map<string, { active: boolean; zone: ZoneState }>;
  };
  for (const state of view.fireSim.states.values()) {
    if (state.state === 'burning') state.state = 'burnt_out';
  }
  engine.step(1, walls, []);
  const warm = view.wallSheetK.get('glass') ?? 0;
  const zoned = [...view.layerState.values()].find((row) => row.zone.sheetK?.glass != null);
  assert.ok(warm > AMBIENT_K + 8, `sheet ${(warm - AMBIENT_K).toFixed(1)} K`);
  assert.ok(zoned?.active, 'the hot layer retired when the fire went out');
  assert.ok(
    Math.abs((zoned?.zone.sheetK?.glass ?? 0) - warm) < 0.05,
    'the zone kept a temperature the wall no longer holds',
  );
  // The hold is the zone, not the fire. A cold ceiling leaves on the next
  // step, and the pane then cools with both faces in ambient air. A 6 mm
  // pane stores about 13.6 kJ/m²K, so eight minutes is the check.
  for (const live of view.layerState.values()) {
    if (!live.active) continue;
    live.zone = { ...freshLayer(2.6), upperK: AMBIENT_K, interfaceM: 2.6 };
  }
  engine.step(1, walls, []);
  assert.equal(
    [...view.layerState.values()].some((row) => row.active),
    false,
    'the cold ceiling stayed up',
  );
  const left = view.wallSheetK.get('glass') ?? 0;
  engine.step(480, walls, []);
  const cooled = view.wallSheetK.get('glass') ?? AMBIENT_K;
  const expected = coolUnclaimedSheet(left, glass, 480);
  assert.ok(
    warm - cooled > 4,
    `still ${(cooled - AMBIENT_K).toFixed(1)} K above ambient, from ${(warm - AMBIENT_K).toFixed(1)} K`,
  );
  assert.ok(
    Math.abs(cooled - expected) < 0.5,
    `wall ${(cooled - AMBIENT_K).toFixed(2)} K, films ${(expected - AMBIENT_K).toFixed(2)} K`,
  );
  const after = [...view.layerState.values()].find((row) => row.zone.sheetK?.glass != null);
  assert.ok(
    Math.abs((after?.zone.sheetK?.glass ?? 0) - cooled) < 0.05,
    'the zone still has the temperature from before the layer left',
  );
});

test('a partition between two rooms is one sheet, heated from both sides', () => {
  const wood = defaultLightFuel();
  const stud = (id: string, x: number, y: number, inside = true) => ({
    id,
    simPos: { x, y },
    spatialContext: inside ? ('inside_building' as const) : ('open_air' as const),
    level: 'G',
  });
  const barrier = (id: string, y: number, material: string, door: boolean): InteriorWall => ({
    id,
    start: { x: -0.2, y },
    end: { x: 3.2, y },
    hasDoor: door,
    doorWidth: 0.9,
    doorPosition: 0.5,
    description: '',
    material,
    photos: [],
    level: 'G',
  });
  const burn = (shared: boolean) => {
    const engine = new SpatialEffectsEngine(undefined, 1);
    const people = shared
      ? [
          stud('a', 1.5, 0),
          stud('b', 1.5, 3),
          stud('south', 1.5, -3, false),
          stud('north', 1.5, 6, false),
        ]
      : [stud('a', 1.5, 0), stud('north', 1.5, 3, false), stud('south', 1.5, -3, false)];
    engine.init(people);
    engine.setStoreyHeights({ G: 2.6 });
    engine.setFuelCells(
      new Map(
        shared
          ? [
              ['a', wood],
              ['b', wood],
            ]
          : [['a', wood]],
      ),
    );
    const walls = [barrier('pane', 1.5, 'glass', false), barrier('south', -1.5, 'concrete', true)];
    if (shared) walls.push(barrier('north', 4.5, 'concrete', true));
    const ignite = shared ? ['a', 'b'] : ['a'];
    (engine as unknown as { fireSim: { ignite: (ids: string[]) => void } }).fireSim.ignite(ignite);
    for (let t = 0; t < 180; t++) engine.step(1, walls, []);
    const view = engine as unknown as {
      layerState: Map<string, { active: boolean; zone: ZoneState }>;
    };
    const sheets = [...view.layerState.values()]
      .filter((row) => row.active && row.zone.sheetK?.pane != null)
      .map((row) => row.zone.sheetK?.pane ?? 0);
    return sheets;
  };
  const both = burn(true);
  const one = burn(false);
  assert.equal(both.length, 2, `shared rooms ${both.length}`);
  assert.equal(one.length, 1, `single room ${one.length}`);
  const shared = both[0] ?? 0;
  const other = both[1] ?? 0;
  const alone = one[0] ?? 0;
  assert.ok(
    Math.abs(shared - other) < 0.05,
    `rooms ${(shared - AMBIENT_K).toFixed(1)} K and ${(other - AMBIENT_K).toFixed(1)} K`,
  );
  assert.ok(
    shared > alone + 15,
    `both sides ${(shared - AMBIENT_K).toFixed(1)} K, outdoor back ${(alone - AMBIENT_K).toFixed(1)} K`,
  );
});

test('a shared partition does not lose heat to outdoor air', () => {
  // Two equal pans, one glass partition. One step adds each room's inside
  // film and that room's share of the fire's radiation. The pane is a wall,
  // so each film is the upper layer above the interface and the lower layer
  // below it. The outdoor film on both faces of this pane is larger than the
  // tolerance, so the step's temperature has to match the two films with
  // that outdoor loss left out.
  const glass = liningForMaterial('glass');
  const store = glass.rhoKgM3 * glass.cKjKgK * glass.thicknessM;
  const filmPart = (gasK: number, sheetK: number) => {
    const across = gasK - sheetK;
    const hConv = (SURFACE_CONVECTION_C_W / 1000) * Math.pow(Math.abs(across), 1 / 3);
    const hRad =
      SURFACE_EMISSIVITY * SIGMA_KW_M2K4 * (gasK * gasK + sheetK * sheetK) * (gasK + sheetK);
    return { conv: hConv * across, rad: hRad * across };
  };
  const outdoorKwM2 = (sheetK: number) => {
    if (!(sheetK > AMBIENT_K)) return 0;
    const across = sheetK - AMBIENT_K;
    const hConv = (SURFACE_CONVECTION_C_W / 1000) * Math.pow(across, 1 / 3);
    return hConv * across + SIGMA_KW_M2K4 * (sheetK ** 4 - AMBIENT_K ** 4);
  };
  const pan: FuelCell = {
    category: 'light',
    chfKwM2: 10,
    trp: 134,
    alphaKwS2: 50,
    spreadMPerMin: 0,
    fuelLoadKgM2: 8,
    liquidPool: true,
    poolAreaM2: 0.08,
    sootYieldGPerG: 0.015,
  };
  const stud = (id: string, x: number, y: number, inside = true) => ({
    id,
    simPos: { x, y },
    spatialContext: inside ? ('inside_building' as const) : ('open_air' as const),
    level: 'G',
  });
  const barrier = (id: string, y: number, material: string, door: boolean): InteriorWall => ({
    id,
    start: { x: -0.2, y },
    end: { x: 3.2, y },
    hasDoor: door,
    doorWidth: 0.9,
    doorPosition: 0.5,
    description: '',
    material,
    photos: [],
    level: 'G',
  });
  const people = [
    stud('a', 1.5, 0),
    stud('b', 1.5, 3),
    stud('south', 1.5, -3, false),
    stud('north', 1.5, 6, false),
  ];
  const walls = [
    barrier('pane', 1.5, 'glass', false),
    barrier('south', -1.5, 'concrete', true),
    barrier('north', 4.5, 'concrete', true),
  ];
  const engine = new SpatialEffectsEngine(undefined, 1);
  engine.init(people);
  engine.setStoreyHeights({ G: 2.6 });
  engine.setFuelCells(
    new Map([
      ['a', pan],
      ['b', pan],
    ]),
  );
  (engine as unknown as { fireSim: { ignite: (ids: string[]) => void } }).fireSim.ignite([
    'a',
    'b',
  ]);
  for (let t = 0; t < 600; t++) engine.step(1, walls, []);
  const view = engine as unknown as {
    wallSheetK: Map<string, number>;
    layerState: Map<string, { active: boolean; zone: ZoneState; members: string[] }>;
    gridStuds: Map<string, GridStud>;
    neighborCache: Map<string, readonly string[]>;
    layerGridWalls: GridWall[];
  };
  const rooms = [...view.layerState.values()].filter(
    (row) => row.active && row.zone.sheetK?.pane != null,
  );
  assert.equal(rooms.length, 2, `shared rooms ${rooms.length}`);
  const start = view.wallSheetK.get('pane') ?? 0;
  const gases = rooms.map((row) => row.zone.upperK);
  assert.ok(Math.abs((gases[0] ?? 0) - (gases[1] ?? 0)) < 0.05, 'the two layers diverged');
  assert.ok(start > AMBIENT_K + 25, `pane only ${(start - AMBIENT_K).toFixed(1)} K above ambient`);
  for (const row of rooms) {
    assert.ok(Math.abs((row.zone.sheetK?.pane ?? 0) - start) < 0.05, 'the zone left the wall');
  }
  const qBefore = engine.fuelReleaseKw('a') ?? 0;
  assert.ok(
    Math.abs(qBefore - poolFireKw(pan.poolAreaM2 ?? 0)) < 0.05,
    `release ${qBefore.toFixed(2)} kW`,
  );
  engine.step(1, walls, []);
  const q = engine.fuelReleaseKw('a') ?? 0;
  assert.ok(Math.abs(q - qBefore) < 0.01, 'the pan was still growing during the step');
  const outdoor = new Set(['south', 'north']);
  let gained = 0;
  for (let i = 0; i < rooms.length; i++) {
    const row = rooms[i];
    if (!row) continue;
    const enc = enclosureFromGrid(
      row.members,
      view.gridStuds,
      view.neighborCache,
      view.layerGridWalls,
      2.6,
      (memberId, outsideId) => {
        if (outdoor.has(memberId) === outdoor.has(outsideId)) return null;
        return { kind: 'wall' };
      },
    );
    assert.ok(enc, 'no enclosure');
    let area = 0;
    let pane = 0;
    for (const boundary of enc.spec.boundaries) {
      if (!(boundary.areaM2 > 0)) continue;
      area += boundary.areaM2;
      if (boundary.id === 'pane') pane = boundary.areaM2;
    }
    assert.ok(pane > 8, `pane area ${pane.toFixed(2)} m²`);
    const rad = area > 0 ? (RADIATIVE_FRACTION * q) / area : 0;
    const upper = gases[i] ?? 0;
    const lower = row.zone.lowerK ?? AMBIENT_K;
    const upperFrac = Math.min(1, Math.max(0, (2.6 - row.zone.interfaceM) / 2.6));
    // The pane below the interface convects with the lower gas and still
    // radiates to the upper gas. The lower layer is clear.
    const hot = filmPart(upper, start);
    const cold = filmPart(lower, start);
    const film = (hot.conv + hot.rad) * upperFrac + (cold.conv + hot.rad) * (1 - upperFrac);
    gained += film + rad;
  }
  const predicted = start + gained / store;
  const actual = view.wallSheetK.get('pane') ?? 0;
  const outdoorK = (2 * outdoorKwM2(start)) / store;
  assert.ok(outdoorK > 0.02, `an outdoor film would move the pane only ${outdoorK.toFixed(4)} K`);
  assert.ok(
    Math.abs(actual - predicted) < 0.005,
    `moved ${(actual - start).toFixed(4)} K, both films ${(predicted - start).toFixed(4)} K, outdoor film ${outdoorK.toFixed(4)} K`,
  );
  for (const row of view.layerState.values()) {
    if (row.zone.sheetK?.pane == null) continue;
    assert.ok(Math.abs(row.zone.sheetK.pane - actual) < 0.05, 'the rooms no longer share the pane');
  }
});

test('a door jet warms an upper layer that has no fire', () => {
  const spec: LayerSpec = {
    areaM2: 36,
    ceilingM: 2.44,
    vents: [{ widthM: 0.81, sillM: 0, soffitM: 2 }],
    boundaries: [
      { areaM2: 36, lining: LINING.concrete },
      { areaM2: 36, lining: LINING.concrete },
      { areaM2: 4 * 6 * 2.44, lining: LINING.concrete },
    ],
    fires: [],
  };
  const jet = { kgS: 0.3, tempK: AMBIENT_K + 90, oxygenY: 0.18 };
  let state = freshLayer(spec.ceilingM);
  for (let t = 0; t < 300; t++) state = stepZone(state, spec, 1, 0, jet).state;
  const rise = state.upperK - AMBIENT_K;
  const fresh = freshLayer(spec.ceilingM);
  // 0.3 kg/s at a 90 K rise into this 36 m² concrete room levels off just
  // under the 20 K layer line. The mass still deepens the layer. A real
  // doorway, checked below, is hot enough to cross the line.
  assert.ok(rise > 15 && rise < 25, `rise ${rise.toFixed(1)} K`);
  assert.ok(state.interfaceM < fresh.interfaceM, `interface ${state.interfaceM}`);
  let cold = freshLayer(spec.ceilingM);
  for (let t = 0; t < 300; t++) cold = stepZone(cold, spec, 1, 0).state;
  assert.ok(cold.upperK < AMBIENT_K + 2, `no jet rose to ${cold.upperK - AMBIENT_K} K`);
});

test('a door into another room reads that room, and a door outdoors does not', () => {
  const gauges = new Map([['hall', { interfaceM: 1, upperK: 500, floorPressurePa: 2 }]]);
  const members = new Set(['a']);
  const rooms = new Map([
    ['a', 'fire'],
    ['b', 'hall'],
    ['c', 'hall'],
    ['d', 'other'],
  ]);
  const hit = neighbourVentOutside(['b', 'c', 'd'], 'fire', members, rooms, gauges);
  assert.equal(hit?.upperK, 500);
  assert.equal(hit?.floorPressurePa, 2);
  assert.equal(neighbourVentOutside(['yard'], 'fire', members, rooms, gauges), undefined);
  assert.equal(neighbourVentOutside(['a'], 'fire', members, rooms, gauges), undefined);
  assert.equal(neighbourVentOutside([], 'fire', members, rooms, gauges), undefined);
  // The other room has no layer yet, so the door still opens to ambient.
  assert.equal(neighbourVentOutside(['d'], 'fire', members, rooms, gauges), undefined);
});

test('a production door into a hot room chokes the fire room', () => {
  // Same fire, same door. One far side is a room that fills from the jet.
  // The other is outdoors. If the engine leaves every door on ambient, the
  // two fire rooms match. CFAST Eq. 4.1 against the hot room cuts the
  // outflow, so that fire room runs hotter.
  const wood = defaultLightFuel();
  const stud = (id: string, x: number, y: number, indoors: boolean) => ({
    id,
    simPos: { x, y },
    spatialContext: indoors ? ('inside_building' as const) : ('open_air' as const),
    level: 'G',
  });
  const barrier = (
    id: string,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    door: boolean,
  ): InteriorWall => ({
    id,
    start: { x: x1, y: y1 },
    end: { x: x2, y: y2 },
    hasDoor: door,
    doorWidth: 0.9,
    doorPosition: 0.5,
    description: '',
    material: 'concrete',
    photos: [],
    level: 'G',
  });
  const walls = [
    barrier('fs', -1.5, -1.5, 1.5, -1.5, false),
    barrier('fw', -1.5, -1.5, -1.5, 1.5, false),
    barrier('fe', 1.5, -1.5, 1.5, 1.5, false),
    barrier('door', -1.5, 1.5, 1.5, 1.5, true),
    barrier('hw', -1.5, 1.5, -1.5, 4.5, false),
    barrier('he', 1.5, 1.5, 1.5, 4.5, false),
    barrier('hn', -1.5, 4.5, 1.5, 4.5, false),
  ];
  const riseOf = (indoors: boolean) => {
    const engine = new SpatialEffectsEngine(undefined, 1);
    engine.init([stud('fire', 0, 0, true), stud('hall', 0, 3, indoors)]);
    engine.setStoreyHeights({ G: 2.6 });
    engine.setFuelCells(new Map([['fire', wood]]));
    const exposed = engine as unknown as {
      fireSim: { ignite: (ids: string[]) => void };
      layerState: Map<string, { active: boolean; members: string[]; zone: { upperK: number } }>;
    };
    exposed.fireSim.ignite(['fire']);
    for (let t = 0; t < 180; t++) engine.step(1, walls, []);
    let fireK = AMBIENT_K;
    let hallK = AMBIENT_K;
    let hallActive = false;
    for (const live of exposed.layerState.values()) {
      if (live.members.includes('fire') && live.members.length === 1 && live.active) {
        fireK = live.zone.upperK;
      }
      if (live.members.includes('hall') && live.active) {
        hallK = live.zone.upperK;
        hallActive = true;
      }
    }
    return { fireRise: fireK - AMBIENT_K, hallRise: hallK - AMBIENT_K, hallActive };
  };
  const coupled = riseOf(true);
  const outdoors = riseOf(false);
  assert.ok(coupled.hallActive, 'the hall never formed a layer to stand on the far side');
  assert.ok(coupled.hallRise > 30, `hall rise ${coupled.hallRise.toFixed(1)} K`);
  assert.ok(outdoors.fireRise > 20, `outdoor fire rise ${outdoors.fireRise.toFixed(1)} K`);
  assert.ok(
    coupled.fireRise > outdoors.fireRise + 15,
    `coupled ${coupled.fireRise.toFixed(1)} K, outdoors ${outdoors.fireRise.toFixed(1)} K`,
  );
});

test('a door jet assigns the vented mass and enthalpy to the receiving room', () => {
  const rooms = new Map<string, string>([
    ['a', 'fire'],
    ['b1', 'hall'],
    ['b2', 'hall'],
    ['c', 'other'],
  ]);
  const members = new Set(['a']);
  const hot = [{ kg: 2, tempK: 500, oxygenY: 0.12 }];
  // Two hall studs, one other room, the source itself, and the outdoors.
  const split = assignDoorJet('fire', members, [['b1', 'b2', 'c', 'a', 'outside']], hot, rooms);
  const hall = split.get('hall');
  const other = split.get('other');
  assert.ok(hall);
  assert.ok(other);
  assert.equal(split.has('fire'), false);
  close(hall.kg, 2 * (2 / 5), 1e-12, 'hall kg');
  close(other.kg, 2 * (1 / 5), 1e-12, 'other kg');
  close(hall.kg + other.kg, 2 * (3 / 5), 1e-12, 'assigned share');
  close(hall.tKg, hall.kg * 500, 1e-9, 'hall enthalpy');
  close(other.tKg, other.kg * 500, 1e-9, 'other enthalpy');
  close(hall.yKg, hall.kg * 0.12, 1e-12, 'hall oxygen');

  const fueled = assignDoorJet(
    'fire',
    members,
    [['b1', 'b2', 'c', 'a', 'outside']],
    [{ kg: 2, tempK: 500, oxygenY: 0.12, fuelY: 0.04 }],
    rooms,
  );
  const fueledHall = fueled.get('hall');
  assert.ok(fueledHall);
  close(fueledHall.fKg ?? 0, fueledHall.kg * 0.04, 1e-12, 'hall fuel');
  const fueledJet = queueDoorJets(fueled, 1).get('hall');
  assert.ok(fueledJet);
  close(fueledJet.fuelY ?? 0, 0.04, 1e-12, 'queued fuel');

  const both = assignDoorJet(
    'fire',
    members,
    [['b1'], ['b2']],
    [
      { kg: 1, tempK: 400, oxygenY: 0.2 },
      { kg: 3, tempK: 600, oxygenY: 0.1 },
    ],
    rooms,
  );
  const summed = both.get('hall');
  assert.ok(summed);
  close(summed.kg, 4, 1e-12, 'summed kg');
  close(summed.tKg, 1 * 400 + 3 * 600, 1e-9, 'summed enthalpy');
  close(summed.yKg, 1 * 0.2 + 3 * 0.1, 1e-12, 'summed oxygen');

  const queued = queueDoorJets(both, 1);
  const jet = queued.get('hall');
  assert.ok(jet);
  close(jet.kgS * 1, summed.kg, 1e-12, 'queued mass');
  close(jet.kgS * jet.tempK, summed.tKg, 1e-9, 'queued enthalpy');
  close(jet.oxygenY, summed.yKg / summed.kg, 1e-12, 'queued oxygen');

  const dust = new Map<string, DoorJetParcel>([
    ['hall', { kg: DOOR_JET_MIN_KGS / 10, tKg: 400 * (DOOR_JET_MIN_KGS / 10), yKg: 0 }],
  ]);
  assert.equal(queueDoorJets(dust, 1).size, 0);
  const cold = assignDoorJet(
    'fire',
    members,
    [['b1']],
    [{ kg: 1, tempK: AMBIENT_K, oxygenY: 0.23 }],
    rooms,
  );
  assert.equal(cold.size, 0);
});

function offeredParcels(
  books: readonly DoorJetBook[],
  rooms: ReadonlyMap<string, string>,
): Map<string, DoorJetParcel> {
  const out = new Map<string, DoorJetParcel>();
  for (const book of books) {
    const part = assignDoorJet(book.room, new Set(book.members), book.receivers, book.hot, rooms);
    for (const [dest, parcel] of part) {
      const cur = out.get(dest) ?? { kg: 0, tKg: 0, yKg: 0 };
      cur.kg += parcel.kg;
      cur.tKg += parcel.tKg;
      cur.yKg += parcel.yKg;
      out.set(dest, cur);
    }
  }
  return out;
}

test('the neighbour of a burning room forms a layer from the door jet', () => {
  const wood = defaultLightFuel();
  const stud = (id: string, x: number, y: number) => ({
    id,
    simPos: { x, y },
    spatialContext: 'inside_building' as const,
    level: 'G',
  });
  const barrier = (
    id: string,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    door: boolean,
  ): InteriorWall => ({
    id,
    start: { x: x1, y: y1 },
    end: { x: x2, y: y2 },
    hasDoor: door,
    doorWidth: 0.9,
    doorPosition: 0.5,
    description: '',
    material: 'concrete',
    photos: [],
    level: 'G',
  });
  const engine = new SpatialEffectsEngine(undefined, 1);
  engine.init([stud('fire', 0, 0), stud('hall', 0, 3)]);
  engine.setStoreyHeights({ G: 2.6 });
  engine.setFuelCells(new Map([['fire', wood]]));
  const walls = [
    barrier('fs', -1.5, -1.5, 1.5, -1.5, false),
    barrier('fw', -1.5, -1.5, -1.5, 1.5, false),
    barrier('fe', 1.5, -1.5, 1.5, 1.5, false),
    barrier('door', -1.5, 1.5, 1.5, 1.5, true),
    barrier('hw', -1.5, 1.5, -1.5, 4.5, false),
    barrier('he', 1.5, 1.5, 1.5, 4.5, false),
    barrier('hn', -1.5, 4.5, 1.5, 4.5, false),
  ];
  const exposed = engine as unknown as {
    fireSim: {
      ignite: (ids: string[]) => void;
      compartmentsOf: (walls: InteriorWall[]) => ReadonlyMap<string, string>;
    };
    jetAudit: DoorJetBook[] | null;
    jetTaken: Map<string, { kgS: number; tempK: number; oxygenY: number }>;
    sootK: Map<string, number>;
    layerState: Map<
      string,
      {
        active: boolean;
        members: string[];
        zone: { sootG: number; interfaceM: number; upperK: number };
      }
    >;
  };
  exposed.fireSim.ignite(['fire']);
  // A known column load, so a scoop on activation would show up as a jump
  // in the layer equal to these grams. Soot does not change the jet.
  const seededK = 2;
  exposed.sootK.set('hall', seededK);
  const columnG = (k: number) => (k * STUD_AREA_M2 * 2.6) / SOOT_EXTINCTION_M2_PER_G;
  const audit: DoorJetBook[] = [];
  exposed.jetAudit = audit;
  const rooms = exposed.fireSim.compartmentsOf(walls);
  const hallId = rooms.get('hall');
  const fireId = rooms.get('fire');
  assert.ok(hallId && fireId && hallId !== fireId, 'the door did not make two rooms');
  let prev: DoorJetBook[] = [];
  let sentKg = 0;
  let sentKJ = 0;
  let hallWasActive = false;
  let prevColumnG = columnG(seededK);
  let prevLayerG = 0;
  let checkedSoot = false;
  for (let t = 0; t < 400; t++) {
    engine.step(1, walls, []);
    // What the source vents assigned on the previous step is what this step
    // passes into the receiver. The fire room is in the queue when the hall
    // flows back, and it does not take that jet.
    const expected = queueDoorJets(offeredParcels(prev, rooms), 1);
    assert.equal(exposed.jetTaken.has(fireId), false, 'the fire room took the jet again');
    for (const [room, got] of exposed.jetTaken) {
      const exp = expected.get(room);
      assert.ok(exp, `${room} took a jet that was not sent`);
      close(got.kgS, exp.kgS, 1e-9, `${room} mass kg/s`);
      close(got.kgS * got.tempK, exp.kgS * exp.tempK, 1e-6, `${room} enthalpy kJ/s`);
      close(got.oxygenY, exp.oxygenY, 1e-9, `${room} oxygen`);
    }
    const expHall = expected.get(hallId);
    if (expHall) {
      const gotHall = exposed.jetTaken.get(hallId);
      assert.ok(gotHall, 'the hall did not take the jet sent on the previous step');
      sentKg += expHall.kgS;
      sentKJ += expHall.kgS * expHall.tempK;
    }
    const hallLive = exposed.layerState.get(hallId);
    const columnNow = columnG(exposed.sootK.get('hall') ?? 0);
    const layerNow = hallLive?.zone.sootG ?? 0;
    if (!hallWasActive && hallLive?.active === true) {
      checkedSoot = true;
      assert.ok(
        prevColumnG > 0.5,
        `only ${prevColumnG.toFixed(3)} g was in the column, so a copied scoop would not show`,
      );
      const gained = layerNow - prevLayerG;
      assert.ok(
        gained < prevColumnG * 0.5,
        `the layer gained ${gained.toFixed(3)} g while ${prevColumnG.toFixed(3)} g stayed in the column`,
      );
      // Once the interface is at the head the stud shows the layer, so the
      // column reading is no longer the lower soot. Above the head it is.
      if (hallLive.zone.interfaceM > HEAD_HEIGHT_M) {
        assert.ok(
          columnNow > prevColumnG * 0.5,
          `column soot fell from ${prevColumnG.toFixed(3)} g to ${columnNow.toFixed(3)} g when the layer formed`,
        );
      }
    }
    hallWasActive = hallLive?.active === true;
    prevColumnG = columnNow;
    prevLayerG = layerNow;
    prev = audit.map((book) => ({
      room: book.room,
      members: book.members.slice(),
      receivers: book.receivers.map((ids) => ids.slice()),
      hot: book.hot.map((row) => ({ kg: row.kg, tempK: row.tempK, oxygenY: row.oxygenY })),
    }));
  }
  assert.ok(sentKg > 1, `the door moved only ${sentKg.toFixed(4)} kg`);
  assert.ok(sentKJ > sentKg * (AMBIENT_K + 1), 'the jet enthalpy was not above ambient');
  assert.ok(checkedSoot, 'the hall layer never formed, so the soot check did not run');
  const layers = [
    ...(
      engine as unknown as {
        layerState: Map<
          string,
          {
            active: boolean;
            members: string[];
            zone: { interfaceM: number; upperK: number };
          }
        >;
      }
    ).layerState.values(),
  ];
  const hall = layers.find((row) => row.members.includes('hall'));
  const fire = layers.find((row) => row.members.includes('fire') && row.members.length === 1);
  assert.ok(fire?.active, 'the fire room lost its layer');
  assert.equal(fire?.members.includes('hall'), false, 'the door did not split the rooms');
  assert.ok(hall?.active, `hall layer active=${hall?.active}`);
  const rise = (hall?.zone.upperK ?? AMBIENT_K) - AMBIENT_K;
  assert.ok(rise >= DISTINCT_LAYER_RISE_K, `hall rise ${rise.toFixed(1)} K`);
  assert.ok((hall?.zone.interfaceM ?? 2.6) < 2.6, `hall interface ${hall?.zone.interfaceM}`);
  assert.ok(extinctionK(engine.studStates.get('hall')?.smoke ?? 0) > 0, 'hall stud has no smoke');
});

test('a burning room keeps the fuel a neighbour jets in', () => {
  // One stud tops out near 2.3 MW. Four of them behind a 0.35 m door are
  // vent-limited, so the jet carries fuel. The fuelOnly path is what the
  // engine passes.
  // Calling stepZone with fuelOnly from the test would still pass if that
  // call were deleted. The cold run keeps the same walls, so the hall's
  // own fire is the control. Both runs solve the door against the other
  // room, so the control is already choked and the extra is only the fuel
  // that arrives. The volume expansion carries the jet's heat back out
  // the door, so the hall is not hotter than its own fire. The fuel
  // stays. The hall alone now retains about 0.12 kg, and the jet adds
  // about 0.12 kg on top of that. The old 0.2 kg margin was the gap when
  // the control retained none. Dropping the jet's fuel leaves none of
  // that extra mass.
  const monster = { ...defaultLightFuel(), alphaKwS2: 80, fuelLoadKgM2: 200 };
  const hallFuel = { ...defaultLightFuel(), alphaKwS2: 0.2, fuelLoadKgM2: 80 };
  const sources = [
    ['a', 0, 0],
    ['b', 0.4, 0],
    ['c', -0.4, 0],
    ['d', 0, 0.4],
  ] as const;
  const stud = (id: string, x: number, y: number) => ({
    id,
    simPos: { x, y },
    spatialContext: 'inside_building' as const,
    level: 'G',
  });
  const barrier = (
    id: string,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    door: boolean,
  ): InteriorWall => ({
    id,
    start: { x: x1, y: y1 },
    end: { x: x2, y: y2 },
    hasDoor: door,
    doorWidth: 0.35,
    doorPosition: 0.5,
    description: '',
    material: 'concrete',
    photos: [],
    level: 'G',
  });
  const walls = [
    barrier('fs', -1.5, -1.5, 1.5, -1.5, false),
    barrier('fw', -1.5, -1.5, -1.5, 1.5, false),
    barrier('fe', 1.5, -1.5, 1.5, 1.5, false),
    barrier('door', -1.5, 1.5, 1.5, 1.5, true),
    barrier('hw', -1.5, 1.5, -1.5, 4.5, false),
    barrier('he', 1.5, 1.5, 1.5, 4.5, false),
    barrier('hn', -1.5, 4.5, 1.5, 4.5, false),
  ];
  const run = (withSource: boolean) => {
    const engine = new SpatialEffectsEngine(undefined, 1);
    const studs = [...sources.map(([id, x, y]) => stud(id, x, y)), stud('hall', 0, 3)];
    engine.init(studs);
    engine.setStoreyHeights({ G: 2.6 });
    const cells = new Map<string, FuelCell>([['hall', hallFuel]]);
    for (const [id] of sources) cells.set(id, monster);
    engine.setFuelCells(cells);
    const exposed = engine as unknown as {
      fireSim: { ignite: (ids: string[]) => void };
      jetAudit: DoorJetBook[] | null;
      layerState: Map<
        string,
        { active: boolean; members: string[]; zone: { upperK: number; fuelKg?: number } }
      >;
    };
    exposed.fireSim.ignite(withSource ? [...sources.map(([id]) => id), 'hall'] : ['hall']);
    const audit: DoorJetBook[] = [];
    exposed.jetAudit = audit;
    let sentFuel = 0;
    for (let t = 0; t < 60; t++) {
      engine.step(1, walls, []);
      // The engine clears the audit at the start of the next step.
      for (const book of audit) {
        if (!book.members.includes('a') || book.members.includes('hall')) continue;
        for (const row of book.hot) sentFuel += row.kg * (row.fuelY ?? 0);
      }
    }
    let hall: { upperK: number; fuelKg?: number } | undefined;
    for (const live of exposed.layerState.values()) {
      if (live.active && live.members.includes('hall') && !live.members.includes('a')) {
        hall = live.zone;
      }
    }
    return { hall, sentFuel };
  };
  const connected = run(true);
  const alone = run(false);
  assert.ok(connected.hall, 'the hall never formed a layer of its own');
  assert.ok(alone.hall, 'the hall alone never formed a layer');
  assert.ok(
    connected.sentFuel > 0.05,
    `the source sent ${connected.sentFuel.toFixed(3)} kg; hall kept ${(connected.hall?.fuelKg ?? 0).toFixed(3)}; alone ${(alone.hall?.fuelKg ?? 0).toFixed(3)}`,
  );
  const kept = connected.hall.fuelKg ?? 0;
  const own = alone.hall.fuelKg ?? 0;
  assert.ok(kept > own + 0.05, `hall kept ${kept.toFixed(3)} kg; alone kept ${own.toFixed(3)} kg`);
});

test('a jet-fed room keeps its head-height soot when it catches fire', () => {
  const wood = defaultLightFuel();
  const stud = (id: string, x: number, y: number) => ({
    id,
    simPos: { x, y },
    spatialContext: 'inside_building' as const,
    level: 'G',
  });
  const barrier = (
    id: string,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    door: boolean,
  ): InteriorWall => ({
    id,
    start: { x: x1, y: y1 },
    end: { x: x2, y: y2 },
    hasDoor: door,
    doorWidth: 0.9,
    doorPosition: 0.5,
    description: '',
    material: 'concrete',
    photos: [],
    level: 'G',
  });
  const engine = new SpatialEffectsEngine(undefined, 1);
  engine.init([stud('fire', 0, 0), stud('hall', 0, 3)]);
  // The same hall at 2.6 m already has its interface at head height when the
  // jet layer forms, so the column shows the layer. Six metres keeps the
  // interface above 1.7 m, which is the soot this test is watching.
  engine.setStoreyHeights({ G: 6 });
  engine.setFuelCells(new Map([['fire', wood]]));
  const walls = [
    barrier('fs', -1.5, -1.5, 1.5, -1.5, false),
    barrier('fw', -1.5, -1.5, -1.5, 1.5, false),
    barrier('fe', 1.5, -1.5, 1.5, 1.5, false),
    barrier('door', -1.5, 1.5, 1.5, 1.5, true),
    barrier('hw', -1.5, 1.5, -1.5, 4.5, false),
    barrier('he', 1.5, 1.5, 1.5, 4.5, false),
    barrier('hn', -1.5, 4.5, 1.5, 4.5, false),
  ];
  const exposed = engine as unknown as {
    fireSim: { ignite: (ids: string[]) => void };
    sootK: Map<string, number>;
    layerState: Map<string, { active: boolean; members: string[]; zone: { interfaceM: number } }>;
  };
  exposed.fireSim.ignite(['fire']);
  exposed.sootK.set('hall', 2);
  const hallSoot = () => exposed.sootK.get('hall') ?? 0;
  let ready = false;
  let best = 'none';
  for (let t = 0; t < 400 && !ready; t++) {
    engine.step(1, walls, []);
    const hall = [...exposed.layerState.values()].find((row) => row.members.includes('hall'));
    if (t === 30 || t === 120 || hall?.active) {
      best = `t=${t + 1} z=${hall?.zone.interfaceM.toFixed(2) ?? 'na'} active=${hall?.active === true} soot=${hallSoot().toFixed(3)}`;
    }
    ready = hall?.active === true && hall.zone.interfaceM > HEAD_HEIGHT_M && hallSoot() > 0.2;
  }
  assert.ok(ready, `the hall never held a jet layer above head height with column soot (${best})`);
  const kept = hallSoot();
  engine.setFuelCells(
    new Map([
      ['fire', wood],
      ['hall', { ...wood, alphaKwS2: 5000, spreadMPerMin: 0 }],
    ]),
  );
  exposed.fireSim.ignite(['hall']);
  engine.step(0.2, walls, []);
  const release = engine.fuelReleaseKw('hall') ?? 0;
  assert.ok(
    release >= 1,
    `the hall fire was only ${release.toFixed(2)} kW, so it stayed on the jet path`,
  );
  const hall = [...exposed.layerState.values()].find((row) => row.members.includes('hall'));
  assert.ok(
    hall?.active,
    `the hall layer dropped when the fire started (z=${hall?.zone.interfaceM.toFixed(2) ?? 'na'}, soot=${hallSoot().toFixed(3)}, ${release.toFixed(1)} kW)`,
  );
  assert.equal(hall?.members.includes('fire'), false, 'the fire spread merged the rooms');
  assert.ok(
    (hall?.zone.interfaceM ?? 0) > HEAD_HEIGHT_M,
    `the interface was already at the head (${hall?.zone.interfaceM.toFixed(2)} m), so this step does not test the clear`,
  );
  const still = hallSoot();
  assert.ok(
    still > kept * 0.5,
    `head-height soot fell from ${kept.toFixed(3)} /m to ${still.toFixed(3)} /m when the room caught fire`,
  );
});

test('a smoke-logged fireless room keeps its layer after the jet stops', () => {
  // The hall has no fire of its own. Once the door jet has dropped the
  // interface through head height, sealing the door stops the feed. The
  // layer is judged from the zone it already holds, so the stud stays in
  // that smoke.
  const wood = defaultLightFuel();
  const stud = (id: string, x: number, y: number) => ({
    id,
    simPos: { x, y },
    spatialContext: 'inside_building' as const,
    level: 'G',
  });
  const barrier = (
    id: string,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    door: boolean,
  ): InteriorWall => ({
    id,
    start: { x: x1, y: y1 },
    end: { x: x2, y: y2 },
    hasDoor: door,
    doorWidth: 0.9,
    doorPosition: 0.5,
    description: '',
    material: 'concrete',
    photos: [],
    level: 'G',
  });
  const engine = new SpatialEffectsEngine(undefined, 1);
  engine.init([stud('fire', 0, 0), stud('hall', 0, 3)]);
  engine.setStoreyHeights({ G: 2.6 });
  engine.setFuelCells(new Map([['fire', wood]]));
  const walls = [
    barrier('fs', -1.5, -1.5, 1.5, -1.5, false),
    barrier('fw', -1.5, -1.5, -1.5, 1.5, false),
    barrier('fe', 1.5, -1.5, 1.5, 1.5, false),
    barrier('door', -1.5, 1.5, 1.5, 1.5, true),
    barrier('hw', -1.5, 1.5, -1.5, 4.5, false),
    barrier('he', 1.5, 1.5, 1.5, 4.5, false),
    barrier('hn', -1.5, 4.5, 1.5, 4.5, false),
  ];
  const exposed = engine as unknown as {
    fireSim: { ignite: (ids: string[]) => void; fuelReleaseKw: (id: string) => number | undefined };
    doorJets: Map<string, { kgS: number }>;
    jetTaken: Map<string, { kgS: number }>;
    layerState: Map<
      string,
      {
        active: boolean;
        members: string[];
        zone: { interfaceM: number; upperK: number; sootG: number };
      }
    >;
  };
  exposed.fireSim.ignite(['fire']);
  const hallOf = () => [...exposed.layerState.values()].find((row) => row.members.includes('hall'));
  const smokeOf = () => engine.studStates.get('hall')?.smoke ?? 0;
  let logged = false;
  let best = 'none';
  for (let t = 0; t < 400 && !logged; t++) {
    engine.step(1, walls, []);
    const hall = hallOf();
    const smoke = smokeOf();
    if (t === 30 || t === 120 || hall?.active) {
      best = `t=${t + 1} z=${hall?.zone.interfaceM.toFixed(2) ?? 'na'} active=${hall?.active === true} smoke=${smoke.toFixed(3)} soot=${(hall?.zone.sootG ?? 0).toFixed(1)} g`;
    }
    logged =
      hall?.active === true &&
      hall.zone.interfaceM <= HEAD_HEIGHT_M &&
      smoke >= 0.5 &&
      hall.zone.sootG > 0 &&
      (exposed.fireSim.fuelReleaseKw('hall') ?? 0) < MIN_LAYER_FIRE_KW;
  }
  assert.ok(logged, `the hall never logged smoke at head height (${best})`);
  const before = hallOf();
  const smokeBefore = smokeOf();
  assert.ok(before);
  const sealed = walls.map((wall) => (wall.id === 'door' ? { ...wall, hasDoor: false } : wall));
  exposed.doorJets = new Map();
  for (let t = 0; t < 10; t++) {
    engine.step(1, sealed, []);
    assert.equal(
      exposed.jetTaken.size,
      0,
      `a jet still arrived on step ${t + 1} after the door was sealed`,
    );
    const hall = hallOf();
    assert.ok(
      hall?.active,
      `the hall layer retired ${t + 1} s after the feed stopped (z=${hall?.zone.interfaceM.toFixed(2) ?? 'na'}, rise=${((hall?.zone.upperK ?? AMBIENT_K) - AMBIENT_K).toFixed(0)} K)`,
    );
    assert.ok(
      hall.zone.interfaceM <= HEAD_HEIGHT_M,
      `the interface lifted through head height (${hall.zone.interfaceM.toFixed(2)} m) while the feed was off`,
    );
    const smoke = smokeOf();
    assert.ok(
      smoke >= smokeBefore * 0.5,
      `head-height smoke fell from ${smokeBefore.toFixed(3)} to ${smoke.toFixed(3)} with the layer still at ${hall.zone.interfaceM.toFixed(2)} m`,
    );
  }
  const after = hallOf();
  assert.ok(after);
  assert.ok(
    after.zone.sootG > before.zone.sootG * 0.5,
    `the layer soot fell from ${before.zone.sootG.toFixed(1)} g to ${after.zone.sootG.toFixed(1)} g`,
  );
});

test('a burning stud under a jet layer adds no soot to the column', () => {
  const wood = defaultLightFuel();
  // Under 1 kW, so the room stays on the jet branch. The yield is large on
  // purpose: one second of that release would move the column if it were
  // painted there as well as put into the layer.
  const hallFuel = { ...wood, alphaKwS2: 0.8, spreadMPerMin: 0, sootYieldGPerG: 4 };
  const ceilingM = 6;
  const stud = (id: string, x: number, y: number) => ({
    id,
    simPos: { x, y },
    spatialContext: 'inside_building' as const,
    level: 'G',
  });
  const barrier = (
    id: string,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    door: boolean,
  ): InteriorWall => ({
    id,
    start: { x: x1, y: y1 },
    end: { x: x2, y: y2 },
    hasDoor: door,
    doorWidth: 0.9,
    doorPosition: 0.5,
    description: '',
    material: 'concrete',
    photos: [],
    level: 'G',
  });
  const engine = new SpatialEffectsEngine(undefined, 1);
  engine.init([stud('fire', 0, 0), stud('hall', 0, 3)]);
  engine.setStoreyHeights({ G: ceilingM });
  engine.setFuelCells(new Map([['fire', wood]]));
  const walls = [
    barrier('fs', -1.5, -1.5, 1.5, -1.5, false),
    barrier('fw', -1.5, -1.5, -1.5, 1.5, false),
    barrier('fe', 1.5, -1.5, 1.5, 1.5, false),
    barrier('door', -1.5, 1.5, 1.5, 1.5, true),
    barrier('hw', -1.5, 1.5, -1.5, 4.5, false),
    barrier('he', 1.5, 1.5, 1.5, 4.5, false),
    barrier('hn', -1.5, 4.5, 1.5, 4.5, false),
  ];
  const exposed = engine as unknown as {
    fireSim: { ignite: (ids: string[]) => void };
    sootK: Map<string, number>;
    layerState: Map<
      string,
      { active: boolean; members: string[]; zone: { interfaceM: number; sootG: number } }
    >;
  };
  exposed.fireSim.ignite(['fire']);
  exposed.sootK.set('hall', 2);
  const hallLayer = () =>
    [...exposed.layerState.values()].find((row) => row.members.includes('hall'));
  let ready = false;
  for (let t = 0; t < 400 && !ready; t++) {
    engine.step(1, walls, []);
    const hall = hallLayer();
    ready =
      hall?.active === true &&
      hall.zone.interfaceM > HEAD_HEIGHT_M &&
      (exposed.sootK.get('hall') ?? 0) > 0.2;
  }
  const before = hallLayer();
  assert.ok(before, 'the hall never held a jet layer above head height');
  assert.ok(before.active, 'the hall layer was not active above head height');
  const kept = exposed.sootK.get('hall') ?? 0;
  const layerBefore = before.zone.sootG;
  engine.setFuelCells(
    new Map([
      ['fire', wood],
      ['hall', hallFuel],
    ]),
  );
  exposed.fireSim.ignite(['hall']);
  const dt = 1;
  engine.step(dt, walls, []);
  const release = engine.fuelReleaseKw('hall') ?? 0;
  assert.ok(release > 0, 'the hall stud did not burn');
  assert.ok(
    release < MIN_LAYER_FIRE_KW,
    `the hall fire was ${release.toFixed(2)} kW, so it left the jet path`,
  );
  const hall = hallLayer();
  assert.ok(hall, 'the hall layer dropped when the stud burned');
  assert.ok(hall.active, 'the hall layer dropped when the stud burned');
  assert.equal(hall.members.includes('fire'), false, 'the fire spread merged the rooms');
  assert.ok(
    hall.zone.interfaceM > HEAD_HEIGHT_M,
    `the interface was at ${hall.zone.interfaceM.toFixed(2)} m, so the column shows the layer`,
  );
  const producedG = sootProductionGPerS(hallFuel, release) * dt;
  const columnFromRelease = (producedG * SOOT_EXTINCTION_M2_PER_G) / (STUD_AREA_M2 * ceilingM);
  assert.ok(
    columnFromRelease > 0.02,
    `the stud made only ${columnFromRelease.toFixed(4)} /m, so a column copy would not show`,
  );
  const leaked = advanceSootK(kept, 0, SMOKE_LEAK_PER_S, dt);
  const still = exposed.sootK.get('hall') ?? 0;
  assert.ok(
    Math.abs(still - leaked) < columnFromRelease * 0.25,
    `column soot went from ${kept.toFixed(3)} /m to ${still.toFixed(3)} /m; leak-only is ${leaked.toFixed(3)} /m and the release would add ${columnFromRelease.toFixed(3)} /m`,
  );
  const gained = hall.zone.sootG - layerBefore;
  assert.ok(
    gained >= producedG * 0.8,
    `the layer gained ${gained.toFixed(3)} g while the stud made ${producedG.toFixed(3)} g`,
  );
});

test('a wall splits at the interface and an untagged face stays with the upper gas', () => {
  const wall = { areaM2: 12, lining: LINING.concrete, place: 'wall' as const };
  const split = layerContactM2(wall, 1, 4);
  assert.ok(Math.abs(split.upperM2 - 9) < 1e-9);
  assert.ok(Math.abs(split.lowerM2 - 3) < 1e-9);
  const floor = layerContactM2({ areaM2: 8, lining: LINING.concrete, place: 'floor' }, 1, 4);
  assert.equal(floor.upperM2, 0);
  assert.equal(floor.lowerM2, 8);
  const lumped = layerContactM2({ areaM2: 8, lining: LINING.concrete }, 1, 4);
  assert.equal(lumped.upperM2, 8);
  assert.equal(lumped.lowerM2, 0);
});

test('the floor warms the lower layer and the upper gas is not charged that film', () => {
  // Concrete conducts most of the radiation, so the lower layer only gains
  // the convective return. That is about a kelvin in 90 s, and the lumped
  // room, which has no lower contact, stays at ambient. The upper gas is
  // not charged that convection, so its cumulative loss is smaller.
  const fire = [{ heatKw: 250, diameterM: 0.5 }];
  const vents = [{ widthM: 0.9, sillM: 0, soffitM: 2 }];
  const tagged = {
    areaM2: 16,
    ceilingM: 2.6,
    vents,
    boundaries: [
      { areaM2: 16, lining: LINING.concrete, place: 'floor' as const },
      { areaM2: 16, lining: LINING.concrete, place: 'ceiling' as const },
      { areaM2: 48, lining: LINING.concrete, place: 'wall' as const },
    ],
    fires: fire,
  };
  const lumped = {
    areaM2: 16,
    ceilingM: 2.6,
    vents,
    boundaries: [
      { areaM2: 16, lining: LINING.concrete },
      { areaM2: 16, lining: LINING.concrete },
      { areaM2: 48, lining: LINING.concrete },
    ],
    fires: fire,
  };
  let zoned = freshLayer(2.6);
  let whole = freshLayer(2.6);
  let zonedUpper = 0;
  let wholeUpper = 0;
  for (let s = 0; s < 90; s++) {
    const zonedStep = stepZone(zoned, tagged, 1);
    const wholeStep = stepZone(whole, lumped, 1);
    zoned = zonedStep.state;
    whole = wholeStep.state;
    zonedUpper += zonedStep.upperLossKw;
    wholeUpper += wholeStep.upperLossKw;
  }
  assert.ok((zoned.lowerK ?? AMBIENT_K) > AMBIENT_K + 0.5, `lower layer ${zoned.lowerK}`);
  assert.ok((whole.lowerK ?? AMBIENT_K) < AMBIENT_K + 0.5);
  assert.ok(zonedUpper < wholeUpper, `upper loss ${zonedUpper} against ${wholeUpper}`);
});

test('a warmer lower layer changes the mass the door carries', () => {
  const spec = {
    areaM2: 20,
    ceilingM: 3,
    vents: [{ widthM: 1, sillM: 0, soffitM: 2 }],
    boundaries: [{ areaM2: 80, lining: LINING.concrete }],
    fires: [],
  };
  const base = { ...freshLayer(3), interfaceM: 1.2, upperK: 500 };
  const cool = stepZone(base, spec, 1);
  const warm = stepZone({ ...base, lowerK: 400 }, spec, 1);
  assert.ok(
    Math.abs(cool.outKgS - warm.outKgS) > 0.05,
    `outflow ${cool.outKgS.toFixed(3)} against ${warm.outKgS.toFixed(3)}`,
  );
});

test('a floor-clamped door between two rooms does not reverse every step', () => {
  // A large fire room on the floor, coupled to a jet-fed neighbour that
  // has its own exit. Studs sit on a 3 m pitch, so the shared wall is a
  // real door: a face is only a vent between 2 m and 3.4 m. Each room
  // solves that door against the other's published floor gauge. Without
  // the two-root mean, that gauge changes sign every step and the shared
  // door's hot outflow turns on and off with it. The published gauge and
  // the hot mass are the fields the step already kept before the mean.
  const wood = { ...defaultLightFuel(), alphaKwS2: 20, fuelLoadKgM2: 2000, spreadMPerMin: 0 };
  const stud = (id: string, x: number, y: number, inside = true) => ({
    id,
    simPos: { x, y },
    spatialContext: inside ? ('inside_building' as const) : ('open_air' as const),
    level: 'G',
  });
  const barrier = (
    id: string,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    door: boolean,
    width: number,
  ): InteriorWall => ({
    id,
    start: { x: x1, y: y1 },
    end: { x: x2, y: y2 },
    hasDoor: door,
    doorWidth: width,
    doorPosition: 0.5,
    description: '',
    material: 'concrete',
    photos: [],
    level: 'G',
  });
  const lattice = (prefix: string, nx: number, ny: number, x0: number, y0: number) => {
    const people = [];
    const ids: string[] = [];
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const id = `${prefix}${i}_${j}`;
        ids.push(id);
        people.push(stud(id, x0 + i * 3, y0 + j * 3));
      }
    }
    return { people, ids };
  };
  const fireNx = 6;
  const fireNy = 8;
  const hallNx = 6;
  const hallNy = 6;
  const fire = lattice('f', fireNx, fireNy, 0, 0);
  const hallY = fireNy * 3;
  const hall = lattice('h', hallNx, hallNy, 0, hallY);
  const xEast = (fireNx - 1) * 3 + 1.5;
  const ySplit = (fireNy - 1) * 3 + 1.5;
  const yNorth = hallY + (hallNy - 1) * 3 + 1.5;
  const walls = [
    barrier('fs', -1.5, -1.5, xEast, -1.5, true, 0.6),
    barrier('fw', -1.5, -1.5, -1.5, ySplit, false, 0.2),
    barrier('fe', xEast, -1.5, xEast, ySplit, false, 0.2),
    barrier('door', -1.5, ySplit, xEast, ySplit, true, 1.2),
    barrier('hw', -1.5, ySplit, -1.5, yNorth, false, 0.2),
    barrier('he', xEast, ySplit, xEast, yNorth, false, 0.2),
    barrier('hn', -1.5, yNorth, xEast, yNorth, true, 0.6),
  ];
  const engine = new SpatialEffectsEngine(undefined, 1);
  engine.init([
    ...fire.people,
    ...hall.people,
    stud('outF', (fireNx - 1) * 1.5, -3, false),
    stud('outH', (fireNx - 1) * 1.5, yNorth + 1.5, false),
  ]);
  engine.setStoreyHeights({ G: 4 });
  engine.setFuelCells(new Map(fire.ids.map((id) => [id, wood])));
  const exposed = engine as unknown as {
    fireSim: { ignite: (ids: string[]) => void };
    floorPressurePa: Map<string, number>;
    jetAudit: DoorJetBook[] | null;
    layerState: Map<string, { active: boolean; members: string[]; zone: { interfaceM: number } }>;
  };
  exposed.fireSim.ignite(fire.ids.slice(0, 14));
  const audit: DoorJetBook[] = [];
  exposed.jetAudit = audit;
  for (let i = 0; i < 90; i++) engine.step(1, walls, []);
  let prevP: number | null = null;
  let prevHot: boolean | null = null;
  let gaugeFlips = 0;
  let flowFlips = 0;
  let onFloor = 0;
  let hallActive = 0;
  let sawDoor = 0;
  const signChange = (prev: number, next: number) =>
    prev * next < 0 && Math.abs(prev) > 0.25 && Math.abs(next) > 0.25;
  for (let i = 0; i < 150; i++) {
    engine.step(1 / 60, walls, []);
    let zone: { id: string; z: number } | undefined;
    let hallOn = false;
    for (const [id, live] of exposed.layerState) {
      const inFire = live.members.includes('f0_0');
      const inHall = live.members.includes('h0_0');
      if (inFire && !inHall && live.active) zone = { id, z: live.zone.interfaceM };
      if (inHall && !inFire && live.active) hallOn = true;
    }
    if (!zone || zone.z > 0.051) {
      prevP = null;
      prevHot = null;
      continue;
    }
    onFloor++;
    if (hallOn) hallActive++;
    const p = exposed.floorPressurePa.get(zone.id) ?? 0;
    let hotKg = 0;
    for (const book of audit) {
      if (!book.members.includes('f0_0')) continue;
      for (let vent = 0; vent < book.hot.length; vent++) {
        const receivers = book.receivers[vent] ?? [];
        if (!receivers.some((id) => id.startsWith('h'))) continue;
        sawDoor++;
        hotKg += book.hot[vent]?.kg ?? 0;
      }
    }
    const hotOn = hotKg > 1e-4;
    if (onFloor > 30 && prevP != null && prevHot != null) {
      if (signChange(prevP, p)) gaugeFlips++;
      if (prevHot !== hotOn) flowFlips++;
    }
    prevP = p;
    prevHot = hotOn;
  }
  assert.ok(onFloor > 100, `the fire room was on the floor for ${onFloor} steps`);
  assert.ok(hallActive > 100, `the neighbour layer was up for ${hallActive} steps`);
  assert.ok(sawDoor > 100, `the shared door was missing on ${onFloor - sawDoor} steps`);
  assert.equal(gaugeFlips, 0, `floor gauge reversed on ${gaugeFlips} steps`);
  assert.equal(flowFlips, 0, `door hot outflow turned over on ${flowFlips} steps`);
});

test('an oxygen-limited fire room keeps its layer and burns again', () => {
  // Harbour's kitchen at T+270. The inflow is the shop's spent gas, at the
  // 0.15 extinction limit, so the steady correlation predicts no layer.
  // The live layer is floor-deep and hot. Retiring it dumps the soot into
  // the columns and the room never steps again. The layer stays, the burn
  // falls to nothing, and fresher air brings the flame back.
  const fuel = { ...defaultLightFuel(), alphaKwS2: 0.2, fuelLoadKgM2: 40 };
  const stud = (id: string, x: number, y: number) => ({
    id,
    simPos: { x, y },
    spatialContext: 'inside_building' as const,
    level: 'G',
  });
  const barrier = (
    id: string,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    door: boolean,
  ): InteriorWall => ({
    id,
    start: { x: x1, y: y1 },
    end: { x: x2, y: y2 },
    hasDoor: door,
    doorWidth: 2,
    doorPosition: 0.5,
    description: '',
    material: 'concrete',
    photos: [],
    level: 'G',
  });
  const walls = [
    barrier('fs', -1.5, -1.5, 1.5, -1.5, false),
    barrier('fw', -1.5, -1.5, -1.5, 1.5, false),
    barrier('fe', 1.5, -1.5, 1.5, 1.5, false),
    barrier('door', -1.5, 1.5, 1.5, 1.5, true),
    barrier('hw', -1.5, 1.5, -1.5, 4.5, false),
    barrier('he', 1.5, 1.5, 1.5, 4.5, false),
    barrier('hn', -1.5, 4.5, 1.5, 4.5, false),
  ];
  const engine = new SpatialEffectsEngine(undefined, 1);
  engine.init([stud('fire', 0, 0), stud('shop', 0, 3)]);
  engine.setStoreyHeights({ G: 2.6 });
  engine.setFuelCells(new Map([['fire', fuel]]));
  const exposed = engine as unknown as {
    fireSim: { ignite: (ids: string[]) => void; burnFraction: (id: string) => number };
    layerState: Map<
      string,
      {
        active: boolean;
        members: string[];
        zone: {
          interfaceM: number;
          upperK: number;
          sootG: number;
          upperO2?: number;
          lowerO2?: number;
        };
      }
    >;
  };
  exposed.fireSim.ignite(['fire']);
  const of = (id: string) =>
    [...exposed.layerState.values()].find((row) => row.members.includes(id));
  for (let t = 0; t < 80; t++) engine.step(1, walls, []);
  const fire = of('fire');
  const shop = of('shop');
  assert.ok(fire?.active && shop?.active, 'the two rooms never formed layers');
  fire.zone.interfaceM = 0.05;
  fire.zone.upperK = AMBIENT_K + 124;
  fire.zone.sootG = 300;
  fire.zone.upperO2 = 0.152;
  fire.zone.lowerO2 = 0.152;
  shop.active = true;
  shop.zone.interfaceM = 0.1;
  shop.zone.upperK = AMBIENT_K + 50;
  shop.zone.upperO2 = 0.152;
  shop.zone.lowerO2 = 0.23;
  shop.zone.sootG = 20;
  engine.step(1, walls, []);
  const starved = of('fire');
  assert.ok(starved?.active, 'the oxygen-limited layer was retired');
  assert.ok(
    starved.zone.sootG > 200,
    `the layer soot was dumped (${starved.zone.sootG.toFixed(1)} g)`,
  );
  assert.ok(starved.zone.interfaceM <= 0.1, `interface ${starved.zone.interfaceM.toFixed(2)} m`);
  assert.ok(
    starved.zone.upperK - AMBIENT_K > 90,
    `rise ${(starved.zone.upperK - AMBIENT_K).toFixed(0)} K`,
  );
  assert.ok(
    exposed.fireSim.burnFraction('fire') < 0.05,
    `burn fraction ${exposed.fireSim.burnFraction('fire').toFixed(3)} at the extinction limit`,
  );
  for (let t = 0; t < 3; t++) {
    const liveFire = of('fire');
    const liveShop = of('shop');
    assert.ok(liveFire && liveShop);
    liveFire.zone.upperO2 = 0.23;
    liveFire.zone.lowerO2 = 0.23;
    liveShop.zone.upperO2 = 0.23;
    liveShop.zone.lowerO2 = 0.23;
    liveShop.zone.interfaceM = 0.1;
    engine.step(1, walls, []);
  }
  const recovered = of('fire');
  assert.ok(recovered?.active, 'the layer did not survive the fresh air');
  assert.ok(
    exposed.fireSim.burnFraction('fire') > 0.3,
    `burn fraction ${exposed.fireSim.burnFraction('fire').toFixed(3)} after fresh air`,
  );
  assert.ok(recovered.zone.sootG > 100, `soot ${recovered.zone.sootG.toFixed(1)} g`);
});
