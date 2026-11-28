import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dutiesByTeam,
  dutySnapshots,
  evaluateTeamTasks,
  type ObservedAction,
} from './teamTasksCore.js';

const START = Date.parse('2026-01-01T00:00:00.000Z');

function atMinute(minute: number): string {
  return new Date(START + minute * 60000).toISOString();
}

function action(partial: Partial<ObservedAction> = {}): ObservedAction {
  return {
    player_id: 'p1',
    action_type: 'draft_approved',
    team_at_action: 'Legal',
    metadata: null,
    created_at: atMinute(12),
    ...partial,
  };
}

const review = {
  action_id: 'legal_review_statement',
  detection_action_type: 'draft_approved',
  timing_benchmark_minutes: 15,
};

describe('charter task status', () => {
  test('a duty is pending before the benchmark, overdue after, and done when matched', () => {
    const pending = evaluateTeamTasks({
      expected: [review],
      actions: [],
      memberIds: ['p1'],
      teamName: 'Legal',
      startMs: START,
      elapsedMinutes: 15,
    });
    assert.equal(pending[0]?.status, 'pending');

    const overdue = evaluateTeamTasks({
      expected: [review],
      actions: [],
      memberIds: ['p1'],
      teamName: 'Legal',
      startMs: START,
      elapsedMinutes: 16,
    });
    assert.equal(overdue[0]?.status, 'overdue');

    const onTime = evaluateTeamTasks({
      expected: [review],
      actions: [action({ created_at: atMinute(15) })],
      memberIds: ['p1'],
      teamName: 'Legal',
      startMs: START,
      elapsedMinutes: 20,
    });
    assert.equal(onTime[0]?.status, 'done');
    assert.equal(onTime[0]?.on_time, true);
    assert.equal(onTime[0]?.completed_minutes, 15);

    const late = evaluateTeamTasks({
      expected: [review],
      actions: [action({ created_at: atMinute(18) })],
      memberIds: ['p1'],
      teamName: 'Legal',
      startMs: START,
      elapsedMinutes: 20,
    });
    assert.equal(late[0]?.on_time, false);
    assert.equal(dutySnapshots(late)[0]?.completed_minute, 18);
  });

  test('fractional minutes keep the score boundary and the duty snapshot uses the session minute', () => {
    const tasks = evaluateTeamTasks({
      expected: [review],
      actions: [action({ created_at: new Date(START + 10.1 * 60000).toISOString() })],
      memberIds: ['p1'],
      teamName: 'Legal',
      startMs: START,
      elapsedMinutes: 20,
    });
    const tightened = { ...review, timing_benchmark_minutes: 10 };
    const boundary = evaluateTeamTasks({
      expected: [tightened],
      actions: [action({ created_at: new Date(START + 10.1 * 60000).toISOString() })],
      memberIds: ['p1'],
      teamName: 'Legal',
      startMs: START,
      elapsedMinutes: 20,
    });
    assert.equal(tasks[0]?.status, 'done');
    assert.equal(boundary[0]?.on_time, false);
    assert.equal(dutySnapshots(boundary)[0]?.completed_minute, 10);
  });

  test('hints, team stamps and an empty roster', () => {
    const hinted = { ...review, detection_hints: { kind: 'statement' } };
    const missed = evaluateTeamTasks({
      expected: [hinted],
      actions: [action({ metadata: { kind: 'other' } })],
      memberIds: ['p1'],
      teamName: 'Legal',
      startMs: START,
      elapsedMinutes: 10,
    });
    assert.equal(missed[0]?.status, 'pending');

    const stamped = evaluateTeamTasks({
      expected: [review],
      actions: [action({ player_id: 'outsider', team_at_action: 'Legal' })],
      memberIds: ['p1'],
      teamName: 'Legal',
      startMs: START,
      elapsedMinutes: 20,
    });
    assert.equal(stamped[0]?.status, 'done');
    assert.equal(stamped[0]?.completed_by, 'outsider');

    const legacy = evaluateTeamTasks({
      expected: [review],
      actions: [action({ player_id: 'p1', team_at_action: null })],
      memberIds: ['p1'],
      teamName: 'Legal',
      startMs: START,
      elapsedMinutes: 20,
    });
    assert.equal(legacy[0]?.status, 'done');

    const otherTeam = evaluateTeamTasks({
      expected: [review],
      actions: [action({ team_at_action: 'Communications' })],
      memberIds: ['p1'],
      teamName: 'Legal',
      startMs: START,
      elapsedMinutes: 10,
    });
    assert.equal(otherTeam[0]?.status, 'pending');

    const unstaffed = evaluateTeamTasks({
      expected: [review],
      actions: [action({})],
      memberIds: [],
      teamName: 'Legal',
      startMs: START,
      elapsedMinutes: 30,
    });
    assert.equal(unstaffed[0]?.status, 'unstaffed');
    assert.deepEqual(dutySnapshots(unstaffed), []);
  });

  test('duties are keyed by team slug and an unstaffed team is left out', () => {
    const duties = dutiesByTeam({
      teams: [
        { team_name: 'Legal', expected: [review] },
        { team_name: 'Communications', expected: [review] },
      ],
      actions: [action({ team_at_action: 'Legal', created_at: atMinute(12) })],
      membersByTeam: new Map([
        ['Legal', ['p1']],
        ['Communications', []],
      ]),
      startMs: START,
    });
    assert.deepEqual(duties.legal, [
      { action_id: 'legal_review_statement', benchmark_minute: 15, completed_minute: 12 },
    ]);
    assert.equal(duties.communications, undefined);
  });
});
