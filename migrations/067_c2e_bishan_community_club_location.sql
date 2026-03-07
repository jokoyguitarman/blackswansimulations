-- C2E: Move event location to Bishan East Community Park (green activity area).
-- Updates scenario center and all scenario_locations so pins sit at the park, not on the CC building.
-- Run once; idempotent for the same scenario.

DO $$
DECLARE
  scenario_uuid UUID;
BEGIN
  SELECT id INTO scenario_uuid
  FROM scenarios
  WHERE title = 'C2E Bombing at Community Event'
  LIMIT 1;

  IF scenario_uuid IS NULL THEN
    RAISE NOTICE '067: C2E scenario not found; skipping.';
    RETURN;
  END IF;

  -- Scenario map center: Bishan East Community Park (green activity area)
  UPDATE scenarios
  SET center_lat = 1.3489, center_lng = 103.8519
  WHERE id = scenario_uuid;

  -- Blast and cordon at park
  UPDATE scenario_locations SET coordinates = '{"lat": 1.3489, "lng": 103.8519}'::jsonb
  WHERE scenario_id = scenario_uuid AND location_type = 'blast_site';
  UPDATE scenario_locations SET coordinates = '{"lat": 1.3489, "lng": 103.8519}'::jsonb
  WHERE scenario_id = scenario_uuid AND location_type = 'cordon';

  -- Exits (by label to match 064)
  UPDATE scenario_locations SET coordinates = '{"lat": 1.3494, "lng": 103.8519}'::jsonb
  WHERE scenario_id = scenario_uuid AND label = 'North exit';
  UPDATE scenario_locations SET coordinates = '{"lat": 1.3484, "lng": 103.8519}'::jsonb
  WHERE scenario_id = scenario_uuid AND label = 'South exit';
  UPDATE scenario_locations SET coordinates = '{"lat": 1.3489, "lng": 103.8524}'::jsonb
  WHERE scenario_id = scenario_uuid AND label = 'East exit';
  UPDATE scenario_locations SET coordinates = '{"lat": 1.3489, "lng": 103.8514}'::jsonb
  WHERE scenario_id = scenario_uuid AND label = 'West exit';
  UPDATE scenario_locations SET coordinates = '{"lat": 1.3492, "lng": 103.8512}'::jsonb
  WHERE scenario_id = scenario_uuid AND label = 'Community club';

  -- Candidate area pins (display_order 20–24; 066 renames to Vacant lot A–E)
  UPDATE scenario_locations SET coordinates = '{"lat": 1.3492, "lng": 103.8519}'::jsonb
  WHERE scenario_id = scenario_uuid AND display_order = 20;
  UPDATE scenario_locations SET coordinates = '{"lat": 1.3486, "lng": 103.8519}'::jsonb
  WHERE scenario_id = scenario_uuid AND display_order = 21;
  UPDATE scenario_locations SET coordinates = '{"lat": 1.3489, "lng": 103.8522}'::jsonb
  WHERE scenario_id = scenario_uuid AND display_order = 22;
  UPDATE scenario_locations SET coordinates = '{"lat": 1.3489, "lng": 103.8516}'::jsonb
  WHERE scenario_id = scenario_uuid AND display_order = 23;
  UPDATE scenario_locations SET coordinates = '{"lat": 1.3495, "lng": 103.8515}'::jsonb
  WHERE scenario_id = scenario_uuid AND display_order = 24;

  RAISE NOTICE '067: C2E location updated to Bishan East Community Park (1.3489, 103.8519).';
END $$;
