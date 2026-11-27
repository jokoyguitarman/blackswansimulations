import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseConditionKey } from '../conditions/conditionCatalog.js';
import { evaluateCommsKey } from '../conditions/commsConditionsCore.js';
import { attributeChatResponse } from '../ledger/injectLedgerCore.js';
import type { CommsDelivery, CommsState } from '../ledger/injectLedgerCore.js';
import { resolveCallRingSet, DEFAULT_CALL_POLICY } from '../calls/lineCore.js';
import {
  chainScopeForRole,
  chainStepHeld,
  moodScope,
  planReroute,
  shouldPromptUnreachable,
  timedFallbackDue,
  waitMinutesExcludingHeld,
} from './roleCore.js';

function delivery(partial: Partial<CommsDelivery>): CommsDelivery {
  return {
    delivery_id: partial.delivery_id ?? 'd1',
    inject_id: 'inj',
    inject_key: partial.inject_key ?? 'k',
    channel: 'call',
    delivered_minute: 5,
    recipient_teams: ['Customer Service'],
    session_wide: false,
    stakeholder_id: 'stk_pastor',
    call_state: 'missed',
    call_group_id: 'g1',
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

function state(rows: CommsDelivery[], extra: Partial<CommsState> = {}): CommsState {
  return { by_key: { k: rows }, generated_at_minute: 20, truncated: false, ...extra };
}

function met(key: string, comms: CommsState): boolean {
  const parsed = parseConditionKey(key);
  if ('error' in parsed) throw new Error(parsed.error);
  return evaluateCommsKey(parsed, comms, 20) === true;
}

describe('runtime roles', () => {
  test('an offline role player with a pending redial prompts once, and reroute is one pass', () => {
    const pending = [{ id: 'group-1', kind: 'call_group' as const }];
    assert.equal(
      shouldPromptUnreachable({
        enginesOn: true,
        roleOfflinePrompt: true,
        alreadyPrompted: false,
        offlinePastGrace: true,
        pending,
      }).emit,
      true,
    );
    assert.equal(
      shouldPromptUnreachable({
        enginesOn: true,
        roleOfflinePrompt: true,
        alreadyPrompted: true,
        offlinePastGrace: true,
        pending,
      }).emit,
      false,
    );
    assert.equal(
      shouldPromptUnreachable({
        enginesOn: false,
        roleOfflinePrompt: true,
        alreadyPrompted: false,
        offlinePastGrace: true,
        pending,
      }).emit,
      false,
    );
    const plan = planReroute(
      [
        { id: 'group-1', kind: 'call_group', channel: 'call', inject_id: 'inj-call' },
        { id: 'group-1', kind: 'call_group', channel: 'call', inject_id: 'inj-call' },
        { id: 'mail-1', kind: 'delivery', channel: 'email', inject_id: 'inj-mail' },
        { id: 'old', kind: 'delivery', channel: 'email', already_linked: true, inject_id: 'inj-old' },
      ],
      { teamName: 'Customer Service', reason: 'trainer_reroute' },
    );
    assert.equal(plan.rerouted.length, 2);
    assert.deepEqual(plan.cancelCallGroups, ['group-1']);
    assert.equal(plan.fallback_reason, 'trainer_reroute');
    const email = plan.deliveries.find((item) => item.channel === 'email');
    const call = plan.deliveries.find((item) => item.channel === 'call');
    assert.equal(email?.team_name, 'Customer Service');
    assert.equal(email?.chain_root_id, 'mail-1');
    assert.equal(email?.fallback_reason, 'trainer_reroute');
    assert.equal(call?.fallback_reason, 'trainer_reroute');
    assert.equal(plan.deliveries.some((item) => item.source_id === 'old'), false);
    const timed = planReroute(
      [{ id: 'mail-2', kind: 'delivery', channel: 'npc_dm', inject_id: 'inj-2' }],
      { teamName: 'Operations', reason: 'role_fallback_after_minutes' },
    );
    assert.equal(timed.deliveries[0]?.channel, 'npc_dm');
    assert.equal(timed.deliveries[0]?.fallback_reason, 'role_fallback_after_minutes');
    assert.equal(timed.deliveries[0]?.chain_root_id, 'mail-2');
  });

  test('line_after_minutes reroutes at the threshold and not when the player returns', () => {
    assert.equal(
      timedFallbackDue({
        roleFallback: 'line_after_minutes',
        roleFallbackMinutes: 10,
        policyMinutes: 2,
        offlineMinutes: 9,
        playerBackOnline: false,
      }).due,
      false,
    );
    const due = timedFallbackDue({
      roleFallback: 'line_after_minutes',
      roleFallbackMinutes: 10,
      policyMinutes: null,
      offlineMinutes: 10,
      playerBackOnline: false,
    });
    assert.equal(due.due, true);
    assert.equal(due.reason, 'role_fallback_after_minutes');
    assert.equal(
      timedFallbackDue({
        roleFallback: 'line_after_minutes',
        roleFallbackMinutes: 10,
        policyMinutes: null,
        offlineMinutes: 10,
        playerBackOnline: true,
      }).due,
      false,
    );
  });

  test('role misses and line misses stay on their own counters', () => {
    const comms = state([
      delivery({
        delivery_id: 'role-miss',
        target_role_id: 'cs_head',
        line_team: 'Customer Service',
        missed_reason: 'role_offline',
      }),
      delivery({
        delivery_id: 'role-busy',
        target_role_id: 'cs_head',
        line_team: 'Customer Service',
        missed_reason: 'role_busy',
        call_group_id: 'g2',
      }),
      delivery({
        delivery_id: 'line-miss',
        target_role_id: null,
        line_team: 'Customer Service',
        missed_reason: 'line_unattended',
        call_group_id: 'g3',
      }),
    ]);
    assert.equal(met('role_missed_calls_gte:cs_head:2', comms), true);
    assert.equal(met('role_missed_calls_gte:cs_head:3', comms), false);
    assert.equal(met('call_missed_count:k:2|role=cs_head', comms), true);
    assert.equal(met('line_missed_calls_gte:customer_service:1', comms), true);
    assert.equal(met('line_missed_calls_gte:customer_service:2', comms), false);
    assert.equal(met('line_busy_missed_gte:customer_service:1', comms), false);
  });

  test('mood scope is the role, and held time is excluded from the wait', () => {
    assert.equal(moodScope({ roleId: 'cs_head', team: 'Customer Service' }), 'role:cs_head');
    assert.equal(moodScope({ team: 'Customer Service' }), 'Customer Service');
    assert.equal(
      waitMinutesExcludingHeld({
        elapsedMinutes: 20,
        firstContactMinute: 5,
        heldIntervals: [{ start: 8, end: 14 }],
      }),
      9,
    );
  });

  test('a role-rooted chain step rings the role and is held while they are offline', () => {
    const scope = chainScopeForRole('cs_head', 'Customer Service');
    assert.deepEqual(scope, { scope_team: 'Customer Service', scope_role: 'cs_head' });
    assert.equal(chainStepHeld({ roleTargeted: true, allPlayersOfflinePastGrace: true }), true);
    const held = resolveCallRingSet({
      mode: 'role',
      targetTeams: ['Customer Service'],
      targetRoleId: 'cs_head',
      rolePlayers: { cs_head: ['aisha'] },
      roleTeam: { cs_head: 'Customer Service' },
      roleFallback: 'none',
      holdersByTeam: { 'Customer Service': ['ben'] },
      teamMembers: { 'Customer Service': [{ user_id: 'aisha', is_bot: false }, { user_id: 'ben', is_bot: false }] },
      recipientsRingAll: null,
      online: () => false,
      busy: () => false,
      heldForRole: () => true,
      policy: DEFAULT_CALL_POLICY,
    });
    assert.equal(held[0]?.outcome, 'held');
    assert.equal(held[0]?.target_role_id, 'cs_head');
    assert.deepEqual(held[0]?.ring, []);
  });

  test('only the role player’s chat reply counts', () => {
    const attributed = attributeChatResponse({
      message: {
        id: 'm1',
        channel_id: 'ch',
        sender_id: 'ben',
        reply_to: null,
        created_at: '2026-11-27T10:05:00.000Z',
        sender_team: 'Customer Service',
        is_trainer: false,
      },
      openDeliveries: [
        {
          id: 'd1',
          ref_id: 'ref',
          chat_channel_id: 'ch',
          delivered_at: '2026-11-27T10:00:00.000Z',
          delivered_minute: 0,
          recipient_teams: ['Customer Service'],
          recipient_user_ids: ['aisha'],
          response_window_minutes: 15,
          first_response_at: null,
        },
      ],
      messageMinute: 5,
      defaultWindowMinutes: 15,
    });
    assert.deepEqual(attributed, []);
    const roleReply = attributeChatResponse({
      message: {
        id: 'm2',
        channel_id: 'ch',
        sender_id: 'aisha',
        reply_to: null,
        created_at: '2026-11-27T10:05:00.000Z',
        sender_team: 'Customer Service',
        is_trainer: false,
      },
      openDeliveries: [
        {
          id: 'd1',
          ref_id: 'ref',
          chat_channel_id: 'ch',
          delivered_at: '2026-11-27T10:00:00.000Z',
          delivered_minute: 0,
          recipient_teams: ['Customer Service'],
          recipient_user_ids: ['aisha'],
          response_window_minutes: 15,
          first_response_at: null,
        },
      ],
      messageMinute: 5,
      defaultWindowMinutes: 15,
    });
    assert.equal(roleReply[0]?.attribution, 'chat_heuristic');
  });
});
