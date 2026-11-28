import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LANE_PAGE_SIZE,
  ROSTER_COLLAPSE_AT,
  laneSearchVisible,
  laneVisibleIds,
  locateField,
  pageForField,
  rosterExpandOnGrow,
  type LaneCardRef,
} from '../src/components/Scenario/lanePaging';

function cards(prefix: string, count: number, teams = 2): LaneCardRef[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}_${index}`,
    fieldPrefixes:
      prefix === 'org'
        ? [`org:${prefix}_${index}`, `team:${prefix}_${index}`]
        : [`${prefix}:${prefix}_${index}`],
    search: `${prefix} ${index}`,
    teamCount: teams,
  }));
}

describe('lane paging', () => {
  test('issue fields map to the page that holds the card', () => {
    const orgs = cards('org', 30, 9);
    assert.equal(LANE_PAGE_SIZE, 12);
    assert.equal(pageForField('org:org_0:name', orgs), 0);
    assert.equal(pageForField('team:org_11:2:description', orgs), 0);
    assert.equal(pageForField('team:org_12:0:name', orgs), 1);
    assert.equal(pageForField('org:org_24:roster', orgs), 2);
    assert.equal(pageForField('brief', orgs), null);

    const place = locateField('team:org_13:1:name', {
      orgs,
      pressure: cards('pressure', 3),
      rivals: cards('rival', 3),
    });
    assert.deepEqual(place, { lane: 'orgs', page: 1, rosterId: 'org_13' });

    const shortRoster = locateField('team:org_1:0:name', {
      orgs: cards('org', 4, 2),
      pressure: [],
      rivals: [],
    });
    assert.equal(shortRoster?.rosterId, null);
    assert.equal(shortRoster?.page, 0);

    const pressure = locateField('pressure:pressure_14:wants', {
      orgs: [],
      pressure: cards('pressure', 20),
      rivals: [],
    });
    assert.deepEqual(pressure, { lane: 'pressure', page: 1, rosterId: null });

    const rival = locateField('rival:rival_0:description', {
      orgs: [],
      pressure: [],
      rivals: cards('rival', 1),
    });
    assert.deepEqual(rival, { lane: 'rivals', page: 0, rosterId: null });
  });

  test('adding the team that crosses the collapse line keeps the roster open', () => {
    assert.equal(ROSTER_COLLAPSE_AT, 8);
    assert.equal(rosterExpandOnGrow(8, 9, true), true);
    assert.equal(rosterExpandOnGrow(4, 12, true), true);
    assert.equal(rosterExpandOnGrow(8, 9, false), false);
    assert.equal(rosterExpandOnGrow(7, 8, true), false);
    assert.equal(rosterExpandOnGrow(9, 10, true), false);
    assert.equal(rosterExpandOnGrow(10, 8, true), false);
  });

  test('a search stays available while it is filtering a lane of 12 or fewer', () => {
    assert.equal(laneSearchVisible(13, ''), true);
    assert.equal(laneSearchVisible(12, ''), false);
    assert.equal(laneSearchVisible(12, '   '), false);
    assert.equal(laneSearchVisible(12, 'acme'), true);
    assert.equal(laneSearchVisible(1, 'acme'), true);

    const lane = cards('org', 14);
    lane[1].search = 'acme office';
    assert.deepEqual([...laneVisibleIds(lane, 'acme', 1)], ['org_1']);
    assert.equal(laneVisibleIds(lane, '', 1).size, LANE_PAGE_SIZE);
    assert.equal(laneVisibleIds(lane, '', 2).size, 14);
  });
});
