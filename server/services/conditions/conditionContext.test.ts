import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { assembleConditionEvaluationContext } from './conditionContextService.js';

const fixture = {
  sessionId: 'session-1',
  scenarioId: 'scenario-1',
  elapsedMinutes: 18,
  currentState: { social_state: { sentiment_score: 40 } },
  decisions: [
    {
      id: 'dec-1',
      title: 'Hold the line',
      description: 'No comment yet',
      type: 'public_position',
    },
  ],
  publishedEvents: [{ metadata: { inject_id: 'pub-1', title: 'Opening post', tags: ['opening'] } }],
  cancelledEvents: [{ metadata: { inject_id: 'can-1' } }],
  gates: [{ id: 'uuid-1', gate_id: 'gate_a' }],
  gateProgress: [{ gate_id: 'gate_a', status: 'met' }],
  placedAssetsCount: 3,
  keyedInjects: [{ id: 'id-1', inject_key: 'supplier_4471' }],
};

describe('condition evaluation context', () => {
  test('the scheduler and the trainer panel build the same context from one fixture', () => {
    const scheduler = assembleConditionEvaluationContext(fixture);
    const panel = assembleConditionEvaluationContext(fixture);
    assert.deepEqual(scheduler, panel);
    assert.deepEqual(scheduler.publishedScenarioInjectIds, ['pub-1']);
    assert.deepEqual(scheduler.publishedInjectKeysOrTags, ['Opening post', 'opening']);
    assert.deepEqual(scheduler.cancelledScenarioInjectIds, ['can-1']);
    assert.equal(scheduler.gateStatusByGateId?.gate_a, 'met');
    assert.equal(scheduler.placedAssetsCount, 3);
    assert.deepEqual(scheduler.injectIdsByKey?.supplier_4471, ['id-1']);
    assert.equal(scheduler.executedDecisions[0]?.decision_type, 'public_position');
    assert.equal(scheduler.elapsedMinutes, 18);
    assert.equal(scheduler.currentState.social_state, fixture.currentState.social_state);
  });
});
