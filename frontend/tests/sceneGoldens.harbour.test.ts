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
 * the floor, with the mall empty of people. Heat is a separate ISO
 * 13571 dose. Four people are down from it by T+180, in both crowds,
 * and fume downs stay 0. Open at T+300 is 99 out and 13 down. The
 * blocked exit lets 79 people out by T+300. A mall fuel stock of 0 kg
 * before about T+376 means the spill burned the fuel the shop jet has
 * carried since about T+159. It does not mean the jet was clean. Soot
 * and gas use the same φ ≤ 2 pyrolysis. Late mean smoke is 0.835 open
 * and 0.840 blocked. The highest asphyxiant FED still inside is 0.029
 * open and 0.042 blocked, and the highest heat FED is 1.001. That
 * gas dose is the time integral. At the four heat downs (171.8 s,
 * shop s_0_12, interface 0.07 m, about 257 °C) φ is 1.47, so the
 * φ ≤ 2 cap is not cutting the pyrolysis: the fraction is 1 and the
 * CO yield is 0.214 g/g, between the well-ventilated 0.0175 and the
 * under-ventilated 0.222. The layer's soot is about 15 /m. The stud
 * is held at the smoke-scale cap, K = 6.1 /m, and the dose follows
 * that cap: about 1900 ppm CO, 88 ppm HCN, 17.4 % oxygen and 3.4 %
 * CO2, a rate of about 0.17 per minute. Until about T+140 the same
 * room is still well ventilated (φ about 0.3) and that rate is under
 * 0.01 per minute, so the rich air lasts about fifteen seconds before
 * the heat FED reaches 1. The T+300 smoke strings are unchanged.
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
