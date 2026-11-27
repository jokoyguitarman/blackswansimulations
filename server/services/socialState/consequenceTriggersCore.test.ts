import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  planConsequenceTriggers,
  type ConsequenceTriggerState,
} from './consequenceTriggersCore.js';

function quiet(over: Partial<ConsequenceTriggerState> = {}): ConsequenceTriggerState {
  return {
    oldest_unaddressed_hate_minutes: 0,
    oldest_unaddressed_misinfo_minutes: 0,
    official_statement_published: false,
    strategic_ratio: 1,
    tier1_reactive_actions: 0,
    rally_call_active: false,
    community_leader_contacted: false,
    narrative_control: 40,
    ...over,
  };
}

describe('consequence triggers', () => {
  test('no_statement_20min fires once at minute 21 when no statement exists', () => {
    const first = planConsequenceTriggers(quiet(), 21, []);
    assert.ok(first.fire.includes('no_statement_20min'));
    const second = planConsequenceTriggers(quiet(), 22, first.fired);
    assert.equal(second.fire.includes('no_statement_20min'), false);
  });

  test('a statement already published does not fire no_statement_20min', () => {
    const plan = planConsequenceTriggers(quiet({ official_statement_published: true }), 21, []);
    assert.equal(plan.fire.includes('no_statement_20min'), false);
  });

  test('narrative_collapsing re-arms after narrative control recovers above 35', () => {
    const collapsed = planConsequenceTriggers(quiet({ narrative_control: 10 }), 0, []);
    assert.ok(collapsed.fire.includes('narrative_collapsing'));
    const recovered = planConsequenceTriggers(quiet({ narrative_control: 40 }), 0, collapsed.fired);
    assert.equal(recovered.fired.includes('narrative_collapsing'), false);
    const again = planConsequenceTriggers(quiet({ narrative_control: 12 }), 0, recovered.fired);
    assert.ok(again.fire.includes('narrative_collapsing'));
  });
});
