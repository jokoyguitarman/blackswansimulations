-- Convert "Second device detonates (area populated)" from a condition-driven
-- inject to a time-based inject at T+40 minutes.
-- The gate required_gate_not_met_id ensures it only fires when the
-- second_device_defused gate has NOT been met (i.e. players didn't defuse it).

DO $$
DECLARE
  scenario_uuid UUID;
  gate_uuid UUID;
BEGIN
  SELECT id INTO scenario_uuid
  FROM scenarios
  WHERE title = 'C2E Bombing at Community Event'
  LIMIT 1;

  IF scenario_uuid IS NULL THEN
    RAISE NOTICE '121: C2E scenario not found; skipping.';
    RETURN;
  END IF;

  SELECT id INTO gate_uuid
  FROM scenario_gates
  WHERE scenario_id = scenario_uuid AND gate_id = 'second_device_defused'
  LIMIT 1;

  IF gate_uuid IS NULL THEN
    RAISE NOTICE '121: Gate second_device_defused not found; skipping.';
    RETURN;
  END IF;

  UPDATE scenario_injects
  SET trigger_time_minutes       = 40,
      required_gate_not_met_id   = gate_uuid,
      conditions_to_appear       = NULL,
      conditions_to_cancel       = NULL,
      eligible_after_minutes     = NULL
  WHERE scenario_id = scenario_uuid
    AND title = 'Second device detonates (area populated)';

  RAISE NOTICE '121: Second device detonation inject converted to time-based (T+40 min).';
END $$;
