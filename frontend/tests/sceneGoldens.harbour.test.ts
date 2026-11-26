/**
 * Harbour House scenes: open crowd, east exit blocked, and the shop.
 * The crowds run to T+600. One nightly matrix entry, one scene at a time.
 *
 * Pyrolysis mass is capped at an equivalence ratio of 2, and the spill
 * entrains only the hot outflow below the receiving interface. The shop
 * door solves against the mall layer. At T+180 the shop burns
 * 12.9 MW of 46.5 MW prescribed, upper oxygen 0.198. It is 15.3 MW at
 * T+200, 32.9 MW at T+290 and 36.4 MW at T+320, and from T+180 it spans
 * 12.9 to 56.9 MW. The kitchen is 0.6 MW at T+210 and 2.7 MW at T+370,
 * against its 6.8 MW door. A fireless room keeps the jet path after the
 * feed pauses, so both crowds still have a mall layer at T+300: 1.30 m
 * and 113.3 K, with head-height smoke at 1. At T+390 the open mall is
 * 1.15 m and 115.8 K and the blocked mall is 1.15 m and 116.2 K, and the
 * head-height smoke is still 1. By T+600 the open mall is 1.07 m and
 * 114.1 K, and the blocked mall is 1.12 m and 114.8 K.
 * Heat is a separate ISO 13571 dose. Six people are down from it by
 * T+180 in both crowds, and that holds through T+600. Gas concentration
 * is the soot mass on the stud: the layer's grams over the upper-layer
 * volume, or the column extinction, including soot past 6.1 per metre.
 * The smoke number still saturates there, and walking and sight use
 * that number. Open outs are 68, 90, 96 and 99 at T+180, T+240, T+300
 * and T+600. Downs are 14 at T+300 and 15 at T+600. Fume downs stay 0,
 * and 21 are still inside at T+600, one of them in the mall. The highest
 * asphyxiant FED still inside is 1 and the highest heat FED is 1.001.
 * Late mean smoke is 0.767. The blocked crowd lets 41, 55 and 100 people
 * out at T+180, T+240 and T+300, and 100 by T+600. Downs stay 14, with
 * 20 still inside and none of them in the mall. Late mean smoke is
 * 0.855. Mean smoke at T+180, T+240 and T+300 is 0.384, 0.385 and 0.704
 * in the open crowd and 0.384, 0.385 and 0.705 in the blocked crowd.
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
