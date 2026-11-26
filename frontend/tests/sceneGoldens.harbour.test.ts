/**
 * Harbour House scenes: open crowd, east exit blocked, and the shop.
 * About 8, 8 and 9 minutes, run one at a time. One nightly matrix entry.
 *
 * Rebaselined when pyrolysate became a species in the layer mass and the
 * doorway spill matched CFAST poreh_plume: the (Tl/Tu)^(2/3) factor, the
 * rise from max(sill, source interface), and the tgignt gate. The shop
 * stays on its door, 22.6–22.8 MW from T+180 through T+370 against
 * 22.1 MW. The tile mall at T+300 is the peak of a transient, 1.79 m and
 * 159.4 K, and the interface is still falling. It crosses head height at
 * 307 s, so the open crowd counts at T+300 do not move. The blocked exit
 * lets one more person out by T+300. Smoke at T+240 and T+300 moves with
 * the deeper layer.
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
