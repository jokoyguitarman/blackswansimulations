-- Offset the inner cordon pin slightly south of the blast epicentre so both
-- icons are visible on the map.  ~22 m south matches the 20 m cordon radius.

DO $$
DECLARE
  scenario_uuid UUID;
BEGIN
  SELECT id INTO scenario_uuid
  FROM scenarios
  WHERE title = 'C2E Bombing at Community Event'
  LIMIT 1;

  IF scenario_uuid IS NULL THEN
    RAISE NOTICE '123: C2E scenario not found; skipping.';
    RETURN;
  END IF;

  UPDATE scenario_locations
  SET coordinates = '{"lat": 1.3487, "lng": 103.8519}'::jsonb
  WHERE scenario_id = scenario_uuid
    AND location_type = 'cordon'
    AND label = 'Inner cordon perimeter (20m)';

  RAISE NOTICE '123: Cordon pin offset south of blast site.';
END $$;
