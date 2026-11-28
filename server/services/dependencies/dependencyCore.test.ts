import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { collectConditionKeys } from '../conditions/conditionCatalog.js';
import { validateInjectTriggerShape } from '../conditions/injectTriggerShape.js';
import {
  evaluateInjectConditions,
  type EvaluationContext,
} from '../conditionEvaluatorService.js';
import {
  prepareTeamDependencies,
  toActiveTeams,
  validateDependencies,
  type ActiveTeam,
  type DependencyInjectRef,
  type TeamDependencyEdge,
} from './dependencyCore.js';

const OPS = '6f1c0000-0000-4000-8000-000000000001';
const COMMS = 'a93e0000-0000-4000-8000-000000000002';
const LEGAL = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CS = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const FINANCE = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const AI = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const GONE = '99999999-9999-4999-8999-999999999999';

const TEAMS: ActiveTeam[] = [
  { team_uid: OPS, team_name: 'Operations', playable: true },
  { team_uid: COMMS, team_name: 'Communications', playable: true },
  { team_uid: LEGAL, team_name: 'Legal', playable: true },
  { team_uid: CS, team_name: 'Customer Service', playable: true },
  { team_uid: FINANCE, team_name: 'Finance', playable: true },
  { team_uid: AI, team_name: 'Simulated Desk', playable: false },
];

function ref(team_uid: string, team_name: string) {
  return { team_uid, team_name };
}

function edge(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'dep_ops_headcount_comms',
    kind: 'information',
    upstream: ref(OPS, 'Operations'),
    downstream: [ref(COMMS, 'Communications')],
    deliverable: 'Confirmed headcount for Bay 3',
    why: 'Communications needs the figure',
    due: { after_inject_key: 'bay3_headcount_request', within_minutes: 10 },
    broken_when: {
      any: [
        'unresponded:bay3_headcount_request:10|team=@upstream',
        'reply_failed:bay3_headcount_request|team=@upstream',
      ],
    },
    met_when: { any: ['responded_relevant:bay3_headcount_request|team=@upstream'] },
    lag_minutes: 5,
    severity: 'high',
    consequence_keys: ['comms_reporter_presses_for_numbers'],
    source: 'war_room',
    ...overrides,
  };
}

const INJECTS: DependencyInjectRef[] = [
  {
    inject_key: 'bay3_headcount_request',
    trigger_time_minutes: 8,
    conditional: false,
    condition_keys: [],
  },
  {
    inject_key: 'comms_reporter_presses_for_numbers',
    trigger_time_minutes: null,
    conditional: true,
    condition_keys: ['dependency_broken_for:dep_ops_headcount_comms:5'],
  },
];

function codes(issues: { code: string }[]): string[] {
  return issues.map((item) => item.code);
}

describe('validateDependencies', () => {
  test('a complete edge has no issues and a renamed team refreshes the name cache', () => {
    const clean = validateDependencies([edge()], TEAMS, INJECTS, 60);
    assert.deepEqual(clean.issues, []);
    assert.equal(clean.edges[0]?.upstream.team_name, 'Operations');

    const renamedTeams: ActiveTeam[] = [
      { team_uid: OPS, team_name: 'Operations Control', playable: true },
      { team_uid: COMMS, team_name: 'Communications Desk', playable: true },
    ];
    const renamed = validateDependencies(
      [
        edge({
          upstream: ref(OPS, 'Ops'),
          downstream: [ref(COMMS, 'Comms')],
        }),
      ],
      renamedTeams,
      INJECTS,
      60,
    );
    assert.deepEqual(
      renamed.issues.filter((item) => item.severity === 'error'),
      [],
    );
    assert.equal(renamed.edges[0]?.upstream.team_uid, OPS);
    assert.equal(renamed.edges[0]?.upstream.team_name, 'Operations Control');
    assert.equal(renamed.edges[0]?.downstream[0]?.team_name, 'Communications Desk');
  });

  test('MO-DEP-001 schema', () => {
    const result = validateDependencies([edge({ id: 'not-a-dep', lag_minutes: 90 })], TEAMS, INJECTS, 60);
    assert.ok(codes(result.issues).includes('MO-DEP-001'));
    assert.equal(result.edges.length, 0);
    const wrapper = prepareTeamDependencies({ v: 2, edges: [] }, TEAMS, INJECTS, 60);
    assert.equal(wrapper.ok, false);
    if (!wrapper.ok) assert.equal(wrapper.issues[0]?.code, 'MO-DEP-001');
  });

  test('MO-DEP-002 duplicate id', () => {
    const result = validateDependencies([edge(), edge()], TEAMS, INJECTS, 60);
    assert.deepEqual(
      result.issues.filter((item) => item.severity === 'error').map((item) => item.code),
      ['MO-DEP-002'],
    );
  });

  test('MO-DEP-003 upstream unresolved or unplayable', () => {
    const removed = validateDependencies(
      [edge({ upstream: ref(GONE, 'Operations') })],
      TEAMS,
      INJECTS,
      60,
    );
    assert.ok(codes(removed.issues).includes('MO-DEP-003'));
    assert.equal(removed.edges[0]?.upstream.team_uid, GONE);
    assert.match(removed.issues.find((item) => item.code === 'MO-DEP-003')?.message ?? '', /not an active team/);

    const unplayable = validateDependencies(
      [edge({ upstream: ref(AI, 'Simulated Desk') })],
      TEAMS,
      INJECTS,
      60,
    );
    assert.match(
      unplayable.issues.find((item) => item.code === 'MO-DEP-003')?.message ?? '',
      /not a playable team/,
    );
  });

  test('MO-DEP-004 downstream count, identity, missing and unplayable', () => {
    const tooMany = validateDependencies(
      [
        edge({
          downstream: [
            ref(COMMS, 'Communications'),
            ref(LEGAL, 'Legal'),
            ref(CS, 'Customer Service'),
            ref(FINANCE, 'Finance'),
          ],
        }),
      ],
      TEAMS,
      INJECTS,
      60,
    );
    assert.ok(codes(tooMany.issues).includes('MO-DEP-004'));
    assert.match(tooMany.issues.find((item) => item.code === 'MO-DEP-004')?.message ?? '', /maximum is 3/);

    const same = validateDependencies(
      [edge({ downstream: [ref(OPS, 'Operations')] })],
      TEAMS,
      INJECTS,
      60,
    );
    assert.match(same.issues.find((item) => item.code === 'MO-DEP-004')?.message ?? '', /same as the upstream/);

    const missing = validateDependencies(
      [edge({ downstream: [ref(GONE, 'Logistics')] })],
      TEAMS,
      INJECTS,
      60,
    );
    assert.match(missing.issues.find((item) => item.code === 'MO-DEP-004')?.message ?? '', /not an active team/);

    const unplayable = validateDependencies(
      [edge({ downstream: [ref(AI, 'Simulated Desk')] })],
      TEAMS,
      INJECTS,
      60,
    );
    assert.match(
      unplayable.issues.find((item) => item.code === 'MO-DEP-004')?.message ?? '',
      /not a playable team/,
    );
  });

  test('MO-DEP-005 parse failure and dependency keys', () => {
    const result = validateDependencies(
      [
        edge({
          broken_when: {
            all: ['dependency_broken:dep_ops_headcount_comms', 'not_a_real_key'],
          },
        }),
      ],
      TEAMS,
      INJECTS,
      60,
    );
    const found = result.issues.filter((item) => item.code === 'MO-DEP-005');
    assert.equal(found.length, 2);
    assert.match(found[0]?.message ?? '', /dependency_\*/);
    assert.match(found[1]?.message ?? '', /failed to parse/);
  });

  test('MO-DEP-006 referenced inject key missing', () => {
    const result = validateDependencies(
      [
        edge({
          due: { after_inject_key: 'missing_due', within_minutes: 5 },
          broken_when: { all: ['unresponded:missing_inject:10|team=@upstream'] },
        }),
      ],
      TEAMS,
      INJECTS,
      60,
    );
    const found = result.issues.filter((item) => item.code === 'MO-DEP-006');
    assert.equal(found.length, 2);
    assert.match(found.map((item) => item.message).join(' '), /missing_inject/);
    assert.match(found.map((item) => item.message).join(' '), /missing_due/);
  });

  test('MO-DEP-007 window does not fit the duration', () => {
    const byMinute = validateDependencies(
      [edge({ due: { by_minute: 90 } })],
      TEAMS,
      INJECTS,
      60,
    );
    assert.ok(codes(byMinute.issues).includes('MO-DEP-007'));

    const overrun = validateDependencies(
      [edge({ due: { after_inject_key: 'bay3_headcount_request', within_minutes: 55 } })],
      TEAMS,
      INJECTS,
      60,
    );
    assert.ok(codes(overrun.issues).includes('MO-DEP-007'));
    assert.equal(
      validateDependencies([edge()], TEAMS, INJECTS, null).issues.some((item) => item.code === 'MO-DEP-007'),
      false,
    );
  });

  test('MO-DEP-008 consequence missing or not conditional', () => {
    const missing = validateDependencies(
      [edge({ consequence_keys: [] })],
      TEAMS,
      INJECTS,
      60,
    );
    assert.equal(
      missing.issues.find((item) => item.code === 'MO-DEP-008')?.severity,
      'warning',
    );

    const timed = validateDependencies(
      [edge({ consequence_keys: ['bay3_headcount_request'] })],
      TEAMS,
      INJECTS,
      60,
    );
    assert.match(
      timed.issues.find((item) => item.code === 'MO-DEP-008')?.message ?? '',
      /not conditional/,
    );

    const absent = validateDependencies(
      [edge({ consequence_keys: ['no_such_inject'] })],
      TEAMS,
      INJECTS,
      60,
    );
    assert.match(absent.issues.find((item) => item.code === 'MO-DEP-008')?.message ?? '', /not in the scenario/);
  });

  test('MO-DEP-009 no consequence references the edge', () => {
    const injects: DependencyInjectRef[] = [
      INJECTS[0]!,
      {
        inject_key: 'comms_reporter_presses_for_numbers',
        trigger_time_minutes: null,
        conditional: true,
        condition_keys: ['sentiment_below_30'],
      },
    ];
    const result = validateDependencies([edge()], TEAMS, injects, 60);
    const found = result.issues.filter((item) => item.code === 'MO-DEP-009');
    assert.equal(found.length, 1);
    assert.equal(found[0]?.severity, 'warning');
    assert.equal(
      result.issues.some((item) => item.code === 'MO-DEP-008'),
      false,
    );
  });

  test('an AI-operated organisation is unplayable', () => {
    const teams = toActiveTeams(
      [
        { team_uid: OPS, team_name: 'Operations', org_key: 'port' },
        { team_uid: AI, team_name: 'Simulated Desk', org_key: 'rival' },
      ],
      [
        { org_key: 'port', operation: 'players' },
        { org_key: 'rival', operation: 'ai' },
      ],
    );
    assert.equal(teams[0]?.playable, true);
    assert.equal(teams[1]?.playable, false);
    const result = validateDependencies([edge({ upstream: ref(AI, 'Simulated Desk') })], teams, INJECTS, 60);
    assert.ok(codes(result.issues).includes('MO-DEP-003'));
  });

  test('prepare stores the normalised document and keeps warnings off the error path', () => {
    const warned = prepareTeamDependencies(
      { v: 1, edges: [edge({ consequence_keys: [] })] },
      TEAMS,
      INJECTS,
      60,
    );
    assert.equal(warned.ok, true);
    if (warned.ok) {
      assert.ok(warned.issues.some((item) => item.code === 'MO-DEP-008' && item.severity === 'warning'));
      assert.equal(warned.team_dependencies.v, 1);
    }
    const referenced = prepareTeamDependencies({ v: 1, edges: [edge()] }, TEAMS, INJECTS, 60);
    assert.equal(referenced.ok, true);
    if (referenced.ok) {
      const stored = referenced.team_dependencies.edges[0] as TeamDependencyEdge;
      assert.equal('threshold' in stored.broken_when ? stored.broken_when.threshold : 0, 1);
      assert.deepEqual(referenced.issues, []);
    }
  });
});

describe('condition any sugar', () => {
  function context(sentiment: number): EvaluationContext {
    return {
      sessionId: 'session',
      scenarioId: 'scenario',
      elapsedMinutes: 10,
      currentState: { social_state: { sentiment_score: sentiment } },
      executedDecisions: [],
      publishedScenarioInjectIds: [],
    };
  }

  test('{ any } is threshold 1 in the evaluator, the trigger shape and key collection', () => {
    assert.equal(
      evaluateInjectConditions({ any: ['sentiment_below_30', 'sentiment_above_60'] }, null, context(20)).status,
      'appear_met',
    );
    assert.equal(
      evaluateInjectConditions({ any: ['sentiment_below_30'] }, null, context(50)).status,
      'not_eligible',
    );
    assert.equal(
      evaluateInjectConditions(
        { all: ['sentiment_below_30', 'sentiment_above_60'] },
        null,
        context(20),
      ).status,
      'not_eligible',
    );
    assert.equal(
      evaluateInjectConditions({ threshold: 1, conditions: ['sentiment_above_60'] }, null, context(80)).status,
      'appear_met',
    );
    assert.deepEqual(collectConditionKeys({ any: ['unresponded:k:10|team=@upstream'] }, null), [
      'unresponded:k:10|team=@upstream',
    ]);
    assert.equal(
      validateInjectTriggerShape({
        trigger_time_minutes: null,
        conditions_to_appear: { any: ['sentiment_below_30'] },
      }),
      'ok',
    );
  });
});
