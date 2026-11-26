import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AMBIENT_K, formsSustainedLayer, hasSmokeReservoir } from '../src/lib/rts/twoZone.ts';
import {
  BE3_TEST_3,
  TOLERANCE,
  VTT_CASE_2,
  compareLayer,
  expectPass,
  runCase,
} from './fixtures/fireValidation/cases.ts';
import {
  T2_ALPHA,
  babrauskasFlashoverKw,
  correlationClockS,
  flashesWithin,
  mqhRoomFlashoverKw,
  thomasFlashoverKw,
  timeToFlashoverS,
} from './fixtures/fireValidation/flashover.ts';

const slow = {
  skip: !process.env.RUN_SLOW_TESTS && 'slow validation run: nightly, or npm run test:slow',
};

test(
  'the layer flashover heat release of the NUREG room lies in the correlation band',
  slow,
  (t) => {
    // Bisect the steady fire that first reaches 600 °C or 20 kW/m² by 600 s, to 10 kW.
    let lo = 500;
    let hi = 6000;
    while (hi - lo > 10) {
      const mid = 0.5 * (lo + hi);
      if (flashesWithin(mid, 600)) hi = mid;
      else lo = mid;
    }
    t.diagnostic(`Babrauskas ${babrauskasFlashoverKw().toFixed(0)} kW`);
    expectPass(t, {
      case: 'NUREG room',
      metric: 'layer flashover heat release',
      unit: 'kW',
      model: hi,
      target: mqhRoomFlashoverKw(),
      tolerance: { band: [thomasFlashoverKw(), mqhRoomFlashoverKw()] },
    });
  },
);

for (const [name, alpha] of Object.entries(T2_ALPHA)) {
  test(`a ${name} t² fire flashes the NUREG room on the MQH clock`, slow, (t) => {
    const clock = correlationClockS(alpha);
    assert.ok(clock != null);
    const engine = timeToFlashoverS(alpha, Math.ceil(clock * 1.5));
    assert.ok(engine != null, `${name}: no flashover by ${Math.ceil(clock * 1.5)} s`);
    expectPass(t, {
      case: `NUREG room, ${name} t²`,
      metric: 'time to flashover',
      unit: 's',
      model: engine,
      target: clock,
      tolerance: { relative: TOLERANCE.flashoverTimeFraction },
    });
  });
}

test('NIST/NRC BE#3 Test 3 over the whole steady fire', slow, (t) => {
  const c = { ...BE3_TEST_3, window: [300, 1379] as const };
  const result = compareLayer(c, runCase(c, c.window[1]));
  expectPass(t, {
    case: `${c.title}, 300–1379 s`,
    metric: 'interface height',
    unit: 'm',
    model: result.modelInterfaceM,
    target: result.measuredInterfaceM,
    tolerance: { absolute: TOLERANCE.interfaceM(c.spec.ceilingM) },
  });
  expectPass(t, {
    case: `${c.title}, 300–1379 s`,
    metric: 'upper-layer rise',
    unit: 'K',
    model: result.modelRiseK,
    target: result.measuredRiseK,
    tolerance: { relative: TOLERANCE.riseFraction },
  });
});

test('VTT hall Case 2: a layer forms, and the interface and the rise pass', slow, (t) => {
  const c = VTT_CASE_2;
  const states = runCase(c, c.window[1]);
  const result = compareLayer(c, states);
  const end = states[c.window[1]]!;
  const reservoir = hasSmokeReservoir(c.spec.vents, c.spec.ceilingM);
  assert.ok(
    formsSustainedLayer(
      c.spec.ceilingM - end.interfaceM,
      c.spec.ceilingM,
      end.upperK - AMBIENT_K,
      reservoir,
    ),
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
