/**
 * Harbour House scenes: open crowd, east exit blocked, and the shop.
 * The crowds run to T+600. One nightly matrix entry, one scene at a time.
 *
 * Pyrolysis mass is capped at an equivalence ratio of 2, and the spill
 * entrains only the hot outflow below the receiving interface. The shop
 * door solves against the mall layer. At T+180 the shop burns
 * 42.4 MW of 46.5 MW prescribed, upper oxygen 0.178, under the 22.1 MW
 * door. It is 17.2 MW at T+200, 15.3 MW at T+290 and 15 MW at T+320,
 * and from T+180 it spans 14.6 to 42.4 MW. The kitchen is 4.2 MW at
 * T+210 and 2.1 MW at T+370, against its 6.8 MW door. The tile mall at
 * T+300 is 1.32 m and 89.7 K. At T+600 the interface is 0.93 m and the
 * rise is 67 K.
 * Heat is a separate ISO 13571 dose. Nobody is down from it at T+180.
 * Two people are by T+240, in both crowds, and that count holds
 * through T+600. Gas concentration is the soot mass on the
 * stud: the layer's grams over the upper-layer volume, or the column
 * extinction, including soot past 6.1 per metre. The smoke number
 * still saturates there, and walking and sight use that number.
 * Open outs are 69, 90, 100 and 104 at T+180, T+240, T+300 and T+600.
 * 16 are down by T+300 and that holds through T+600: eight from the
 * blast, one heat down who never started out, and seven in a cluster of
 * forced crawlers heading for E1-west (one heat, six fume). The
 * all-Infinity fallback sends that cluster to the west door, and it goes
 * down at T+190 to T+201, six of them just outside the door in its spill.
 * Those six count as out as well. Master had three down there, in both
 * crowds. The extra four come from contacts no longer towing people at
 * the faster one's pace. With one blast down fewer (nine on master),
 * they take the blocked crowd from 13 to 16.
 * People dying just past that door is a follow-up, with the steering
 * blend that never catches the air drag (frictionAir). Nobody is in the
 * mall at T+600. The
 * highest asphyxiant FED still inside is 1.002 and the highest heat FED
 * is 1. Late mean smoke is 0.835. The blocked crowd lets 42 and 81
 * people out at T+180 and T+240, and 104 by T+300. By T+600, 104 are out
 * and 16 are down, the same people as in the open crowd, and nobody is
 * in the mall. Late mean smoke is 0.843.
 * Mean smoke at T+180, T+240 and T+300 is 0.402, 0.726 and 0.761
 * with the east exit open, and 0.402, 0.729 and 0.766 with it blocked.
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
