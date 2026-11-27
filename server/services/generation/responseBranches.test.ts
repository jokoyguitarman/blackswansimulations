import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { catalogPromptBlock } from '../conditions/conditionCatalog.js';
import { validateConditionalInjects } from '../conditions/conditionalInjectsCore.js';
import type { SocialInject } from '../socialCrisisGeneratorService.js';
import {
  generateResponseBranches,
  responseBranchChatOptions,
  type ResponseBranchClient,
} from './responseBranchService.js';
import {
  coverageReport,
  postProcessResponseBranches,
  type BranchParent,
} from './responseBranchesCore.js';

const supplierParent: BranchParent = {
  inject_key: 'supplier_4471',
  title: 'Batch 4471 is on hold',
  app: 'email',
  content: 'We cannot ship batch 4471 until you confirm the recall. When does the notice go out?',
  window_minutes: 15,
  target_teams: ['Ops'],
  stakeholder_id: 'stk_supplier',
  relationship: 'supplier',
};

/** Recorded model output for the §8.3 supplier example. No network. */
const supplierFixture = {
  branches: [
    {
      parent_inject_key: 'supplier_4471',
      branch: 'no_reply',
      title: 'Chaser',
      content: 'I still have not heard back about batch 4471. Please confirm today.',
      type: 'email_inbound',
      delivery_config: { app: 'email', inject_key: 'supplier_4471_chaser' },
      conditions_to_appear: { all: ['email_unreplied:supplier_4471:10'] },
      conditions_to_cancel: ['email_replied:supplier_4471'],
      eligible_after_minutes: 0,
    },
    {
      parent_inject_key: 'supplier_4471',
      branch: 'no_reply',
      title: 'Supplier phones',
      content: 'This is Priya. I emailed about batch 4471 and nobody answered.',
      type: 'phone_call',
      delivery_config: { app: 'phone_call', inject_key: 'supplier_4471_call' },
      conditions_to_appear: { all: ['email_unreplied:supplier_4471:15'] },
      conditions_to_cancel: ['email_replied:supplier_4471'],
      eligible_after_minutes: 0,
    },
    {
      parent_inject_key: 'supplier_4471',
      branch: 'no_reply',
      title: 'Public complaint',
      content: 'They will not even answer their supplier. Batch 4471 is still in limbo.',
      type: 'social_post',
      delivery_config: { app: 'social_feed', inject_key: 'supplier_4471_public' },
      conditions_to_appear: {
        all: ['email_unreplied:supplier_4471:15', 'call_missed:supplier_4471_call'],
      },
      conditions_to_cancel: [],
      eligible_after_minutes: 0,
    },
    {
      parent_inject_key: 'supplier_4471',
      branch: 'poor_reply',
      title: 'Escalates to legal',
      content: 'Your reply dodged the deadline. Our counsel will write to yours.',
      type: 'email_inbound',
      delivery_config: { app: 'email', inject_key: 'supplier_4471_legal' },
      conditions_to_appear: { all: ['reply_tone:supplier_4471:defensive'] },
      conditions_to_cancel: ['reply_best_passed:supplier_4471'],
      eligible_after_minutes: 0,
    },
    {
      parent_inject_key: 'supplier_4471',
      branch: 'good_reply',
      title: 'Thanks',
      content: 'Thank you. We will hold the line until the recall notice goes out.',
      type: 'email_inbound',
      delivery_config: { app: 'email', inject_key: 'supplier_4471_thanks' },
      conditions_to_appear: { all: ['reply_passed:supplier_4471'] },
      conditions_to_cancel: ['reply_failed:supplier_4471'],
      eligible_after_minutes: 0,
    },
  ],
  rubrics: [
    {
      inject_key: 'supplier_4471',
      asks: ['confirm the batch number', 'state when the recall notice goes out'],
      criteria: [
        "acknowledges the supplier's deadline",
        'commits to a specific time',
        'does not admit liability',
      ],
      expected_tone: ['professional', 'empathetic'],
      pass_threshold: 2,
    },
  ],
};

describe('catalogPromptBlock', () => {
  test('email and call keys are included and war-room keys are not', () => {
    const block = catalogPromptBlock(['email', 'call']);
    assert.match(block, /email_unreplied:<inject_key>:<N>/);
    assert.match(block, /call_missed:<inject_key>/);
    assert.equal(block.includes('crowd_density_above_0.6'), false);
    assert.equal(block.includes('no_media_management_decision'), false);
    assert.equal(block.includes('sentiment_below_30'), false);
  });
});

describe('response branch post-processing', () => {
  test('a missing cancel is filled and an invalid app becomes the parent app', () => {
    const processed = postProcessResponseBranches(
      {
        branches: [
          {
            parent_inject_key: 'supplier_4471',
            branch: 'no_reply',
            title: 'Chaser',
            content: 'Any update on batch 4471?',
            delivery_config: { app: 'carrier_pigeon' },
            conditions_to_appear: { all: ['email_unreplied:supplier_4471:10'] },
          },
        ],
      },
      [supplierParent],
      60,
    );
    assert.equal(processed.branches.length, 1);
    const branch = processed.branches[0];
    assert.equal(branch.delivery_config?.app, 'email');
    assert.deepEqual(branch.conditions_to_cancel, ['email_replied:supplier_4471']);
    assert.deepEqual(branch.conditions_to_appear, {
      all: ['email_unreplied:supplier_4471:10'],
    });
  });
});

describe('coverage report', () => {
  test('counts conditional injects per delivery app and names the gaps', () => {
    const report = coverageReport([
      {
        title: 'Ambient post',
        trigger_time_minutes: 5,
        delivery_config: { app: 'social_feed' },
      },
      {
        title: 'Team chat',
        trigger_time_minutes: 6,
        delivery_config: { app: 'group_chat' },
      },
      {
        title: 'Chaser',
        delivery_config: { app: 'email' },
        conditions_to_appear: { all: ['email_unreplied:k:10'] },
      },
      {
        title: 'Ring',
        delivery_config: { app: 'phone_call' },
        conditions_to_appear: { all: ['call_missed:k'] },
      },
    ]);
    assert.equal(report.by_platform.email, 1);
    assert.equal(report.by_platform.phone_call, 1);
    assert.equal(report.by_platform.social_feed, 0);
    assert.equal(report.by_platform.group_chat, 0);
    assert.ok(report.gaps.includes('social_feed'));
    assert.ok(report.gaps.includes('group_chat'));
    assert.equal(report.gaps.includes('email'), false);
  });
});

describe('supplier reference example', () => {
  test('a recorded fixture reproduces the branches with no network', async () => {
    const requests: Array<{ system: string; user: string }> = [];
    const client: ResponseBranchClient = {
      async complete(request) {
        requests.push(request);
        return supplierFixture;
      },
    };
    const parent: SocialInject = {
      trigger_time_minutes: 8,
      type: 'email_inbound',
      title: supplierParent.title,
      content: supplierParent.content,
      severity: 'high',
      inject_scope: 'team_specific',
      target_teams: ['Ops'],
      requires_response: true,
      response_deadline_minutes: 15,
      delivery_config: {
        app: 'email',
        inject_key: 'supplier_4471',
        stakeholder_id: 'stk_supplier',
        from_name: 'Priya Raman',
        from_address: 'priya@supplier.sim',
      },
    };
    const result = await generateResponseBranches(
      [parent],
      [{ id: 'stk_supplier', name: 'Priya Raman', relationship: 'supplier' }],
      { confirmed_facts: ['Batch 4471 failed a quality check'], unconfirmed_claims: [] },
      { crisisType: 'product recall', duration: 60, country: 'Singapore', context: 'batch 4471' },
      { client },
    );

    assert.equal(requests.length, 1);
    assert.match(requests[0].system, /email_unreplied:<inject_key>:<N>/);
    assert.equal(requests[0].system.includes('crowd_density_above_0.6'), false);
    assert.match(requests[0].user, /supplier_4471/);
    assert.equal(result.branches.length, 5);

    const byTitle = new Map(result.branches.map((branch) => [branch.title, branch]));
    const chaser = byTitle.get('Chaser');
    const phone = byTitle.get('Supplier phones');
    const complaint = byTitle.get('Public complaint');
    const legal = byTitle.get('Escalates to legal');
    const thanks = byTitle.get('Thanks');
    assert.ok(chaser && phone && complaint && legal && thanks);

    assert.equal(chaser.delivery_config.app, 'email');
    assert.deepEqual(chaser.conditions_to_appear, { all: ['email_unreplied:supplier_4471:10'] });
    assert.deepEqual(chaser.conditions_to_cancel, ['email_replied:supplier_4471']);

    assert.equal(phone.delivery_config.app, 'phone_call');
    assert.equal(phone.delivery_config.inject_key, 'supplier_4471_call');
    assert.deepEqual(phone.conditions_to_appear, { all: ['email_unreplied:supplier_4471:15'] });
    assert.deepEqual(phone.conditions_to_cancel, ['email_replied:supplier_4471']);

    assert.equal(complaint.delivery_config.app, 'social_feed');
    assert.deepEqual(complaint.conditions_to_appear, {
      all: ['email_unreplied:supplier_4471:15', 'call_missed:supplier_4471_call'],
    });
    assert.deepEqual(complaint.conditions_to_cancel, []);

    assert.equal(legal.delivery_config.app, 'email');
    assert.deepEqual(legal.conditions_to_appear, { all: ['reply_tone:supplier_4471:defensive'] });
    assert.deepEqual(legal.conditions_to_cancel, ['reply_best_passed:supplier_4471']);

    assert.equal(thanks.delivery_config.app, 'email');
    assert.deepEqual(thanks.conditions_to_appear, { all: ['reply_passed:supplier_4471'] });
    assert.deepEqual(thanks.conditions_to_cancel, ['reply_failed:supplier_4471']);

    const rubric = parent.delivery_config.response_rubric;
    assert.ok(rubric);
    assert.equal(rubric.criteria.length, 3);
    assert.equal(rubric.pass_threshold, 2);
    assert.deepEqual(rubric.asks, [
      'confirm the batch number',
      'state when the recall notice goes out',
    ]);

    const validated = validateConditionalInjects({
      duration_minutes: 60,
      injects: [parent, ...result.branches],
    });
    assert.deepEqual(
      validated.issues.filter((issue) => issue.severity === 'error'),
      [],
    );
    assert.deepEqual(validated.issues, []);
  });

  test('batches parents into one call per 10', async () => {
    const parents: SocialInject[] = Array.from({ length: 11 }, (_, index) => ({
      type: 'email_inbound',
      title: `Parent ${index}`,
      content: 'Please confirm the batch?',
      severity: 'high',
      inject_scope: 'team_specific',
      target_teams: ['Ops'],
      requires_response: true,
      delivery_config: { app: 'email' },
    }));
    let calls = 0;
    const client: ResponseBranchClient = {
      async complete() {
        calls += 1;
        return { branches: [], rubrics: [] };
      },
    };
    await generateResponseBranches(
      parents,
      [],
      { confirmed_facts: [], unconfirmed_claims: [] },
      { crisisType: 'recall', duration: 60 },
      { client },
    );
    assert.equal(calls, 2);
    for (const parent of parents) {
      assert.equal(parent.delivery_config.response_rubric?.criteria.length, 4);
    }
  });
});

describe('response branch chat options', () => {
  test('uses the standard tier, JSON, and the responseBranches label', () => {
    const options = responseBranchChatOptions('system', 'user');
    assert.equal(options.tier, 'standard');
    assert.equal(options.json, true);
    assert.equal(options.label, 'generator.responseBranches');
  });
});
