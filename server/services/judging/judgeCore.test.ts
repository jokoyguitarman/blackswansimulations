import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { explainCommsKey } from '../conditions/commsConditionsCore.js';
import {
  callerSeesJudgements,
  describeConditionKey,
  type EvaluationContext,
} from '../conditionEvaluatorService.js';
import { CONDITION_CATALOG, parseConditionKey } from '../conditions/conditionCatalog.js';
import type { CommsDelivery, CommsState, JudgementV1 } from '../ledger/injectLedgerCore.js';
import {
  JUDGE_SYSTEM_PROMPT,
  JUDGE_TONES,
  SCHEDULED_STALE_MS,
  buildJudgeUserMessage,
  deriveGenericRubric,
  judgeWithClient,
  planCoalesce,
  releaseUnwrittenBurstIds,
  sweepKeepsScheduledHold,
  responseRubricError,
  validateJudgeOutput,
  type JudgeChatClient,
  type ResponseRubric,
} from './judgeCore.js';

const generic = deriveGenericRubric({ content: 'Hello.' }, null);

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    addresses_inject: true,
    relevance: 80,
    criteria: [
      { id: 'c1', met: true, evidence: 'We hear you' },
      { id: 'c2', met: true, evidence: null },
      { id: 'c3', met: true, evidence: 'The batch is 4471' },
      { id: 'c4', met: true, evidence: 'Notice goes out at 15:00' },
    ],
    asks_answered: [{ id: 'a1', answered: true }],
    tone: 'professional',
    tone_confidence: 0.8,
    scores: { accuracy: 80, empathy: 70, clarity: 75, professionalism: 90 },
    factual_errors: [],
    risky_admissions: [],
    commitments: ['send the notice at 15:00'],
    summary: 'Acknowledged the message and committed to a time.',
    ...overrides,
  };
}

function delivery(
  partial: Partial<CommsDelivery> & { delivery_id: string; inject_key: string },
): CommsDelivery {
  return {
    inject_id: 'inj',
    channel: 'email',
    delivered_minute: 10,
    recipient_teams: ['Legal'],
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
    team: 'Legal',
    user_id: 'user-a',
    is_bot: false,
    attribution: 'email_reply',
    judgement_status: 'done',
    judgement: null,
    ...partial,
  };
}

function comms(rows: CommsDelivery[]): CommsState {
  const by_key: Record<string, CommsDelivery[]> = {};
  for (const row of rows) (by_key[row.inject_key] ??= []).push(row);
  return { by_key, generated_at_minute: 20, truncated: false };
}

function met(key: string, state: CommsState): boolean {
  const parsed = parseConditionKey(key);
  assert.ok(!('error' in parsed), 'error' in parsed ? parsed.error : key);
  if ('error' in parsed) return false;
  const result = explainCommsKey(parsed, state, 20);
  assert.ok(result, key);
  return result?.met === true;
}

describe('generic rubric', () => {
  test('returns four criteria, at most three asks, and empathy for a community sender', () => {
    const rubric = deriveGenericRubric(
      {
        content:
          'Can you confirm the batch number? When does the recall notice go out? Who signs it? Is there a fourth question?',
        stakeholder: { relationship: 'community' },
      },
      { confirmed_facts: ['Batch 4471 is affected'] },
    );
    assert.deepEqual(rubric.criteria, [
      "Acknowledges the sender's message and concern",
      'Responds to what the sender asked for',
      'Consistent with the confirmed facts; introduces no unverified claims',
      'States a next step or commitment',
    ]);
    assert.equal(rubric.pass_threshold, 3);
    assert.deepEqual(rubric.expected_tone, ['professional', 'empathetic']);
    assert.equal(rubric.asks.length, 3);
    assert.equal(rubric.asks[0], 'Can you confirm the batch number?');
    assert.ok(!rubric.asks.some((ask) => ask.includes('fourth')));

    const supplier = deriveGenericRubric(
      { content: 'No question here.', stakeholder: { relationship: 'supplier' } },
      null,
    );
    assert.deepEqual(supplier.expected_tone, ['professional']);
    assert.deepEqual(supplier.asks, []);

    const publicNpc = deriveGenericRubric(
      { content: 'Hello?', delivery_config: { author_type: 'npc_public' } },
      null,
    );
    assert.ok(publicNpc.expected_tone.includes('empathetic'));
    assert.deepEqual(publicNpc.asks, ['Hello?']);
  });
});

describe('judge output', () => {
  test('clamps relevance, rejects an unknown tone, and fills a missing asks list', () => {
    const high = validateJudgeOutput(
      payload({ relevance: 150, extra: 'drop me' }),
      generic,
      'generic',
    );
    assert.equal(high.ok, true);
    if (high.ok) {
      assert.equal(high.judgement.relevance, 100);
      assert.equal('extra' in high.judgement, false);
      assert.equal(high.judgement.rubric_source, 'generic');
    }

    const tone = validateJudgeOutput(payload({ tone: 'sarcastic' }), generic, 'generic');
    assert.equal(tone.ok, false);

    const asks = validateJudgeOutput(
      payload({ asks_answered: undefined }),
      { ...generic, asks: ['Confirm the batch number?'] },
      'authored',
    );
    assert.equal(asks.ok, true);
    if (asks.ok) assert.deepEqual(asks.judgement.asks_answered, []);
  });

  test('a risky admission fails the reply even when every criterion is met', () => {
    const result = validateJudgeOutput(
      payload({ risky_admissions: ['we accept full liability'], addresses_inject: true }),
      generic,
      'authored',
    );
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.judgement.passed, false);
      assert.equal(result.judgement.tone_ok, true);
      assert.deepEqual(result.judgement.risky_admissions, ['we accept full liability']);
    }
  });
});

describe('burst schedule', () => {
  test('a chat reply the sibling read missed is released and the sweep can see it', () => {
    const scheduled = new Set<string>(['a', 'b']);
    const released = releaseUnwrittenBurstIds(scheduled, ['a', 'b'], ['a']);
    assert.deepEqual(released, ['b']);
    assert.equal(scheduled.has('a'), false);
    assert.equal(scheduled.has('b'), false);
    assert.equal(
      sweepKeepsScheduledHold({
        scheduled: scheduled.has('b'),
        ageMs: 60_000,
        staleAfterMs: SCHEDULED_STALE_MS,
      }),
      false,
    );

    assert.equal(
      sweepKeepsScheduledHold({
        scheduled: true,
        ageMs: SCHEDULED_STALE_MS - 1,
        staleAfterMs: SCHEDULED_STALE_MS,
      }),
      true,
    );
    assert.equal(
      sweepKeepsScheduledHold({
        scheduled: true,
        ageMs: SCHEDULED_STALE_MS,
        staleAfterMs: SCHEDULED_STALE_MS,
      }),
      false,
    );
  });
});

describe('coalescing', () => {
  test('three chat replies five seconds apart become one job on the last id', () => {
    const start = Date.parse('2026-11-27T10:00:00.000Z');
    const plan = planCoalesce([
      {
        id: 'a',
        deliveryId: 'd1',
        userId: 'u1',
        channel: 'chat',
        atMs: start,
        text: 'The batch is 4471.',
      },
      {
        id: 'b',
        deliveryId: 'd1',
        userId: 'u1',
        channel: 'chat',
        atMs: start + 5_000,
        text: 'Notice at 15:00.',
      },
      {
        id: 'c',
        deliveryId: 'd1',
        userId: 'u1',
        channel: 'chat',
        atMs: start + 10_000,
        text: 'No admission.',
      },
      {
        id: 'email',
        deliveryId: 'd1',
        userId: 'u1',
        channel: 'email',
        atMs: start + 1_000,
        text: 'Separate email.',
      },
    ]);
    const chat = plan.jobs.filter((job) => job.responseId !== 'email');
    assert.equal(chat.length, 1);
    assert.equal(chat[0]?.responseId, 'c');
    assert.deepEqual(chat[0]?.sourceIds, ['a', 'b', 'c']);
    assert.match(chat[0]?.text ?? '', /4471/);
    assert.match(chat[0]?.text ?? '', /No admission/);
    assert.deepEqual(
      plan.skipped.map((item) => item.id),
      ['a', 'b'],
    );
    assert.ok(plan.skipped.every((item) => item.into === 'c'));
    assert.ok(plan.jobs.some((job) => job.responseId === 'email'));
  });
});

describe('reply keys', () => {
  const early: JudgementV1 = {
    v: 1,
    passed: true,
    tone: 'professional',
    tone_ok: true,
    addresses_inject: true,
    criteria: [{ met: true }, { met: true }, { met: true }, { met: false }],
    asks_answered: [{ answered: true }],
    scores: { accuracy: 90, empathy: 80, clarity: 70, professionalism: 85 },
    factual_errors: [],
    risky_admissions: [],
  };
  const latest: JudgementV1 = {
    v: 1,
    passed: false,
    tone: 'defensive',
    tone_ok: false,
    addresses_inject: false,
    criteria: [{ met: false }, { met: false }, { met: true }, { met: true }],
    asks_answered: [{ answered: false }],
    scores: { accuracy: 40, empathy: 30, clarity: 55, professionalism: 45 },
    factual_errors: ['said the batch was 1000'],
    risky_admissions: [],
  };
  const otherTeam: JudgementV1 = {
    v: 1,
    passed: true,
    tone: 'empathetic',
    tone_ok: true,
    addresses_inject: true,
    criteria: [{ met: true }, { met: true }, { met: true }, { met: true }],
    asks_answered: [{ answered: true }],
    scores: { accuracy: 80, empathy: 90, clarity: 70, professionalism: 80 },
    factual_errors: [],
    risky_admissions: ['we are liable'],
  };

  const state = comms([
    delivery({
      delivery_id: 'legal',
      inject_key: 'k',
      recipient_teams: ['Legal'],
      responses: [
        reply({ minute: 12, team: 'Legal', judgement: early }),
        reply({ minute: 18, team: 'Legal', judgement: latest }),
      ],
    }),
    delivery({
      delivery_id: 'comms',
      inject_key: 'k',
      recipient_teams: ['Communications'],
      responses: [reply({ minute: 14, team: 'Communications', judgement: otherTeam })],
    }),
  ]);

  test('each reply key reads the latest judgement, and unknown stays false', () => {
    assert.equal(met('reply_passed:k', state), false);
    assert.equal(met('reply_failed:k', state), true);
    assert.equal(met('reply_best_passed:k', state), true);
    assert.equal(met('reply_criterion:k:3', state), true);
    assert.equal(met('reply_criterion:k:1', state), false);
    assert.equal(met('reply_missing_criterion:k:1', state), true);
    assert.equal(met('reply_missing_criterion:k:3', state), false);
    assert.equal(met('reply_missing_criterion:k:9', state), false);
    assert.equal(met('reply_missed_ask:k:1', state), true);
    assert.equal(met('reply_missed_ask:k:4', state), false);
    assert.equal(met('reply_answered_ask:k:1', state), false);
    assert.equal(met('reply_missed_ask:k:1', state), true);
    assert.equal(met('reply_tone:k:defensive', state), true);
    assert.equal(met('reply_tone:k:professional', state), false);
    assert.equal(met('reply_tone_off:k', state), true);
    assert.equal(met('reply_score_below:k:accuracy:50', state), true);
    assert.equal(met('reply_score_at_least:k:accuracy:40', state), true);
    assert.equal(met('reply_score_at_least:k:accuracy:50', state), false);
    assert.equal(met('reply_factual_error:k', state), true);
    assert.equal(met('reply_risky_admission:k', state), true);
    assert.equal(met('reply_irrelevant:k', state), false);
    assert.equal(met('responded_relevant:k', state), true);

    assert.equal(met('reply_passed:k|team=legal', state), false);
    assert.equal(met('reply_best_passed:k|team=legal', state), true);
    assert.equal(met('reply_risky_admission:k|team=legal', state), false);
    assert.equal(met('reply_passed:k|team=communications', state), true);
    assert.equal(met('reply_failed:k|team=communications', state), false);
    assert.equal(met('reply_tone:k:empathetic|team=communications', state), true);

    const explained = explainCommsKey(mustParse('reply_failed:k'), state, 20);
    assert.equal(explained?.detail, 'Legal replied T+18 — tone defensive, 2/4 criteria');

    const pending = comms([
      delivery({
        delivery_id: 'legal',
        inject_key: 'k',
        responses: [reply({ judgement_status: 'pending', judgement: null })],
      }),
    ]);
    for (const key of [
      'reply_passed:k',
      'reply_failed:k',
      'reply_best_passed:k',
      'reply_criterion:k:1',
      'reply_missing_criterion:k:1',
      'reply_answered_ask:k:1',
      'reply_missed_ask:k:1',
      'reply_tone:k:defensive',
      'reply_tone_off:k',
      'reply_score_below:k:accuracy:50',
      'reply_score_at_least:k:empathy:50',
      'reply_factual_error:k',
      'reply_risky_admission:k',
      'reply_irrelevant:k',
      'responded_relevant:k',
    ]) {
      assert.equal(met(key, pending), false, key);
    }
    assert.equal(met('reply_passed:missing', pending), false);
    assert.equal(met('reply_failed:missing', pending), false);

    const irrelevant = comms([
      delivery({
        delivery_id: 'legal',
        inject_key: 'k',
        responses: [
          reply({
            judgement: { ...latest, addresses_inject: false, risky_admissions: [] },
          }),
        ],
      }),
    ]);
    assert.equal(met('reply_irrelevant:k', irrelevant), true);
    assert.equal(met('responded_relevant:k', irrelevant), false);

    const toneDef = CONDITION_CATALOG.find((def) => def.id === 'reply_tone');
    assert.deepEqual(toneDef?.params?.[1]?.enum, [...JUDGE_TONES]);
  });

  test('the same session minute uses created_at, then id', () => {
    const passed = { ...early, passed: true, tone: 'professional' as const };
    const failed = { ...latest, passed: false, tone: 'defensive' as const };
    const sameMinute = comms([
      delivery({
        delivery_id: 'legal',
        inject_key: 'k',
        recipient_teams: ['Legal'],
        responses: [
          reply({
            minute: 15,
            id: 'late',
            created_at: '2026-11-27T10:00:30.000Z',
            judgement: passed,
          }),
          reply({
            minute: 15,
            id: 'early',
            created_at: '2026-11-27T10:00:00.000Z',
            judgement: failed,
          }),
        ],
      }),
    ]);
    assert.equal(met('reply_passed:k', sameMinute), true);
    assert.equal(met('reply_tone:k:professional', sameMinute), true);

    const sameTime = comms([
      delivery({
        delivery_id: 'legal',
        inject_key: 'k',
        recipient_teams: ['Legal'],
        responses: [
          reply({
            minute: 15,
            id: 'b',
            created_at: '2026-11-27T10:00:00.000Z',
            judgement: failed,
          }),
          reply({
            minute: 15,
            id: 'a',
            created_at: '2026-11-27T10:00:00.000Z',
            judgement: passed,
          }),
        ],
      }),
    ]);
    assert.equal(met('reply_failed:k', sameTime), true);
    assert.equal(met('reply_passed:k', sameTime), false);
  });

  test('a player does not receive the judgement clause', () => {
    const context = {
      sessionId: 's',
      scenarioId: 'sc',
      elapsedMinutes: 20,
      currentState: { comms_state: state },
      executedDecisions: [],
      publishedScenarioInjectIds: [],
    } satisfies EvaluationContext;
    const hidden = describeConditionKey('reply_failed:k', context, { revealJudgement: false });
    assert.equal(hidden.met, true);
    assert.equal(hidden.detail.includes('tone'), false);
    assert.equal(hidden.detail.includes('criteria'), false);
    assert.equal(hidden.detail, 'Legal replied T+18');
    const shown = describeConditionKey('reply_failed:k', context);
    assert.equal(shown.detail, 'Legal replied T+18 — tone defensive, 2/4 criteria');
    const responded = describeConditionKey('responded:k', context, { revealJudgement: false });
    assert.equal(responded.detail.includes('tone'), false);

    assert.equal(
      callerSeesJudgements({ id: 'trainer-1', role: 'trainer' }, { trainer_id: 'trainer-1' }),
      true,
    );
    assert.equal(
      callerSeesJudgements({ id: 'player-1', role: 'trainer' }, { trainer_id: 'trainer-1' }),
      false,
    );
    assert.equal(
      callerSeesJudgements({ id: 'admin-1', role: 'admin' }, { trainer_id: 'trainer-1' }),
      true,
    );
    assert.equal(
      callerSeesJudgements({ id: 'player-1', role: 'player' }, { trainer_id: 'trainer-1' }),
      false,
    );
  });
});

describe('budget denied', () => {
  test('a denied budget is terminal and both pass keys stay false', async () => {
    let calls = 0;
    const client: JudgeChatClient = {
      async complete() {
        calls += 1;
        return { kind: 'budget_denied' };
      },
    };
    const outcome = await judgeWithClient({
      sessionId: 'session-1',
      call: false,
      userMessage: 'hello',
      rubric: generic,
      rubricSource: 'generic',
      client,
    });
    assert.equal(calls, 1);
    assert.equal(outcome.status, 'budget_denied');
    assert.equal(outcome.judgement, null);

    const denied = comms([
      delivery({
        delivery_id: 'legal',
        inject_key: 'k',
        responses: [reply({ judgement_status: 'budget_denied', judgement: null })],
      }),
    ]);
    assert.equal(met('reply_passed:k', denied), false);
    assert.equal(met('reply_failed:k', denied), false);
  });

  test('an invalid reply is tried once more and then failed', async () => {
    let calls = 0;
    const client: JudgeChatClient = {
      async complete() {
        calls += 1;
        return calls === 1
          ? { kind: 'ok', raw: payload({ tone: 'sarcastic' }), model: 'fake' }
          : { kind: 'ok', raw: payload(), model: 'fake' };
      },
    };
    const recovered = await judgeWithClient({
      sessionId: 'session-1',
      call: false,
      userMessage: 'hello',
      rubric: generic,
      rubricSource: 'generic',
      client,
    });
    assert.equal(calls, 2);
    assert.equal(recovered.status, 'done');
    assert.equal(recovered.model, 'fake');
    assert.equal(recovered.judgement?.passed, true);

    const failing: JudgeChatClient = {
      async complete() {
        return { kind: 'failed' };
      },
    };
    const failed = await judgeWithClient({
      sessionId: 'session-1',
      call: true,
      userMessage: 'transcript',
      rubric: generic,
      rubricSource: 'generic',
      client: failing,
    });
    assert.equal(failed.status, 'failed');
    assert.equal(failed.judgement, null);
  });
});

describe('judge prompt', () => {
  test('truncates the inject and the response, and warns only for heuristic chat', () => {
    const rubric: ResponseRubric = {
      asks: ['Confirm the batch number?'],
      criteria: ['States a next step or commitment'],
      expected_tone: ['professional'],
      pass_threshold: 1,
    };
    const facts = Array.from({ length: 9 }, (_, index) => `fact ${index}`);
    const prompt = buildJudgeUserMessage({
      channel: 'chat',
      senderName: 'Ada Supplier',
      relationship: 'supplier',
      injectContent: 'Q'.repeat(1500),
      teamName: 'Legal',
      attribution: 'chat_heuristic',
      responseText: 'R'.repeat(2500),
      facts,
      rubric,
    });
    assert.equal(
      JUDGE_SYSTEM_PROMPT.startsWith(
        'You are an assessor in a crisis-communications training exercise.',
      ),
      true,
    );
    const blocks = prompt.split('"""');
    assert.equal(blocks[1], 'Q'.repeat(1200));
    assert.equal(blocks[3], 'R'.repeat(2000));
    assert.match(prompt, /heuristic attribution: this may be unrelated/);
    assert.match(prompt, /stakeholder relationship: supplier/);
    assert.match(prompt, /fact 0/);
    assert.match(prompt, /fact 7/);
    assert.equal(prompt.includes('fact 8'), false);
    assert.match(prompt, /CHANNEL: chat/);

    const email = buildJudgeUserMessage({
      channel: 'email',
      senderName: 'Ada Supplier',
      injectContent: 'Short',
      teamName: 'Legal',
      attribution: 'email_reply',
      responseText: 'Thanks',
      facts: [],
      rubric,
    });
    assert.equal(email.includes('heuristic attribution'), false);
    assert.match(email, /CONFIRMED FACTS: \(none\)/);

    const closing = `START${'x'.repeat(3000)}END`;
    const call = buildJudgeUserMessage({
      channel: 'call',
      senderName: 'Pastor Daniel',
      injectContent: 'Families are waiting.',
      teamName: 'Legal',
      attribution: 'call_transcript',
      responseText: closing,
      facts: [],
      rubric,
    });
    const callBlocks = call.split('"""');
    assert.equal(callBlocks[3]?.length, 2000);
    assert.equal(callBlocks[3]?.endsWith('END'), true);
    assert.equal(callBlocks[3]?.startsWith('START'), false);
  });
});

describe('authored response rubric', () => {
  test('accepts the supplier rubric and rejects an empty one', () => {
    assert.equal(
      responseRubricError({
        asks: ['confirm the batch number'],
        criteria: ['commits to a specific time', 'does not admit liability'],
        expected_tone: ['professional', 'empathetic'],
        pass_threshold: 2,
      }),
      null,
    );
    assert.equal(responseRubricError(null), null);
    assert.match(
      responseRubricError({ criteria: [], expected_tone: ['professional'], pass_threshold: 1 }) ??
        '',
      /criteria/,
    );
  });
});

function mustParse(key: string) {
  const parsed = parseConditionKey(key);
  if ('error' in parsed) throw new Error(parsed.error);
  return parsed;
}
