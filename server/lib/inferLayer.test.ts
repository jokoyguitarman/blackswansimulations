import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { inferLayer, type FingerprintInject } from './injectFingerprint.js';

const teams = [
  { team_name: 'Communications', team_uid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
  { team_name: 'Legal', team_uid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
];

function row(over: Partial<FingerprintInject> = {}): FingerprintInject {
  return {
    title: 'Inject',
    content: 'Body',
    type: 'social_post',
    severity: 'low',
    target_teams: [],
    inject_scope: 'universal',
    delivery_config: { app: 'social_feed' },
    ...over,
  };
}

describe('inferLayer', () => {
  test('prefers a parent key, then a stakeholder, then a pressure org', () => {
    assert.equal(
      inferLayer(row({ delivery_config: { app: 'email', parent_inject_key: 'supplier_email' } }), teams),
      'branch:supplier_email',
    );
    assert.equal(
      inferLayer(row({ delivery_config: { app: 'email', stakeholder_id: 'stk_supplier' } }), teams),
      'stakeholder:stk_supplier',
    );
    assert.equal(
      inferLayer(
        row({ delivery_config: { app: 'social_feed', page_org_key: 'org_pressure_union_my' } }),
        teams,
      ),
      'pressure:org_pressure_union_my',
    );
  });

  test('maps one target team to its uid', () => {
    assert.equal(
      inferLayer(row({ target_teams: ['Communications'], inject_scope: 'team_specific' }), teams),
      'team:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    );
  });

  test('uses strategy, gate, shared, then backbone', () => {
    assert.equal(inferLayer(row({ trigger_condition: 'decision:recall' }), teams), 'strategy');
    assert.equal(
      inferLayer(row({ conditions_to_appear: { all: ['sentiment_below_30'] } }), teams),
      'gate',
    );
    assert.equal(inferLayer(row({ target_teams: [] }), teams), 'shared');
    assert.equal(
      inferLayer(row({ target_teams: ['Communications', 'Legal'] }), teams),
      'backbone',
    );
  });
});
