import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { env } from '../../env.js';
import { supabaseAdmin } from '../../lib/supabaseAdmin.js';
import { buildConditionEvaluationContext } from '../conditions/conditionContextService.js';
import { loadDependencyTick, updateDependencyStates } from './dependencyService.js';

const SESSION = '11111111-1111-4111-8111-111111111111';
const SCENARIO = '22222222-2222-4222-8222-222222222222';
const OPS = '6f1c0000-0000-4000-8000-000000000001';
const COMMS = 'a93e0000-0000-4000-8000-000000000002';

const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);
const originalFlag = env.crossTeamDependencies;

const edge = {
  id: 'dep_ops_headcount_comms',
  kind: 'information',
  upstream: { team_uid: OPS, team_name: 'Operations' },
  downstream: [{ team_uid: COMMS, team_name: 'Communications' }],
  deliverable: 'Confirmed headcount for Bay 3',
  why: 'Communications needs the figure',
  due: { after_inject_key: 'bay3_headcount_request', within_minutes: 10 },
  broken_when: { any: ['unresponded:bay3_headcount_request:10|team=@upstream'] },
  met_when: { any: ['responded_relevant:bay3_headcount_request|team=@upstream'] },
  lag_minutes: 5,
  severity: 'high',
  consequence_keys: ['comms_reporter_presses_for_numbers'],
  source: 'war_room',
};

const session = {
  id: SESSION,
  scenario_id: SCENARIO,
  trainer_id: '33333333-3333-4333-8333-333333333333',
  start_time: '2026-11-28T12:00:00.000Z',
};

describe('dependency reads per tick', () => {
  const calls: string[] = [];
  let initialState: unknown = {};

  after(() => {
    supabaseAdmin.from = originalFrom;
    env.crossTeamDependencies = originalFlag;
  });

  function install(): void {
    env.crossTeamDependencies = true;
    calls.length = 0;
    (supabaseAdmin as { from: (table: string) => unknown }).from = (table: string) => {
      calls.push(table);
      const builder: Record<string, unknown> = {};
      const self = () => builder;
      for (const method of [
        'select',
        'eq',
        'neq',
        'in',
        'is',
        'not',
        'or',
        'order',
        'limit',
        'gte',
        'lte',
        'gt',
        'lt',
        'filter',
        'match',
      ]) {
        builder[method] = self;
      }
      const data =
        table === 'scenarios'
          ? { initial_state: initialState }
          : table === 'scenario_teams'
            ? [
                { team_uid: OPS, team_name: 'Operations', org_key: 'org_a' },
                { team_uid: COMMS, team_name: 'Communications', org_key: 'org_a' },
              ]
            : [];
      const result = { data, error: null, count: 0 };
      builder.maybeSingle = async () => result;
      builder.single = async () => result;
      builder.then = (resolve: (value: unknown) => unknown, reject?: (err: unknown) => unknown) =>
        Promise.resolve(result).then(resolve, reject);
      return builder;
    };
  }

  function count(table: string): number {
    return calls.filter((name) => name === table).length;
  }

  test('one scenarios, state and team read when the tick loads dependencies', async () => {
    initialState = { team_dependencies: { v: 1, edges: [edge] } };
    install();
    const tick = await loadDependencyTick({ sessionId: SESSION, scenarioId: SCENARIO });
    const ctx = await buildConditionEvaluationContext(session, {
      elapsedMinutes: 12,
      currentState: {},
      dependencyTick: tick,
    });
    await updateDependencyStates(session, ctx, 12, tick ?? undefined);
    assert.equal(count('scenarios'), 1);
    assert.equal(count('session_dependency_states'), 1);
    assert.equal(count('scenario_teams'), 1);
  });

  test('a tick that already loaded initial_state does not read it again', async () => {
    initialState = { team_dependencies: { v: 1, edges: [edge] } };
    install();
    const tick = await loadDependencyTick({
      sessionId: SESSION,
      scenarioId: SCENARIO,
      initialState,
      initialStateKnown: true,
    });
    const ctx = await buildConditionEvaluationContext(session, {
      elapsedMinutes: 12,
      currentState: {},
      dependencyTick: tick,
    });
    await updateDependencyStates(session, ctx, 12, tick ?? undefined);
    assert.equal(count('scenarios'), 0);
    assert.equal(count('session_dependency_states'), 1);
    assert.equal(count('scenario_teams'), 1);
  });

  test('no dependency reads when the scenario has no team_dependencies', async () => {
    initialState = { stakeholders: [] };
    install();
    const known = await loadDependencyTick({
      sessionId: SESSION,
      scenarioId: SCENARIO,
      initialState,
      initialStateKnown: true,
    });
    await buildConditionEvaluationContext(session, {
      elapsedMinutes: 12,
      currentState: {},
      dependencyTick: known,
    });
    assert.equal(count('scenarios'), 0);
    assert.equal(count('session_dependency_states'), 0);
    assert.equal(count('scenario_teams'), 0);

    calls.length = 0;
    const loaded = await loadDependencyTick({ sessionId: SESSION, scenarioId: SCENARIO });
    await buildConditionEvaluationContext(session, {
      elapsedMinutes: 12,
      currentState: {},
      dependencyTick: loaded,
    });
    assert.equal(count('scenarios'), 1);
    assert.equal(count('session_dependency_states'), 0);
    assert.equal(count('scenario_teams'), 0);
  });
});
