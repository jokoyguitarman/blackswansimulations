import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ignitionTimeSec } from '../src/lib/rts/flameFront.ts';
import {
  FLAME_AHEAD_FLUX_KW_M2,
  GLASS_BREAK_STRESS_PA,
  GLASS_EXPANSION_PER_K,
  GLASS_FALLOUT_AREA_FRACTION,
  GLASS_FALLOUT_GAS_C,
  GLASS_MODULUS_PA,
  PLYWOOD_CHAR_MM_PER_MIN,
  UPWARD_FLAME_K_M2_PER_KW,
  advanceTimberFace,
  charRateMPerS,
  charThroughS,
  concurrentSpreadMPerS,
  freshTimberFace,
  glassBreakDeltaK,
  glassFalloutGasK,
  liningBurnAreaM2,
  liningKind,
  linkCrossesWall,
  opposedSpreadMPerS,
  paneNetKwM2,
  stepGlassPane,
  timberHeatReleaseKwM2,
  timberRelease,
  upwardFlameLengthM,
} from '../src/lib/rts/liningFire.ts';
import { entryById, fuelCellFromEntry, layerLiningFor } from '../src/lib/rts/materialLibrary.ts';
import { SpatialEffectsEngine } from '../src/lib/rts/spatialEffects.ts';
import type { InteriorWall } from '../src/lib/rts/types.ts';
import { AMBIENT_K } from '../src/lib/rts/twoZone.ts';

test('glass cracks at Keski-Rahkonen σ / (E β), and a cool pane stays whole', () => {
  const delta = GLASS_BREAK_STRESS_PA / (GLASS_EXPANSION_PER_K * GLASS_MODULUS_PA);
  assert.equal(glassBreakDeltaK(), delta);
  assert.ok(Math.abs(delta - 78.125) < 1e-9);

  const row = layerLiningFor('glass');
  const whole = { cracked: false, fallen: false };
  const still = stepGlassPane(
    {
      paneK: AMBIENT_K,
      gasK: AMBIENT_K,
      flameKwM2: 0,
      dt: 600,
      rhoKgM3: row.densityKgM3,
      cJKgK: row.specificHeatJKgK,
      thicknessM: row.thicknessM,
    },
    whole,
  );
  assert.equal(still.cracked, false);
  assert.equal(still.fallen, false);
  assert.equal(still.paneK, AMBIENT_K);

  const cap = row.densityKgM3 * (row.specificHeatJKgK / 1000) * row.thicknessM;
  const q = paneNetKwM2(AMBIENT_K, AMBIENT_K, 100);
  assert.equal(q, 100);
  const one = stepGlassPane(
    {
      paneK: AMBIENT_K,
      gasK: AMBIENT_K,
      flameKwM2: 100,
      dt: 1,
      rhoKgM3: row.densityKgM3,
      cJKgK: row.specificHeatJKgK,
      thicknessM: row.thicknessM,
    },
    whole,
  );
  assert.ok(Math.abs(one.paneK - (AMBIENT_K + q / cap)) < 1e-9);
  assert.equal(one.cracked, false);
  assert.equal(one.fallen, false);

  let pane = AMBIENT_K;
  let state = { cracked: false, fallen: false };
  for (let i = 0; i < 30 && !state.cracked; i++) {
    const step = stepGlassPane(
      {
        paneK: pane,
        gasK: AMBIENT_K,
        flameKwM2: 100,
        dt: 1,
        rhoKgM3: row.densityKgM3,
        cJKgK: row.specificHeatJKgK,
        thicknessM: row.thicknessM,
      },
      state,
    );
    pane = step.paneK;
    state = { cracked: step.cracked, fallen: step.fallen };
  }
  assert.equal(state.cracked, true);
  assert.equal(state.fallen, false);
  assert.ok(pane - AMBIENT_K >= delta);
  const held = stepGlassPane(
    {
      paneK: pane,
      gasK: AMBIENT_K,
      flameKwM2: 0,
      dt: 10,
      rhoKgM3: row.densityKgM3,
      cJKgK: row.specificHeatJKgK,
      thicknessM: row.thicknessM,
    },
    state,
  );
  assert.equal(held.cracked, true);
  assert.equal(held.fallen, false);
  assert.equal(held.paneK, pane);
  const dropped = stepGlassPane(
    {
      paneK: pane,
      gasK: glassFalloutGasK(),
      flameKwM2: 0,
      dt: 1,
      rhoKgM3: row.densityKgM3,
      cJKgK: row.specificHeatJKgK,
      thicknessM: row.thicknessM,
    },
    { cracked: true, fallen: false },
  );
  assert.equal(dropped.fallen, true);
  assert.equal(dropped.paneK, pane);
});

test('a 6 mm pane under 200–300 °C cracks without falling, and 450 °C falls out', () => {
  assert.equal(GLASS_FALLOUT_GAS_C, 450);
  assert.equal(glassFalloutGasK(), 723.15);
  assert.equal(GLASS_FALLOUT_AREA_FRACTION, 0.2);
  const row = layerLiningFor('glass');
  const expose = (gasC: number, seconds: number) => {
    let pane = AMBIENT_K;
    let state = { cracked: false, fallen: false };
    let crackedAt: number | null = null;
    for (let t = 1; t <= seconds; t++) {
      const step = stepGlassPane(
        {
          paneK: pane,
          gasK: gasC + 273.15,
          flameKwM2: 0,
          dt: 1,
          rhoKgM3: row.densityKgM3,
          cJKgK: row.specificHeatJKgK,
          thicknessM: row.thicknessM,
        },
        state,
      );
      pane = step.paneK;
      if (step.cracked && crackedAt == null) crackedAt = t;
      state = { cracked: step.cracked, fallen: step.fallen };
    }
    return { state, crackedAt };
  };
  const cool = expose(150, 30 * 60);
  assert.equal(cool.state.cracked, false, `150 °C cracked at ${cool.crackedAt}`);
  assert.equal(cool.state.fallen, false);
  const warm = expose(200, 30 * 60);
  assert.equal(warm.state.cracked, true);
  assert.equal(warm.state.fallen, false);
  assert.ok(warm.crackedAt != null && warm.crackedAt > 400 && warm.crackedAt < 550);
  const hotter = expose(300, 30 * 60);
  assert.equal(hotter.state.cracked, true);
  assert.equal(hotter.state.fallen, false);
  assert.ok(hotter.crackedAt != null && hotter.crackedAt > 100 && hotter.crackedAt < 220);
  const fall = expose(450, 30 * 60);
  assert.equal(fall.state.cracked, true);
  assert.equal(fall.state.fallen, true);
  assert.ok(fall.crackedAt != null && fall.crackedAt < 90);
  assert.ok(
    fall.crackedAt != null &&
      hotter.crackedAt != null &&
      warm.crackedAt != null &&
      fall.crackedAt < hotter.crackedAt &&
      hotter.crackedAt < warm.crackedAt,
  );
  const justUnder = stepGlassPane(
    {
      paneK: AMBIENT_K + glassBreakDeltaK(),
      gasK: glassFalloutGasK() - 0.2,
      flameKwM2: 0,
      dt: 1,
      rhoKgM3: row.densityKgM3,
      cJKgK: row.specificHeatJKgK,
      thicknessM: row.thicknessM,
    },
    { cracked: true, fallen: false },
  );
  assert.equal(justUnder.fallen, false);
});

test('a plywood board releases β ρ ΔH and chars through at the panel rate', () => {
  const row = layerLiningFor('timber');
  const wood = entryById('wood');
  assert.equal(PLYWOOD_CHAR_MM_PER_MIN, 1);
  const eq37 = Math.sqrt(450 / 420) * Math.sqrt(20 / 18);
  assert.ok(Math.abs(eq37 - 1.091) < 0.002, `Eq. 3.7 would be ${eq37.toFixed(3)} mm/min`);
  assert.equal(row.densityKgM3, 420);
  assert.notEqual(row.densityKgM3, 540);
  assert.equal(row.thicknessM, 0.018);
  assert.equal(wood?.effectiveHeatOfCombustionMjKg, 12.4);
  assert.equal(wood?.chfKwM2, 10);
  assert.equal(wood?.trp, 134);
  const q = charRateMPerS() * 420 * 12.4 * 1000;
  assert.ok(Math.abs(timberHeatReleaseKwM2() - q) < 1e-9);
  assert.ok(q < 100, 'this board is below the 100 kW/m² runaway');
  assert.ok(Math.abs(charThroughS(0.018) - 1080) < 1e-9);

  const face = timberRelease(2, 0);
  assert.ok(Math.abs(face.heatKw - 2 * q) < 1e-6);
  const massG = charRateMPerS() * 420 * 2 * 1000;
  assert.ok(Math.abs(face.sootGPerS - 0.015 * massG) < 1e-9);
  assert.ok(Math.abs((face.fumes.CO ?? 0) - 0.004 * massG) < 1e-9);
  assert.equal(face.fumes.acrolein, undefined);
});

test('upward spread needs a flame taller than the pyrolysis zone, and this board does not have one', () => {
  const q = timberHeatReleaseKwM2();
  const flame = upwardFlameLengthM(q, 2);
  assert.ok(Math.abs(flame - UPWARD_FLAME_K_M2_PER_KW * q * 2) < 1e-12);
  assert.ok(flame < 2);
  assert.equal(concurrentSpreadMPerS(flame, 2, 10), 0);
  assert.ok(Math.abs(upwardFlameLengthM(200, 1) - 2) < 1e-12);
  assert.ok(Math.abs(concurrentSpreadMPerS(2, 1, 4) - 0.25) < 1e-12);
  assert.equal(FLAME_AHEAD_FLUX_KW_M2, 30);
  // The opposed formula is the published one. It is not applied: no Φ was measured for this board.
  assert.ok(Math.abs(opposedSpreadMPerS(10, 2, 600, 500) - 10 / (2 * 100 * 100)) < 1e-12);
  assert.equal(opposedSpreadMPerS(0, 2, 600, 500), 0);
});

test('the immersed lining ignites on the wood dose, and concrete does not burn', () => {
  assert.equal(liningKind('plywood'), 'timber');
  assert.equal(liningKind('window'), 'glass');
  assert.equal(liningKind('drywall'), 'inert');
  assert.equal(liningKind('concrete'), 'inert');
  assert.equal(liningKind('steel'), 'inert');

  const tig = ignitionTimeSec(20, 10, 134);
  assert.ok(tig != null && Math.abs(tig - 141) < 0.2);
  const cold = advanceTimberFace(freshTimberFace(), {
    flameKwM2: 9,
    gasK: AMBIENT_K,
    hotDepthM: 0,
    ceilingM: 4,
    igniterFlameM: 1.5,
    lengthM: 6,
    doorWidthM: 0,
    doorHeadM: 0,
    dt: 1000,
  });
  assert.equal(cold.face.baseDose, 0);
  assert.equal(cold.areaM2, 0);

  const lit = advanceTimberFace(freshTimberFace(), {
    flameKwM2: 20,
    gasK: AMBIENT_K,
    hotDepthM: 0,
    ceilingM: 4,
    igniterFlameM: 1.5,
    lengthM: 6,
    doorWidthM: 0,
    doorHeadM: 0,
    dt: tig ?? 0,
  });
  assert.ok(lit.face.baseDose >= 1);
  assert.equal(lit.face.fromFloorM, 1.5);
  assert.equal(lit.areaM2, 6 * 1.5);

  const held = advanceTimberFace(lit.face, {
    flameKwM2: 0,
    gasK: AMBIENT_K,
    hotDepthM: 0,
    ceilingM: 4,
    igniterFlameM: 0,
    lengthM: 6,
    doorWidthM: 0,
    doorHeadM: 0,
    dt: 600,
  });
  assert.equal(held.face.fromFloorM, 1.5);

  const deep = advanceTimberFace(freshTimberFace(), {
    flameKwM2: 0,
    gasK: 900,
    hotDepthM: 1.2,
    ceilingM: 4,
    igniterFlameM: 0,
    lengthM: 6,
    doorWidthM: 1.5,
    doorHeadM: 2,
    dt: 60,
  });
  assert.ok(deep.face.layerDose >= 1);
  assert.equal(deep.face.fromCeilingM, 1.2);
  assert.equal(deep.areaM2, 6 * 1.2);
  assert.equal(liningBurnAreaM2(6, 4, 1.5, 2, 4, 0), 6 * 4 - 1.5 * 2);
  assert.equal(linkCrossesWall(0, 0, 3, 0, 1.5, -1, 1.5, 1), true);
  assert.equal(linkCrossesWall(0, 3, 3, 3, 1.5, -1, 1.5, 1), false);
});

test('a timber wall burns and a glass wall opens, and concrete does neither', () => {
  const cell = fuelCellFromEntry(entryById('wood')!);
  assert.ok(cell);
  const stud = (id: string, x: number, y: number) => ({
    id,
    simPos: { x, y },
    spatialContext: 'inside_building' as const,
    level: 'G',
  });
  const wall = (id: string, material: string, y: number): InteriorWall => ({
    id,
    start: { x: -2, y },
    end: { x: 5, y },
    hasDoor: false,
    doorWidth: 0,
    doorPosition: 0.5,
    description: '',
    material,
    photos: [],
    level: 'G',
  });
  const door: InteriorWall = {
    id: 'door',
    start: { x: 4.5, y: -1 },
    end: { x: 4.5, y: 2 },
    hasDoor: true,
    doorWidth: 0.9,
    doorPosition: 0.5,
    description: '',
    material: 'concrete',
    photos: [],
    level: 'G',
  };
  const run = (material: string, id: string) => {
    const engine = new SpatialEffectsEngine(undefined, 1);
    engine.init([stud('a', 0, 0), stud('b', 3, 0), stud('north', 0, 3), stud('east', 6, 0)]);
    engine.setStoreyHeights({ G: 4 });
    engine.setFuelCells(new Map([['a', cell]]));
    const walls = [wall(id, material, 0.4), door];
    (engine as unknown as { fireSim: { ignite: (ids: string[]) => void } }).fireSim.ignite(['a']);
    for (let t = 0; t < 250; t++) engine.step(1, walls, []);
    return engine;
  };

  const timber = run('wood', 'ply');
  const burned = (timber as unknown as { linings: Map<string, { burnedKg: number }> }).linings.get(
    'ply',
  );
  assert.ok(burned && burned.burnedKg > 0, `timber burned ${burned?.burnedKg}`);

  const concrete = run('concrete', 'slab');
  assert.equal(
    (concrete as unknown as { linings: Map<string, unknown> }).linings.has('slab'),
    false,
  );

  const glass = run('glass', 'pane');
  const mem = (
    glass as unknown as { linings: Map<string, { cracked: boolean; fallen: boolean }> }
  ).linings.get('pane');
  assert.ok(mem?.cracked, 'the point source cracks the pane');
  const fallen = (glass as unknown as { fallenGlass: Set<string> }).fallenGlass;
  assert.equal(fallen.has('pane'), mem?.fallen === true);
  const walls = [wall('pane', 'glass', 0.4), door];
  const enc = (
    glass as unknown as {
      enclosureOf: (
        room: string,
        members: string[],
        walls: InteriorWall[],
        ceiling: number,
      ) => { spec: { vents: Array<{ widthM: number; soffitM: number }> } } | null;
    }
  ).enclosureOf('check', ['a', 'b'], walls, 4);
  const opened = enc?.spec.vents.filter((vent) => vent.soffitM > 3.9) ?? [];
  assert.equal(
    opened.some((vent) => Math.abs(vent.widthM - 7) < 0.05),
    false,
    `whole face opened ${JSON.stringify(opened)}`,
  );
  if (mem?.fallen) {
    assert.ok(
      opened.some((vent) => Math.abs(vent.widthM - 7 * GLASS_FALLOUT_AREA_FRACTION) < 0.05),
      `fallout vents ${JSON.stringify(opened)}`,
    );
  } else {
    assert.equal(fallen.has('pane'), false);
  }
});

test('a partition the studs can walk around burns into that room', () => {
  const cell = fuelCellFromEntry(entryById('wood')!);
  assert.ok(cell);
  const stud = (id: string, x: number, y: number) => ({
    id,
    simPos: { x, y },
    spatialContext: 'inside_building' as const,
    level: 'G',
  });
  const partition = (material: string): InteriorWall => ({
    id: 'ply',
    start: { x: 0.4, y: -1 },
    end: { x: 0.4, y: 1.2 },
    hasDoor: false,
    doorWidth: 0,
    doorPosition: 0.5,
    description: '',
    material,
    photos: [],
    level: 'G',
  });
  const door: InteriorWall = {
    id: 'door',
    start: { x: 4.5, y: -1 },
    end: { x: 4.5, y: 2 },
    hasDoor: true,
    doorWidth: 0.9,
    doorPosition: 0.5,
    description: '',
    material: 'concrete',
    photos: [],
    level: 'G',
  };
  const engine = new SpatialEffectsEngine(undefined, 1);
  engine.init([
    stud('a', 0, 0),
    stud('b', 3, 0),
    stud('c', 0, 3),
    stud('d', 3, 3),
    stud('east', 6, 0),
  ]);
  engine.setStoreyHeights({ G: 4 });
  engine.setFuelCells(new Map([['a', cell]]));
  const walls = [partition('wood'), door];
  const rooms = (
    engine as unknown as { fireSim: { compartmentIds: (w: InteriorWall[]) => Map<string, string> } }
  ).fireSim.compartmentIds(walls);
  assert.equal(rooms.get('a'), rooms.get('b'));
  assert.equal(rooms.get('a'), rooms.get('d'));
  const members = [...rooms.entries()]
    .filter(([, room]) => room === rooms.get('a'))
    .map(([id]) => id);
  const before = (
    engine as unknown as {
      enclosureOf: (
        room: string,
        members: string[],
        walls: InteriorWall[],
        ceiling: number,
      ) => { wallIds: string[] } | null;
    }
  ).enclosureOf('check', members, walls, 4);
  assert.equal(before?.wallIds.includes('ply'), false);
  (engine as unknown as { fireSim: { ignite: (ids: string[]) => void } }).fireSim.ignite(['a']);
  for (let t = 0; t < 250; t++) engine.step(1, walls, []);
  const burned = (engine as unknown as { linings: Map<string, { burnedKg: number }> }).linings.get(
    'ply',
  );
  assert.ok(burned && burned.burnedKg > 0, `partition burned ${burned?.burnedKg}`);
});
