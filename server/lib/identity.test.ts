import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { displayNameOf, firstNameOf, handleFor } from './identity.js';

describe('displayNameOf (spec §10.1: user_profiles first, auth metadata last)', () => {
  test('prefers the profile display name over stale auth metadata', () => {
    assert.equal(
      displayNameOf({
        id: 'u1',
        email: 'katigayunanfoodcorp@gmail.com',
        displayName: 'Sandwichman',
        metadata: { full_name: 'Participant, 1' },
      }),
      'Sandwichman',
    );
  });

  test('falls back to auth metadata, then the email local part, then Player', () => {
    assert.equal(
      displayNameOf({ id: 'u1', email: 'a@b.c', metadata: { full_name: ' Kenneth ' } }),
      'Kenneth',
    );
    assert.equal(displayNameOf({ id: 'u1', email: 'devi.krishnan@x.sim' }), 'devi.krishnan');
    assert.equal(displayNameOf({ id: 'u1' }), 'Player');
    assert.equal(displayNameOf({ id: 'u1', displayName: '   ' }), 'Player');
  });
});

describe('handleFor (legacy derivation preserved so stored handles keep matching)', () => {
  test('matches the historical algorithm exactly', () => {
    assert.equal(handleFor('Participant, 1'), '@participant__1');
    assert.equal(handleFor('Kenneth X. Yeo'), '@kenneth_x__yeo');
    assert.equal(handleFor('Sandwichman'), '@sandwichman');
  });
  test('strips PostgREST-structural characters', () => {
    assert.equal(handleFor('O"Brien\\x'), '@o_brien_x');
  });
});

describe('firstNameOf', () => {
  test('handles "Last, First M." and plain names', () => {
    assert.equal(firstNameOf('Yeo, Kenneth X.'), 'Kenneth');
    assert.equal(firstNameOf('Mei Ling Wong'), 'Mei');
    assert.equal(firstNameOf('Sandwichman'), 'Sandwichman');
  });
});
