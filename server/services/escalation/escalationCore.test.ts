import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { explainCommsKey } from '../conditions/commsConditionsCore.js';
import { parseConditionKey } from '../conditions/conditionCatalog.js';
import { chainStepHeld } from '../roles/roleCore.js';
import type { CommsState } from '../ledger/injectLedgerCore.js';
import {
  applyUrgencyPrefix,
  decideChainAction,
  extractAsk,
  nextDueAfterSend,
  planStepMaterialisation,
  renderChainTemplate,
  resolveStep,
  runtimeStepInjectId,
  STEP_CLAIM_ABANDON_MS,
  urgencyEffects,
  validateEscalation,
  type ChainClock,
  type ChainResponseFact,
  type EscalationConfig,
  type TemplateVars,
} from './escalationCore.js';
import { sendStep, type ChainStepStore, type StepDraft } from './escalationService.js';

const config: EscalationConfig = {
  max_steps: 4,
  scope: 'per_team',
  stop_on: 'any_response',
  stop_on_contact: true,
  steps: [
    { after_minutes: 5, urgency: 'follow_up', app: 'same', content_mode: 'template' },
    { after_minutes: 5, urgency: 'urgent', app: 'npc_dm', content_mode: 'template' },
    { after_minutes: 8, urgency: 'final', app: 'phone_call', content_mode: 'template', redial: { attempts: 2, interval_minutes: 2 } },
    { after_minutes: 10, urgency: 'escalated', app: 'email', content_mode: 'template' },
  ],
};

function clock(overrides: Partial<ChainClock> = {}): ChainClock {
  return {
    scope: 'per_team',
    scope_team: 'Operations',
    scope_role: null,
    root_key: 'pastor_welfare_email',
    root_delivery_id: 'root-delivery',
    stakeholder_id: 'stk_pastor',
    stop_on: 'any_response',
    stop_on_contact: true,
    steps_sent: 0,
    max_steps: 4,
    last_step_delivered_minute: 10,
    next_due_minute: 15,
    waiting_on_call_group_id: null,
    hold_through_minute: null,
    root_minute: 10,
    root_app: 'email',
    config,
    ...overrides,
  };
}

function reply(overrides: Partial<ChainResponseFact> = {}): ChainResponseFact {
  return {
    id: 'resp-1',
    minute: 13,
    team: 'Operations',
    user_id: 'aisha',
    judgement_status: 'pending',
    judgement: null,
    delivery_id: 'root-delivery',
    inject_key: 'pastor_welfare_email',
    chain_step: null,
    chain_root_delivery_id: null,
    chain_root_key: null,
    recipient_teams: ['Operations'],
    fallback_reason: null,
    ...overrides,
  };
}

describe('decideChainAction', () => {
  test('step 1 waits at T+14 and sends at T+15', () => {
    assert.equal(decideChainAction({ chain: clock(), responses: [], contactMinute: null, callGroup: null, elapsed: 14, sessionStatus: 'in_progress', held: false }).kind, 'wait');
    const due = decideChainAction({ chain: clock(), responses: [], contactMinute: null, callGroup: null, elapsed: 15, sessionStatus: 'in_progress', held: false });
    assert.equal(due.kind, 'send');
    if (due.kind === 'send') assert.equal(due.stepNo, 1);
  });

  test('a reply to the root or a chain step stops, and team scope is respected', () => {
    const root = decideChainAction({
      chain: clock(),
      responses: [reply()],
      contactMinute: null,
      callGroup: null,
      elapsed: 13,
      sessionStatus: 'in_progress',
      held: false,
    });
    assert.deepEqual(root, { kind: 'stop', reason: 'response', responseId: 'resp-1', stoppedAfterStep: 0 });

    const chaser = decideChainAction({
      chain: clock({ steps_sent: 1 }),
      responses: [reply({ delivery_id: 'step-1', chain_step: 1, chain_root_delivery_id: 'root-delivery', chain_root_key: 'pastor_welfare_email', inject_key: 'pastor_welfare_email__s1' })],
      contactMinute: null,
      callGroup: null,
      elapsed: 18,
      sessionStatus: 'in_progress',
      held: false,
    });
    assert.equal(chaser.kind, 'stop');

    const otherTeam = decideChainAction({
      chain: clock(),
      responses: [reply({ team: 'Legal' })],
      contactMinute: null,
      callGroup: null,
      elapsed: 13,
      sessionStatus: 'in_progress',
      held: false,
    });
    assert.equal(otherTeam.kind, 'wait');

    const anyone = decideChainAction({
      chain: clock({ scope: 'any_recipient', scope_team: null, config: { ...config, scope: 'any_recipient' } }),
      responses: [reply({ team: 'Legal' })],
      contactMinute: null,
      callGroup: null,
      elapsed: 13,
      sessionStatus: 'in_progress',
      held: false,
    });
    assert.equal(anyone.kind, 'stop');
  });

  test('contact with the stakeholder elsewhere stops the chain', () => {
    const action = decideChainAction({
      chain: clock(),
      responses: [],
      contactMinute: 12,
      callGroup: null,
      elapsed: 12,
      sessionStatus: 'in_progress',
      held: false,
    });
    assert.equal(action.kind, 'stop');
    if (action.kind === 'stop') assert.equal(action.reason, 'contact_elsewhere');
  });

  test('a failed judgement resets the due minute and a passed one stops', () => {
    const failed = decideChainAction({
      chain: clock({ stop_on: 'passed_response', config: { ...config, stop_on: 'passed_response' } }),
      responses: [reply({ judgement_status: 'done', judgement: { passed: false } })],
      contactMinute: null,
      callGroup: null,
      elapsed: 13,
      sessionStatus: 'in_progress',
      held: false,
    });
    assert.deepEqual(failed, { kind: 'reset', nextDueMinute: 18 });

    const passed = decideChainAction({
      chain: clock({ stop_on: 'passed_response', config: { ...config, stop_on: 'passed_response' } }),
      responses: [reply({ judgement_status: 'done', judgement: { passed: true } })],
      contactMinute: null,
      callGroup: null,
      elapsed: 13,
      sessionStatus: 'in_progress',
      held: false,
    });
    assert.equal(passed.kind, 'stop');
    if (passed.kind === 'stop') assert.equal(passed.reason, 'passed_response');
  });

  test('an unjudged relevant reply waits two minutes, and an irrelevant one does not stop', () => {
    const chain = clock({ stop_on: 'relevant_response', next_due_minute: 30, config: { ...config, stop_on: 'relevant_response' } });
    const fresh = decideChainAction({
      chain,
      responses: [reply({ minute: 13 })],
      contactMinute: null,
      callGroup: null,
      elapsed: 14,
      sessionStatus: 'in_progress',
      held: false,
    });
    assert.equal(fresh.kind, 'wait');
    const aged = decideChainAction({
      chain,
      responses: [reply({ minute: 13 })],
      contactMinute: null,
      callGroup: null,
      elapsed: 15,
      sessionStatus: 'in_progress',
      held: false,
    });
    assert.equal(aged.kind, 'stop');
    const irrelevant = decideChainAction({
      chain,
      responses: [reply({ minute: 13, judgement_status: 'done', judgement: { addresses_inject: false } })],
      contactMinute: null,
      callGroup: null,
      elapsed: 20,
      sessionStatus: 'in_progress',
      held: false,
    });
    assert.equal(irrelevant.kind, 'wait');
  });

  test('a call step waits for redials, stops when answered, and counts the next due minute from the finish', () => {
    const waiting = clock({ steps_sent: 3, waiting_on_call_group_id: 'group-1', next_due_minute: null });
    const pending = decideChainAction({
      chain: waiting,
      responses: [],
      contactMinute: null,
      callGroup: { finished: false, finish_minute: null, answered: false },
      elapsed: 28,
      sessionStatus: 'in_progress',
      held: false,
    });
    assert.equal(pending.kind, 'wait');
    const answered = decideChainAction({
      chain: waiting,
      responses: [],
      contactMinute: null,
      callGroup: { finished: false, finish_minute: null, answered: true },
      elapsed: 28,
      sessionStatus: 'in_progress',
      held: false,
    });
    assert.equal(answered.kind, 'stop');
    const finished = decideChainAction({
      chain: waiting,
      responses: [],
      contactMinute: null,
      callGroup: { finished: true, finish_minute: 30, answered: false },
      elapsed: 30,
      sessionStatus: 'in_progress',
      held: false,
    });
    assert.equal(finished.kind, 'wait');
    if (finished.kind === 'wait') {
      assert.equal(finished.lastStepMinute, 30);
      assert.equal(finished.nextDueMinute, 40);
    }
  });

  test('a short ladder repeats the last step at final urgency and then exhausts', () => {
    const short: EscalationConfig = {
      max_steps: 3,
      scope: 'per_team',
      stop_on: 'any_response',
      stop_on_contact: false,
      steps: [{ after_minutes: 5, urgency: 'follow_up', app: 'same', content_mode: 'template' }],
    };
    const second = resolveStep(short, 2, 'email');
    const third = resolveStep(short, 3, 'email');
    assert.equal(second?.urgency, 'final');
    assert.equal(second?.repeated, true);
    assert.equal(third?.urgency, 'final');
    assert.equal(resolveStep(short, 1, 'email')?.urgency, 'follow_up');
    const base = clock({ config: short, max_steps: 3, steps_sent: 3, last_step_delivered_minute: 20, next_due_minute: 25, stakeholder_id: null, stop_on_contact: false });
    assert.equal(decideChainAction({ chain: base, responses: [], contactMinute: null, callGroup: null, elapsed: 24, sessionStatus: 'in_progress', held: false }).kind, 'wait');
    assert.equal(decideChainAction({ chain: base, responses: [], contactMinute: null, callGroup: null, elapsed: 25, sessionStatus: 'in_progress', held: false }).kind, 'exhaust');
  });

  test('an overdue chain sends one step and the next due minute is counted from now', () => {
    const action = decideChainAction({
      chain: clock({ next_due_minute: 15 }),
      responses: [],
      contactMinute: null,
      callGroup: null,
      elapsed: 30,
      sessionStatus: 'in_progress',
      held: false,
    });
    assert.equal(action.kind, 'send');
    if (action.kind === 'send') assert.equal(action.stepNo, 1);
    assert.equal(
      nextDueAfterSend({ elapsed: 30, nextDueMinute: 15, sentAfterMinutes: 5, followingAfterMinutes: 5 }),
      35,
    );
  });

  test('a role chain is held while every role player is offline', () => {
    const held = chainStepHeld({ roleTargeted: true, allPlayersOfflinePastGrace: true });
    assert.equal(held, true);
    const action = decideChainAction({
      chain: clock({ scope_role: 'cs_head', next_due_minute: 15 }),
      responses: [],
      contactMinute: null,
      callGroup: null,
      elapsed: 14,
      sessionStatus: 'in_progress',
      held,
    });
    assert.equal(action.kind, 'wait');
    if (action.kind === 'wait') {
      assert.equal(action.held, true);
      assert.equal(action.nextDueMinute, 16);
    }
    assert.equal(chainStepHeld({ roleTargeted: true, allPlayersOfflinePastGrace: false }), false);
  });
});

describe('follow-up text and urgency', () => {
  test('placeholders render, an unknown one is dropped, and ask falls back', () => {
    const vars: TemplateVars = {
      sender_name: 'Pastor Daniel',
      recipient_team: 'Stakeholder Engagement',
      original_subject: 'Workers waiting',
      ask: '',
      minutes_waiting: 8,
      root_minute: 10,
      followups_sent: 1,
      missed_calls: 2,
      step: 2,
      max_steps: 4,
    };
    const text = renderChainTemplate(
      'Hello {sender_name}, {ask} after {minutes_waiting} from T+{root_minute}. {not_a_thing}',
      vars,
    );
    assert.equal(text, 'Hello Pastor Daniel, an answer after 8 from T+10. ');
    assert.equal(extractAsk('Families are waiting. Is the plant closing?', 'Welfare'), 'Is the plant closing?');
    assert.equal(extractAsk('No question here.', ''), 'an answer');
  });

  test('urgency prefixes are not doubled and email priority maps', () => {
    assert.equal(applyUrgencyPrefix('URGENT: Already', 'URGENT: '), 'URGENT: Already');
    assert.equal(applyUrgencyPrefix('Need an answer', 'URGENT: '), 'URGENT: Need an answer');
    assert.equal(urgencyEffects('follow_up').emailPriority, 'normal');
    assert.equal(urgencyEffects('urgent').emailPriority, 'high');
    assert.equal(urgencyEffects('final').emailPriority, 'urgent');
    assert.equal(urgencyEffects('escalated').notificationPriority, 'high');
    assert.equal(urgencyEffects('reminder').notificationPriority, 'low');
    assert.equal(urgencyEffects('urgent').ringSecondsExtra, 10);
  });
});

describe('chain condition keys', () => {
  test('each chain key respects team and role scope', () => {
    const chains = {
      pastor_welfare_email: [
        {
          chain_id: 'legal',
          scope_team: 'Legal',
          scope_role: null,
          status: 'active' as const,
          steps_sent: 2,
          max_steps: 4,
          max_urgency: 'urgent' as const,
          stopped_reason: null,
          stopped_minute: null,
          stopped_after_step: null,
        },
        {
          chain_id: 'ops',
          scope_team: 'Operations',
          scope_role: null,
          status: 'stopped' as const,
          steps_sent: 1,
          max_steps: 4,
          max_urgency: 'follow_up' as const,
          stopped_reason: 'response',
          stopped_minute: 18,
          stopped_after_step: 1,
        },
        {
          chain_id: 'role',
          scope_team: 'Customer Service',
          scope_role: 'cs_head',
          status: 'exhausted' as const,
          steps_sent: 3,
          max_steps: 3,
          max_urgency: 'final' as const,
          stopped_reason: null,
          stopped_minute: null,
          stopped_after_step: null,
        },
      ],
    };
    const state: CommsState = { by_key: {}, generated_at_minute: 40, truncated: false, chains };
    const met = (key: string) => {
      const parsed = parseConditionKey(key);
      assert.equal('error' in parsed, false);
      if ('error' in parsed) return false;
      return explainCommsKey(parsed, state, 40)?.met === true;
    };
    assert.equal(met('chain_active:pastor_welfare_email|team=legal'), true);
    assert.equal(met('chain_active:pastor_welfare_email|team=operations'), false);
    assert.equal(met('chain_stopped:pastor_welfare_email|team=operations'), true);
    assert.equal(met('chain_stopped:pastor_welfare_email|team=legal'), false);
    assert.equal(met('chain_exhausted:pastor_welfare_email|role=cs_head'), true);
    assert.equal(met('chain_exhausted:pastor_welfare_email|team=legal'), false);
    assert.equal(met('chain_step_reached:pastor_welfare_email:2|team=legal'), true);
    assert.equal(met('chain_step_reached:pastor_welfare_email:2|team=operations'), false);
    assert.equal(met('followups_sent_gte:pastor_welfare_email:4'), true);
    assert.equal(met('followups_sent_gte:pastor_welfare_email:3|team=legal'), false);
    assert.equal(met('chain_stopped_by_step:pastor_welfare_email:1|team=operations'), true);
    assert.equal(met('urgency_reached:pastor_welfare_email:urgent|team=legal'), true);
    assert.equal(met('urgency_reached:pastor_welfare_email:final|team=legal'), false);
    assert.equal(met('urgency_reached:pastor_welfare_email:final|role=cs_head'), true);
  });
});

describe('escalation validation', () => {
  test('decreasing urgency and a step with no stakeholder are errors, and a double chaser is a warning', () => {
    const decreasing = validateEscalation({
      escalation: {
        max_steps: 2,
        steps: [
          { after_minutes: 5, urgency: 'urgent', app: 'email' },
          { after_minutes: 5, urgency: 'follow_up', app: 'email' },
        ],
      },
      rootApp: 'email',
      rootStakeholderId: 'stk_pastor',
      stakeholderIds: ['stk_pastor'],
      durationMinutes: 90,
      rootKey: 'pastor_welfare_email',
      rootTriggerMinute: 10,
      otherInjects: [],
    });
    assert.ok(decreasing.some((issue) => issue.level === 'error' && /decreases/.test(issue.message)));

    const missing = validateEscalation({
      escalation: {
        max_steps: 1,
        steps: [{ after_minutes: 5, urgency: 'follow_up', app: 'npc_dm' }],
      },
      rootApp: 'email',
      rootStakeholderId: null,
      stakeholderIds: [],
      durationMinutes: 90,
      rootKey: 'k',
      rootTriggerMinute: 10,
      otherInjects: [],
    });
    assert.ok(missing.some((issue) => issue.level === 'error' && /stakeholder/.test(issue.message)));

    const chaser = validateEscalation({
      escalation: {
        max_steps: 1,
        steps: [{ after_minutes: 5, urgency: 'follow_up', app: 'same' }],
      },
      rootApp: 'email',
      rootStakeholderId: 'stk_pastor',
      stakeholderIds: ['stk_pastor'],
      durationMinutes: 90,
      rootKey: 'pastor_welfare_email',
      rootTriggerMinute: 10,
      otherInjects: [
        {
          key: 'pastor_goes_public',
          trigger_time_minutes: null,
          condition_keys: ['unresponded:pastor_welfare_email:15'],
        },
      ],
    });
    assert.ok(chaser.some((issue) => issue.level === 'warning'));
    assert.equal(chaser.some((issue) => issue.level === 'error'), false);
  });
});

describe('planStepMaterialisation', () => {
  test('a lost claim does not create a second inject while the owner is still publishing', () => {
    assert.equal(
      planStepMaterialisation({ claim: 'lost', existingInjectId: null, stepAgeMs: 0 }),
      'stop',
    );
    assert.equal(
      planStepMaterialisation({
        claim: 'lost',
        existingInjectId: null,
        stepAgeMs: STEP_CLAIM_ABANDON_MS - 1,
      }),
      'stop',
    );
    assert.equal(planStepMaterialisation({ claim: 'won', existingInjectId: null, stepAgeMs: null }), 'create');
    assert.equal(
      planStepMaterialisation({ claim: 'lost', existingInjectId: 'already', stepAgeMs: 0 }),
      'publish_existing',
    );
    assert.equal(
      planStepMaterialisation({
        claim: 'lost',
        existingInjectId: null,
        stepAgeMs: STEP_CLAIM_ABANDON_MS,
      }),
      'resume',
    );
  });

  test('the runtime inject id is stable for a chain step and different for the next step', () => {
    const chainId = '11111111-1111-4111-8111-111111111111';
    const first = runtimeStepInjectId(chainId, 1);
    assert.equal(runtimeStepInjectId(chainId, 1), first);
    assert.notEqual(runtimeStepInjectId(chainId, 2), first);
    assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe('sendStep', () => {
  test('two sends of the same step create one runtime inject', async () => {
    const created: string[] = [];
    let injectId: string | null = null;
    let claimed = false;
    const store: ChainStepStore = {
      async claim() {
        if (claimed) return 'exists';
        claimed = true;
        return 'claimed';
      },
      async existingStep() {
        return { injectId, ageMs: 0 };
      },
      async insertInject(row) {
        injectId = String(row.id);
        created.push(injectId);
        return 'inserted';
      },
      async attachInject() {
        return true;
      },
      async publish() {},
    };
    const draft: StepDraft = {
      chainId: '11111111-1111-4111-8111-111111111111',
      stepNo: 1,
      urgency: 'follow_up',
      app: 'email',
      contentMode: 'template',
      inject: { title: 'Following up' },
    };
    const first = await sendStep(draft, store);
    const second = await sendStep(draft, store);
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.injectId, first.injectId);
    assert.equal(created.length, 1);
  });

  test('a sender that loses the claim before inject_id is written does not publish', async () => {
    let inserted = 0;
    let published = 0;
    const store: ChainStepStore = {
      async claim() {
        return 'exists';
      },
      async existingStep() {
        return { injectId: null, ageMs: 1_000 };
      },
      async insertInject() {
        inserted += 1;
        return 'inserted';
      },
      async attachInject() {
        return true;
      },
      async publish() {
        published += 1;
      },
    };
    const result = await sendStep(
      {
        chainId: '11111111-1111-4111-8111-111111111111',
        stepNo: 1,
        urgency: 'follow_up',
        app: 'email',
        contentMode: 'template',
        inject: { title: 'Following up' },
      },
      store,
    );
    assert.deepEqual(result, { created: false, injectId: null });
    assert.equal(inserted, 0);
    assert.equal(published, 0);
  });
});
