import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  applyClaim,
  exitGateState,
  isPinClaimableInSession,
  type ExitGatePin,
} from '../../../shared/fieldOps/exitGate.js';

const pin = (id: string, claimed: string | null, claimable: boolean | undefined): ExitGatePin => ({
  id,
  claimed_by_team: claimed,
  claimable_in_session: claimable,
});

describe('exit gate', () => {
  test('no pins open the gate', () => {
    assert.deepEqual(exitGateState([]), { open: true, claimed: 0, total: 0 });
  });

  test('no claimable pin opens the gate', () => {
    assert.deepEqual(exitGateState([pin('a', null, false), pin('b', 'Bomb Squad', false)]), {
      open: true,
      claimed: 0,
      total: 0,
    });
  });

  test('counts only claimable pins', () => {
    const unclaimed = pin('c', null, true);
    const closed = exitGateState([
      pin('a', 'Bomb Squad', true),
      pin('b', null, true),
      unclaimed,
      pin('d', null, false),
    ]);
    assert.deepEqual(closed, { open: false, claimed: 1, total: 3 });

    const open = exitGateState([
      pin('a', 'Bomb Squad', true),
      pin('b', 'Medical', true),
      pin('c', 'Police', true),
      pin('d', null, false),
    ]);
    assert.deepEqual(open, { open: true, claimed: 3, total: 3 });
  });

  test('who may claim a pin', () => {
    const teams = ['Bomb Squad', 'Medical'];
    assert.equal(isPinClaimableInSession(null, teams), true);
    assert.equal(isPinClaimableInSession(undefined, teams), true);
    assert.equal(isPinClaimableInSession([], teams), true);
    assert.equal(isPinClaimableInSession(['all'], teams), true);
    assert.equal(isPinClaimableInSession(['Bomb Squad'], teams), true);
    assert.equal(isPinClaimableInSession(['Police'], teams), false);
    assert.equal(isPinClaimableInSession(['all'], []), false);
    assert.equal(isPinClaimableInSession(['Bomb Squad'], []), false);
    assert.equal(isPinClaimableInSession(null, []), false);
  });

  test('a claim survives a rebuild', () => {
    const input = [
      { id: 'a', claimed_by_team: null, claimed_as: null, claim_exclusivity: null, label: 'North' },
      { id: 'b', claimed_by_team: null, claimed_as: null, claim_exclusivity: null, label: 'South' },
    ];
    const original = input.map((row) => ({ ...row }));
    const first = applyClaim(input, {
      location_id: 'a',
      claimed_by_team: 'Bomb Squad',
      claimed_as: 'entry',
      claim_exclusivity: 'exclusive',
    });
    const second = applyClaim(first, {
      location_id: 'b',
      claimed_by_team: 'Medical',
      claimed_as: 'exit',
      claim_exclusivity: null,
    });

    assert.deepEqual(input, original);
    assert.equal(first[0]?.claimed_by_team, 'Bomb Squad');
    assert.equal(first[1]?.claimed_by_team, null);
    assert.deepEqual(
      second.map((row) => ({
        id: row.id,
        claimed_by_team: row.claimed_by_team,
        claimed_as: row.claimed_as,
        claim_exclusivity: row.claim_exclusivity,
        label: row.label,
      })),
      [
        {
          id: 'a',
          claimed_by_team: 'Bomb Squad',
          claimed_as: 'entry',
          claim_exclusivity: 'exclusive',
          label: 'North',
        },
        {
          id: 'b',
          claimed_by_team: 'Medical',
          claimed_as: 'exit',
          claim_exclusivity: null,
          label: 'South',
        },
      ],
    );
  });
});
