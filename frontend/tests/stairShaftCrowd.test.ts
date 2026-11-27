/**
 * Stair shaft test with the crowd sensing smoke and fire.
 *
 * Default central blast: the four burning studs sit on the ground-floor
 * door's inside approach, so no stair or door has a finite cost from either
 * storey. The ground floor matches the same room run as a single floor:
 * survivors crawl out of the door (§2.6 in chooseExit) instead of
 * sheltering beside the fire.
 *
 * The upper floor is not a refuge. It is clear only until about T+240, is
 * untenable from about T+390 (head gas near 190 °C), and anyone still on it
 * is heat-down by T+420. Its only opening is a window, so its people take
 * the same crawl down the stair while the projected dose allows it. Two of
 * them freeze in fear at the foot of the stair and, with no marshal in this
 * run, stay there.
 *
 * The walled run seals a ground-floor room in the north-west corner and
 * splits the upper floor north of y = 1.5.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { InteriorWall } from '../src/lib/rts/types.ts';
import { runStairShaft } from './scenes/stairShaftFire.ts';
import { slowScene } from './scenes/slow.ts';

function wall(id: string, level: string, a: [number, number], b: [number, number]): InteriorWall {
  return {
    id,
    level,
    start: { x: a[0], y: a[1] },
    end: { x: b[0], y: b[1] },
    hasDoor: false,
    doorWidth: 0,
    doorPosition: 0.5,
  };
}

test(
  'central blast: both floors crawl out, and nobody defends in place on the upper floor',
  { skip: slowScene, timeout: 10 * 60 * 1000 },
  () => {
    const run = runStairShaft({ durationS: 420 });
    const floors = JSON.stringify(run.perFloor);
    const { G, L1 } = run.perFloor;
    assert.equal(G.sheltering, 0, floors);
    assert.equal(G.out + G.down, 20, floors);
    assert.equal(G.heatDown, 0, floors);
    assert.equal(L1.sheltering, 0, floors);
    assert.ok(L1.out >= 18, floors);

    const single = runStairShaft({ durationS: 240, groundOnly: true }).marks.at(-1);
    assert.ok(single);
    assert.equal(single.sheltering, 0);
  },
);

test(
  'walled scene: the sealed room shelters, the split upper floor walks round, nobody crosses a wall',
  { skip: slowScene, timeout: 10 * 60 * 1000 },
  () => {
    const walls = [
      wall('g-west-a', 'G', [-4.5, -6], [-4.5, 0]),
      wall('g-west-b', 'G', [-4.5, 0], [-7.5, 0]),
      wall('l1-split', 'L1', [1.5, -6], [1.5, 1.5]),
    ];
    const run = runStairShaft({ durationS: 420, walls });
    assert.equal(run.wallCrossings, 0);
    const atT240 = run.marks.find((mark) => mark.tSec === 240);
    assert.ok(atT240);
    const marks = JSON.stringify(atT240.byLevel);
    // Only the people inside the sealed corner room shelter.
    assert.ok((atT240.byLevel.G?.sheltering ?? 0) >= 1, marks);
    assert.equal(atT240.byLevel.L1?.sheltering ?? 0, 0, marks);
    const floors = JSON.stringify(run.perFloor);
    const { G, L1 } = run.perFloor;
    assert.equal(G.out + G.down, 20, floors);
    assert.ok(G.out >= 16, floors);
    assert.ok(L1.out >= 18, floors);
  },
);
