import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  learn,
  transition,
  expandGroups,
  publicExposure,
  shouldKnowGap,
  relayProbability,
  actorKey,
  type KnowledgeMap,
} from './decisionKnowledgeCore.js';
import type { KnowledgeEntry } from './decisionTypes.js';

const entry = (
  state: KnowledgeEntry['state'],
  via: KnowledgeEntry['learned_via'],
  at: number,
): KnowledgeEntry => ({
  actor_kind: 'stakeholder',
  actor_id: 'stk_a',
  state,
  learned_from: 'x',
  learned_via: via,
  at_minute: at,
});

describe('monotonic transitions', () => {
  test('knowledge only moves forward; a later rumour never downgrades a formal notice', () => {
    assert.ok(transition(undefined, entry('rumour', 'internal_relay', 5)));
    assert.ok(
      transition(entry('rumour', 'internal_relay', 5), entry('informed', 'direct_message', 10)),
    );
    assert.equal(
      transition(
        entry('officially_notified', 'formal_notice', 10),
        entry('rumour', 'grievance_relay', 30),
      ),
      null,
    );
    assert.equal(
      transition(entry('informed', 'direct_message', 10), entry('informed', 'public_exposure', 30)),
      null,
      'same rank keeps the first provenance',
    );
  });
});

describe('learn + provenance', () => {
  test('records who/how/when and returns only the changed entries', () => {
    const map: KnowledgeMap = new Map();
    const changed = learn(
      map,
      [
        { actor_kind: 'stakeholder', actor_id: 'stk_a' },
        { actor_kind: 'team', actor_id: 'People Ops' },
      ],
      'informed',
      'direct_message',
      'u_ceo',
      12,
      { ref_table: 'sim_emails', ref_id: 'e1' },
    );
    assert.equal(changed.length, 2);
    const a = map.get('stakeholder:stk_a')!;
    assert.equal(a.learned_via, 'direct_message');
    assert.equal(a.learned_from, 'u_ceo');
    assert.equal(a.ref_id, 'e1');
    const again = learn(
      map,
      [{ actor_kind: 'stakeholder', actor_id: 'stk_a' }],
      'rumour',
      'internal_relay',
      'stk_b',
      30,
    );
    assert.equal(again.length, 0, 'no downgrade, nothing changed');
  });
});

describe('groups (R1 workaround) and public exposure', () => {
  test('a distribution list told = every member told at the same minute', () => {
    const actors = expandGroups(
      [{ actor_kind: 'group', actor_id: 'stk_list' }],
      new Map([['stk_list', ['stk_r1', 'stk_r2']]]),
    );
    assert.deepEqual(actors.map(actorKey), [
      'group:stk_list',
      'stakeholder:stk_r1',
      'stakeholder:stk_r2',
    ]);
    const map: KnowledgeMap = new Map();
    const changed = learn(map, actors, 'officially_notified', 'formal_notice', 'u_hr', 40);
    assert.ok(changed.every((c) => c.at_minute === 40 && c.state === 'officially_notified'));
  });
  test('public exposure marks the country (or everyone when unscoped) and skips those already informed', () => {
    const map: KnowledgeMap = new Map();
    learn(
      map,
      [{ actor_kind: 'stakeholder', actor_id: 'my_1' }],
      'officially_notified',
      'formal_notice',
      'u_hr',
      20,
    );
    const candidates = [
      { actor_kind: 'stakeholder' as const, actor_id: 'my_1', country: 'Malaysia' },
      { actor_kind: 'stakeholder' as const, actor_id: 'my_2', country: 'Malaysia' },
      { actor_kind: 'stakeholder' as const, actor_id: 'sg_1', country: 'Singapore' },
      { actor_kind: 'stakeholder' as const, actor_id: 'common', country: null },
    ];
    const changed = publicExposure(map, candidates, 'Malaysia', 55, {
      ref_table: 'scenario_injects',
      ref_id: 'i1',
    });
    assert.deepEqual(changed.map((c) => c.actor_id).sort(), ['common', 'my_2']);
    assert.ok(changed.every((c) => c.learned_via === 'public_exposure' && c.state === 'informed'));
    const unscoped = publicExposure(map, candidates, null, 60);
    assert.deepEqual(
      unscoped.map((c) => c.actor_id),
      ['sg_1'],
    );
  });
});

describe('should-know gap + relay probability', () => {
  test('gap lists actors still below informed', () => {
    const map: KnowledgeMap = new Map();
    learn(
      map,
      [{ actor_kind: 'stakeholder', actor_id: 'told' }],
      'informed',
      'direct_message',
      'u',
      1,
    );
    learn(
      map,
      [{ actor_kind: 'stakeholder', actor_id: 'rumour' }],
      'rumour',
      'internal_relay',
      'x',
      2,
    );
    const gap = shouldKnowGap(
      map,
      ['told', 'rumour', 'unaware'].map((id) => ({
        actor_kind: 'stakeholder' as const,
        actor_id: id,
      })),
    );
    assert.deepEqual(
      gap.map((g) => g.actor_id),
      ['rumour', 'unaware'],
    );
  });
  test('leakier organisations and more elapsed time relay faster; capped at 0.95', () => {
    assert.ok(relayProbability(0.2, 0) < relayProbability(0.8, 0));
    assert.ok(relayProbability(0.5, 10) < relayProbability(0.5, 50));
    assert.equal(relayProbability(1, 10_000), 0.95);
    assert.equal(relayProbability(0, 0), 0);
  });
});
