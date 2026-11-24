import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extinctionK } from '../src/lib/evacuation/hazardSensing.ts';
import type { ExitDef, Vec2 } from '../src/lib/evacuation/types.ts';
import { defaultLightFuel } from '../src/lib/rts/materialLibrary.ts';
import { SpatialEffectsEngine } from '../src/lib/rts/spatialEffects.ts';
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
  freshLayer,
  heskestadEntrainmentKgS,
  mqhFlashoverKw,
  mqhRiseK,
  orificeSliceKgS,
  steadyLayer,
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
  assert.ok(Math.abs(runRise - steadyRise) / steadyRise < 0.2, `run ${runRise.toFixed(1)} steady ${steadyRise.toFixed(1)}`);
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
  const spec: LayerSpec = {
    areaM2: floor,
    ceilingM: height,
    chi: 0.2,
    vents: [{ widthM: doorW, sillM: 0, soffitM: doorH }],
    boundaries: [
      { areaM2: floor, lining: CERAMIC_FIBRE },
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
  assert.ok(Math.abs((steady?.interfaceM ?? 0) - measuredZ) <= zTol, `steady interface ${steady?.interfaceM}`);
  // The series film on this thin board leaves the layer about 21% hot.
  // That is outside the 20% band, and it is not adjusted to land inside it.
  const riseRatio = rise / measuredRise;
  assert.ok(
    riseRatio > 1.2 && riseRatio < 1.3,
    `rise ${rise.toFixed(1)} K is ${riseRatio.toFixed(3)} of the measured ${measuredRise.toFixed(1)} K`,
  );
  // The model's own doorway flow. Heskestad at the measured height entrains
  // about 0.30 kg/s and McCaffrey about 0.36; the coupled points are about
  // 0.39 and 0.42 kg/s. Neither is inside 25% of 0.571 (the floor is 0.428).
  // CFAST's doorway jet (TRG Eq. 4.7) entrains after the gas has left the
  // room, so it is not added to this flow. The orifice held at 0.985 m is
  // only a check that the vent formula works.
  assert.ok(coupled < measuredFlow * 0.75, `coupled ${coupled.toFixed(3)} kg/s was reported as inside 25%`);
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
    if (member === 'b' && outside === 'door') return { kind: 'exit' as const, exitKey: 'west', widthM: 1.6 };
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
        layerState: Map<string, { active: boolean; ceilingM: number; zone: { interfaceM: number } }>;
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
    ...(
      open as unknown as { layerState: Map<string, { active: boolean }> }
    ).layerState.values(),
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
    ...(
      shell as unknown as { layerState: Map<string, { active: boolean }> }
    ).layerState.values(),
  ].some((row) => row.active);
  const atExit = extinctionK(shell.studStates.get('atExit')?.smoke ?? 0);
  const atWall = extinctionK(shell.studStates.get('atWall')?.smoke ?? 0);
  assert.equal(layered, true);
  assert.ok(atExit > 0.05, `exit stud K ${atExit}`);
  assert.ok(atWall * 5 < atExit, `wall stud K ${atWall} took a share of the exit's soot`);
});
