-- Phase 4: State effects on time-based C2E injects + condition-driven injects for Evacuation, Triage, Media.
-- (A) UPDATE "Journalist Arrives" to set media_state.journalist_arrived when published.
-- (B) INSERT time-based "Patient surge at triage site" with state_effect triage_state.surge_active.
-- (C–E) INSERT condition-driven injects using Phase 2 condition keys.
-- See docs/CONDITION_INJECT_DATA_MODEL.md and plan Phase 4.

DO $$
DECLARE
  scenario_uuid UUID;
BEGIN
  SELECT id INTO scenario_uuid
  FROM scenarios
  WHERE title = 'C2E Bombing at Community Event'
  LIMIT 1;

  IF scenario_uuid IS NULL THEN
    RAISE NOTICE '077: C2E Bombing scenario not found; skipping.';
    RETURN;
  END IF;

  -- -------------------------------------------------------------------------
  -- A: Journalist Arrives (T+12) – set media_state.journalist_arrived on publish
  -- -------------------------------------------------------------------------
  UPDATE scenario_injects
  SET state_effect = '{"media_state": {"journalist_arrived": true}}'::jsonb
  WHERE scenario_id = scenario_uuid AND title = 'Journalist Arrives';

  -- -------------------------------------------------------------------------
  -- B: Patient surge at triage site (T+8) – sets triage_state.surge_active
  -- -------------------------------------------------------------------------
  INSERT INTO scenario_injects (
    scenario_id, trigger_time_minutes, type, title, content, severity,
    affected_roles, inject_scope, target_teams, requires_response, requires_coordination,
    state_effect
  )
  SELECT
    scenario_uuid, 8, 'field_update',
    'Patient surge at triage site',
    'A sudden influx of casualties is overwhelming the triage area. Multiple serious injuries are arriving at once. Medical lead reports that without a clear prioritisation protocol, the team is struggling to allocate limited resources. Families are demanding attention.',
    'high',
    '[]'::jsonb, 'team_specific', ARRAY['triage'], true, true,
    '{"triage_state": {"surge_active": true}}'::jsonb
  WHERE NOT EXISTS (
    SELECT 1 FROM scenario_injects
    WHERE scenario_id = scenario_uuid AND title = 'Patient surge at triage site'
  );

  -- -------------------------------------------------------------------------
  -- C: Evacuation – exit bottleneck / flow control; coordination (optional)
  -- -------------------------------------------------------------------------
  INSERT INTO scenario_injects (
    scenario_id, trigger_time_minutes, conditions_to_appear, conditions_to_cancel,
    eligible_after_minutes, type, title, content, severity,
    affected_roles, inject_scope, target_teams, requires_response, requires_coordination
  )
  SELECT
    scenario_uuid, NULL,
    '{"all": ["evacuation_exit_bottleneck_active", "evacuation_no_flow_control_decision"]}'::jsonb,
    '["evacuation_flow_control_decided"]'::jsonb,
    8, 'field_update',
    'Exit bottleneck – flow control needed',
    'Congestion at the exit is worsening. Crowds are bunching and there is a risk of crush or stampede. Evacuation lead reports that without a clear flow-control or staggered-egress decision, the bottleneck cannot be safely managed. Coordination with triage on priority cases is also lacking.',
    'high',
    '[]'::jsonb, 'team_specific', ARRAY['evacuation'], true, true
  WHERE NOT EXISTS (
    SELECT 1 FROM scenario_injects
    WHERE scenario_id = scenario_uuid AND title = 'Exit bottleneck – flow control needed'
  );

  INSERT INTO scenario_injects (
    scenario_id, trigger_time_minutes, conditions_to_appear, conditions_to_cancel,
    eligible_after_minutes, type, title, content, severity,
    affected_roles, inject_scope, target_teams, requires_response, requires_coordination
  )
  SELECT
    scenario_uuid, NULL,
    '{"all": ["evacuation_exit_bottleneck_active", "evacuation_coordination_not_established"]}'::jsonb,
    '["evacuation_coordination_established"]'::jsonb,
    10, 'field_update',
    'Coordination with triage not established',
    'Evacuation and medical teams are operating in silos. Critical patients are not being prioritised at the exit. Evacuation lead reports that no formal coordination with triage has been established, leading to delays and confusion.',
    'medium',
    '[]'::jsonb, 'team_specific', ARRAY['evacuation'], true, true
  WHERE NOT EXISTS (
    SELECT 1 FROM scenario_injects
    WHERE scenario_id = scenario_uuid AND title = 'Coordination with triage not established'
  );

  -- -------------------------------------------------------------------------
  -- D: Triage – supply crisis; surge prioritisation warning (pressure only)
  -- -------------------------------------------------------------------------
  INSERT INTO scenario_injects (
    scenario_id, trigger_time_minutes, conditions_to_appear, conditions_to_cancel,
    eligible_after_minutes, type, title, content, severity,
    affected_roles, inject_scope, target_teams, requires_response, requires_coordination,
    objective_penalty
  )
  SELECT
    scenario_uuid, NULL,
    '{"all": ["triage_supply_critical", "triage_no_supply_management_decision"]}'::jsonb,
    '["triage_supply_request_made"]'::jsonb,
    10, 'field_update',
    'Supply crisis at triage',
    'Medical supplies at the triage site are critically low. Without a supply request or rationing decision, the team cannot sustain care for incoming casualties. Equipment and consumables are running out.',
    'critical',
    '[]'::jsonb, 'team_specific', ARRAY['triage'], true, true,
    '{"objective_id": "triage", "reason": "Supply crisis", "points": 20}'::jsonb
  WHERE NOT EXISTS (
    SELECT 1 FROM scenario_injects
    WHERE scenario_id = scenario_uuid AND title = 'Supply crisis at triage'
  );

  INSERT INTO scenario_injects (
    scenario_id, trigger_time_minutes, conditions_to_appear, conditions_to_cancel,
    eligible_after_minutes, type, title, content, severity,
    affected_roles, inject_scope, target_teams, requires_response, requires_coordination
  )
  SELECT
    scenario_uuid, NULL,
    '{"all": ["triage_surge_active", "triage_no_prioritisation_decision"]}'::jsonb,
    '["triage_prioritisation_decided"]'::jsonb,
    8, 'field_update',
    'Surge – prioritisation needed',
    'The triage area is under surge pressure. Multiple critical patients need decisions on who is treated first. Without a clear prioritisation protocol (e.g. critical first, severity-based), the team cannot allocate limited resources effectively. Establish a prioritisation decision to avoid deterioration and deaths on site.',
    'high',
    '[]'::jsonb, 'team_specific', ARRAY['triage'], true, true
  WHERE NOT EXISTS (
    SELECT 1 FROM scenario_injects
    WHERE scenario_id = scenario_uuid AND title = 'Surge – prioritisation needed'
  );

  -- -------------------------------------------------------------------------
  -- E: Media – no statement by T+12; misinformation still unaddressed (optional)
  -- -------------------------------------------------------------------------
  INSERT INTO scenario_injects (
    scenario_id, trigger_time_minutes, conditions_to_appear, conditions_to_cancel,
    eligible_after_minutes, type, title, content, severity,
    affected_roles, inject_scope, target_teams, requires_response, requires_coordination
  )
  SELECT
    scenario_uuid, NULL,
    '{"all": ["media_no_statement_by_T12"]}'::jsonb,
    '["media_statement_issued"]'::jsonb,
    12, 'media_report',
    'No official statement by T+12',
    'Twelve minutes have passed with no official public statement from the response. The information vacuum is being filled by speculation and viral misinformation. Journalists and the public are demanding an official response. Delays in issuing a statement are damaging credibility and allowing false narratives to spread.',
    'high',
    '[]'::jsonb, 'team_specific', ARRAY['media'], true, true
  WHERE NOT EXISTS (
    SELECT 1 FROM scenario_injects
    WHERE scenario_id = scenario_uuid AND title = 'No official statement by T+12'
  );

  INSERT INTO scenario_injects (
    scenario_id, trigger_time_minutes, conditions_to_appear, conditions_to_cancel,
    eligible_after_minutes, type, title, content, severity,
    affected_roles, inject_scope, target_teams, requires_response, requires_coordination
  )
  SELECT
    scenario_uuid, NULL,
    '{"threshold": 2, "conditions": ["media_misinformation_not_addressed", "prior_social_media_rumour_inject_fired"]}'::jsonb,
    '[]'::jsonb,
    15, 'media_report',
    'Misinformation still unaddressed',
    'Rumours and false narratives about the incident have been circulating. The Media team has not yet addressed or countered this misinformation. Community tensions and public confusion are rising. An official correction or debunking is needed.',
    'high',
    '[]'::jsonb, 'team_specific', ARRAY['media'], true, true
  WHERE NOT EXISTS (
    SELECT 1 FROM scenario_injects
    WHERE scenario_id = scenario_uuid AND title = 'Misinformation still unaddressed'
  );

  RAISE NOTICE '077: C2E Phase 4 state effects and condition-driven injects applied.';
END $$;
