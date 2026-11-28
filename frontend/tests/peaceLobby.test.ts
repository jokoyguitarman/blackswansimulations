import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { PEACE_PERIOD_DEFAULT_SECONDS, PEACE_PERIOD_MAX_SECONDS } from '../../shared/peaceFeed.ts';
import { lobbyPeaceMinutes, lobbyPeaceSeconds, lobbyPeaceVisible } from '../src/lib/peaceLobby.ts';
import { peaceCountdownLabel } from '../src/lib/peaceCountdown.ts';
import { crisisBriefLocked, showCrisisBriefSection } from '../src/lib/briefingLock.ts';

const feed = { seconds: 300, enabled: true, posts: [{ ref: 'P1' }] };

describe('lobby peace control', () => {
  test('flag off (404), a non-social session, and a disabled feed show nothing', () => {
    assert.equal(lobbyPeaceVisible({ social: true, trainer: true, probeStatus: 404, feed }), false);
    assert.equal(lobbyPeaceVisible({ social: true, trainer: true, probeStatus: null, feed }), false);
    assert.equal(lobbyPeaceVisible({ social: false, trainer: true, probeStatus: 200, feed }), false);
    assert.equal(lobbyPeaceVisible({ social: true, trainer: false, probeStatus: 200, feed }), false);
    assert.equal(
      lobbyPeaceVisible({ social: true, trainer: true, probeStatus: 200, feed: { ...feed, enabled: false } }),
      false,
    );
    assert.equal(
      lobbyPeaceVisible({ social: true, trainer: true, probeStatus: 200, feed: { posts: [] } }),
      false,
    );
  });

  test('a social trainer with a feed gets minutes, and off sends zero seconds', () => {
    assert.equal(lobbyPeaceVisible({ social: true, trainer: true, probeStatus: 200, feed }), true);
    assert.equal(lobbyPeaceMinutes(feed), 5);
    assert.equal(lobbyPeaceMinutes(null), PEACE_PERIOD_DEFAULT_SECONDS / 60);
    assert.equal(lobbyPeaceSeconds({ shown: false, enabled: true, minutes: 5 }), undefined);
    assert.equal(lobbyPeaceSeconds({ shown: true, enabled: false, minutes: 5 }), 0);
    assert.equal(lobbyPeaceSeconds({ shown: true, enabled: true, minutes: 5 }), 300);
    assert.equal(
      lobbyPeaceSeconds({ shown: true, enabled: true, minutes: 100 }),
      PEACE_PERIOD_MAX_SECONDS,
    );
  });
});

describe('trainer countdown and brief lock', () => {
  const now = Date.parse('2026-06-01T12:00:00.000Z');
  const ahead = '2026-06-01T12:03:12.000Z';

  test('players have no countdown chip text, and the trainer does until crisis start', () => {
    assert.equal(peaceCountdownLabel({ start_time: ahead }, now), null);
    assert.equal(peaceCountdownLabel({ crisis_starts_at: ahead }, now), 'Peace · 3:12 to crisis');
    assert.equal(peaceCountdownLabel({ crisis_starts_at: '2026-06-01T11:00:00.000Z' }, now), null);
    assert.equal(peaceCountdownLabel(null, now), null);
  });

  test('the crisis section exists only when the peace clock was sent, and locks until then', () => {
    assert.equal(showCrisisBriefSection({ start_time: ahead }), false);
    assert.equal(crisisBriefLocked({ start_time: ahead }, now), false);
    assert.equal(showCrisisBriefSection({ crisis_starts_at: ahead }), true);
    assert.equal(crisisBriefLocked({ crisis_starts_at: ahead }, now), true);
    assert.equal(crisisBriefLocked({ crisis_starts_at: '2026-06-01T11:59:00.000Z' }, now), false);
  });
});
