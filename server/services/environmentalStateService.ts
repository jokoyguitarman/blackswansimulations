import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { getWebSocketService } from './websocketService.js';

/**
 * Environmental State Service — Step 2
 * Loads a pre-authored environmental seed (one of multiple variants per scenario) from the DB
 * at session start and writes it into session.current_state.environmental_state.
 * No generation from scratch; all content comes from scenario_environmental_seeds.
 */

export interface EnvironmentalSeedRow {
  id: string;
  scenario_id: string;
  variant_label: string;
  seed_data: { routes?: unknown[]; areas?: unknown[] };
}

/**
 * Load environmental seed variants for the session's scenario, pick one (at random),
 * merge into current_state.environmental_state, persist and broadcast.
 * No-op if the scenario has no seeds.
 */
export async function loadAndApplyEnvironmentalState(sessionId: string): Promise<void> {
  try {
    const { data: session, error: sessionError } = await supabaseAdmin
      .from('sessions')
      .select('id, scenario_id, current_state')
      .eq('id', sessionId)
      .single();

    if (sessionError || !session) {
      logger.warn({ sessionId, error: sessionError }, 'Session not found for environmental state');
      return;
    }

    const scenarioId = session.scenario_id as string;
    if (!scenarioId) {
      logger.warn({ sessionId }, 'Session has no scenario_id');
      return;
    }

    // Fetch all variants for this scenario; pick one at random (no ORDER BY RANDOM() in client)
    const { data: allSeeds, error: allSeedsError } = await supabaseAdmin
      .from('scenario_environmental_seeds')
      .select('id, scenario_id, variant_label, seed_data')
      .eq('scenario_id', scenarioId);

    if (allSeedsError || !allSeeds?.length) {
      logger.debug({ sessionId, scenarioId }, 'No environmental seeds for scenario; skipping');
      return;
    }

    const chosen = allSeeds[Math.floor(Math.random() * allSeeds.length)] as EnvironmentalSeedRow;
    const currentState = (session.current_state as Record<string, unknown>) || {};

    const nextState: Record<string, unknown> = {
      ...currentState,
      environmental_state: chosen.seed_data ?? {},
      environmental_variant: chosen.variant_label,
    };

    const { error: updateError } = await supabaseAdmin
      .from('sessions')
      .update({ current_state: nextState })
      .eq('id', sessionId);

    if (updateError) {
      logger.error(
        { sessionId, error: updateError },
        'Failed to write environmental state to session',
      );
      return;
    }

    logger.info(
      { sessionId, scenarioId, variant: chosen.variant_label },
      'Environmental state loaded and applied',
    );

    getWebSocketService().stateUpdated?.(sessionId, {
      state: nextState,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    logger.error({ err, sessionId }, 'Error in loadAndApplyEnvironmentalState');
  }
}
