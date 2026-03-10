-- C2E: Condition-driven inject asking Triage team what equipment they need.
-- Fires when triage zone is established but no supply/equipment decision has been made.

DO $$
DECLARE
  scenario_uuid UUID;
BEGIN
  SELECT id INTO scenario_uuid
  FROM scenarios
  WHERE title = 'C2E Bombing at Community Event'
  LIMIT 1;

  IF scenario_uuid IS NULL THEN
    RAISE NOTICE '102: C2E Bombing scenario not found; skipping.';
    RETURN;
  END IF;

  INSERT INTO scenario_injects (
    scenario_id, trigger_time_minutes, conditions_to_appear, conditions_to_cancel,
    eligible_after_minutes, type, title, content, severity,
    inject_scope, target_teams, requires_response, requires_coordination
  )
  SELECT
    scenario_uuid, NULL,
    '{"all": ["triage_zone_established_as_incident_location", "triage_no_supply_management_decision"]}'::jsonb,
    '["triage_supply_request_made"]'::jsonb,
    5,
    'field_update',
    'Coordination centre: What equipment do you need for triage?',
    'The coordination centre is preparing to source medical supplies. Before casualties arrive in large numbers: what equipment and supplies do you need for the triage site? Specify your minimum triage kit (e.g. triage tags, tourniquets, airway kits, oxygen, IV fluids, stretchers, trauma kits).',
    'medium',
    'team_specific', ARRAY['triage'], true, false
  WHERE NOT EXISTS (
    SELECT 1 FROM scenario_injects
    WHERE scenario_id = scenario_uuid AND title = 'Coordination centre: What equipment do you need for triage?'
  );

  RAISE NOTICE '102: Added condition-driven triage equipment request inject.';
END $$;
