import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { evaluateAllObjectivesForSession as evaluateAllObjectivesWithAI } from './objectiveEvaluationService.js';

/**
 * Objective Tracking Service
 * Tracks progress on scenario objectives in real-time
 */

export interface ObjectiveProgress {
  id: string;
  session_id: string;
  objective_id: string;
  objective_name: string;
  progress_percentage: number;
  status: 'not_started' | 'in_progress' | 'completed' | 'failed';
  score: number | null;
  metrics: Record<string, unknown>;
  penalties: Array<{ reason: string; points: number; timestamp: string }>;
  bonuses: Array<{ reason: string; points: number; timestamp: string }>;
  weight: number;
}

export interface SessionScore {
  overall_score: number;
  objective_scores: Array<{
    objective_id: string;
    objective_name: string;
    score: number;
    weight: number;
    status: string;
  }>;
  success_level: 'Excellent' | 'Good' | 'Adequate' | 'Needs Improvement';
}

/**
 * Update objective progress
 */
export async function updateObjectiveProgress(
  sessionId: string,
  objectiveId: string,
  progressPercentage: number,
  options?: {
    status?: 'not_started' | 'in_progress' | 'completed' | 'failed';
    metrics?: Record<string, unknown>;
    objectiveName?: string;
  },
): Promise<void> {
  try {
    const { error } = await supabaseAdmin.rpc('update_objective_progress', {
      p_session_id: sessionId,
      p_objective_id: objectiveId,
      p_progress_percentage: progressPercentage,
      p_status: options?.status || null,
      p_metrics: options?.metrics || null,
      p_objective_name: options?.objectiveName || null,
    });

    if (error) {
      logger.error({ error, sessionId, objectiveId }, 'Failed to update objective progress');
      throw error;
    }

    logger.info(
      { sessionId, objectiveId, progressPercentage, status: options?.status },
      'Objective progress updated',
    );

    // Check if session should be auto-completed after objective update
    await checkAndAutoCompleteSession(sessionId);
  } catch (err) {
    logger.error({ error: err, sessionId, objectiveId }, 'Error updating objective progress');
    throw err;
  }
}

/**
 * Add penalty to objective
 */
export async function addObjectivePenalty(
  sessionId: string,
  objectiveId: string,
  reason: string,
  points: number,
): Promise<void> {
  try {
    const { error } = await supabaseAdmin.rpc('add_objective_penalty', {
      p_session_id: sessionId,
      p_objective_id: objectiveId,
      p_reason: reason,
      p_points: points,
    });

    if (error) {
      logger.error({ error, sessionId, objectiveId }, 'Failed to add objective penalty');
      throw error;
    }

    logger.info({ sessionId, objectiveId, reason, points }, 'Objective penalty added');
  } catch (err) {
    logger.error({ error: err, sessionId, objectiveId }, 'Error adding objective penalty');
    throw err;
  }
}

/**
 * Add bonus to objective
 */
export async function addObjectiveBonus(
  sessionId: string,
  objectiveId: string,
  reason: string,
  points: number,
): Promise<void> {
  try {
    const { error } = await supabaseAdmin.rpc('add_objective_bonus', {
      p_session_id: sessionId,
      p_objective_id: objectiveId,
      p_reason: reason,
      p_points: points,
    });

    if (error) {
      logger.error({ error, sessionId, objectiveId }, 'Failed to add objective bonus');
      throw error;
    }

    logger.info({ sessionId, objectiveId, reason, points }, 'Objective bonus added');
  } catch (err) {
    logger.error({ error: err, sessionId, objectiveId }, 'Error adding objective bonus');
    throw err;
  }
}

/**
 * Get objective progress for a session
 */
export async function getObjectiveProgress(sessionId: string): Promise<ObjectiveProgress[]> {
  try {
    const { data, error } = await supabaseAdmin
      .from('scenario_objective_progress')
      .select('*')
      .eq('session_id', sessionId)
      .order('objective_id');

    if (error) {
      logger.error({ error, sessionId }, 'Failed to get objective progress');
      throw error;
    }

    return (data as ObjectiveProgress[]) || [];
  } catch (err) {
    logger.error({ error: err, sessionId }, 'Error getting objective progress');
    throw err;
  }
}

/**
 * Calculate overall session score
 */
export async function calculateSessionScore(sessionId: string): Promise<SessionScore> {
  try {
    const { data, error } = await supabaseAdmin.rpc('calculate_session_score', {
      p_session_id: sessionId,
    });

    if (error) {
      logger.error({ error, sessionId }, 'Failed to calculate session score');
      throw error;
    }

    if (!data || data.length === 0) {
      return {
        overall_score: 0,
        objective_scores: [],
        success_level: 'Needs Improvement',
      };
    }

    return data[0] as SessionScore;
  } catch (err) {
    logger.error({ error: err, sessionId }, 'Error calculating session score');
    throw err;
  }
}

/**
 * Initialize objectives for a session based on scenario
 */
export async function initializeSessionObjectives(sessionId: string): Promise<void> {
  try {
    // Get session and scenario
    const { data: session, error: sessionError } = await supabaseAdmin
      .from('sessions')
      .select('scenario_id')
      .eq('id', sessionId)
      .single();

    if (sessionError || !session) {
      logger.error(
        { error: sessionError, sessionId },
        'Failed to get session for objective initialization',
      );
      return;
    }

    // Get scenario objectives
    const { data: objectives, error: objectivesError } = await supabaseAdmin
      .from('scenario_objectives')
      .select('*')
      .eq('scenario_id', session.scenario_id);

    if (objectivesError) {
      logger.error({ error: objectivesError, sessionId }, 'Failed to get scenario objectives');
      return;
    }

    if (!objectives || objectives.length === 0) {
      logger.warn(
        { sessionId, scenarioId: session.scenario_id },
        'No objectives defined for scenario',
      );
      return;
    }

    // Initialize progress for each objective
    for (const objective of objectives) {
      await updateObjectiveProgress(sessionId, objective.objective_id, 0, {
        status: 'not_started',
        objectiveName: objective.objective_name,
        metrics: {},
      });

      // Set weight from objective definition
      await supabaseAdmin
        .from('scenario_objective_progress')
        .update({ weight: objective.weight })
        .eq('session_id', sessionId)
        .eq('objective_id', objective.objective_id);
    }

    logger.info({ sessionId, objectiveCount: objectives.length }, 'Session objectives initialized');
  } catch (err) {
    logger.error({ error: err, sessionId }, 'Error initializing session objectives');
  }
}

/**
 * Check if all objectives are completed or failed (resolved)
 */
export async function areAllObjectivesResolved(sessionId: string): Promise<boolean> {
  try {
    const objectives = await getObjectiveProgress(sessionId);

    if (objectives.length === 0) {
      return false; // No objectives means not resolved
    }

    // All objectives must be either 'completed' or 'failed' (resolved states)
    return objectives.every((obj) => obj.status === 'completed' || obj.status === 'failed');
  } catch (err) {
    logger.error({ error: err, sessionId }, 'Error checking if all objectives are resolved');
    return false;
  }
}

/**
 * Check and auto-complete session if all objectives are resolved and auto-complete is enabled
 */
export async function checkAndAutoCompleteSession(sessionId: string): Promise<boolean> {
  try {
    // Get session to check if auto-complete is enabled
    const { data: session, error: sessionError } = await supabaseAdmin
      .from('sessions')
      .select('id, status, auto_complete_on_objectives')
      .eq('id', sessionId)
      .single();

    if (sessionError || !session) {
      logger.error(
        { error: sessionError, sessionId },
        'Failed to get session for auto-complete check',
      );
      return false;
    }

    // Only check if session is in progress
    if (session.status !== 'in_progress') {
      return false;
    }

    // Check if auto-complete is enabled (default to false if not set)
    const autoCompleteEnabled = session.auto_complete_on_objectives === true;
    if (!autoCompleteEnabled) {
      return false;
    }

    // Check if all objectives are resolved
    const allResolved = await areAllObjectivesResolved(sessionId);
    if (!allResolved) {
      return false;
    }

    // Auto-complete the session
    const { error: updateError } = await supabaseAdmin
      .from('sessions')
      .update({
        status: 'completed',
        end_time: new Date().toISOString(),
      })
      .eq('id', sessionId);

    if (updateError) {
      logger.error({ error: updateError, sessionId }, 'Failed to auto-complete session');
      return false;
    }

    logger.info({ sessionId }, 'Session auto-completed - all objectives resolved');
    return true;
  } catch (err) {
    logger.error({ error: err, sessionId }, 'Error checking and auto-completing session');
    return false;
  }
}

/**
 * Track decision impact on objectives
 * Called when decisions are executed
 */
export async function trackDecisionImpactOnObjectives(
  sessionId: string,
  decision: {
    id: string;
    title: string;
    description: string;
    type: string;
  },
): Promise<void> {
  try {
    const decisionText = `${decision.title} ${decision.description}`.toLowerCase();

    // Check for evacuation decisions
    if (
      decision.type === 'emergency_declaration' &&
      (decisionText.includes('evacuate') || decisionText.includes('evacuation'))
    ) {
      if (decisionText.includes('separate') || decisionText.includes('segregate')) {
        // Discriminatory segregation - penalty
        await addObjectivePenalty(
          sessionId,
          'evacuation',
          'Discriminatory segregation decision',
          30,
        );
        await addObjectivePenalty(sessionId, 'media', 'Discriminatory actions observed', 40);
      } else if (decisionText.includes('together') || decisionText.includes('everyone')) {
        // Evacuation together - update progress
        await updateObjectiveProgress(sessionId, 'evacuation', 30, {
          status: 'in_progress',
          metrics: { evacuation_plan_executed: true },
        });
      }
    }

    // Check for media/statement decisions
    if (decision.type === 'public_statement') {
      if (
        decisionText.includes('misinformation') ||
        decisionText.includes('false') ||
        decisionText.includes('deny')
      ) {
        // Addressing misinformation - bonus
        await addObjectiveBonus(sessionId, 'media', 'Statement addresses misinformation', 20);
        await updateObjectiveProgress(sessionId, 'media', 50, { status: 'in_progress' });
      } else if (decisionText.includes('refuse') || decisionText.includes('no comment')) {
        // Refusing to comment - penalty
        await addObjectivePenalty(
          sessionId,
          'media',
          'Refusal to comment creates information vacuum',
          30,
        );
      } else {
        // Statement without addressing misinformation - penalty
        await addObjectivePenalty(
          sessionId,
          'media',
          'Statement fails to counter misinformation',
          25,
        );
      }
    }

    // Check for triage/medical decisions
    if (decision.type === 'resource_allocation' && decisionText.includes('triage')) {
      await updateObjectiveProgress(sessionId, 'triage', 50, {
        status: 'in_progress',
        metrics: { triage_system_established: true },
      });
    }

    // Check for coordination decisions
    if (decision.type === 'coordination_order') {
      await updateObjectiveProgress(sessionId, 'coordination', 40, {
        status: 'in_progress',
        metrics: { coordination_efforts: true },
      });
    }

    // Check if session should be auto-completed after objective update
    await checkAndAutoCompleteSession(sessionId);
  } catch (err) {
    logger.error(
      { error: err, sessionId, decisionId: decision.id },
      'Error tracking decision impact on objectives',
    );
  }
}

/**
 * Evaluate all objectives for a session using AI
 * Called after decision execution to determine if objectives are complete
 * This is a non-blocking operation that runs in the background
 */
export async function evaluateAllObjectivesForSession(
  sessionId: string,
  openAiApiKey: string | undefined,
): Promise<void> {
  try {
    // Call the AI evaluation service
    await evaluateAllObjectivesWithAI(sessionId, openAiApiKey);
  } catch (err) {
    // Don't throw - this is a background process
    logger.error(
      { error: err, sessionId },
      'Error in evaluateAllObjectivesForSession - continuing without blocking',
    );
  }
}
