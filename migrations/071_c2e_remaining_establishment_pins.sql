-- C2E: Add remaining establishment pins (in Insider but not yet on map).
-- Bishan Community Hospital, Toa Payoh Polyclinic, Toa Payoh East NPC, Ang Mo Kio Division HQ.
-- Run after 064/069. Idempotent: skips if pins already present.

DO $$
DECLARE
  scenario_uuid UUID;
BEGIN
  SELECT id INTO scenario_uuid
  FROM scenarios
  WHERE title = 'C2E Bombing at Community Event'
  LIMIT 1;

  IF scenario_uuid IS NULL THEN
    RAISE NOTICE '071: C2E scenario not found; skipping.';
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM scenario_locations WHERE scenario_id = scenario_uuid AND label = 'Bishan Community Hospital' LIMIT 1) THEN
    RAISE NOTICE '071: C2E remaining establishment pins already present; skipping.';
    RETURN;
  END IF;

  INSERT INTO scenario_locations (scenario_id, location_type, label, coordinates, conditions, display_order)
  VALUES
    (scenario_uuid, 'hospital', 'Bishan Community Hospital', '{"lat": 1.3502, "lng": 103.8491}'::jsonb, '{}'::jsonb, 36),
    (scenario_uuid, 'hospital', 'Toa Payoh Polyclinic', '{"lat": 1.3343, "lng": 103.8494}'::jsonb, '{}'::jsonb, 37),
    (scenario_uuid, 'police_station', 'Toa Payoh East NPC', '{"lat": 1.3345, "lng": 103.8512}'::jsonb, '{}'::jsonb, 38),
    (scenario_uuid, 'police_station', 'Ang Mo Kio Division HQ', '{"lat": 1.3752, "lng": 103.8490}'::jsonb, '{}'::jsonb, 39);

  RAISE NOTICE '071: C2E remaining establishment pins inserted (BCH, TPP, Toa Payoh East NPC, AMK Division HQ).';
END $$;
