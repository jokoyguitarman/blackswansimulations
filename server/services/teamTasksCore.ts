/**
 * Charter-duty matching shared by team scores and team-signal conditions.
 * No database access.
 */

import { slugifyTeamName } from '../../shared/conditionKeyGrammar.js';

export interface CharterAction {
  action_id: string;
  detection_action_type: string;
  detection_hints?: Record<string, unknown>;
  timing_benchmark_minutes: number | null;
}

export interface ObservedAction {
  player_id: string;
  action_type: string;
  team_at_action: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

export interface EvaluatedTask {
  action_id: string;
  benchmark_minutes: number | null;
  status: 'done' | 'pending' | 'overdue' | 'unstaffed';
  completed_at: string | null;
  completed_by: string | null;
  on_time: boolean | null;
  /** Fractional minutes after the session start. Null when the clock or the action has no time. */
  completed_minutes: number | null;
}

export interface DutySnapshot {
  action_id: string;
  benchmark_minute: number | null;
  completed_minute: number | null;
}

/** Loose subset match of detection hints against action metadata. */
function hintsMatch(
  hints: Record<string, unknown> | undefined,
  metadata: Record<string, unknown> | null,
): boolean {
  if (!hints) return true;
  if (!metadata) return false;
  return Object.entries(hints).every(([key, value]) => metadata[key] === value);
}

/**
 * Same task status the team score uses. Actions are matched in the order given,
 * so the caller passes them oldest first and the earliest hit wins.
 */
export function evaluateTeamTasks(input: {
  expected: readonly CharterAction[];
  actions: readonly ObservedAction[];
  memberIds: readonly string[];
  teamName: string;
  startMs: number | null;
  elapsedMinutes: number | null;
}): EvaluatedTask[] {
  const memberSet = new Set(input.memberIds);
  const unstaffed = input.memberIds.length === 0;
  const teamActions = input.actions.filter((action) => {
    if (action.team_at_action) return action.team_at_action === input.teamName;
    return memberSet.has(action.player_id);
  });

  return input.expected.map((expected) => {
    const benchmark = expected.timing_benchmark_minutes;
    if (unstaffed) {
      return {
        action_id: expected.action_id,
        benchmark_minutes: benchmark,
        status: 'unstaffed',
        completed_at: null,
        completed_by: null,
        on_time: null,
        completed_minutes: null,
      };
    }

    const match = teamActions.find(
      (action) =>
        action.action_type === expected.detection_action_type &&
        hintsMatch(expected.detection_hints, action.metadata),
    );
    if (match) {
      const completedMs = new Date(match.created_at).getTime();
      const completedMinutes =
        input.startMs != null && Number.isFinite(input.startMs) && Number.isFinite(completedMs)
          ? (completedMs - input.startMs) / 60000
          : null;
      const onTime =
        benchmark != null && completedMinutes != null ? completedMinutes <= benchmark : true;
      return {
        action_id: expected.action_id,
        benchmark_minutes: benchmark,
        status: 'done',
        completed_at: match.created_at,
        completed_by: match.player_id,
        on_time: onTime,
        completed_minutes: completedMinutes,
      };
    }

    const overdue =
      benchmark != null && input.elapsedMinutes != null && input.elapsedMinutes > benchmark;
    return {
      action_id: expected.action_id,
      benchmark_minutes: benchmark,
      status: overdue ? 'overdue' : 'pending',
      completed_at: null,
      completed_by: null,
      on_time: null,
      completed_minutes: null,
    };
  });
}

/** Unstaffed teams are omitted: an empty roster is not a missed duty. */
export function dutySnapshots(tasks: readonly EvaluatedTask[]): DutySnapshot[] {
  if (tasks.length === 0 || tasks.every((task) => task.status === 'unstaffed')) return [];
  return tasks
    .filter((task) => task.status !== 'unstaffed')
    .map((task) => ({
      action_id: task.action_id,
      benchmark_minute: task.benchmark_minutes,
      completed_minute:
        task.completed_minutes == null ? null : Math.max(0, Math.floor(task.completed_minutes)),
    }));
}

export function dutiesByTeam(input: {
  teams: readonly { team_name: string; expected: readonly CharterAction[] }[];
  actions: readonly ObservedAction[];
  membersByTeam: ReadonlyMap<string, readonly string[]>;
  startMs: number | null;
}): Record<string, DutySnapshot[]> {
  const out: Record<string, DutySnapshot[]> = {};
  for (const team of input.teams) {
    const slug = slugifyTeamName(team.team_name);
    if (!slug || out[slug]) continue;
    const snapshots = dutySnapshots(
      evaluateTeamTasks({
        expected: team.expected,
        actions: input.actions,
        memberIds: input.membersByTeam.get(team.team_name) ?? [],
        teamName: team.team_name,
        startMs: input.startMs,
        elapsedMinutes: null,
      }),
    );
    if (snapshots.length > 0) out[slug] = snapshots;
  }
  return out;
}
