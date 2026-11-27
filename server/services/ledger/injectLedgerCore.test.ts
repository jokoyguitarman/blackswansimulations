import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { injectKeyOf, isValidInjectKey, stampGeneratedInjectKeys } from '../../lib/injectKey.js';
import {
  attributeChatResponse,
  buildCommsState,
  matchEmailDelivery,
  resolveEmailRootId,
  type OpenChatDelivery,
  type ChatAttributionMessage,
} from './injectLedgerCore.js';

const CHANNEL = '11111111-1111-4111-8111-111111111111';

function message(overrides: Partial<ChatAttributionMessage> = {}): ChatAttributionMessage {
  return {
    id: 'msg-1',
    channel_id: CHANNEL,
    sender_id: 'user-1',
    reply_to: null,
    created_at: '2026-01-01T00:10:00.000Z',
    sender_team: 'Legal',
    is_trainer: false,
    ...overrides,
  };
}

function delivery(overrides: Partial<OpenChatDelivery> = {}): OpenChatDelivery {
  return {
    id: 'del-1',
    ref_id: 'chat-1',
    chat_channel_id: CHANNEL,
    delivered_at: '2026-01-01T00:05:00.000Z',
    delivered_minute: 5,
    recipient_teams: ['Legal'],
    recipient_user_ids: null,
    response_window_minutes: null,
    first_response_at: null,
    ...overrides,
  };
}

describe('chat attribution', () => {
  test('an explicit reply_to attributes to that delivery even when another is more recent', () => {
    const older = delivery({
      id: 'older',
      ref_id: 'chat-older',
      delivered_at: '2026-01-01T00:02:00.000Z',
    });
    const newer = delivery({
      id: 'newer',
      ref_id: 'chat-newer',
      delivered_at: '2026-01-01T00:08:00.000Z',
      delivered_minute: 8,
    });
    const result = attributeChatResponse({
      message: message({ reply_to: 'chat-older', created_at: '2026-01-01T00:12:00.000Z' }),
      openDeliveries: [older, newer],
      messageMinute: 12,
      defaultWindowMinutes: 15,
    });
    assert.deepEqual(result, [{ deliveryId: 'older', attribution: 'chat_reply_to' }]);
  });

  test('a recipient-team message inside the window is a heuristic response', () => {
    const result = attributeChatResponse({
      message: message({ created_at: '2026-01-01T00:10:00.000Z' }),
      openDeliveries: [delivery({ delivered_minute: 5, delivered_at: '2026-01-01T00:05:00.000Z' })],
      messageMinute: 10,
      defaultWindowMinutes: 15,
    });
    assert.deepEqual(result, [{ deliveryId: 'del-1', attribution: 'chat_heuristic' }]);
  });

  test('a message after the window is not a response', () => {
    const result = attributeChatResponse({
      message: message({ created_at: '2026-01-01T00:21:00.000Z' }),
      openDeliveries: [delivery({ delivered_minute: 0, delivered_at: '2026-01-01T00:00:00.000Z' })],
      messageMinute: 16,
      defaultWindowMinutes: 15,
    });
    assert.deepEqual(result, []);
  });

  test('a message from a non-recipient team is not a response', () => {
    const result = attributeChatResponse({
      message: message({ sender_team: 'Communications' }),
      openDeliveries: [
        delivery({ recipient_teams: ['Legal'], recipient_user_ids: ['someone-else'] }),
      ],
      messageMinute: 10,
      defaultWindowMinutes: 15,
    });
    assert.deepEqual(result, []);
  });

  test('a trainer message is not a response', () => {
    const result = attributeChatResponse({
      message: message({ is_trainer: true, reply_to: 'chat-1' }),
      openDeliveries: [delivery()],
      messageMinute: 10,
      defaultWindowMinutes: 15,
    });
    assert.deepEqual(result, []);
  });

  test('two open deliveries in one channel attribute only the most recent', () => {
    const older = delivery({
      id: 'older',
      ref_id: 'chat-older',
      delivered_at: '2026-01-01T00:02:00.000Z',
      delivered_minute: 2,
    });
    const newer = delivery({
      id: 'newer',
      ref_id: 'chat-newer',
      delivered_at: '2026-01-01T00:08:00.000Z',
      delivered_minute: 8,
    });
    const result = attributeChatResponse({
      message: message({ created_at: '2026-01-01T00:10:00.000Z' }),
      openDeliveries: [older, newer],
      messageMinute: 10,
      defaultWindowMinutes: 15,
    });
    assert.deepEqual(result, [{ deliveryId: 'newer', attribution: 'chat_heuristic' }]);
  });

  test('a team that already responded is still recorded, and the first minute does not move', () => {
    const open = delivery({ id: 'del-legal', responded_teams: ['Legal'] });
    const again = attributeChatResponse({
      message: message({ id: 'msg-2', created_at: '2026-01-01T00:12:00.000Z' }),
      openDeliveries: [open],
      messageMinute: 12,
      defaultWindowMinutes: 15,
    });
    assert.deepEqual(again, [{ deliveryId: 'del-legal', attribution: 'chat_heuristic' }]);

    const row = {
      id: 'del-legal',
      inject_id: 'inj-1',
      inject_key: 'supplier_4471',
      channel: 'chat',
      delivered_minute: 5,
      recipient_teams: ['Legal'],
      recipient_user_ids: null,
    };
    const first = {
      delivery_id: 'del-legal',
      response_minute: 8,
      team_name: 'Legal',
      user_id: 'user-1',
      is_bot: false,
      attribution: 'chat_heuristic',
    };
    const second = { ...first, response_minute: 12, user_id: 'user-2' };
    const one = buildCommsState({ deliveries: [row], responses: [first], elapsedMinutes: 12 });
    const two = buildCommsState({
      deliveries: [row],
      responses: [first, second],
      elapsedMinutes: 12,
    });
    const single = one.by_key.supplier_4471?.[0];
    const both = two.by_key.supplier_4471?.[0];
    assert.ok(single && both);
    assert.equal(both.responses.length, 2);
    assert.equal(both.first_response_minute, single.first_response_minute);
    assert.equal(both.first_response_minute, 8);
    assert.equal(both.first_response_by_team.Legal, 8);
  });

  test('a session-wide delivery counts any participant', () => {
    const result = attributeChatResponse({
      message: message({ sender_team: 'Communications' }),
      openDeliveries: [delivery({ recipient_teams: [], recipient_user_ids: null })],
      messageMinute: 10,
      defaultWindowMinutes: 15,
    });
    assert.deepEqual(result, [{ deliveryId: 'del-1', attribution: 'chat_heuristic' }]);
  });
});

describe('inject keys', () => {
  test('injectKeyOf keeps a valid slug and otherwise uses inj_ plus 8 hex chars', () => {
    assert.equal(
      injectKeyOf({
        id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        delivery_config: { inject_key: 'supplier_4471' },
      }),
      'supplier_4471',
    );
    assert.equal(
      injectKeyOf({
        id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
        delivery_config: { inject_key: 'Not A Slug' },
      }),
      'inj_a1b2c3d4',
    );
    assert.equal(injectKeyOf({ id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' }), 'inj_a1b2c3d4');
    assert.equal(isValidInjectKey('supplier_4471'), true);
    assert.equal(isValidInjectKey('Supplier'), false);
    assert.equal(isValidInjectKey('has space'), false);
    assert.equal(isValidInjectKey('a'.repeat(61)), false);
    assert.equal(isValidInjectKey('a'.repeat(60)), true);

    const stamped = stampGeneratedInjectKeys([
      { title: 'Batch 4471 recall', delivery_config: { app: 'email' } },
      { title: 'Batch 4471 recall', delivery_config: { app: 'email', inject_key: 'keep_me' } },
      { title: 'Batch 4471 recall', delivery_config: null },
    ]);
    assert.equal(stamped[0]?.delivery_config.inject_key, 'batch_4471_recall');
    assert.equal(stamped[1]?.delivery_config.inject_key, 'keep_me');
    assert.equal(stamped[2]?.delivery_config.inject_key, 'batch_4471_recall_2');
  });
});

describe('email root resolution', () => {
  test('replied_to_id walks the thread_id chain to the delivery', () => {
    const emails = [
      { id: 'root', thread_id: 'root', replied_to_id: null },
      { id: 'mid', thread_id: 'root', replied_to_id: 'root' },
      { id: 'leaf', thread_id: null, replied_to_id: 'mid' },
    ];
    assert.equal(resolveEmailRootId(emails, 'leaf'), 'root');
    assert.equal(resolveEmailRootId(emails, 'mid'), 'root');
    const deliveryId = matchEmailDelivery(
      [{ id: 'del-1', thread_id: 'root', ref_id: 'root' }],
      'root',
      'leaf',
    );
    assert.equal(deliveryId, 'del-1');
    assert.equal(
      matchEmailDelivery([{ id: 'del-2', thread_id: null, ref_id: 'root' }], 'missing', 'root'),
      'del-2',
    );
  });
});

describe('comms_state', () => {
  test('buildCommsState reports per-team first minutes, chain roots and truncation', () => {
    const delivery = {
      id: 'd1',
      inject_id: 'i1',
      inject_key: 'supplier_4471',
      channel: 'email',
      delivered_minute: 4,
      delivered_at: '2026-01-01T00:04:00.000Z',
      first_opened_at: '2026-01-01T00:06:00.000Z',
      recipient_teams: ['Legal'],
      recipient_user_ids: ['user-1'],
      stakeholder_id: 'supplier',
    };
    const followUp = {
      id: 'd2',
      inject_id: 'i2',
      inject_key: 'supplier_4471_chase',
      channel: 'email',
      delivered_minute: 20,
      delivered_at: '2026-01-01T00:20:00.000Z',
      recipient_teams: ['Legal'],
      chain_root_key: 'supplier_4471',
      chain_step: 1,
      urgency: 'follow_up',
    };
    const state = buildCommsState({
      deliveries: [delivery, followUp],
      responses: [
        {
          delivery_id: 'd1',
          response_minute: 9,
          team_name: 'Communications',
          user_id: 'user-2',
          is_bot: false,
          attribution: 'email_reply',
          judgement_status: 'pending',
        },
        {
          delivery_id: 'd1',
          response_minute: 6,
          team_name: 'Legal',
          user_id: 'user-1',
          is_bot: false,
          attribution: 'email_reply',
          judgement_status: 'pending',
        },
      ],
      elapsedMinutes: 22,
      sessionStartedAt: '2026-01-01T00:00:00.000Z',
    });
    const root = state.by_key.supplier_4471 ?? [];
    assert.equal(root.length, 2);
    assert.equal(root[0]?.delivery_id, 'd1');
    assert.equal(root[0]?.first_response_minute, 6);
    assert.equal(root[0]?.first_response_team, 'Legal');
    assert.equal(root[0]?.first_response_by_team.Legal, 6);
    assert.equal(root[0]?.first_response_by_team.Communications, 9);
    assert.equal(root[0]?.opened_minute, 6);
    assert.equal(root[0]?.session_wide, false);
    assert.equal(root[1]?.chain_step, 1);
    assert.equal(state.by_key.supplier_4471_chase?.[0]?.delivery_id, 'd2');
    assert.equal(state.truncated, false);
    assert.equal(state.generated_at_minute, 22);

    const burst = buildCommsState({
      deliveries: [
        { ...delivery, id: 'old', delivered_minute: 1, delivered_at: '2026-01-01T00:01:00.000Z' },
        { ...delivery, id: 'mid', delivered_minute: 2, delivered_at: '2026-01-01T00:02:00.000Z' },
        { ...delivery, id: 'new', delivered_minute: 3, delivered_at: '2026-01-01T00:03:00.000Z' },
      ],
      responses: [],
      elapsedMinutes: 3,
      deliveryCap: 2,
    });
    assert.equal(burst.truncated, true);
    const kept = (burst.by_key.supplier_4471 ?? []).map((row) => row.delivery_id);
    assert.deepEqual(kept, ['mid', 'new']);

    const withBot = buildCommsState({
      deliveries: [delivery],
      responses: [
        {
          delivery_id: 'd1',
          response_minute: 5,
          team_name: 'Legal',
          user_id: 'bot-1',
          is_bot: true,
          attribution: 'email_reply',
        },
        {
          delivery_id: 'd1',
          response_minute: 8,
          team_name: 'Legal',
          user_id: 'user-1',
          is_bot: false,
          attribution: 'email_reply',
        },
      ],
      elapsedMinutes: 10,
      countBots: false,
    });
    const counted = withBot.by_key.supplier_4471?.[0];
    assert.equal(counted?.responses.length, 1);
    assert.equal(counted?.first_response_minute, 8);
    assert.equal(counted?.responses[0]?.is_bot, false);
  });
});
