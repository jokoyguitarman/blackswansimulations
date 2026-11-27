/**
 * Harbour House scenes: open crowd, east exit blocked, and the shop.
 * The crowds run to T+600. One nightly matrix entry, one scene at a time.
 *
 * The shop door publishes the mean of its last two floor-pressure roots,
 * and a sliver the prescribed plume can consume in one substep,
 * plume·slice/(ρ·A) at the floor, credits half its air to the flame.
 * The door no longer reverses every step once the interface is on
 * the floor. The mall's upper inflow is near-fresh air, and once the
 * interface is on the floor the flame also takes its own layer's oxygen.
 * The credit fades over the first 5 cm, so a millimetre of lift does not
 * drop the flame back to fresh air. At T+180 the shop burns 27.1 MW of
 * 46.5 MW prescribed, upper oxygen 0.189. The layer still holds oxygen,
 * so the burn reaches 50.2 MW at T+200. That excess over the 22.1 MW
 * door is the layer's own oxygen, booked at 13,100 kJ per kilogram. By
 * T+290 the shop is 15.1 MW, and 9.7 MW at T+320. From T+180 it spans 9.7
 * to 50.2 MW. The frame peak, one substep per frame, is 52.3 MW. The
 * kitchen burns its own layer after the shop's inflow is spent: the
 * prescribed 4.2 MW at T+210, T+250 and T+290. By T+320 the flame is
 * out and does not relight, and its oxygen is at the extinction
 * limit. The floor-deep layer stays. At T+370 the rise is
 * 107 K with 1843 g of soot, against its 6.8 MW door. A fireless room
 * keeps the jet path after the feed pauses, so both crowds still have a
 * mall layer at T+300: 1.48 m and 66.7 K. By T+600 both are 1.11 m and
 * 78.8 K.
 * Heat is a separate ISO 13571 dose. Five people are down from it by
 * T+180 in both crowds, and that holds through T+600. Gas concentration
 * is the soot mass on the stud: the layer's grams over the upper-layer
 * volume, or the column extinction, including soot past 6.1 per metre.
 * The smoke number still saturates there, and walking and sight use
 * that number. The unimpeded walk stops at 2.0 m/s after panic. Open
 * outs are 93, 101, 101 and 101 at T+180, T+240, T+300 and T+600. Downs
 * are 12 from T+180 through T+300 and 13 at T+600. No fume downs by
 * T+300, and 19 are still inside at T+600, one of them in the mall. The
 * highest asphyxiant FED still inside is 1 and the highest heat FED is
 * 1.001. Late mean smoke is 0.774. The blocked crowd lets 91, 100 and
 * 101 people out at T+180, T+240 and T+300, and 101 by T+600. Downs
 * match the open crowd, with 19 still inside and one of them in the
 * mall. Late mean smoke is 0.779. Open reroutes are 0 and blocked
 * reroutes are 13. Mean smoke at T+180, T+240 and T+300 is 0.382, 0.376
 * and 0.652 in the open crowd and 0.382, 0.376 and 0.652 in the blocked
 * crowd. Flashover stays 79.88 s and the
 * peak stays 163.5 MW.
 * Freezing in fear: in both crowds ped 61 freezes at T+72, ped 36 at
 * T+79 and ped 109 at T+85, beside the west fires. Nobody freezes later
 * in the mall. The run has no marshal, so they stay frozen until a dose
 * puts them down: 61 and 109 by heat, 36 by the gas dose. Frozen people
 * are not counted as crawling. The freeze roll and the smoke turn-back
 * roll are keyed on the person, so a frozen person moves nobody else's
 * pre-movement or turn-back draw. The six people in the sealed concrete
 * room have no route to any exit, so they shelter in place. Both crowds
 * count 6 crawling at T+300, those six.
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
