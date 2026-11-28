import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { env } from '../env.js';
import { activityMinute, countsOnCrisisClock, rosterValidAt, skipForPeace } from './peaceGate.js';

const original = env.enablePeacePeriod;

afterEach(() => {
  env.enablePeacePeriod = original;
});

describe('peace gate with the flag off', () => {
  test('skipForPeace is false even when start_time is ahead', () => {
    env.enablePeacePeriod = false;
    assert.equal(skipForPeace({ start_time: new Date(Date.now() + 60_000).toISOString() }), false);
  });

  test('countsOnCrisisClock keeps a row from before start', () => {
    env.enablePeacePeriod = false;
    assert.equal(countsOnCrisisClock('2020-01-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z'), true);
  });

  test('rosterValidAt is start_time, or a Date when the session has not started', () => {
    env.enablePeacePeriod = false;
    assert.equal(
      rosterValidAt({
        start_time: '2026-06-01T12:00:00.000Z',
        opened_at: '2026-06-01T11:00:00.000Z',
      }),
      '2026-06-01T12:00:00.000Z',
    );
    assert.ok(rosterValidAt({ start_time: null }) instanceof Date);
  });

  test('activityMinute stays on sessionMinuteAt, including a pre-start timestamp', () => {
    env.enablePeacePeriod = false;
    assert.equal(activityMinute('2026-06-01T12:05:00.000Z', '2026-06-01T12:04:00.000Z'), 0);
  });
});

describe('peace gate with the flag on', () => {
  test('a future start is skipped and a pre-start action is dropped', () => {
    env.enablePeacePeriod = true;
    const start = new Date(Date.now() + 60_000).toISOString();
    assert.equal(skipForPeace({ start_time: start }), true);
    assert.equal(skipForPeace({ start_time: new Date(Date.now() - 60_000).toISOString() }), false);
    assert.equal(
      countsOnCrisisClock('2026-06-01T12:00:00.000Z', '2026-06-01T12:05:00.000Z'),
      false,
    );
    assert.equal(activityMinute('2026-06-01T12:05:00.000Z', '2026-06-01T12:04:00.000Z'), null);
    assert.equal(
      rosterValidAt({
        start_time: '2026-06-01T12:05:00.000Z',
        opened_at: '2026-06-01T12:00:00.000Z',
      }),
      '2026-06-01T12:00:00.000Z',
    );
  });
});
