import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { displayNameOf, handleFor } from './identity.js';
import { mergeViewerSubject, viewedByLabels } from './viewerSubject.js';

describe('view-as subject identity', () => {
  test('an empty profile name uses auth metadata, then the email, the way a signed-in player does', () => {
    const fromMetadata = mergeViewerSubject(
      'player-1',
      {
        email: 'ken.yeo@example.com',
        app_metadata: { role: 'participant' },
        user_metadata: { full_name: 'Grace Hopper' },
      },
      { role: 'player', full_name: '   ' },
    );
    assert.equal(fromMetadata.role, 'participant');
    assert.equal(fromMetadata.displayName, 'Grace Hopper');
    assert.equal(handleFor(displayNameOf(fromMetadata)), '@grace_hopper');

    const fromEmail = mergeViewerSubject(
      'player-1',
      {
        email: 'ken.yeo@example.com',
        app_metadata: { role: 'participant', agency: 'Ops' },
        user_metadata: {},
      },
      { role: 'player', agency_name: 'Other', full_name: '' },
    );
    assert.equal(fromEmail.email, 'ken.yeo@example.com');
    assert.equal(fromEmail.agency, 'Ops');
    assert.equal(displayNameOf(fromEmail), 'ken.yeo');
    assert.equal(handleFor(displayNameOf(fromEmail)), '@ken_yeo');
    assert.notEqual(handleFor(displayNameOf(fromEmail)), '@player');
  });

  test('a profile name still wins over metadata and email', () => {
    const subject = mergeViewerSubject(
      'player-1',
      { email: 'ken.yeo@example.com', user_metadata: { full_name: 'Grace Hopper' } },
      { full_name: 'Ada Lovelace' },
    );
    assert.equal(displayNameOf(subject), 'Ada Lovelace');
    assert.equal(handleFor(displayNameOf(subject)), '@ada_lovelace');
  });

  test('viewed-by labels keep the latest visit per staff member', () => {
    const labels = viewedByLabels(
      [
        { staffUserId: 'a', lastAt: '2026-01-01T00:00:00Z' },
        { staffUserId: 'b', lastAt: '2026-01-02T00:00:00Z' },
        { staffUserId: 'a', lastAt: '2026-01-03T00:00:00Z' },
      ],
      new Map([
        ['a', 'Ada'],
        ['b', 'Bea'],
      ]),
    );
    assert.deepEqual(labels, ['Ada', 'Bea']);
  });
});
