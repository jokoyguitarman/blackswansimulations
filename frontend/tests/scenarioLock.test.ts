import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { scenarioLockState } from '../src/lib/scenarioLock.ts';

const active = { is_active: true, summary: { live_session_id: null } };

describe('scenario library credit lock', () => {
  test('an admin with 0 session credits gets editable', () => {
    assert.equal(scenarioLockState(active, true, 0), 'editable');
  });

  test('a non-admin trainer with 0 session credits gets locked-credits', () => {
    assert.equal(scenarioLockState(active, false, 0), 'locked-credits');
  });

  test('a live session still locks an admin with 0 credits', () => {
    assert.equal(
      scenarioLockState({ is_active: true, summary: { live_session_id: 'sess-1' } }, true, 0),
      'locked-live',
    );
  });
});
