import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  buildCommsResponsesSection,
  emptyCommsResponses,
  isUnappliedSchema,
  type CommsResponsesInput,
} from './aarCommsResponses.js';

const sample: CommsResponsesInput = {
  names: { 'ops-player': 'Aisha' },
  injects: [
    {
      id: 'inj-supplier',
      title: 'Supplier batch 4471',
      inject_key: 'supplier_4471',
      requires_response: true,
      app: 'email',
    },
    {
      id: 'inj-public',
      title: 'Public complaint',
      inject_key: 'supplier_4471_public',
      app: 'social_feed',
      conditions_to_appear: { all: ['email_unreplied:supplier_4471:15', 'call_missed:supplier_4471_call'] },
    },
  ],
  deliveries: [
    {
      id: 'del-1',
      inject_id: 'inj-supplier',
      inject_key: 'supplier_4471',
      channel: 'email',
      delivered_minute: 0,
      recipient_teams: ['Ops'],
      sender_name: 'Supplier 4471',
      requires_response: true,
      first_opened_minute: 4,
      first_opened_by: 'ops-player',
    },
    {
      id: 'del-step',
      inject_id: 'inj-step',
      inject_key: 'supplier_4471__s1',
      channel: 'email',
      delivered_minute: 10,
      requires_response: false,
      chain_root_key: 'supplier_4471',
      chain_step: 1,
      urgency: 'follow_up',
    },
  ],
  responses: [
    {
      delivery_id: 'del-1',
      inject_key: 'supplier_4471',
      channel: 'email',
      user_id: 'ops-player',
      team_name: 'Ops',
      response_minute: 14,
      judgement_status: 'done',
      judgement: { tone: 'defensive', passed: false, summary: 'Deflected the deadline' },
      wait_minutes: 14,
      mood_rung: 'upset',
    },
  ],
  calls: [
    {
      id: 'call-1',
      inject_id: 'inj-supplier',
      call_group_id: 'group-1',
      attempt_no: 1,
      max_attempts: 2,
      status: 'missed',
      minute: 28,
    },
  ],
  chains: [
    {
      id: 'chain-1',
      root_key: 'supplier_4471',
      status: 'exhausted',
      steps_sent: 1,
      max_steps: 2,
      stopped_minute: 40,
    },
  ],
  steps: [
    {
      chain_id: 'chain-1',
      step_no: 1,
      urgency: 'follow_up',
      app: 'email',
      delivered_minute: 10,
    },
  ],
  moods: [
    {
      stakeholder_id: 'stk_supplier',
      scope_team: 'Ops',
      rung_id: 'upset',
      history: [
        { rung: 'calm', minute: 0 },
        { rung: 'upset', minute: 14, reason: 'late reply' },
      ],
      consequences_fired: ['upset:0'],
    },
  ],
  events: [{ event_type: 'inject', minute: 16, inject_id: 'inj-public' }],
};

describe('comms response timeline', () => {
  test('the section lists delivery, reply, judgement, branch, chain step, attempt and mood', () => {
    const section = buildCommsResponsesSection(sample);
    assert.equal(section.response_injects, 1);
    const events = section.timeline.map((row) => `${row.minute}|${row.event}|${row.detail}`);
    assert.ok(events.some((row) => row.startsWith('0|delivered|')));
    assert.ok(events.includes('4|opened|opened'));
    assert.ok(
      section.timeline.some(
        (row) =>
          row.event === 'responded' &&
          row.minute === 14 &&
          row.who === 'Aisha · Ops' &&
          row.channel === 'email' &&
          row.detail.includes('tone defensive') &&
          row.detail.includes('failed') &&
          row.detail.includes('waited 14 min') &&
          row.detail.includes('mood upset'),
      ),
    );
    assert.ok(
      section.timeline.some(
        (row) => row.event === 'branch' && row.parent === 'supplier_4471' && row.detail === 'published: Public complaint',
      ),
    );
    assert.ok(
      section.timeline.some(
        (row) => row.event === 'chain_step' && row.detail === 'step 1 of 2 · follow_up · email',
      ),
    );
    assert.ok(section.timeline.some((row) => row.event === 'call_attempt' && row.detail === 'missed · attempt 1 of 2'));
    assert.equal(section.moods[0]?.history, 'calm at T+0 → upset at T+14');
    assert.equal(section.moods[0]?.consequences, 'upset:0');
    assert.ok(section.timeline.some((row) => row.event === 'mood' && row.detail === 'upset · late reply'));
    assert.ok(section.timeline.some((row) => row.event === 'consequence' && row.detail === 'upset:0'));
  });

  test('missing calls and moods drop those rows; a chain step on the delivery remains', () => {
    const section = buildCommsResponsesSection({
      ...sample,
      calls: null,
      chains: null,
      steps: null,
      moods: null,
      events: [],
    });
    assert.equal(section.response_injects, 1);
    assert.equal(section.moods.length, 0);
    assert.ok(section.timeline.some((row) => row.event === 'delivered'));
    assert.equal(section.timeline.some((row) => row.event === 'call_attempt'), false);
    assert.equal(section.timeline.some((row) => row.event === 'mood'), false);
    assert.ok(section.timeline.some((row) => row.event === 'chain_step' && row.detail.includes('follow_up')));
  });

  test('an empty session is still a section', () => {
    assert.deepEqual(buildCommsResponsesSection({}), emptyCommsResponses());
  });

  test('unapplied migrations are the schema codes and nothing else', () => {
    for (const code of ['42P01', '42703', 'PGRST204', 'PGRST205']) {
      assert.equal(isUnappliedSchema({ code }), true);
    }
    assert.equal(isUnappliedSchema({ code: '23505' }), false);
    assert.equal(isUnappliedSchema(null), false);
  });
});
