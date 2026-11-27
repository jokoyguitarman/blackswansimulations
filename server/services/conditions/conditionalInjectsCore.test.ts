import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validateConditionalInjects } from './conditionalInjectsCore.js';

describe('validateConditionalInjects', () => {
  test('drops an unknown key, reports a dangling inject, a cycle, and call_missed on an email', () => {
    const parent = {
      title: 'Supplier email',
      trigger_time_minutes: 8,
      delivery_config: { app: 'email', inject_key: 'supplier_4471' },
    };
    const chaser = {
      title: 'Chaser',
      delivery_config: { app: 'email', inject_key: 'chaser' },
      conditions_to_appear: { all: ['email_replied:supplier_4471', 'not_a_real_key'] },
      conditions_to_cancel: ['also_unknown'],
    };
    const dangling = {
      title: 'Dangling',
      delivery_config: { app: 'email', inject_key: 'dangling' },
      conditions_to_appear: { all: ['unresponded:no_such_inject:10'] },
    };
    const cycleA = {
      title: 'Cycle A',
      delivery_config: { app: 'email', inject_key: 'branch_a' },
      conditions_to_appear: { all: ['responded:branch_b'] },
    };
    const cycleB = {
      title: 'Cycle B',
      delivery_config: { app: 'email', inject_key: 'branch_b' },
      conditions_to_appear: { all: ['responded:branch_a'] },
    };
    const wrongApp = {
      title: 'Missed call on an email',
      delivery_config: { app: 'email', inject_key: 'wrong_app' },
      conditions_to_appear: { all: ['call_missed:supplier_4471'] },
    };
    const orphan = {
      title: 'Orphan branch',
      delivery_config: {
        app: 'email',
        inject_key: 'orphan',
        branch: 'no_reply',
        parent_inject_key: 'gone',
      },
      conditions_to_appear: { all: ['email_unreplied:gone:10'] },
    };

    const result = validateConditionalInjects({
      duration_minutes: 60,
      injects: [parent, chaser, dangling, cycleA, cycleB, wrongApp, orphan],
    });

    assert.deepEqual(chaser.conditions_to_appear, { all: ['email_replied:supplier_4471'] });
    assert.deepEqual(chaser.conditions_to_cancel, []);
    assert.equal(
      result.injects.some((inject) => inject.title === 'Orphan branch'),
      false,
    );

    const codes = result.issues.map((issue) => issue.code);
    assert.ok(codes.includes('MO-COND-002'), codes.join(','));
    assert.ok(
      result.issues.some(
        (issue) => issue.code === 'MO-COND-002' && issue.message.includes('no_such_inject'),
      ),
    );
    assert.ok(codes.includes('MO-COND-003'), codes.join(','));
    assert.ok(
      result.issues.some(
        (issue) =>
          issue.code === 'MO-COND-004' &&
          issue.message.includes('call_missed') &&
          issue.message.includes('email'),
      ),
      result.issues.map((issue) => issue.message).join('\n'),
    );
  });

  test('a phone script with more than 6 beats is an error', () => {
    const result = validateConditionalInjects({
      duration_minutes: 60,
      injects: [
        {
          title: 'Long call',
          delivery_config: {
            app: 'phone_call',
            inject_key: 'long_call',
            call_script: {
              opening: 'Hello',
              beats: Array.from({ length: 7 }, (_, index) => ({ id: `b${index}`, say: 'Again' })),
            },
          },
        },
      ],
    });
    assert.ok(result.issues.some((issue) => issue.code === 'MO-COND-008' && issue.severity === 'error'));
  });

  test('an inject whose conditions are all unknown is dropped', () => {
    const emptied = {
      title: 'All unknown',
      delivery_config: { app: 'email', inject_key: 'all_unknown' },
      conditions_to_appear: { all: ['not_a_real_key', 'also_fake'] },
    };
    const timed = {
      title: 'Timed beat',
      trigger_time_minutes: 12,
      delivery_config: { app: 'social_feed', inject_key: 'timed_beat' },
      conditions_to_appear: { all: ['not_a_real_key'] },
    };
    const result = validateConditionalInjects({
      duration_minutes: 60,
      injects: [emptied, timed],
    });
    assert.equal(
      result.injects.some((inject) => inject.title === 'All unknown'),
      false,
    );
    assert.equal(
      result.injects.some((inject) => inject.title === 'Timed beat'),
      true,
    );
    assert.equal(
      result.issues.some((issue) => issue.severity === 'error'),
      false,
    );
  });

  test('an npc_dm without a stakeholder is an error', () => {
    const result = validateConditionalInjects({
      duration_minutes: 60,
      injects: [
        {
          title: 'DM',
          delivery_config: { app: 'npc_dm', inject_key: 'dm_1' },
          conditions_to_appear: { all: ['dm_unanswered:dm_1:10'] },
        },
      ],
    });
    assert.ok(
      result.issues.some((issue) => issue.code === 'MO-COND-009' && issue.severity === 'error'),
    );
  });

  test('a generated npc_dm with no stakeholder is dropped instead of failing', () => {
    const result = validateConditionalInjects({
      duration_minutes: 60,
      injects: [
        {
          title: 'Generated DM',
          delivery_config: {
            app: 'npc_dm',
            inject_key: 'dm_branch',
            branch: 'no_reply',
            parent_inject_key: 'parent_email',
          },
          conditions_to_appear: { all: ['dm_unanswered:parent_email:10'] },
        },
        {
          title: 'Parent',
          trigger_time_minutes: 4,
          delivery_config: { app: 'email', inject_key: 'parent_email' },
        },
      ],
    });
    assert.equal(
      result.injects.some((inject) => inject.title === 'Generated DM'),
      false,
    );
    assert.ok(
      result.issues.some((issue) => issue.code === 'MO-COND-009' && issue.severity === 'warning'),
    );
    assert.equal(
      result.issues.some((issue) => issue.severity === 'error'),
      false,
    );
  });

  test('a generated phone branch with an out-of-range ring is clamped', () => {
    const call = {
      title: 'Generated call',
      delivery_config: {
        app: 'phone_call',
        inject_key: 'call_branch',
        branch: 'no_reply',
        parent_inject_key: 'parent_email',
        ring_seconds: 999,
        max_call_seconds: 5,
        redial: { attempts: 99, interval_minutes: 0 },
      },
      conditions_to_appear: { all: ['call_missed:call_branch'] },
    };
    const result = validateConditionalInjects({
      duration_minutes: 60,
      injects: [
        call,
        {
          title: 'Parent',
          trigger_time_minutes: 4,
          delivery_config: { app: 'email', inject_key: 'parent_email' },
        },
      ],
    });
    assert.equal(
      result.injects.some((inject) => inject.title === 'Generated call'),
      true,
    );
    assert.equal(call.delivery_config.ring_seconds, 60);
    assert.equal(call.delivery_config.max_call_seconds, 60);
    assert.equal(call.delivery_config.redial.attempts, 6);
    assert.equal(call.delivery_config.redial.interval_minutes, 1);
    assert.equal(
      result.issues.some((issue) => issue.severity === 'error'),
      false,
    );
    assert.ok(
      result.issues.some((issue) => issue.code === 'MO-COND-008' && issue.severity === 'warning'),
    );
  });
});
