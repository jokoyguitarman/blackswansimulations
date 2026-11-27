import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { attributeDmResponses, type DmDelivery } from '../ledger/injectLedgerCore.js';
import {
  buildMessengerDmRows,
  dmDeliveryConfigError,
  MESSENGER_DM_NEEDS_HANDLE,
  NPC_DM_NEEDS_STAKEHOLDER,
  type MessengerRecipient,
} from './dmDeliveryCore.js';

const USER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const EXISTING_THREAD = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OTHER_THREAD = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

describe('buildMessengerDmRows', () => {
  test('one row per recipient, reused thread id, and the authored sender type', () => {
    const recipients: MessengerRecipient[] = [
      { userId: USER_A, handle: '@aisha', threadId: EXISTING_THREAD },
      { userId: USER_B, handle: '@ben', threadId: null },
    ];
    const minted: string[] = [];
    const rows = buildMessengerDmRows(
      { content: 'Can you confirm the headcount?' },
      {
        author_handle: '@sarah_lim',
        author_display_name: 'Sarah Lim',
        author_type: 'npc_media',
        platform: 'x_twitter',
      },
      recipients,
      (recipient) => {
        minted.push(recipient.userId);
        return 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
      },
    );

    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((row) => row.recipient_user_id),
      [USER_A, USER_B],
    );
    assert.equal(rows[0].thread_id, EXISTING_THREAD);
    assert.equal(rows[1].thread_id, 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee');
    assert.deepEqual(minted, [USER_B]);
    assert.equal(rows[0].sender_handle, '@sarah_lim');
    assert.equal(rows[0].sender_display_name, 'Sarah Lim');
    assert.equal(rows[0].sender_type, 'npc_media');
    assert.equal(rows[0].platform, 'x_twitter');
    assert.equal(rows[0].content, 'Can you confirm the headcount?');
    assert.equal(rows[1].recipient_handle, '@ben');
  });

  test('sender type and platform fall back when the authored values are not allowed', () => {
    const rows = buildMessengerDmRows(
      { content: 'Hello' },
      { author_handle: '@pastor', author_type: 'journalist', platform: 'instagram' },
      [{ userId: USER_A, handle: '@aisha' }],
      () => EXISTING_THREAD,
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].sender_type, 'npc_public');
    assert.equal(rows[0].platform, 'facebook');
    assert.equal(rows[0].sender_display_name, 'pastor');
    assert.equal(rows[0].thread_id, EXISTING_THREAD);
  });
});

describe('dmDeliveryConfigError', () => {
  test('npc_dm without stakeholder_id fails validation', () => {
    assert.equal(dmDeliveryConfigError({ app: 'npc_dm' }), NPC_DM_NEEDS_STAKEHOLDER);
    assert.equal(
      dmDeliveryConfigError({ app: 'npc_dm', stakeholder_id: '   ' }),
      NPC_DM_NEEDS_STAKEHOLDER,
    );
    assert.equal(
      dmDeliveryConfigError({ app: 'npc_dm', stakeholder_id: 'stk_pastor', author_handle: '' }),
      null,
    );
  });

  test('messenger_dm without author_handle fails validation', () => {
    assert.equal(dmDeliveryConfigError({ app: 'messenger_dm' }), MESSENGER_DM_NEEDS_HANDLE);
    assert.equal(dmDeliveryConfigError({ app: 'messenger_dm', author_handle: '@sarah_lim' }), null);
    assert.equal(dmDeliveryConfigError({ app: 'email' }), null);
    assert.equal(dmDeliveryConfigError(null), null);
  });
});

describe('DM ledger attribution', () => {
  const delivery = (threadId: string): DmDelivery => ({
    id: `del-${threadId}`,
    delivered_at: '2026-01-01T00:00:00.000Z',
    delivered_minute: 4,
    response_window_minutes: 15,
    recipient_teams: ['Operations'],
    recipient_user_ids: [USER_A],
    thread_id: threadId,
    responded_teams: [],
  });

  const playerMessage = {
    id: 'msg-1',
    sender_id: USER_A,
    created_at: '2026-01-01T00:05:00.000Z',
    sender_team: 'Operations',
    is_trainer: false,
  };

  test('a player DM in the same thread after delivery is dm_thread; another thread is none', () => {
    const same = attributeDmResponses({
      message: playerMessage,
      deliveries: [delivery(EXISTING_THREAD), delivery(OTHER_THREAD)],
      messageMinute: 9,
      threadId: EXISTING_THREAD,
    });
    assert.deepEqual(same, [{ deliveryId: `del-${EXISTING_THREAD}`, attribution: 'dm_thread' }]);

    const other = attributeDmResponses({
      message: playerMessage,
      deliveries: [delivery(EXISTING_THREAD)],
      messageMinute: 9,
      threadId: OTHER_THREAD,
    });
    assert.deepEqual(other, []);
  });
});
