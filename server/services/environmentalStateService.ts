import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { getWebSocketService } from './websocketService.js';
import type { CounterDefinition } from '../counterDefinitions.js';

/**
 * Environmental State Service
 * Initializes team state containers and counter_definitions at session start.
 * Seeds are no longer generated; counters are derived live from scenario_casualties/hazards.
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
  patients_being_treated?: number;
  patients_waiting?: number;
  casualties?: number;
  /** If set, used as pool cap for rate-based triage counters; else derived from total_evacuees * 0.25. */
  initial_patients_at_site?: number;
}

export interface MediaStateSeed {
  first_statement_issued?: boolean;
  statement_issued_at_minute?: number;
  misinformation_addressed?: boolean;
  journalist_arrived?: boolean;
  public_sentiment?: number;
  statements_issued?: number;
  misinformation_addressed_count?: number;
  sentiment_label?: string;
  sentiment_reason?: string;
  robustness_boost?: number;
  spokesperson_designated?: boolean;
  victim_dignity_respected?: boolean;
  regular_updates_planned?: boolean;
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
    [key: string]: unknown;
  };
}

/** Map team name to current_state key. */
function teamToStateKey(teamName: string): string {
  const n = (teamName ?? '').toLowerCase();
  if (/evacuation|evac/.test(n)) return 'evacuation_state';
  if (/triage/.test(n)) return 'triage_state';
  if (/media/.test(n)) return 'media_state';
  return `${n.replace(/\s+/g, '_')}_state`;
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
  patients_being_treated: 0,
  patients_waiting: 0,
  casualties: 0,
};

const DEFAULT_MEDIA_STATE: MediaStateSeed = {
  first_statement_issued: false,
  misinformation_addressed: false,
  journalist_arrived: false,
  statements_issued: 0,
  misinformation_addressed_count: 0,
  robustness_boost: 0,
};

/** Default states for non-MCI team archetypes. Spread with seed values so richer seeds override. */
const DEFAULT_POLICE_STATE: Record<string, unknown> = {
  perimeter_established: false,
  tactical_team_ready: false,
  armed_units: 0,
  inner_cordon_radius_m: 200,
};

const DEFAULT_NEGOTIATION_STATE: Record<string, unknown> = {
  contact_established: false,
  demands_received: false,
  active_session: false,
  sessions_count: 0,
  last_contact_minutes_ago: null,
};

const DEFAULT_INTELLIGENCE_STATE: Record<string, unknown> = {
  hostage_count_confirmed: null,
  threat_level: 'high',
  perpetrator_count_known: false,
  inside_intel: false,
};

const DEFAULT_FIRE_STATE: Record<string, unknown> = {
  fire_contained: false,
  entry_safe: false,
  units_deployed: 0,
  hotspots: [],
};

/**
 * Initialize team state containers, counter_definitions, and environmental
 * route/area seeds at session start.
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

    const currentState = (session.current_state as Record<string, unknown>) || {};

    const { data: scenarioTeams } = await supabaseAdmin
      .from('scenario_teams')
      .select('team_name, counter_definitions')
      .eq('scenario_id', scenarioId);

    interface ScenarioTeamRow {
      team_name: string;
      counter_definitions?: CounterDefinition[] | null;
    }
    const teamRows = (scenarioTeams ?? []) as ScenarioTeamRow[];

    const nextState: Record<string, unknown> = { ...currentState };

    const teamsToInit: ScenarioTeamRow[] =
      teamRows.length > 0
        ? teamRows
        : [
            { team_name: 'Evacuation', counter_definitions: null },
            { team_name: 'Medical Triage', counter_definitions: null },
            { team_name: 'Media', counter_definitions: null },
          ];

    for (const teamRow of teamsToInit) {
      const stateKey = teamToStateKey(teamRow.team_name);
      const defs = teamRow.counter_definitions;

      if (defs && Array.isArray(defs) && defs.length > 0) {
        const teamState: Record<string, unknown> = {};
        for (const def of defs) {
          const iv = def.initial_value;
          teamState[def.key] =
            iv != null && typeof iv === 'object'
              ? def.type === 'number'
                ? 0
                : def.type === 'boolean'
                  ? false
                  : ''
              : iv;
        }
        nextState[stateKey] = teamState;
      } else {
        if (stateKey === 'evacuation_state') {
          nextState.evacuation_state = { ...DEFAULT_EVACUATION_STATE };
        } else if (stateKey === 'triage_state') {
          nextState.triage_state = { ...DEFAULT_TRIAGE_STATE };
        } else if (stateKey === 'media_state') {
          nextState.media_state = { ...DEFAULT_MEDIA_STATE };
        } else if (stateKey === 'police_state') {
          nextState.police_state = { ...DEFAULT_POLICE_STATE };
        } else if (stateKey === 'negotiation_state') {
          nextState.negotiation_state = { ...DEFAULT_NEGOTIATION_STATE };
        } else if (stateKey === 'intelligence_state') {
          nextState.intelligence_state = { ...DEFAULT_INTELLIGENCE_STATE };
        } else if (stateKey === 'fire_state') {
          nextState.fire_state = { ...DEFAULT_FIRE_STATE };
        } else {
          nextState[stateKey] = {};
        }
      }
    }

    const counterDefsMap: Record<string, CounterDefinition[]> = {};
    for (const teamRow of teamsToInit) {
      if (teamRow.counter_definitions?.length) {
        const stateKey = teamToStateKey(teamRow.team_name);
        counterDefsMap[stateKey] = teamRow.counter_definitions;
      }
    }
    if (Object.keys(counterDefsMap).length > 0) {
      nextState._counter_definitions = counterDefsMap;
    }

    // Load route locations from scenario_locations into session environmental_state
    const { data: routeLocations } = await supabaseAdmin
      .from('scenario_locations')
      .select('label, conditions')
      .eq('scenario_id', scenarioId)
      .eq('location_type', 'route');

    if (routeLocations && routeLocations.length > 0) {
      const routes = routeLocations.map((r) => {
        const c = (r.conditions ?? {}) as Record<string, unknown>;
        return {
          route_id: c.route_id ?? '',
          label: r.label,
          travel_time_minutes: c.travel_time_minutes ?? null,
          problem: c.problem ?? null,
          managed: c.managed ?? true,
          connects_to: c.connects_to ?? [],
          is_optimal_for: c.is_optimal_for ?? [],
          highway_type: c.highway_type,
          geometry: c.geometry,
        };
      });

      const envState = (nextState.environmental_state as Record<string, unknown>) ?? {};
      nextState.environmental_state = { ...envState, routes };

      logger.info(
        { sessionId, routes: routes.length },
        'Route locations loaded into environmental state',
      );
    }

    const { error: updateError } = await supabaseAdmin
      .from('sessions')
      .update({ current_state: nextState })
      .eq('id', sessionId);

    if (updateError) {
      logger.error(
        { sessionId, error: updateError },
        'Failed to write initial team state to session',
      );
      return;
    }

    logger.info(
      { sessionId, scenarioId, teams: teamsToInit.length },
      'Team and environmental state initialized',
    );

    getWebSocketService().stateUpdated?.(sessionId, {
      state: nextState,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    logger.error({ err, sessionId }, 'Error in loadAndApplyEnvironmentalState');
  }
}
