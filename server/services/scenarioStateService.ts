import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { getWebSocketService } from './websocketService.js';

/**
 * Scenario State Service - Server-side only
 * Separation of concerns: Manages scenario state updates when decisions are executed
 */

interface ScenarioState {
  evacuation_zones?: Array<{
    id: string;
    center_lat: number;
    center_lng: number;
    radius_meters: number;
    title: string;
    created_at: string;
  }>;
  resource_allocations?: Record<string, unknown>;
  public_sentiment?: number; // 0-100 scale
  active_incidents?: number;
  [key: string]: unknown;
}

/**
 * Update scenario state when a decision is executed
 */
export const updateStateOnDecisionExecution = async (
  sessionId: string,
  decision: {
    id: string;
    decision_type: string;
    title: string;
    description: string;
    resources_needed?: Record<string, unknown>;
    consequences?: Record<string, unknown>;
  },
): Promise<void> => {
  try {
    // Get current session state
    const { data: session } = await supabaseAdmin
      .from('sessions')
      .select('current_state, scenario_id')
      .eq('id', sessionId)
      .single();

    if (!session) {
      logger.warn({ sessionId }, 'Session not found for state update');
      return;
    }

    const currentState: ScenarioState = (session.current_state as ScenarioState) || {};

    // Update state based on decision type
    switch (decision.decision_type) {
      case 'operational_action': {
        // Check if it's an evacuation order
        if (
          decision.title.toLowerCase().includes('evacuation') ||
          decision.description.toLowerCase().includes('evacuation')
        ) {
          // Extract evacuation zone details from decision
          const radiusMatch = decision.description.match(/(\d+)\s*m(?:eter)?s?/i);
          const radius = radiusMatch ? parseInt(radiusMatch[1], 10) : 500; // Default 500m

          // Try to extract location from decision or use default (Suntec City)
          const lat = 1.2931; // Suntec City default
          const lng = 103.8558;

          const evacuationZone = {
            id: `evac-${Date.now()}`,
            center_lat: lat,
            center_lng: lng,
            radius_meters: radius,
            title: decision.title,
            created_at: new Date().toISOString(),
          };

          if (!currentState.evacuation_zones) {
            currentState.evacuation_zones = [];
          }
          currentState.evacuation_zones.push(evacuationZone);

          logger.info(
            { sessionId, decisionId: decision.id, zone: evacuationZone },
            'Evacuation zone added to state',
          );
        }
        break;
      }

      case 'resource_allocation': {
        // Update resource allocations
        if (decision.resources_needed) {
          if (!currentState.resource_allocations) {
            currentState.resource_allocations = {};
          }
          Object.assign(currentState.resource_allocations, decision.resources_needed);
          logger.info(
            { sessionId, decisionId: decision.id, resources: decision.resources_needed },
            'Resource allocations updated',
          );
        }
        break;
      }

      case 'public_statement': {
        // Update sentiment (will be enhanced in Phase 7)
        if (!currentState.public_sentiment) {
          currentState.public_sentiment = 50; // Neutral starting point
        }
        // Simple sentiment adjustment (will be replaced with AI-based calculation in Phase 7)
        const sentimentChange = decision.description.toLowerCase().includes('reassur') ? 5 : -2;
        currentState.public_sentiment = Math.max(
          0,
          Math.min(100, currentState.public_sentiment + sentimentChange),
        );
        logger.info(
          { sessionId, decisionId: decision.id, newSentiment: currentState.public_sentiment },
          'Public sentiment updated',
        );
        break;
      }

      default:
        logger.debug(
          { sessionId, decisionId: decision.id, decisionType: decision.decision_type },
          'No state update for decision type',
        );
    }

    // Save updated state to session
    const { error: updateError } = await supabaseAdmin
      .from('sessions')
      .update({ current_state: currentState })
      .eq('id', sessionId);

    if (updateError) {
      logger.error({ error: updateError, sessionId }, 'Failed to update session state');
      return;
    }

    // Create state snapshot for history
    await createStateSnapshot(sessionId, currentState, decision.id);

    // Broadcast state update via WebSocket
    getWebSocketService().stateUpdated?.(sessionId, {
      type: 'state.updated',
      state: currentState,
      decision_id: decision.id,
      timestamp: new Date().toISOString(),
    });

    logger.info({ sessionId, decisionId: decision.id }, 'State updated successfully');
  } catch (error) {
    logger.error({ error, sessionId, decisionId: decision.id }, 'Error updating scenario state');
  }
};

/**
 * Create a state snapshot for history tracking
 */
const createStateSnapshot = async (
  sessionId: string,
  state: ScenarioState,
  decisionId: string,
): Promise<void> => {
  try {
    const { error } = await supabaseAdmin.from('scenario_state_history').insert({
      session_id: sessionId,
      state_snapshot: state,
      triggered_by_decision_id: decisionId,
      created_at: new Date().toISOString(),
    });

    if (error) {
      logger.error({ error, sessionId }, 'Failed to create state snapshot');
    } else {
      logger.debug({ sessionId, decisionId }, 'State snapshot created');
    }
  } catch (error) {
    logger.error({ error, sessionId }, 'Error creating state snapshot');
  }
};

/**
 * Phase 3: Update team state (evacuation_state, triage_state, media_state) from an executed decision
 * using AI classification and author team. Called after classifyDecision and storing ai_classification.
 */
export async function updateTeamStateFromDecision(
  sessionId: string,
  _decisionId: string,
  authorTeamNames: string[],
  classification: { categories?: string[]; keywords?: string[]; primary_category?: string },
  elapsedMinutes: number,
): Promise<void> {
  if (!authorTeamNames?.length) return;
  const categories = classification?.categories ?? [];
  const primary = (classification?.primary_category ?? '').toLowerCase();
  const keywords = (classification?.keywords ?? []).map((k) => String(k).toLowerCase());

  const hasCategory = (c: string) => categories.includes(c) || primary === c.toLowerCase();
  const hasKeyword = (...kws: string[]) =>
    kws.some((kw) => keywords.some((k) => k.includes(kw) || kw.includes(k)));

  try {
    const { data: session } = await supabaseAdmin
      .from('sessions')
      .select('current_state')
      .eq('id', sessionId)
      .single();

    if (!session) return;
    const currentState: Record<string, unknown> =
      (session.current_state as Record<string, unknown>) || {};

    const evacuationState = (currentState.evacuation_state as Record<string, unknown>) || {};
    const triageState = (currentState.triage_state as Record<string, unknown>) || {};
    const mediaState = (currentState.media_state as Record<string, unknown>) || {};

    const isEvacuation = authorTeamNames.some((t) => /evacuation/i.test(t));
    const isTriage = authorTeamNames.some((t) => /triage/i.test(t));
    const isMedia = authorTeamNames.some((t) => /media/i.test(t));

    if (isEvacuation) {
      if (
        hasCategory('flow_control') ||
        hasCategory('evacuation_flow_control') ||
        hasKeyword('flow', 'bottleneck', 'stagger', 'egress', 'congestion')
      ) {
        evacuationState.flow_control_decided = true;
      }
      if (
        hasCategory('coordination_order') ||
        hasCategory('coordination') ||
        hasCategory('evacuation_coordination') ||
        hasKeyword('coordinate', 'triage')
      ) {
        evacuationState.coordination_with_triage = true;
      }
    }
    if (isTriage) {
      if (
        hasCategory('supply_management') ||
        hasKeyword('supply', 'request', 'ration', 'equipment', 'shortage')
      ) {
        triageState.supply_request_made = true;
      }
      if (
        hasCategory('prioritisation') ||
        hasCategory('triage_protocol') ||
        hasKeyword('prioritise', 'critical first', 'severity', 'triage protocol')
      ) {
        triageState.prioritisation_decided = true;
      }
      if (hasKeyword('handover', 'transfer', 'hospital', 'ambulance', 'hand over')) {
        const current = Math.max(0, Number(triageState.handed_over_to_hospital) || 0);
        triageState.handed_over_to_hospital = current + 5;
      }
    }
    if (isMedia) {
      if (
        hasCategory('public_statement') ||
        hasKeyword('statement', 'press', 'announce', 'release')
      ) {
        mediaState.first_statement_issued = true;
        mediaState.statement_issued_at_minute = elapsedMinutes;
        mediaState.statements_issued = Math.max(0, Number(mediaState.statements_issued) || 0) + 1;
      }
      if (
        hasCategory('misinformation_management') ||
        hasCategory('misinformation_response') ||
        hasKeyword('debunk', 'counter', 'correct', 'misinformation', 'rumour', 'narrative')
      ) {
        mediaState.misinformation_addressed = true;
        mediaState.misinformation_addressed_count =
          Math.max(0, Number(mediaState.misinformation_addressed_count) || 0) + 1;
      }
    }

    const nextState = {
      ...currentState,
      evacuation_state: evacuationState,
      triage_state: triageState,
      media_state: mediaState,
    };

    const { error } = await supabaseAdmin
      .from('sessions')
      .update({ current_state: nextState })
      .eq('id', sessionId);
    if (error) {
      logger.error({ error, sessionId }, 'Failed to update team state from decision');
      return;
    }
    getWebSocketService().stateUpdated?.(sessionId, {
      type: 'state.updated',
      state: nextState,
      timestamp: new Date().toISOString(),
    });
    logger.debug({ sessionId, authorTeamNames }, 'Team state updated from decision');
  } catch (err) {
    logger.error({ err, sessionId }, 'Error in updateTeamStateFromDecision');
  }
}

/**
 * Get current state for a session
 */
export const getCurrentState = async (sessionId: string): Promise<ScenarioState | null> => {
  try {
    const { data: session } = await supabaseAdmin
      .from('sessions')
      .select('current_state')
      .eq('id', sessionId)
      .single();

    return (session?.current_state as ScenarioState) || null;
  } catch (error) {
    logger.error({ error, sessionId }, 'Error getting current state');
    return null;
  }
};
