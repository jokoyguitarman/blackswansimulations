/**
 * Harbour House scenes: open crowd, east exit blocked, and the shop.
 * The crowds run to T+600. One nightly matrix entry, one scene at a time.
 *
 * Pyrolysis mass is capped at an equivalence ratio of 2, and the spill
 * entrains only the hot outflow below the receiving interface. The shop
 * door solves against the mall layer. At T+180 the shop burns
 * 21.5 MW of 46.5 MW prescribed, upper oxygen 0.193, under the 22.1 MW
 * door. It is 27.2 MW at T+200, 18.6 MW at T+290 and 19.8 MW at T+320,
 * and from T+180 it spans 15.3 to 56.9 MW. The kitchen is 2.7 MW at
 * T+210 and 0.5 MW at T+370, against its 6.8 MW door. With the east
 * exit open the tile mall at T+300 is 0.78 m and 151.5 K. With it
 * blocked the mall is 0.81 m and 149.6 K. At T+600 the mall has no
 * layer in either crowd.
 * Heat is a separate ISO 13571 dose. Five people are down from it by
 * T+180 in both crowds, and six by T+240. The open crowd has seven by
 * T+600. The blocked crowd stays at six. Gas concentration is the soot
 * mass on the stud: the layer's grams over the upper-layer volume, or
 * the column extinction, including soot past 6.1 per metre. The smoke
 * number still saturates there, and walking and sight use that number.
 * Open outs are 68, 90, 96 and 100 at T+180, T+240, T+300 and T+600.
 * Downs are 13 at T+180 and 16 at T+240 and T+300, then 17 at T+600.
 * Two are fume downs on the T+300 snapshot, and 23 are still inside at
 * T+600, one of them in the mall. The highest asphyxiant FED still
 * inside is 1.002 and the highest heat FED is 1. Late mean smoke is
 * 0.404. The blocked crowd lets 41 and 77 people out at T+180 and
 * T+240, and 100 by T+300. By T+600, 100 are out and 16 are down, with
 * 22 still inside and none of them in the mall. Late mean smoke is
 * 0.404. Mean smoke at T+180, T+240 and T+300 is 0.384, 0.666 and 0.402
 * with the east exit open, and 0.384, 0.667 and 0.402 with it blocked.
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
