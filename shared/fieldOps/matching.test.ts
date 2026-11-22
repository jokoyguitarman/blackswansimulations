import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normaliseTeamText } from './matching.js';

describe('normaliseTeamText', () => {
  it('matches AC1.40', () => {
    assert.equal(normaliseTeamText('Hazards / Fire / Rescue Team'), 'hazards fire rescue');
    assert.equal(normaliseTeamText('SCDF — Fire & Rescue'), 'scdf fire and rescue');
    assert.equal(normaliseTeamText('A&E'), 'a and e');
    assert.equal(normaliseTeamText('Cảnh sát PCCC'), 'canh sat pccc');
    assert.equal(normaliseTeamText('Canh sat PCCC'), 'canh sat pccc');
    assert.equal(normaliseTeamText('Ｆｉｒｅ'), 'fire');
    assert.equal(normaliseTeamText('Fire\u200bTeam'), 'fire');
  });
});
