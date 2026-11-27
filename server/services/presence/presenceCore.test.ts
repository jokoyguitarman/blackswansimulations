import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  createPresenceMap,
  presenceExpire,
  presenceIsOnline,
  presenceJoin,
  presenceLeave,
} from './presenceCore.js';

const GRACE = 60_000;

describe('session presence', () => {
  test('a reconnect inside the grace never goes offline, and the grace fires once', () => {
    const map = createPresenceMap();
    const online = presenceJoin(map, 's1', 'aisha', 0);
    assert.equal(online?.type, 'presence.online');
    presenceLeave(map, 's1', 'aisha', 1_000);
    assert.equal(presenceIsOnline(map, 's1', 'aisha', 30_000, GRACE), true);
    assert.deepEqual(presenceExpire(map, 30_000, GRACE, false), []);

    presenceJoin(map, 's1', 'aisha', 40_000);
    presenceLeave(map, 's1', 'aisha', 40_000);
    const first = presenceExpire(map, 40_000 + GRACE, GRACE, false);
    const second = presenceExpire(map, 40_000 + GRACE + 5_000, GRACE, false);
    assert.equal(first.length, 1);
    assert.equal(first[0]?.type, 'presence.offline');
    assert.deepEqual(second, []);
    assert.equal(presenceIsOnline(map, 's1', 'aisha', 40_000 + GRACE, GRACE), false);
  });

  test('boot grace does not emit offline', () => {
    const map = createPresenceMap();
    presenceJoin(map, 's1', 'aisha', 0);
    presenceLeave(map, 's1', 'aisha', 0);
    assert.deepEqual(presenceExpire(map, GRACE + 1, GRACE, true), []);
  });
});
