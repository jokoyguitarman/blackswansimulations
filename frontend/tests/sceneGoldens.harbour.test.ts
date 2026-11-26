/**
 * Harbour House scenes: open crowd, east exit blocked, and the shop.
 * The crowds run to T+600. One nightly matrix entry, one scene at a time.
 *
 * Pyrolysis mass is capped at an equivalence ratio of 2, and the spill
 * entrains only the hot outflow below the receiving interface. The shop
 * stays on its door, 22.6–23.0 MW from T+180 through T+370 against
 * 22.1 MW. The tile mall at T+300 is 2.07 m and 79.4 K. It is 1.82 m at
 * T+330 and 1.60 m at T+360, so head height falls in that half-minute.
 * At T+600 the interface is 0.81 m and the rise is 58.5 K, still above
 * the floor. Heat is a separate ISO 13571 dose. Four people are down
 * from it by T+180, in both crowds. Gas concentration is the soot mass
 * on the stud: the layer's grams over the upper-layer volume, or the
 * column extinction, including soot past 6.1 per metre. The smoke
 * number still saturates there, and walking and sight use that number.
 * Open outs are 64, 93, 99 and 101 at T+180, T+240, T+300 and T+600,
 * with 13 down, fume downs at 0, and 19 still inside. The highest
 * asphyxiant FED still inside is 0.098 and the highest heat FED is
 * 1.001. Late mean smoke is 0.837. The blocked crowd lets 41, 52 and
 * 82 people out at the first three marks, and 100 by T+600, with 14
 * down and 20 still inside. One person is in the mall with asphyxiant
 * FED 1.001. Heat downs stay 4. Late mean smoke is 0.843. Mean smoke
 * at T+180, T+240 and T+300 is 0.424, 0.451 and 0.443 in both crowds.
 * A mall fuel stock of 0 kg before about T+376 means the spill burned
 * the fuel the shop jet has carried since about T+159. It does not mean
 * the jet was clean. Soot and gas use the same φ ≤ 2 pyrolysis.
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
