import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSessionTeamName } from './sessionTeamName.js';

describe('session team names', () => {
  test('leading and trailing whitespace is removed and interior spaces stay', () => {
    assert.equal(normalizeSessionTeamName('  Communications  '), 'Communications');
    assert.equal(normalizeSessionTeamName('Legal — DBS'), 'Legal — DBS');
    assert.equal(normalizeSessionTeamName('   '), '');
  });
});
