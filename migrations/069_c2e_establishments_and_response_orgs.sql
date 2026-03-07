-- C2E: Add pins for establishments and response organisations (police, SCDF, hospital, other CC, CCTV).
-- For DBs that ran 064 before these were added. Idempotent: only inserts if not already present.

DO $$
DECLARE
  scenario_uuid UUID;
BEGIN
  SELECT id INTO scenario_uuid
  FROM scenarios
  WHERE title = 'C2E Bombing at Community Event'
  LIMIT 1;

  IF scenario_uuid IS NULL THEN
    RAISE NOTICE '069: C2E scenario not found; skipping.';
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM scenario_locations WHERE scenario_id = scenario_uuid AND location_type = 'police_station' LIMIT 1) THEN
    RAISE NOTICE '069: C2E establishments already present; skipping.';
    RETURN;
  END IF;

  INSERT INTO scenario_locations (scenario_id, location_type, label, coordinates, conditions, display_order)
  VALUES
    (scenario_uuid, 'police_station', 'Bishan Neighbourhood Police Centre', '{"lat": 1.3578, "lng": 103.8478}'::jsonb, '{}'::jsonb, 30),
    (scenario_uuid, 'fire_station', 'Bishan Fire Station (SCDF)', '{"lat": 1.3479, "lng": 103.8387}'::jsonb, '{}'::jsonb, 31),
    (scenario_uuid, 'hospital', 'Tan Tock Seng Hospital', '{"lat": 1.3216, "lng": 103.8459}'::jsonb, '{}'::jsonb, 32),
    (scenario_uuid, 'community_center', 'Toa Payoh Central Community Club', '{"lat": 1.3329, "lng": 103.8497}'::jsonb, '{}'::jsonb, 33),
    (scenario_uuid, 'cctv', 'CCTV (Bishan MRT area)', '{"lat": 1.3512, "lng": 103.8485}'::jsonb, '{}'::jsonb, 34),
    (scenario_uuid, 'cctv', 'CCTV (east of park)', '{"lat": 1.3490, "lng": 103.8520}'::jsonb, '{}'::jsonb, 35);

  RAISE NOTICE '069: C2E establishments and response org pins inserted.';
END $$;
