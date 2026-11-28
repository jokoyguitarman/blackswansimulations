import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { teamsValidAt } from '../lib/templateRows.js';
import { env } from '../env.js';
import { selectSession, type SessionClockFields } from '../lib/peaceSchema.js';
import { countsOnCrisisClock, rosterValidAt } from '../lib/peaceGate.js';
import { crisisElapsedFractionalMinutes } from '../lib/sessionPhase.js';
import { logger } from '../lib/logger.js';
import { getWebSocketService } from './websocketService.js';
import { getCatalogCharter, type TeamExpectedAction } from './teamCharterService.js';
import { resolveTeamFunction } from '../lib/stakeholderContract.js';
import { getIntelManifest } from './intelSharingService.js';
import { evaluateTeamTasks, type ObservedAction } from './teamTasksCore.js';
import { isUnappliedSchema } from '../lib/unappliedSchema.js';

const CONTENT_WEIGHT = 0.45;
const TASK_WEIGHT = 0.3;
const ROLE_WEIGHT = 0.15;
const COLLAB_WEIGHT = 0.1;
const DIRECTOR_GRADE_READ_LIMIT = 2000;

/**
 * Live per-team scoring for the social media crisis module.
 *
 * The team score is a pure, recomputable rollup over immutable event history —
 * nothing mutates on the hot path, so a crash or double-recompute can never
 * corrupt it. Composite = ~45% content quality (AI grades on members'
 * posts/emails), ~30% expected-task completion/timeliness, ~15% role fit,
 * ~10% collaboration (cross-team intel the team held and shared on time —
 * null when the scenario gave the team no intel, so old scenarios keep the
 * previous 50/35/15 behaviour via weight renormalisation).
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
  /** Pooled AI teammate account (docs/ai-teammate-bots-plan.md). Display-only. */
  is_bot?: boolean;
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
  /** Cross-team intel sharing: % of held intel shared (on time = full credit). */
  collaboration: number | null;
  intel_held: number;
  intel_shared_count: number;
  composite_score: number | null;
  graded_items: number;
  /** Informational. The composite still counts every graded item. */
  content_breakdown: ContentBreakdown;
  most_urgent_overdue: { description: string; minutes_overdue: number } | null;
}

export interface ContentBucket {
  items: number;
  avg: number | null;
}

export interface ContentBreakdown {
  authored: ContentBucket;
  unscripted: ContentBucket;
}

export function isDirectorInjectKey(injectKey: string): boolean {
  return injectKey.startsWith('dir_');
}

export function gradeRefKey(refTable: string, refId: string): string {
  return `${refTable}:${refId}`;
}

/** Director deliveries named by inject_responses rows. Other inject keys stay authored. */
export function directorRefsFromResponses(
  rows: ReadonlyArray<{ ref_table?: unknown; ref_id?: unknown; inject_key?: unknown }>,
): Set<string> {
  const refs = new Set<string>();
  for (const row of rows) {
    const key = typeof row.inject_key === 'string' ? row.inject_key : '';
    const refId = typeof row.ref_id === 'string' ? row.ref_id : '';
    const refTable = typeof row.ref_table === 'string' ? row.ref_table : '';
    if (!isDirectorInjectKey(key) || !refId || !refTable) continue;
    refs.add(gradeRefKey(refTable, refId));
  }
  return refs;
}

export function contentBreakdown(
  items: readonly { refId: string; overall: number }[],
  directorRefs: ReadonlySet<string>,
): { quality: number | null; breakdown: ContentBreakdown } {
  const authored: number[] = [];
  const unscripted: number[] = [];
  for (const item of items) {
    (directorRefs.has(item.refId) ? unscripted : authored).push(item.overall);
  }
  return {
    quality: roundedAverage(items.map((item) => item.overall)),
    breakdown: { authored: bucket(authored), unscripted: bucket(unscripted) },
  };
}

export function compositeScore(parts: {
  content: number | null;
  tasks: number | null;
  role: number | null;
  collaboration: number | null;
}): number | null {
  const components: Array<{ value: number; weight: number }> = [];
  if (parts.content != null) components.push({ value: parts.content, weight: CONTENT_WEIGHT });
  if (parts.tasks != null) components.push({ value: parts.tasks, weight: TASK_WEIGHT });
  if (parts.role != null) components.push({ value: parts.role, weight: ROLE_WEIGHT });
  if (parts.collaboration != null) components.push({ value: parts.collaboration, weight: COLLAB_WEIGHT });
  const weightSum = components.reduce((sum, component) => sum + component.weight, 0);
  if (weightSum === 0) return null;
  return Math.round(components.reduce((sum, component) => sum + component.value * component.weight, 0) / weightSum);
}

function bucket(values: readonly number[]): ContentBucket {
  return { items: values.length, avg: roundedAverage(values) };
}

function roundedAverage(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

const EMPTY_BREAKDOWN: ContentBreakdown = {
  authored: { items: 0, avg: null },
  unscripted: { items: 0, avg: null },
};

export interface TeamScoreReport {
  teams: TeamScore[];
  unassigned: Array<{ user_id: string; display_name: string }>;
  elapsed_minutes: number | null;
  computed_at: string;
}

interface TeamScoreSession extends SessionClockFields {
  scenario_id: string | null;
  start_time: string | null;
  trainer_id: string | null;
}

function createdAtOf(row: { created_at?: string | null }): string | null {
  return typeof row.created_at === 'string' ? row.created_at : null;
}

interface GradeRow {
  id?: string | null;
  posted_by_user_id?: string | null;
  sent_by_player_id?: string | null;
  sop_compliance_score: unknown;
  created_at?: string | null;
}

async function loadPostGrades(sessionId: string): Promise<{ data: GradeRow[] | null }> {
  if (!env.enablePeacePeriod) {
    const { data } = await supabaseAdmin
      .from('social_posts')
      .select('id, posted_by_user_id, sop_compliance_score')
      .eq('session_id', sessionId)
      .eq('author_type', 'player')
      .not('sop_compliance_score', 'is', null);
    return { data };
  }
  const { data } = await supabaseAdmin
    .from('social_posts')
    .select('id, posted_by_user_id, sop_compliance_score, created_at')
    .eq('session_id', sessionId)
    .eq('author_type', 'player')
    .not('sop_compliance_score', 'is', null);
  return { data };
}

async function loadDirectorGradeRefs(sessionId: string): Promise<Set<string>> {
  const refs = new Set<string>();
  try {
    const { data, error } = await supabaseAdmin
      .from('inject_responses')
      .select('ref_table, ref_id, inject_key')
      .eq('session_id', sessionId)
      .in('ref_table', ['social_posts', 'sim_emails'])
      .like('inject_key', 'dir_%')
      .limit(DIRECTOR_GRADE_READ_LIMIT);
    if (error) {
      warnDirectorGrades(error);
      return refs;
    }
    for (const ref of directorRefsFromResponses(data ?? [])) refs.add(ref);
  } catch (err) {
    warnDirectorGrades(err);
  }
  return refs;
}

let directorGradesWarned = false;

function warnDirectorGrades(err: unknown): void {
  if (directorGradesWarned) return;
  directorGradesWarned = true;
  logger.warn(
    { err, event: 'team_score_director_grades' },
    isUnappliedSchema(err)
      ? 'Director grade attribution is off until the response ledger is applied'
      : 'Director grade attribution was not loaded',
  );
}

async function loadEmailGrades(sessionId: string): Promise<{ data: GradeRow[] | null }> {
  if (!env.enablePeacePeriod) {
    const { data } = await supabaseAdmin
      .from('sim_emails')
      .select('id, sent_by_player_id, sop_compliance_score')
      .eq('session_id', sessionId)
      .not('sent_by_player_id', 'is', null)
      .not('sop_compliance_score', 'is', null);
    return { data };
  }
  const { data } = await supabaseAdmin
    .from('sim_emails')
    .select('id, sent_by_player_id, sop_compliance_score, created_at')
    .eq('session_id', sessionId)
    .not('sent_by_player_id', 'is', null)
    .not('sop_compliance_score', 'is', null);
  return { data };
}

export async function computeTeamScores(sessionId: string): Promise<TeamScoreReport> {
  const sessionResult = await selectSession<TeamScoreSession>(
    'scenario_id, start_time, trainer_id',
    (query) => query.eq('id', sessionId).single(),
  );
  const session = sessionResult.data;

  const emptyReport: TeamScoreReport = {
    teams: [],
    unassigned: [],
    elapsed_minutes: null,
    computed_at: new Date().toISOString(),
  };

  if (!session?.scenario_id) return emptyReport;

  const [teamsRes, membershipRes, participantsRes, actionsRes, postsRes, emailsRes, directorRefs] =
    await Promise.all([
      teamsValidAt(String(session.scenario_id), rosterValidAt(session)),
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
      loadPostGrades(sessionId),
      loadEmailGrades(sessionId),
      loadDirectorGradeRefs(sessionId),
    ]);

  const scenarioTeams = teamsRes.data || [];
  if (scenarioTeams.length === 0) return emptyReport;

  const startTime = session.start_time ? new Date(String(session.start_time)).getTime() : null;
  const elapsedMinutes = startTime
    ? crisisElapsedFractionalMinutes(String(session.start_time))
    : null;

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
  const scoredGrades: Array<{ playerId: string; overall: number; refKey: string }> = [];
  const accumulate = (
    pid: string | null,
    score: Record<string, unknown> | null,
    refTable: string,
    refId: string | null,
  ) => {
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
    scoredGrades.push({
      playerId: pid,
      overall,
      refKey: refId ? gradeRefKey(refTable, refId) : '',
    });
  };
  for (const p of postsRes.data || []) {
    if (!countsOnCrisisClock(createdAtOf(p), session.start_time ?? null)) continue;
    accumulate(
      p.posted_by_user_id ? String(p.posted_by_user_id) : null,
      (p.sop_compliance_score as Record<string, unknown>) || null,
      'social_posts',
      p.id ? String(p.id) : null,
    );
  }
  for (const e of emailsRes.data || []) {
    if (!countsOnCrisisClock(createdAtOf(e), session.start_time ?? null)) continue;
    accumulate(
      e.sent_by_player_id ? String(e.sent_by_player_id) : null,
      (e.sop_compliance_score as Record<string, unknown>) || null,
      'sim_emails',
      e.id ? String(e.id) : null,
    );
  }

  // Resolve display names for everyone involved.
  const allPlayerIds = new Set<string>();
  for (const p of participantsRes.data || []) allPlayerIds.add(String(p.user_id));
  for (const pid of teamByPlayer.keys()) allPlayerIds.add(pid);
  const nameById = new Map<string, string>();
  const botIds = new Set<string>();
  if (allPlayerIds.size > 0) {
    const { data: profiles } = await supabaseAdmin
      .from('user_profiles')
      .select('id, full_name, is_bot')
      .in('id', Array.from(allPlayerIds));
    for (const pr of profiles || []) {
      nameById.set(String(pr.id), String(pr.full_name || 'Unknown'));
      if ((pr as { is_bot?: boolean }).is_bot) botIds.add(String(pr.id));
    }
  }

  const actions = (actionsRes.data || []).filter((row) =>
    countsOnCrisisClock(String(row.created_at), session.start_time ?? null),
  );
  const observedActions: ObservedAction[] = actions.map((row) => ({
    player_id: String(row.player_id),
    action_type: String(row.action_type),
    team_at_action: row.team_at_action ? String(row.team_at_action) : null,
    metadata: (row.metadata as Record<string, unknown> | null) || null,
    created_at: String(row.created_at),
  }));

  // Cross-team intel: which keys each team held, and when each key was shared.
  // Derived from scenario_injects (cached) + intel_shared actions already loaded.
  const intelManifest = await getIntelManifest(session.scenario_id).catch(() => []);
  const intelShareTimes = new Map<string, number | null>();
  for (const a of actions) {
    if (String(a.action_type) !== 'intel_shared') continue;
    const key = ((a.metadata as Record<string, unknown> | null) || {}).intel_key;
    if (typeof key !== 'string' || !key || intelShareTimes.has(key)) continue;
    intelShareTimes.set(
      key,
      startTime ? (new Date(String(a.created_at)).getTime() - startTime) / 60000 : null,
    );
  }

  const teams: TeamScore[] = scenarioTeams.map((teamRow) => {
    const teamName = String(teamRow.team_name);
    const memberIds = membersByTeam.get(teamName) || [];
    const charterJson = (teamRow.charter || {}) as Record<string, unknown>;
    const catalogFallback = getCatalogCharter(
      resolveTeamFunction({
        team_name: teamName,
        function_key:
          ((teamRow as Record<string, unknown>).function_key as string | null | undefined) ?? null,
      }),
    );
    const mission =
      (charterJson.mission as string) ||
      String(teamRow.team_description || '') ||
      catalogFallback?.mission ||
      '';
    const expectedActions =
      (teamRow.expected_actions as TeamExpectedAction[] | null) ||
      catalogFallback?.expected_actions ||
      [];

    const unstaffed = memberIds.length === 0;

    const evaluated = evaluateTeamTasks({
      expected: expectedActions,
      actions: observedActions,
      memberIds,
      teamName,
      startMs: startTime,
      elapsedMinutes,
    });
    const tasks: TeamTaskStatus[] = evaluated.map((task, index) => {
      const expected = expectedActions[index];
      return {
        action_id: task.action_id,
        description: expected?.description ?? '',
        tier: expected?.tier ?? 1,
        weight: expected?.weight ?? 1,
        detection_action_type: expected?.detection_action_type ?? '',
        timing_benchmark_minutes: expected?.timing_benchmark_minutes ?? null,
        status: task.status,
        completed_at: task.completed_at,
        completed_by: task.completed_by,
        on_time: task.on_time,
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
    let overallCount = 0;
    let roleFitSum = 0;
    let roleFitCount = 0;
    const members: TeamMemberSummary[] = memberIds.map((pid) => {
      const acc = gradesByPlayer.get(pid);
      if (acc) {
        overallCount += acc.overallCount;
        roleFitSum += acc.roleFitSum;
        roleFitCount += acc.roleFitCount;
      }
      return {
        user_id: pid,
        display_name: nameById.get(pid) || 'Unknown',
        ...(botIds.has(pid) ? { is_bot: true } : {}),
        graded_items: acc?.overallCount || 0,
        avg_overall:
          acc && acc.overallCount > 0 ? Math.round(acc.overallSum / acc.overallCount) : null,
        avg_role_fit:
          acc && acc.roleFitCount > 0 ? Math.round(acc.roleFitSum / acc.roleFitCount) : null,
      };
    });

    const mine = scoredGrades.filter((grade) => memberIds.includes(grade.playerId));
    const split = contentBreakdown(
      mine.map((grade) => ({ refId: grade.refKey, overall: grade.overall })),
      directorRefs,
    );
    const contentQuality = unstaffed ? null : split.quality;
    const breakdown = unstaffed ? EMPTY_BREAKDOWN : split.breakdown;
    const roleFit = roleFitCount > 0 ? Math.round(roleFitSum / roleFitCount) : null;

    // Collaboration: of the intel this team held, how much was shared with the
    // team(s) that needed it. Sharing after the deadline earns 60% credit
    // (mirrors late task completion). Null when the team held no intel.
    const heldIntel = intelManifest.filter((m) => m.holder_team === teamName);
    let intelSharedCount = 0;
    let collaboration: number | null = null;
    if (!unstaffed && heldIntel.length > 0) {
      let earned = 0;
      for (const entry of heldIntel) {
        if (!intelShareTimes.has(entry.intel_key)) continue;
        intelSharedCount++;
        const sharedAt = intelShareTimes.get(entry.intel_key);
        const late =
          entry.deadline_minutes != null && sharedAt != null && sharedAt > entry.deadline_minutes;
        earned += late ? 0.6 : 1;
      }
      collaboration = Math.round((earned / heldIntel.length) * 100);
    } else if (heldIntel.length > 0) {
      intelSharedCount = heldIntel.filter((m) => intelShareTimes.has(m.intel_key)).length;
    }

    const composite = unstaffed
      ? null
      : compositeScore({
          content: contentQuality,
          tasks: taskCompletion,
          role: roleFit,
          collaboration,
        });

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
      collaboration,
      intel_held: heldIntel.length,
      intel_shared_count: intelSharedCount,
      composite_score: composite,
      graded_items: overallCount,
      content_breakdown: breakdown,
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
        collaboration: t.collaboration,
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
          collaboration: t.collaboration,
        })),
      },
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    logger.error({ err, sessionId }, 'snapshotTeamScores failed (non-critical)');
  }
}
