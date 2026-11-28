import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { playerClockHidden, trainerClockStart } from '../src/lib/crisisClock.ts';

const NOW = Date.parse('2026-06-01T12:00:00.000Z');

describe('crisis clock', () => {
  test('without crisis_starts_at the trainer clock is started_at, then start_time', () => {
    assert.equal(playerClockHidden({ start_time: '2026-06-01T12:05:00.000Z' }, NOW), false);
    assert.equal(
      trainerClockStart({ started_at: '2026-06-01T11:00:00.000Z', start_time: '2026-06-01T12:00:00.000Z' }),
      '2026-06-01T11:00:00.000Z',
    );
    assert.equal(trainerClockStart({ start_time: '2026-06-01T12:00:00.000Z' }), '2026-06-01T12:00:00.000Z');
    assert.equal(trainerClockStart(null), null);
  });

  test('a future crisis_starts_at hides the player clock and becomes the trainer clock', () => {
    const ahead = '2026-06-01T12:05:00.000Z';
    assert.equal(playerClockHidden({ crisis_starts_at: ahead, start_time: ahead }, NOW), true);
    assert.equal(trainerClockStart({ crisis_starts_at: ahead, started_at: '2026-06-01T11:00:00.000Z' }), ahead);
    assert.equal(playerClockHidden({ crisis_starts_at: '2026-06-01T11:59:00.000Z' }, NOW), false);
  });
});
