import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  crisisElapsedFractionalMinutes,
  crisisElapsedMinutes,
  crisisElapsedRoundedMinutes,
  isCrisisPhase,
  isOnOrAfterCrisis,
  resolvePeaceSeconds,
  sessionPhase,
  sessionValidAt,
  silenceActivityMinute,
  startClaimFields,
} from './sessionPhase.js';

const T0 = Date.parse('2026-06-01T12:00:00.000Z');

describe('session phase', () => {
  test('null start is not started, a future start is peace, a past start is crisis', () => {
    assert.equal(sessionPhase({ start_time: null }, T0), 'not_started');
    assert.equal(sessionPhase({ start_time: 'not-a-date' }, T0), 'not_started');
    assert.equal(
      sessionPhase({ start_time: new Date(T0 + 60_000).toISOString() }, T0),
      'peace',
    );
    assert.equal(sessionPhase({ start_time: new Date(T0).toISOString() }, T0), 'crisis');
    assert.equal(
      sessionPhase({ start_time: new Date(T0 - 1).toISOString() }, T0),
      'crisis',
    );
    assert.equal(isCrisisPhase({ start_time: null }, T0), false);
    assert.equal(isCrisisPhase({ start_time: new Date(T0 + 1).toISOString() }, T0), false);
    assert.equal(isCrisisPhase({ start_time: new Date(T0).toISOString() }, T0), true);
  });

  test('sessionValidAt prefers opened_at, then start_time, then now', () => {
    const now = new Date('2026-06-01T12:00:00.000Z');
    assert.equal(
      sessionValidAt({ start_time: '2026-06-01T12:05:00.000Z', opened_at: '2026-06-01T12:00:00.000Z' }, now),
      '2026-06-01T12:00:00.000Z',
    );
    assert.equal(
      sessionValidAt({ start_time: '2026-06-01T12:05:00.000Z', opened_at: null }, now),
      '2026-06-01T12:05:00.000Z',
    );
    assert.equal(sessionValidAt({ start_time: null, opened_at: null }, now), now.toISOString());
    assert.equal(sessionValidAt({ start_time: null }, now), now.toISOString());
  });
});

describe('crisis elapsed helpers match the old formulas for every non-negative elapsed', () => {
  const elapsedMs = [
    0, 1, 999, 59_999, 60_000, 60_001, 89_999, 90_000, 90_001, 119_999, 120_000,
    5 * 60_000, 15 * 60_000 + 30_000, 59 * 60_000 + 30_000, 24 * 60 * 60_000,
  ];

  test('floor helper equals Math.floor for non-negative values and the old clamp for negatives', () => {
    const start = T0;
    for (const ms of elapsedMs) {
      const now = start + ms;
      const floor = Math.floor((now - start) / 60000);
      const clamped = Math.max(0, floor);
      assert.equal(crisisElapsedMinutes(new Date(start).toISOString(), now), floor);
      assert.equal(crisisElapsedMinutes(new Date(start).toISOString(), now), clamped);
      assert.equal(crisisElapsedMinutes(start, now), floor);
    }
    const ahead = start + 5 * 60_000;
    const negativeFloor = Math.floor((start - ahead) / 60000);
    assert.ok(negativeFloor < 0);
    assert.equal(crisisElapsedMinutes(new Date(ahead).toISOString(), start), 0);
    assert.equal(crisisElapsedMinutes(null, start), 0);
    assert.equal(crisisElapsedMinutes('nope', start), 0);
    assert.equal(crisisElapsedMinutes(new Date(start).toISOString(), Number.NaN), 0);
  });

  test('rounded helper equals Math.round for non-negative values, including the half-minute boundary', () => {
    const start = T0;
    for (const ms of elapsedMs) {
      const now = start + ms;
      const rounded = Math.round((now - start) / 60000);
      assert.equal(crisisElapsedRoundedMinutes(new Date(start).toISOString(), now), rounded);
      assert.equal(crisisElapsedRoundedMinutes(new Date(start).toISOString(), now), Math.max(0, rounded));
    }
    assert.equal(crisisElapsedRoundedMinutes(new Date(start).toISOString(), start + 90_000), 2);
    assert.equal(crisisElapsedMinutes(new Date(start).toISOString(), start + 90_000), 1);
    assert.equal(crisisElapsedRoundedMinutes(null), 0);
  });

  test('fractional helper equals the raw division for every non-negative elapsed value', () => {
    const start = T0;
    for (const ms of elapsedMs) {
      const now = start + ms;
      const raw = (now - start) / 60000;
      assert.equal(crisisElapsedFractionalMinutes(new Date(start).toISOString(), now), raw);
      assert.equal(
        crisisElapsedFractionalMinutes(new Date(start).toISOString(), now),
        Math.max(0, raw),
      );
    }
    assert.equal(crisisElapsedFractionalMinutes(null, start), null);
    assert.equal(crisisElapsedFractionalMinutes('nope', start), null);
    assert.equal(crisisElapsedFractionalMinutes(new Date(start + 30_000).toISOString(), start), 0);
  });
});

describe('resolvePeaceSeconds', () => {
  const feed = { peace_period: { seconds: 300, posts: [{ ref: 'P1' }] } };

  test('flag off, a non-social session, and a scenario with no feed all stay at 0', () => {
    assert.equal(
      resolvePeaceSeconds({
        requested: 300,
        initialState: feed,
        social: true,
        enabled: false,
        defaultSeconds: 300,
        maxSeconds: 900,
      }),
      0,
    );
    assert.equal(
      resolvePeaceSeconds({
        requested: 300,
        initialState: feed,
        social: false,
        enabled: true,
        defaultSeconds: 300,
        maxSeconds: 900,
      }),
      0,
    );
    assert.equal(
      resolvePeaceSeconds({
        requested: 300,
        initialState: { peace_period: { posts: [] } },
        social: true,
        enabled: true,
        defaultSeconds: 300,
        maxSeconds: 900,
      }),
      0,
    );
    assert.equal(
      resolvePeaceSeconds({
        requested: undefined,
        initialState: {},
        social: true,
        enabled: true,
        defaultSeconds: 300,
        maxSeconds: 900,
      }),
      0,
    );
  });

  test('uses the request, then the scenario, then the default, and clamps', () => {
    assert.equal(
      resolvePeaceSeconds({
        requested: 120,
        initialState: feed,
        social: true,
        enabled: true,
        defaultSeconds: 300,
        maxSeconds: 900,
      }),
      120,
    );
    assert.equal(
      resolvePeaceSeconds({
        requested: undefined,
        initialState: feed,
        social: true,
        enabled: true,
        defaultSeconds: 300,
        maxSeconds: 900,
      }),
      300,
    );
    assert.equal(
      resolvePeaceSeconds({
        requested: undefined,
        initialState: { peace_period: { posts: [{ ref: 'P1' }] } },
        social: true,
        enabled: true,
        defaultSeconds: 300,
        maxSeconds: 900,
      }),
      300,
    );
    assert.equal(
      resolvePeaceSeconds({
        requested: 5000,
        initialState: feed,
        social: true,
        enabled: true,
        defaultSeconds: 300,
        maxSeconds: 900,
      }),
      900,
    );
    assert.equal(
      resolvePeaceSeconds({
        requested: -4,
        initialState: feed,
        social: true,
        enabled: true,
        defaultSeconds: 300,
        maxSeconds: 900,
      }),
      0,
    );
    assert.equal(
      resolvePeaceSeconds({
        requested: 4000,
        initialState: feed,
        social: true,
        enabled: true,
        defaultSeconds: 300,
        maxSeconds: 10_000,
      }),
      3600,
    );
  });

  test('a zero-length peace writes only start_time; a real peace shifts it', () => {
    const now = new Date('2026-06-01T12:00:00.000Z');
    assert.deepEqual(startClaimFields({ now, peaceSeconds: 0 }), {
      start_time: '2026-06-01T12:00:00.000Z',
    });
    assert.deepEqual(startClaimFields({ now, peaceSeconds: 300 }), {
      opened_at: '2026-06-01T12:00:00.000Z',
      peace_seconds: 300,
      start_time: '2026-06-01T12:05:00.000Z',
    });
  });
});

describe('silence activity and crisis rows', () => {
  test('activity before crisis start does not become a positive minute', () => {
    const start = '2026-06-01T12:05:00.000Z';
    const duringPeace = '2026-06-01T12:04:00.000Z';
    assert.equal(silenceActivityMinute(start, duringPeace), null);
    assert.equal(silenceActivityMinute(start, '2026-06-01T12:05:00.000Z'), 0);
    assert.equal(silenceActivityMinute(start, '2026-06-01T12:13:00.000Z'), 8);
    assert.equal(silenceActivityMinute(null, duringPeace), 0);
    assert.equal(isOnOrAfterCrisis(duringPeace, start), false);
    assert.equal(isOnOrAfterCrisis(start, start), true);
    assert.equal(isOnOrAfterCrisis(null, start), true);
  });
});
