import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { BLAST_DATASET } from '../src/lib/rts/blast/blastDataset';
import {
  BLAST_CONSTANTS,
  BLAST_CONSTANT_SOURCES,
  bandForEffectiveKpa,
  blastPressureAt,
  clampCharge,
  computeBlastRings,
  defaultCharge,
  surfacePsKpa,
  surfacePrKpa,
  type ChargeSpec,
} from '../src/lib/rts/blast/blastModel';
import { isNearWallBehind, mulberry32 } from '../src/lib/evacuation/hazardSensing';
import { readStoredBlast, writeStoredBlast } from '../src/lib/rts/blast/blastSiteRecord';
import {
  CUBE_ROOT_GLASS,
  SURFACE_LOOKUP_SAMPLES,
  THRESHOLD_RADII_10KG,
  TNT_10KG_CASES,
} from './fixtures/blastWorkedExamples';

function relErr(actual: number, expected: number): number {
  const denom = Math.abs(expected);
  if (denom === 0) return Math.abs(actual);
  return Math.abs(actual - expected) / denom;
}

function close(actual: number, expected: number, rel = 0.01, label = ''): void {
  const err = relErr(actual, expected);
  assert.ok(err <= rel, `${label} ${actual} vs ${expected} (relative ${err})`);
}

function charge(partial: Partial<ChargeSpec> & Pick<ChargeSpec, 'presetKey' | 'amountKg' | 'burst'>): ChargeSpec {
  return { heightM: 0, ...partial };
}

const TNT10 = charge({ presetKey: 'tnt', amountKg: 10, burst: 'surface' });

describe('blast model', () => {
  test('10 kg point values', () => {
    for (const row of TNT_10KG_CASES) {
      const spec = charge({ presetKey: 'tnt', amountKg: 10, burst: row.burst });
      const open = blastPressureAt(spec, row.rangeM, false);
      const wall = blastPressureAt(spec, row.rangeM, true);
      close(open.psKpa, row.psKpa, 0.01, row.caseId + ' Ps');
      close(open.qKpa, row.qKpa, 0.01, row.caseId + ' q');
      close(open.effectiveKpa, row.standingKpa, 0.01, row.caseId + ' Ps+q');
      close(wall.effectiveKpa, row.reflectedKpa, 0.01, row.caseId + ' Pr');
      const w = 10;
      const ws = row.burst === 'free_air' ? w / BLAST_CONSTANTS.FREE_AIR_FROM_SURFACE_FACTOR : w;
      close(open.z, row.rangeM / Math.cbrt(ws), 1e-9, row.caseId + ' z');
      close(row.rangeM / Math.cbrt(w), row.zOracle, 0.001, row.caseId + ' z oracle');
    }
  });

  test('10 kg threshold radii', () => {
    const surface = computeBlastRings(TNT10);
    close(surface.lethalM, THRESHOLD_RADII_10KG.surface.lethalM, 0.01, 'surface lethal');
    close(surface.seriousM, THRESHOLD_RADII_10KG.surface.seriousM, 0.01, 'surface serious');
    close(surface.minorM, THRESHOLD_RADII_10KG.surface.minorM, 0.01, 'surface minor');
    close(surface.glassInjuryM, THRESHOLD_RADII_10KG.surface.glassInjuryM, 0.01, 'surface glass injury');
    close(surface.glassBreakageM, THRESHOLD_RADII_10KG.surface.glassBreakageM, 0.01, 'surface glass breakage');
    const free = computeBlastRings(charge({ presetKey: 'tnt', amountKg: 10, burst: 'free_air' }));
    close(free.lethalM, THRESHOLD_RADII_10KG.free_air.lethalM, 0.01, 'free lethal');
    close(free.seriousM, THRESHOLD_RADII_10KG.free_air.seriousM, 0.01, 'free serious');
    close(free.minorM, THRESHOLD_RADII_10KG.free_air.minorM, 0.01, 'free minor');
    close(free.glassInjuryM, THRESHOLD_RADII_10KG.free_air.glassInjuryM, 0.01, 'free glass injury');
    close(free.glassBreakageM, THRESHOLD_RADII_10KG.free_air.glassBreakageM, 0.01, 'free glass breakage');

    const raised = computeBlastRings(charge({ presetKey: 'tnt', amountKg: 10, burst: 'free_air', heightM: 1.5 }));
    assert.ok(raised.minorM < surface.minorM);
    close(raised.minorM, Math.sqrt(THRESHOLD_RADII_10KG.free_air.minorM ** 2 - 1.5 ** 2), 0.01, 'ground minor');
    const aboveLethal = computeBlastRings(charge({ presetKey: 'tnt', amountKg: 10, burst: 'free_air', heightM: 5 }));
    assert.equal(aboveLethal.lethalM, 0);

    const heavy = computeBlastRings(charge({ presetKey: 'tnt', amountKg: 80, burst: 'surface' }));
    for (const key of ['lethalM', 'seriousM', 'minorM', 'glassInjuryM', 'glassBreakageM'] as const) {
      close(heavy[key] / surface[key], 2, 0.01, key);
    }
  });

  test('cube-root scaling', () => {
    for (const row of CUBE_ROOT_GLASS) {
      const rings = computeBlastRings(charge({ presetKey: 'tnt', amountKg: row.k ** 3 * 10, burst: 'surface' }));
      const ratio = rings.glassInjuryM / row.radius10kgM;
      assert.ok(Math.abs(ratio - row.k) / row.k <= 0.005, `${row.k} ratio ${ratio}`);
      close(ratio, row.ratio, 0.005, `oracle ratio ${row.k}`);
    }
  });

  test('radii grow with mass and with the pressure factor', () => {
    const amounts = [0.5, 1, 5, 10, 50, 100, 500];
    const bursts = ['surface', 'free_air'] as const;
    for (const preset of BLAST_DATASET.presets) {
      for (const burst of bursts) {
        let prev = computeBlastRings(charge({ presetKey: preset.key, amountKg: amounts[0]!, burst }));
        for (const amountKg of amounts.slice(1)) {
          const next = computeBlastRings(charge({ presetKey: preset.key, amountKg, burst }));
          assert.ok(next.lethalM >= prev.lethalM - 1e-9);
          assert.ok(next.seriousM >= prev.seriousM - 1e-9);
          assert.ok(next.minorM >= prev.minorM - 1e-9);
          assert.ok(next.glassInjuryM >= prev.glassInjuryM - 1e-9);
          assert.ok(next.glassBreakageM >= prev.glassBreakageM - 1e-9);
          prev = next;
        }
      }
    }
    const ordered = [...BLAST_DATASET.presets].sort((a, b) => a.tntEqPressure.value - b.tntEqPressure.value);
    for (const burst of bursts) {
      let prev = computeBlastRings(charge({ presetKey: ordered[0]!.key, amountKg: 10, burst }));
      for (const preset of ordered.slice(1)) {
        const next = computeBlastRings(charge({ presetKey: preset.key, amountKg: 10, burst }));
        assert.ok(next.minorM >= prev.minorM - 1e-6, preset.key);
        prev = next;
      }
    }
    const c4 = computeBlastRings(charge({ presetKey: 'c4', amountKg: 10, burst: 'surface' }));
    const anfo = computeBlastRings(charge({ presetKey: 'anfo', amountKg: 10, burst: 'surface' }));
    const rdx = computeBlastRings(charge({ presetKey: 'rdx', amountKg: 10, burst: 'surface' }));
    close(c4.minorM / anfo.minorM, Math.cbrt(1.37 / 0.82), 0.01, 'c4/anfo');
    assert.ok(c4.lethalM > rdx.lethalM);
  });

  test('injury radii stay nested', () => {
    const amounts = [0.5, 1, 5, 10, 50, 100, 500];
    for (const preset of BLAST_DATASET.presets) {
      for (const amountKg of amounts) {
        for (const burst of ['surface', 'free_air'] as const) {
          const rings = computeBlastRings(charge({ presetKey: preset.key, amountKg, burst }));
          assert.ok(rings.lethalM <= rings.seriousM + 1e-9);
          assert.ok(rings.seriousM <= rings.minorM + 1e-9);
        }
      }
    }
  });

  test('standing effective pressure sets the injury radii', () => {
    const rings = computeBlastRings(TNT10);
    close(rings.lethalM, 3.836, 0.01, 'lethal');
    let lo = Math.log(BLAST_CONSTANTS.Z_MIN);
    let hi = Math.log(BLAST_CONSTANTS.Z_MAX);
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (surfacePsKpa(Math.exp(mid)) > 34.5) lo = mid;
      else hi = mid;
    }
    const psOnly = Math.exp((lo + hi) / 2) * Math.cbrt(10);
    assert.ok(rings.minorM > psOnly);
    assert.equal(bandForEffectiveKpa(blastPressureAt(TNT10, 3.8, false).effectiveKpa), 'lethal');
    assert.equal(bandForEffectiveKpa(blastPressureAt(TNT10, 5, false).effectiveKpa), 'serious');
    assert.equal(bandForEffectiveKpa(blastPressureAt(TNT10, 10, false).effectiveKpa), 'minor');
    assert.equal(bandForEffectiveKpa(blastPressureAt(TNT10, 7, false).effectiveKpa), 'minor');
    assert.equal(bandForEffectiveKpa(blastPressureAt(TNT10, 7, true).effectiveKpa), 'serious');
  });

  test('scaled distance stays inside the fit', () => {
    const at = blastPressureAt(charge({ presetKey: 'tnt', amountKg: 500, burst: 'surface' }), 1, false);
    assert.equal(at.z, BLAST_CONSTANTS.Z_MIN);
    assert.ok(at.notes.includes('outside_curve_range'));
    close(at.psKpa, surfacePsKpa(0.2), 1e-12, 'Ps at z min');
    close(at.psKpa, 17310, 0.01, 'lookup row');
    assert.ok(Number.isFinite(at.psKpa));
    for (const range of [0, 0.01, 1, 10, 100, 1000]) {
      const row = blastPressureAt(TNT10, range, false);
      for (const n of [row.z, row.psKpa, row.qKpa, row.prKpa, row.effectiveKpa]) {
        assert.ok(Number.isFinite(n) && n >= 0);
      }
    }
  });

  test('segment joins and lookup rows', () => {
    close(surfacePsKpa(2.9 - 1e-4), surfacePsKpa(2.9), 0.01, 'join 2.9');
    close(surfacePsKpa(23.8 - 1e-4), surfacePsKpa(23.8), 0.01, 'join 23.8');
    for (const row of SURFACE_LOOKUP_SAMPLES) {
      close(surfacePsKpa(row.z), row.incidentKpa, 0.01, `lookup ${row.z}`);
    }
    const ps = surfacePsKpa(50);
    const p0 = BLAST_CONSTANTS.P0_KPA;
    close(surfacePrKpa(50), (8 * ps * ps + 14 * ps * p0) / (ps + 7 * p0), 1e-12, 'reflected past the fit');
  });

  test('free-air ground radius shrinks as height rises', () => {
    const heights = [0, 0.5, 1.5, 3, 5, 10, 20, 40, 90];
    let prev = computeBlastRings(charge({ presetKey: 'tnt', amountKg: 10, burst: 'free_air', heightM: heights[0] }));
    for (const heightM of heights.slice(1)) {
      const next = computeBlastRings(charge({ presetKey: 'tnt', amountKg: 10, burst: 'free_air', heightM }));
      assert.ok(next.lethalM <= prev.lethalM + 1e-9);
      assert.ok(next.seriousM <= prev.seriousM + 1e-9);
      assert.ok(next.minorM <= prev.minorM + 1e-9);
      assert.ok(next.glassInjuryM <= prev.glassInjuryM + 1e-9);
      assert.ok(next.glassBreakageM <= prev.glassBreakageM + 1e-9);
      prev = next;
    }
    const clear = computeBlastRings(charge({ presetKey: 'tnt', amountKg: 10, burst: 'free_air', heightM: 100 }));
    assert.equal(clear.lethalM, 0);
    assert.equal(clear.glassBreakageM, 0);
  });

  test('out of range amounts and a seeded fuzz', () => {
    const high = clampCharge(charge({ presetKey: 'tnt', amountKg: 5000, burst: 'surface', heightM: 1.5 }));
    assert.equal(high.spec.amountKg, 2000);
    assert.ok(high.notes.includes('Clamped to 2,000 kg'));
    const low = clampCharge(charge({ presetKey: 'tnt', amountKg: 0, burst: 'surface', heightM: 1.5 }));
    assert.equal(low.spec.amountKg, 0.1);
    const unknown = clampCharge(charge({ presetKey: 'petn_plastic', amountKg: 10, burst: 'surface', heightM: 1.5 }));
    assert.equal(unknown.spec.presetKey, 'unknown');
    const rng = mulberry32(1337);
    const keys = [...BLAST_DATASET.presets.map((p) => p.key), 'petn_plastic', 'no-such'];
    for (let i = 0; i < 200; i++) {
      const spec = charge({
        presetKey: keys[Math.floor(rng() * keys.length)]!,
        amountKg: rng() * 6000 - 100,
        burst: rng() < 0.5 ? 'surface' : 'free_air',
        heightM: rng() * 80 - 10,
      });
      const rings = computeBlastRings(clampCharge(spec).spec);
      const raw = computeBlastRings(spec);
      for (const pack of [rings, raw]) {
        for (const n of [pack.lethalM, pack.seriousM, pack.minorM, pack.glassInjuryM, pack.glassBreakageM, pack.ignitionM, pack.tntKg]) {
          assert.ok(Number.isFinite(n) && n >= 0);
        }
      }
      const pressure = blastPressureAt(spec, rng() * 500, rng() < 0.5);
      for (const n of [pressure.z, pressure.psKpa, pressure.qKpa, pressure.prKpa, pressure.effectiveKpa]) {
        assert.ok(Number.isFinite(n) && n >= 0);
      }
    }
  });

  test('preset table', () => {
    const byKey = new Map(BLAST_DATASET.presets.map((p) => [p.key, p]));
    assert.equal(byKey.get('rdx')!.tntEqPressure.value, 1.14);
    assert.equal(byKey.get('rdx')!.tntEqImpulse.value, 1.09);
    assert.equal(byKey.get('c4')!.tntEqPressure.value, 1.37);
    assert.equal(byKey.get('c4')!.tntEqImpulse.value, 1.19);
    assert.equal(byKey.get('petn')!.tntEqPressure.status, 'seed_pending');
    for (const key of ['semtex', 'dynamite', 'tatp', 'black_powder']) {
      assert.equal(byKey.get(key)!.tntEqPressure.status, 'assumed');
      assert.equal(byKey.get(key)!.tntEqPressure.confidence, 'low');
      assert.equal(byKey.get(key)!.tntEqImpulse.status, 'assumed');
    }
    assert.equal([...byKey.keys()].some((key) => key.includes('smokeless')), false);
    assert.deepEqual(
      BLAST_DATASET.presets.map((p) => p.key),
      ['unknown', 'tnt', 'anfo', 'rdx', 'c4', 'petn', 'semtex', 'dynamite', 'tatp', 'black_powder'],
    );
    const home = computeBlastRings(defaultCharge());
    assert.equal(home.tntKg, 10);
    close(home.minorM, THRESHOLD_RADII_10KG.surface.minorM, 0.01, 'default minor');
    assert.equal(home.dataStatus, 'mixed');
    assert.equal(home.ignitionM, home.lethalM);
  });

  test('a wall behind the person', () => {
    const person = { x: 10, y: 10 };
    const site = { x: 0, y: 10 };
    const wall = {
      startX: 11,
      startY: 0,
      endX: 11,
      endY: 20,
      hasDoor: false,
      doorWidth: 0,
      doorPosition: 0.5,
    };
    assert.equal(isNearWallBehind(person, site, [wall], []), true);
    assert.equal(isNearWallBehind(person, site, [{ ...wall, startX: 13, endX: 13 }], []), false);
    assert.equal(
      isNearWallBehind(person, site, [{ ...wall, startX: 9, endX: 9 }], []),
      false,
    );
  });

  test('export list', async () => {
    const mod = await import('../src/lib/rts/blast/blastModel.ts');
    // Step 2 names only. A module namespace lists keys in lexicographic order.
    const step2 = [
      'BLAST_CONSTANTS',
      'BLAST_CONSTANT_SOURCES',
      'clampCharge',
      'tntEquivalentKg',
      'surfacePsKpa',
      'surfacePrKpa',
      'dynamicPressureKpa',
      'blastPressureAt',
      'bandForEffectiveKpa',
      'computeBlastRings',
      'defaultCharge',
    ];
    assert.deepEqual(Object.keys(mod), [...step2].sort());
  });

  test('every constant has a source', () => {
    for (const key of Object.keys(BLAST_CONSTANTS)) {
      assert.ok(key in BLAST_CONSTANT_SOURCES, key);
    }
    assert.ok('WALL_ATTENUATION' in BLAST_CONSTANT_SOURCES);
    const assumedKeys = new Set(['NEAR_WALL_M', 'FIRE_IGNITION_FACTOR', 'WALL_ATTENUATION']);
    const lowPresets = new Set(['semtex', 'dynamite', 'tatp', 'black_powder']);
    for (const [key, source] of Object.entries(BLAST_CONSTANT_SOURCES)) {
      if (source.status === 'assumed') assert.ok(assumedKeys.has(key), key);
    }
    for (const preset of BLAST_DATASET.presets) {
      if (preset.tntEqPressure.status === 'assumed') assert.ok(lowPresets.has(preset.key), preset.key);
    }
  });

  test('old blast_site keeps SceneEditor fields and its saved radius', () => {
    const sceneEditor = {
      x: 12,
      y: 34,
      radius: 40,
      weaponType: 'legacy-a',
      gameZones: [{ id: 'zone-a', name: 'Lobby' }],
      locationDescription: 'Main lobby, north entrance',
    };
    const loaded = readStoredBlast(sceneEditor);
    assert.ok(loaded);
    assert.deepEqual(loaded.pos, { x: 12, y: 34 });
    assert.equal(loaded.charge, null);
    assert.equal(loaded.manualRadius, true);
    assert.equal(loaded.radiusM, 40);
    const saved = writeStoredBlast(loaded.record, loaded.pos, defaultCharge(), true, loaded.radiusM ?? 20);
    assert.equal(saved.radius, 40);
    assert.equal(saved.manualRadiusM, 40);
    assert.equal(saved.weaponType, 'legacy-a');
    assert.equal(saved.locationDescription, 'Main lobby, north entrance');
    assert.deepEqual(saved.gameZones, sceneEditor.gameZones);
    assert.equal(saved.x, 12);
    assert.equal(saved.y, 34);

    const calculated = readStoredBlast({
      x: 1,
      y: 2,
      radius: 18,
      weaponType: 'legacy-b',
      gameZones: ['approach'],
      locationDescription: 'Service road',
      charge: { presetKey: 'tnt', amountKg: 10, burst: 'surface', heightM: 1.5 },
      manualRadius: false,
    });
    assert.ok(calculated);
    assert.equal(calculated.manualRadius, false);
    assert.equal(calculated.radiusM, 18);
    const rewritten = writeStoredBlast(
      calculated.record,
      calculated.pos,
      calculated.charge,
      false,
      13.1,
    );
    assert.equal(rewritten.radius, 13.1);
    assert.equal(rewritten.manualRadiusM, 13.1);
    assert.equal(rewritten.manualRadius, false);
    assert.equal(rewritten.weaponType, 'legacy-b');
    assert.deepEqual(rewritten.gameZones, ['approach']);
    assert.equal(rewritten.locationDescription, 'Service road');
  });
});
