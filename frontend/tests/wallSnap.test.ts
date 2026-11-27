/**
 * Wall ends on the RTS page: studs sit on 3 m cell centres, so the building
 * edge, its corners and other walls' ends are offered as snap targets too.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nearestOutlinePoint, snapWallPoint } from '../src/lib/rts/wallSnap.ts';

const box = [
  { x: 0, y: 0 },
  { x: 60, y: 0 },
  { x: 60, y: 27 },
  { x: 0, y: 27 },
];

test('a click near the building edge lands on the edge, not on the stud 1.5 m in', () => {
  const r = snapWallPoint({ x: 0.4, y: 10 }, box, [], { x: 1.5, y: 10.5 });
  assert.equal(r.kind, 'outline');
  assert.deepEqual(r.pos, { x: 0, y: 10 });
});

test('a click nearer a stud than the edge still lands on the stud', () => {
  const r = snapWallPoint({ x: 1.2, y: 10.4 }, box, [], { x: 1.5, y: 10.5 });
  assert.equal(r.kind, 'stud');
  assert.deepEqual(r.pos, { x: 1.5, y: 10.5 });
});

test('corners and existing wall ends join when they are the nearest target', () => {
  assert.deepEqual(snapWallPoint({ x: 0.5, y: 0.6 }, box, [], { x: 1.5, y: 1.5 }), {
    pos: { x: 0, y: 0 },
    kind: 'join',
  });
  const end = { x: 12, y: 13.5 };
  assert.deepEqual(snapWallPoint({ x: 12.3, y: 13.2 }, box, [end], { x: 13.5, y: 13.5 }), {
    pos: end,
    kind: 'join',
  });
});

test('with no stud near and no target in reach the click stays where it is', () => {
  assert.deepEqual(snapWallPoint({ x: 30, y: 13 }, box, [], null), {
    pos: { x: 30, y: 13 },
    kind: 'free',
  });
});

test('the nearest outline point can be a corner', () => {
  assert.deepEqual(nearestOutlinePoint({ x: -2, y: -1 }, box).point, { x: 0, y: 0 });
});
