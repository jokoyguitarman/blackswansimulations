/**
 * Hooded food-court fryer through T+600. About 14 minutes. Nightly matrix entry.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import foodCourtGolden from './scenes/goldens/food-court.json' with { type: 'json' };
import { runFoodCourt } from './scenes/foodCourt.ts';
import { slowScene } from './scenes/slow.ts';

test(
  'hooded food-court fryer matches the Decision 9 marks',
  { skip: slowScene, timeout: 35 * 60 * 1000 },
  () => {
    assert.deepEqual(runFoodCourt({ fire: 'oil', hoods: true }), foodCourtGolden.fryerHood);
  },
);
