/**
 * Three-storey office fire sample: the plan the RTS page loads.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectSceneStuds } from '../src/lib/rts/sceneStuds.ts';
import { linkLevels, normaliseStairwell } from '../src/lib/rts/levels.ts';
import {
  OFFICE_TOWER_IGNITION_PLAN,
  OFFICE_TOWER_IGNITION_RADIUS_M,
  officeTowerFuelObjects,
  officeTowerRoomAt,
  officeTowerSample,
  officeTowerStuds,
  officeTowerToPlan,
} from '../src/lib/rts/officeTowerFire.ts';
import type { LevelDef } from '../src/lib/rts/types.ts';

const scene = officeTowerSample.scene;
const levels = scene.levels as LevelDef[];

function fireStuds() {
  const polygon = scene.buildingPolygon.map((pair) => [pair[0], pair[1]] as [number, number]);
  return projectSceneStuds(polygon, officeTowerStuds(polygon)).map((stud) => ({
    id: stud.id,
    simPos: stud.simPos,
    spatialContext: stud.spatialContext,
    level: stud.floor,
  }));
}

test('three storeys joined by three stairs, with four ground-floor exits', () => {
  assert.deepEqual(
    levels.map((level) => level.id),
    ['G', 'L1', 'L2'],
  );
  assert.equal(scene.stairwells.length, 3);
  for (const stair of scene.stairwells) {
    assert.deepEqual(linkLevels(normaliseStairwell(stair, levels), levels), ['G', 'L1', 'L2']);
  }
  assert.equal(scene.exits.length, 4);
  assert.ok(scene.exits.every((exit) => exit.level === 'G' && exit.status === 'open'));
});

test('every storey has its own walls in several materials', () => {
  for (const level of levels) {
    const walls = scene.interiorWalls.filter((wall) => wall.level === level.id);
    assert.equal(walls.length, 16, level.id);
    const materials = new Set(walls.map((wall) => wall.material));
    for (const m of ['drywall', 'concrete', 'glass', 'brick']) assert.ok(materials.has(m), m);
  }
  const timber = scene.interiorWalls.filter((wall) => wall.material.includes('timber'));
  assert.ok(timber.length >= 2);
});

test('studs sit on 3 m cell centres, so every wall falls between them', () => {
  for (const stud of fireStuds()) {
    if (stud.spatialContext !== 'inside_building') continue;
    const plan = officeTowerToPlan(stud.simPos, 'editor');
    assert.ok(
      Math.abs(((plan.x - 1.5) / 3) % 1) < 1e-3 || Math.abs(((plan.x - 1.5) / 3) % 1) > 1 - 1e-3,
    );
    assert.ok(
      Math.abs(((plan.y - 1.5) / 3) % 1) < 1e-3 || Math.abs(((plan.y - 1.5) / 3) % 1) > 1 - 1e-3,
    );
  }
});

test('each storey has furnished and empty rooms, and the ignition reaches no room but S1', () => {
  const studs = fireStuds();
  const objects = officeTowerFuelObjects(studs);
  for (const level of levels) {
    const rooms = new Set(
      objects
        .filter((obj) => obj.level === level.id)
        .map((obj) => officeTowerRoomAt(officeTowerToPlan(obj.pos, 'editor'))?.id),
    );
    assert.ok(rooms.size >= 3 && rooms.size <= 4, `${level.id}: ${[...rooms]}`);
  }
  const fuelInS1 = objects.filter(
    (obj) =>
      obj.level === 'G' && officeTowerRoomAt(officeTowerToPlan(obj.pos, 'editor'))?.id === 'S1',
  );
  assert.ok(fuelInS1.length > 0);
  const p = OFFICE_TOWER_IGNITION_PLAN;
  const r = OFFICE_TOWER_IGNITION_RADIUS_M;
  assert.ok(p.x + r < 12 && p.y + r < 12, 'the ignition reaches no other room');
  assert.equal(scene.blastSite.level, 'G');
});
