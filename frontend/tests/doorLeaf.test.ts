import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MOUTH_APPROACH_M, nextIndoorWaypoint } from '../src/lib/evacuation/hazardSensing.ts';
import {
  CLOSER_LATCH_FRACTION,
  CLOSER_RATE_PER_S,
  CLOSER_SWEEP_S,
  commandDoorLeaf,
  doorHeldShut,
  leafWidthM,
  stepDoorLeaves,
  type DoorLeafWall,
} from '../src/lib/rts/doorLeaf.ts';
import { enclosureFromGrid } from '../src/lib/rts/twoZone.ts';

function ratedDoor(over: Partial<DoorLeafWall> = {}): DoorLeafWall {
  return {
    id: 'door',
    hasDoor: true,
    doorWidth: 0.9,
    doorPosition: 0.5,
    fireRatingMin: 20,
    openFraction: 1,
    startX: 0,
    startY: 0,
    endX: 4,
    endY: 0,
    ...over,
  };
}

test('a fire door closes at the accessible-door minimum', () => {
  const wall = ratedDoor();
  stepDoorLeaves([wall], [], new Set(), CLOSER_SWEEP_S, MOUTH_APPROACH_M);
  assert.ok(Math.abs((wall.openFraction ?? 0) - CLOSER_LATCH_FRACTION) < 1e-9);
  assert.ok(Math.abs(CLOSER_RATE_PER_S - (1 - CLOSER_LATCH_FRACTION) / CLOSER_SWEEP_S) < 1e-12);
  stepDoorLeaves([wall], [], new Set(), 1, MOUTH_APPROACH_M);
  assert.equal(wall.openFraction, 0);
  assert.equal(leafWidthM(wall), 0);
});

test('a person in the opening holds the closer', () => {
  const wall = ratedDoor();
  stepDoorLeaves([wall], [{ x: 2, y: 0.4 }], new Set(), CLOSER_SWEEP_S, MOUTH_APPROACH_M);
  assert.equal(wall.openFraction, 1);
  assert.equal(leafWidthM(wall), 0.9);
});

test('an unrated door stays where it was left', () => {
  const wall = ratedDoor({ fireRatingMin: undefined, openFraction: 1 });
  stepDoorLeaves([wall], [], new Set(), 30, MOUTH_APPROACH_M);
  assert.equal(wall.openFraction, 1);
  const left = ratedDoor({ fireRatingMin: undefined, openFraction: 0.4 });
  stepDoorLeaves([left], [], new Set(), 30, MOUTH_APPROACH_M);
  assert.equal(left.openFraction, 0.4);
});

test('the rating opens the leaf after that many minutes of flashover', () => {
  const wall = ratedDoor({ fireRatingMin: 1, openFraction: 0 });
  stepDoorLeaves([wall], [], new Set(), 120, MOUTH_APPROACH_M);
  assert.equal(wall.doorFailed, undefined);
  assert.equal(wall.doorExposedSec ?? 0, 0);
  stepDoorLeaves([wall], [], new Set(['door']), 59, MOUTH_APPROACH_M);
  assert.notEqual(wall.doorFailed, true);
  stepDoorLeaves([wall], [], new Set(['door']), 1, MOUTH_APPROACH_M);
  assert.equal(wall.doorFailed, true);
  assert.equal(wall.openFraction, 1);
  stepDoorLeaves([wall], [], new Set(['door']), 30, MOUTH_APPROACH_M);
  assert.equal(wall.openFraction, 1);
});

test('a command pins the leaf, and a failed door does not stay shut', () => {
  const wall = ratedDoor();
  commandDoorLeaf(wall, 0);
  assert.equal(doorHeldShut(wall), true);
  stepDoorLeaves([wall], [{ x: 2, y: 0.2 }], new Set(), 5, MOUTH_APPROACH_M);
  assert.equal(wall.openFraction, 0);
  commandDoorLeaf(wall, 1, false);
  assert.equal(wall.doorPinned, false);
  assert.equal(wall.openFraction, 1);
  wall.doorFailed = true;
  commandDoorLeaf(wall, 0);
  assert.equal(wall.openFraction, 1);
  assert.equal(wall.doorPinned, false);
});

test('the fire vent and the crowd both read the leaf', () => {
  const studs = new Map([
    ['a', { id: 'a', x: 0, y: 0, level: 'G' }],
    ['gap', { id: 'gap', x: 3, y: 0, level: 'G' }],
  ]);
  const neighbors = new Map<string, readonly string[]>([
    ['a', ['gap']],
    ['gap', ['a']],
  ]);
  const wall = {
    id: 'partition',
    x1: 1.5,
    y1: -6,
    x2: 1.5,
    y2: 6,
    hasDoor: true,
    doorWidth: 1.6,
    doorPosition: 0.5,
    material: 'concrete',
    level: 'G',
    openFraction: 1,
  };
  const open = enclosureFromGrid(['a'], studs, neighbors, [wall], 4);
  assert.equal(open?.spec.vents[0]?.widthM, 1.6);
  const half = enclosureFromGrid(['a'], studs, neighbors, [{ ...wall, openFraction: 0.5 }], 4);
  assert.equal(half?.spec.vents[0]?.widthM, 0.8);
  const shut = enclosureFromGrid(['a'], studs, neighbors, [{ ...wall, openFraction: 0 }], 4);
  assert.equal(shut?.spec.vents.length, 0);

  const crowd = {
    startX: 0,
    startY: 2,
    endX: 4,
    endY: 2,
    hasDoor: true,
    doorWidth: 0.9,
    doorPosition: 0.5,
  };
  const pushed = nextIndoorWaypoint({ x: 2, y: 0 }, { x: 2, y: 4 }, [
    { ...crowd, openFraction: 0 },
  ]);
  assert.ok(Math.abs(pushed.x - 2) < 1e-6 && Math.abs(pushed.y - 2) < 1e-6);
  const held = nextIndoorWaypoint({ x: 2, y: 0 }, { x: 2, y: 4 }, [
    { ...crowd, openFraction: 0, doorPinned: true },
  ]);
  assert.ok(
    Math.hypot(held.x - 2, held.y - 2) > 0.5,
    `a shut pin is a wall, aim ${held.x},${held.y}`,
  );
  const upstairs = ratedDoor({ level: 'G' });
  stepDoorLeaves([upstairs], [{ x: 2, y: 0.2, level: 'L1' }], new Set(), 5, MOUTH_APPROACH_M);
  assert.ok((upstairs.openFraction ?? 1) < 1);
});
