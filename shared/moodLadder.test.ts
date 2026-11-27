import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  buildMoodBlock,
  defaultLadderFor,
  moodLineFor,
  moodPreviewLine,
  renderMoodPlaceholders,
  resolveGaveUpAfter,
  selectRung,
  validateMoodLadder,
  type MoodLadder,
  type WaitProfile,
} from './moodLadder.js';

const WINDOW = 30;

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

function ladder(
  variant: 'angry' | 'disappointed' = 'angry',
  recovery: MoodLadder['recovery'] = 'one_rung_per_good_reply',
): MoodLadder {
  const base = defaultLadderFor(variant === 'angry' ? 'low' : 'medium');
  return { ...base, recovery };
}

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
    const selected = selectRung(
      ladder('disappointed'),
      profile({ missed_calls: 3, wait_minutes: 9 }),
    );
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
    const none = selectRung(ladder('angry', 'none'), calmProfile, {
      rungId: 'upset',
      pendingRecoverySteps: 1,
    });
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
    const block = buildMoodBlock(upset, profile({ wait_minutes: 4 }), { name: 'Officer' }, {
      includeScript: false,
    });
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

describe('ladder validation', () => {
  test('duplicate ids, a non-empty first when, a terminal rung that is not last, and too many lines', () => {
    const base = defaultLadderFor('low');
    const duplicate = validateMoodLadder({
      ladder: { ...base, rungs: base.rungs.map((item) => ({ ...item, id: 'calm' })) },
    });
    assert.ok(duplicate.some((issue) => issue.message.includes('Duplicate')));
    const firstWhen = validateMoodLadder({
      ladder: {
        ...base,
        rungs: base.rungs.map((item, index) =>
          index === 0 ? { ...item, when: { any: [{ wait_minutes_gte: 1 }] } } : item,
        ),
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

  test('a press consequence must name a conditional inject', () => {
    const base = defaultLadderFor('low');
    const withPress = {
      ...base,
      rungs: base.rungs.map((item) =>
        item.id === 'gave_up'
          ? {
              ...item,
              consequences: [
                { type: 'publish_inject' as const, inject_key: 'pastor_goes_to_press' },
                ...item.consequences,
              ],
            }
          : item,
      ),
    };
    const missing = validateMoodLadder({
      ladder: withPress,
      knownInjects: [{ key: 'other', conditional: true }],
    });
    assert.ok(missing.some((issue) => issue.message.includes('does not exist')));
    const timed = validateMoodLadder({
      ladder: withPress,
      knownInjects: [{ key: 'pastor_goes_to_press', conditional: false }],
    });
    assert.ok(timed.some((issue) => issue.message.includes('conditional')));
    const ok = validateMoodLadder({
      ladder: withPress,
      knownInjects: [{ key: 'pastor_goes_to_press', conditional: true }],
    });
    assert.equal(ok.length, 0);
  });
});

describe('editor preview and worked ladder rows', () => {
  test('the default preview profile lands on Upset and renders the opening', () => {
    const preview = moodPreviewLine(
      defaultLadderFor('low'),
      profile({ wait_minutes: 14, missed_calls: 2, unanswered_messages: 1 }),
    );
    assert.equal(preview.id, 'upset');
    assert.equal(preview.label, 'Upset');
    assert.equal(preview.opening, "I've called you 2 times. People here feel ignored.");
    assert.match(preview.block, /YOUR MOOD RIGHT NOW: Upset/);
    assert.match(preview.block, /OPEN WITH/);
  });

  test('A. call-back profiles climb the angry ladder and then give up', () => {
    const authored = defaultLadderFor('low');
    const early = moodPreviewLine(authored, profile({ wait_minutes: 2, missed_calls: 1 }));
    assert.equal(early.id, 'impatient');
    assert.equal(early.opening, "I've been trying to reach you.");
    const angry = moodPreviewLine(authored, profile({ wait_minutes: 9, missed_calls: 3 }));
    assert.equal(angry.id, 'angry');
    assert.equal(angry.opening, 'Finally. 9 minutes. Who is actually in charge?');
    const held = selectRung(authored, profile({ wait_minutes: 15, missed_calls: 3, unanswered_messages: 2 }), {
      rungId: 'angry',
    });
    assert.equal(held.rung.id, 'angry');
    assert.equal(
      renderMoodPlaceholders(held.rung.script.opening ?? '', profile({ wait_minutes: 15, missed_calls: 3 })),
      'Finally. 15 minutes. Who is actually in charge?',
    );
    const done = moodPreviewLine(authored, profile({ wait_minutes: 32 }));
    assert.equal(done.id, 'gave_up');
    assert.equal(done.opening, "I stopped waiting. I've spoken to the press.");
  });

  test('B. a 19 minute wait with two unanswered messages is upset, then one good reply steps down', () => {
    const authored = defaultLadderFor('medium');
    const wait = profile({ wait_minutes: 19, unanswered_messages: 2, followups_sent: 1 });
    const selected = selectRung(authored, wait);
    assert.equal(selected.rung.id, 'upset');
    const recovered = selectRung(authored, profile(), { rungId: 'upset', pendingRecoverySteps: 1 });
    assert.equal(recovered.rung.id, 'impatient');
    assert.equal(moodLineFor(authored, selected.rung, wait), 'Why did nobody pick up?');
  });

  test('C. an earlier dismissive tone reaches upset on a short wait', () => {
    const authored = defaultLadderFor('medium');
    const wait = profile({ wait_minutes: 2, prior_tones: ['dismissive'] });
    assert.equal(selectRung(authored, wait).rung.id, 'upset');
  });
});
