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
