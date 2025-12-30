import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { publishInjectToSession } from '../routes/injects.js';
import type { Server as SocketServer } from 'socket.io';
import { generateInjectFromDecision, type DecisionClassification } from './aiService.js';
import { env } from '../env.js';

/**
 * Trigger Condition Format
 * Supports both JSON and simple text formats
 */
export interface TriggerCondition {
  type: 'decision_based';
  match_criteria: {
    categories?: string[];
    keywords?: string[];
    semantic_tags?: string[];
  };
  match_mode?: 'any' | 'all'; // Default: 'any'
}

/**
 * Parse trigger condition from TEXT field
 * Supports both JSON and simple text formats
 */
export function parseTriggerCondition(condition: string | null): TriggerCondition | null {
  if (!condition) return null;

  try {
    // Try parsing as JSON first
    const parsed = JSON.parse(condition);
    if (parsed.type === 'decision_based') {
      return parsed as TriggerCondition;
    }
  } catch {
    // Not JSON, try simple text format
    // Format: "category:emergency_declaration AND keyword:evacuation"
    const parts = condition.split(' AND ');
    const criteria: { categories?: string[]; keywords?: string[]; semantic_tags?: string[] } = {};

    for (const part of parts) {
      const trimmed = part.trim();
      if (trimmed.startsWith('category:')) {
        const category = trimmed.replace('category:', '').trim();
        if (!criteria.categories) criteria.categories = [];
        criteria.categories.push(category);
      } else if (trimmed.startsWith('keyword:')) {
        const keyword = trimmed.replace('keyword:', '').trim();
        if (!criteria.keywords) criteria.keywords = [];
        criteria.keywords.push(keyword);
      } else if (trimmed.startsWith('tag:')) {
        const tag = trimmed.replace('tag:', '').trim();
        if (!criteria.semantic_tags) criteria.semantic_tags = [];
        criteria.semantic_tags.push(tag);
      }
    }

    if (Object.keys(criteria).length > 0) {
      return {
        type: 'decision_based',
        match_criteria: criteria,
        match_mode: 'any',
      };
    }
  }

  return null;
}

/**
 * Check if AI classification matches trigger condition
 */
export function matchesTriggerCondition(
  condition: TriggerCondition,
  classification: DecisionClassification,
): boolean {
  const { match_criteria, match_mode = 'any' } = condition;
  const matches: boolean[] = [];

  // Check categories
  if (match_criteria.categories && match_criteria.categories.length > 0) {
    const categoryMatch = match_criteria.categories.some((cat) =>
      classification.categories.includes(cat.toLowerCase()),
    );
    matches.push(categoryMatch);
  }

  // Check keywords (case-insensitive, partial matching)
  if (match_criteria.keywords && match_criteria.keywords.length > 0) {
    const allKeywords = [...classification.keywords, ...classification.primary_category.split('_')];
    const keywordMatch = match_criteria.keywords.some((keyword) =>
      allKeywords.some(
        (k) =>
          k.toLowerCase().includes(keyword.toLowerCase()) ||
          keyword.toLowerCase().includes(k.toLowerCase()),
      ),
    );
    matches.push(keywordMatch);
  }

  // Check semantic tags
  if (match_criteria.semantic_tags && match_criteria.semantic_tags.length > 0) {
    const tagMatch = match_criteria.semantic_tags.some((tag) =>
      classification.semantic_tags.includes(tag.toLowerCase()),
    );
    matches.push(tagMatch);
  }

  // If no criteria specified, don't match
  if (matches.length === 0) return false;

  // Apply match mode
  if (match_mode === 'all') {
    return matches.every((m) => m);
  } else {
    // 'any' mode - at least one must match
    return matches.some((m) => m);
  }
}

/**
 * Get list of inject IDs that have already been published to a session
 */
async function getPublishedInjectIds(sessionId: string): Promise<Set<string>> {
  try {
    const { data: events, error } = await supabaseAdmin
      .from('session_events')
      .select('metadata')
      .eq('session_id', sessionId)
      .eq('event_type', 'inject');

    if (error) {
      logger.error({ error, sessionId }, 'Failed to fetch published injects');
      return new Set(); // Return empty set on error to be safe
    }

    if (!events || events.length === 0) {
      return new Set();
    }

    // Extract inject IDs from metadata
    const publishedIds = new Set<string>();
    for (const event of events) {
      const metadata = event.metadata as { inject_id?: string } | null;
      if (metadata?.inject_id) {
        publishedIds.add(metadata.inject_id);
      }
    }

    return publishedIds;
  } catch (err) {
    logger.error({ error: err, sessionId }, 'Error getting published inject IDs');
    return new Set(); // Return empty set on error to be safe
  }
}

/**
 * Find injects that should be triggered based on decision classification
 * Only returns injects that haven't been published yet (one-time use)
 */
export async function findMatchingInjects(
  sessionId: string,
  classification: DecisionClassification,
): Promise<Array<{ id: string; trigger_condition: string }>> {
  try {
    // Get session to find scenario_id
    const { data: session } = await supabaseAdmin
      .from('sessions')
      .select('scenario_id')
      .eq('id', sessionId)
      .single();

    if (!session) {
      logger.warn({ sessionId }, 'Session not found for inject trigger evaluation');
      return [];
    }

    // Get all injects for this scenario with decision-based triggers
    const { data: injects, error } = await supabaseAdmin
      .from('scenario_injects')
      .select('id, trigger_condition')
      .eq('scenario_id', session.scenario_id)
      .not('trigger_condition', 'is', null)
      .is('trigger_time_minutes', null); // Only decision-based, not time-based

    if (error) {
      logger.error({ error, sessionId }, 'Failed to fetch injects for trigger evaluation');
      return [];
    }

    if (!injects || injects.length === 0) {
      return [];
    }

    // Get list of injects that have already been published (one-time use limit)
    const publishedInjectIds = await getPublishedInjectIds(sessionId);

    // Filter injects that match the classification AND haven't been published yet
    const matchingInjects: Array<{ id: string; trigger_condition: string }> = [];

    for (const inject of injects) {
      // Skip if inject has already been published (one-time use)
      if (publishedInjectIds.has(inject.id)) {
        logger.debug(
          { sessionId, injectId: inject.id },
          'Skipping inject that has already been published (one-time use limit)',
        );
        continue;
      }

      const condition = parseTriggerCondition(inject.trigger_condition);
      if (condition && matchesTriggerCondition(condition, classification)) {
        matchingInjects.push({
          id: inject.id,
          trigger_condition: inject.trigger_condition,
        });
      }
    }

    return matchingInjects;
  } catch (err) {
    logger.error({ error: err, sessionId }, 'Error finding matching injects');
    return [];
  }
}

/**
 * Check if inject has already been published to session
 * This is a secondary check to ensure one-time use limit is enforced
 */
export async function shouldTriggerInject(injectId: string, sessionId: string): Promise<boolean> {
  try {
    // Check if inject has been published (via session_events)
    // Note: inject_id is stored in metadata, not event_data
    const { data: events, error } = await supabaseAdmin
      .from('session_events')
      .select('metadata')
      .eq('session_id', sessionId)
      .eq('event_type', 'inject');

    if (error) {
      logger.error({ error, sessionId, injectId }, 'Failed to check published injects');
      return false; // Default to blocking trigger if we can't check (safer)
    }

    if (!events || events.length === 0) {
      return true; // No injects published yet, allow trigger
    }

    // Check if this inject ID is in the published events (stored in metadata)
    for (const event of events) {
      const metadata = event.metadata as { inject_id?: string } | null;
      if (metadata?.inject_id === injectId) {
        logger.debug({ sessionId, injectId }, 'Inject already published, blocking trigger');
        return false; // Already published - enforce one-time use
      }
    }

    return true; // Not published yet, allow trigger
  } catch (err) {
    logger.error({ error: err, sessionId, injectId }, 'Error checking if inject should trigger');
    return false; // Default to blocking trigger on error (safer for one-time use)
  }
}

/**
 * Evaluate decision-based triggers and auto-publish matching injects
 * Limits the number of injects published per decision to prevent flooding
 */
export async function evaluateDecisionBasedTriggers(
  sessionId: string,
  decision: { id: string; title: string; description: string },
  classification: DecisionClassification,
  io?: SocketServer,
): Promise<void> {
  try {
    logger.info(
      { sessionId, decisionId: decision.id, classification: classification.primary_category },
      'Evaluating decision-based inject triggers',
    );

    // Find matching injects
    const matchingInjects = await findMatchingInjects(sessionId, classification);

    if (matchingInjects.length === 0) {
      logger.debug({ sessionId, decisionId: decision.id }, 'No matching injects found');
      return;
    }

    logger.info(
      { sessionId, decisionId: decision.id, matchCount: matchingInjects.length },
      'Found matching injects for decision',
    );

    // Get session trainer_id for publishing
    const { data: session } = await supabaseAdmin
      .from('sessions')
      .select('trainer_id')
      .eq('id', sessionId)
      .single();

    if (!session) {
      logger.warn({ sessionId }, 'Session not found, cannot publish injects');
      return;
    }

    // Limit the number of injects published per decision (default: 2)
    // This prevents flooding the screen with too many injects at once
    const maxInjectsPerDecision = Number(process.env.MAX_DECISION_INJECTS_PER_TRIGGER) || 2;
    let publishedCount = 0;

    // Publish each matching inject (up to the limit)
    for (const inject of matchingInjects) {
      // Stop if we've reached the limit
      if (publishedCount >= maxInjectsPerDecision) {
        logger.info(
          {
            sessionId,
            decisionId: decision.id,
            publishedCount,
            totalMatches: matchingInjects.length,
            limit: maxInjectsPerDecision,
          },
          'Reached decision-based inject limit, remaining injects will not be published',
        );
        break;
      }

      // Check if already published
      const shouldTrigger = await shouldTriggerInject(inject.id, sessionId);
      if (!shouldTrigger) {
        logger.debug({ sessionId, injectId: inject.id }, 'Inject already published, skipping');
        continue;
      }

      try {
        // Get io instance if not provided
        let socketIo = io;
        if (!socketIo) {
          const { io: importedIo } = await import('../index.js');
          socketIo = importedIo;
        }

        await publishInjectToSession(inject.id, sessionId, session.trainer_id, socketIo);
        publishedCount++;

        logger.info(
          { sessionId, decisionId: decision.id, injectId: inject.id, publishedCount },
          'Auto-published inject based on decision',
        );
      } catch (publishErr) {
        logger.error(
          { error: publishErr, sessionId, decisionId: decision.id, injectId: inject.id },
          'Failed to auto-publish inject',
        );
        // Continue with next inject even if one fails
      }
    }
  } catch (err) {
    logger.error(
      { error: err, sessionId, decisionId: decision.id },
      'Error evaluating decision-based triggers',
    );
    // Don't throw - we don't want to block decision execution
  }
}

/**
 * Generate and publish a fresh inject based on a decision
 * This creates a new inject dynamically rather than matching against pre-defined ones
 */
export async function generateAndPublishInjectFromDecision(
  sessionId: string,
  decision: { id: string; title: string; description: string; type: string },
  classification: DecisionClassification,
  io?: SocketServer,
): Promise<void> {
  try {
    logger.info(
      { sessionId, decisionId: decision.id, classification: classification.primary_category },
      'Generating fresh inject from decision',
    );

    // Get session and scenario context
    const { data: session, error: sessionError } = await supabaseAdmin
      .from('sessions')
      .select('scenario_id, trainer_id, start_time, current_state')
      .eq('id', sessionId)
      .single();

    if (sessionError) {
      logger.error(
        {
          sessionId,
          error: sessionError,
          errorCode: sessionError.code,
          errorMessage: sessionError.message,
          errorDetails: sessionError.details,
          errorHint: sessionError.hint,
        },
        'Error fetching session for inject generation',
      );
      return;
    }

    if (!session) {
      logger.warn(
        {
          sessionId,
          sessionIdLength: sessionId.length,
          sessionIdFormat: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
            sessionId,
          ),
        },
        'Session not found for inject generation',
      );
      return;
    }

    // Calculate session duration
    const sessionDurationMinutes = session.start_time
      ? Math.round((new Date().getTime() - new Date(session.start_time).getTime()) / 60000)
      : 0;

    // Gather all context in parallel for efficiency
    const [
      scenarioResult,
      allDecisionsResult,
      upcomingInjectsResult,
      objectivesResult,
      recentInjectsResult,
      participantsResult,
    ] = await Promise.all([
      // Get scenario description
      supabaseAdmin.from('scenarios').select('description').eq('id', session.scenario_id).single(),

      // Get ALL executed decisions (not just last 5) with full context
      supabaseAdmin
        .from('decisions')
        .select(
          'id, title, description, type, proposed_by, executed_at, ai_classification, creator:user_profiles!decisions_proposed_by_fkey(full_name)',
        )
        .eq('session_id', sessionId)
        .eq('status', 'executed')
        .order('executed_at', { ascending: true }), // Chronological order

      // Get upcoming time-based injects (next 10)
      supabaseAdmin
        .from('scenario_injects')
        .select('trigger_time_minutes, type, title, content, severity')
        .eq('scenario_id', session.scenario_id)
        .not('trigger_time_minutes', 'is', null)
        .gt('trigger_time_minutes', sessionDurationMinutes)
        .order('trigger_time_minutes', { ascending: true })
        .limit(10),

      // Get objectives status
      supabaseAdmin
        .from('scenario_objective_progress')
        .select('objective_id, objective_name, status, progress_percentage')
        .eq('session_id', sessionId),

      // Get recent injects (last 10 published)
      supabaseAdmin
        .from('session_events')
        .select('metadata, created_at')
        .eq('session_id', sessionId)
        .eq('event_type', 'inject')
        .order('created_at', { ascending: false })
        .limit(10),

      // Get participants
      supabaseAdmin
        .from('session_participants')
        .select('user_id, role')
        .eq('session_id', sessionId),
    ]);

    // Process decisions to include creator names
    const allDecisions =
      allDecisionsResult.data?.map((d: Record<string, unknown>) => ({
        id: d.id as string,
        title: d.title as string,
        description: d.description as string,
        type: d.type as string,
        proposed_by: d.proposed_by as string | undefined,
        proposed_by_name: (d.creator as { full_name?: string } | null)?.full_name,
        executed_at: (d.executed_at as string) || undefined,
        ai_classification: (d.ai_classification as DecisionClassification | null) || undefined,
      })) || [];

    // Process recent injects
    const recentInjects =
      recentInjectsResult.data?.map((e: Record<string, unknown>) => {
        const metadata = e.metadata as Record<string, unknown> | null;
        return {
          type: (metadata?.type as string) || 'unknown',
          title: (metadata?.title as string) || 'Unknown',
          content: (metadata?.content as string) || '',
          published_at: e.created_at as string,
        };
      }) || [];

    // Enhanced context object
    const enhancedContext = {
      scenarioDescription: scenarioResult.data?.description,
      recentDecisions: allDecisions, // ALL decisions now, not just last 5
      sessionDurationMinutes,
      upcomingInjects: upcomingInjectsResult.data || [],
      currentState: (session.current_state as Record<string, unknown>) || {},
      objectives: objectivesResult.data || [],
      recentInjects,
      participants: participantsResult.data || [],
    };

    // Generate inject using AI
    if (!env.openAiApiKey) {
      logger.warn('OpenAI API key not configured, skipping inject generation');
      return;
    }

    const generatedInject = await generateInjectFromDecision(
      decision,
      enhancedContext,
      env.openAiApiKey,
    );

    if (!generatedInject) {
      logger.debug({ sessionId, decisionId: decision.id }, 'AI determined no inject needed');
      return;
    }

    // Create the inject in the database
    const { data: createdInject, error: createError } = await supabaseAdmin
      .from('scenario_injects')
      .insert({
        scenario_id: session.scenario_id,
        trigger_time_minutes: null, // Not time-based
        trigger_condition: null, // Not condition-based (fresh generation)
        type: generatedInject.type,
        title: generatedInject.title,
        content: generatedInject.content,
        severity: generatedInject.severity,
        affected_roles: generatedInject.affected_roles || [],
        inject_scope: generatedInject.inject_scope || 'universal',
        requires_response: generatedInject.requires_response ?? false,
        requires_coordination: generatedInject.requires_coordination ?? false,
        ai_generated: true, // Mark as AI-generated
      })
      .select()
      .single();

    if (createError) {
      logger.error(
        { error: createError, sessionId, decisionId: decision.id },
        'Failed to create AI-generated inject',
      );
      return;
    }

    if (!createdInject) {
      logger.error({ sessionId, decisionId: decision.id }, 'Inject creation returned no data');
      return;
    }

    // Get io instance if not provided
    let socketIo = io;
    if (!socketIo) {
      const { io: importedIo } = await import('../index.js');
      socketIo = importedIo;
    }

    // Immediately publish the inject
    await publishInjectToSession(createdInject.id, sessionId, session.trainer_id, socketIo);

    logger.info(
      { sessionId, decisionId: decision.id, injectId: createdInject.id },
      'AI-generated inject created and published',
    );
  } catch (err) {
    logger.error(
      { error: err, sessionId, decisionId: decision.id },
      'Error generating and publishing inject from decision',
    );
    // Don't throw - we don't want to block decision execution
  }
}
