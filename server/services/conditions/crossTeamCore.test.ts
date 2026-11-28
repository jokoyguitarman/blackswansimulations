import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateInjectConditions, type EvaluationContext } from '../conditionEvaluatorService.js';
import {
  applyCrossTeamGuards,
  causeDepth,
  crossTeamProfile,
  registerSourceTeamResolver,
  type CrossTeamCandidate,
  type CrossTeamGuardEnv,
  type RecentCrossTeamTrigger,
  type TeamDelivery,
} from './crossTeamCore.js';

const teams = [{ name: 'A', role_ids: ['lead'] }, { name: 'B' }];

const env: CrossTeamGuardEnv = {
  maxPerTeamWindow: 2,
  windowMinutes: 15,
  pressureMaxDeliveries10Min: 6,
  loopWindowMinutes: 20,
  maxCascadeDepth: 3,
};

function cross(id: string, severity: string, minute = 20, age = 0, depth = 1): CrossTeamCandidate {
  return {
    id,
    inject_key: id,
    severity,
    minute,
    dependency_age: age,
    source_teams: ['A'],
    target_teams: ['B'],
    is_cross_team: true,
    cause_depth: depth,
    origin: 'conditional',
    met_keys: ['unresponded:root:10|team=a'],
  };
}

function fired(
  key: string,
  minute: number,
  extra: Partial<RecentCrossTeamTrigger> = {},
): RecentCrossTeamTrigger {
  return {
    inject_key: key,
    minute,
    source_teams: ['A'],
    target_teams: ['B'],
    origin: 'conditional',
    is_cross_team: true,
    cause_depth: 1,
    ...extra,
  };
}

function explainContext(): EvaluationContext {
  return {
    sessionId: 's',
    scenarioId: 'sc',
    elapsedMinutes: 12,
    currentState: {},
    executedDecisions: [],
    publishedScenarioInjectIds: ['id-a', 'id-c'],
    injectIdsByKey: { alpha: ['id-a'], beta: ['id-b'], gamma: ['id-c'] },
  };
}

describe('cross-team profile', () => {
  test('an inject to B caused by team A is cross-team; one caused by B is not', () => {
    const fromA = crossTeamProfile({ target_teams: ['B'] }, ['unresponded:k:10|team=a'], teams);
    assert.deepEqual(fromA.source_teams, ['A']);
    assert.deepEqual(fromA.target_teams, ['B']);
    assert.equal(fromA.is_cross_team, true);

    const fromB = crossTeamProfile({ target_teams: ['B'] }, ['unresponded:k:10|team=b'], teams);
    assert.deepEqual(fromB.source_teams, ['B']);
    assert.equal(fromB.is_cross_team, false);

    const viaRole = crossTeamProfile(
      { target_teams: ['B'] },
      ['unresponded:k:10|role=lead'],
      teams,
    );
    assert.deepEqual(viaRole.source_teams, ['A']);
    assert.equal(viaRole.is_cross_team, true);

    const fanOut = crossTeamProfile(
      { target_teams: ['A', 'B'] },
      ['unresponded:k:10|team=a'],
      teams,
    );
    assert.equal(fanOut.is_cross_team, true);
  });

  test('a registered resolver contributes its source team and an unregistered dependency key does not', () => {
    const remove = registerSourceTeamResolver('probe_*', () => ['Legal']);
    try {
      const profile = crossTeamProfile(
        { target_teams: ['Communications'] },
        ['probe_alpha'],
        [{ name: 'Legal' }, { name: 'Communications' }],
      );
      assert.deepEqual(profile.source_teams, ['Legal']);
      assert.equal(profile.is_cross_team, true);

      const dependency = crossTeamProfile(
        { target_teams: ['Communications'] },
        ['dependency_broken:dep_ops_headcount_comms'],
        [{ name: 'Operations' }, { name: 'Communications' }],
      );
      assert.deepEqual(dependency.source_teams, []);
      assert.equal(dependency.is_cross_team, false);
    } finally {
      remove();
    }

    const after = crossTeamProfile(
      { target_teams: ['Communications'] },
      ['probe_alpha'],
      [{ name: 'Legal' }, { name: 'Communications' }],
    );
    assert.deepEqual(after.source_teams, []);
    assert.equal(after.is_cross_team, false);
  });
});

describe('cross-team guards', () => {
  test('three cross-team candidates for one team publish two by severity and defer one', () => {
    const first = applyCrossTeamGuards(
      [cross('low', 'low'), cross('high', 'high'), cross('medium', 'medium')],
      [],
      [],
      env,
    );
    assert.deepEqual(
      first.publish.map((item) => item.id),
      ['high', 'medium'],
    );
    assert.deepEqual(
      first.defer.map((item) => item.candidate.id),
      ['low'],
    );
    assert.equal(first.defer[0]?.reason, 'throttle');

    const recent = [fired('high', 20), fired('medium', 20)];
    const stillInside = applyCrossTeamGuards([cross('low', 'low', 35)], recent, [], env);
    assert.equal(stillInside.publish.length, 0);
    assert.equal(stillInside.defer[0]?.candidate.id, 'low');

    const nextWindow = applyCrossTeamGuards([cross('low', 'low', 36)], recent, [], env);
    assert.deepEqual(
      nextWindow.publish.map((item) => item.id),
      ['low'],
    );

    const cancelled = applyCrossTeamGuards([cross('low', 'low', 36, 0, 4)], recent, [], env);
    assert.equal(cancelled.publish.length, 0);
    assert.equal(cancelled.cancel[0]?.reason, 'cascade_cap');
    assert.equal(cancelled.cancel[0]?.candidate.id, 'low');

    const olderFirst = applyCrossTeamGuards(
      [cross('fresh', 'medium', 20, 1), cross('waiting', 'medium', 20, 9)],
      [],
      [],
      { ...env, maxPerTeamWindow: 1 },
    );
    assert.deepEqual(
      olderFirst.publish.map((item) => item.id),
      ['waiting'],
    );
    assert.equal(olderFirst.defer[0]?.candidate.id, 'fresh');

    const severityBeatsAge = applyCrossTeamGuards(
      [cross('old-low', 'low', 20, 100), cross('new-high', 'high', 20, 0)],
      [],
      [],
      { ...env, maxPerTeamWindow: 1 },
    );
    assert.deepEqual(
      severityBeatsAge.publish.map((item) => item.id),
      ['new-high'],
    );

    const directors = applyCrossTeamGuards(
      [cross('again', 'high', 22)],
      [
        fired('dir-1', 20, { origin: 'director', is_cross_team: false, source_teams: [] }),
        fired('dir-2', 20, { origin: 'director', is_cross_team: false, source_teams: [] }),
      ],
      [],
      env,
    );
    assert.equal(directors.publish.length, 0);
    assert.equal(directors.defer[0]?.reason, 'throttle');

    const sameTeam = applyCrossTeamGuards(
      [cross('open', 'high', 22)],
      [
        fired('self-1', 20, { source_teams: ['B'], target_teams: ['B'], is_cross_team: false }),
        fired('self-2', 20, { source_teams: ['B'], target_teams: ['B'], is_cross_team: false }),
      ],
      [],
      env,
    );
    assert.deepEqual(
      sameTeam.publish.map((item) => item.id),
      ['open'],
    );
  });

  test('a team at 6 deliveries in 10 minutes gets no cross-team publish', () => {
    const deliveries: TeamDelivery[] = Array.from({ length: 6 }, (_, index) => ({
      team: 'B',
      minute: 20 - index,
    }));
    const blocked = applyCrossTeamGuards(
      [cross('onto-b', 'high'), { ...cross('onto-c', 'high'), target_teams: ['C'] }],
      [],
      deliveries,
      env,
    );
    assert.deepEqual(
      blocked.publish.map((item) => item.id),
      ['onto-c'],
    );
    assert.equal(blocked.defer[0]?.candidate.id, 'onto-b');
    assert.equal(blocked.defer[0]?.reason, 'pressure');

    const five: TeamDelivery[] = Array.from({ length: 5 }, (_, index) => ({
      team: 'B',
      minute: 20 - index,
    }));
    const roomForOne = applyCrossTeamGuards(
      [cross('first', 'high'), cross('second', 'medium')],
      [],
      five,
      env,
    );
    assert.deepEqual(
      roomForOne.publish.map((item) => item.id),
      ['first'],
    );
    assert.equal(roomForOne.defer[0]?.candidate.id, 'second');
    assert.equal(roomForOne.defer[0]?.reason, 'pressure');
  });

  test('a reverse consequence that only answers the forward one is held inside the loop window', () => {
    const recent = [fired('cons_ab', 20)];
    const back: CrossTeamCandidate = {
      id: 'cons_ba',
      inject_key: 'cons_ba',
      severity: 'medium',
      minute: 30,
      source_teams: ['B'],
      target_teams: ['A'],
      is_cross_team: true,
      cause_depth: 1,
      origin: 'conditional',
      met_keys: ['unresponded:cons_ab:5|team=b'],
    };
    const held = applyCrossTeamGuards([back], recent, [], env);
    assert.equal(held.publish.length, 0);
    assert.equal(held.defer.length, 0);
    assert.equal(held.hold[0]?.id, 'cons_ba');

    const stillHeld = applyCrossTeamGuards([{ ...back, minute: 40 }], recent, [], env);
    assert.equal(stillHeld.hold[0]?.id, 'cons_ba');

    const released = applyCrossTeamGuards([{ ...back, minute: 41 }], recent, [], env);
    assert.equal(released.hold.length, 0);
    assert.equal(released.publish[0]?.id, 'cons_ba');

    const independent = applyCrossTeamGuards(
      [
        {
          ...back,
          met_keys: ['unresponded:cons_ab:5|team=b', 'duty_missed:legal_review_statement|team=b'],
        },
      ],
      recent,
      [],
      env,
    );
    assert.equal(independent.hold.length, 0);
    assert.equal(independent.publish[0]?.id, 'cons_ba');
  });

  test('cascade depths 1 to 3 publish and depth 4 is cancelled', () => {
    const triggers = {
      root: { cause_depth: 0 },
      c1: { cause_depth: 1 },
      c2: { cause_depth: 2 },
      c3: { cause_depth: 3 },
    };
    assert.equal(causeDepth(['unresponded:root:5|team=a'], triggers), 1);
    assert.equal(causeDepth(['unresponded:c1:5|team=a'], triggers), 2);
    assert.equal(causeDepth(['unresponded:c2:5|team=a'], triggers), 3);
    assert.equal(causeDepth(['unresponded:c3:5|team=a'], triggers), 4);
    assert.equal(causeDepth(['unresponded:c1:5|team=a', 'unresponded:c3:5|team=a'], triggers), 4);
    assert.equal(causeDepth(['duty_missed:legal_review|team=a'], triggers), 1);

    const candidates = [1, 2, 3, 4].map((depth) => ({
      id: `d${depth}`,
      inject_key: `d${depth}`,
      minute: 10,
      severity: 'medium',
      cause_depth: depth,
      is_cross_team: false,
      source_teams: ['A'],
      target_teams: ['A'],
      origin: 'conditional' as const,
    }));
    const result = applyCrossTeamGuards(candidates, [], [], env);
    assert.deepEqual(
      result.publish.map((item) => item.id),
      ['d1', 'd2', 'd3'],
    );
    assert.equal(result.cancel.length, 1);
    assert.equal(result.cancel[0]?.reason, 'cascade_cap');
    assert.equal(result.cancel[0]?.candidate.id, 'd4');
  });

  test('an authored timed inject is never deferred', () => {
    const deliveries: TeamDelivery[] = Array.from({ length: 6 }, () => ({
      team: 'B',
      minute: 18,
    }));
    const recent = [fired('one', 20), fired('two', 20)];
    const result = applyCrossTeamGuards(
      [
        {
          id: 'clock',
          inject_key: 'clock',
          minute: 20,
          severity: 'low',
          timed: true,
          origin: 'timed',
          cause_depth: 0,
          target_teams: ['B'],
        },
        cross('pile', 'high'),
      ],
      recent,
      deliveries,
      env,
    );
    assert.deepEqual(
      result.publish.map((item) => item.id),
      ['clock'],
    );
    assert.equal(result.defer[0]?.candidate.id, 'pile');
    assert.equal(result.hold.length, 0);
    assert.equal(result.cancel.length, 0);
  });
});

describe('condition explain', () => {
  test('explain returns the keys that held for all, any and threshold', () => {
    const context = explainContext();
    const alpha = 'inject_published:alpha';
    const beta = 'inject_published:beta';
    const gamma = 'inject_published:gamma';

    const allMet = evaluateInjectConditions({ all: [alpha, gamma] }, [], context, {
      explain: true,
    });
    assert.equal(allMet.status, 'appear_met');
    assert.deepEqual(allMet.met_keys, [alpha, gamma]);
    assert.deepEqual(allMet.failed_keys, []);

    const allShort = evaluateInjectConditions({ all: [alpha, beta] }, [], context, {
      explain: true,
    });
    assert.equal(allShort.status, 'not_eligible');
    assert.deepEqual(allShort.met_keys, [alpha]);
    assert.deepEqual(allShort.failed_keys, [beta]);

    const anyMet = evaluateInjectConditions({ any: [beta, alpha] }, [], context, { explain: true });
    assert.equal(anyMet.status, 'appear_met');
    assert.deepEqual(anyMet.met_keys, [alpha]);
    assert.deepEqual(anyMet.failed_keys, [beta]);

    const anyMiss = evaluateInjectConditions({ any: [beta] }, [], context, { explain: true });
    assert.equal(anyMiss.status, 'not_eligible');
    assert.deepEqual(anyMiss.met_keys, []);
    assert.deepEqual(anyMiss.failed_keys, [beta]);

    const thresholdMet = evaluateInjectConditions(
      { threshold: 2, conditions: [alpha, beta, gamma] },
      [],
      context,
      { explain: true },
    );
    assert.equal(thresholdMet.status, 'appear_met');
    assert.deepEqual(thresholdMet.met_keys, [alpha, gamma]);
    assert.deepEqual(thresholdMet.failed_keys, [beta]);

    const thresholdMiss = evaluateInjectConditions(
      { threshold: 3, conditions: [alpha, beta, gamma] },
      [],
      context,
      { explain: true },
    );
    assert.equal(thresholdMiss.status, 'not_eligible');
    assert.deepEqual(thresholdMiss.met_keys, [alpha, gamma]);
    assert.deepEqual(thresholdMiss.failed_keys, [beta]);

    const plain = evaluateInjectConditions({ all: [alpha, gamma] }, [], context);
    assert.deepEqual(plain, { status: 'appear_met' });
    const plainAny = evaluateInjectConditions({ any: [beta, alpha] }, [], context);
    assert.deepEqual(plainAny, { status: 'appear_met' });

    const cancelled = evaluateInjectConditions({ all: [beta] }, [alpha], context, {
      explain: true,
    });
    assert.equal(cancelled.status, 'cancel_met');
    assert.deepEqual(cancelled.met_keys, [alpha]);
    assert.deepEqual(cancelled.failed_keys, []);
  });
});
