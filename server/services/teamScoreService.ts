import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { getWebSocketService } from './websocketService.js';
import { getCatalogCharter, type TeamExpectedAction } from './teamCharterService.js';

/**
 * Live per-team scoring for the social media crisis module.
 *
 * The team score is a pure, recomputable rollup over immutable event history —
 * nothing mutates on the hot path, so a crash or double-recompute can never
 * corrupt it. Composite = ~50% content quality (AI grades on members'
 * posts/emails), ~35% expected-task completion/timeliness, ~15% role fit.
 *
 * Teams with zero members score null ("unstaffed"), never 0 — an empty team is
 * a staffing problem for the trainer, not a failing grade.
 */

export interface TeamTaskStatus {
  action_id: string;
  description: string;
  tier: number;
  weight: number;
  detection_action_type: string;
  timing_benchmark_minutes: number | null;
  status: 'done' | 'pending' | 'overdue' | 'unstaffed';
  completed_at: string | null;
  completed_by: string | null;
  on_time: boolean | null;
}

export interface TeamMemberSummary {
  user_id: string;
  display_name: string;
  graded_items: number;
  avg_overall: number | null;
  avg_role_fit: number | null;
}

export interface TeamScore {
  team_name: string;
  mission: string;
  member_count: number;
  members: TeamMemberSummary[];
  tasks: TeamTaskStatus[];
  tasks_done: number;
  tasks_total: number;
  content_quality: number | null;
  task_completion: number | null;
  role_fit: number | null;
  composite_score: number | null;
  graded_items: number;
  most_urgent_overdue: { description: string; minutes_overdue: number } | null;
}

export interface TeamScoreReport {
  teams: TeamScore[];
  unassigned: Array<{ user_id: string; display_name: string }>;
  elapsed_minutes: number | null;
  computed_at: string;
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

export async function computeTeamScores(sessionId: string): Promise<TeamScoreReport> {
  const { data: session } = await supabaseAdmin
    .from('sessions')
    .select('scenario_id, start_time, trainer_id')
    .eq('id', sessionId)
    .single();

  const emptyReport: TeamScoreReport = {
    teams: [],
    unassigned: [],
    elapsed_minutes: null,
    computed_at: new Date().toISOString(),
  };

  if (!session?.scenario_id) return emptyReport;

  const [teamsRes, membershipRes, participantsRes, actionsRes, postsRes, emailsRes] =
    await Promise.all([
      supabaseAdmin
        .from('scenario_teams')
        .select('team_name, team_description, charter, expected_actions')
        .eq('scenario_id', session.scenario_id)
        .order('team_name', { ascending: true }),
      supabaseAdmin
        .from('session_teams')
        .select('user_id, team_name, assigned_at')
        .eq('session_id', sessionId)
        .order('assigned_at', { ascending: true }),
      supabaseAdmin
        .from('session_participants')
        .select('user_id, role')
        .eq('session_id', sessionId),
      supabaseAdmin
        .from('player_actions')
        .select('player_id, action_type, team_at_action, metadata, created_at')
        .eq('session_id', sessionId)
        .order('created_at', { ascending: true }),
      supabaseAdmin
        .from('social_posts')
        .select('posted_by_user_id, sop_compliance_score')
        .eq('session_id', sessionId)
        .eq('author_type', 'player')
        .not('sop_compliance_score', 'is', null),
      supabaseAdmin
        .from('sim_emails')
        .select('sent_by_player_id, sop_compliance_score')
        .eq('session_id', sessionId)
        .not('sent_by_player_id', 'is', null)
        .not('sop_compliance_score', 'is', null),
    ]);

  const scenarioTeams = teamsRes.data || [];
  if (scenarioTeams.length === 0) return emptyReport;

  const startTime = session.start_time ? new Date(session.start_time).getTime() : null;
  const elapsedMinutes = startTime ? (Date.now() - startTime) / 60000 : null;

  // Player -> team (earliest assignment wins for legacy multi-team rows).
  const teamByPlayer = new Map<string, string>();
  for (const row of membershipRes.data || []) {
    const pid = String(row.user_id);
    if (!teamByPlayer.has(pid)) teamByPlayer.set(pid, String(row.team_name));
  }

  const membersByTeam = new Map<string, string[]>();
  for (const [pid, team] of teamByPlayer) {
    const list = membersByTeam.get(team);
    if (list) list.push(pid);
    else membersByTeam.set(team, [pid]);
  }

  // Grades per player (posts + emails).
  interface GradeAccum {
    overallSum: number;
    overallCount: number;
    roleFitSum: number;
    roleFitCount: number;
  }
  const gradesByPlayer = new Map<string, GradeAccum>();
  const accumulate = (pid: string | null, score: Record<string, unknown> | null) => {
    if (!pid || !score) return;
    const overall = Number(score.overall);
    if (Number.isNaN(overall)) return;
    let acc = gradesByPlayer.get(pid);
    if (!acc) {
      acc = { overallSum: 0, overallCount: 0, roleFitSum: 0, roleFitCount: 0 };
      gradesByPlayer.set(pid, acc);
    }
    acc.overallSum += overall;
    acc.overallCount += 1;
    const roleFit = Number(score.role_fit);
    if (!Number.isNaN(roleFit) && score.role_fit != null) {
      acc.roleFitSum += roleFit;
      acc.roleFitCount += 1;
    }
  };
  for (const p of postsRes.data || []) {
    accumulate(
      p.posted_by_user_id ? String(p.posted_by_user_id) : null,
      (p.sop_compliance_score as Record<string, unknown>) || null,
    );
  }
  for (const e of emailsRes.data || []) {
    accumulate(
      e.sent_by_player_id ? String(e.sent_by_player_id) : null,
      (e.sop_compliance_score as Record<string, unknown>) || null,
    );
  }

  // Resolve display names for everyone involved.
  const allPlayerIds = new Set<string>();
  for (const p of participantsRes.data || []) allPlayerIds.add(String(p.user_id));
  for (const pid of teamByPlayer.keys()) allPlayerIds.add(pid);
  const nameById = new Map<string, string>();
  if (allPlayerIds.size > 0) {
    const { data: profiles } = await supabaseAdmin
      .from('user_profiles')
      .select('id, full_name')
      .in('id', Array.from(allPlayerIds));
    for (const pr of profiles || []) {
      nameById.set(String(pr.id), String(pr.full_name || 'Unknown'));
    }
  }

  const actions = actionsRes.data || [];

  const teams: TeamScore[] = scenarioTeams.map((teamRow) => {
    const teamName = String(teamRow.team_name);
    const memberIds = membersByTeam.get(teamName) || [];
    const memberSet = new Set(memberIds);
    const charterJson = (teamRow.charter || {}) as Record<string, unknown>;
    const catalogFallback = getCatalogCharter(teamName);
    const mission =
      (charterJson.mission as string) ||
      String(teamRow.team_description || '') ||
      catalogFallback?.mission ||
      '';
    const expectedActions =
      (teamRow.expected_actions as TeamExpectedAction[] | null) ||
      catalogFallback?.expected_actions ||
      [];

    // An action counts for this team when it was stamped with the team at
    // write time, or (legacy rows without a stamp) when its author is a
    // current member.
    const teamActions = actions.filter((a) => {
      if (a.team_at_action) return String(a.team_at_action) === teamName;
      return memberSet.has(String(a.player_id));
    });

    const unstaffed = memberIds.length === 0;

    const tasks: TeamTaskStatus[] = expectedActions.map((expected) => {
      if (unstaffed) {
        return {
          action_id: expected.action_id,
          description: expected.description,
          tier: expected.tier,
          weight: expected.weight,
          detection_action_type: expected.detection_action_type,
          timing_benchmark_minutes: expected.timing_benchmark_minutes,
          status: 'unstaffed',
          completed_at: null,
          completed_by: null,
          on_time: null,
        };
      }

      const match = teamActions.find(
        (a) =>
          String(a.action_type) === expected.detection_action_type &&
          hintsMatch(expected.detection_hints, (a.metadata as Record<string, unknown>) || null),
      );

      if (match) {
        const completedMinutes = startTime
          ? (new Date(String(match.created_at)).getTime() - startTime) / 60000
          : null;
        const onTime =
          expected.timing_benchmark_minutes != null && completedMinutes != null
            ? completedMinutes <= expected.timing_benchmark_minutes
            : true;
        return {
          action_id: expected.action_id,
          description: expected.description,
          tier: expected.tier,
          weight: expected.weight,
          detection_action_type: expected.detection_action_type,
          timing_benchmark_minutes: expected.timing_benchmark_minutes,
          status: 'done',
          completed_at: String(match.created_at),
          completed_by: String(match.player_id),
          on_time: onTime,
        };
      }

      const overdue =
        expected.timing_benchmark_minutes != null &&
        elapsedMinutes != null &&
        elapsedMinutes > expected.timing_benchmark_minutes;

      return {
        action_id: expected.action_id,
        description: expected.description,
        tier: expected.tier,
        weight: expected.weight,
        detection_action_type: expected.detection_action_type,
        timing_benchmark_minutes: expected.timing_benchmark_minutes,
        status: overdue ? 'overdue' : 'pending',
        completed_at: null,
        completed_by: null,
        on_time: null,
      };
    });

    // Weighted task completion; late completions earn 60% credit.
    const totalWeight = tasks.reduce((sum, t) => sum + (t.weight || 1), 0);
    const earnedWeight = tasks.reduce((sum, t) => {
      if (t.status !== 'done') return sum;
      return sum + (t.weight || 1) * (t.on_time === false ? 0.6 : 1);
    }, 0);
    const taskCompletion =
      unstaffed || totalWeight === 0 ? null : Math.round((earnedWeight / totalWeight) * 100);

    // Content quality + role fit across member artifacts.
    let overallSum = 0;
    let overallCount = 0;
    let roleFitSum = 0;
    let roleFitCount = 0;
    const members: TeamMemberSummary[] = memberIds.map((pid) => {
      const acc = gradesByPlayer.get(pid);
      if (acc) {
        overallSum += acc.overallSum;
        overallCount += acc.overallCount;
        roleFitSum += acc.roleFitSum;
        roleFitCount += acc.roleFitCount;
      }
      return {
        user_id: pid,
        display_name: nameById.get(pid) || 'Unknown',
        graded_items: acc?.overallCount || 0,
        avg_overall:
          acc && acc.overallCount > 0 ? Math.round(acc.overallSum / acc.overallCount) : null,
        avg_role_fit:
          acc && acc.roleFitCount > 0 ? Math.round(acc.roleFitSum / acc.roleFitCount) : null,
      };
    });

    const contentQuality = overallCount > 0 ? Math.round(overallSum / overallCount) : null;
    const roleFit = roleFitCount > 0 ? Math.round(roleFitSum / roleFitCount) : null;

    // Composite: weighted average over the available components so a team is
    // not penalised for components that have no data yet.
    let composite: number | null = null;
    if (!unstaffed) {
      const components: Array<{ value: number; weight: number }> = [];
      if (contentQuality != null) components.push({ value: contentQuality, weight: 0.5 });
      if (taskCompletion != null) components.push({ value: taskCompletion, weight: 0.35 });
      if (roleFit != null) components.push({ value: roleFit, weight: 0.15 });
      const weightSum = components.reduce((s, c) => s + c.weight, 0);
      if (weightSum > 0) {
        composite = Math.round(components.reduce((s, c) => s + c.value * c.weight, 0) / weightSum);
      }
    }

    // Most urgent overdue task (largest overshoot) for the trainer alert.
    let mostUrgent: { description: string; minutes_overdue: number } | null = null;
    if (elapsedMinutes != null) {
      for (const t of tasks) {
        if (t.status !== 'overdue' || t.timing_benchmark_minutes == null) continue;
        const minutesOverdue = Math.round(elapsedMinutes - t.timing_benchmark_minutes);
        if (!mostUrgent || minutesOverdue > mostUrgent.minutes_overdue) {
          mostUrgent = { description: t.description, minutes_overdue: minutesOverdue };
        }
      }
    }

    return {
      team_name: teamName,
      mission,
      member_count: memberIds.length,
      members,
      tasks,
      tasks_done: tasks.filter((t) => t.status === 'done').length,
      tasks_total: tasks.length,
      content_quality: contentQuality,
      task_completion: taskCompletion,
      role_fit: roleFit,
      composite_score: composite,
      graded_items: overallCount,
      most_urgent_overdue: mostUrgent,
    };
  });

  // Players in the session but on no team (trainer excluded).
  const unassigned = (participantsRes.data || [])
    .filter((p) => !teamByPlayer.has(String(p.user_id)) && String(p.user_id) !== session.trainer_id)
    .map((p) => ({
      user_id: String(p.user_id),
      display_name: nameById.get(String(p.user_id)) || 'Unknown',
    }));

  return {
    teams,
    unassigned,
    elapsed_minutes: elapsedMinutes != null ? Math.round(elapsedMinutes) : null,
    computed_at: new Date().toISOString(),
  };
}

// ─── Snapshots + broadcast (throttled) ──────────────────────────────────────

const lastSnapshotAt = new Map<string, number>();
const SNAPSHOT_MIN_INTERVAL_MS = 60_000;

/**
 * Recompute team scores, persist a snapshot per team, and broadcast the
 * numbers to the session (throttled to once per minute per session).
 * Fire-and-forget safe: never throws.
 */
export async function snapshotTeamScores(sessionId: string): Promise<void> {
  try {
    const last = lastSnapshotAt.get(sessionId) || 0;
    if (Date.now() - last < SNAPSHOT_MIN_INTERVAL_MS) return;
    lastSnapshotAt.set(sessionId, Date.now());

    const report = await computeTeamScores(sessionId);
    if (report.teams.length === 0) return;

    await supabaseAdmin.from('team_score_snapshots').insert(
      report.teams.map((t) => ({
        session_id: sessionId,
        team_name: t.team_name,
        composite_score: t.composite_score,
        content_quality: t.content_quality,
        task_completion: t.task_completion,
        role_fit: t.role_fit,
        tasks_done: t.tasks_done,
        tasks_total: t.tasks_total,
        member_count: t.member_count,
      })),
    );

    // Numbers only — no content rides on this session-wide broadcast.
    getWebSocketService().broadcastToSession(sessionId, {
      type: 'team_scores.updated',
      data: {
        teams: report.teams.map((t) => ({
          team_name: t.team_name,
          composite_score: t.composite_score,
          tasks_done: t.tasks_done,
          tasks_total: t.tasks_total,
        })),
      },
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    logger.error({ err, sessionId }, 'snapshotTeamScores failed (non-critical)');
  }
}
