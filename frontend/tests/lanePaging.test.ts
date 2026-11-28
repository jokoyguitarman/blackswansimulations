import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LANE_PAGE_SIZE,
  locateField,
  pageForField,
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
});
