-- C2E: Second device (second bomb) outcomes — found/defused, detonation (area populated vs area cleared).
-- Run after 062, 055, 056, demo/seed_c2e_gates_and_insider.sql. Idempotent.
-- See docs/INJECT_ENGINE_DEVELOPMENT_PLAN.md (Type A/B) and GAME_SPECIFICS_AND_LOCATIONS.md.
--
-- Outcomes:
-- 1. Positive: Second device found and defused (gate second_device_defused → if_met inject).
-- 2. Bad: Second device detonates with area still populated (additional casualties).
-- 3. Acceptable: Second device detonates after area cleared (no additional casualties).
-- Not a strict win/lose: explosion after area cleared is tolerable.

DO $$
DECLARE
  scenario_uuid UUID;
  inj_found_defused_id UUID;
  gate_second_device_id UUID;
BEGIN
  SELECT id INTO scenario_uuid
  FROM scenarios
  WHERE title = 'C2E Bombing at Community Event'
  LIMIT 1;

  IF scenario_uuid IS NULL THEN
    RAISE NOTICE '073: C2E Bombing scenario not found; skipping second-device outcomes.';
    RETURN;
  END IF;

  -- -------------------------------------------------------------------------
  -- 1. Inject: Second device found and defused (published when gate is met)
  -- -------------------------------------------------------------------------
  INSERT INTO scenario_injects (
    scenario_id, trigger_time_minutes, type, title, content, severity,
    affected_roles, inject_scope, target_teams, requires_response, requires_coordination
  )
  SELECT scenario_uuid, NULL, 'field_update',
    'Second device found and defused',
    'A second device has been located and safely neutralised. The area is now clear of that threat. No detonation occurred.',
    'medium',
    '[]'::jsonb, 'universal', NULL, false, false
  WHERE NOT EXISTS (
    SELECT 1 FROM scenario_injects
    WHERE scenario_id = scenario_uuid AND title = 'Second device found and defused'
  )
  RETURNING id INTO inj_found_defused_id;

  IF inj_found_defused_id IS NULL THEN
    SELECT id INTO inj_found_defused_id FROM scenario_injects
    WHERE scenario_id = scenario_uuid AND title = 'Second device found and defused' LIMIT 1;
  END IF;

  -- -------------------------------------------------------------------------
  -- 2. Gate: second_device_defused — met when teams find and defuse the device
  -- -------------------------------------------------------------------------
  INSERT INTO scenario_gates (
    scenario_id, gate_id, gate_order, check_at_minutes, condition,
    if_not_met_inject_ids, if_met_inject_id
  ) VALUES (
    scenario_uuid,
    'second_device_defused',
    10,
    20,
    '{"team": "evacuation", "decision_types": ["operational_plan", "resource_allocation", "emergency_declaration"], "content_hints": ["second device", "defuse", "defused", "found", "neutralise", "neutralize", "bomb", "suspicious package", "suspicious bag", "exit B", "backpack", "secure", "suspicious individual"], "min_hints": 1}'::jsonb,
    ARRAY[]::UUID[],
    inj_found_defused_id
  )
  ON CONFLICT (scenario_id, gate_id) DO UPDATE SET
    check_at_minutes = EXCLUDED.check_at_minutes,
    condition = EXCLUDED.condition,
    if_met_inject_id = EXCLUDED.if_met_inject_id;

  SELECT id INTO gate_second_device_id
  FROM scenario_gates
  WHERE scenario_id = scenario_uuid AND gate_id = 'second_device_defused' LIMIT 1;

  -- -------------------------------------------------------------------------
  -- 3. Condition-driven inject: Second device detonates (area still populated)
  --    Type A–style: opportunity / late response. Cancelled if gate second_device_defused met.
  -- -------------------------------------------------------------------------
  INSERT INTO scenario_injects (
    scenario_id, trigger_time_minutes, type, title, content, severity,
    affected_roles, inject_scope, target_teams, requires_response, requires_coordination,
    conditions_to_appear, conditions_to_cancel, eligible_after_minutes
  )
  SELECT scenario_uuid, NULL, 'field_update',
    'Second device detonates (area populated)',
    'A second device has detonated. The blast occurred in an area that had not been fully cleared. Additional casualties and injuries are reported. Panic and confusion have intensified. Emergency services are still en route.',
    'critical',
    '[]'::jsonb, 'universal', NULL, true, true,
    '{"all": ["gate_not_met:second_device_defused", "area_not_cleared"]}'::jsonb,
    '["gate_met:second_device_defused"]'::jsonb,
    20
  WHERE NOT EXISTS (
    SELECT 1 FROM scenario_injects
    WHERE scenario_id = scenario_uuid AND title = 'Second device detonates (area populated)'
  );

  -- -------------------------------------------------------------------------
  -- 4. Condition-driven inject: Second device detonates (area cleared)
  --    Same timing; acceptable outcome — no additional casualties.
  -- -------------------------------------------------------------------------
  INSERT INTO scenario_injects (
    scenario_id, trigger_time_minutes, type, title, content, severity,
    affected_roles, inject_scope, target_teams, requires_response, requires_coordination,
    conditions_to_appear, conditions_to_cancel, eligible_after_minutes
  )
  SELECT scenario_uuid, NULL, 'field_update',
    'Second device detonates (area cleared)',
    'A second device has detonated in an area that had already been cordoned and cleared. There are no additional casualties or injuries from this blast. The explosion has caused further structural damage and noise; continue to keep evacuees and responders away from the blast zone.',
    'high',
    '[]'::jsonb, 'universal', NULL, true, false,
    '{"all": ["gate_not_met:second_device_defused", "area_cleared"]}'::jsonb,
    '["gate_met:second_device_defused"]'::jsonb,
    20
  WHERE NOT EXISTS (
    SELECT 1 FROM scenario_injects
    WHERE scenario_id = scenario_uuid AND title = 'Second device detonates (area cleared)'
  );

  RAISE NOTICE '073: C2E second-device outcomes added (gate second_device_defused, found/defused inject, two detonation injects).';
END $$;
