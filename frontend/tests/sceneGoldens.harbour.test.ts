/**
 * Harbour House scenes: open crowd, east exit blocked, and the shop.
 * The crowds run to T+600. One nightly matrix entry, one scene at a time.
 *
 * Pyrolysis mass is capped at an equivalence ratio of 2, and the spill
 * entrains only the hot outflow below the receiving interface. The shop
 * door solves against the mall layer, so the burn falls below the
 * 22.1 MW door: 21.5 MW at T+180, then 18.6–21.5 MW through T+370.
 * Upper-layer oxygen is still 0.186 at T+180 and 0.091 by T+370.
 * The kitchen holds 4.2 MW at T+210 and 3.1–3.2 MW from T+290, against
 * its 6.8 MW door. The tile mall at T+300 is 2.10 m and 70.7 K. At T+600
 * the interface is 0.77 m and the rise is 50 K, still above the floor.
 * Heat is a separate ISO 13571 dose. Four people are down from it by
 * T+180, in both crowds. Gas concentration is the soot mass on the
 * stud: the layer's grams over the upper-layer volume, or the column
 * extinction, including soot past 6.1 per metre. The smoke number
 * still saturates there, and walking and sight use that number.
 * Open outs are 64, 93, 99 and 101 at T+180, T+240, T+300 and T+600,
 * with 13 down, fume downs at 0, and 19 still inside. The highest
 * asphyxiant FED still inside is 0.104 and the highest heat FED is
 * 1.001. Late mean smoke is 0.822. The blocked crowd lets 41 and 52
 * people out at T+180 and T+240, and 83 by T+300. By T+600, 101 are
 * out and 13 are down, with 19 still inside. Nobody is left in the
 * mall at an asphyxiant FED of 1. The highest asphyxiant FED still
 * inside is 0.104. Heat downs stay 4. Late mean smoke is 0.826.
 * Mean smoke at T+180, T+240 and T+300 is 0.423, 0.451 and 0.443 in
 * both crowds. Flashover stays 79.88 s and the peak stays 163.5 MW.
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
