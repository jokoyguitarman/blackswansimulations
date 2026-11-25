/**
 * Food-court table through T+600, including the Decision 9 T+120 mark of 169 kW.
 * About 14 minutes. Nightly matrix entry.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import foodCourtGolden from './scenes/goldens/food-court.json' with { type: 'json' };
import { runFoodCourt } from './scenes/foodCourt.ts';
import { slowScene } from './scenes/slow.ts';

test(
  'food-court table matches the Decision 9 marks',
  { skip: slowScene, timeout: 35 * 60 * 1000 },
  () => {
    assert.deepEqual(runFoodCourt({ fire: 'table', hoods: false }), foodCourtGolden.table);
  },
);
