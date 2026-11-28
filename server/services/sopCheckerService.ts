import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { crisisElapsedFractionalMinutes } from '../lib/sessionPhase.js';
import { actionCountsAsCrisisActivity, EMPTY_CONTENT_INDEX } from './scoring/crisisActivityCore.js';
import { loadContentIndex, scoringFiltersActive } from './scoring/crisisActivityLookup.js';
import { getPlayerTeamName } from './teamCharterService.js';

export interface SOPComplianceResult {
  step_id: string;
  step_name: string;
  status: 'completed' | 'pending' | 'overdue' | 'skipped';
  completed_at?: string;
  time_limit_minutes?: number;
  elapsed_minutes?: number;
  actions_taken: string[];
}

export async function evaluateSOPCompliance(
  sessionId: string,
  scenarioId: string,
): Promise<SOPComplianceResult[]> {
  const { data: sops } = await supabaseAdmin
    .from('sop_definitions')
    .select('*')
    .eq('scenario_id', scenarioId);

  if (!sops || sops.length === 0) return [];

  const { data: session } = await supabaseAdmin
    .from('sessions')
    .select('start_time')
    .eq('id', sessionId)
    .single();

  if (!session?.start_time) return [];

  const elapsedMinutes = crisisElapsedFractionalMinutes(String(session.start_time)) ?? 0;

  const filtersActive = scoringFiltersActive();
  const { data: actions } = filtersActive
    ? await supabaseAdmin
        .from('player_actions')
        .select('player_id, action_type, target_id, sop_step_matched, created_at, metadata')
        .eq('session_id', sessionId)
        .order('created_at', { ascending: true })
    : await supabaseAdmin
        .from('player_actions')
        .select('action_type, sop_step_matched, created_at, metadata')
        .eq('session_id', sessionId)
        .order('created_at', { ascending: true });

  const contentIndex = filtersActive ? await loadContentIndex(sessionId) : EMPTY_CONTENT_INDEX;
  const countableActions = (actions || []).filter((action) => {
    if (!filtersActive) return true;
    const row = action as {
      player_id?: string | null;
      target_id?: string | null;
      action_type: string;
      created_at: string;
    };
    return actionCountsAsCrisisActivity(
      {
        action_type: String(row.action_type),
        player_id: String(row.player_id ?? ''),
        target_id: row.target_id ? String(row.target_id) : null,
        created_at: String(row.created_at),
      },
      contentIndex,
      String(session.start_time),
      true,
    );
  });

  const results: SOPComplianceResult[] = [];

  // Organic executive decisions (docs/executive-decisions-organic-plan.md §4.1 / §6.6; touch
  // point, generator agent): notification steps carry `trigger: 'decision_notification'` and
  // their clock starts at the FIRST detected decision, not at session start. With no decision
  // they stay pending — never overdue.
  const hasDecisionSteps = sops.some((sop) =>
    ((sop.steps || []) as Array<{ trigger?: string }>).some(
      (s) => s.trigger === 'decision_notification',
    ),
  );
  let firstDecisionMinute: number | null = null;
  if (hasDecisionSteps) {
    const { data: decisions } = await supabaseAdmin
      .from('session_decisions')
      .select('recorded_at_minute')
      .eq('session_id', sessionId)
      .order('recorded_at_minute', { ascending: true })
      .limit(1);
    const m = decisions?.[0]?.recorded_at_minute;
    firstDecisionMinute = typeof m === 'number' ? m : null;
  }

  for (const sop of sops) {
    const steps = (sop.steps || []) as Array<{
      step_id: string;
      name: string;
      time_limit_minutes?: number;
      triggered_by_decision_key?: string;
      trigger?: string;
    }>;

    for (const step of steps) {
      // Steps keyed to the removed menu-based decision layer stay inert: nothing records a
      // decision_key any more, so their clock never starts (see
      // docs/executive-decisions-organic-handover.md). Scenarios compiled with them still load.
      if (step.triggered_by_decision_key) continue;

      const matchingActions = countableActions.filter(
        (action) => action.sop_step_matched === step.step_id,
      );

      let status: SOPComplianceResult['status'] = 'pending';
      let completedAt: string | undefined;

      const decisionStep = step.trigger === 'decision_notification';
      const minutesOnClock = decisionStep
        ? firstDecisionMinute == null
          ? null
          : elapsedMinutes - firstDecisionMinute
        : elapsedMinutes;

      if (matchingActions.length > 0) {
        status = 'completed';
        completedAt = matchingActions[0].created_at;
      } else if (
        step.time_limit_minutes &&
        minutesOnClock != null &&
        minutesOnClock > step.time_limit_minutes
      ) {
        status = 'overdue';
      }

      results.push({
        step_id: step.step_id,
        step_name: step.name,
        status,
        completed_at: completedAt,
        time_limit_minutes: step.time_limit_minutes,
        elapsed_minutes: Math.round(elapsedMinutes),
        actions_taken: matchingActions.map((a) => a.action_type),
      });
    }
  }

  return results;
}

export async function recordPlayerAction(
  sessionId: string,
  playerId: string,
  actionType: string,
  targetId: string | null,
  content: string | null,
  metadata: Record<string, unknown> = {},
  sopStepMatched: string | null = null,
): Promise<void> {
  // Stamp the author's team at write time so mid-session reassignment never
  // retroactively shifts team attribution. Null when unassigned (safe fallback).
  const teamAtAction = await getPlayerTeamName(sessionId, playerId);

  const { error } = await supabaseAdmin.from('player_actions').insert({
    session_id: sessionId,
    player_id: playerId,
    action_type: actionType,
    target_id: targetId,
    content,
    metadata,
    sop_step_matched: sopStepMatched,
    team_at_action: teamAtAction,
  });

  if (error) {
    logger.error({ error, sessionId, playerId, actionType }, 'Failed to record player action');
  }
}
