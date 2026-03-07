import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { getWebSocketService } from './websocketService.js';

/**
 * Environmental State Service — Step 2
 * Loads a pre-authored environmental seed (one of multiple variants per scenario) from the DB
 * at session start. Writes routes/areas into session.current_state.environmental_state and
 * optional team state (evacuation_state, triage_state, media_state) at top level of current_state.
 * No generation from scratch; all content comes from scenario_environmental_seeds.
 */

/** Facility (hospital/police) in environmental seed areas; constrains decisions when at_capacity. */
export interface EnvironmentalAreaSeed {
  area_id: string;
  label: string;
  type?: 'hospital' | 'police' | 'fire_station';
  at_capacity?: boolean;
  capacity?: number;
  current_load?: number;
  problem?: string;
  active?: boolean;
  managed?: boolean;
  aliases?: string[];
}

/** Team state shapes (optional in seed; written to top-level current_state). */
export interface EvacuationStateSeed {
  exits_congested?: string[];
  flow_control_decided?: boolean;
  coordination_with_triage?: boolean;
  evacuated_count?: number;
  total_evacuees?: number;
}

export interface TriageStateSeed {
  supply_level?: 'adequate' | 'low' | 'critical';
  surge_active?: boolean;
  critical_pending?: number;
  deaths_on_site?: number;
  supply_request_made?: boolean;
  prioritisation_decided?: boolean;
  handed_over_to_hospital?: number;
}

export interface MediaStateSeed {
  first_statement_issued?: boolean;
  statement_issued_at_minute?: number;
  misinformation_addressed?: boolean;
  journalist_arrived?: boolean;
  public_sentiment?: number;
  statements_issued?: number;
  misinformation_addressed_count?: number;
}

export interface EnvironmentalSeedRow {
  id: string;
  scenario_id: string;
  variant_label: string;
  seed_data: {
    routes?: unknown[];
    areas?: EnvironmentalAreaSeed[];
    evacuation_state?: EvacuationStateSeed;
    triage_state?: TriageStateSeed;
    media_state?: MediaStateSeed;
  };
}

/** Default team state when seed does not provide it. */
const DEFAULT_EVACUATION_STATE: EvacuationStateSeed = {
  flow_control_decided: false,
  coordination_with_triage: false,
  exits_congested: [],
  evacuated_count: 0,
  total_evacuees: 1000,
};

const DEFAULT_TRIAGE_STATE: TriageStateSeed = {
  supply_level: 'adequate',
  surge_active: false,
  prioritisation_decided: false,
  supply_request_made: false,
  deaths_on_site: 0,
  critical_pending: 0,
  handed_over_to_hospital: 0,
};

const DEFAULT_MEDIA_STATE: MediaStateSeed = {
  first_statement_issued: false,
  misinformation_addressed: false,
  journalist_arrived: false,
  statements_issued: 0,
  misinformation_addressed_count: 0,
};

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
    const seed = chosen.seed_data ?? {};
    const currentState = (session.current_state as Record<string, unknown>) || {};

    const nextState: Record<string, unknown> = {
      ...currentState,
      environmental_state: {
        routes: seed.routes ?? [],
        areas: seed.areas ?? [],
      },
      evacuation_state: { ...DEFAULT_EVACUATION_STATE, ...seed.evacuation_state },
      triage_state: { ...DEFAULT_TRIAGE_STATE, ...seed.triage_state },
      media_state: { ...DEFAULT_MEDIA_STATE, ...seed.media_state },
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
