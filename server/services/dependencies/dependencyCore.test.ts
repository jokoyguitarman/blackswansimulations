import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { collectConditionKeys } from '../conditions/conditionCatalog.js';
import { validateInjectTriggerShape } from '../conditions/injectTriggerShape.js';
import {
  describeConditionKey,
  evaluateConditionKey,
  evaluateInjectConditions,
  type EvaluationContext,
} from '../conditionEvaluatorService.js';
import { parseConditionKey } from '../conditions/conditionCatalog.js';
import { assembleConditionEvaluationContext } from '../conditions/conditionContextService.js';
import {
  applyCrossTeamGuards,
  causeDepth,
  crossTeamProfile,
  isCrossTeamHop,
  referencedInjectKeys,
  type CrossTeamCandidate,
} from '../conditions/crossTeamCore.js';
import type { CommsDelivery, CommsState } from '../ledger/injectLedgerCore.js';
import {
  evaluateDependency,
  nextState,
  prepareTeamDependencies,
  toActiveTeams,
  validateDependencies,
  type ActiveTeam,
  type DependencyInjectRef,
  type TeamDependencyEdge,
} from './dependencyCore.js';
import { catalogDependencies, dependencyEdgeSchema, teamDependenciesSchema } from './dependencySchema.js';
import { readDependencyEdge } from '../../../shared/teamDependencies.js';
import {
  dependencyTriggerCause,
  guardKeysForDependency,
  nextHoldMinute,
  planDependencyWrite,
  projectDependencyStates,
  type DependencyRuntimeState,
  type StoredDependencyRow,
} from './dependencyConditionsCore.js';
import {
  dependencyTableMissing,
  rememberDependencyReferences,
  rememberDependencySources,
  withDependencySession,
} from './dependencyService.js';

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

describe('team dependency schema', () => {
  test('the section 6.1 shape round-trips and any normalises to threshold 1', () => {
    const document = { v: 1 as const, edges: [edge()] };
    const parsed = teamDependenciesSchema.parse(document);
    assert.deepEqual(parsed.edges[0]?.broken_when, {
      threshold: 1,
      conditions: [
        'unresponded:bay3_headcount_request:10|team=@upstream',
        'reply_failed:bay3_headcount_request|team=@upstream',
      ],
    });
    assert.deepEqual(parsed.edges[0]?.met_when, {
      threshold: 1,
      conditions: ['responded_relevant:bay3_headcount_request|team=@upstream'],
    });
    assert.deepEqual(teamDependenciesSchema.parse(parsed), parsed);
    const [row] = catalogDependencies(document);
    assert.equal(row?.id, 'dep_ops_headcount_comms');
    assert.deepEqual(row?.state_keys[1], 'dependency_broken_for:dep_ops_headcount_comms:5');
    assert.deepEqual(catalogDependencies({ v: 2, edges: [] }), []);
  });
});

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

const HEAD = 'dep_ops_headcount_comms';
const BROKEN_FOR = `dependency_broken_for:${HEAD}:5`;
const APPEAR = { all: [BROKEN_FOR] };
const CANCEL = [`dependency_resolved:${HEAD}`, `dependency_waived:${HEAD}`];

function parsedEdge(overrides: Record<string, unknown> = {}): TeamDependencyEdge {
  const parsed = teamDependenciesSchema.parse({ v: 1, edges: [edge(overrides)] });
  const found = parsed.edges[0];
  if (!found) throw new Error('edge did not parse');
  return found;
}

function delivery(
  partial: Partial<CommsDelivery> & { delivery_id: string; inject_key: string },
): CommsDelivery {
  return {
    inject_id: 'inj',
    channel: 'email',
    delivered_minute: 8,
    recipient_teams: ['Operations'],
    session_wide: false,
    stakeholder_id: null,
    call_state: null,
    call_group_id: null,
    attempt_no: 1,
    chain_root_key: null,
    chain_step: null,
    urgency: null,
    mood_rung: null,
    opened_minute: null,
    first_response_minute: null,
    first_response_team: null,
    first_response_by_team: {},
    responses: [],
    ...partial,
  };
}

function relevantReply(minute: number): CommsDelivery['responses'][number] {
  return {
    minute,
    team: 'Operations',
    user_id: 'ops-user',
    is_bot: false,
    attribution: 'email_reply',
    judgement_status: 'done',
    judgement: { addresses_inject: true, passed: true },
  };
}

function comms(rows: CommsDelivery[], extra: Partial<CommsState> = {}): CommsState {
  const by_key: Record<string, CommsDelivery[]> = {};
  for (const row of rows) (by_key[row.inject_key] ??= []).push(row);
  return { by_key, generated_at_minute: 0, truncated: false, ...extra };
}

function runtimeContext(
  elapsed: number,
  state: CommsState,
  dependency?: Record<string, DependencyRuntimeState>,
): EvaluationContext {
  return {
    sessionId: 'session-1',
    scenarioId: 'scenario-1',
    elapsedMinutes: elapsed,
    currentState: {
      comms_state: state,
      ...(dependency ? { dependency_state: dependency } : {}),
    },
    executedDecisions: [],
    publishedScenarioInjectIds: [],
  };
}

const silent = comms([delivery({ delivery_id: 'd1', inject_key: 'bay3_headcount_request' })]);

function replyAt(minute: number): CommsState {
  return comms([
    delivery({
      delivery_id: 'd1',
      inject_key: 'bay3_headcount_request',
      responses: [relevantReply(minute)],
    }),
  ]);
}

describe('dependency runtime', () => {
  const opsEdge = parsedEdge();
  const pending = projectDependencyStates([opsEdge], [], TEAMS)[HEAD];
  if (!pending) throw new Error('expected a pending dependency');

  function step(current: DependencyRuntimeState, elapsed: number, state: CommsState) {
    const evaluation = evaluateDependency(opsEdge, runtimeContext(elapsed, state), TEAMS);
    return { evaluation, state: nextState(current, evaluation, elapsed) };
  }

  test('the six dependency keys parse on the cross platform and reject a team scope', () => {
    for (const key of [
      `dependency_broken:${HEAD}`,
      BROKEN_FOR,
      `dependency_met:${HEAD}`,
      `dependency_recovered:${HEAD}`,
      `dependency_resolved:${HEAD}`,
      `dependency_waived:${HEAD}`,
    ]) {
      const parsed = parseConditionKey(key);
      assert.equal('error' in parsed, false, key);
      if ('error' in parsed) continue;
      assert.equal(parsed.def.platform, 'cross', key);
      assert.equal(parsed.def.teamScope, undefined, key);
    }
    const scoped = parseConditionKey(`dependency_broken:${HEAD}|team=operations`);
    assert.equal('error' in scoped, true);
  });

  test('pending becomes broken when the upstream team has not replied, and broken_minute is set once', () => {
    const early = step(pending, 17, silent);
    assert.equal(early.evaluation.broken, false);
    assert.equal(early.state.status, 'pending');
    assert.equal(early.state.broken_minute, null);

    const broken = step(pending, 18, silent);
    assert.equal(broken.evaluation.broken, true);
    assert.equal(broken.state.status, 'broken');
    assert.equal(broken.state.broken_minute, 18);

    const again = step(broken.state, 20, silent);
    assert.equal(again.state.status, 'broken');
    assert.equal(again.state.broken_minute, 18);
  });

  test('met first is never broken, and met wins when both hold in one tick', () => {
    const onTime = step(pending, 12, replyAt(12));
    assert.equal(onTime.evaluation.met, true);
    assert.equal(onTime.evaluation.broken, false);
    assert.equal(onTime.state.status, 'met');
    assert.equal(onTime.state.met_minute, 12);
    const later = nextState(
      onTime.state,
      { broken: true, met: false, evidence: [], inert: false },
      30,
    );
    assert.equal(later.status, 'met');
    assert.equal(later.broken_minute, null);

    const both = step(pending, 19, replyAt(19));
    assert.equal(both.evaluation.met, true);
    assert.equal(both.evaluation.broken, true);
    assert.equal(both.state.status, 'met');
    assert.equal(both.state.broken_minute, null);
  });

  test('broken then met becomes recovered, and the lag key turns off while dependency_broken stays true', () => {
    const broken = step(pending, 18, silent).state;
    const recovered = step(broken, 20, replyAt(20));
    assert.equal(recovered.state.status, 'recovered');
    assert.equal(recovered.state.broken_minute, 18);
    assert.equal(recovered.state.recovered_minute, 20);
    const at = runtimeContext(23, replyAt(20), { [HEAD]: recovered.state });
    assert.equal(evaluateConditionKey(`dependency_broken:${HEAD}`, at), true);
    assert.equal(evaluateConditionKey(BROKEN_FOR, at), false);
    assert.equal(evaluateConditionKey(`dependency_recovered:${HEAD}`, at), true);
    assert.equal(evaluateConditionKey(`dependency_resolved:${HEAD}`, at), true);
    assert.equal(evaluateConditionKey(`dependency_met:${HEAD}`, at), false);
  });

  test('dependency_broken_for is true exactly at the lag and false while a hold is still ahead', () => {
    const broken = step(pending, 18, silent).state;
    const before = runtimeContext(22, silent, { [HEAD]: broken });
    const atLag = runtimeContext(23, silent, { [HEAD]: broken });
    assert.equal(evaluateConditionKey(BROKEN_FOR, before), false);
    assert.equal(evaluateConditionKey(BROKEN_FOR, atLag), true);
    assert.equal(
      describeConditionKey(BROKEN_FOR, atLag).label,
      "Operations didn't deliver \u2018Confirmed headcount for Bay 3\u2019 to Communications (5 min ago)",
    );

    const held = { ...broken, hold_until_minute: 26 };
    assert.equal(evaluateConditionKey(BROKEN_FOR, runtimeContext(23, silent, { [HEAD]: held })), false);
    assert.equal(evaluateConditionKey(`dependency_broken:${HEAD}`, runtimeContext(23, silent, { [HEAD]: held })), true);
    assert.equal(evaluateConditionKey(BROKEN_FOR, runtimeContext(26, silent, { [HEAD]: held })), true);
    assert.equal(nextHoldMinute(null, 18), 23);
    assert.equal(nextHoldMinute(30, 20), 30);
  });

  test('an @downstream key is evaluated once per downstream team and holds if any team matches', () => {
    const fan = parsedEdge({
      downstream: [ref(COMMS, 'Communications'), ref(CS, 'Customer Service')],
      broken_when: { all: ['action_count_gte:post_created:1|team=@downstream'] },
      met_when: null,
    });
    const onlyService = comms([], {
      action_counts: [
        { action_type: 'post_created', team_slug: 'customer_service', count: 1, first_minute: 3 },
      ],
    });
    const hit = evaluateDependency(fan, runtimeContext(6, onlyService), TEAMS);
    assert.equal(hit.broken, true);
    assert.equal(hit.evidence.length, 1);
    assert.match(hit.evidence[0]?.key ?? '', /\|team=customer_service$/);

    const neither = evaluateDependency(fan, runtimeContext(6, comms([])), TEAMS);
    assert.equal(neither.broken, false);
    assert.deepEqual(neither.evidence, []);

    const onlyComms = comms([], {
      action_counts: [
        { action_type: 'post_created', team_slug: 'communications', count: 2, first_minute: 2 },
      ],
    });
    const commsHit = evaluateDependency(fan, runtimeContext(6, onlyComms), TEAMS);
    assert.equal(commsHit.broken, true);
    assert.match(commsHit.evidence[0]?.key ?? '', /\|team=communications$/);
  });

  test('an inert edge never transitions', () => {
    const gone = TEAMS.filter((team) => team.team_uid !== OPS);
    const evaluation = evaluateDependency(opsEdge, runtimeContext(18, silent), gone);
    assert.equal(evaluation.inert, true);
    assert.equal(evaluation.broken, false);
    const stayed = nextState(
      pending,
      { broken: true, met: false, evidence: [], inert: true },
      18,
    );
    assert.equal(stayed.status, 'pending');
    assert.equal(stayed.broken_minute, null);
  });

  test('dependency keys are false and do not throw when the state map is empty', () => {
    const blank = runtimeContext(30, silent);
    for (const key of [
      `dependency_broken:${HEAD}`,
      BROKEN_FOR,
      `dependency_met:${HEAD}`,
      `dependency_recovered:${HEAD}`,
      `dependency_resolved:${HEAD}`,
      `dependency_waived:${HEAD}`,
    ]) {
      assert.equal(evaluateConditionKey(key, blank), false, key);
      assert.equal(describeConditionKey(key, blank).met, false, key);
    }
    assert.equal(dependencyTableMissing({ code: '42P01', message: 'relation missing' }), true);
    assert.equal(dependencyTableMissing({ code: '42703', message: 'column missing' }), true);
    assert.equal(dependencyTableMissing({ code: 'PGRST204', message: 'schema cache' }), true);
    assert.equal(dependencyTableMissing({ code: 'PGRST205', message: 'schema cache' }), true);
    assert.equal(dependencyTableMissing({ code: '23505', message: 'duplicate' }), false);
  });

  test('the trainer panel context and the scheduler context agree on one fixture', () => {
    const transitioned = step(pending, 18, silent).state;
    const row: StoredDependencyRow = {
      dep_id: HEAD,
      status: 'broken',
      upstream_team: 'Operations',
      downstream_teams: ['Communications'],
      broken_minute: 18,
      met_minute: null,
      recovered_minute: null,
      hold_until_minute: null,
      evidence: [],
    };
    const projected = projectDependencyStates([opsEdge], [row], TEAMS)[HEAD];
    assert.ok(projected);
    assert.equal(projected?.status, transitioned.status);
    assert.equal(projected?.broken_minute, transitioned.broken_minute);
    assert.equal(projected?.upstream, transitioned.upstream);
    const parts = {
      sessionId: 'session-1',
      scenarioId: 'scenario-1',
      elapsedMinutes: 23,
      decisions: [],
      publishedEvents: [],
      cancelledEvents: [],
      gates: [],
      gateProgress: [],
      placedAssetsCount: 0,
      keyedInjects: [],
    };
    const scheduler = assembleConditionEvaluationContext({
      ...parts,
      currentState: { comms_state: silent, dependency_state: { [HEAD]: transitioned } },
    });
    const panel = assembleConditionEvaluationContext({
      ...parts,
      currentState: { comms_state: silent, dependency_state: { [HEAD]: projected } },
    });
    for (const key of [`dependency_broken:${HEAD}`, BROKEN_FOR, `dependency_resolved:${HEAD}`]) {
      assert.equal(evaluateConditionKey(key, scheduler), evaluateConditionKey(key, panel), key);
    }
    assert.equal(evaluateConditionKey(BROKEN_FOR, scheduler), true);
  });

  test('example A: Operations silence breaks at T+18 and the Communications consequence fires at T+23 unless they reply first', () => {
    const ignored = step(pending, 18, silent).state;
    assert.equal(ignored.status, 'broken');
    assert.equal(ignored.broken_minute, 18);
    const tooSoon = runtimeContext(22, silent, { [HEAD]: ignored });
    const due = runtimeContext(23, silent, { [HEAD]: ignored });
    assert.equal(evaluateInjectConditions(APPEAR, CANCEL, tooSoon).status, 'not_eligible');
    assert.equal(evaluateInjectConditions(APPEAR, CANCEL, due).status, 'appear_met');

    const early = step(pending, 15, replyAt(15)).state;
    assert.equal(early.status, 'met');
    assert.equal(
      evaluateInjectConditions(APPEAR, CANCEL, runtimeContext(23, replyAt(15), { [HEAD]: early })).status,
      'cancel_met',
    );

    const late = step(ignored, 20, replyAt(20)).state;
    assert.equal(late.status, 'recovered');
    assert.equal(
      evaluateInjectConditions(APPEAR, CANCEL, runtimeContext(23, replyAt(20), { [HEAD]: late })).status,
      'cancel_met',
    );
  });

  test('a dependency key names the upstream team, and a dependency cause records origin fields', () => {
    const insert = planDependencyWrite(null, step(pending, 18, silent).state, [
      { key: 'unresponded:bay3_headcount_request:10|team=operations', detail: 'No reply', minute: 18 },
    ]);
    assert.equal(insert?.op, 'insert');
    assert.equal(insert?.whereStatus, null);
    assert.equal(insert?.row.upstream_team, 'Operations');
    assert.deepEqual(insert?.row.downstream_teams, ['Communications']);
    const recovered = step(step(pending, 18, silent).state, 20, replyAt(20)).state;
    const update = planDependencyWrite('broken', recovered, []);
    assert.equal(update?.op, 'update');
    assert.equal(update?.whereStatus, 'broken');
    assert.equal(Object.prototype.hasOwnProperty.call(update?.row ?? {}, 'upstream_team'), false);
    assert.equal(planDependencyWrite('broken', step(pending, 18, silent).state, []), null);

    assert.deepEqual(
      dependencyTriggerCause({ cause: { kind: 'dependency', dep_id: HEAD } }),
      { cause_kind: 'dependency', dep_id: HEAD },
    );
    assert.equal(dependencyTriggerCause({ cause: { kind: 'mood', dep_id: HEAD } }).dep_id, null);
    assert.equal(
      isCrossTeamHop({
        origin: 'dependency',
        cause_depth: 1,
        source_teams: ['Operations'],
        target_teams: ['Communications'],
      }),
      true,
    );

    rememberDependencySources('sess-dep', new Map([[HEAD, ['Operations']]]));
    const profile = withDependencySession('sess-dep', () =>
      crossTeamProfile({ target_teams: ['Communications'] }, [BROKEN_FOR], [
        { name: 'Operations' },
        { name: 'Communications' },
      ]),
    );
    assert.deepEqual(profile.source_teams, ['Operations']);
    assert.equal(profile.is_cross_team, true);
  });
});

describe('dependency keys feed the loop guard and the cascade cap', () => {
  const brokenWhen = {
    any: [
      'unresponded:cons_comms_legal:5|team=@upstream',
      'unresponded:legal_own_mail:10|team=@upstream',
      'duty_missed:legal_review_statement|team=@upstream',
    ],
  };
  const duty = 'duty_missed:legal_review_statement|team=legal';
  const depKey = 'dependency_broken_for:dep_legal_statement_comms:5';
  const guardEnv = {
    maxPerTeamWindow: 2,
    windowMinutes: 15,
    pressureMaxDeliveries10Min: 6,
    loopWindowMinutes: 20,
    maxCascadeDepth: 3,
  };

  test('held evidence is preferred, and broken_when is the fallback', () => {
    assert.deepEqual(
      guardKeysForDependency(brokenWhen, [{ key: 'unresponded:cons_comms_legal:5|team=legal' }]),
      ['cons_comms_legal'],
    );
    assert.deepEqual(
      guardKeysForDependency(brokenWhen, [
        { key: 'unresponded:cons_comms_legal:5|team=legal' },
        { key: duty },
      ]),
      ['cons_comms_legal', duty],
    );
    assert.deepEqual(guardKeysForDependency(brokenWhen, []), [
      'cons_comms_legal',
      'legal_own_mail',
      'duty_missed:legal_review_statement|team=@upstream',
    ]);
  });

  test('example C is held at T+30, released at T+41, and publishes when the duty also held', () => {
    const recent = [
      {
        inject_key: 'cons_comms_legal',
        minute: 20,
        source_teams: ['Communications'],
        target_teams: ['Legal'],
        origin: 'dependency',
        is_cross_team: true,
        cause_depth: 1,
      },
    ];
    const candidate = (minute: number): CrossTeamCandidate => ({
      id: 'cons_legal_comms',
      inject_key: 'cons_legal_comms',
      minute,
      severity: 'medium',
      source_teams: ['Legal'],
      target_teams: ['Communications'],
      is_cross_team: true,
      origin: 'dependency',
      cause_depth: 2,
      met_keys: [depKey],
    });
    const session = 'example-c';
    rememberDependencyReferences(
      session,
      new Map([['dep_legal_statement_comms', guardKeysForDependency(brokenWhen, [
        { key: 'unresponded:cons_comms_legal:5|team=legal' },
      ])]]),
    );
    const held = withDependencySession(session, () =>
      applyCrossTeamGuards([candidate(30)], recent, [], guardEnv),
    );
    assert.equal(held.hold[0]?.id, 'cons_legal_comms');
    assert.equal(held.publish.length, 0);
    const released = withDependencySession(session, () =>
      applyCrossTeamGuards([candidate(41)], recent, [], guardEnv),
    );
    assert.equal(released.hold.length, 0);
    assert.equal(released.publish[0]?.id, 'cons_legal_comms');

    rememberDependencyReferences(
      session,
      new Map([[
        'dep_legal_statement_comms',
        guardKeysForDependency(brokenWhen, [
          { key: 'unresponded:cons_comms_legal:5|team=legal' },
          { key: duty },
        ]),
      ]]),
    );
    const independent = withDependencySession(session, () =>
      applyCrossTeamGuards([candidate(30)], recent, [], guardEnv),
    );
    assert.equal(independent.hold.length, 0);
    assert.equal(independent.publish[0]?.id, 'cons_legal_comms');
    assert.deepEqual(withDependencySession(session, () => referencedInjectKeys(depKey)), [
      'cons_comms_legal',
      duty,
    ]);
  });

  test('the fourth dependency hop is cancelled by the cascade cap', () => {
    const session = 'dep-chain';
    const parents = [
      ['dep_1', 'root'],
      ['dep_2', 'c1'],
      ['dep_3', 'c2'],
      ['dep_4', 'c3'],
    ] as const;
    rememberDependencyReferences(
      session,
      new Map(parents.map(([dep, inject]) => [dep, [inject]])),
    );
    const hops = [
      { dep: 'dep_1', inject: 'c1', source: 'A', target: 'B' },
      { dep: 'dep_2', inject: 'c2', source: 'B', target: 'C' },
      { dep: 'dep_3', inject: 'c3', source: 'C', target: 'D' },
      { dep: 'dep_4', inject: 'c4', source: 'D', target: 'A' },
    ];
    const triggers: Record<string, { cause_depth: number; source_teams: string[]; target_teams: string[]; origin: string; is_cross_team: boolean }> = {
      root: {
        cause_depth: 0,
        source_teams: ['A'],
        target_teams: ['A'],
        origin: 'timed',
        is_cross_team: false,
      },
    };
    const candidates: CrossTeamCandidate[] = [];
    withDependencySession(session, () => {
      for (const hop of hops) {
        const depth = causeDepth([`dependency_broken_for:${hop.dep}:5`], triggers);
        triggers[hop.inject] = {
          cause_depth: depth,
          source_teams: [hop.source],
          target_teams: [hop.target],
          origin: 'dependency',
          is_cross_team: true,
        };
        candidates.push({
          id: hop.inject,
          inject_key: hop.inject,
          minute: 40,
          severity: 'medium',
          cause_depth: depth,
          is_cross_team: true,
          source_teams: [hop.source],
          target_teams: [hop.target],
          origin: 'dependency',
          met_keys: [`dependency_broken_for:${hop.dep}:5`],
        });
      }
    });
    assert.deepEqual(
      hops.map((hop) => triggers[hop.inject]?.cause_depth),
      [1, 2, 3, 4],
    );
    const result = applyCrossTeamGuards(candidates, [], [], guardEnv);
    assert.deepEqual(
      result.publish.map((item) => item.id),
      ['c1', 'c2', 'c3'],
    );
    assert.equal(result.cancel[0]?.reason, 'cascade_cap');
    assert.equal(result.cancel[0]?.candidate.id, 'c4');
  });
});

describe('shared reader and zod schema', () => {
  test('they accept the same edge and reject a non-uuid team', () => {
    const stored = edge();
    const parsed = dependencyEdgeSchema.safeParse(stored);
    const shared = readDependencyEdge(stored);
    assert.equal(parsed.success, true);
    assert.ok(!('error' in shared));
    if (!parsed.success || 'error' in shared) return;
    assert.equal(shared.edge.id, parsed.data.id);
    assert.equal(shared.edge.deliverable, parsed.data.deliverable);
    assert.equal(shared.edge.lag_minutes, parsed.data.lag_minutes);
    assert.equal(shared.edge.upstream.team_uid, parsed.data.upstream.team_uid);
    assert.deepEqual(
      'conditions' in shared.edge.broken_when ? shared.edge.broken_when.conditions : shared.edge.broken_when.all,
      'conditions' in parsed.data.broken_when ? parsed.data.broken_when.conditions : parsed.data.broken_when.all,
    );

    const badUid = edge({ upstream: { team_uid: 'not-a-uuid', team_name: 'Operations' } });
    assert.equal(dependencyEdgeSchema.safeParse(badUid).success, false);
    assert.ok('error' in readDependencyEdge(badUid));

    const emptyName = edge({ upstream: { team_uid: null, team_name: '  ' } });
    assert.equal(dependencyEdgeSchema.safeParse(emptyName).success, true);
    const sharedEmpty = readDependencyEdge(emptyName);
    assert.ok(!('error' in sharedEmpty));
    if ('error' in sharedEmpty) return;
    assert.equal(sharedEmpty.edge.upstream.team_name, '');
  });
});
