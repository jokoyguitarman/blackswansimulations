import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ALLOWED_DETECTION_ACTION_TYPES } from '../teamCharterService.js';
import { evaluateConditionKey } from '../conditionEvaluatorService.js';
import type { EvaluationContext } from '../conditionEvaluatorService.js';
import type { CommsDelivery, CommsState } from '../ledger/injectLedgerCore.js';
import {
  evaluateCommsKey,
  explainCommsKey,
  firstEmailMinuteByStakeholder,
  selectPublishable,
} from './commsConditionsCore.js';
import { CATALOG_ACTION_TYPES, CONDITION_CATALOG, parseConditionKey } from './conditionCatalog.js';

function delivery(
  partial: Partial<CommsDelivery> & { delivery_id: string; inject_key: string },
): CommsDelivery {
  return {
    inject_id: 'inj',
    channel: 'chat',
    delivered_minute: 10,
    recipient_teams: [],
    session_wide: false,
    stakeholder_id: null,
    call_state: null,
    call_group_id: null,
    attempt_no: 1,
    chain_root_key: null,
    chain_step: null,
    urgency: null,
    mood_rung: null,
    opened_minute: null,
    first_response_minute: null,
    first_response_team: null,
    first_response_by_team: {},
    responses: [],
    ...partial,
  };
}

function reply(
  partial: Partial<CommsDelivery['responses'][number]> = {},
): CommsDelivery['responses'][number] {
  return {
    minute: 15,
    team: 'A',
    user_id: 'user-a',
    is_bot: false,
    attribution: 'chat_heuristic',
    judgement_status: 'pending',
    judgement: null,
    ...partial,
  };
}

function comms(rows: CommsDelivery[], extra: Partial<CommsState> = {}): CommsState {
  const by_key: Record<string, CommsDelivery[]> = {};
  for (const row of rows) {
    (by_key[row.inject_key] ??= []).push(row);
    if (row.chain_root_key && row.chain_root_key !== row.inject_key) {
      (by_key[row.chain_root_key] ??= []).push(row);
    }
  }
  return { by_key, generated_at_minute: 0, truncated: false, ...extra };
}

function met(key: string, state: CommsState, elapsed: number): boolean {
  const parsed = parseConditionKey(key);
  assert.ok(!('error' in parsed), key);
  if ('error' in parsed) return false;
  const result = evaluateCommsKey(parsed, state, elapsed);
  assert.notEqual(result, undefined, key);
  return result === true;
}

const pair = [
  delivery({ delivery_id: 'a', inject_key: 'k1', recipient_teams: ['A'] }),
  delivery({ delivery_id: 'b', inject_key: 'k1', recipient_teams: ['B'] }),
];

describe('per-inject comms keys', () => {
  test('unresponded is false until the window has elapsed', () => {
    assert.equal(met('unresponded:k1:10', comms(pair), 19), false);
  });

  test('unresponded is true when every delivery is overdue and unanswered', () => {
    assert.equal(met('unresponded:k1:10', comms(pair), 20), true);
    const explained = explainCommsKey(mustParse('unresponded:k1:10'), comms(pair), 20);
    assert.match(explained?.detail ?? '', /delivered T\+10 to A/);
    assert.match(explained?.detail ?? '', /no reply yet \(T\+20\)/);
  });

  test('one team answering keeps the inject answered only for that team', () => {
    const rows = [
      delivery({
        delivery_id: 'a',
        inject_key: 'k1',
        recipient_teams: ['A'],
        responses: [reply({ minute: 15, team: 'A' })],
      }),
      delivery({ delivery_id: 'b', inject_key: 'k1', recipient_teams: ['B'] }),
    ];
    const state = comms(rows);
    assert.equal(met('unresponded:k1:10', state, 20), false);
    assert.equal(met('unresponded:k1:10|team=b', state, 20), true);
    assert.equal(met('responded:k1|team=a', state, 20), true);
    assert.equal(met('responded:k1|team=b', state, 20), false);
  });

  test('a late reply does not clear unresponded and does count as responded', () => {
    const rows = [
      delivery({
        delivery_id: 'a',
        inject_key: 'k1',
        recipient_teams: ['A'],
        responses: [reply({ minute: 25, team: 'A' })],
      }),
      delivery({ delivery_id: 'b', inject_key: 'k1', recipient_teams: ['B'] }),
    ];
    const state = comms(rows);
    assert.equal(met('unresponded:k1:10', state, 25), true);
    assert.equal(met('responded:k1', state, 25), true);
  });

  test('an inject that was never delivered is false for positive and negative keys', () => {
    const state = comms([]);
    for (const key of [
      'delivered:k2',
      'responded:k2',
      'opened:k2',
      'unresponded:k2:5',
      'unopened:k2:5',
    ]) {
      assert.equal(met(key, state, 30), false, key);
    }
  });

  test('email_replied ignores a forward, and email_forwarded sees the forward recipients', () => {
    const forwarded = comms([
      delivery({
        delivery_id: 'e',
        inject_key: 'k',
        channel: 'email',
        recipient_teams: ['Legal'],
        responses: [
          reply({
            attribution: 'email_forward',
            team: 'Communications',
            meta: { recipient_teams: ['Legal'] },
          }),
        ],
      }),
    ]);
    assert.equal(met('email_replied:k', forwarded, 20), false);
    assert.equal(met('email_forwarded:k', forwarded, 20), true);
    assert.equal(met('email_forwarded:k|team=legal', forwarded, 20), true);
    assert.equal(met('email_forwarded:k|team=finance', forwarded, 20), false);

    const replied = comms([
      delivery({
        delivery_id: 'e2',
        inject_key: 'k',
        channel: 'email',
        responses: [reply({ attribution: 'email_reply', minute: 12 })],
      }),
    ]);
    assert.equal(met('email_replied:k', replied, 20), true);
    assert.equal(met('email_forwarded:k', replied, 20), false);
  });

  test('chat_unanswered ignores email deliveries of the same key', () => {
    const emailOnly = comms([
      delivery({
        delivery_id: 'e',
        inject_key: 'k',
        channel: 'email',
        responses: [reply({ attribution: 'email_reply', minute: 11 })],
      }),
    ]);
    assert.equal(met('chat_unanswered:k:5', emailOnly, 30), false);

    const both = comms([
      delivery({
        delivery_id: 'e',
        inject_key: 'k',
        channel: 'email',
        responses: [reply({ attribution: 'email_reply', minute: 11 })],
      }),
      delivery({ delivery_id: 'c', inject_key: 'k', channel: 'chat', recipient_teams: ['A'] }),
    ]);
    assert.equal(met('chat_unanswered:k:10', both, 20), true);
    assert.equal(met('chat_replied:k', both, 20), false);
  });

  test('call keys stay false with no call deliveries, and attempts share a group', () => {
    assert.equal(met('call_missed:k', comms([]), 10), false);

    const ringing = comms([attempt(1, 'missed'), attempt(2, 'missed'), attempt(3, 'ringing')]);
    assert.equal(met('call_missed:k', ringing, 10), false);
    assert.equal(met('call_missed_count:k:2', ringing, 10), true);
    assert.equal(met('call_attempts_gte:k:3', ringing, 10), true);

    const answered = comms([
      attempt(1, 'missed'),
      attempt(2, 'missed'),
      attempt(3, 'answered', [reply({ attribution: 'call_answered', minute: 4 })]),
    ]);
    assert.equal(met('call_answered:k', answered, 10), true);
    assert.equal(met('call_answered_by_attempt:k:2', answered, 10), false);
    assert.equal(met('call_answered_by_attempt:k:3', answered, 10), true);
    assert.equal(met('call_missed:k', answered, 10), false);

    const blocked = comms(
      [attempt(1, 'answered', [reply({ attribution: 'call_answered', minute: 2 })])],
      { calls_available: false },
    );
    assert.equal(met('call_answered:k', blocked, 10), false);
  });

  test('a reply to a chain chaser answers the root, measured from the root delivery', () => {
    const rows = [
      delivery({
        delivery_id: 'root',
        inject_key: 'k',
        channel: 'email',
        delivered_minute: 10,
        recipient_teams: ['A'],
      }),
      delivery({
        delivery_id: 'chaser',
        inject_key: 'k',
        channel: 'email',
        delivered_minute: 15,
        recipient_teams: ['A'],
        chain_root_key: 'k',
        chain_step: 1,
        responses: [reply({ minute: 17, team: 'A', attribution: 'email_reply' })],
      }),
    ];
    const state = comms(rows);
    assert.equal(met('responded:k', state, 25), true);
    assert.equal(met('unresponded:k:5', state, 25), true);
    assert.equal(met('unresponded:k:10', state, 25), false);
  });

  test('contacted_via reads stakeholder_contacts', () => {
    const state = comms([], {
      stakeholder_contacts: { stk_a: { first_minute: 4, channels: ['email'] } },
    });
    assert.equal(met('contacted_via:stk_a:email', state, 10), true);
    assert.equal(met('contacted_via:stk_a:phone', state, 10), false);
    assert.equal(met('contacted:stk_a', state, 10), true);
    assert.equal(met('not_contacted:stk_a:5', state, 10), false);
    assert.equal(met('not_contacted:stk_a:3', state, 10), true);
    assert.equal(met('not_contacted:stk_a:3', comms([]), 2), false);
    assert.equal(met('not_contacted:stk_a:3', comms([]), 10), true);
  });

  test('action_count_gte with a team scope counts only that team', () => {
    const state = comms([], {
      action_counts: [
        { action_type: 'group_post_created', team_slug: 'a', count: 2, first_minute: 3 },
        { action_type: 'group_post_created', team_slug: 'b', count: 5, first_minute: 1 },
      ],
    });
    assert.equal(met('action_count_gte:group_post_created:2|team=a', state, 10), true);
    assert.equal(met('action_count_gte:group_post_created:3|team=a', state, 10), false);
    assert.equal(met('action_absent:group_post_created:4|team=a', state, 10), false);
    assert.equal(met('action_absent:group_post_created:2|team=a', state, 10), true);
    assert.equal(met('action_absent:draft_approved:5', comms([]), 4), false);
    assert.equal(met('action_absent:draft_approved:5', comms([]), 5), true);
  });

  test('an email_sent to a stakeholder address is recorded by id', () => {
    const minutes = firstEmailMinuteByStakeholder(
      [
        {
          action_type: 'email_sent',
          created_at: '2026-01-01T00:08:00.000Z',
          metadata: { to_addresses: ['Ada@Firm.test'], cc_addresses: [] },
        },
      ],
      [{ id: 'stk_a', email: 'ada@firm.test' }],
      '2026-01-01T00:00:00.000Z',
    );
    assert.equal(minutes.stk_a, 8);
    const state = comms([], { email_sent_minutes: minutes });
    assert.equal(met('email_sent_to_stakeholder:stk_a', state, 12), true);
    assert.equal(met('email_not_sent_to_stakeholder:stk_a:10', state, 12), false);
    assert.equal(met('email_not_sent_to_stakeholder:stk_b:10', state, 12), true);
  });

  test('a failed read keeps absence and positive keys false', () => {
    const unknown = comms([], {
      action_facts_known: false,
      email_facts_known: false,
      contact_facts_known: false,
      action_counts: [
        { action_type: 'group_post_created', team_slug: 'a', count: 5, first_minute: 1 },
      ],
      email_sent_minutes: { stk_a: 2 },
      stakeholder_contacts: { stk_a: { first_minute: 2, channels: ['email'] } },
    });
    assert.equal(met('action_absent:group_post_created:1', unknown, 10), false);
    assert.equal(met('action_count_gte:group_post_created:1', unknown, 10), false);
    assert.equal(met('email_not_sent_to_stakeholder:stk_b:1', unknown, 10), false);
    assert.equal(met('email_sent_to_stakeholder:stk_a', unknown, 10), false);
    assert.equal(met('not_contacted:stk_b:1', unknown, 10), false);
    assert.equal(met('contacted:stk_a', unknown, 10), false);
    assert.equal(met('contacted_via:stk_a:email', unknown, 10), false);
  });

  test('a truncated history cannot prove that something never happened', () => {
    const truncated = comms([], {
      action_counts_truncated: true,
      email_facts_truncated: true,
      contact_facts_truncated: true,
      action_counts: [
        { action_type: 'group_post_created', team_slug: 'a', count: 2, first_minute: 1 },
      ],
    });
    assert.equal(met('action_absent:draft_approved:5', truncated, 10), false);
    assert.equal(met('email_not_sent_to_stakeholder:stk_a:5', truncated, 10), false);
    assert.equal(met('not_contacted:stk_a:5', truncated, 10), false);
    assert.equal(met('action_count_gte:group_post_created:2|team=a', truncated, 10), true);
  });
});

describe('condition key grammar', () => {
  test('minutes, inject keys and empty scopes are rejected', () => {
    for (const key of [
      'unresponded:k1:0',
      'unresponded:k1:241',
      'email_unreplied:Bad Key:5',
      'unresponded:k1:10|team=',
    ]) {
      const parsed = parseConditionKey(key);
      assert.ok('error' in parsed, key);
    }
    const roleScope = parseConditionKey('unresponded:k1:10|role=cs_head');
    assert.ok(!('error' in roleScope));
    if (!('error' in roleScope)) assert.equal(roleScope.scope?.role, 'cs_head');
    const unknownScope = parseConditionKey('unresponded:k1:10|desk=ops');
    assert.ok('error' in unknownScope);
    if ('error' in unknownScope) assert.match(unknownScope.error, /desk/);

    const slugged = parseConditionKey('responded:k1|team=Legal Team');
    assert.ok(!('error' in slugged));
    if (!('error' in slugged)) assert.equal(slugged.scope?.team, 'legal_team');
  });

  test('the catalogue has every new prefix and each example round-trips', () => {
    const examples = [
      'delivered:k1',
      'opened:k1',
      'unopened:k1:10',
      'responded:k1',
      'unresponded:k1:10|team=b',
      'responded_within:k1:10',
      'response_count_gte:k1:2',
      'responded_by_bot_only:k1',
      'email_opened:k1',
      'email_unopened:k1:10',
      'email_replied:k1',
      'email_unreplied:k1:10',
      'email_forwarded:k1',
      'email_sent_to_stakeholder:stk_a',
      'email_not_sent_to_stakeholder:stk_a:10',
      'chat_replied:k1',
      'chat_unanswered:k1:10',
      'dm_replied:k1',
      'dm_unanswered:k1:10',
      'call_answered:k1',
      'call_missed:k1',
      'call_declined:k1',
      'call_missed_count:k1:2',
      'call_attempts_gte:k1:3',
      'call_answered_by_attempt:k1:3',
      'call_unreturned:k1:10',
      'call_answered_within:k1:30',
      'stakeholder_missed_calls:stk_a:2',
      'contacted:stk_a',
      'contacted_via:stk_a:email',
      'not_contacted:stk_a:10',
      'stakeholder_verdict:stk_a:delay',
      'news_opened:k1',
      'action_count_gte:group_post_created:2|team=a',
      'action_absent:draft_approved:15',
      'reply_passed:k1',
      'reply_failed:k1',
      'reply_best_passed:k1',
      'reply_criterion:k1:2',
      'reply_missing_criterion:k1:2',
      'reply_answered_ask:k1:1',
      'reply_missed_ask:k1:1',
      'reply_tone:k1:defensive',
      'reply_tone_off:k1',
      'reply_score_below:k1:accuracy:40',
      'reply_score_at_least:k1:empathy:60',
      'reply_factual_error:k1',
      'reply_risky_admission:k1',
      'reply_irrelevant:k1',
      'responded_relevant:k1|team=a',
    ];
    const ids = examples.map((key) => key.split(':')[0] ?? '');
    for (const id of ids) {
      assert.ok(
        CONDITION_CATALOG.some((def) => def.kind === 'prefix' && def.id === id),
        id,
      );
    }
    for (const key of examples) {
      const parsed = parseConditionKey(key);
      assert.ok(!('error' in parsed), 'error' in parsed ? `${key}: ${parsed.error}` : key);
      if ('error' in parsed) continue;
      const scope = parsed.scope?.team ? `|team=${parsed.scope.team}` : '';
      assert.equal(`${parsed.def.prefix}${parsed.args.join(':')}${scope}`, key);
    }
    assert.deepEqual([...CATALOG_ACTION_TYPES], [...ALLOWED_DETECTION_ACTION_TYPES]);
  });
});

describe('conditional publish burst control', () => {
  test('selectPublishable keeps the three highest-priority injects in a stable order', () => {
    const metList = [
      { id: '1', severity: 'low', eligible_after_minutes: 0, inject_key: 'a' },
      { id: '2', severity: 'critical', eligible_after_minutes: 5, inject_key: 'b' },
      { id: '3', severity: 'high', eligible_after_minutes: 1, inject_key: 'c' },
      { id: '4', severity: 'critical', eligible_after_minutes: 1, inject_key: 'd' },
      { id: '5', severity: 'critical', eligible_after_minutes: 1, inject_key: 'a' },
    ];
    const selected = selectPublishable(metList, 3);
    assert.deepEqual(
      selected.publish.map((item) => item.id),
      ['5', '4', '2'],
    );
    assert.deepEqual(
      selected.deferred.map((item) => item.id),
      ['3', '1'],
    );
  });

  test('a held inject does not take a publish slot or block the rest of the queue', () => {
    const metList = [
      { id: '1', severity: 'low', eligible_after_minutes: 0, inject_key: 'a' },
      { id: '2', severity: 'critical', eligible_after_minutes: 5, inject_key: 'b' },
      { id: '3', severity: 'high', eligible_after_minutes: 1, inject_key: 'c' },
      { id: '4', severity: 'critical', eligible_after_minutes: 1, inject_key: 'd' },
      { id: '5', severity: 'critical', eligible_after_minutes: 1, inject_key: 'a' },
    ];
    const held = (item: { id: string }) => item.id === '5';
    const firstTick = selectPublishable(metList, 3, held);
    assert.deepEqual(
      firstTick.publish.map((item) => item.id),
      ['4', '2', '3'],
    );
    assert.deepEqual(
      firstTick.skipped.map((item) => item.id),
      ['5'],
    );
    assert.deepEqual(
      firstTick.deferred.map((item) => item.id),
      ['1'],
    );

    const nextTick = selectPublishable(metList, 3, held);
    assert.deepEqual(
      nextTick.publish.map((item) => item.id),
      ['4', '2', '3'],
    );
    assert.equal(
      nextTick.publish.some((item) => item.id === '5'),
      false,
    );

    const released = selectPublishable(metList, 3);
    assert.equal(released.publish[0]?.id, '5');
  });
});

describe('consistency keys use the crisis-standards score', () => {
  test('inconsistent is the low score and consistent needs both platforms', () => {
    const base = {
      sessionId: 's',
      scenarioId: 'sc',
      elapsedMinutes: 12,
      currentState: {},
      executedDecisions: [],
      publishedScenarioInjectIds: [],
    } satisfies EvaluationContext;

    assert.equal(
      evaluateConditionKey('player_message_inconsistent_across_channels', {
        ...base,
        currentState: { crisis_standards: { consistency: { score: 30 } } },
      }),
      true,
    );
    assert.equal(
      evaluateConditionKey('player_message_is_consistent_across_channels', {
        ...base,
        currentState: {
          crisis_standards: { consistency: { score: 70 } },
          social_state: { player_message_is_consistent_across_channels: true },
        },
      }),
      true,
    );
    assert.equal(
      evaluateConditionKey('player_message_is_consistent_across_channels', {
        ...base,
        currentState: { crisis_standards: { consistency: { score: 80 } } },
      }),
      false,
    );
    assert.equal(
      evaluateConditionKey('player_message_inconsistent_across_channels', {
        ...base,
        currentState: { crisis_standards: { consistency: { score: 55 } } },
      }),
      false,
    );
  });
});

function attempt(
  n: number,
  callState: string,
  responses: CommsDelivery['responses'] = [],
): CommsDelivery {
  return delivery({
    delivery_id: `c${n}`,
    inject_key: 'k',
    channel: 'call',
    delivered_minute: n,
    recipient_teams: ['A'],
    call_state: callState,
    call_group_id: 'g1',
    attempt_no: n,
    responses,
  });
}

function mustParse(key: string) {
  const parsed = parseConditionKey(key);
  if ('error' in parsed) throw new Error(parsed.error);
  return parsed;
}
