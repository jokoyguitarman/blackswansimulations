/**
 * Harbour House scenes: open crowd, east exit blocked, and the shop.
 * The crowds run to T+600. One nightly matrix entry, one scene at a time.
 *
 * Pyrolysis mass is capped at an equivalence ratio of 2, and the spill
 * entrains only the hot outflow below the receiving interface. The shop
 * door solves against the mall layer. Dropping the interface with the
 * expansion brings the oxygen limit forward: at T+180 the shop is
 * 21.5 MW of 46.5 MW prescribed, upper oxygen 0.197, under the 22.1 MW
 * door. It is 27.2 MW at T+200, 19.1 MW at T+290 and 18.9 MW at T+320,
 * and from T+180 it spans 18.7 to 33.5 MW. The kitchen holds 2.7 MW
 * from T+210 through T+370, against its 6.8 MW door. The tile mall at
 * T+300 is 1.45 m and 89.8 K. At T+600 the interface is 0.96 m and the
 * rise is 70.6 K.
 * Heat is a separate ISO 13571 dose. Nobody is down from it at T+180.
 * Three people are by T+240, in both crowds, and that count holds
 * through T+600. Gas concentration is the soot mass on the
 * stud: the layer's grams over the upper-layer volume, or the column
 * extinction, including soot past 6.1 per metre. The smoke number
 * still saturates there, and walking and sight use that number.
 * Open outs are 65, 82, 83 and 97 at T+180, T+240, T+300 and T+600,
 * with 18 down by T+600, one fume down on the T+300 snapshot, and 24
 * still inside, 5 of them in the mall. The highest asphyxiant FED still
 * inside is 1.001 and the highest heat FED is 1.001. Late mean smoke is
 * 0.835. The blocked crowd lets 42 and 51 people out at T+180 and
 * T+240, and 102 by T+300. By T+600, 102 are out and 13 are down, with
 * 19 still inside and none of them in the mall. Late mean smoke is
 * 0.843. Mean smoke at T+180, T+240 and T+300 is 0.402, 0.725 and 0.757
 * with the east exit open, and 0.402, 0.728 and 0.762 with it blocked.
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
    'Harbour open crowd matches the Decision 9 figures',
    { skip: slowScene, timeout: TIMEOUT_MS },
    () => {
      assert.deepEqual(runHarbourCrowd(false), harbourOpenGolden);
    },
  );

  test(
    'Harbour blocked east exit matches the Decision 9 figures',
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
