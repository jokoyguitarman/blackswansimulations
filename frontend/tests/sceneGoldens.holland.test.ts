/**
 * Holland Village through T+300. Nightly matrix entry.
 * The job timeout is 60 minutes, so this test's own limit is 55.
 * Pedestrians no longer carry Matter air drag, and each person has a
 * seeded level speed around 1.34 m/s, so the crowd reaches the exits
 * earlier. Outs are 21, 74, 102 and 111 at T+90, T+120, T+180 and T+240,
 * against 2, 19, 72 and 102 before, and T+300 stays 111. The blast is at
 * T+60, after some have started walking, so one more person is caught:
 * 5 down (3 lethal, 2 serious) and 8 minor, against 4 down and 7 minor.
 * Fume and heat downs stay 0, and the burn counts are unchanged. Three
 * people still freeze in fear and, with no marshal, stay frozen through
 * T+300. They are not counted as crawling.
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
