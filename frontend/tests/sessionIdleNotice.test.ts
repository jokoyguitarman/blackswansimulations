import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  idleNoticeCopy,
  idleNoticeReducer,
  type IdleNoticeState,
} from '../src/components/Session/sessionIdleNoticeModel';

const formatTime = (iso: string) => iso.slice(11, 16);

const settings = {
  idleEndMinutes: 30,
  idleWarnMinutes: 5,
  maxHours: 12,
  formatTime,
};

test('idle notice follows warning, clear, warning, then end', () => {
  let state: IdleNoticeState = { kind: 'hidden' };
  state = idleNoticeReducer(state, {
    type: 'session.idle_warning',
    data: { reason: 'idle', ends_at: '2026-11-04T10:50:00.000Z' },
  });
  assert.deepEqual(state, {
    kind: 'warning',
    reason: 'idle',
    endsAt: '2026-11-04T10:50:00.000Z',
  });

  state = idleNoticeReducer(state, { type: 'session.idle_cleared', data: { session_id: 's1' } });
  assert.deepEqual(state, { kind: 'hidden' });

  state = idleNoticeReducer(state, {
    type: 'session.idle_warning',
    data: { reason: 'max_duration', ends_at: '2026-11-04T22:00:00.000Z' },
  });
  assert.deepEqual(state, {
    kind: 'warning',
    reason: 'max_duration',
    endsAt: '2026-11-04T22:00:00.000Z',
  });

  const twelveHourWarning = state;
  state = idleNoticeReducer(state, { type: 'session.idle_cleared', data: { session_id: 's1' } });
  assert.deepEqual(state, twelveHourWarning);

  state = idleNoticeReducer(state, {
    type: 'session.auto_ended',
    data: { reason: 'idle' },
  });
  assert.deepEqual(state, { kind: 'ended', reason: 'idle' });

  const ended = state;
  state = idleNoticeReducer(state, { type: 'session.idle_cleared', data: { session_id: 's1' } });
  assert.deepEqual(state, ended);
});

test('idle notice copy', () => {
  assert.equal(idleNoticeCopy({ kind: 'hidden' }, { ...settings, role: 'player' }), null);

  assert.deepEqual(
    idleNoticeCopy(
      { kind: 'warning', reason: 'idle', endsAt: '2026-11-04T10:50:00.000Z' },
      { ...settings, role: 'player' },
    ),
    {
      text: 'No player activity for 25 minutes. This session ends automatically at 10:50 unless someone acts.',
      action: 'still_here',
    },
  );
  assert.deepEqual(
    idleNoticeCopy(
      { kind: 'warning', reason: 'max_duration', endsAt: '2026-11-04T22:00:00.000Z' },
      { ...settings, role: 'trainer' },
    ),
    {
      text: 'This session reaches its 12-hour limit at 22:00 and will end then.',
      action: null,
    },
  );

  const endedIdle = { kind: 'ended' as const, reason: 'idle' as const };
  assert.deepEqual(idleNoticeCopy(endedIdle, { ...settings, role: 'trainer' }), {
    text: 'This session has ended: no player activity for 30 minutes.',
    action: 'open_aar',
  });
  assert.deepEqual(idleNoticeCopy(endedIdle, { ...settings, role: 'player' }), {
    text: 'This session has ended: no player activity for 30 minutes.',
    action: null,
  });

  const endedLimit = { kind: 'ended' as const, reason: 'max_duration' as const };
  assert.deepEqual(idleNoticeCopy(endedLimit, { ...settings, role: 'trainer' }), {
    text: 'This session has ended: it reached its 12-hour limit.',
    action: 'open_aar',
  });
  assert.deepEqual(idleNoticeCopy(endedLimit, { ...settings, role: 'player' }), {
    text: 'This session has ended: it reached its 12-hour limit.',
    action: null,
  });
});
