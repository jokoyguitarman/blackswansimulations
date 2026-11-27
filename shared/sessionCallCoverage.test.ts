import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildStartOverride,
  computeCallCoverage,
  mayStart,
  startWithUnfilledPayload,
  type CallCoverageInput,
  type CoverageInject,
} from './sessionCallCoverage.js';

const aisha = { user_id: 'aisha', name: 'Aisha', online: true };
const ben = { user_id: 'ben', name: 'Ben', online: true };

function base(overrides: Partial<CallCoverageInput> = {}): CallCoverageInput {
  return {
    beforeStart: true,
    booth: false,
    envGate: 'enforce',
    scenarioGate: 'enforce',
    roles: [
      { role_id: 'cs_head', title: 'Head of Customer Service', team_name: 'Customer Service' },
      { role_id: 'plant_manager_jb', title: 'Plant Manager, Johor', team_name: 'Operations' },
      { role_id: 'union_liaison', title: 'Union Liaison', team_name: 'Operations' },
    ],
    injects: [],
    roleAssignments: [],
    lines: [],
    teams: [
      { team_name: 'Customer Service', members: [aisha, ben] },
      { team_name: 'Operations', members: [ben] },
      { team_name: 'Legal', members: [] },
    ],
    ...overrides,
  };
}

function inject(partial: Partial<CoverageInject> & Pick<CoverageInject, 'id' | 'app'>): CoverageInject {
  return { title: partial.id, ...partial };
}

describe('computeCallCoverage', () => {
  test('timed role calls are required and conditional or decision injects are warnings', () => {
    const coverage = computeCallCoverage(
      base({
        injects: [
          inject({ id: 'timed', app: 'phone_call', title: 'Pastor', trigger_time_minutes: 5, target_role_id: 'cs_head' }),
          inject({
            id: 'branch',
            app: 'phone_call',
            title: 'strike',
            target_role_id: 'union_liaison',
            conditions_to_appear: { all: ['x'] },
          }),
          inject({
            id: 'chain',
            app: 'phone_call',
            title: 'chaser',
            target_role_id: 'cs_head',
            chain_of_timed_root: true,
          }),
          inject({
            id: 'decision',
            app: 'email',
            title: 'decision',
            target_role_id: 'plant_manager_jb',
            trigger_condition: 'keyword',
          }),
        ],
        roleAssignments: [{ ...aisha, role_id: 'cs_head' }],
      }),
    );
    const cs = coverage.items.find((item) => item.key === 'cs_head');
    const union = coverage.items.find((item) => item.key === 'union_liaison');
    const plant = coverage.items.find((item) => item.key === 'plant_manager_jb');
    assert.equal(cs?.required, true);
    assert.equal(cs?.satisfied, true);
    assert.equal(union?.required, false);
    assert.ok(coverage.warnings.some((warning) => warning.includes('Union Liaison')));
    assert.equal(plant?.required, false);
    assert.equal(coverage.covered, true);
  });

  test('a timed team call needs a member and a holder; a timed team email needs a member only', () => {
    const coverage = computeCallCoverage(
      base({
        injects: [
          inject({ id: 'call', app: 'phone_call', trigger_time_minutes: 15, teams: ['Legal'] }),
          inject({ id: 'mail', app: 'email', trigger_time_minutes: 12, teams: ['Operations'] }),
        ],
      }),
    );
    const legal = coverage.items.find((item) => item.kind === 'line' && item.key === 'Legal');
    const ops = coverage.items.find((item) => item.kind === 'team' && item.key === 'Operations');
    assert.equal(legal?.reason, 'no_member');
    assert.equal(legal?.satisfied, false);
    assert.equal(ops?.satisfied, true);
    const withMembers = computeCallCoverage(
      base({
        injects: [inject({ id: 'call', app: 'phone_call', trigger_time_minutes: 15, teams: ['Customer Service'] })],
        lines: [{ team_name: 'Customer Service', holders: [] }],
      }),
    );
    assert.equal(
      withMembers.items.find((item) => item.kind === 'line')?.reason,
      'no_line_holder',
    );
  });

  test('one player can hold three roles, and max_per_session is enforced', () => {
    const held = computeCallCoverage(
      base({
        injects: [
          inject({ id: 'a', app: 'email', trigger_time_minutes: 1, target_role_id: 'cs_head' }),
          inject({ id: 'b', app: 'email', trigger_time_minutes: 2, target_role_id: 'plant_manager_jb' }),
          inject({ id: 'c', app: 'email', trigger_time_minutes: 3, target_role_id: 'union_liaison' }),
        ],
        roleAssignments: [
          { ...aisha, role_id: 'cs_head' },
          { ...aisha, role_id: 'plant_manager_jb' },
          { ...aisha, role_id: 'union_liaison' },
        ],
        teams: [
          { team_name: 'Customer Service', members: [aisha] },
          { team_name: 'Operations', members: [aisha] },
        ],
      }),
    );
    assert.equal(held.covered, true);
    assert.equal(held.items.filter((item) => item.kind === 'role' && item.satisfied).length, 3);

    const tooMany = computeCallCoverage(
      base({
        injects: [inject({ id: 'a', app: 'email', trigger_time_minutes: 1, target_role_id: 'cs_head' })],
        roleAssignments: [
          { ...aisha, role_id: 'cs_head' },
          { ...ben, role_id: 'cs_head' },
        ],
      }),
    );
    assert.equal(tooMany.items.find((item) => item.key === 'cs_head')?.reason, 'too_many_players');
    assert.equal(tooMany.covered, false);
  });

  test('load is high or overloaded and never blocks a covered roster', () => {
    const high = computeCallCoverage(
      base({
        injects: [
          inject({ id: 'c1', app: 'phone_call', trigger_time_minutes: 5, teams: ['Customer Service'] }),
          inject({ id: 'c2', app: 'phone_call', trigger_time_minutes: 8, teams: ['Customer Service'] }),
        ],
        roleAssignments: [
          { ...aisha, role_id: 'cs_head' },
          { ...aisha, role_id: 'plant_manager_jb' },
        ],
        lines: [{ team_name: 'Customer Service', holders: [aisha] }],
        teams: [{ team_name: 'Customer Service', members: [aisha, ben] }],
      }),
    );
    const aishaLoad = high.load.find((row) => row.user_id === 'aisha');
    assert.equal(aishaLoad?.max_overlap, 2);
    assert.equal(aishaLoad?.level, 'high');
    assert.equal(high.covered, true);

    const overloaded = computeCallCoverage(
      base({
        roles: Array.from({ length: 5 }, (_, index) => ({
          role_id: `r${index}`,
          title: `Role ${index}`,
          team_name: 'Customer Service',
        })),
        injects: Array.from({ length: 5 }, (_, index) =>
          inject({ id: `i${index}`, app: 'email', trigger_time_minutes: index, target_role_id: `r${index}` }),
        ),
        roleAssignments: Array.from({ length: 5 }, (_, index) => ({ ...aisha, role_id: `r${index}` })),
        teams: [{ team_name: 'Customer Service', members: [aisha] }],
      }),
    );
    assert.equal(overloaded.load.find((row) => row.user_id === 'aisha')?.level, 'overloaded');
    assert.equal(overloaded.covered, true);
  });

  test('legacy scenarios warn, enforce blocks, and the env cap can turn the gate off', () => {
    const gaps = {
      injects: [inject({ id: 'call', app: 'phone_call', trigger_time_minutes: 8, target_role_id: 'cs_head' })],
    };
    const legacy = computeCallCoverage(base({ ...gaps, scenarioGate: null }));
    assert.equal(legacy.mode, 'warn');
    assert.equal(legacy.covered, false);
    assert.equal(mayStart(legacy, false), true);

    const enforced = computeCallCoverage(base(gaps));
    assert.equal(enforced.mode, 'enforce');
    assert.equal(mayStart(enforced, false), false);

    const forced = computeCallCoverage(base({ ...gaps, envGate: 'warn' }));
    assert.equal(forced.mode, 'warn');
    assert.equal(mayStart(forced, false), true);

    const off = computeCallCoverage(base({ ...gaps, envGate: 'off' }));
    assert.equal(off.applies, false);
    assert.equal(mayStart(off, false), true);
  });

  test('an acknowledged override records the gaps and the start event', () => {
    const coverage = computeCallCoverage(
      base({
        injects: [inject({ id: 'call', app: 'phone_call', trigger_time_minutes: 8, target_role_id: 'cs_head' })],
      }),
    );
    assert.equal(mayStart(coverage, true), true);
    assert.equal(mayStart(coverage, false), false);
    const record = buildStartOverride('trainer-1', '2026-11-27T12:00:00.000Z', coverage);
    assert.equal(record.by, 'trainer-1');
    assert.deepEqual(record.warnings, ['role:cs_head']);
    const event = startWithUnfilledPayload(coverage);
    assert.equal(event.event_type, 'start_with_unfilled');
    assert.equal(event.metadata.items[0]?.key, 'cs_head');
  });
});
