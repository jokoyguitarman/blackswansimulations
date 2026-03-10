-- C2E: Add 2–4 new triage and evacuation holding locations with full metadata.
-- Run after 096 (distance_from_blast). Idempotent: skips if new locations already exist.
-- Suggested: one triage 60–80 m (water, power); one 40–50 m without power;
-- one evac 70–100 m with cover and water; one 55–65 m, open, no water.
-- Blast: 1.3489, 103.8519. At Singapore ~1.35°: 1° lat ≈ 111 km, 1° lng ≈ 111*cos(1.35°) km.

DO $$
DECLARE
  scenario_uuid UUID;
  blast_lat CONSTANT float := 1.3489;
  blast_lng CONSTANT float := 103.8519;
  inserted INT;
BEGIN
  SELECT id INTO scenario_uuid
  FROM scenarios
  WHERE title = 'C2E Bombing at Community Event'
  LIMIT 1;

  IF scenario_uuid IS NULL THEN
    RAISE NOTICE '097: C2E Bombing scenario not found; skipping.';
    RETURN;
  END IF;

  -- Skip if we already added these (by label)
  IF EXISTS (
    SELECT 1 FROM scenario_locations
    WHERE scenario_id = scenario_uuid AND label = 'North annex (triage)'
  ) THEN
    RAISE NOTICE '097: Additional C2E locations already present; skipping.';
    RETURN;
  END IF;

  -- 2 new triage sites (display_order 25, 26)
  -- North annex: ~70 m from blast, water, power
  INSERT INTO scenario_locations (scenario_id, location_type, label, coordinates, conditions, display_order)
  VALUES
    (
      scenario_uuid, 'area', 'North annex (triage)',
      '{"lat": 1.34953, "lng": 103.8519}'::jsonb,
      '{"suitability": "high", "capacity_lying": 55, "capacity_standing": 140, "distance_from_blast_m": 70, "water": true, "power": true, "has_cover": true, "vehicle_access": true, "stretcher_route": true}'::jsonb,
      25
    ),
    -- East strip 2: ~45 m from blast, no power
    (
      scenario_uuid, 'area', 'East strip 2 (triage)',
      '{"lat": 1.3489, "lng": 103.85235}'::jsonb,
      '{"suitability": "medium", "capacity_lying": 30, "capacity_standing": 80, "distance_from_blast_m": 45, "water": true, "power": false, "has_cover": false, "vehicle_access": false, "stretcher_route": true}'::jsonb,
      26
    );

  -- 2 new evacuation holdings (display_order 22, 23)
  INSERT INTO scenario_locations (scenario_id, location_type, label, coordinates, conditions, display_order)
  VALUES
    -- Assembly North-East: ~85 m from blast, cover, water
    (
      scenario_uuid, 'evacuation_holding', 'Assembly North-East',
      '{"lat": 1.34967, "lng": 103.8520}'::jsonb,
      '{"capacity": 180, "suitability": "high", "nearest_exit": "North exit", "has_cover": true, "water": true, "power": false, "distance_from_blast_m": 85}'::jsonb,
      22
    ),
    -- West open staging: ~60 m, open, no water
    (
      scenario_uuid, 'evacuation_holding', 'West open staging',
      '{"lat": 1.3489, "lng": 103.8510}'::jsonb,
      '{"capacity": 90, "suitability": "medium", "nearest_exit": "West exit", "has_cover": false, "water": false, "power": false, "distance_from_blast_m": 60, "hazards": "Exposed; ensure water supply."}'::jsonb,
      23
    );

  GET DIAGNOSTICS inserted = ROW_COUNT;
  RAISE NOTICE '097: Inserted % additional C2E triage and evac locations.', inserted;
END $$;
