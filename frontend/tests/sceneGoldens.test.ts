/**
 * Decision 9 scene goldens.
 *
 * The food-court table through T+120 runs on every `npm test`, twice, and the
 * two summaries must hash the same. That mark is 169 kW with the layer still
 * off. On this machine that pair takes about two minutes.
 *
 * The full scenes stay skipped unless `SCENE_NIGHTLY=1`:
 *
 *   SCENE_NIGHTLY=1 npx tsx --test frontend/tests/sceneGoldens.test.ts
 *
 * They run one at a time. Measured here: Harbour open 7.4 min, east blocked
 * 7.8 min, the shop 8.6 min, each food-court fire 14 to 15 min, Holland 27 min.
 * With the hash, that is about 111 minutes, so a pull-request run leaves them
 * for a nightly job. The timeout is 45 minutes because Holland used 27.
 *
 * Fire-only numbers are exact. The crowd counts here are exact too: a repeat
 * on this Node major reproduced them. A Node upgrade re-baselines the JSON.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import foodCourtGolden from './scenes/goldens/food-court.json' with { type: 'json' };
import harbourOpenGolden from './scenes/goldens/harbour-open.json' with { type: 'json' };
import harbourBlockedGolden from './scenes/goldens/harbour-blocked.json' with { type: 'json' };
import harbourShopGolden from './scenes/goldens/harbour-shop.json' with { type: 'json' };
import hollandGolden from './scenes/goldens/holland.json' with { type: 'json' };
import { runFoodCourt } from './scenes/foodCourt.ts';
import { runHarbourCrowd } from './scenes/harbourCrowd.ts';
import { runHarbourShop } from './scenes/harbourShop.ts';
import { runHolland } from './scenes/holland.ts';
import { sceneHash } from './scenes/hash.ts';

const nightly = process.env.SCENE_NIGHTLY === '1';
const FULL_SCENE = nightly ? false : 'full scene; run with SCENE_NIGHTLY=1';
const FULL_TIMEOUT_MS = 45 * 60 * 1000;

describe('scene goldens', { concurrency: 1 }, () => {
  test('two food-court table runs to T+120 hash the same', { timeout: 10 * 60 * 1000 }, () => {
    const expected = { ...foodCourtGolden.table, marks: [foodCourtGolden.table.marks[0]] };
    const first = runFoodCourt({ fire: 'table', hoods: false, untilSec: 120 });
    const second = runFoodCourt({ fire: 'table', hoods: false, untilSec: 120 });
    assert.equal(sceneHash(first), sceneHash(second));
    assert.deepEqual(first, second);
    assert.deepEqual(first, expected);
  });

  test(
    'food-court table matches the Decision 9 marks',
    { skip: FULL_SCENE, timeout: FULL_TIMEOUT_MS },
    () => {
      assert.deepEqual(runFoodCourt({ fire: 'table', hoods: false }), foodCourtGolden.table);
    },
  );

  test(
    'hooded food-court table matches the Decision 9 marks',
    { skip: FULL_SCENE, timeout: FULL_TIMEOUT_MS },
    () => {
      assert.deepEqual(runFoodCourt({ fire: 'table', hoods: true }), foodCourtGolden.tableHood);
    },
  );

  test(
    'food-court fryer matches the Decision 9 marks',
    { skip: FULL_SCENE, timeout: FULL_TIMEOUT_MS },
    () => {
      assert.deepEqual(runFoodCourt({ fire: 'oil', hoods: false }), foodCourtGolden.fryer);
    },
  );

  test(
    'hooded food-court fryer matches the Decision 9 marks',
    { skip: FULL_SCENE, timeout: FULL_TIMEOUT_MS },
    () => {
      assert.deepEqual(runFoodCourt({ fire: 'oil', hoods: true }), foodCourtGolden.fryerHood);
    },
  );

  test(
    'Harbour shop stays on the Decision 9 burn band',
    { skip: FULL_SCENE, timeout: FULL_TIMEOUT_MS },
    () => {
      assert.deepEqual(runHarbourShop(), harbourShopGolden);
    },
  );

  test(
    'Harbour open crowd matches the Decision 9 figures',
    { skip: FULL_SCENE, timeout: FULL_TIMEOUT_MS },
    () => {
      assert.deepEqual(runHarbourCrowd(false), harbourOpenGolden);
    },
  );

  test(
    'Harbour blocked east exit matches the Decision 9 figures',
    { skip: FULL_SCENE, timeout: FULL_TIMEOUT_MS },
    () => {
      assert.deepEqual(runHarbourCrowd(true), harbourBlockedGolden);
    },
  );

  test(
    'Holland Village matches the Decision 9 figures',
    { skip: FULL_SCENE, timeout: FULL_TIMEOUT_MS },
    () => {
      assert.deepEqual(runHolland(), hollandGolden);
    },
  );
});
