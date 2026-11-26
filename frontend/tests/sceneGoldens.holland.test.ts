/**
 * Holland Village through T+300. About 27 minutes. Nightly matrix entry.
 * The job timeout is 60 minutes, so this test's own limit is 55.
 * People in contact no longer tow each other at the faster one's pace.
 * That already moves the T+60 minor injuries from 9 to 7, and mid-run
 * arrivals are slower: 72 out at T+180 and 90 at T+210, against 85 and
 * 102 before. The counts converge by T+240, and 113 are out at T+300
 * against 114. Downs stay the four from the blast.
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
