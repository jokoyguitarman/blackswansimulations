-- Add patients_being_treated, patients_waiting, casualties to triage_state in C2E environmental seeds.
-- Also add patients_waiting to "Patient surge at triage site" state_effect so the counter updates when that inject is published.

DO $$
DECLARE
  scenario_uuid UUID;
BEGIN
  SELECT id INTO scenario_uuid
  FROM scenarios
  WHERE title = 'C2E Bombing at Community Event'
  LIMIT 1;

  IF scenario_uuid IS NULL THEN
    RAISE NOTICE '084: C2E scenario not found; skipping.';
    RETURN;
  END IF;

  -- Merge new triage_state keys into existing seed_data for all C2E variants
  UPDATE scenario_environmental_seeds
  SET seed_data = jsonb_set(
    seed_data,
    '{triage_state}',
    COALESCE(seed_data->'triage_state', '{}'::jsonb) || '{"patients_being_treated": 0, "patients_waiting": 0, "casualties": 0}'::jsonb
  )
  WHERE scenario_id = scenario_uuid;

  -- Patient surge inject: add patients_waiting to state_effect (merge with existing surge_active)
  UPDATE scenario_injects
  SET state_effect = COALESCE(state_effect, '{}'::jsonb) || '{"triage_state": {"surge_active": true, "patients_waiting": 10}}'::jsonb
  WHERE scenario_id = scenario_uuid AND title = 'Patient surge at triage site';

  -- Death at Triage: also increment casualties when published
  UPDATE scenario_injects
  SET state_effect = COALESCE(state_effect, '{}'::jsonb) || '{"triage_state": {"deaths_on_site": 1, "casualties": 1}}'::jsonb
  WHERE scenario_id = scenario_uuid AND title = 'Death at Triage - Critical Patient Deterioration';
END;
$$;
