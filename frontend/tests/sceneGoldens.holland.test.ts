/**
 * Holland Village through T+300. About 27 minutes. Nightly matrix entry.
 * The job timeout is 60 minutes, so this test's own limit is 55.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import hollandGolden from './scenes/goldens/holland.json' with { type: 'json' };
import { runHolland } from './scenes/holland.ts';
import { slowScene } from './scenes/slow.ts';

test(
  'Holland Village matches the Decision 9 figures',
  { skip: slowScene, timeout: 55 * 60 * 1000 },
  () => {
    assert.deepEqual(runHolland(), hollandGolden);
  },
);
