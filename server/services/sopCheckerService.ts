import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
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

  const startTime = new Date(session.start_time).getTime();
  const elapsedMinutes = (Date.now() - startTime) / 60000;

  const { data: actions } = await supabaseAdmin
    .from('player_actions')
    .select('action_type, sop_step_matched, created_at, metadata')
    .eq('session_id', sessionId)
    .order('created_at', { ascending: true });

  // Decision layer (runtime plan §5.5): steps with `triggered_by_decision_key` are inert until
  // that decision is recorded, then their clock starts at the recording minute.
  const decisionMinuteByKey = new Map<string, number>();
  try {
    const { data: decisions } = await supabaseAdmin
      .from('session_decisions')
      .select('decision_key, recorded_at_minute')
      .eq('session_id', sessionId);
    for (const d of decisions ?? []) {
      const r = d as { decision_key: string; recorded_at_minute: number };
      if (!decisionMinuteByKey.has(r.decision_key))
        decisionMinuteByKey.set(r.decision_key, r.recorded_at_minute);
    }
  } catch {
    /* table absent before migration 203 */
  }

  const results: SOPComplianceResult[] = [];

  for (const sop of sops) {
    const steps = (sop.steps || []) as Array<{
      step_id: string;
      name: string;
      time_limit_minutes?: number;
      triggered_by_decision_key?: string;
    }>;

    for (const step of steps) {
      let stepStart = 0;
      if (step.triggered_by_decision_key) {
        const recordedAt = decisionMinuteByKey.get(step.triggered_by_decision_key);
        if (recordedAt === undefined) continue; // decision not taken → step does not apply
        stepStart = recordedAt;
      }

      const matchingActions = (actions || []).filter((a) => a.sop_step_matched === step.step_id);

      let status: SOPComplianceResult['status'] = 'pending';
      let completedAt: string | undefined;

      if (matchingActions.length > 0) {
        status = 'completed';
        completedAt = matchingActions[0].created_at;
      } else if (step.time_limit_minutes && elapsedMinutes - stepStart > step.time_limit_minutes) {
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
