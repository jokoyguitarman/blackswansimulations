import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildRealtimeInstructions, type CallScript } from '../calls/callCore.js';
import { parseConditionKey } from '../conditions/conditionCatalog.js';
import { evaluateCommsKey } from '../conditions/commsConditionsCore.js';
import type { CommsState } from '../ledger/injectLedgerCore.js';
import { enforceVerdict } from '../stakeholderReconsiderationService.js';
import { buildCharacterPrompt } from '../stakeholderReplyService.js';
import type { Stakeholder } from '../../lib/stakeholderContract.js';
import {
  buildMoodBlock,
  addPendingRecovery,
  applyPublishInject,
  claimConsequences,
  commitClaim,
  type ClaimState,
  computeWaitProfile,
  defaultLadderFor,
  moodLineFor,
  renderMoodPlaceholders,
  resolveGaveUpAfter,
  selectRung,
  validateMoodLadder,
  type MoodDeliveryFact,
  type MoodLadder,
  type WaitProfile,
} from './moodCore.js';

const WINDOW = 30;

function delivery(patch: Partial<MoodDeliveryFact> & Pick<MoodDeliveryFact, 'delivery_id'>): MoodDeliveryFact {
  return {
    stakeholder_id: 'pastor',
    channel: 'email',
    delivered_minute: 0,
    recipient_teams: ['Engagement'],
    line_team: 'Engagement',
    responses: [],
    ...patch,
  };
}

function profile(patch: Partial<WaitProfile> = {}): WaitProfile {
  return {
    at_minute: 0,
    episode_anchor_minute: null,
    wait_minutes: 0,
    missed_calls: 0,
    unanswered_messages: 0,
    followups_sent: 0,
    prior_tones: [],
    prior_failed: 0,
    prior_passed: 0,
    gave_up_after: WINDOW,
    ...patch,
  };
}

function ladder(variant: 'angry' | 'disappointed' = 'angry', recovery: MoodLadder['recovery'] = 'one_rung_per_good_reply'): MoodLadder {
  const base = defaultLadderFor(variant === 'angry' ? 'low' : 'medium');
  return { ...base, recovery };
}

describe('computeWaitProfile', () => {
  test('the episode anchor is the first unanswered delivery, and a reply opens the next one', () => {
    const rows = [
      delivery({ delivery_id: 'a', delivered_minute: 4, responses: [{ minute: 6, team: 'Engagement', user_id: 'p', judgement_status: 'pending' }] }),
      delivery({ delivery_id: 'b', delivered_minute: 10 }),
      delivery({ delivery_id: 'c', delivered_minute: 14, channel: 'call', call_state: 'missed' }),
    ];
    const open = computeWaitProfile({
      stakeholderId: 'pastor',
      scope: 'Engagement',
      atMinute: 18,
      deliveries: rows,
      gaveUpAfter: WINDOW,
    });
    assert.equal(open.episode_anchor_minute, 10);
    assert.equal(open.wait_minutes, 8);
    assert.equal(open.missed_calls, 1);
    assert.equal(open.unanswered_messages, 1);
  });

  test('missed and declined attempts count, and cancelled attempts do not', () => {
    const rows = [
      delivery({ delivery_id: 'm', channel: 'call', call_state: 'missed', delivered_minute: 1 }),
      delivery({ delivery_id: 'd', channel: 'call', call_state: 'declined', delivered_minute: 3 }),
      delivery({ delivery_id: 'c', channel: 'call', call_state: 'cancelled', delivered_minute: 2 }),
      delivery({ delivery_id: 's', channel: 'call', call_state: 'scheduled', delivered_minute: 5 }),
    ];
    const wait = computeWaitProfile({
      stakeholderId: 'pastor',
      scope: 'Engagement',
      atMinute: 6,
      deliveries: rows,
      gaveUpAfter: WINDOW,
    });
    assert.equal(wait.missed_calls, 2);
    assert.equal(wait.episode_anchor_minute, 1);
  });

  test('prior tones are the newest three, across episodes', () => {
    const tone = (id: string, minute: number, name: string, passed: boolean) =>
      delivery({
        delivery_id: id,
        delivered_minute: minute,
        responses: [{
          id,
          minute: minute + 1,
          team: 'Engagement',
          user_id: 'p',
          judgement_status: 'done',
          judgement: { tone: name, passed },
        }],
      });
    const wait = computeWaitProfile({
      stakeholderId: 'pastor',
      scope: 'Engagement',
      atMinute: 40,
      deliveries: [
        tone('t1', 1, 'neutral', true),
        tone('t2', 5, 'defensive', false),
        tone('t3', 9, 'dismissive', false),
        tone('t4', 12, 'hostile', false),
      ],
      gaveUpAfter: WINDOW,
    });
    assert.deepEqual(wait.prior_tones, ['hostile', 'dismissive', 'defensive']);
    assert.equal(wait.prior_failed, 3);
    assert.equal(wait.prior_passed, 0);
    assert.equal(wait.episode_anchor_minute, null);
  });

  test('the team scope isolates teams, and role waits skip held time', () => {
    const rows = [
      delivery({ delivery_id: 'eng', line_team: 'Engagement', recipient_teams: ['Engagement'], delivered_minute: 2 }),
      delivery({
        delivery_id: 'legal',
        line_team: 'Legal',
        recipient_teams: ['Legal'],
        channel: 'call',
        call_state: 'missed',
        delivered_minute: 2,
      }),
    ];
    const engagement = computeWaitProfile({
      stakeholderId: 'pastor',
      scope: 'Engagement',
      atMinute: 9,
      deliveries: rows,
      gaveUpAfter: WINDOW,
    });
    const legal = computeWaitProfile({
      stakeholderId: 'pastor',
      scope: 'Legal',
      atMinute: 9,
      deliveries: rows,
      gaveUpAfter: WINDOW,
    });
    assert.equal(engagement.missed_calls, 0);
    assert.equal(engagement.unanswered_messages, 1);
    assert.equal(legal.missed_calls, 1);
    assert.equal(legal.unanswered_messages, 0);
    const role = computeWaitProfile({
      stakeholderId: 'pastor',
      scope: 'role:cs_head',
      atMinute: 20,
      deliveries: [
        delivery({
          delivery_id: 'role',
          target_role_id: 'cs_head',
          line_team: 'Customer Service',
          delivered_minute: 5,
        }),
      ],
      gaveUpAfter: WINDOW,
      heldIntervals: [{ start: 8, end: 14 }],
      rolePlayerIds: ['aisha'],
    });
    assert.equal(role.wait_minutes, 9);
  });
});

describe('selectRung', () => {
  test('an empty profile stays on the base rung', () => {
    const selected = selectRung(ladder(), profile());
    assert.equal(selected.rung.id, 'calm');
  });

  test('one missed call is impatient, and a 12 minute wait is upset', () => {
    assert.equal(selectRung(ladder(), profile({ missed_calls: 1 })).rung.id, 'impatient');
    assert.equal(selectRung(ladder(), profile({ wait_minutes: 12 })).rung.id, 'upset');
  });

  test('the disappointed variant skips angry', () => {
    const selected = selectRung(ladder('disappointed'), profile({ missed_calls: 3, wait_minutes: 9 }));
    assert.equal(selected.rung.id, 'disappointed');
  });

  test('gave_up_after comes from the ladder, otherwise the callback window', () => {
    const overridden = { ...ladder(), gave_up_after_minutes: 45 };
    assert.equal(resolveGaveUpAfter(overridden, WINDOW), 45);
    assert.equal(resolveGaveUpAfter(ladder(), WINDOW), WINDOW);
    const early = selectRung(ladder(), profile({ wait_minutes: 32, gave_up_after: WINDOW }));
    const late = selectRung(overridden, profile({ wait_minutes: 32, gave_up_after: 45 }));
    assert.equal(early.rung.id, 'gave_up');
    assert.equal(late.rung.id, 'angry');
  });

  test('the terminal rung is sticky', () => {
    const selected = selectRung(ladder(), profile(), { rungId: 'gave_up', pendingRecoverySteps: 3 });
    assert.equal(selected.rung.id, 'gave_up');
    assert.equal(selected.reason, 'terminal');
  });

  test('recovery drops one rung, resets, or stays', () => {
    const calmProfile = profile();
    const one = selectRung(ladder(), calmProfile, { rungId: 'upset', pendingRecoverySteps: 1 });
    assert.equal(one.rung.id, 'impatient');
    const floor = selectRung(ladder(), calmProfile, { rungId: 'calm', pendingRecoverySteps: 1 });
    assert.equal(floor.rung.id, 'calm');
    const reset = selectRung(ladder('angry', 'reset_on_good_reply'), calmProfile, {
      rungId: 'upset',
      pendingRecoverySteps: 1,
    });
    assert.equal(reset.rung.id, 'calm');
    const none = selectRung(ladder('angry', 'none'), calmProfile, { rungId: 'upset', pendingRecoverySteps: 1 });
    assert.equal(none.rung.id, 'upset');
  });

  test('reset_on_good_reply stays down until the wait itself gets worse', () => {
    const baseline = { wait_minutes: 25, missed_calls: 3, unanswered_messages: 0, followups_sent: 0 };
    const high = profile({ wait_minutes: 25, missed_calls: 3 });
    const reset = selectRung(ladder('disappointed', 'reset_on_good_reply'), high, {
      rungId: 'disappointed',
      pendingRecoverySteps: 1,
      baseline,
    });
    assert.equal(reset.rung.id, 'calm');
    assert.equal(reset.hold, true);
    const sameTick = selectRung(ladder('disappointed', 'reset_on_good_reply'), high, {
      rungId: 'calm',
      baseline,
    });
    assert.equal(sameTick.rung.id, 'calm');
    const grew = selectRung(
      ladder('disappointed', 'reset_on_good_reply'),
      profile({ wait_minutes: 26, missed_calls: 3 }),
      { rungId: 'calm', baseline },
    );
    assert.equal(grew.rung.id, 'disappointed');
    assert.equal(grew.clearHold, true);
  });
});

describe('consequences and verdict lock', () => {
  test('entering gave_up twice fires publish_inject once', () => {
    const gaveUp = defaultLadderFor('low').rungs.find((item) => item.id === 'gave_up');
    assert.ok(gaveUp);
    const authored = {
      ...gaveUp,
      consequences: [{ type: 'publish_inject' as const, inject_key: 'pastor_goes_to_press' }, ...gaveUp.consequences],
    };
    const first = claimConsequences(authored, []);
    const second = claimConsequences(authored, first.next);
    assert.deepEqual(first.ids, ['gave_up:0', 'gave_up:1', 'gave_up:2']);
    assert.deepEqual(second.ids, []);
  });

  test('two writers claim different consequences and a later recovery keeps the verdict lock', () => {
    let live: ClaimState = { fired: [], locks: {} };
    const first = commitClaim(live, 'gave_up:0', { verdict: 'keep', verdict_rung: 'gave_up' });
    assert.equal(first.won, true);
    const second = commitClaim(first.state, 'gave_up:1', { stop_chains: true, grievance_append: ['They went to the press.'] });
    assert.equal(second.won, true);
    live = second.state;
    const again = commitClaim(live, 'gave_up:0', { verdict: 'keep', verdict_rung: 'gave_up' });
    assert.equal(again.won, false);
    assert.deepEqual(again.state.fired, ['gave_up:0', 'gave_up:1']);
    assert.equal(live.locks.verdict, 'keep');
    assert.equal(live.locks.stop_chains, true);
    const recovered = addPendingRecovery(live.locks);
    assert.equal(recovered.verdict, 'keep');
    assert.equal(recovered.pending_recovery_steps, 1);
    assert.deepEqual(recovered.grievance_append, ['They went to the press.']);
  });

  test('a failed publish releases the claim and the next attempt publishes once', () => {
    let attempts = 0;
    const failed = applyPublishInject({
      fired: [],
      id: 'gave_up:0',
      publish: () => {
        attempts += 1;
        return false;
      },
    });
    assert.equal(failed.published, false);
    assert.equal(failed.released, true);
    assert.deepEqual(failed.fired, []);
    const retried = applyPublishInject({
      fired: failed.fired,
      id: 'gave_up:0',
      publish: () => {
        attempts += 1;
        return true;
      },
    });
    assert.equal(retried.published, true);
    assert.deepEqual(retried.fired, ['gave_up:0']);
    const again = applyPublishInject({
      fired: retried.fired,
      id: 'gave_up:0',
      publish: () => {
        attempts += 1;
        return true;
      },
    });
    assert.equal(again.published, false);
    assert.equal(attempts, 2);
  });

  test('verdict_lock coerces cancel to keep', () => {
    const pending = {
      id: 'inj',
      title: 'Statement',
      content: 'We will comment at six.',
      type: 'email',
      trigger_time_minutes: 20,
      delivery_config: {},
    };
    const effective = {
      grievance: 'Ignored',
      resolution_criteria: ['apologise', 'name a time', 'name a person'],
      persuadability: 'high' as const,
      hard_constraints: [],
      source: 'base' as const,
      verdict_lock: { rung: 'angry' },
    };
    const locked = enforceVerdict(
      { verdict: 'cancel', reason: 'They apologised', criteria_met: [1, 2, 3] },
      pending,
      effective,
    );
    assert.equal(locked.verdict, 'keep');
    assert.equal(locked.reason, 'mood: angry');
  });
});

describe('buildMoodBlock', () => {
  const upset = ladder().rungs.find((item) => item.id === 'upset');
  assert.ok(upset);

  test('mentions only the facts that are non-zero and renders placeholders', () => {
    const block = buildMoodBlock(
      upset,
      profile({ wait_minutes: 19, unanswered_messages: 2, missed_calls: 0 }),
      { name: 'Officer' },
      { includeScript: true, recovery: 'one_rung_per_good_reply' },
    );
    assert.match(block, /19 minutes ago/);
    assert.match(block, /2 of your messages got no reply/);
    assert.equal(block.includes('calls went unanswered'), false);
    assert.match(block, /I've called you 0 times/);
    assert.equal(block.toLowerCase().includes('simulation'), false);
    assert.match(block, /Never say "Upset"/);
  });

  test('omits the script directions when includeScript is false', () => {
    const block = buildMoodBlock(upset, profile({ wait_minutes: 4 }), { name: 'Officer' }, { includeScript: false });
    assert.equal(block.includes('OPEN WITH'), false);
    assert.equal(block.includes('WORK THESE IN'), false);
    assert.match(block, /in your own words/);
  });

  test('the terminal rung says the decision stands', () => {
    const gaveUp = ladder().rungs.find((item) => item.id === 'gave_up');
    assert.ok(gaveUp);
    const block = buildMoodBlock(gaveUp, profile({ wait_minutes: 32 }), { name: 'Pastor' }, {
      includeScript: true,
      recovery: 'one_rung_per_good_reply',
    });
    assert.match(block, /Do not take it back/);
    assert.equal(block.includes('you may soften'), false);
  });
});

describe('mood on calls and replies', () => {
  const script: CallScript = {
    opening: 'Hello, is this the response team?',
    beats: [{ id: 'b1', say: 'Is the plant closing?', must_ask: true }],
    closing: 'Please call me back before 6pm.',
    language: 'en',
  };

  test('the rung opening replaces the call opening and the beats stay', () => {
    const rung = ladder().rungs.find((item) => item.id === 'impatient');
    assert.ok(rung);
    const facts = profile({ wait_minutes: 2, missed_calls: 1 });
    const opening = renderMoodPlaceholders(rung.script.opening ?? '', facts);
    const text = buildRealtimeInstructions({
      character: { name: 'Pastor Daniel', stance: 'urgent' },
      injectContent: 'The workers are still waiting.',
      script: { ...script, opening },
      maxMinutes: 5,
      context: { kind: 'callback', attempt_no: 1, wait_minutes: 2, missed_calls: 1, unanswered_messages: 0 },
      mood: buildMoodBlock(rung, facts, { name: 'Pastor Daniel' }, { includeScript: true, recovery: 'one_rung_per_good_reply' }),
    });
    assert.match(text, /I've been trying to reach you/);
    assert.match(text, /\[b1\] Is the plant closing\?/);
    assert.equal(text.includes('CALL CONTEXT'), false);
    assert.match(text, /YOUR MOOD RIGHT NOW: Impatient/);
  });

  test('a mood block follows the context, and a calm reply is unchanged', () => {
    const stakeholder = {
      name: 'Officer Tan',
      title: 'Inspector',
      organisation: 'MAS',
      relationship: 'regulator',
      personality: 'formal',
      stance: 'waiting',
      knowledge: ['The batch number'],
      will_not_disclose: [],
    } as unknown as Stakeholder;
    const ctx = { description: 'A plant closure.', org_name: 'Acme', fact_sheet: null };
    const plain = buildCharacterPrompt(stakeholder, [], ctx, { context: 'They have not written back.' });
    const same = buildCharacterPrompt(stakeholder, [], ctx, { context: 'They have not written back.' });
    assert.equal(plain, same);
    const rung = ladder('disappointed').rungs.find((item) => item.id === 'upset');
    assert.ok(rung);
    const block = buildMoodBlock(rung, profile({ wait_minutes: 19 }), { name: 'Officer Tan' }, { includeScript: false });
    const withMood = buildCharacterPrompt(stakeholder, [], ctx, {
      context: 'They have not written back.',
      mood: block,
    });
    assert.ok(withMood.indexOf('They have not written back.') < withMood.indexOf('YOUR MOOD RIGHT NOW'));
    assert.equal(withMood.includes(plain), false);
  });
});

describe('mood keys and ladder validation', () => {
  function state(): CommsState {
    return {
      by_key: {
        mas_query: [
          {
            delivery_id: 'd1',
            inject_id: 'i1',
            inject_key: 'mas_query',
            channel: 'email',
            delivered_minute: 8,
            recipient_teams: ['Engagement'],
            session_wide: false,
            stakeholder_id: 'stk_mas_officer',
            call_state: null,
            call_group_id: null,
            attempt_no: 1,
            chain_root_key: null,
            chain_step: null,
            urgency: null,
            mood_rung: null,
            opened_minute: null,
            first_response_minute: 27,
            first_response_team: 'Engagement',
            first_response_by_team: { Engagement: 27 },
            responses: [
              {
                minute: 27,
                team: 'Engagement',
                user_id: 'p',
                is_bot: false,
                attribution: 'email_reply',
                judgement_status: 'done',
                judgement: { passed: true, tone: 'professional' },
                wait_minutes: 19,
                mood_rung: 'upset',
              },
            ],
          },
        ],
        role_query: [
          {
            delivery_id: 'role-mail',
            inject_id: 'i2',
            inject_key: 'role_query',
            channel: 'email',
            delivered_minute: 8,
            recipient_teams: ['Engagement'],
            session_wide: false,
            stakeholder_id: 'stk_mas_officer',
            call_state: null,
            call_group_id: null,
            attempt_no: 1,
            chain_root_key: null,
            chain_step: null,
            urgency: null,
            mood_rung: null,
            target_role_id: 'cs_head',
            opened_minute: null,
            first_response_minute: 27,
            first_response_team: 'Engagement',
            first_response_by_team: { Engagement: 27 },
            responses: [
              {
                minute: 27,
                team: 'Engagement',
                user_id: 'aisha',
                is_bot: false,
                attribution: 'email_reply',
                judgement_status: 'done',
                judgement: { passed: true, tone: 'professional' },
                wait_minutes: 19,
                mood_rung: 'upset',
              },
            ],
          },
          {
            delivery_id: 'team-mail',
            inject_id: 'i2',
            inject_key: 'role_query',
            channel: 'email',
            delivered_minute: 4,
            recipient_teams: ['Legal'],
            session_wide: false,
            stakeholder_id: 'stk_mas_officer',
            call_state: null,
            call_group_id: null,
            attempt_no: 1,
            chain_root_key: null,
            chain_step: null,
            urgency: null,
            mood_rung: null,
            target_role_id: null,
            opened_minute: null,
            first_response_minute: 10,
            first_response_team: 'Legal',
            first_response_by_team: { Legal: 10 },
            responses: [
              {
                minute: 10,
                team: 'Legal',
                user_id: 'ben',
                is_bot: false,
                attribution: 'email_reply',
                judgement_status: 'done',
                judgement: { passed: false, tone: 'dismissive' },
                wait_minutes: 40,
                mood_rung: 'angry',
              },
            ],
          },
        ],
      },
      generated_at_minute: 30,
      truncated: false,
      moods: [
        {
          stakeholder_id: 'stk_mas_officer',
          scope_team: 'Engagement',
          rung_id: 'upset',
          rung_index: 2,
          ladder_ids: ['calm', 'impatient', 'upset', 'disappointed', 'gave_up'],
          history: [{ rung: 'calm' }, { rung: 'impatient' }, { rung: 'upset' }],
          terminal: false,
        },
        {
          stakeholder_id: 'pastor',
          scope_team: 'Engagement',
          rung_id: 'gave_up',
          rung_index: 4,
          ladder_ids: ['calm', 'impatient', 'upset', 'angry', 'gave_up'],
          history: [{ rung: 'gave_up' }],
          terminal: true,
        },
      ],
    };
  }

  function met(key: string, comms: CommsState): boolean {
    const parsed = parseConditionKey(key);
    assert.equal('error' in parsed, false);
    if ('error' in parsed) return false;
    return evaluateCommsKey(parsed, comms, 30) === true;
  }

  test('mood_at_least, mood_reached, gave up, replied_late and mood_at_reply', () => {
    const comms = state();
    assert.equal(met('mood_at_least:stk_mas_officer:impatient', comms), true);
    assert.equal(met('mood_at_least:stk_mas_officer:disappointed', comms), false);
    assert.equal(met('mood_reached:stk_mas_officer:impatient', comms), true);
    assert.equal(met('mood_is:stk_mas_officer:upset', comms), true);
    assert.equal(met('stakeholder_gave_up:pastor', comms), true);
    assert.equal(met('stakeholder_gave_up:stk_mas_officer', comms), false);
    assert.equal(met('replied_late:mas_query:15', comms), true);
    assert.equal(met('replied_late:mas_query:20', comms), false);
    assert.equal(met('mood_at_reply:mas_query:upset', comms), true);
    assert.equal(met('mood_at_least:stk_mas_officer:upset|team=legal', comms), false);
    assert.equal(met('replied_late:role_query:30|role=cs_head', comms), false);
    assert.equal(met('replied_late:role_query:15|role=cs_head', comms), true);
    assert.equal(met('mood_at_reply:role_query:upset|role=cs_head', comms), true);
    assert.equal(met('mood_at_reply:role_query:angry|role=cs_head', comms), false);
  });

  test('duplicate ids, a non-empty first when, a terminal rung that is not last, and too many lines', () => {
    const base = defaultLadderFor('low');
    const duplicate = validateMoodLadder({
      ladder: { ...base, rungs: base.rungs.map((item) => ({ ...item, id: 'calm' })) },
    });
    assert.ok(duplicate.some((issue) => issue.message.includes('Duplicate')));
    const firstWhen = validateMoodLadder({
      ladder: {
        ...base,
        rungs: base.rungs.map((item, index) => (index === 0 ? { ...item, when: { any: [{ wait_minutes_gte: 1 }] } } : item)),
      },
    });
    assert.ok(firstWhen.some((issue) => issue.message.includes('first rung')));
    const terminal = validateMoodLadder({
      ladder: {
        ...base,
        rungs: [base.rungs[base.rungs.length - 1], ...base.rungs.slice(0, -1)],
      },
    });
    assert.ok(terminal.some((issue) => issue.message.includes('terminal')));
    const lines = validateMoodLadder({
      ladder: {
        ...base,
        rungs: base.rungs.map((item, index) =>
          index === 0 ? { ...item, script: { opening: null, lines: ['a', 'b', 'c', 'd'] } } : item,
        ),
      },
    });
    assert.ok(lines.some((issue) => issue.message.includes('script lines')));
  });
});

describe('worked examples', () => {
  test('A. a call-back climbs the angry ladder and then gives up', () => {
    const authored = defaultLadderFor('low');
    const rows = (missed: number, emails = 0): MoodDeliveryFact[] => {
      const calls = Array.from({ length: missed }, (_, index) =>
        delivery({
          delivery_id: `call-${index}`,
          channel: 'call',
          call_state: 'missed',
          delivered_minute: 10 + index * 3,
        }),
      );
      const messages = Array.from({ length: emails }, (_, index) =>
        delivery({ delivery_id: `mail-${index}`, channel: 'email', delivered_minute: 11 + index }),
      );
      return [...calls, ...messages];
    };
    const at = (minute: number, missed: number, emails = 0) => {
      const wait = computeWaitProfile({
        stakeholderId: 'pastor',
        scope: 'Engagement',
        atMinute: minute,
        deliveries: rows(missed, emails),
        gaveUpAfter: 30,
      });
      const selected = selectRung(authored, wait, minute >= 25 ? { rungId: 'angry' } : null);
      const opening = selected.rung.script.opening
        ? renderMoodPlaceholders(selected.rung.script.opening, wait)
        : '';
      return { wait, rung: selected.rung.id, opening };
    };
    const early = at(12, 1);
    assert.equal(early.wait.wait_minutes, 2);
    assert.equal(early.wait.missed_calls, 1);
    assert.equal(early.rung, 'impatient');
    assert.equal(early.opening, "I've been trying to reach you.");
    const angry = at(19, 3);
    assert.equal(angry.wait.wait_minutes, 9);
    assert.equal(angry.wait.missed_calls, 3);
    assert.equal(angry.rung, 'angry');
    assert.equal(angry.opening, 'Finally. 9 minutes. Who is actually in charge?');
    const held = at(25, 3, 2);
    assert.equal(held.wait.wait_minutes, 15);
    assert.equal(held.wait.unanswered_messages, 2);
    assert.equal(held.rung, 'angry');
    assert.equal(held.opening, 'Finally. 15 minutes. Who is actually in charge?');
    const done = at(42, 3, 2);
    assert.equal(done.wait.wait_minutes, 32);
    assert.equal(done.rung, 'gave_up');
    assert.equal(done.opening, "I stopped waiting. I've spoken to the press.");
  });

  test('B. a late email is upset, then one good reply steps down', () => {
    const authored = defaultLadderFor('medium');
    const wait = computeWaitProfile({
      stakeholderId: 'stk_mas_officer',
      scope: 'Engagement',
      atMinute: 27,
      deliveries: [
        delivery({ delivery_id: 'root', stakeholder_id: 'stk_mas_officer', delivered_minute: 8 }),
        delivery({
          delivery_id: 'step',
          stakeholder_id: 'stk_mas_officer',
          delivered_minute: 18,
          chain_step: 1,
        }),
      ],
      gaveUpAfter: 30,
    });
    assert.equal(wait.wait_minutes, 19);
    assert.equal(wait.unanswered_messages, 2);
    assert.equal(wait.followups_sent, 1);
    const selected = selectRung(authored, wait);
    assert.equal(selected.rung.id, 'upset');
    const recovered = selectRung(authored, profile(), { rungId: 'upset', pendingRecoverySteps: 1 });
    assert.equal(recovered.rung.id, 'impatient');
    assert.equal(moodLineFor(authored, selected.rung, wait), 'Why did nobody pick up?');
  });

  test('C. an earlier dismissive tone reaches upset on a short wait', () => {
    const authored = defaultLadderFor('medium');
    const wait = computeWaitProfile({
      stakeholderId: 'union',
      scope: 'Engagement',
      atMinute: 16,
      deliveries: [
        delivery({
          delivery_id: 'first',
          stakeholder_id: 'union',
          delivered_minute: 5,
          responses: [{
            minute: 6,
            team: 'Engagement',
            user_id: 'p',
            judgement_status: 'done',
            judgement: { tone: 'dismissive', passed: false },
          }],
        }),
        delivery({ delivery_id: 'second', stakeholder_id: 'union', delivered_minute: 14 }),
      ],
      gaveUpAfter: 30,
    });
    assert.equal(wait.wait_minutes, 2);
    assert.deepEqual(wait.prior_tones, ['dismissive']);
    assert.equal(selectRung(authored, wait).rung.id, 'upset');
  });
});
