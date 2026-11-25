/**
 * Per-PR determinism check for the scene harness.
 *
 * Two food-court table runs through T+15 must hash the same and match
 * `scenes/goldens/food-court-short.json` (3 kW, layer still off). On this
 * machine the pair takes about 7 s. The Decision 9 figures, including the
 * T+120 table mark, are the slow files below. They skip unless
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
import shortGolden from './scenes/goldens/food-court-short.json' with { type: 'json' };
import { runFoodCourt } from './scenes/foodCourt.ts';
import { sceneHash } from './scenes/hash.ts';

const SHORT = { fire: 'table' as const, hoods: false, untilSec: 15, alsoAt: [15] };

test('two food-court table runs to T+15 hash the same', { timeout: 30_000 }, () => {
  const first = runFoodCourt(SHORT);
  const second = runFoodCourt(SHORT);
  assert.equal(sceneHash(first), sceneHash(second));
  assert.deepEqual(first, second);
  assert.deepEqual(first, shortGolden);
});
