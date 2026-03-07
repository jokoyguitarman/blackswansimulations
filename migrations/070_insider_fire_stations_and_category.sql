-- Add Insider category 'fire_stations' and seed C2E osm_vicinity.fire_stations for SCDF/fire Q&A.
-- Run after 057, 061. Idempotent.

-- Allow new category in session_insider_qa (drop existing check, add updated one)
DO $$
DECLARE
  conname text;
BEGIN
  FOR conname IN
    SELECT c.conname
    FROM pg_catalog.pg_constraint c
    JOIN pg_catalog.pg_class t ON t.oid = c.conrelid
    WHERE t.relname = 'session_insider_qa' AND c.contype = 'c'
  LOOP
    EXECUTE format('ALTER TABLE session_insider_qa DROP CONSTRAINT %I', conname);
  END LOOP;
  ALTER TABLE session_insider_qa
    ADD CONSTRAINT session_insider_qa_category_check
    CHECK (category IN ('map', 'hospitals', 'police', 'fire_stations', 'cctv', 'routes', 'layout', 'other'));
END $$;

-- Add fire_stations to C2E scenario insider_knowledge.osm_vicinity (align with scenario_locations pins)
DO $$
DECLARE
  scenario_uuid UUID;
  current_osm jsonb;
  fire_stations jsonb;
BEGIN
  SELECT id INTO scenario_uuid
  FROM scenarios
  WHERE title = 'C2E Bombing at Community Event'
  LIMIT 1;

  IF scenario_uuid IS NULL THEN
    RAISE NOTICE '070: C2E scenario not found; skipping fire_stations seed.';
    RETURN;
  END IF;

  fire_stations := jsonb_build_array(
    jsonb_build_object('name', 'Bishan Fire Station (SCDF)', 'lat', 1.3479, 'lng', 103.8387, 'address', 'Bishan')
  );

  SELECT COALESCE(insider_knowledge->'osm_vicinity', '{}'::jsonb) INTO current_osm
  FROM scenarios WHERE id = scenario_uuid;

  UPDATE scenarios
  SET insider_knowledge = jsonb_set(
    COALESCE(insider_knowledge, '{}'::jsonb),
    '{osm_vicinity}',
    current_osm || jsonb_build_object('fire_stations', fire_stations)
  )
  WHERE id = scenario_uuid;

  RAISE NOTICE '070: fire_stations added to C2E insider_knowledge.osm_vicinity.';
END $$;
