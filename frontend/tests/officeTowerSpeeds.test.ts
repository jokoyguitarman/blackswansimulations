/**
 * Three-storey office fire played the way the RTS page plays it: a loaded
 * 10x run, with and without the frame budget, gives the same outcome as 1x.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { performance } from 'node:perf_hooks';
import { FX } from '../src/lib/rts/fx/fxConstants.ts';
import { MAX_FRAME_SIM_S } from '../src/lib/rts/fx/simClock.ts';
import { runOfficeFrames, type OfficeFrameResult } from './scenes/officeTowerFrames.ts';
import { slowScene } from './scenes/slow.ts';

function assertMatches(fast: OfficeFrameResult, real: OfficeFrameResult) {
  assert.ok(Math.abs(fast.out - real.out) <= 10, `out ${fast.out} vs ${real.out}`);
  assert.ok(Math.abs(fast.down - real.down) <= 3, `down ${fast.down} vs ${real.down}`);
  assert.ok(
    Math.abs(fast.sheltering - real.sheltering) <= 3,
    `sheltering ${fast.sheltering} vs ${real.sheltering}`,
  );
  assert.ok(
    Math.abs(fast.burning - real.burning) <= 3,
    `burning ${fast.burning} vs ${real.burning}`,
  );
}

test(
  'office fire: a loaded 10x run matches a 1x run',
  { skip: slowScene, timeout: 20 * 60 * 1000 },
  () => {
    const untilS = 210;
    const real = runOfficeFrames(1, 1 / 60, untilS);
    // One second a frame at 10x asks for 10 s; every subsystem gets 4 s.
    const fast = runOfficeFrames(10, 1, untilS);
    // The budget cuts that to the steps that fit in SIM_BUDGET_MS.
    const budgeted = runOfficeFrames(10, 1, untilS, {
      budget: { budgetMs: FX.SIM_BUDGET_MS, now: () => performance.now() },
    });
    for (const r of [real, fast, budgeted]) {
      assert.ok(Math.abs(r.clockS - r.crowdS) < 1e-6, JSON.stringify(r));
      assert.ok(r.crowdS - r.effectsS >= 0 && r.crowdS - r.effectsS < FX.EFFECTS_DT);
    }
    assert.ok(fast.frames <= Math.ceil(untilS / MAX_FRAME_SIM_S) + 1, 'the clock slowed');
    assert.ok(budgeted.frames > fast.frames * 4, 'the budget slowed the clock further');
    assertMatches(fast, real);
    assertMatches(budgeted, real);
  },
);
