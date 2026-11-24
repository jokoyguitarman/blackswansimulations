import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { effectiveLevelPlan } from '../src/lib/rts/levels.ts';
import {
  floorCount,
  footprintSessionNote,
  levelsForFootprint,
  type OsmBuildingFootprint,
} from '../src/lib/rts/footprintLevels.ts';
import type { InteriorWall } from '../src/lib/rts/types.ts';

function wall(level: string): InteriorWall {
  return {
    id: `wall-${level}`,
    start: { x: 0, y: 0 },
    end: { x: 4, y: 0 },
    hasDoor: false,
    doorWidth: 0.9,
    doorPosition: 0.5,
    description: 'stall',
    material: 'concrete',
    photos: [],
    level,
  };
}

describe('footprint storeys', () => {
  test('a missing count is one ground floor, and a fraction is floored', () => {
    assert.equal(floorCount(null), 1);
    assert.equal(floorCount(0.4), 1);
    assert.equal(floorCount(3.5), 3);
    const ground = levelsForFootprint({ aboveGround: null, underground: null });
    assert.deepEqual(
      ground.map((level) => level.id),
      ['G'],
    );
    assert.equal(ground[0].designed, true);

    const three = levelsForFootprint({ aboveGround: 3.5, underground: 1 });
    assert.deepEqual(
      three.map((level) => [level.id, level.designed]),
      [
        ['B1', false],
        ['G', true],
        ['L1', false],
        ['L2', false],
      ],
    );
  });

  test('an upper floor with no plan copies the floor below and is marked assumed', () => {
    const levels = levelsForFootprint({
      aboveGround: 3,
      underground: null,
      plannedFloorIds: ['L1'],
    });
    assert.equal(levels.find((level) => level.id === 'L1')?.designed, true);
    assert.equal(levels.find((level) => level.id === 'L2')?.designed, false);

    const walls = [wall('G'), wall('L1')];
    const copied = effectiveLevelPlan('L2', levels, { walls, exits: [] });
    assert.equal(copied.assumedFrom, 'L1');
    assert.equal(copied.walls.length, 1);
    assert.equal(copied.walls[0].level, 'L2');
    assert.equal(copied.walls[0].description, 'stall');
  });

  test('more than twelve storeys are cut down to the cap', () => {
    const levels = levelsForFootprint({ aboveGround: 20, underground: 4 });
    assert.equal(levels.length, 12);
    assert.equal(levels[0].id, 'B4');
    assert.equal(levels[levels.length - 1].id, 'L7');
  });

  test('the session note says where the outline came from and that it is not saved', () => {
    const live: OsmBuildingFootprint = {
      osmId: 'way/152752628',
      name: 'Holland Village Market and Food Centre',
      buildingType: 'commercial',
      levels: null,
      underground: null,
      heightM: 9,
      polygon: [
        [1, 103],
        [1.1, 103],
        [1.1, 103.1],
      ],
      source: 'live_osm',
    };
    const note = footprintSessionNote(live);
    assert.match(note, /way\/152752628/);
    assert.match(note, /live OpenStreetMap/);
    assert.match(note, /ground floor only/);
    assert.match(note, /Tagged height 9 m/);
    assert.match(note, /not saved/);

    const saved = footprintSessionNote({ ...live, source: 'saved', levels: 3, heightM: null });
    assert.match(saved, /saved map data/);
    assert.match(saved, /marked assumed/);
  });
});
