import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { evaluateObjectiveCompletion, type ObjectiveCompletionEvaluation } from './aiService.js';
import { updateObjectiveProgress } from './objectiveTrackingService.js';

/**
 * Objective Evaluation Service
 * Uses AI to evaluate if objectives have been completed based on executed decisions
 */

/**
 * Get all executed decisions for a session
 */
async function getExecutedDecisions(sessionId: string): Promise<
  Array<{
    id: string;
    title: string;
    description: string;
    type: string;
    executed_at: string;
  }>
> {
  try {
    const { data, error } = await supabaseAdmin
      .from('decisions')
      .select('id, title, description, type, executed_at')
      .eq('session_id', sessionId)
      .eq('status', 'executed')
      .order('executed_at', { ascending: true });

    if (error) {
      logger.error({ error, sessionId }, 'Failed to fetch executed decisions');
      throw error;
    }

    return (data || []).map((d) => ({
      id: d.id,
      title: d.title || '',
      description: d.description || '',
      type: d.type || 'operational_action',
      executed_at: d.executed_at || '',
    }));
  } catch (err) {
    logger.error({ error: err, sessionId }, 'Error fetching executed decisions');
    throw err;
  }
}

/**
 * Get session start time
 */
async function getSessionStartTime(sessionId: string): Promise<string> {
  try {
    const { data, error } = await supabaseAdmin
      .from('sessions')
      .select('start_time')
      .eq('id', sessionId)
      .single();

    if (error || !data) {
      logger.error({ error, sessionId }, 'Failed to fetch session start time');
      throw error || new Error('Session not found');
    }

    // Use start_time if available, otherwise use created_at as fallback
    return data.start_time || new Date().toISOString();
  } catch (err) {
    logger.error({ error: err, sessionId }, 'Error fetching session start time');
    // Fallback to current time if we can't get session start
    return new Date().toISOString();
  }
}

/**
 * Evaluate a single objective for completion
 */
export async function evaluateObjective(
  sessionId: string,
  objective: {
    objective_id: string;
    objective_name: string;
    description: string;
    success_criteria: Record<string, unknown>;
  },
  decisions: Array<{
    id: string;
    title: string;
    description: string;
    type: string;
    executed_at: string;
  }>,
  sessionStartTime: string,
  openAiApiKey: string,
): Promise<ObjectiveCompletionEvaluation | null> {
  try {
    const evaluation = await evaluateObjectiveCompletion(
      objective,
      decisions,
      sessionStartTime,
      openAiApiKey,
    );

    logger.info(
      {
        sessionId,
        objectiveId: objective.objective_id,
        isComplete: evaluation.isComplete,
        confidence: evaluation.confidence,
        progressPercentage: evaluation.progressPercentage,
      },
      'Objective evaluated by AI',
    );

    return evaluation;
  } catch (err) {
    logger.error(
      { error: err, sessionId, objectiveId: objective.objective_id },
      'Error evaluating objective with AI',
    );
    return null;
  }
}

/**
 * Evaluate all objectives for a session and update their status
 * Called after each decision execution (async, non-blocking)
 */
export async function evaluateAllObjectivesForSession(
  sessionId: string,
  openAiApiKey: string | undefined,
): Promise<void> {
  try {
    // Skip if OpenAI API key is not configured
    if (!openAiApiKey) {
      logger.debug(
        { sessionId },
        'Skipping AI objective evaluation - OpenAI API key not configured',
      );
      return;
    }

    // Get session to verify it's in progress
    const { data: session, error: sessionError } = await supabaseAdmin
      .from('sessions')
      .select('id, status, start_time')
      .eq('id', sessionId)
      .single();

    if (sessionError || !session) {
      logger.error(
        { error: sessionError, sessionId },
        'Failed to get session for objective evaluation',
      );
      return;
    }

    // Only evaluate if session is in progress
    if (session.status !== 'in_progress') {
      logger.debug(
        { sessionId, status: session.status },
        'Skipping objective evaluation - session not in progress',
      );
      return;
    }

    // Get all objectives for this session
    const { data: objectives, error: objectivesError } = await supabaseAdmin
      .from('scenario_objective_progress')
      .select('objective_id, objective_name, status')
      .eq('session_id', sessionId);

    if (objectivesError) {
      logger.error(
        { error: objectivesError, sessionId },
        'Failed to get objectives for evaluation',
      );
      return;
    }

    if (!objectives || objectives.length === 0) {
      logger.debug({ sessionId }, 'No objectives found for evaluation');
      return;
    }

    // Get objective definitions with success criteria
    const objectiveIds = objectives.map((o) => o.objective_id);
    const { data: objectiveDefinitions, error: definitionsError } = await supabaseAdmin
      .from('scenario_objectives')
      .select('objective_id, objective_name, description, success_criteria')
      .in('objective_id', objectiveIds);

    if (definitionsError) {
      logger.error({ error: definitionsError, sessionId }, 'Failed to get objective definitions');
      return;
    }

    if (!objectiveDefinitions || objectiveDefinitions.length === 0) {
      logger.warn({ sessionId }, 'No objective definitions found');
      return;
    }

    // Get executed decisions and session start time
    const [decisions, sessionStartTime] = await Promise.all([
      getExecutedDecisions(sessionId),
      getSessionStartTime(sessionId),
    ]);

    // Evaluate each objective that is not already completed or failed
    const evaluationPromises = objectives
      .filter((obj) => obj.status !== 'completed' && obj.status !== 'failed')
      .map(async (objectiveProgress) => {
        const objectiveDef = objectiveDefinitions.find(
          (def) => def.objective_id === objectiveProgress.objective_id,
        );

        if (!objectiveDef) {
          logger.warn(
            { sessionId, objectiveId: objectiveProgress.objective_id },
            'Objective definition not found',
          );
          return null;
        }

        const evaluation = await evaluateObjective(
          sessionId,
          {
            objective_id: objectiveDef.objective_id,
            objective_name: objectiveDef.objective_name,
            description: objectiveDef.description || '',
            success_criteria: (objectiveDef.success_criteria as Record<string, unknown>) || {},
          },
          decisions,
          sessionStartTime,
          openAiApiKey,
        );

        if (!evaluation) {
          return null;
        }

        // Update objective if AI determined it's complete
        if (evaluation.isComplete && evaluation.confidence >= 0.75) {
          try {
            await updateObjectiveProgress(
              sessionId,
              objectiveDef.objective_id,
              evaluation.progressPercentage,
              {
                status: 'completed',
                metrics: {
                  ai_evaluation: true,
                  confidence: evaluation.confidence,
                  reasoning: evaluation.reasoning,
                  evaluated_at: new Date().toISOString(),
                },
              },
            );

            logger.info(
              {
                sessionId,
                objectiveId: objectiveDef.objective_id,
                confidence: evaluation.confidence,
                progressPercentage: evaluation.progressPercentage,
              },
              'Objective marked as completed by AI evaluation',
            );
          } catch (updateError) {
            logger.error(
              { error: updateError, sessionId, objectiveId: objectiveDef.objective_id },
              'Failed to update objective status after AI evaluation',
            );
          }
        } else if (evaluation.progressPercentage > 0) {
          // Update progress even if not complete
          try {
            await updateObjectiveProgress(
              sessionId,
              objectiveDef.objective_id,
              evaluation.progressPercentage,
              {
                metrics: {
                  ai_evaluation: true,
                  confidence: evaluation.confidence,
                  reasoning: evaluation.reasoning,
                  evaluated_at: new Date().toISOString(),
                },
              },
            );
          } catch (updateError) {
            logger.error(
              { error: updateError, sessionId, objectiveId: objectiveDef.objective_id },
              'Failed to update objective progress after AI evaluation',
            );
          }
        }

        return evaluation;
      });

    await Promise.all(evaluationPromises);

    logger.info(
      { sessionId, objectiveCount: objectives.length },
      'Completed AI evaluation of all objectives',
    );
  } catch (err) {
    // Don't throw - this is a background process that shouldn't block decision execution
    logger.error({ error: err, sessionId }, 'Error in evaluateAllObjectivesForSession');
  }
}
