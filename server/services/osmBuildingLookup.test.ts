import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  footprintFromOsmApi,
  footprintFromSavedRow,
  lookupOsmBuilding,
  openRing,
  parseOsmObjectId,
  type SavedBuildingRow,
} from './osmBuildingLookup.js';

const HOLLAND = {
  elements: [
    { type: 'node', id: 1655352813, lat: 1.3109098, lon: 103.794894 },
    { type: 'node', id: 1655352708, lat: 1.3108498, lon: 103.7947684 },
    { type: 'node', id: 7164297380, lat: 1.3109805, lon: 103.7947079 },
    { type: 'node', id: 1655352795, lat: 1.3111669, lon: 103.7946216 },
    { type: 'node', id: 7164317585, lat: 1.3111884, lon: 103.7946664 },
    { type: 'node', id: 1655352782, lat: 1.3112402, lon: 103.7947744 },
    { type: 'node', id: 4368147070, lat: 1.3112871, lon: 103.7948339 },
    { type: 'node', id: 1655352830, lat: 1.3113087, lon: 103.7949064 },
    { type: 'node', id: 1655352827, lat: 1.3113019, lon: 103.7949818 },
    { type: 'node', id: 1655352765, lat: 1.3112678, lon: 103.7950494 },
    { type: 'node', id: 4368147069, lat: 1.3112112, lon: 103.7950996 },
    { type: 'node', id: 1655352815, lat: 1.31114, lon: 103.7951254 },
    { type: 'node', id: 1655352748, lat: 1.3110644, lon: 103.795123 },
    { type: 'node', id: 1655352735, lat: 1.3109949, lon: 103.7950929 },
    { type: 'node', id: 1655352727, lat: 1.3109416, lon: 103.7950392 },
    { type: 'node', id: 1655352709, lat: 1.3109118, lon: 103.7949696 },
    {
      type: 'way',
      id: 152752628,
      nodes: [
        1655352813, 1655352708, 7164297380, 1655352795, 7164317585, 1655352782, 4368147070,
        1655352830, 1655352827, 1655352765, 4368147069, 1655352815, 1655352748, 1655352735,
        1655352727, 1655352709, 1655352813,
      ],
      tags: {
        name: 'Holland Village Market and Food Centre',
        building: 'commercial',
        height: '9',
        'addr:street': 'Lorong Mambong',
      },
    },
  ],
};

describe('osm building lookup', () => {
  test('parses a way id and rejects anything else', () => {
    assert.deepEqual(parseOsmObjectId('way/152752628'), { kind: 'way', id: 152752628 });
    assert.deepEqual(parseOsmObjectId('relation/21400876'), { kind: 'relation', id: 21400876 });
    assert.equal(parseOsmObjectId('node/1'), null);
    assert.equal(parseOsmObjectId('way/'), null);
  });

  test('drops the repeated closing corner', () => {
    assert.deepEqual(
      openRing([
        [1, 2],
        [3, 4],
        [5, 6],
        [1, 2],
      ]),
      [
        [1, 2],
        [3, 4],
        [5, 6],
      ],
    );
  });

  test('reads the live Holland Village way, without inventing a storey count', () => {
    const footprint = footprintFromOsmApi(HOLLAND, 'way/152752628');
    assert.ok(footprint);
    assert.equal(footprint.name, 'Holland Village Market and Food Centre');
    assert.equal(footprint.buildingType, 'commercial');
    assert.equal(footprint.levels, null);
    assert.equal(footprint.heightM, 9);
    assert.equal(footprint.polygon.length, 16);
    assert.equal(footprint.source, 'live_osm');
    assert.equal(footprint.polygon[0][0], 1.3109098);
  });

  test('a saved row wins, and a failed saved read falls through without writing', async () => {
    const row: SavedBuildingRow = {
      osm_id: 'way/152752628',
      name: 'Holland Village Market and Food Centre',
      building_type: 'commercial',
      building_levels: 3.5,
      building_levels_underground: null,
      height_m: 9,
      footprint_polygon_json: [
        [1.31, 103.79],
        [1.32, 103.79],
        [1.32, 103.8],
        [1.31, 103.79],
      ],
    };
    let liveCalls = 0;
    const fromSaved = await lookupOsmBuilding('way/152752628', {
      readSaved: async () => row,
      readLive: async () => {
        liveCalls += 1;
        return HOLLAND;
      },
    });
    assert.equal(liveCalls, 0);
    assert.equal(fromSaved?.source, 'saved');
    assert.equal(fromSaved?.levels, 3.5);
    assert.equal(fromSaved?.polygon.length, 3);

    const fromLive = await lookupOsmBuilding('way/152752628', {
      readSaved: async () => {
        throw new Error('database refused the select');
      },
      readLive: async () => HOLLAND,
    });
    assert.equal(fromLive?.source, 'live_osm');
    assert.equal(fromLive?.polygon.length, 16);
  });

  test('an unusable saved ring falls through to the live way', async () => {
    const footprint = await lookupOsmBuilding('way/152752628', {
      readSaved: async () => ({
        osm_id: 'way/152752628',
        name: 'Holland Village',
        building_type: 'yes',
        building_levels: null,
        building_levels_underground: null,
        height_m: null,
        footprint_polygon_json: [[1, 2]],
      }),
      readLive: async () => HOLLAND,
    });
    assert.equal(footprint?.source, 'live_osm');
    assert.equal(
      footprintFromSavedRow({
        osm_id: 'way/1',
        name: null,
        building_type: 'yes',
        building_levels: null,
        building_levels_underground: null,
        height_m: null,
        footprint_polygon_json: [],
      }),
      null,
    );
  });

  test('a bad id is rejected before either reader runs', async () => {
    let calls = 0;
    await assert.rejects(
      lookupOsmBuilding('holland', {
        readSaved: async () => {
          calls += 1;
          return null;
        },
        readLive: async () => {
          calls += 1;
          return null;
        },
      }),
      /way\/123/,
    );
    assert.equal(calls, 0);
  });
});
