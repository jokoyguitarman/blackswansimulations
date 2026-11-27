import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { REGISTERED_CONDITION_KEYS } from '../conditionEvaluatorService.js';
import { CONDITION_CATALOG, isKnownConditionKey, parseConditionKey } from './conditionCatalog.js';
import { validateInjectTriggerShape } from './injectTriggerShape.js';
import { adversaryAdaptationAllowed, cancellationGateFor } from './cancellationGate.js';

const fixedCatalogIds = CONDITION_CATALOG.filter((def) => def.kind === 'fixed').map(
  (def) => def.id,
);

describe('condition catalogue matches the evaluator', () => {
  test('isKnownConditionKey is true for every registered key', () => {
    for (const key of REGISTERED_CONDITION_KEYS) {
      assert.equal(isKnownConditionKey(key), true, key);
    }
  });

  test('fixed catalogue keys and the registry are the same set', () => {
    assert.deepEqual(new Set(fixedCatalogIds), new Set(REGISTERED_CONDITION_KEYS));
  });

  test('prefixed keys parse and an empty argument is an error', () => {
    const shared = parseConditionKey('intel_shared:abc');
    assert.ok(!('error' in shared));
    if (!('error' in shared)) assert.deepEqual(shared.args, ['abc']);

    const empty = parseConditionKey('inject_published:');
    assert.ok('error' in empty);

    assert.equal(isKnownConditionKey('objective_not_completed:obj_1'), true);
    const objective = parseConditionKey('objective_not_completed:obj_1');
    assert.ok(!('error' in objective));
  });

  test('an unknown key is rejected', () => {
    assert.equal(isKnownConditionKey('foo_bar_baz'), false);
    const parsed = parseConditionKey('foo_bar_baz');
    assert.ok('error' in parsed);
  });

  test('deprecated keys stay known and name a replacement', () => {
    const deprecated = CONDITION_CATALOG.filter((def) => def.deprecated);
    assert.ok(deprecated.length >= 6);
    for (const def of deprecated) {
      assert.equal(isKnownConditionKey(def.id), true, def.id);
      assert.equal(typeof def.deprecated?.use, 'string');
      assert.ok(def.deprecated?.use);
    }
    const ids = new Set(deprecated.map((def) => def.id));
    for (const id of [
      'player_posted_infographic',
      'player_posted_video_concept',
      'player_posted_personal_story',
      'leader_has_preexisting_credibility',
      'player_message_inconsistent_across_channels',
      'player_pinned_verified_update',
    ]) {
      assert.equal(ids.has(id), true, id);
    }
  });
});

describe('inject trigger shape', () => {
  test('a time and conditions cannot both be set', () => {
    assert.equal(
      validateInjectTriggerShape({
        trigger_time_minutes: 12,
        conditions_to_appear: { all: ['sentiment_below_30'] },
      }),
      'timed_with_conditions',
    );
  });

  test('a conditional inject with no conditions and no decision trigger is rejected', () => {
    assert.equal(
      validateInjectTriggerShape({
        trigger_time_minutes: null,
        trigger_condition: '   ',
        conditions_to_appear: { conditions: [] },
      }),
      'conditional_without_conditions',
    );
    assert.equal(
      validateInjectTriggerShape({
        trigger_time_minutes: null,
        trigger_condition: null,
        conditions_to_appear: null,
      }),
      'conditional_without_conditions',
    );
  });

  test('timed, decision-driven and conditional shapes are ok', () => {
    assert.equal(
      validateInjectTriggerShape({
        trigger_time_minutes: 0,
        conditions_to_appear: null,
      }),
      'ok',
    );
    assert.equal(
      validateInjectTriggerShape({
        trigger_time_minutes: null,
        trigger_condition: 'keyword',
        conditions_to_appear: null,
      }),
      'ok',
    );
    assert.equal(
      validateInjectTriggerShape({
        trigger_time_minutes: null,
        conditions_to_appear: { threshold: 1, conditions: ['sentiment_below_30'] },
      }),
      'ok',
    );
  });
});

describe('social cancellation gate', () => {
  test('a social_media session never selects the war-room gate', () => {
    for (const boothWorld of [true, false]) {
      for (const socialInjectCancelGate of [true, false]) {
        for (const stakeholderPublishAsIs of [true, false]) {
          const gate = cancellationGateFor({
            simMode: 'social_media',
            boothWorld,
            socialInjectCancelGate,
            stakeholderPublishAsIs,
          });
          assert.notEqual(gate, 'warroom');
        }
      }
    }
    assert.equal(
      cancellationGateFor({
        simMode: 'social_media',
        boothWorld: false,
        socialInjectCancelGate: true,
        stakeholderPublishAsIs: false,
      }),
      'social',
    );
    assert.equal(adversaryAdaptationAllowed('social_media'), false);
    assert.equal(adversaryAdaptationAllowed(null), true);
  });
});
