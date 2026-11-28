import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  CONDITION_CATALOG,
  parseConditionKey,
} from '../server/services/conditions/conditionCatalog.js';
import {
  builderModelToKey,
  keyToBuilderModel,
  parseCatalogCondition,
  sampleBuilderModel,
} from './conditionKeyGrammar.js';
import { slugifyInjectTitle, uniqueInjectKey } from './injectKeySlug.js';

const SUPPLIER_KEYS = [
  'email_unreplied:supplier_4471:10',
  'email_unreplied:supplier_4471:15',
  'email_replied:supplier_4471',
  'call_missed:supplier_4471_call',
  'reply_tone:supplier_4471:defensive',
  'reply_passed:supplier_4471',
  'reply_failed:supplier_4471',
  'reply_best_passed:supplier_4471',
];

describe('condition key grammar', () => {
  test('every catalogue def round-trips through the builder model', () => {
    for (const def of CONDITION_CATALOG) {
      const scopes: Array<'none' | 'team' | 'role'> = [];
      if (!def.requiresScope) scopes.push('none');
      if (def.teamScope) scopes.push('team');
      if (def.kind === 'prefix') scopes.push('role');
      for (const scope of scopes) {
        const model = sampleBuilderModel(def, scope);
        const formatted = builderModelToKey(model, CONDITION_CATALOG);
        assert.ok(
          !('error' in formatted),
          `${def.id} ${scope}: ${'error' in formatted ? formatted.error : ''}`,
        );
        if ('error' in formatted) continue;
        const back = keyToBuilderModel(formatted.key, CONDITION_CATALOG);
        assert.ok(!('error' in back), formatted.key);
        if ('error' in back) continue;
        assert.deepEqual(back.model, model, formatted.key);
        const server = parseConditionKey(formatted.key);
        const shared = parseCatalogCondition(formatted.key, CONDITION_CATALOG);
        assert.ok(!('error' in server), formatted.key);
        assert.ok(!('error' in shared), formatted.key);
        if ('error' in server || 'error' in shared) continue;
        assert.equal(server.def.id, shared.def.id);
        assert.deepEqual(server.args, shared.args);
        assert.deepEqual(server.scope, shared.scope);
        assert.equal(server.def.id, model.event);
        assert.deepEqual(server.args, model.args);
      }
    }
  });

  test('the supplier example keys round-trip', () => {
    for (const key of SUPPLIER_KEYS) {
      const model = keyToBuilderModel(key, CONDITION_CATALOG);
      assert.ok(!('error' in model), key);
      if ('error' in model) continue;
      const formatted = builderModelToKey(model.model, CONDITION_CATALOG);
      assert.ok(!('error' in formatted), key);
      if ('error' in formatted) continue;
      assert.equal(formatted.key, key);
    }
  });

  test('minutes, inject keys and empty scopes are rejected', () => {
    for (const key of [
      'unresponded:k1:0',
      'unresponded:k1:241',
      'email_unreplied:Bad Key:5',
      'unresponded:k1:10|team=',
      'unresponded:k1:10|desk=ops',
    ]) {
      const parsed = parseCatalogCondition(key, CONDITION_CATALOG);
      assert.ok('error' in parsed, key);
    }
    const role = parseCatalogCondition('unresponded:k1:10|role=cs_head', CONDITION_CATALOG);
    assert.ok(!('error' in role));
    if (!('error' in role)) assert.equal(role.scope?.role, 'cs_head');
    const team = parseCatalogCondition('responded:k1|team=Legal Team', CONDITION_CATALOG);
    assert.ok(!('error' in team));
    if (!('error' in team)) assert.equal(team.scope?.team, 'legal_team');
  });

  test('an inject key is the title slug, unique in the scenario', () => {
    assert.equal(slugifyInjectTitle('Supplier batch 4471'), 'supplier_batch_4471');
    const taken = new Set(['supplier_batch_4471']);
    assert.equal(uniqueInjectKey('Supplier batch 4471', taken), 'supplier_batch_4471_2');
    assert.equal(slugifyInjectTitle(''), 'inject');
  });
});
