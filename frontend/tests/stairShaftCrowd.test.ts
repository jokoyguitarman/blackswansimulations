/**
 * Stair shaft test with the crowd sensing smoke and fire, default central
 * blast. The four burning studs sit on the ground-floor door's inside
 * approach, so no stair or door has a finite cost from either storey.
 *
 * The ground floor matches the same room run as a single floor: survivors
 * crawl out of the door (§2.6) instead of sheltering beside the fire. The
 * upper floor's only opening is a window, and its only way out runs down
 * the stair into that room, so all 20 defend in place on the clean storey.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runStairShaft } from './scenes/stairShaftFire.ts';
import { slowScene } from './scenes/slow.ts';

test(
  'central blast: the ground floor crawls out and the upper floor shelters',
  { skip: slowScene, timeout: 10 * 60 * 1000 },
  () => {
    const run = runStairShaft({ durationS: 240 });
    const last = run.marks.at(-1);
    assert.ok(last);
    assert.equal(last.byLevel.G?.sheltering ?? 0, 0, JSON.stringify(last.byLevel));
    const ground = last.byLevel.G ?? {};
    const groundOut = (ground.outside ?? 0) + (ground.left_map ?? 0) + (ground.arrived ?? 0);
    const groundAlive = 20 - (ground.down ?? 0);
    assert.ok(groundOut >= groundAlive - 1, `ground out ${groundOut} of ${groundAlive}`);
    assert.equal(last.byLevel.L1?.sheltering, 20, JSON.stringify(last.byLevel));

    const single = runStairShaft({ durationS: 240, groundOnly: true }).marks.at(-1);
    assert.ok(single);
    assert.equal(single.sheltering, 0);
  },
);
