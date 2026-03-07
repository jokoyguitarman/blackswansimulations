-- C2E: Add more hospital, fire station, and police pins (research: real SG facilities near Bishan/Toa Payoh/AMK).
-- Run after 064 (or 069/071). Idempotent: only inserts if label not already present for this scenario.
-- See docs/GAME_SPECIFICS_AND_LOCATIONS.md.

DO $$
DECLARE
  scenario_uuid UUID;
  loc_count INT;
BEGIN
  SELECT id INTO scenario_uuid
  FROM scenarios
  WHERE title = 'C2E Bombing at Community Event'
  LIMIT 1;

  IF scenario_uuid IS NULL THEN
    RAISE NOTICE '072: C2E Bombing scenario not found; skipping.';
    RETURN;
  END IF;

  INSERT INTO scenario_locations (scenario_id, location_type, label, coordinates, conditions, display_order)
  SELECT scenario_uuid, v.location_type, v.label, v.coordinates, '{}'::jsonb, v.display_order
  FROM (VALUES
    -- Additional hospitals (acute / community in north–central corridor)
    ('hospital', 'Mount Alvernia Hospital', '{"lat": 1.3415, "lng": 103.8376}'::jsonb, 40),
    ('hospital', 'Ang Mo Kio – Thye Hua Kwan Hospital', '{"lat": 1.3840, "lng": 103.8404}'::jsonb, 41),
    ('hospital', 'Ren Ci Community Hospital', '{"lat": 1.3260, "lng": 103.8510}'::jsonb, 42),
    ('hospital', 'Khoo Teck Puat Hospital', '{"lat": 1.4246, "lng": 103.8382}'::jsonb, 43),
    ('hospital', 'KK Women''s and Children''s Hospital', '{"lat": 1.3063, "lng": 103.8415}'::jsonb, 44),
    -- Additional SCDF fire stations / fire posts
    ('fire_station', 'Toa Payoh Fire Post (SCDF)', '{"lat": 1.3330, "lng": 103.8500}'::jsonb, 50),
    ('fire_station', 'Ang Mo Kio Fire Station (SCDF)', '{"lat": 1.3820, "lng": 103.8400}'::jsonb, 51),
    -- Additional police
    ('police_station', 'Ang Mo Kio South NPC', '{"lat": 1.3695, "lng": 103.8492}'::jsonb, 52)
  ) AS v(location_type, label, coordinates, display_order)
  WHERE NOT EXISTS (
    SELECT 1 FROM scenario_locations s
    WHERE s.scenario_id = scenario_uuid AND s.label = v.label
  );

  GET DIAGNOSTICS loc_count = ROW_COUNT;
  RAISE NOTICE '072: scenario_locations inserted (extra hospitals/fire/police): %', loc_count;
END $$;

-- Update Insider osm_vicinity so the Insider can answer about the new hospitals, fire stations, police.
DO $$
DECLARE
  scenario_uuid UUID;
  ik jsonb;
  osm jsonb;
  hospitals_new jsonb := jsonb_build_array(
    jsonb_build_object('name', 'Mount Alvernia Hospital', 'lat', 1.3415, 'lng', 103.8376, 'address', '820 Thomson Road', 'notes', 'Private acute; 24h; near Marymount.'),
    jsonb_build_object('name', 'Ang Mo Kio – Thye Hua Kwan Hospital', 'lat', 1.3840, 'lng', 103.8404, 'address', '17 Ang Mo Kio Ave 9', 'notes', 'Community hospital; rehab and sub-acute.'),
    jsonb_build_object('name', 'Ren Ci Community Hospital', 'lat', 1.3260, 'lng', 103.8510, 'address', '71 Irrawaddy Road', 'notes', 'Next to TTSH; rehabilitative care.'),
    jsonb_build_object('name', 'Khoo Teck Puat Hospital', 'lat', 1.4246, 'lng', 103.8382, 'address', '90 Yishun Central', 'notes', 'Acute; north region.'),
    jsonb_build_object('name', 'KK Women''s and Children''s Hospital', 'lat', 1.3063, 'lng', 103.8415, 'address', '100 Bukit Timah Road', 'notes', 'Women and children; Rochor.')
  );
  fire_new jsonb := jsonb_build_array(
    jsonb_build_object('name', 'Toa Payoh Fire Post (SCDF)', 'lat', 1.3330, 'lng', 103.8500, 'address', '46 Lorong 5 Toa Payoh'),
    jsonb_build_object('name', 'Ang Mo Kio Fire Station (SCDF)', 'lat', 1.3820, 'lng', 103.8400, 'address', '2874 Ang Mo Kio Ave 9')
  );
  police_new jsonb := jsonb_build_array(
    jsonb_build_object('name', 'Ang Mo Kio South NPC', 'lat', 1.3695, 'lng', 103.8492, 'address', '81 Ang Mo Kio Ave 3')
  );
  cur jsonb;
  elem jsonb;
  name_val text;
BEGIN
  SELECT id INTO scenario_uuid FROM scenarios WHERE title = 'C2E Bombing at Community Event' LIMIT 1;
  IF scenario_uuid IS NULL THEN RETURN; END IF;

  SELECT insider_knowledge INTO ik FROM scenarios WHERE id = scenario_uuid;
  osm := COALESCE(ik->'osm_vicinity', '{}'::jsonb);

  -- Merge hospitals (add only if name not already present)
  cur := COALESCE(osm->'hospitals', '[]'::jsonb);
  FOR elem IN SELECT * FROM jsonb_array_elements(hospitals_new)
  LOOP
    name_val := elem->>'name';
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(cur) e WHERE e->>'name' = name_val) THEN
      cur := cur || jsonb_build_array(elem);
    END IF;
  END LOOP;
  osm := jsonb_set(COALESCE(osm, '{}'::jsonb), '{hospitals}', cur);

  -- Merge fire_stations
  cur := COALESCE(osm->'fire_stations', '[]'::jsonb);
  FOR elem IN SELECT * FROM jsonb_array_elements(fire_new)
  LOOP
    name_val := elem->>'name';
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(cur) e WHERE e->>'name' = name_val) THEN
      cur := cur || jsonb_build_array(elem);
    END IF;
  END LOOP;
  osm := jsonb_set(COALESCE(osm, '{}'::jsonb), '{fire_stations}', cur);

  -- Merge police
  cur := COALESCE(osm->'police', '[]'::jsonb);
  FOR elem IN SELECT * FROM jsonb_array_elements(police_new)
  LOOP
    name_val := elem->>'name';
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(cur) e WHERE e->>'name' = name_val) THEN
      cur := cur || jsonb_build_array(elem);
    END IF;
  END LOOP;
  osm := jsonb_set(COALESCE(osm, '{}'::jsonb), '{police}', cur);

  UPDATE scenarios
  SET insider_knowledge = jsonb_set(COALESCE(insider_knowledge, '{}'::jsonb), '{osm_vicinity}', osm)
  WHERE id = scenario_uuid;

  RAISE NOTICE '072: insider_knowledge.osm_vicinity updated with extra hospitals, fire_stations, police.';
END $$;
