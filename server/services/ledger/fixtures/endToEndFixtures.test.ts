import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { walkPastorChain, walkPastorMood } from './pastorScenario.js';
import { walkSupplier } from './supplierScenario.js';

describe('supplier email branches', () => {
  test('no reply: chaser at T+10, the supplier phones at T+15, the public complaint the minute the miss is visible', () => {
    const run = walkSupplier({ kind: 'none' });
    assert.deepEqual(
      run.published.map((item) => [item.minute, item.key]),
      [
        [10, 'supplier_4471_chaser'],
        [15, 'supplier_4471_call'],
        [16, 'supplier_4471_public'],
      ],
    );
    assert.deepEqual(run.cancelled, []);
  });

  test('a defensive reply at T+14 keeps the chaser and fires the legal escalation', () => {
    const run = walkSupplier({ kind: 'defensive', minute: 14 });
    assert.deepEqual(
      run.published.map((item) => [item.minute, item.key]),
      [
        [10, 'supplier_4471_chaser'],
        [14, 'supplier_4471_legal'],
      ],
    );
    assert.deepEqual(
      run.cancelled.map((item) => [item.minute, item.key]),
      [
        [14, 'supplier_4471_call'],
        [14, 'supplier_4471_thanks'],
      ],
    );
  });

  test('a good reply at T+12 keeps the chaser and fires the thank-you', () => {
    const run = walkSupplier({ kind: 'good', minute: 12 });
    assert.deepEqual(
      run.published.map((item) => [item.minute, item.key]),
      [
        [10, 'supplier_4471_chaser'],
        [12, 'supplier_4471_thanks'],
      ],
    );
    assert.deepEqual(
      run.cancelled.map((item) => [item.minute, item.key]),
      [
        [12, 'supplier_4471_call'],
        [12, 'supplier_4471_legal'],
      ],
    );
  });
});

describe('pastor escalation chain', () => {
  test('never answers: steps, two missed attempts, and the press inject at T+50', () => {
    const run = walkPastorChain(null);
    assert.equal(run.callRingSeconds, 45);
    assert.deepEqual(
      run.steps.map((step) => [step.minute, step.step, step.urgency, step.app]),
      [
        [15, 1, 'follow_up', 'email'],
        [20, 2, 'urgent', 'npc_dm'],
        [28, 3, 'final', 'phone_call'],
        [40, 4, 'escalated', 'email'],
      ],
    );
    assert.deepEqual(
      run.attempts.map((attempt) => [attempt.minute, attempt.attempt, attempt.of, attempt.state]),
      [
        [28, 1, 2, 'missed'],
        [30, 2, 2, 'missed'],
      ],
    );
    assert.equal(run.missedCountTrueAt, 30);
    assert.equal(run.stopped, null);
    assert.equal(run.pressMinute, 50);
  });

  test('a text back at T+18 stops the chain after step 1', () => {
    const run = walkPastorChain(18);
    assert.deepEqual(
      run.steps.map((step) => [step.minute, step.step, step.app]),
      [[15, 1, 'email']],
    );
    assert.deepEqual(run.attempts, []);
    assert.deepEqual(run.stopped, { minute: 18, reason: 'contact_elsewhere', afterStep: 1 });
    assert.equal(run.stoppedByStep1, true);
    assert.equal(run.pressMinute, null);
    assert.equal(run.missedCountTrueAt, null);
  });
});

describe('pastor mood ladder', () => {
  test('call-backs climb the ladder and the press inject fires at T+40', () => {
    const run = walkPastorMood();
    assert.deepEqual(
      run.attempts.map((attempt) => [attempt.minute, attempt.attempt, attempt.of, attempt.state]),
      [
        [10, 1, 3, 'missed'],
        [13, 2, 3, 'missed'],
        [16, 3, 3, 'missed'],
      ],
    );
    assert.equal(run.pressMinute, 40);
    assert.deepEqual(run.gaveUpConsequences, ['publish_inject', 'stop_chains', 'verdict_lock']);

    const early = run.callback(12);
    assert.equal(early.wait_minutes, 2);
    assert.equal(early.missed_calls, 1);
    assert.equal(early.rung, 'impatient');
    assert.equal(early.opening, "I've been trying to reach you.");

    const angry = run.callback(19);
    assert.equal(angry.wait_minutes, 9);
    assert.equal(angry.missed_calls, 3);
    assert.equal(angry.rung, 'angry');
    assert.equal(angry.opening, 'Finally. 9 minutes. Who is actually in charge?');

    const held = run.callback(25, 2);
    assert.equal(held.wait_minutes, 15);
    assert.equal(held.missed_calls, 3);
    assert.equal(held.unanswered_messages, 2);
    assert.equal(held.rung, 'angry');
    assert.equal(held.opening, 'Finally. 15 minutes. Who is actually in charge?');
    assert.match(held.block, /2 of your messages got no reply/);

    const done = run.callback(42);
    assert.equal(done.wait_minutes, 32);
    assert.equal(done.rung, 'gave_up');
    assert.equal(done.opening, "I stopped waiting. I've spoken to the press.");
  });
});
