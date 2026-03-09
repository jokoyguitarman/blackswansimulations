-- C2E: set target_teams on universal injects so gate evaluation counts decisions in response to them.
-- Universal injects (inject_scope = 'universal') that have NULL target_teams are updated to target
-- all three teams (evacuation, triage, media), so evac/triage/media situation-report gates can be
-- satisfied when players respond to e.g. Initial Explosion.

DO $$
DECLARE
  scenario_uuid UUID;
  updated_count INT;
BEGIN
  SELECT id INTO scenario_uuid
  FROM scenarios
  WHERE title = 'C2E Bombing at Community Event'
  LIMIT 1;

  IF scenario_uuid IS NULL THEN
    RAISE NOTICE '089: C2E Bombing scenario not found; skipping.';
    RETURN;
  END IF;

  UPDATE scenario_injects
  SET target_teams = ARRAY['evacuation', 'triage', 'media']
  WHERE scenario_id = scenario_uuid
    AND (inject_scope = 'universal' OR (inject_scope IS NULL AND target_teams IS NULL))
    AND (target_teams IS NULL OR target_teams = '{}');

  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RAISE NOTICE '089: Updated target_teams for % C2E universal inject(s).', updated_count;
END $$;
