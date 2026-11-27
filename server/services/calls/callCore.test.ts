import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  ALMOST_GIVEN_UP,
  answerChannel,
  applyDecline,
  buildRealtimeInstructions,
  callbackScript,
  callerMissedCount,
  canTransition,
  DEFAULT_REALTIME_VOICES,
  deriveCallScript,
  formatTranscript,
  groupMissedCount,
  nextAttempt,
  normalizeStoredOpening,
  openingForAttempt,
  spokenOpeningFor,
  pickVoice,
  sweepTerminal,
  unseenMissedBadge,
  voiceAllowedByBudget,
  voicemailContents,
  type CallStatus,
  type CountedAttempt,
} from './callCore.js';
import { resolveCallRingSet, DEFAULT_CALL_POLICY } from './lineCore.js';

const chain: CallStatus[] = ['ringing', 'connecting', 'active', 'ended'];

describe('call state machine', () => {
  test('allows the live path and the terminal exits, and rejects going backwards', () => {
    for (let i = 0; i < chain.length - 1; i++) {
      assert.equal(canTransition(chain[i], chain[i + 1]), true);
    }
    assert.equal(canTransition('ringing', 'declined'), true);
    assert.equal(canTransition('ringing', 'missed'), true);
    assert.equal(canTransition('connecting', 'failed'), true);
    assert.equal(canTransition('active', 'active'), true);
    assert.equal(canTransition('ended', 'active'), false);
    assert.equal(canTransition('missed', 'connecting'), false);
  });

  test('one decline of two recipients stays ringing; both declines end it', () => {
    const first = applyDecline(['aisha', 'ben'], [], 'aisha');
    assert.equal(first.status, 'ringing');
    assert.deepEqual(first.declinedUserIds, ['aisha']);
    const second = applyDecline(['aisha', 'ben'], first.declinedUserIds, 'ben');
    assert.equal(second.status, 'declined');
  });
});

describe('call script and voice', () => {
  test('derives an opening, must-ask questions and at most four beats', () => {
    const script = deriveCallScript(
      'Hello, is this the team? Families are hearing the plant is closing. Is that true? Who will speak tonight? People will gather at the gate. Please confirm the time. One more sentence that must be dropped.',
    );
    assert.equal(script.opening, 'Hello, is this the team?');
    assert.equal(script.beats.length, 4);
    assert.equal(script.beats[0].must_ask, false);
    assert.equal(script.beats[1].must_ask, true);
    assert.equal(script.beats[1].say.includes('?'), true);
    assert.equal(script.closing, 'Please call me back when you can.');
    assert.equal(script.beats.some((beat) => beat.say.startsWith('One more')), false);
  });

  test('voice pick is stable and stays inside the configured list', () => {
    const first = pickVoice('stk_pastor_daniel');
    const again = pickVoice('stk_pastor_daniel');
    assert.equal(first, again);
    assert.ok(DEFAULT_REALTIME_VOICES.includes(first as (typeof DEFAULT_REALTIME_VOICES)[number]));
    assert.ok(DEFAULT_REALTIME_VOICES.includes(pickVoice('stk_regulator') as (typeof DEFAULT_REALTIME_VOICES)[number]));
  });
});

describe('realtime instructions and transcript', () => {
  test('instructions carry the beats, the closing and the withheld facts, and stay short', () => {
    const text = buildRealtimeInstructions({
      character: {
        name: 'Pastor Daniel',
        title: 'Pastor',
        organisation: "Johor Workers' Fellowship",
        orgName: 'Meridian',
        personality: 'Warm and persistent.',
        stance: 'protective of the workers',
        knowledge: Array.from({ length: 40 }, (_, i) => `Fact ${i} `.repeat(40)),
        willNotDisclose: ['the strike date', 'who funds the fellowship'],
        hardConstraints: ['do not invent a closure date'],
      },
      injectContent: 'Families think the plant is closing for good.',
      script: {
        opening: 'Hello, is this the response team?',
        beats: [
          { id: 'b1', say: 'Is the plant closing?', must_ask: true },
          { id: 'b2', say: 'Who speaks tonight?', must_ask: true },
        ],
        closing: 'Please call me back before 6pm.',
        language: 'en',
      },
      maxMinutes: 5,
      context: {
        kind: 'redial',
        attempt_no: 2,
        wait_minutes: 4,
        missed_calls: 1,
        unanswered_messages: 0,
        voicemails: 1,
      },
    });
    assert.ok(text.includes('[b1]'));
    assert.ok(text.includes('[b2]'));
    assert.ok(text.includes('Please call me back before 6pm.'));
    assert.ok(text.includes('the strike date'));
    assert.ok(text.includes('who funds the fellowship'));
    assert.ok(text.length <= 6000);
    const mentions = text.match(/simulation/gi) ?? [];
    assert.equal(mentions.length, 1);
    assert.ok(text.includes('Never say you are an AI, a simulation'));
  });

  test('the judge transcript keeps the end of the call', () => {
    const turns = [
      { speaker: 'npc' as const, text: 'A'.repeat(4000) },
      { speaker: 'player' as const, text: 'B'.repeat(4000) },
      { speaker: 'npc' as const, text: 'CLOSING-LINE' },
    ];
    const text = formatTranscript(turns);
    assert.ok(text.length <= 6000);
    assert.ok(text.endsWith('CALLER: CLOSING-LINE'));
    assert.ok(text.includes('PLAYER:'));
    assert.ok(text.includes('CALLER:'));
  });
});

describe('sweep and budget', () => {
  test('deadlines move ringing, connecting and active calls to their terminals', () => {
    const deadline = '2026-11-27T10:00:30.000Z';
    assert.equal(
      sweepTerminal({
        status: 'ringing',
        ringDeadlineAt: deadline,
        statusSince: '2026-11-27T10:00:00.000Z',
        maxSeconds: 300,
        nowMs: Date.parse('2026-11-27T10:00:31.000Z'),
      }),
      'missed',
    );
    assert.equal(
      sweepTerminal({
        status: 'connecting',
        ringDeadlineAt: deadline,
        statusSince: '2026-11-27T10:00:00.000Z',
        maxSeconds: 300,
        nowMs: Date.parse('2026-11-27T10:00:31.000Z'),
      }),
      'failed',
    );
    assert.equal(
      sweepTerminal({
        status: 'active',
        ringDeadlineAt: deadline,
        statusSince: '2026-11-27T10:00:00.000Z',
        maxSeconds: 300,
        nowMs: Date.parse('2026-11-27T10:06:01.000Z'),
      }),
      'ended_timeout',
    );
    assert.equal(
      sweepTerminal({
        status: 'active',
        ringDeadlineAt: deadline,
        statusSince: '2026-11-27T10:00:00.000Z',
        maxSeconds: 300,
        nowMs: Date.parse('2026-11-27T10:05:00.000Z'),
      }),
      null,
    );
  });

  test('concurrent-call and minute caps force text mode', () => {
    assert.equal(voiceAllowedByBudget({ activeCalls: 4, maxConcurrent: 4, usedSeconds: 0, maxMinutes: 60 }), false);
    assert.equal(
      voiceAllowedByBudget({ activeCalls: 0, maxConcurrent: 4, usedSeconds: 60 * 60, maxMinutes: 60 }),
      false,
    );
    assert.equal(voiceAllowedByBudget({ activeCalls: 1, maxConcurrent: 4, usedSeconds: 10, maxMinutes: 60 }), true);
    assert.equal(
      answerChannel({
        webrtc: true,
        mic: true,
        openAiKeyPresent: true,
        aiEnabled: true,
        budgetAllowsVoice: false,
      }),
      'text',
    );
  });
});

describe('redial planner', () => {
  const base = { max_attempts: 3, interval_minutes: 2, stop_on_contact: true };
  const quiet = {
    called_back: false,
    contacted_elsewhere_at_minute: null,
    chain_stopped: false,
    session_ended: false,
  };

  test('a miss and a decline both schedule the next attempt, and the last miss finishes the group', () => {
    assert.deepEqual(
      nextAttempt(
        { ...base, attempts: [{ attempt_no: 1, status: 'missed', ended_minute: 10, scheduled_for_minute: null }] },
        10,
        quiet,
      ),
      { action: 'schedule', attempt_no: 2, at_minute: 12 },
    );
    assert.deepEqual(
      nextAttempt(
        { ...base, attempts: [{ attempt_no: 1, status: 'declined', ended_minute: 10, scheduled_for_minute: null }] },
        10,
        quiet,
      ),
      { action: 'schedule', attempt_no: 2, at_minute: 12 },
    );
    assert.deepEqual(
      nextAttempt(
        {
          ...base,
          attempts: [
            { attempt_no: 1, status: 'missed', ended_minute: 10, scheduled_for_minute: null },
            { attempt_no: 2, status: 'missed', ended_minute: 12, scheduled_for_minute: 12 },
            { attempt_no: 3, status: 'missed', ended_minute: 14, scheduled_for_minute: 14 },
          ],
        },
        14,
        quiet,
      ),
      { action: 'finished' },
    );
  });

  test('an answer schedules nothing and does not cancel earlier attempts', () => {
    const plan = nextAttempt(
      {
        ...base,
        attempts: [
          { attempt_no: 1, status: 'missed', ended_minute: 10, scheduled_for_minute: null },
          { attempt_no: 2, status: 'ended', ended_minute: 12, scheduled_for_minute: 12, answered: true },
        ],
      },
      12,
      quiet,
    );
    assert.deepEqual(plan, { action: 'finished' });
  });

  test('contact elsewhere cancels the pending redial', () => {
    assert.deepEqual(
      nextAttempt(
        {
          ...base,
          attempts: [
            { attempt_no: 1, status: 'missed', ended_minute: 10, scheduled_for_minute: null },
            { attempt_no: 2, status: 'scheduled', ended_minute: null, scheduled_for_minute: 12 },
          ],
        },
        11,
        { ...quiet, contacted_elsewhere_at_minute: 11 },
      ),
      { action: 'cancel', reason: 'contacted_elsewhere' },
    );
  });

  test('a scheduled attempt that is already late rings once, and a second pass does not ring again', () => {
    const late = nextAttempt(
      {
        ...base,
        attempts: [
          { attempt_no: 1, status: 'missed', ended_minute: 10, scheduled_for_minute: null },
          { attempt_no: 2, status: 'scheduled', ended_minute: null, scheduled_for_minute: 12 },
          { attempt_no: 3, status: 'scheduled', ended_minute: null, scheduled_for_minute: 14 },
        ],
      },
      22,
      quiet,
    );
    assert.deepEqual(late, { action: 'ring', attempt_no: 2 });
    const after = nextAttempt(
      {
        ...base,
        attempts: [
          { attempt_no: 1, status: 'missed', ended_minute: 10, scheduled_for_minute: null },
          { attempt_no: 2, status: 'ringing', ended_minute: null, scheduled_for_minute: 12 },
        ],
      },
      22,
      quiet,
    );
    assert.equal(after.action, 'wait');
  });
});

describe('missed counts, voicemail and call-back', () => {
  test('group and caller counts, and the badge ignores seen and later-handled groups', () => {
    const attempts: CountedAttempt[] = [
      row('A', 'missed', '2026-11-27T10:00:00.000Z', false),
      row('A', 'missed', '2026-11-27T10:02:00.000Z', false),
      row('A', 'declined', '2026-11-27T10:04:00.000Z', false),
      row('B', 'missed', '2026-11-27T10:06:00.000Z', false),
      row('C', 'missed', '2026-11-27T09:00:00.000Z', true),
    ];
    assert.equal(groupMissedCount(attempts, 'A'), 3);
    assert.equal(callerMissedCount(attempts, 'stk_pastor'), 5);
    assert.equal(unseenMissedBadge(attempts, 'aisha', '2026-11-27T10:03:00.000Z'), 2);
    assert.equal(unseenMissedBadge(attempts, 'aisha', null), 4);
  });

  test('voicemail is one counted line, or one line per attempt', () => {
    const shared = {
      caller_name: 'Pastor Daniel',
      caller_number: '+60 9300 6062',
      opening: 'Hello, is this the response team?',
      attempts: [
        { status: 'missed', attempt_no: 1 },
        { status: 'missed', attempt_no: 2 },
        { status: 'declined', attempt_no: 3 },
      ],
      inject: { title: 'Welfare', content: 'Hello, is this the response team?' },
      config: { stakeholder_id: 'stk_pastor' },
    };
    const once = voicemailContents({ ...shared, voicemail_each: false, group_finished: true });
    assert.equal(once.length, 1);
    assert.ok(once[0].includes('3 missed calls'));
    const each = voicemailContents({ ...shared, voicemail_each: true, group_finished: false });
    assert.equal(each.length, 3);
    assert.ok(each.every((line) => line.startsWith('📞 Missed call from Pastor Daniel')));
  });

  test('a late call-back is still scripted, with the almost-given-up line', () => {
    const script = deriveCallScript('Hello, is this the response team? Is the plant closing?');
    const late = callbackScript(script, 45, 30);
    assert.ok(late.opening.includes(ALMOST_GIVEN_UP));
    const early = callbackScript(script, 10, 30);
    assert.equal(early.opening.includes(ALMOST_GIVEN_UP), false);
    assert.ok(openingForAttempt(script, 2, 'Pastor Daniel').startsWith("It's Pastor Daniel again"));
    const rung = 'Finally. 9 minutes. Who is actually in charge?';
    const reloaded = normalizeStoredOpening({
      opening: rung,
      redial_openings: ['old redial line'],
      mood_opening_applied: true,
    });
    assert.equal(reloaded.mood_opening_applied, true);
    assert.equal(reloaded.opening, rung);
    assert.equal(reloaded.redial_openings, undefined);
    assert.equal(spokenOpeningFor(reloaded, 3, 'Pastor Daniel'), rung);
  });
});

describe('ring set', () => {
  test('a multi-team call is one ring_all group per team', () => {
    const groups = resolveCallRingSet({
      mode: 'ring_all',
      targetTeams: ['Customer Service', 'Legal'],
      rolePlayers: {},
      roleTeam: {},
      roleFallback: 'none',
      holdersByTeam: {},
      teamMembers: {
        'Customer Service': [
          { user_id: 'aisha', is_bot: false },
          { user_id: 'bot', is_bot: true },
        ],
        Legal: [{ user_id: 'ben', is_bot: false }],
      },
      recipientsRingAll: ['aisha', 'ben', 'bot'],
      online: () => true,
      busy: (id) => id === 'ben',
      policy: DEFAULT_CALL_POLICY,
    });
    assert.equal(groups.length, 2);
    assert.equal(groups[0].line_team, 'Customer Service');
    assert.deepEqual(groups[0].ring, ['aisha']);
    assert.equal(groups[0].mode_used, 'ring_all');
    assert.equal(groups[1].line_team, 'Legal');
    assert.deepEqual(groups[1].call_waiting, ['ben']);
    assert.equal(groups[1].outcome, 'line_busy');
  });
});

function row(
  group: string,
  status: string,
  at: string,
  handled: boolean,
): CountedAttempt {
  return {
    call_group_id: group,
    caller_key: 'stk_pastor',
    status,
    ring_started_at: at,
    addressed_to: ['aisha'],
    group_answered: handled,
    group_called_back: false,
  };
}
