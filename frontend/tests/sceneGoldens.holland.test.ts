/**
 * Holland Village through T+300. Nightly matrix entry.
 * The job timeout is 60 minutes, so this test's own limit is 55.
 * Pedestrians no longer carry Matter air drag. Each person draws an SFPE
 * unimpeded speed around 1.19 m/s, and panic brings the mean to about
 * 1.55 m/s. Outs are 19, 72, 100 and 112 at T+90, T+120, T+180 and T+240,
 * and T+300 is 112. The blast is at T+60: 5 down (3 lethal, 2 serious)
 * and 8 minor. Fume and heat downs stay 0, and the burn counts are
 * unchanged. A forced crawl no longer reverses on the stall corner, so
 * ped 17 is outside by T+210 and off the map by T+240. Three people still
 * freeze in fear (ped 61 at T+78, ped 101 at T+87, ped 36 at T+102) and,
 * with no marshal, stay frozen through T+300. They are not counted as
 * crawling.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import hollandGolden from './scenes/goldens/holland.json' with { type: 'json' };
import { runHolland } from './scenes/holland.ts';
import { slowScene } from './scenes/slow.ts';

test(
  'Holland Village matches the Decision 9 figures',
  { skip: slowScene, timeout: 55 * 60 * 1000 },
  () => {
    assert.deepEqual(runHolland(), hollandGolden);
  },
);
