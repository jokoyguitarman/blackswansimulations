import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  buildReplyRecipients,
  normalizeRecipients,
  splitAddresses,
  type ReplyableEmail,
} from './emailRecipients.js';

const npcMail = (patch: Partial<ReplyableEmail> = {}): ReplyableEmail => ({
  from_address: 'npc@n',
  to_addresses: ['me@x', 'b@x'],
  cc_addresses: ['c@x'],
  sent_by_player_id: 'npc-sender',
  ...patch,
});

describe('email recipients', () => {
  test('dedupes To and Cc case-insensitively and drops Cc already in To', () => {
    assert.deepEqual(normalizeRecipients(['A@x', 'a@x', 'b@x'], ['B@x', 'c@x', 'C@x'], []), {
      to: ['A@x', 'b@x'],
      cc: ['c@x'],
    });
  });

  test('removes self from To and Cc', () => {
    assert.deepEqual(normalizeRecipients(['me@x', 'b@x'], ['ME@x'], ['me@x']), {
      to: ['b@x'],
      cc: [],
    });
  });

  test('promotes Cc when To would otherwise be only self', () => {
    assert.deepEqual(normalizeRecipients(['me@x'], ['c@x'], ['me@x']), {
      to: ['c@x'],
      cc: [],
    });
  });

  test('all empty when the only recipient is self', () => {
    assert.deepEqual(normalizeRecipients(['me@x'], [], ['me@x']), { to: [], cc: [] });
  });

  test('Reply to someone else goes only to the sender', () => {
    assert.deepEqual(
      buildReplyRecipients(npcMail(), {
        all: false,
        selfAddresses: ['me@x'],
        currentUserId: 'me',
      }),
      { to: ['npc@n'], cc: [] },
    );
  });

  test('Reply All keeps the other To and Cc recipients', () => {
    assert.deepEqual(
      buildReplyRecipients(npcMail(), {
        all: true,
        selfAddresses: ['me@x'],
        currentUserId: 'me',
      }),
      { to: ['npc@n', 'b@x'], cc: ['c@x'] },
    );
  });

  test('Reply All when I was only CC still drops me', () => {
    assert.deepEqual(
      buildReplyRecipients(npcMail({ to_addresses: ['b@x'], cc_addresses: ['me@x', 'c@x'] }), {
        all: true,
        selfAddresses: ['me@x'],
        currentUserId: 'me',
      }),
      { to: ['npc@n', 'b@x'], cc: ['c@x'] },
    );
  });

  test('replying to my own sent mail continues to the original recipients', () => {
    const mine = npcMail({
      from_address: 'me@x',
      to_addresses: ['b@x'],
      cc_addresses: ['c@x'],
      sent_by_player_id: 'me',
    });
    const opts = { selfAddresses: ['me@x'], currentUserId: 'me' };
    assert.deepEqual(buildReplyRecipients(mine, { ...opts, all: false }), {
      to: ['b@x'],
      cc: [],
    });
    assert.deepEqual(buildReplyRecipients(mine, { ...opts, all: true }), {
      to: ['b@x'],
      cc: ['c@x'],
    });
  });

  test('legacy self address is removed from Cc', () => {
    assert.deepEqual(
      normalizeRecipients(['npc@n'], ['ME@LEGACY', 'c@x'], ['me@new', 'me@legacy']),
      { to: ['npc@n'], cc: ['c@x'] },
    );
  });

  test('splitAddresses drops empties and accepts commas or semicolons', () => {
    assert.deepEqual(splitAddresses(' a@x, ;b@x;; '), ['a@x', 'b@x']);
  });
});
