-- C2E Bombing: add evacuation_state, triage_state, media_state to scenario_environmental_seeds.
-- Run after 068. Merges team state into seed_data so session start writes them to current_state top level.
-- See docs/SESSION_STATE_SHAPE.md and server/services/environmentalStateService.ts.

DO $$
DECLARE
  scenario_uuid UUID;
BEGIN
  SELECT id INTO scenario_uuid
  FROM scenarios
  WHERE title = 'C2E Bombing at Community Event'
  LIMIT 1;

  IF scenario_uuid IS NULL THEN
    RAISE NOTICE '075: C2E Bombing scenario not found; skipping.';
    RETURN;
  END IF;

  -- all_clear: default team state
  UPDATE scenario_environmental_seeds
  SET seed_data = seed_data || '{
    "evacuation_state": {
      "flow_control_decided": false,
      "coordination_with_triage": false,
      "exits_congested": []
    },
    "triage_state": {
      "supply_level": "adequate",
      "surge_active": false,
      "prioritisation_decided": false,
      "supply_request_made": false,
      "deaths_on_site": 0,
      "critical_pending": 0
    },
    "media_state": {
      "first_statement_issued": false,
      "misinformation_addressed": false,
      "journalist_arrived": false
    }
  }'::jsonb
  WHERE scenario_id = scenario_uuid AND variant_label = 'all_clear';

  -- north_congested: West exit congested (align with 064 exit conditions)
  UPDATE scenario_environmental_seeds
  SET seed_data = seed_data || '{
    "evacuation_state": {
      "flow_control_decided": false,
      "coordination_with_triage": false,
      "exits_congested": ["West exit"]
    },
    "triage_state": {
      "supply_level": "adequate",
      "surge_active": false,
      "prioritisation_decided": false,
      "supply_request_made": false,
      "deaths_on_site": 0,
      "critical_pending": 0
    },
    "media_state": {
      "first_statement_issued": false,
      "misinformation_addressed": false,
      "journalist_arrived": false
    }
  }'::jsonb
  WHERE scenario_id = scenario_uuid AND variant_label = 'north_congested';

  -- service_road_blocked: triage supply starts low for variety
  UPDATE scenario_environmental_seeds
  SET seed_data = seed_data || '{
    "evacuation_state": {
      "flow_control_decided": false,
      "coordination_with_triage": false,
      "exits_congested": []
    },
    "triage_state": {
      "supply_level": "low",
      "surge_active": false,
      "prioritisation_decided": false,
      "supply_request_made": false,
      "deaths_on_site": 0,
      "critical_pending": 0
    },
    "media_state": {
      "first_statement_issued": false,
      "misinformation_addressed": false,
      "journalist_arrived": false
    }
  }'::jsonb
  WHERE scenario_id = scenario_uuid AND variant_label = 'service_road_blocked';

  RAISE NOTICE '075: C2E team state (evacuation_state, triage_state, media_state) merged into scenario_environmental_seeds.';
END $$;
