import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extinctionK } from '../src/lib/evacuation/hazardSensing.ts';
import type { ExitDef, Vec2 } from '../src/lib/evacuation/types.ts';
import { HOOD_HEIGHT_M, STUD_AREA_M2 } from '../src/lib/rts/flameFront.ts';
import { GLASS_FALLOUT_AREA_FRACTION } from '../src/lib/rts/liningFire.ts';
import { defaultLightFuel } from '../src/lib/rts/materialLibrary.ts';
import { SOOT_EXTINCTION_M2_PER_G, sootProductionGPerS } from '../src/lib/rts/toxicDose.ts';
import {
  DOOR_JET_MIN_KGS,
  SMOKE_LEAK_PER_S,
  SpatialEffectsEngine,
  advanceSootK,
  assignDoorJet,
  queueDoorJets,
  type DoorJetBook,
  type DoorJetParcel,
} from '../src/lib/rts/spatialEffects.ts';
import type { InteriorWall } from '../src/lib/rts/types.ts';
import {
  AMBIENT_K,
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
  fanVolumeM3PerS,
  heskestadEntrainmentKgS,
  DELTA_H_O2_KJ_PER_KG,
  KAWAGOE_KW,
  O2_AMBIENT_MASS,
  O2_LIMIT_MASS,
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
  stepZone,
  type LayerSpec,
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

test('Heskestad flame height matches the 1 MW worked example', () => {
  // L = 0.235 Q^0.4 − 1.02 D = 2.70 m. Entrainment at the tip is positive.
  const atTip = heskestadEntrainmentKgS(1000, 2.7, 1);
  assert.ok(atTip > 1 && atTip < 8, `entrainment at the flame tip is ${atTip}`);
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
  const window = afterFloor.slice(0, 10);
  const shown = lines.join('\n');
  assert.equal(window.length, 10, shown);
  for (const value of window) {
    assert.ok(
      Math.abs(value - cap) / cap < 0.15,
      `${value.toFixed(0)} kW vs ${cap.toFixed(0)}\n${shown}`,
    );
  }
  // One bad doorway root, or the enthalpy cap fed back into the air, used
  // to drop a single second far below the vent limit.
  for (const value of afterFloor) {
    assert.ok(value > cap * 0.5, `collapse ${value.toFixed(0)} kW\n${shown}`);
  }
  // Upper-layer oxygen at the floor is not a second supply. The flame is
  // the fresh-air fire, so a hot layer at 0.177 still burns near the door.
  const stored = oxygenLimitedBurn(spec, 0.05, AMBIENT_K + 300, O2_AMBIENT_MASS, 0.177, 0.1);
  assert.ok(
    Math.abs(stored.burn.burnedKw - cap) / cap < 0.15,
    `stored oxygen ${stored.burn.burnedKw.toFixed(0)} kW vs ${cap.toFixed(0)}`,
  );
  assert.ok(stored.burn.burnedKw < prescribed * 0.5);
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
  assert.equal(pane?.areaM2, 6 * 4);

  const open = enclosureFromGrid(['a'], studs, neighbors, [glass], 4, undefined, new Set(['pane']));
  assert.equal(open?.spec.vents.length, 1);
  assert.equal(open?.spec.vents[0]?.widthM, 6 * GLASS_FALLOUT_AREA_FRACTION);
  assert.equal(open?.spec.vents[0]?.soffitM, 4);
  assert.equal(open?.spec.vents[0]?.sillM, 0);
  assert.deepEqual(open?.ventReceivers, [['out']]);
  const kept = open?.spec.boundaries.find((boundary) => boundary.lining.name === 'glass');
  assert.ok(kept);
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
