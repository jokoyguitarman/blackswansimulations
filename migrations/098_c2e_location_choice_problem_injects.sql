-- C2E: Location-choice problem injects — in-world consequences when players choose poor triage or evac locations.
-- Run after 077, 097. Condition keys implemented in conditionEvaluatorService.
-- Each inject has requires_response: true for pathway outcomes and robustness band selection.

DO $$
DECLARE
  scenario_uuid UUID;
BEGIN
  SELECT id INTO scenario_uuid
  FROM scenarios
  WHERE title = 'C2E Bombing at Community Event'
  LIMIT 1;

  IF scenario_uuid IS NULL THEN
    RAISE NOTICE '098: C2E Bombing scenario not found; skipping.';
    RETURN;
  END IF;

  -- Triage: unsuitable zone
  INSERT INTO scenario_injects (
    scenario_id, trigger_time_minutes, conditions_to_appear, conditions_to_cancel,
    eligible_after_minutes, type, title, content, severity,
    affected_roles, inject_scope, target_teams, requires_response, requires_coordination
  )
  SELECT
    scenario_uuid, NULL,
    '{"all": ["triage_zone_unsuitable"]}'::jsonb,
    '[]'::jsonb,
    3, 'field_update',
    'Smoke drift affecting triage area',
    'Staff and patients reporting respiratory irritation at the triage site. Consider relocation or protective equipment.',
    'high',
    '[]'::jsonb, 'team_specific', ARRAY['triage'], true, false
  WHERE NOT EXISTS (
    SELECT 1 FROM scenario_injects
    WHERE scenario_id = scenario_uuid AND title = 'Smoke drift affecting triage area'
  );

  -- Triage: no water
  INSERT INTO scenario_injects (
    scenario_id, trigger_time_minutes, conditions_to_appear, conditions_to_cancel,
    eligible_after_minutes, type, title, content, severity,
    affected_roles, inject_scope, target_teams, requires_response, requires_coordination
  )
  SELECT
    scenario_uuid, NULL,
    '{"all": ["triage_zone_no_water"]}'::jsonb,
    '[]'::jsonb,
    3, 'field_update',
    'Water shortage at triage',
    'Staff requesting portable water supply for wound cleaning and hydration.',
    'medium',
    '[]'::jsonb, 'team_specific', ARRAY['triage'], true, false
  WHERE NOT EXISTS (
    SELECT 1 FROM scenario_injects
    WHERE scenario_id = scenario_uuid AND title = 'Water shortage at triage'
  );

  -- Triage: no power
  INSERT INTO scenario_injects (
    scenario_id, trigger_time_minutes, conditions_to_appear, conditions_to_cancel,
    eligible_after_minutes, type, title, content, severity,
    affected_roles, inject_scope, target_teams, requires_response, requires_coordination
  )
  SELECT
    scenario_uuid, NULL,
    '{"all": ["triage_zone_no_power"]}'::jsonb,
    '[]'::jsonb,
    5, 'field_update',
    'Triage site losing light',
    'As dusk approaches, lighting is inadequate. Need generator or emergency lighting.',
    'medium',
    '[]'::jsonb, 'team_specific', ARRAY['triage'], true, false
  WHERE NOT EXISTS (
    SELECT 1 FROM scenario_injects
    WHERE scenario_id = scenario_uuid AND title = 'Triage site losing light'
  );

  -- Triage: small capacity
  INSERT INTO scenario_injects (
    scenario_id, trigger_time_minutes, conditions_to_appear, conditions_to_cancel,
    eligible_after_minutes, type, title, content, severity,
    affected_roles, inject_scope, target_teams, requires_response, requires_coordination
  )
  SELECT
    scenario_uuid, NULL,
    '{"all": ["triage_zone_small_capacity"]}'::jsonb,
    '[]'::jsonb,
    4, 'field_update',
    'Patient overflow at triage site',
    'Stretchers lining the corridor. Staff requesting overflow area or secondary triage zone.',
    'high',
    '[]'::jsonb, 'team_specific', ARRAY['triage'], true, false
  WHERE NOT EXISTS (
    SELECT 1 FROM scenario_injects
    WHERE scenario_id = scenario_uuid AND title = 'Patient overflow at triage site'
  );

  -- Triage: close to blast
  INSERT INTO scenario_injects (
    scenario_id, trigger_time_minutes, conditions_to_appear, conditions_to_cancel,
    eligible_after_minutes, type, title, content, severity,
    affected_roles, inject_scope, target_teams, requires_response, requires_coordination
  )
  SELECT
    scenario_uuid, NULL,
    '{"all": ["triage_zone_close_to_blast"]}'::jsonb,
    '[]'::jsonb,
    3, 'field_update',
    'Evacuees anxious near blast zone',
    'Families at the triage site requesting to move further from the blast area.',
    'medium',
    '[]'::jsonb, 'team_specific', ARRAY['triage'], true, false
  WHERE NOT EXISTS (
    SELECT 1 FROM scenario_injects
    WHERE scenario_id = scenario_uuid AND title = 'Evacuees anxious near blast zone'
  );

  -- Evac: small capacity
  INSERT INTO scenario_injects (
    scenario_id, trigger_time_minutes, conditions_to_appear, conditions_to_cancel,
    eligible_after_minutes, type, title, content, severity,
    affected_roles, inject_scope, target_teams, requires_response, requires_coordination
  )
  SELECT
    scenario_uuid, NULL,
    '{"all": ["evac_holding_small_capacity"]}'::jsonb,
    '[]'::jsonb,
    4, 'field_update',
    'Assembly area overcrowded',
    'Evacuees spilling onto adjacent streets. Marshals requesting overflow staging or secondary holding zone.',
    'high',
    '[]'::jsonb, 'team_specific', ARRAY['evacuation'], true, false
  WHERE NOT EXISTS (
    SELECT 1 FROM scenario_injects
    WHERE scenario_id = scenario_uuid AND title = 'Assembly area overcrowded'
  );

  -- Evac: no water
  INSERT INTO scenario_injects (
    scenario_id, trigger_time_minutes, conditions_to_appear, conditions_to_cancel,
    eligible_after_minutes, type, title, content, severity,
    affected_roles, inject_scope, target_teams, requires_response, requires_coordination
  )
  SELECT
    scenario_uuid, NULL,
    '{"all": ["evac_holding_no_water"]}'::jsonb,
    '[]'::jsonb,
    3, 'field_update',
    'Water shortage at assembly area',
    'Evacuees requesting supplies. Risk of dehydration.',
    'medium',
    '[]'::jsonb, 'team_specific', ARRAY['evacuation'], true, false
  WHERE NOT EXISTS (
    SELECT 1 FROM scenario_injects
    WHERE scenario_id = scenario_uuid AND title = 'Water shortage at assembly area'
  );

  -- Evac: no cover
  INSERT INTO scenario_injects (
    scenario_id, trigger_time_minutes, conditions_to_appear, conditions_to_cancel,
    eligible_after_minutes, type, title, content, severity,
    affected_roles, inject_scope, target_teams, requires_response, requires_coordination
  )
  SELECT
    scenario_uuid, NULL,
    '{"all": ["evac_holding_no_cover"]}'::jsonb,
    '[]'::jsonb,
    4, 'field_update',
    'Evacuees exposed to elements',
    'Multiple reports of heat exhaustion. Requesting shade, water, or relocation.',
    'medium',
    '[]'::jsonb, 'team_specific', ARRAY['evacuation'], true, false
  WHERE NOT EXISTS (
    SELECT 1 FROM scenario_injects
    WHERE scenario_id = scenario_uuid AND title = 'Evacuees exposed to elements'
  );

  RAISE NOTICE '098: C2E location-choice problem injects inserted.';
END $$;
