/**
 * Harbour House scenes: open crowd, east exit blocked, and the shop.
 * The crowds run to T+600. One nightly matrix entry, one scene at a time.
 *
 * Pyrolysis mass is capped at an equivalence ratio of 2, and the spill
 * entrains only the hot outflow below the receiving interface. The shop
 * door solves against the mall layer. At T+180 the shop burns
 * 12.9 MW of 46.5 MW prescribed, upper oxygen 0.198. It is 15.3 MW at
 * T+200, 38.3 MW at T+290 and 46.1 MW at T+320, and from T+180 it spans
 * 12.9 to 57.2 MW. The kitchen is 0.6 MW at T+210 and 0.1 MW at T+370,
 * against its 6.8 MW door. Neither crowd has a mall layer at T+300.
 * By T+600 the open mall is 0.24 m and 137.8 K, and the blocked mall is
 * 0.32 m and 140.7 K.
 * Heat is a separate ISO 13571 dose. Six people are down from it by
 * T+180 in both crowds, and that holds through T+600. Gas concentration
 * is the soot mass on the stud: the layer's grams over the upper-layer
 * volume, or the column extinction, including soot past 6.1 per metre.
 * The smoke number still saturates there, and walking and sight use
 * that number. Open outs are 68, 90, 96 and 100 at T+180, T+240, T+300
 * and T+600. Downs stay 14. None are fume downs, and 20 are still inside
 * at T+600, none of them in the mall. The highest asphyxiant FED still
 * inside is 0.187 and the highest heat FED is 1.001. Late mean smoke is
 * 0.402. The blocked crowd lets 41, 55 and 99 people out at T+180,
 * T+240 and T+300, and 100 by T+600. Downs stay 14, with 20 still inside
 * and none of them in the mall. Late mean smoke is 0.402. Mean smoke at
 * T+180, T+240 and T+300 is 0.384, 0.385 and 0.382 in both crowds.
 * Flashover stays 79.88 s and the peak stays 163.5 MW.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import harbourBlockedGolden from './scenes/goldens/harbour-blocked.json' with { type: 'json' };
import harbourOpenGolden from './scenes/goldens/harbour-open.json' with { type: 'json' };
import harbourShopGolden from './scenes/goldens/harbour-shop.json' with { type: 'json' };
import { runHarbourCrowd } from './scenes/harbourCrowd.ts';
import { runHarbourShop } from './scenes/harbourShop.ts';
import { slowScene } from './scenes/slow.ts';

const TIMEOUT_MS = 20 * 60 * 1000;

describe('Harbour scene goldens', { concurrency: 1 }, () => {
  test(
    'Harbour open crowd matches the recorded crowd',
    { skip: slowScene, timeout: TIMEOUT_MS },
    () => {
      assert.deepEqual(runHarbourCrowd(false), harbourOpenGolden);
    },
  );

  test(
    'Harbour blocked east exit matches the recorded crowd',
    { skip: slowScene, timeout: TIMEOUT_MS },
    () => {
      assert.deepEqual(runHarbourCrowd(true), harbourBlockedGolden);
    },
  );

  test(
    'Harbour shop stays on the Decision 9 burn band',
    { skip: slowScene, timeout: TIMEOUT_MS },
    () => {
      assert.deepEqual(runHarbourShop(), harbourShopGolden);
    },
  );
});
