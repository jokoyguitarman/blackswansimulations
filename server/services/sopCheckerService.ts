import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';

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

  const results: SOPComplianceResult[] = [];

  for (const sop of sops) {
    const steps = (sop.steps || []) as Array<{
      step_id: string;
      name: string;
      time_limit_minutes?: number;
    }>;

    for (const step of steps) {
      const matchingActions = (actions || []).filter((a) => a.sop_step_matched === step.step_id);

      let status: SOPComplianceResult['status'] = 'pending';
      let completedAt: string | undefined;

      if (matchingActions.length > 0) {
        status = 'completed';
        completedAt = matchingActions[0].created_at;
      } else if (step.time_limit_minutes && elapsedMinutes > step.time_limit_minutes) {
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
  const { error } = await supabaseAdmin.from('player_actions').insert({
    session_id: sessionId,
    player_id: playerId,
    action_type: actionType,
    target_id: targetId,
    content,
    metadata,
    sop_step_matched: sopStepMatched,
  });

  if (error) {
    logger.error({ error, sessionId, playerId, actionType }, 'Failed to record player action');
  }
}
