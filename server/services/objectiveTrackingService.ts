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

    // Snapshot final state so counters persist for AAR review
    const { snapshotFinalStateOnCompletion } = await import('./scenarioStateService.js');
    void snapshotFinalStateOnCompletion(sessionId).catch((err) =>
      logger.error({ err, sessionId }, 'Snapshot final state on auto-complete failed'),
    );

    logger.info({ sessionId }, 'Session auto-completed - all objectives resolved');
    return true;
  } catch (err) {
    logger.error({ error: err, sessionId }, 'Error checking and auto-completing session');
    return false;
  }
}

/**
 * Update triage_state.robustness_boost when triage bonuses/penalties are applied.
 * The inject scheduler adds this to robustness_by_team.Triage when computing the triage band.
 */
export async function updateTriageRobustnessBoost(sessionId: string, delta: number): Promise<void> {
  try {
    const { data: session } = await supabaseAdmin
      .from('sessions')
      .select('current_state')
      .eq('id', sessionId)
      .single();
    const currentState = (session?.current_state as Record<string, unknown>) || {};
    const triageState = (currentState.triage_state as Record<string, unknown>) || {};
    const current = (triageState.robustness_boost as number) ?? 0;
    const next = Math.max(-2, Math.min(2, current + delta));
    const nextTriageState = { ...triageState, robustness_boost: next };
    await supabaseAdmin
      .from('sessions')
      .update({
        current_state: { ...currentState, triage_state: nextTriageState },
      })
      .eq('id', sessionId);
  } catch (err) {
    logger.error({ err, sessionId }, 'Failed to update triage robustness boost');
  }
}

/**
 * Update media_state.robustness_boost when media bonuses/penalties are applied.
 * Used by computePublicSentiment or sentiment modifiers.
 */
export async function updateMediaRobustnessBoost(sessionId: string, delta: number): Promise<void> {
  try {
    const { data: session } = await supabaseAdmin
      .from('sessions')
      .select('current_state')
      .eq('id', sessionId)
      .single();
    const currentState = (session?.current_state as Record<string, unknown>) || {};
    const mediaState = (currentState.media_state as Record<string, unknown>) || {};
    const current = (mediaState.robustness_boost as number) ?? 0;
    const next = Math.max(-2, Math.min(2, current + delta));
    const nextMediaState = { ...mediaState, robustness_boost: next };
    await supabaseAdmin
      .from('sessions')
      .update({
        current_state: { ...currentState, media_state: nextMediaState },
      })
      .eq('id', sessionId);
  } catch (err) {
    logger.error({ err, sessionId }, 'Failed to update media robustness boost');
  }
}

/**
 * Track decision impact on objectives
 * Called when decisions are executed
 * @param options.skipPositiveForObjectiveIds - when set, positive updates (progress/bonus) for these objective IDs are skipped (anti-gaming); penalties still apply
 * @param options.authorTeamNames - team names of the decision author; triage bonuses only apply when author is in triage team
 */
export async function trackDecisionImpactOnObjectives(
  sessionId: string,
  decision: {
    id: string;
    title: string;
    description: string;
    type: string;
  },
  options?: {
    authorId?: string;
    skipPositiveForObjectiveIds?: string[];
    authorTeamNames?: string[];
  },
): Promise<void> {
  try {
    const skipPositive = options?.skipPositiveForObjectiveIds ?? [];
    const skip = (objectiveId: string) =>
      skipPositive.length > 0 && skipPositive.includes(objectiveId);
    const authorTeamNames = options?.authorTeamNames ?? [];
    const isTriageTeam = authorTeamNames.some((t) => /triage/i.test(t));
    const isMediaTeam = authorTeamNames.some((t) => /media/i.test(t));

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
        // Evacuation together - update progress (skip if vague for evacuation gate)
        if (!skip('evacuation')) {
          await updateObjectiveProgress(sessionId, 'evacuation', 30, {
            status: 'in_progress',
            metrics: { evacuation_plan_executed: true },
          });
        }
      }
    }

    // Check for media/statement decisions
    if (decision.type === 'public_statement') {
      if (
        decisionText.includes('misinformation') ||
        decisionText.includes('false') ||
        decisionText.includes('deny')
      ) {
        // Addressing misinformation - bonus (skip if vague for media gate)
        if (!skip('media')) {
          await addObjectiveBonus(sessionId, 'media', 'Statement addresses misinformation', 20);
          await updateObjectiveProgress(sessionId, 'media', 50, { status: 'in_progress' });
        }
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

      // Tier 1: Crisis media keyword bonuses (only when author is media team)
      if (isMediaTeam && !skip('media')) {
        if (
          decisionText.includes('spokesperson') ||
          decisionText.includes('one voice') ||
          decisionText.includes('designated spokesperson')
        ) {
          await addObjectiveBonus(sessionId, 'media', 'Designated spokesperson referenced', 5);
          await updateMediaRobustnessBoost(sessionId, 0.5);
        }
        if (
          decisionText.includes('cannot confirm') ||
          decisionText.includes('under investigation') ||
          decisionText.includes('no comment on') ||
          (decisionText.includes('investigat') && decisionText.includes('authorities'))
        ) {
          await addObjectiveBonus(sessionId, 'media', 'Avoids speculation on perpetrators', 5);
          await updateMediaRobustnessBoost(sessionId, 0.5);
        }
        if (
          decisionText.includes('verified') ||
          decisionText.includes('confirmed') ||
          decisionText.includes('what we know')
        ) {
          await addObjectiveBonus(sessionId, 'media', 'Verify-before-release framing', 5);
          await updateMediaRobustnessBoost(sessionId, 0.5);
        }
        if (
          decisionText.includes('no names') ||
          decisionText.includes('family first') ||
          decisionText.includes('notify family') ||
          decisionText.includes('victim dignity')
        ) {
          await addObjectiveBonus(sessionId, 'media', 'Victim dignity respected', 5);
          await updateMediaRobustnessBoost(sessionId, 0.5);
        }
        if (
          decisionText.includes('media zone') ||
          decisionText.includes('100m') ||
          decisionText.includes('150m') ||
          decisionText.includes('outside operational')
        ) {
          await addObjectiveBonus(sessionId, 'media', 'Media zone management', 5);
          await updateMediaRobustnessBoost(sessionId, 0.5);
        }
        if (
          decisionText.includes('30 min') ||
          decisionText.includes('60 min') ||
          decisionText.includes('next update') ||
          decisionText.includes('regular updates')
        ) {
          await addObjectiveBonus(sessionId, 'media', 'Regular update schedule', 5);
          await updateMediaRobustnessBoost(sessionId, 0.5);
        }
      }
    }

    // Check for triage/medical decisions (broaden: resource_allocation, triage_protocol, prioritisation)
    const isTriageDecision =
      (decision.type === 'resource_allocation' && decisionText.includes('triage')) ||
      decision.type === 'triage_protocol' ||
      (decision.type === 'prioritisation' &&
        (decisionText.includes('triage') ||
          decisionText.includes('casualty') ||
          decisionText.includes('red') ||
          decisionText.includes('critical')));

    if (isTriageDecision && !skip('triage')) {
      await updateObjectiveProgress(sessionId, 'triage', 50, {
        status: 'in_progress',
        metrics: { triage_system_established: true },
      });

      // Tier 1: Keyword-based bonuses (only when author is triage team)
      if (isTriageTeam) {
        // START protocol
        if (decisionText.includes('start') || decisionText.includes('simple triage')) {
          await addObjectiveBonus(sessionId, 'triage', 'START protocol referenced', 10);
          await updateTriageRobustnessBoost(sessionId, 0.5);
        }
        // Tag colours (at least 2 of red/yellow/green)
        const tagCount = ['red', 'yellow', 'green'].filter((c) => decisionText.includes(c)).length;
        if (tagCount >= 2) {
          await addObjectiveBonus(
            sessionId,
            'triage',
            'Triage tag categories (Red/Yellow/Green)',
            5,
          );
        }
        // Staff ratio 1:5
        if (
          decisionText.includes('1:5') ||
          decisionText.includes('1 per 5') ||
          decisionText.includes('staff per 5 critical')
        ) {
          await addObjectiveBonus(sessionId, 'triage', 'Correct staff-to-critical ratio', 10);
          await updateTriageRobustnessBoost(sessionId, 0.5);
        }
        // Zone separation (hot/warm/cold)
        if (
          decisionText.includes('hot zone') ||
          decisionText.includes('warm zone') ||
          decisionText.includes('cold zone') ||
          (decisionText.includes('perimeter') && decisionText.includes('buffer'))
        ) {
          await addObjectiveBonus(sessionId, 'triage', 'Proper zone separation mentioned', 10);
          await updateTriageRobustnessBoost(sessionId, 0.5);
        }
        // Secondary device awareness
        if (
          decisionText.includes('bomb sweep') ||
          decisionText.includes('secondary device') ||
          decisionText.includes('blast radius')
        ) {
          await addObjectiveBonus(sessionId, 'triage', 'Secondary device awareness', 10);
          await updateTriageRobustnessBoost(sessionId, 0.5);
        }
        // Red-first transport
        if (
          decisionText.includes('red first') ||
          decisionText.includes('critical first') ||
          decisionText.includes('immediate first') ||
          decisionText.includes('priority transport')
        ) {
          await addObjectiveBonus(sessionId, 'triage', 'Red patients transport priority', 10);
          await updateTriageRobustnessBoost(sessionId, 0.5);
        }
        // Hospital distribution
        if (
          decisionText.includes('distribute') ||
          decisionText.includes('multiple hospitals') ||
          decisionText.includes('trauma center') ||
          decisionText.includes('trauma centre') ||
          decisionText.includes('spread')
        ) {
          await addObjectiveBonus(sessionId, 'triage', 'Hospital distribution protocol', 10);
          await updateTriageRobustnessBoost(sessionId, 0.5);
        }
        // Transport coordination
        if (
          decisionText.includes('transport officer') ||
          decisionText.includes('hospital coordination') ||
          decisionText.includes('ambulance staging')
        ) {
          await addObjectiveBonus(sessionId, 'triage', 'Transport coordination', 5);
          await updateTriageRobustnessBoost(sessionId, 0.25);
        }
        // Hospital tier penalties: Red/critical to polyclinic = wrong
        const mentionsRed =
          decisionText.includes('red') ||
          decisionText.includes('critical') ||
          decisionText.includes('immediate');
        const mentionsPolyclinic =
          decisionText.includes('toa payoh polyclinic') || decisionText.includes('polyclinic');
        const mentionsTTSH =
          decisionText.includes('tan tock seng') || decisionText.includes('ttsh');
        if (mentionsRed && mentionsPolyclinic) {
          await addObjectivePenalty(
            sessionId,
            'triage',
            'Red/critical patients routed to polyclinic (wrong tier)',
            15,
          );
          await updateTriageRobustnessBoost(sessionId, -0.5);
        }
        if (mentionsRed && mentionsTTSH) {
          await addObjectiveBonus(sessionId, 'triage', 'Red patients routed to trauma center', 5);
          await updateTriageRobustnessBoost(sessionId, 0.25);
        }
      }
    }

    // Check for coordination decisions
    if (decision.type === 'coordination_order') {
      if (!skip('coordination')) {
        await updateObjectiveProgress(sessionId, 'coordination', 40, {
          status: 'in_progress',
          metrics: { coordination_efforts: true },
        });
      }
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
