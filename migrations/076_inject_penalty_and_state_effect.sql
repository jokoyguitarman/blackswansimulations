-- Phase 3: Add objective_penalty and state_effect to scenario_injects.
-- When an inject is published, these are applied: penalty via add_objective_penalty RPC,
-- state_effect by merging into session.current_state (evacuation_state/triage_state/media_state).
-- See server/routes/injects.ts publishInjectToSession and docs/CONDITION_INJECT_DATA_MODEL.md.

ALTER TABLE scenario_injects
  ADD COLUMN IF NOT EXISTS objective_penalty JSONB,
  ADD COLUMN IF NOT EXISTS state_effect JSONB;

COMMENT ON COLUMN scenario_injects.objective_penalty IS 'When this inject is published: { "objective_id": "triage", "reason": "Death on site", "points": 15 }. Optional.';
COMMENT ON COLUMN scenario_injects.state_effect IS 'When this inject is published, merge into session.current_state e.g. { "triage_state": { "deaths_on_site": 1 } }. Optional.';

-- C2E: condition-driven "Death at triage" bad-outcome inject
DO $$
DECLARE
  scenario_uuid UUID;
BEGIN
  SELECT id INTO scenario_uuid
  FROM scenarios
  WHERE title = 'C2E Bombing at Community Event'
  LIMIT 1;

  IF scenario_uuid IS NULL THEN
    RAISE NOTICE '076: C2E Bombing scenario not found; skipping inject insert.';
    RETURN;
  END IF;

  INSERT INTO scenario_injects (
    scenario_id,
    trigger_time_minutes,
    conditions_to_appear,
    conditions_to_cancel,
    eligible_after_minutes,
    type,
    title,
    content,
    severity,
    affected_roles,
    inject_scope,
    target_teams,
    requires_response,
    requires_coordination,
    objective_penalty,
    state_effect
  )
  SELECT
    scenario_uuid,
    NULL,
    '{"all": ["triage_no_prioritisation_decision", "triage_surge_active"]}'::jsonb,
    '["triage_deaths_on_site_positive"]'::jsonb,
    10,
    'field_update',
    'Death at Triage - Critical Patient Deterioration',
    'A critical patient has deteriorated and died at the triage site. Medical lead reports that without a clear prioritisation protocol and under surge pressure, the team could not allocate limited resources in time. Family members are present; the incident is affecting morale.',
    'critical',
    '[]'::jsonb,
    'team_specific',
    ARRAY['Triage'],
    true,
    true,
    '{"objective_id": "triage", "reason": "Death on site", "points": 15}'::jsonb,
    '{"triage_state": {"deaths_on_site": 1}}'::jsonb
  WHERE NOT EXISTS (
    SELECT 1 FROM scenario_injects
    WHERE scenario_id = scenario_uuid AND title = 'Death at Triage - Critical Patient Deterioration'
  );
END;
$$;

-- Optional: extend C2E triage objective success_criteria with new penalty keys (documentation / consistency)
DO $$
DECLARE
  scenario_uuid UUID;
  current_criteria JSONB;
BEGIN
  SELECT id INTO scenario_uuid
  FROM scenarios
  WHERE title = 'C2E Bombing at Community Event'
  LIMIT 1;

  IF scenario_uuid IS NULL THEN
    RETURN;
  END IF;

  SELECT success_criteria INTO current_criteria
  FROM scenario_objectives
  WHERE scenario_id = scenario_uuid AND objective_id = 'triage';

  IF current_criteria IS NOT NULL AND current_criteria ? 'penalties' THEN
    UPDATE scenario_objectives
    SET success_criteria = jsonb_set(
      jsonb_set(
        COALESCE(success_criteria, '{}'::jsonb),
        '{penalties,deaths_on_site}',
        '15'::jsonb,
        true
      ),
      '{penalties,supply_crisis}',
      '20'::jsonb,
      true
    )
    WHERE scenario_id = scenario_uuid AND objective_id = 'triage';
  END IF;
END;
$$;
