import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { publishInjectToSession } from '../routes/injects.js';
import type { Server as SocketServer } from 'socket.io';

/**
 * Decision Classification from AI
 */
export interface DecisionClassification {
  primary_category: string;
  categories: string[];
  keywords: string[];
  semantic_tags: string[];
  confidence: number;
}

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
 * Find injects that should be triggered based on decision classification
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

    // Filter injects that match the classification
    const matchingInjects: Array<{ id: string; trigger_condition: string }> = [];

    for (const inject of injects) {
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
 */
export async function shouldTriggerInject(injectId: string, sessionId: string): Promise<boolean> {
  try {
    // Check if inject has been published (via session_events)
    const { data: events, error } = await supabaseAdmin
      .from('session_events')
      .select('event_data')
      .eq('session_id', sessionId)
      .eq('event_type', 'inject');

    if (error) {
      logger.error({ error, sessionId, injectId }, 'Failed to check published injects');
      return true; // Default to allowing trigger if we can't check
    }

    if (!events || events.length === 0) {
      return true; // No injects published yet, allow trigger
    }

    // Check if this inject ID is in the published events
    for (const event of events) {
      const eventData = event.event_data as { inject_id?: string };
      if (eventData?.inject_id === injectId) {
        return false; // Already published
      }
    }

    return true; // Not published yet, allow trigger
  } catch (err) {
    logger.error({ error: err, sessionId, injectId }, 'Error checking if inject should trigger');
    return true; // Default to allowing trigger on error
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
