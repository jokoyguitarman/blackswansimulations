import { supabaseAdmin } from './supabaseAdmin.js';
import { getControlledOrgKey, getPageControllerIdsByHandle } from '../services/orgPageService.js';

/**
 * Shared authorization guardrails.
 *
 * IMPORTANT: All DB access in this app uses the Supabase service-role client, which
 * BYPASSES Row Level Security. Authorization must therefore be enforced in code on
 * every route. These helpers return a result object (they do NOT throw) so call sites
 * can early-return a proper 4xx without an existing try/catch masking it as a 500.
 *
 * Usage:
 *   const access = await assertSessionAccess(sessionId, user);
 *   if (!access.ok) return res.status(access.status).json({ error: access.error });
 */

export interface AccessUser {
  id: string;
  role?: string;
}

export type AccessResult =
  | { ok: true; session?: SessionRow }
  | { ok: false; status: number; error: string };

interface SessionRow {
  id: string;
  trainer_id: string | null;
  [key: string]: unknown;
}

const isStaff = (user: AccessUser): boolean => user.role === 'admin' || user.role === 'trainer';

/**
 * Allow if the caller is the owning trainer, an admin, OR a participant in the session.
 * Returns the loaded session row on success so callers can avoid a second fetch.
 *
 * @param select - extra columns to load on the session row (always includes id, trainer_id).
 */
export async function assertSessionAccess(
  sessionId: string | null | undefined,
  user: AccessUser,
  select = 'id, trainer_id',
): Promise<AccessResult> {
  if (!sessionId) {
    return { ok: false, status: 404, error: 'Session not found' };
  }

  const columns = ensureColumns(select);
  const { data: session, error } = await supabaseAdmin
    .from('sessions')
    .select(columns)
    .eq('id', sessionId)
    .maybeSingle<SessionRow>();

  if (error || !session) {
    return { ok: false, status: 404, error: 'Session not found' };
  }

  // Owning trainer or admin always allowed.
  if (user.role === 'admin' || session.trainer_id === user.id) {
    return { ok: true, session };
  }

  // Otherwise the caller must be a participant of this session.
  const { data: participant } = await supabaseAdmin
    .from('session_participants')
    .select('user_id')
    .eq('session_id', sessionId)
    .eq('user_id', user.id)
    .maybeSingle();

  if (!participant) {
    return { ok: false, status: 403, error: 'Access denied' };
  }

  return { ok: true, session };
}

/**
 * Allow only the owning trainer or an admin (privileged session actions:
 * start/stop, sweeps, anything that mutates global session state).
 */
export async function assertSessionOwner(
  sessionId: string | null | undefined,
  user: AccessUser,
  select = 'id, trainer_id',
): Promise<AccessResult> {
  if (!sessionId) {
    return { ok: false, status: 404, error: 'Session not found' };
  }

  const columns = ensureColumns(select);
  const { data: session, error } = await supabaseAdmin
    .from('sessions')
    .select(columns)
    .eq('id', sessionId)
    .maybeSingle<SessionRow>();

  if (error || !session) {
    return { ok: false, status: 404, error: 'Session not found' };
  }

  if (user.role === 'admin' || session.trainer_id === user.id) {
    return { ok: true, session };
  }

  return { ok: false, status: 403, error: 'Only the session trainer can perform this action' };
}

/**
 * Allow only the scenario's creator or an admin to MUTATE a scenario.
 * (Listing/viewing scenarios stays open to all trainers; only edits are locked.)
 */
export async function assertScenarioOwner(
  scenarioId: string | null | undefined,
  user: AccessUser,
): Promise<AccessResult> {
  if (!scenarioId) {
    return { ok: false, status: 404, error: 'Scenario not found' };
  }

  const { data: scenario, error } = await supabaseAdmin
    .from('scenarios')
    .select('id, created_by')
    .eq('id', scenarioId)
    .maybeSingle<{ id: string; created_by: string | null }>();

  if (error || !scenario) {
    return { ok: false, status: 404, error: 'Scenario not found' };
  }

  if (user.role === 'admin' || scenario.created_by === user.id) {
    return { ok: true };
  }

  return { ok: false, status: 403, error: 'Only the scenario creator can modify this scenario' };
}

/** Return all team names the caller belongs to in this session (empty for trainers/admins). */
export async function getCallerTeams(sessionId: string, user: AccessUser): Promise<string[]> {
  const { data } = await supabaseAdmin
    .from('session_teams')
    .select('team_name')
    .eq('session_id', sessionId)
    .eq('user_id', user.id);

  return (data ?? [])
    .map((r) => (r as { team_name: string }).team_name)
    .filter((t): t is string => typeof t === 'string' && t.length > 0);
}

/**
 * Validate that the caller may act as `teamName`.
 * Trainers/admins may act as ANY team. Other users must belong to the team they claim.
 * If no team is claimed, allow (the action is not team-scoped).
 */
export async function assertTeamMembership(
  sessionId: string,
  user: AccessUser,
  teamName: string | null | undefined,
): Promise<AccessResult> {
  if (isStaff(user)) {
    return { ok: true };
  }
  if (!teamName) {
    return { ok: true };
  }
  const teams = await getCallerTeams(sessionId, user);
  if (teams.includes(teamName)) {
    return { ok: true };
  }
  return { ok: false, status: 403, error: 'You are not a member of that team' };
}

/**
 * Social-crisis equivalent of a team check: validate the caller controls the given
 * org page (identified by its handle). Trainers/admins may act as any page.
 */
export async function assertControlsOrgPage(
  sessionId: string,
  user: AccessUser,
  pageHandle: string | null | undefined,
): Promise<AccessResult> {
  if (isStaff(user)) {
    return { ok: true };
  }
  if (!pageHandle) {
    return { ok: true };
  }
  const controllerIds = await getPageControllerIdsByHandle(sessionId, pageHandle);
  if (controllerIds.includes(user.id)) {
    return { ok: true };
  }
  return { ok: false, status: 403, error: 'You do not control that page' };
}

/** Convenience: the org_key the caller controls in a session, or null. */
export async function getControlledOrgKeyForUser(
  sessionId: string,
  user: AccessUser,
): Promise<string | null> {
  return getControlledOrgKey(sessionId, user.id);
}

/** Ensure the select string always includes the columns the helpers rely on. */
function ensureColumns(select: string): string {
  const cols = new Set(
    select
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean),
  );
  cols.add('id');
  cols.add('trainer_id');
  return Array.from(cols).join(', ');
}
