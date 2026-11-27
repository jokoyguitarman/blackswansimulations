import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parseEscalation, validateEscalation } from '../../shared/escalationAuthoring.ts';
import {
  applyPhoneDraft,
  escalationConfigFromDraft,
  escalationDraftFrom,
  redialDraftFrom,
  redialFieldErrors,
} from '../src/components/Scenario/chainEditorModel.ts';
import { escalationTimelineSentence } from '../src/components/Scenario/escalationTimelinePreview.ts';

const exampleA = {
  max_steps: 4,
  scope: 'per_team',
  stop_on: 'any_response',
  stop_on_contact: true,
  steps: [
    {
      after_minutes: 5,
      urgency: 'follow_up',
      app: 'same',
      content_mode: 'template',
      template: 'Following up on my email below. Could you confirm {ask}?',
    },
    {
      after_minutes: 5,
      urgency: 'urgent',
      app: 'npc_dm',
      content_mode: 'ai',
      brief: 'Short text message.',
    },
    {
      after_minutes: 8,
      urgency: 'final',
      app: 'phone_call',
      content_mode: 'template',
      redial: { attempts: 2, interval_minutes: 2 },
    },
    {
      after_minutes: 10,
      urgency: 'escalated',
      app: 'email',
      sender_stakeholder_id: 'stk_union_rep',
      cc_team: 'Executive',
      content_mode: 'template',
      template: 'Subject: Workers still waiting',
    },
  ],
  on_exhausted: { publish_inject_key: 'pastor_goes_public' },
};

describe('escalation timeline preview', () => {
  test('example A includes the call-group gap before the senior email and the press post', () => {
    const config = parseEscalation(exampleA);
    assert.ok(config);
    const sentence = escalationTimelineSentence(config, 'email', {
      senderName: (id) => (id === 'stk_union_rep' ? 'Union rep' : id),
      publishTitle: (key) => (key === 'pastor_goes_public' ? 'Pastor goes public' : key),
    });
    assert.equal(
      sentence,
      'T+0 root → +5 follow-up email → +10 text (urgent) → +18 call ×2 (final) → +30 Union rep emails Executive → +40 "Pastor goes public" (all relative to delivery; stops at the first reply)',
    );
  });

  test('max_steps past the authored list repeats the last step at final or higher', () => {
    const config = parseEscalation({
      max_steps: 3,
      steps: [{ after_minutes: 4, urgency: 'follow_up', app: 'email', content_mode: 'template' }],
    });
    assert.ok(config);
    assert.equal(
      escalationTimelineSentence(config, 'email'),
      'T+0 root → +4 follow-up email → +8 email (final) → +12 email (final) (all relative to delivery; stops at the first reply)',
    );
  });

  test('a repeated call step waits out every redial before the next ring', () => {
    const config = parseEscalation({
      max_steps: 2,
      steps: [
        {
          after_minutes: 8,
          urgency: 'final',
          app: 'phone_call',
          content_mode: 'template',
          redial: { attempts: 3, interval_minutes: 2 },
        },
      ],
    });
    assert.ok(config);
    assert.equal(
      escalationTimelineSentence(config, 'email'),
      'T+0 root → +8 call ×3 (final) → +20 call ×3 (final) (all relative to delivery; stops at the first reply)',
    );
  });

  test('the editor draft of example A saves the same chain the validator accepts', () => {
    const draft = escalationDraftFrom(exampleA, true);
    assert.equal(draft.enabled, true);
    assert.equal(draft.steps[2]?.redial_attempts, 2);
    assert.equal(draft.steps[3]?.cc_team, 'Executive');
    const saved = escalationConfigFromDraft(draft);
    const issues = validateEscalation({
      escalation: saved,
      rootApp: 'email',
      rootStakeholderId: 'stk_pastor_daniel',
      stakeholderIds: ['stk_pastor_daniel', 'stk_union_rep'],
      durationMinutes: 90,
      rootKey: 'pastor_welfare_email',
      rootTriggerMinute: 10,
      otherInjects: [
        { key: 'pastor_goes_public', trigger_time_minutes: null, condition_keys: [] },
        {
          key: 'supplier_chaser',
          trigger_time_minutes: null,
          condition_keys: ['email_unreplied:pastor_welfare_email:10'],
        },
      ],
    });
    assert.deepEqual(
      issues.filter((issue) => issue.level === 'error'),
      [],
    );
    assert.equal(issues.some((issue) => issue.level === 'warning'), true);
    assert.equal(
      escalationTimelineSentence(saved, 'email', {
        senderName: () => 'Union rep',
        publishTitle: () => 'Pastor goes public',
      }).includes('+18 call ×2 (final)'),
      true,
    );
  });
});

describe('phone redial draft', () => {
  test('extra rings are stored as attempts, and the default single ring omits redial', () => {
    const config: Record<string, unknown> = { app: 'phone_call' };
    applyPhoneDraft(
      config,
      'phone_call',
      {
        ring_seconds: 30,
        extra_rings: 2,
        interval_minutes: 2,
        stop_on_contact: true,
        voicemail_each: false,
      },
    );
    assert.equal(config.ring_seconds, 30);
    assert.deepEqual(config.redial, {
      attempts: 3,
      interval_minutes: 2,
      voicemail_each: false,
      stop_on_contact: true,
    });
    const round = redialDraftFrom(config);
    assert.equal(round.extra_rings, 2);
    applyPhoneDraft(config, 'phone_call', { ...round, extra_rings: 0, voicemail_each: false, stop_on_contact: true, interval_minutes: 2 });
    assert.equal(config.redial, undefined);
  });

  test('out of range ring and interval use the server messages', () => {
    assert.deepEqual(
      redialFieldErrors({
        ring_seconds: 5,
        extra_rings: 8,
        interval_minutes: 0,
        stop_on_contact: true,
        voicemail_each: false,
      }),
      [
        'ring_seconds must be an integer from 10 to 60.',
        'redial.attempts must be an integer from 1 to 6.',
        'redial.interval_minutes must be an integer from 1 to 30.',
      ],
    );
  });
});
