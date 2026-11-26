/**
 * Harbour House scenes: open crowd, east exit blocked, and the shop.
 * The crowds run to T+600. One nightly matrix entry, one scene at a time.
 *
 * Pyrolysis mass is capped at an equivalence ratio of 2, and the spill
 * entrains only the hot outflow below the receiving interface. The shop
 * door solves against the mall layer. Expansion delays the oxygen limit:
 * the shop is still at 45.5 MW at T+180, of 46.5 MW prescribed, with
 * upper oxygen 0.180. By T+200 it is 21.4 MW, under the 22.1 MW door,
 * then 18.8 MW at T+290 and 18.9 MW at T+320. The kitchen is unchanged,
 * 4.2 MW at T+210, 3.3 MW at T+250 and 3 MW from T+290, against its
 * 6.8 MW door. The tile mall at T+300 is 1.96 m and 65.9 K. At T+600
 * the interface is 1.08 m and the rise is 82.6 K. The extra mass from
 * the shop deepens the mall layer and cools it a few degrees.
 * Heat is a separate ISO 13571 dose. Four people are down from it by
 * T+180, in both crowds. Gas concentration is the soot mass on the
 * stud: the layer's grams over the upper-layer volume, or the column
 * extinction, including soot past 6.1 per metre. The smoke number
 * still saturates there, and walking and sight use that number.
 * Open outs are 64, 82, 96 and 99 at T+180, T+240, T+300 and T+600,
 * with 15 down by T+600, fume downs at 0, and 21 still inside, 2 of
 * them in the mall. The highest asphyxiant FED still inside is 1.001
 * and the highest heat FED is 1.001. Late mean smoke is 0.828. The
 * blocked crowd lets 41 and 63 people out at T+180 and T+240, and 91
 * by T+300. By T+600, 100 are out and 14 are down, with 20 still
 * inside, 1 of them in the mall at an asphyxiant FED of 1. Heat downs
 * stay 4. Late mean smoke is 0.833. Mean smoke at T+180, T+240 and
 * T+300 is 0.408, 0.410 and 0.450 with the east exit open, and 0.409,
 * 0.413 and 0.456 with it blocked. Flashover stays 79.88 s and the
 * peak stays 163.5 MW.
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
