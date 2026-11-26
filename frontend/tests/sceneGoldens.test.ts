/**
 * Per-PR determinism check for the scene harness.
 *
 * The food-court table runs to reported T+15. Smoke is already on hundreds of
 * studs there; the rounded summary of that moment is still 3 kW and zeros, so
 * this hashes every stud (fire, soot, smoke, fumes) and every layer. Two runs
 * must match `scenes/goldens/per-pr-hashes.json`. Doubling the wood soot yield
 * or multiplying the smoke leak by ten changes that hash.
 *
 * Harbour's 120 people then walk for 15 s from the showcase seed, and the
 * hash covers their positions and states. The blast is at 60 s. A run through
 * it and 20 s of fire does not fit this budget; the nightly Harbour golden
 * still covers that. On this machine the four runs take about 10 s.
 *
 * The Decision 9 figures are the slow files below. They skip unless
 * `RUN_SLOW_TESTS=1`, which `npm run test:slow` sets.
 *
 * The nightly job runs one file per matrix entry so they stay inside its
 * 60 minute timeout. Measured here, one scene at a time:
 *
 *   sceneGoldens.foodCourtTable.test.ts       14 min
 *   sceneGoldens.foodCourtTableHood.test.ts   15 min
 *   sceneGoldens.foodCourtFryer.test.ts       15 min
 *   sceneGoldens.foodCourtFryerHood.test.ts   14 min
 *   sceneGoldens.harbour.test.ts              24 min (open, blocked, shop)
 *   sceneGoldens.holland.test.ts              27 min
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import hashes from './scenes/goldens/per-pr-hashes.json' with { type: 'json' };
import { foodCourtAt } from './scenes/foodCourt.ts';
import { harbourCrowdAt } from './scenes/harbourCrowd.ts';
import { sceneHash } from './scenes/hash.ts';
import { crowdState, effectsState } from './scenes/stateHash.ts';

test('reading smokeLayers() leaves a stepped Harbour state unchanged', { timeout: 120_000 }, () => {
  const run = harbourCrowdAt(80);
  const before = sceneHash(effectsState(run.effects));
  const layers = run.effects.smokeLayers();
  assert.ok(layers.length > 0, 'a layer has formed by T+80');
  assert.equal(sceneHash(effectsState(run.effects)), before);
});

test(
  'food-court T+15 state and a 15 s Harbour crowd hash the same twice',
  { timeout: 60_000 },
  () => {
    const firstFire = effectsState(foodCourtAt(15));
    const secondFire = effectsState(foodCourtAt(15));
    assert.deepEqual(firstFire, secondFire);
    assert.equal(sceneHash(firstFire), hashes.foodCourtTableT15);

    const firstCrowd = harbourCrowdAt(15);
    const secondCrowd = harbourCrowdAt(15);
    const firstPeople = crowdState(firstCrowd.evac);
    const secondPeople = crowdState(secondCrowd.evac);
    assert.deepEqual(firstPeople, secondPeople);
    assert.deepEqual(effectsState(firstCrowd.effects), effectsState(secondCrowd.effects));
    assert.equal(
      sceneHash({ people: firstPeople, effects: effectsState(firstCrowd.effects) }),
      hashes.harbourCrowd15s,
    );
  },
);
