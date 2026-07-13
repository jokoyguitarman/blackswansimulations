import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { getBalances, isAdmin } from './creditService.js';

/**
 * Scenario edit lock.
 *
 * Trainers get unlimited free edits to compiled scenario content, but editing
 * is locked when either:
 *  1. a session on the scenario is currently live (in_progress or paused) —
 *     mid-run edits would half-leak into the running simulation. Applies to
 *     admins too (data-consistency rule, not a billing rule).
 *  2. the trainer has zero session-launch credits — admins bypass this check.
 *
 * Both conditions are evaluated live on every request, so editing reopens as
 * soon as the live session ends or credits are topped up.
 */

export type EditLockReason = 'ok' | 'live_session' | 'no_session_credits';

export interface EditabilityResult {
  editable: boolean;
  reason: EditLockReason;
  session_credits: number;
  live_session_id: string | null;
}

const LIVE_STATUSES = ['in_progress', 'paused'];

/**
 * Decide whether the user may edit this scenario's content right now.
 * Throws on database errors (callers surface a 500) — the lock must never
 * silently fail open or closed.
 */
export async function canEditScenario(
  scenarioId: string,
  user: { id: string; role?: string },
): Promise<EditabilityResult> {
  const { data: liveSessions, error: liveErr } = await supabaseAdmin
    .from('sessions')
    .select('id')
    .eq('scenario_id', scenarioId)
    .in('status', LIVE_STATUSES)
    .limit(1);

  if (liveErr) {
    logger.error({ error: liveErr, scenarioId }, 'Editability live-session check failed');
    throw new Error(`Editability check failed: ${liveErr.message}`);
  }

  const admin = isAdmin(user);
  const sessionCredits = (await getBalances(user.id)).session;

  const liveSessionId =
    liveSessions && liveSessions.length > 0 ? (liveSessions[0].id as string) : null;
  if (liveSessionId) {
    return {
      editable: false,
      reason: 'live_session',
      session_credits: sessionCredits,
      live_session_id: liveSessionId,
    };
  }

  if (!admin && sessionCredits <= 0) {
    return {
      editable: false,
      reason: 'no_session_credits',
      session_credits: sessionCredits,
      live_session_id: null,
    };
  }

  return {
    editable: true,
    reason: 'ok',
    session_credits: sessionCredits,
    live_session_id: null,
  };
}
