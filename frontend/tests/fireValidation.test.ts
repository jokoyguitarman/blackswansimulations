import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MOUTH_APPROACH_M } from '../src/lib/evacuation/hazardSensing.ts';
import {
  CLOSER_LATCH_DEG,
  CLOSER_OPEN_DEG,
  CLOSER_SWEEP_S,
  stepDoorLeaves,
  type DoorLeafWall,
} from '../src/lib/rts/doorLeaf.ts';
import {
  FLASHOVER_ROOM_KW,
  SPRINKLER_RTI,
  SUPPRESSION_TAU_S,
  ceilingJet,
  ignitionTimeSec,
  steadyActivationSec,
  suppressedHeatKw,
} from '../src/lib/rts/flameFront.ts';
import { charThroughS, glassBreakDeltaK } from '../src/lib/rts/liningFire.ts';
import { layerLiningFor } from '../src/lib/rts/materialLibrary.ts';
import {
  O2_AMBIENT_VOLUME_PERCENT,
  co2Hyperventilation,
  oxygenFedPerMin,
} from '../src/lib/rts/toxicDose.ts';
import {
  AMBIENT_K,
  formsSustainedLayer,
  freshLayer,
  hasSmokeReservoir,
  heskestadEntrainmentKgS,
  heskestadFlameHeightM,
  steadyLayer,
  stepZone,
  type LayerSpec,
  type Lining,
} from '../src/lib/rts/twoZone.ts';
import {
  BE3_TEST_3,
  NBS_CORRIDOR,
  NBS_FIRE_ROOM,
  TOLERANCE,
  VTT_CASE_1,
  compareLayer,
  expectKnownGap,
  KNOWN_GAPS_DOC,
  expectPass,
  readLayer,
  runCase,
} from './fixtures/fireValidation/cases.ts';
import {
  babrauskasFlashoverKw,
  correlationClockS,
  flashesWithin,
  mqhRoomFlashoverKw,
  thomasFlashoverKw,
  timeToFlashoverS,
  T2_ALPHA,
} from './fixtures/fireValidation/flashover.ts';
import {
  NBS_PLAN_FIRE_KW,
  runNbsPlan,
  type RoomSample,
} from './fixtures/fireValidation/nbsPlan.ts';

/** Recorded corridor extinction, 1/m, mean over 300–880 s. */
const FV4_CORRIDOR_K = 0.2766;

// ── Flashover correlations, 4 m × 5 m × 2.6 m concrete room, 0.9 × 2.0 m door ──

test('the flashover correlations for the NUREG room', () => {
  // A√H = 1.8 √2 = 2.546. A_T = 85 m² (the room's surfaces less the door).
  assert.ok(Math.abs(babrauskasFlashoverKw() - 1909.2) < 0.5);
  assert.ok(Math.abs(thomasFlashoverKw() - 1625.2) < 0.5);
  assert.ok(Math.abs(mqhRoomFlashoverKw() - 2366) / 2366 < 0.01);
});

test('the layer flashes the NUREG room between Thomas and MQH', (t) => {
  // Flashover is a 600 °C upper layer or 20 kW/m² on the floor, by 600 s.
  const thomas = thomasFlashoverKw();
  const mqh = mqhRoomFlashoverKw();
  const atThomas = flashesWithin(thomas, 600);
  const atMqh = flashesWithin(mqh, 600);
  t.diagnostic(
    `steady ${thomas.toFixed(0)} kW flashes: ${atThomas}; ${mqh.toFixed(0)} kW: ${atMqh}`,
  );
  assert.equal(atThomas, false, `${thomas.toFixed(0)} kW (Thomas) already flashes the room`);
  assert.equal(atMqh, true, `${mqh.toFixed(0)} kW (MQH) does not flash the room`);
});

test('the 1 MW flashover latch is below every correlation (known gap FV-2)', (t) => {
  expectKnownGap(
    t,
    {
      case: 'NUREG room',
      metric: 'flashover latch heat release',
      unit: 'kW',
      model: FLASHOVER_ROOM_KW,
      target: thomasFlashoverKw(),
      tolerance: { band: [thomasFlashoverKw(), mqhRoomFlashoverKw()] },
    },
    {
      id: 'FV-2',
      recorded: 1000,
      pin: 0,
      roadmap: 'realistic-fire roadmap, Decision 8 (the 1 MW latch still ignites the fuel)',
    },
  );
});

test('a fast t² fire flashes the NUREG room on the MQH clock', (t) => {
  const alpha = T2_ALPHA.fast;
  const engine = timeToFlashoverS(alpha, 600);
  const clock = correlationClockS(alpha);
  assert.ok(engine != null && clock != null);
  t.diagnostic(
    `Babrauskas clock ${Math.sqrt(babrauskasFlashoverKw() / alpha).toFixed(0)} s, Thomas ${Math.sqrt(thomasFlashoverKw() / alpha).toFixed(0)} s`,
  );
  expectPass(t, {
    case: 'NUREG room, fast t²',
    metric: 'time to flashover',
    unit: 's',
    model: engine,
    target: clock,
    tolerance: { relative: TOLERANCE.flashoverTimeFraction },
  });
});

// ── Hand checks ──

test('Heskestad flame height, 1 MW on a 1 m pan', () => {
  // 0.235 × 1000^0.4 − 1.02 × 1 = 3.7245 − 1.02.
  assert.ok(Math.abs(heskestadFlameHeightM(1000, 1) - 2.7045) < 0.003);
});

test('Heskestad entrainment above the flame matches the SFPE form', () => {
  // SFPE Handbook (Heskestad): ṁ = 0.071 Qc^⅓ (z − z0)^⁵⁄₃ + 0.00192 Qc above the flame.
  // Q = 1000 kW, D = 1 m, χ = 0.35, z = 5 m. z0 = 0.083 Q^0.4 − 1.02 D = 0.2955 m.
  const qc = 0.65 * 1000;
  const z0 = 0.083 * Math.pow(1000, 0.4) - 1.02;
  const hand = 0.071 * Math.cbrt(qc) * Math.pow(5 - z0, 5 / 3) + 0.00192 * qc;
  assert.ok(Math.abs(hand - 9.37) < 0.01, `hand ${hand}`);
  const engine = heskestadEntrainmentKgS(1000, 5, 1, 0.35);
  assert.ok(Math.abs(engine - hand) / hand < 0.05, `engine ${engine} vs ${hand}`);
});

test('NUREG-1805 Eq. 6-2 ignition time for red oak at 30 kW/m²', () => {
  // π/4 × (134 / (30 − 10))² = 0.7854 × 44.89 = 35.26 s.
  const tig = ignitionTimeSec(30, 10, 134);
  assert.ok(tig != null && Math.abs(tig - 35.26) < 0.01, `t_ig ${tig}`);
  assert.equal(ignitionTimeSec(10, 10, 134), null);
});

test('Alpert ceiling jet and RTI activation, 1 MW under a 3 m ceiling', () => {
  // Plume: 16.9 × 1000^⅔ / 3^⁵⁄₃ = 270.8 K, 0.96 (1000/3)^⅓ = 6.657 m/s.
  const axis = ceilingJet(1000, 3, 0);
  assert.ok(Math.abs(axis.riseK - 270.8) < 0.1, `axis ${axis.riseK}`);
  assert.ok(Math.abs(axis.speedMps - 6.657) < 0.002, `axis ${axis.speedMps}`);
  // r = 4 m: 5.38 (1000/4)^⅔ / 3 = 71.18 K, 0.195 × 1000^⅓ × √3 / 4^⁵⁄₆ = 1.064 m/s.
  const jet = ceilingJet(1000, 3, 4);
  assert.ok(Math.abs(jet.riseK - 71.18) < 0.02, `jet ${jet.riseK}`);
  assert.ok(Math.abs(jet.speedMps - 1.0638) < 0.001, `jet ${jet.speedMps}`);
  // NUREG Eq. 10-2, RTI 50, link at 20 °C opening at 68 °C:
  // 50 / √1.0638 × ln(71.18 / 23.18) = 48.48 × 1.1219 = 54.39 s.
  const act = steadyActivationSec(20, 20 + jet.riseK, jet.speedMps, SPRINKLER_RTI);
  assert.ok(act != null && Math.abs(act - 54.39) < 0.05, `activation ${act}`);
});

test('Evans decay after the spray opens', (t) => {
  // Q(t) = Q_act exp(−t / τ). One τ leaves 1/e of the release.
  assert.ok(Math.abs(suppressedHeatKw(1000, SUPPRESSION_TAU_S) - 1000 / Math.E) < 1e-9);
  assert.ok(Math.abs(suppressedHeatKw(1000, 2 * SUPPRESSION_TAU_S) - 1000 / Math.E ** 2) < 1e-9);
  // NIST IR 5254 crib τ = 3 w^−1.85 s with w in mm/s. At 0.07 mm/s that is
  // 410.8 s. The engine's 435 s is the stated bound, not the crib value.
  const crib = 3 * Math.pow(0.07, -1.85);
  t.diagnostic(`τ ${SUPPRESSION_TAU_S} s against the crib's ${crib.toFixed(1)} s at 0.07 mm/s`);
  assert.ok(Math.abs(crib - 410.8) < 0.1);
});

test("Keski-Rahkonen's crack and the board's char-through", () => {
  // σ_b / (E β) = 50 MPa / (80 GPa × 8e-6 /K) = 78.125 K.
  assert.ok(Math.abs(glassBreakDeltaK() - 78.125) < 1e-9);
  // 18 mm at 1.0 mm/min (EN 1995-1-2 Table 3.1) is 18 min.
  assert.equal(layerLiningFor('timber').thicknessM, 0.018);
  assert.ok(Math.abs(charThroughS(0.018) - 1080) < 1e-6);
});

test('a fire door sweeps from 90° to 12° in 5 s', () => {
  const wall: DoorLeafWall = {
    id: 'door',
    hasDoor: true,
    doorWidth: 0.9,
    doorPosition: 0.5,
    fireRatingMin: 20,
    openFraction: 1,
    startX: 0,
    startY: 0,
    endX: 4,
    endY: 0,
  };
  const slices = Math.round(CLOSER_SWEEP_S / 0.1);
  for (let i = 0; i < slices; i++) stepDoorLeaves([wall], [], new Set(), 0.1, MOUTH_APPROACH_M);
  const angle = (wall.openFraction ?? 0) * CLOSER_OPEN_DEG;
  assert.ok(Math.abs(angle - CLOSER_LATCH_DEG) < 1e-6, `angle at 5 s ${angle}`);
  assert.equal(CLOSER_OPEN_DEG, 90);
  assert.equal(CLOSER_LATCH_DEG, 12);
});

test('ISO 13571 oxygen and carbon-dioxide terms', () => {
  // 1/exp(8.13 − 0.54 (20.9 − 12)) = 0.03601 per min, less the ambient rate.
  const ambient = 1 / Math.exp(8.13 - 0.54 * (20.9 - O2_AMBIENT_VOLUME_PERCENT));
  assert.ok(Math.abs(ambient - 0.000304) < 0.000001, `ambient ${ambient}`);
  assert.ok(
    Math.abs(oxygenFedPerMin(12) - (0.03601 - ambient)) < 0.00001,
    `${oxygenFedPerMin(12)}`,
  );
  assert.equal(oxygenFedPerMin(O2_AMBIENT_VOLUME_PERCENT), 0);
  // exp(%CO2 / 5): 5% CO2 multiplies the CO and HCN terms by e.
  assert.ok(Math.abs(co2Hyperventilation(5) - Math.E) < 1e-12);
  assert.equal(co2Hyperventilation(0), 1);
});

// ── Steckler, NBSIR 82-2520 ──

/** 12.7 mm ceramic fibre board (NIST TN 1889v3); k, ρ, c are the 96 kg/m³ alumina-silica blanket. */
const CERAMIC_FIBRE: Lining = {
  name: 'ceramic fibre board',
  kKwMK: 0.00006,
  rhoKgM3: 96,
  cKjKgK: 1.13,
  thicknessM: 0.0127,
};
const CALCIUM_SILICATE: Lining = {
  name: 'calcium silicate 19 mm',
  kKwMK: 0.00012,
  rhoKgM3: 720,
  cKjKgK: 0.84,
  thicknessM: 0.019,
};

test('Steckler centre burner: interface and rise pass, door flow is known gap FV-1', (t) => {
  // 2.8 × 2.8 × 2.13 m, door 0.74 × 1.83 m, 62.9 kW, χ = 0.2. Johansson and
  // van Hees (IAFSS 2014, Table 3): interface 0.985 m, Tg/Ta 1.335.
  // NBSIR 82-2520: outflow 0.571 kg/s.
  const width = 2.8;
  const height = 2.13;
  const floor = width * width;
  const spec: LayerSpec = {
    areaM2: floor,
    ceilingM: height,
    chi: 0.2,
    vents: [{ widthM: 0.74, sillM: 0, soffitM: 1.83 }],
    boundaries: [
      { areaM2: floor, lining: CALCIUM_SILICATE },
      { areaM2: floor, lining: CERAMIC_FIBRE },
      { areaM2: 4 * width * height - 0.74 * 1.83, lining: CERAMIC_FIBRE },
    ],
    fires: [{ heatKw: 62.9, diameterM: 0.3 }],
  };
  let state = freshLayer(height);
  for (let s = 0; s < 600; s++) state = stepZone(state, spec, 1).state;
  const steady = steadyLayer(spec, 600);
  assert.ok(steady);
  expectPass(t, {
    case: 'Steckler',
    metric: 'interface height',
    unit: 'm',
    model: state.interfaceM,
    target: 0.985,
    tolerance: { absolute: TOLERANCE.interfaceM(height) },
  });
  expectPass(t, {
    case: 'Steckler',
    metric: 'upper-layer rise',
    unit: 'K',
    model: state.upperK - AMBIENT_K,
    target: (1.335 - 1) * AMBIENT_K,
    tolerance: { relative: TOLERANCE.riseFraction },
  });
  expectKnownGap(
    t,
    {
      case: 'Steckler',
      metric: 'door outflow (coupled)',
      unit: 'kg/s',
      model: steady.outKgS,
      target: 0.571,
      tolerance: { relative: TOLERANCE.doorFlowFraction },
    },
    {
      id: 'FV-1',
      recorded: 0.392,
      pin: 0.03,
      roadmap: 'realistic-fire roadmap, Decision 7 (known gap: the Steckler doorway flow)',
    },
  );
});

// ── NBS multi-room MV100A ──

test('NBS MV100A fire room: interface passes, rise is known gap FV-3', (t) => {
  const c = NBS_FIRE_ROOM;
  const result = compareLayer(c, runCase(c, c.window[1]));
  expectPass(t, {
    case: c.title,
    metric: 'interface height',
    unit: 'm',
    model: result.modelInterfaceM,
    target: result.measuredInterfaceM,
    tolerance: { absolute: TOLERANCE.interfaceM(c.spec.ceilingM) },
  });
  expectKnownGap(
    t,
    {
      case: c.title,
      metric: 'upper-layer rise',
      unit: 'K',
      model: result.modelRiseK,
      target: result.measuredRiseK,
      tolerance: { relative: TOLERANCE.riseFraction },
    },
    {
      id: 'FV-3',
      recorded: 183.3,
      pin: 5,
      roadmap: 'realistic-fire roadmap, "What to reproduce": one two-room case',
    },
  );
});

test('NBS MV100A corridor: the door jet forms a layer, rise is known gap FV-4', (t) => {
  // Fire room, entry and corridor on the live engine, joined by their doors.
  // The entry stud is merged into the corridor, so the jet enters one 45 m²
  // room and is not cooled in a separate entry. The rise is short of the
  // measurement because the plan's fire room is about 90 K (the test's is
  // 242 K) and concrete takes 61% of the jet enthalpy. The receiver still
  // solves its doors against ambient; that limit is recorded under FV-4 and
  // is not what this pin checks.
  const c = NBS_CORRIDOR;
  const plan = runNbsPlan(c.window[1]);
  assert.ok(Math.abs(plan.fireKw - NBS_PLAN_FIRE_KW) < 1, `burner ${plan.fireKw} kW`);
  const inWindow = (rows: readonly RoomSample[]) =>
    rows.filter((row) => row.t >= c.window[0] && row.t <= c.window[1]);
  const mean = (rows: readonly RoomSample[], key: 'interfaceM' | 'riseK' | 'meanK') =>
    rows.reduce((sum, row) => sum + row[key], 0) / rows.length;
  const corridor = inWindow(plan.corridor);
  const fireRoom = inWindow(plan.fireRoom);
  assert.ok(corridor.length >= 3);
  assert.ok(
    fireRoom.every((row) => row.active),
    'the fire room lost its layer',
  );
  assert.ok(
    corridor.every((row) => row.active),
    `corridor layer in ${corridor.filter((row) => row.active).length} of ${corridor.length}`,
  );
  t.diagnostic(
    `plan fire room: interface ${mean(fireRoom, 'interfaceM').toFixed(2)} m, rise ${mean(fireRoom, 'riseK').toFixed(1)} K; ` +
      `corridor: interface ${mean(corridor, 'interfaceM').toFixed(2)} m, rise ${mean(corridor, 'riseK').toFixed(1)} K`,
  );

  const rows = readLayer(c.extract).filter((row) => row.t >= c.window[0] && row.t <= c.window[1]);
  const ambientC = readLayer(c.extract)[0]!.lowerC;
  const measuredZ = rows.reduce((sum, row) => sum + row.interfaceM, 0) / rows.length;
  const measuredRise = rows.reduce((sum, row) => sum + row.upperC - ambientC, 0) / rows.length;
  const roadmap = 'realistic-fire roadmap, "What to reproduce": one two-room case';
  expectPass(t, {
    case: c.title,
    metric: 'interface height',
    unit: 'm',
    model: mean(corridor, 'interfaceM'),
    target: measuredZ,
    tolerance: { absolute: TOLERANCE.interfaceM(c.spec.ceilingM) },
  });
  expectKnownGap(
    t,
    {
      case: c.title,
      metric: 'upper-layer rise',
      unit: 'K',
      model: mean(corridor, 'riseK'),
      target: measuredRise,
      tolerance: { relative: TOLERANCE.riseFraction },
    },
    { id: 'FV-4', recorded: 33.4, pin: 1, roadmap },
  );
  // No measurement of extinction. The soot now sits in the corridor layer.
  const corridorK = mean(corridor, 'meanK');
  t.diagnostic(
    `FV-4 corridor mean extinction ${corridorK.toFixed(4)} /m over ${c.window[0]}–${c.window[1]} s`,
  );
  assert.ok(
    Math.abs(corridorK - FV4_CORRIDOR_K) <= 0.02,
    `FV-4 corridor extinction moved from ${FV4_CORRIDOR_K} ± 0.02 to ${corridorK.toFixed(4)} /m. Update ${KNOWN_GAPS_DOC}#fv-4`,
  );
});

// ── NIST/NRC ICFMP BE#3 Test 3 ──

test('NIST/NRC BE#3 Test 3: interface and rise pass', (t) => {
  const c = BE3_TEST_3;
  const result = compareLayer(c, runCase(c, c.window[1]));
  expectPass(t, {
    case: c.title,
    metric: 'interface height',
    unit: 'm',
    model: result.modelInterfaceM,
    target: result.measuredInterfaceM,
    tolerance: { absolute: TOLERANCE.interfaceM(c.spec.ceilingM) },
  });
  expectPass(t, {
    case: c.title,
    metric: 'upper-layer rise',
    unit: 'K',
    model: result.modelRiseK,
    target: result.measuredRiseK,
    tolerance: { relative: TOLERANCE.riseFraction },
  });
});

// ── VTT large hall, ICFMP BE#2 Case 1 ──

test('VTT hall Case 1: a layer forms, and the interface and the rise pass', (t) => {
  const c = VTT_CASE_1;
  const states = runCase(c, c.window[1]);
  const result = compareLayer(c, states);
  const reservoir = hasSmokeReservoir(c.spec.vents, c.spec.ceilingM);
  const end = states[c.window[1]]!;
  const modelLayer = formsSustainedLayer(
    c.spec.ceilingM - end.interfaceM,
    c.spec.ceilingM,
    end.upperK - AMBIENT_K,
    reservoir,
  );
  const measuredLayer = formsSustainedLayer(
    c.spec.ceilingM - result.measuredInterfaceM,
    c.spec.ceilingM,
    result.measuredRiseK,
    reservoir,
  );
  t.diagnostic(`layer forms: model ${modelLayer}, measured ${measuredLayer}`);
  assert.equal(measuredLayer, true);
  assert.equal(
    modelLayer,
    measuredLayer,
    'the engine and the hall disagree on whether a layer forms',
  );
  expectPass(t, {
    case: c.title,
    metric: 'interface height',
    unit: 'm',
    model: result.modelInterfaceM,
    target: result.measuredInterfaceM,
    tolerance: { absolute: TOLERANCE.interfaceM(c.spec.ceilingM) },
  });
  expectPass(t, {
    case: c.title,
    metric: 'upper-layer rise',
    unit: 'K',
    model: result.modelRiseK,
    target: result.measuredRiseK,
    tolerance: { relative: TOLERANCE.riseFraction },
  });
});
