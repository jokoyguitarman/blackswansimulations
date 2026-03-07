-- When injects that describe exit congestion/panic are published, add to evacuation_state.exits_congested
-- so the scheduler halves the evac rate (see injectPublishEffectsService append semantics).
-- C2E: "Exit bottleneck – flow control needed" adds West exit (aligns with 075 north_congested variant).

DO $$
DECLARE
  scenario_uuid UUID;
BEGIN
  SELECT id INTO scenario_uuid
  FROM scenarios
  WHERE title = 'C2E Bombing at Community Event'
  LIMIT 1;

  IF scenario_uuid IS NULL THEN
    RAISE NOTICE '083: C2E scenario not found; skipping.';
    RETURN;
  END IF;

  UPDATE scenario_injects
  SET state_effect = '{"evacuation_state": {"exits_congested": ["West exit"]}}'::jsonb
  WHERE scenario_id = scenario_uuid AND title = 'Exit bottleneck – flow control needed';
END;
$$;
