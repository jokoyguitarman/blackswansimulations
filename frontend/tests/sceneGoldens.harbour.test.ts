/**
 * Harbour House scenes: open crowd, east exit blocked, and the shop.
 * The crowds run to T+600. One nightly matrix entry, one scene at a time.
 *
 * The shop door publishes the mean of its last two floor-pressure roots,
 * and a sliver the prescribed plume can consume in one substep,
 * plume·slice/(ρ·A) at the floor, credits half its air to the flame.
 * The door no longer reverses every step once the interface is on
 * the floor. At T+180 the shop burns 12.9 MW of 46.5 MW prescribed, upper
 * oxygen 0.198. It is 15.2 MW at T+200, 15.2 MW at T+290 and 15 MW at
 * T+320, and from T+180 it spans 12.9 to 17 MW. The kitchen is 0.6 MW at
 * T+210 and 2.1 MW at T+370, against its 6.8 MW door. A fireless room
 * keeps the jet path after the feed pauses, so both crowds still have a
 * mall layer at T+300: 1.60 m and 69 K. At T+390 both malls are 1.27 m
 * and 81.7 K. By T+600 both are 1.12 m and 81.4 K.
 * Heat is a separate ISO 13571 dose. Six people are down from it by
 * T+180 in both crowds, and that holds through T+600. Gas concentration
 * is the soot mass on the stud: the layer's grams over the upper-layer
 * volume, or the column extinction, including soot past 6.1 per metre.
 * The smoke number still saturates there, and walking and sight use
 * that number. Open outs are 68, 90, 96 and 99 at T+180, T+240, T+300
 * and T+600. Downs are 14 at T+300 and 15 at T+600. Fume downs stay 0,
 * and 21 are still inside at T+600, one of them in the mall. The highest
 * asphyxiant FED still inside is 1 and the highest heat FED is 1.001.
 * Late mean smoke is 0.779. The blocked crowd lets 41, 55 and 97 people
 * out at T+180, T+240 and T+300, and 100 by T+600. Downs stay 14, with
 * 20 still inside and none of them in the mall. Late mean smoke is
 * 0.786. Mean smoke at T+180, T+240 and T+300 is 0.384, 0.385 and 0.681
 * in both crowds. Flashover stays 79.88 s and the peak stays 163.5 MW.
 * The six people in the sealed concrete room have no route to any exit,
 * so they shelter in place, crawling, instead of walking at an exit
 * they cannot reach. The open crowd counts 7 crawling at T+300, those
 * six and one other. The blocked crowd records 48 reroutes, five fewer:
 * people in the room no longer switch between exits they cannot reach,
 * as when E2-east closes. Outs and downs do not move.
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
