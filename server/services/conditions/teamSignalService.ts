/**
 * Loads the team-signal facts `loadCommsState` attaches.
 * Each read is one query. A missing table or column (42P01, 42703, PGRST204,
 * PGRST205) turns that signal off for the call and logs once per process.
 */

import { supabaseAdmin } from '../../lib/supabaseAdmin.js';
import { teamsValidAt } from '../../lib/templateRows.js';
import { env } from '../../env.js';
import { logger } from '../../lib/logger.js';
import { isLedgerSchemaMissing } from '../ledger/ledgerSchema.js';
import { sessionMinuteAt } from '../ledger/injectLedgerCore.js';
import { getCatalogCharter, type TeamExpectedAction } from '../teamCharterService.js';
import { resolveTeamFunction } from '../../lib/stakeholderContract.js';
import { parsePlayerRoles } from '../roles/roleCore.js';
import { slugifyTeamName } from '../../../shared/conditionKeyGrammar.js';
import { dutiesByTeam, type CharterAction, type ObservedAction } from '../teamTasksCore.js';
import {
  decisionFacts,
  gradesByTeam,
  latestActivity,
  overallGrade,
  roleTeamSlugs,
  teamLabelMap,
  type ActivityHit,
  type DecisionFact,
  type GradeHit,
} from './teamSignalsCore.js';
import type { DutySnapshot } from '../teamTasksCore.js';

const DUTY_ACTION_CAP = 8000;
const GRADE_CAP = 2000;
const DECISION_CAP = 500;
const ACTIVITY_SCAN_CAP = 8000;

export interface TeamSignalFacts {
  duties: Record<string, DutySnapshot[]>;
  duties_known: boolean;
  duties_truncated: boolean;
  team_activity: Record<string, { last_minute: number | null }>;
  team_activity_known: boolean;
  team_activity_truncated: boolean;
  content_grades: Record<string, number[]>;
  content_grades_known: boolean;
  content_grades_truncated: boolean;
  decisions: DecisionFact[];
  decisions_enabled: boolean;
  decisions_known: boolean;
  role_teams: Record<string, string>;
  team_labels: Record<string, string>;
}

const warned = new Set<string>();

function warnOnce(key: string, err: unknown, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  logger.warn({ err, event: key }, message);
}

function emptyFacts(enabled: boolean): TeamSignalFacts {
  return {
    duties: {},
    duties_known: false,
    duties_truncated: false,
    team_activity: {},
    team_activity_known: false,
    team_activity_truncated: false,
    content_grades: {},
    content_grades_known: false,
    content_grades_truncated: false,
    decisions: [],
    decisions_enabled: enabled,
    decisions_known: !enabled,
    role_teams: {},
    team_labels: {},
  };
}

interface QueryError {
  code?: string;
  message?: string;
}

function schemaMissing(error: QueryError | null): boolean {
  return error != null && isLedgerSchemaMissing(error);
}

export async function loadTeamSignalFacts(
  sessionId: string,
  startTime: string | null,
): Promise<TeamSignalFacts> {
  const enabled = env.enableExecutiveDecisions;
  try {
    const scenario = await loadScenarioId(sessionId);
    const [
      roster,
      membership,
      participants,
      dutyActions,
      actionActivity,
      chatActivity,
      posts,
      emails,
      decisionRows,
      roles,
    ] = await Promise.all([
      loadRoster(scenario, startTime ?? new Date()),
      loadMembership(sessionId),
      loadTrainerIds(sessionId),
      loadDutyActions(sessionId),
      loadActionActivity(sessionId),
      loadChatActivity(sessionId),
      loadGradeRows(sessionId, 'social_posts', 'posted_by_user_id', { author_type: 'player' }),
      loadGradeRows(sessionId, 'sim_emails', 'sent_by_player_id', {}),
      enabled
        ? loadDecisionRows(sessionId)
        : Promise.resolve({ rows: [], known: true, truncated: false }),
      loadRoleTeams(scenario),
    ]);

    const facts = emptyFacts(enabled);
    facts.role_teams = roles;
    facts.team_labels = teamLabelMap(roster.teams.map((team) => team.team_name));
    facts.duties_known = roster.known && membership.known && dutyActions.known;
    facts.duties_truncated = dutyActions.truncated;
    if (facts.duties_known) {
      const startMs = startTime ? Date.parse(startTime) : Number.NaN;
      facts.duties = dutiesByTeam({
        teams: roster.teams,
        actions: dutyActions.rows,
        membersByTeam: membership.byTeam,
        startMs: Number.isFinite(startMs) ? startMs : null,
      });
    }

    const activityKnown = membership.known && actionActivity.known && chatActivity.known;
    facts.team_activity_known = activityKnown;
    facts.team_activity_truncated = actionActivity.truncated || chatActivity.truncated;
    if (activityKnown) {
      facts.team_activity = latestActivity([
        ...actionHits(actionActivity.rows, membership.teamByPlayer, startTime),
        ...chatHits(chatActivity.rows, membership.teamByPlayer, participants, startTime),
      ]);
    }

    facts.content_grades_known = membership.known && posts.known && emails.known;
    facts.content_grades_truncated = posts.truncated || emails.truncated;
    if (facts.content_grades_known) {
      facts.content_grades = gradesByTeam([
        ...gradeHits(posts.rows, 'posted_by_user_id', membership.teamByPlayer),
        ...gradeHits(emails.rows, 'sent_by_player_id', membership.teamByPlayer),
      ]);
    }

    facts.decisions_enabled = enabled;
    facts.decisions_known = decisionRows.known;
    facts.decisions = enabled && decisionRows.known ? decisionFacts(decisionRows.rows) : [];
    return facts;
  } catch (err) {
    warnOnce('team_signals_failed', err, 'Team signal facts could not be loaded');
    return emptyFacts(enabled);
  }
}

async function loadScenarioId(sessionId: string): Promise<{ id: string | null; known: boolean }> {
  const { data, error } = await supabaseAdmin
    .from('sessions')
    .select('scenario_id')
    .eq('id', sessionId)
    .maybeSingle();
  if (error) {
    warnOnce(
      'team_signal_session_unavailable',
      error,
      'Charter duties are off; the session could not be read',
    );
    return { id: null, known: false };
  }
  return { id: data?.scenario_id ? String(data.scenario_id) : null, known: true };
}

interface RosterTeam {
  team_name: string;
  expected: CharterAction[];
}

async function loadRoster(
  scenario: { id: string | null; known: boolean },
  at: string | Date,
): Promise<{ teams: RosterTeam[]; known: boolean }> {
  if (!scenario.known) return { teams: [], known: false };
  if (!scenario.id) return { teams: [], known: true };
  try {
    const { data, error } = await teamsValidAt(scenario.id, at);
    if (error) {
      warnOnce('team_signal_roster_unavailable', error, 'Charter duties are off for this process');
      return { teams: [], known: false };
    }
    const teams: RosterTeam[] = [];
    for (const raw of data ?? []) {
      const row = raw as Record<string, unknown>;
      const teamName = typeof row.team_name === 'string' ? row.team_name : '';
      if (!teamName) continue;
      const catalog = getCatalogCharter(
        resolveTeamFunction({
          team_name: teamName,
          function_key: typeof row.function_key === 'string' ? row.function_key : null,
        }),
      );
      const expected =
        (row.expected_actions as TeamExpectedAction[] | null) || catalog?.expected_actions || [];
      teams.push({ team_name: teamName, expected: charterActions(expected) });
    }
    return { teams, known: true };
  } catch (err) {
    warnOnce('team_signal_roster_unavailable', err, 'Charter duties are off for this process');
    return { teams: [], known: false };
  }
}

function charterActions(value: unknown): CharterAction[] {
  if (!Array.isArray(value)) return [];
  const out: CharterAction[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as Record<string, unknown>;
    const actionId = typeof row.action_id === 'string' ? row.action_id.trim() : '';
    const detection =
      typeof row.detection_action_type === 'string' ? row.detection_action_type : '';
    if (!actionId || !detection) continue;
    const timing = row.timing_benchmark_minutes;
    const hints = row.detection_hints;
    out.push({
      action_id: actionId,
      detection_action_type: detection,
      ...(hints && typeof hints === 'object' && !Array.isArray(hints)
        ? { detection_hints: hints as Record<string, unknown> }
        : {}),
      timing_benchmark_minutes:
        typeof timing === 'number' && Number.isFinite(timing) ? timing : null,
    });
  }
  return out;
}

async function loadMembership(sessionId: string): Promise<{
  known: boolean;
  byTeam: Map<string, string[]>;
  teamByPlayer: Map<string, string>;
}> {
  try {
    const { data, error } = await supabaseAdmin
      .from('session_teams')
      .select('user_id, team_name, assigned_at')
      .eq('session_id', sessionId)
      .order('assigned_at', { ascending: true });
    if (error) {
      warnOnce(
        'team_signal_membership_unavailable',
        error,
        'Team signals are off; team membership could not be read',
      );
      return { known: false, byTeam: new Map(), teamByPlayer: new Map() };
    }
    const teamByPlayer = new Map<string, string>();
    const byTeam = new Map<string, string[]>();
    for (const row of data ?? []) {
      const userId = row.user_id ? String(row.user_id) : '';
      const teamName = typeof row.team_name === 'string' ? row.team_name : '';
      if (!userId || !teamName || teamByPlayer.has(userId)) continue;
      teamByPlayer.set(userId, teamName);
      const list = byTeam.get(teamName);
      if (list) list.push(userId);
      else byTeam.set(teamName, [userId]);
    }
    return { known: true, byTeam, teamByPlayer };
  } catch (err) {
    warnOnce(
      'team_signal_membership_unavailable',
      err,
      'Team signals are off; team membership could not be read',
    );
    return { known: false, byTeam: new Map(), teamByPlayer: new Map() };
  }
}

async function loadTrainerIds(sessionId: string): Promise<Set<string>> {
  try {
    const { data, error } = await supabaseAdmin
      .from('session_participants')
      .select('user_id, role')
      .eq('session_id', sessionId);
    if (error) return new Set();
    const ids = new Set<string>();
    for (const row of data ?? []) {
      const role = typeof row.role === 'string' ? row.role : '';
      if ((role === 'trainer' || role === 'admin') && row.user_id) ids.add(String(row.user_id));
    }
    return ids;
  } catch {
    return new Set();
  }
}

async function loadDutyActions(sessionId: string): Promise<{
  rows: ObservedAction[];
  known: boolean;
  truncated: boolean;
}> {
  try {
    const { data, error } = await supabaseAdmin
      .from('player_actions')
      .select('player_id, action_type, team_at_action, metadata, created_at')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: true })
      .limit(DUTY_ACTION_CAP + 1);
    if (error) {
      warnOnce('team_signal_duties_unavailable', error, 'Charter duties are off for this process');
      return { rows: [], known: false, truncated: false };
    }
    const raw = data ?? [];
    const truncated = raw.length > DUTY_ACTION_CAP;
    if (truncated) {
      warnOnce(
        'team_signal_duties_truncated',
        null,
        'Duty history exceeded the condition-key cap; missed-duty keys stay false',
      );
    }
    const kept = truncated ? raw.slice(0, DUTY_ACTION_CAP) : raw;
    return {
      rows: kept.map((row) => ({
        player_id: row.player_id ? String(row.player_id) : '',
        action_type: typeof row.action_type === 'string' ? row.action_type : '',
        team_at_action: typeof row.team_at_action === 'string' ? row.team_at_action : null,
        metadata:
          row.metadata && typeof row.metadata === 'object'
            ? (row.metadata as Record<string, unknown>)
            : null,
        created_at: typeof row.created_at === 'string' ? row.created_at : '',
      })),
      known: true,
      truncated,
    };
  } catch (err) {
    warnOnce('team_signal_duties_unavailable', err, 'Charter duties are off for this process');
    return { rows: [], known: false, truncated: false };
  }
}

interface ActivityRow {
  team_at_action?: string | null;
  player_id?: string | null;
  sender_id?: string | null;
  /** Aggregate `max()` is typed as a number; PostgREST still returns an ISO string. */
  last_at?: string | number | null;
  created_at?: string | number | null;
  type?: string | null;
}

function instantOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value) && value > 1e11) {
    return new Date(value).toISOString();
  }
  return '';
}

async function loadActionActivity(sessionId: string): Promise<{
  rows: ActivityRow[];
  known: boolean;
  truncated: boolean;
}> {
  try {
    const { data, error } = await supabaseAdmin
      .from('player_actions')
      .select('team_at_action, player_id, last_at:created_at.max()')
      .eq('session_id', sessionId);
    if (!error) return { rows: (data ?? []) as ActivityRow[], known: true, truncated: false };
    if (schemaMissing(error)) {
      warnOnce(
        'team_activity_unavailable',
        error,
        'Team activity conditions are off for this process',
      );
      return { rows: [], known: false, truncated: false };
    }
    warnOnce(
      'team_activity_aggregate_failed',
      error,
      'Grouped team activity failed; scanning player_actions instead',
    );
  } catch (err) {
    warnOnce(
      'team_activity_aggregate_failed',
      err,
      'Grouped team activity failed; scanning player_actions instead',
    );
  }
  return scanActivity(sessionId, 'player_actions', 'player_id, team_at_action, created_at');
}

async function loadChatActivity(sessionId: string): Promise<{
  rows: ActivityRow[];
  known: boolean;
  truncated: boolean;
}> {
  try {
    const { data, error } = await supabaseAdmin
      .from('chat_messages')
      .select('sender_id, last_at:created_at.max()')
      .eq('session_id', sessionId)
      .not('sender_id', 'is', null)
      .neq('type', 'system');
    if (!error) return { rows: (data ?? []) as ActivityRow[], known: true, truncated: false };
    if (schemaMissing(error)) {
      warnOnce(
        'team_chat_activity_unavailable',
        error,
        'Team activity conditions are off for this process',
      );
      return { rows: [], known: false, truncated: false };
    }
    warnOnce(
      'team_chat_aggregate_failed',
      error,
      'Grouped chat activity failed; scanning chat_messages instead',
    );
  } catch (err) {
    warnOnce(
      'team_chat_aggregate_failed',
      err,
      'Grouped chat activity failed; scanning chat_messages instead',
    );
  }
  return scanActivity(sessionId, 'chat_messages', 'sender_id, created_at, type');
}

async function scanActivity(
  sessionId: string,
  table: 'player_actions' | 'chat_messages',
  columns: string,
): Promise<{ rows: ActivityRow[]; known: boolean; truncated: boolean }> {
  try {
    const { data, error } = await supabaseAdmin
      .from(table)
      .select(columns)
      .eq('session_id', sessionId)
      .order('created_at', { ascending: false })
      .limit(ACTIVITY_SCAN_CAP + 1);
    if (error) {
      warnOnce(
        'team_activity_unavailable',
        error,
        'Team activity conditions are off for this process',
      );
      return { rows: [], known: false, truncated: false };
    }
    const raw = (data ?? []) as ActivityRow[];
    const truncated = raw.length > ACTIVITY_SCAN_CAP;
    if (truncated) {
      warnOnce(
        'team_activity_truncated',
        null,
        'Team activity exceeded the condition-key cap; silence keys stay false',
      );
    }
    const kept = (truncated ? raw.slice(0, ACTIVITY_SCAN_CAP) : raw).filter(
      (row) => row.type !== 'system',
    );
    return { rows: kept, known: true, truncated };
  } catch (err) {
    warnOnce('team_activity_unavailable', err, 'Team activity conditions are off for this process');
    return { rows: [], known: false, truncated: false };
  }
}

function actionHits(
  rows: readonly ActivityRow[],
  teamByPlayer: ReadonlyMap<string, string>,
  startTime: string | null,
): ActivityHit[] {
  const hits: ActivityHit[] = [];
  for (const row of rows) {
    const stamped = typeof row.team_at_action === 'string' ? row.team_at_action : '';
    const playerId = row.player_id ? String(row.player_id) : '';
    const teamName = stamped || (playerId ? (teamByPlayer.get(playerId) ?? '') : '');
    const slug = slugifyTeamName(teamName);
    const at = instantOf(row.last_at) || instantOf(row.created_at);
    if (!slug || !at) continue;
    hits.push({ team_slug: slug, minute: sessionMinuteAt(startTime, at) });
  }
  return hits;
}

function chatHits(
  rows: readonly ActivityRow[],
  teamByPlayer: ReadonlyMap<string, string>,
  trainers: ReadonlySet<string>,
  startTime: string | null,
): ActivityHit[] {
  const hits: ActivityHit[] = [];
  for (const row of rows) {
    const senderId = row.sender_id ? String(row.sender_id) : '';
    if (!senderId || trainers.has(senderId)) continue;
    const teamName = teamByPlayer.get(senderId) ?? '';
    const slug = slugifyTeamName(teamName);
    const at = instantOf(row.last_at) || instantOf(row.created_at);
    if (!slug || !at) continue;
    hits.push({ team_slug: slug, minute: sessionMinuteAt(startTime, at) });
  }
  return hits;
}

async function loadGradeRows(
  sessionId: string,
  table: 'social_posts' | 'sim_emails',
  userColumn: 'posted_by_user_id' | 'sent_by_player_id',
  extra: { author_type?: string },
): Promise<{ rows: Array<Record<string, unknown>>; known: boolean; truncated: boolean }> {
  try {
    let query = supabaseAdmin
      .from(table)
      .select(`${userColumn}, sop_compliance_score`)
      .eq('session_id', sessionId)
      .not(userColumn, 'is', null)
      .not('sop_compliance_score', 'is', null)
      .limit(GRADE_CAP + 1);
    if (extra.author_type) query = query.eq('author_type', extra.author_type);
    const { data, error } = await query;
    if (error) {
      warnOnce(
        'team_signal_grades_unavailable',
        error,
        'Content-grade conditions are off for this process',
      );
      return { rows: [], known: false, truncated: false };
    }
    const raw = (data ?? []) as Array<Record<string, unknown>>;
    const truncated = raw.length > GRADE_CAP;
    if (truncated) {
      warnOnce(
        'team_signal_grades_truncated',
        null,
        'Graded content exceeded the condition-key cap; only the loaded grades count',
      );
    }
    return { rows: truncated ? raw.slice(0, GRADE_CAP) : raw, known: true, truncated };
  } catch (err) {
    warnOnce(
      'team_signal_grades_unavailable',
      err,
      'Content-grade conditions are off for this process',
    );
    return { rows: [], known: false, truncated: false };
  }
}

function gradeHits(
  rows: readonly Record<string, unknown>[],
  userColumn: string,
  teamByPlayer: ReadonlyMap<string, string>,
): GradeHit[] {
  const hits: GradeHit[] = [];
  for (const row of rows) {
    const userId = row[userColumn] ? String(row[userColumn]) : '';
    const teamName = userId ? (teamByPlayer.get(userId) ?? '') : '';
    const slug = slugifyTeamName(teamName);
    const score = overallGrade(row.sop_compliance_score);
    if (!slug || score == null) continue;
    hits.push({ team_slug: slug, score });
  }
  return hits;
}

async function loadDecisionRows(sessionId: string): Promise<{
  rows: Array<{
    team_name: string | null;
    category: string | null;
    minute: number;
    status: string | null;
  }>;
  known: boolean;
  truncated: boolean;
}> {
  try {
    const { data, error } = await supabaseAdmin
      .from('session_decisions')
      .select('team_name, recorded_at_minute, detail, status')
      .eq('session_id', sessionId)
      .order('recorded_at_minute', { ascending: true })
      .limit(DECISION_CAP + 1);
    if (error) {
      warnOnce(
        'team_signal_decisions_unavailable',
        error,
        'Decision conditions are off because the decision ledger is not available',
      );
      return { rows: [], known: false, truncated: false };
    }
    const raw = data ?? [];
    const truncated = raw.length > DECISION_CAP;
    if (truncated) {
      warnOnce(
        'team_signal_decisions_truncated',
        null,
        'Decision history exceeded the condition-key cap; only the loaded decisions count',
      );
    }
    const kept = truncated ? raw.slice(0, DECISION_CAP) : raw;
    return {
      rows: kept.map((row) => {
        const detail = row.detail;
        const category =
          detail &&
          typeof detail === 'object' &&
          typeof (detail as { category?: unknown }).category === 'string'
            ? (detail as { category: string }).category
            : null;
        const minute = Number(row.recorded_at_minute);
        return {
          team_name: typeof row.team_name === 'string' ? row.team_name : null,
          category,
          minute: Number.isFinite(minute) ? minute : Number.NaN,
          status: typeof row.status === 'string' ? row.status : null,
        };
      }),
      known: true,
      truncated,
    };
  } catch (err) {
    warnOnce(
      'team_signal_decisions_unavailable',
      err,
      'Decision conditions are off because the decision ledger is not available',
    );
    return { rows: [], known: false, truncated: false };
  }
}

async function loadRoleTeams(scenario: {
  id: string | null;
  known: boolean;
}): Promise<Record<string, string>> {
  if (!scenario.known || !scenario.id) return {};
  try {
    const { data, error } = await supabaseAdmin
      .from('scenarios')
      .select('initial_state')
      .eq('id', scenario.id)
      .maybeSingle();
    if (error || !data) return {};
    const initial = data.initial_state as { player_roles?: unknown } | null;
    return roleTeamSlugs(parsePlayerRoles(initial?.player_roles));
  } catch (err) {
    warnOnce(
      'team_signal_roles_unavailable',
      err,
      'Role-scoped team signals cannot see player roles',
    );
    return {};
  }
}
