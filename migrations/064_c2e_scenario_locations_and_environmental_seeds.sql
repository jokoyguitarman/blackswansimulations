-- C2E Bombing: seed scenario_locations (map pins) and scenario_environmental_seeds for the existing scenario.
-- Run after 061, 062, 063. Idempotent: finds scenario by title; replaces locations and env seeds for that scenario.
-- See docs/GAME_SPECIFICS_AND_LOCATIONS.md and environmentalStateService / environmentalPrerequisiteService.

DO $$
DECLARE
  scenario_uuid UUID;
  loc_count INT;
  seed_count INT;
BEGIN
  SELECT id INTO scenario_uuid
  FROM scenarios
  WHERE title = 'C2E Bombing at Community Event'
  LIMIT 1;

  IF scenario_uuid IS NULL THEN
    RAISE NOTICE '064: C2E Bombing scenario not found; skipping. Run demo/seed_c2e_scenario.sql if needed.';
    RETURN;
  END IF;

  -- ============================================
  -- PART 1: scenario_locations (map pins)
  -- Center from 061 osm_vicinity: lat 1.3521, lng 103.8198
  -- ============================================
  DELETE FROM scenario_locations WHERE scenario_id = scenario_uuid;

  INSERT INTO scenario_locations (scenario_id, location_type, label, coordinates, conditions, display_order)
  VALUES
    -- Blast & cordon
    (scenario_uuid, 'blast_site', 'Ground zero (blast epicentre)', '{"lat": 1.3521, "lng": 103.8198}'::jsonb, '{"cordon_rule": "No entry except authorised response; casualty pickup at edge only."}'::jsonb, 0),
    (scenario_uuid, 'cordon', 'Inner cordon perimeter (20m)', '{"lat": 1.3521, "lng": 103.8198}'::jsonb, '{}'::jsonb, 1),
    -- Exits (N, S, E, W, CC)
    (scenario_uuid, 'exit', 'North exit', '{"lat": 1.3526, "lng": 103.8198}'::jsonb, '{"flow_per_min": 120, "status": "open", "width_m": 4}'::jsonb, 10),
    (scenario_uuid, 'exit', 'South exit', '{"lat": 1.3516, "lng": 103.8198}'::jsonb, '{"flow_per_min": 80, "status": "open", "width_m": 3}'::jsonb, 11),
    (scenario_uuid, 'exit', 'East exit', '{"lat": 1.3521, "lng": 103.8203}'::jsonb, '{"flow_per_min": 60, "status": "open", "width_m": 2}'::jsonb, 12),
    (scenario_uuid, 'exit', 'West exit', '{"lat": 1.3521, "lng": 103.8193}'::jsonb, '{"flow_per_min": 45, "status": "congested", "width_m": 2.5}'::jsonb, 13),
    (scenario_uuid, 'exit', 'Community club', '{"lat": 1.3520, "lng": 103.8202}'::jsonb, '{"flow_per_min": 90, "status": "open", "width_m": 3.5}'::jsonb, 14),
    -- Triage candidate areas (site_areas from 061; conditions drive prerequisite gate)
    (scenario_uuid, 'triage_site', 'North side of court', '{"lat": 1.3524, "lng": 103.8198}'::jsonb, '{"suitability": "medium", "capacity_lying": 45, "hazards": "Partially collapsed shelter; check structural integrity."}'::jsonb, 20),
    (scenario_uuid, 'triage_site', 'South side of court', '{"lat": 1.3518, "lng": 103.8198}'::jsonb, '{"suitability": "high", "capacity_lying": 65}'::jsonb, 21),
    (scenario_uuid, 'triage_site', 'East side (along community club)', '{"lat": 1.3521, "lng": 103.8201}'::jsonb, '{"suitability": "high", "capacity_lying": 15}'::jsonb, 22),
    (scenario_uuid, 'triage_site', 'West side (service road area)', '{"lat": 1.3521, "lng": 103.8195}'::jsonb, '{"suitability": "low", "unsuitable": true, "capacity_lying": 50, "hazards": "Congested; downwind of cordon."}'::jsonb, 23),
    (scenario_uuid, 'triage_site', 'Adjacent grass field (north-west)', '{"lat": 1.3528, "lng": 103.8192}'::jsonb, '{"suitability": "high", "capacity_lying": 100}'::jsonb, 24);

  GET DIAGNOSTICS loc_count = ROW_COUNT;
  RAISE NOTICE '064: scenario_locations inserted: %', loc_count;

  -- ============================================
  -- PART 2: scenario_environmental_seeds (env state variants)
  -- seed_data shape: { routes: [{ route_id, label, travel_time_minutes?, problem?, active, managed }], areas?: [...] }
  -- ============================================
  DELETE FROM scenario_environmental_seeds WHERE scenario_id = scenario_uuid;

  INSERT INTO scenario_environmental_seeds (scenario_id, variant_label, seed_data, display_order)
  VALUES
    (scenario_uuid, 'all_clear', '{
      "routes": [
        {"route_id": "north_corridor", "label": "Bishan Street 13 – north to hospital zone", "travel_time_minutes": 12, "problem": null, "active": true, "managed": true},
        {"route_id": "east_access", "label": "Lorong 2 Toa Payoh – east access", "travel_time_minutes": 10, "problem": null, "active": true, "managed": true},
        {"route_id": "service_road", "label": "Service road behind community club", "travel_time_minutes": 5, "problem": null, "active": true, "managed": true}
      ]
    }'::jsonb, 0),
    (scenario_uuid, 'north_congested', '{
      "routes": [
        {"route_id": "north_corridor", "label": "Bishan Street 13 – north to hospital zone", "travel_time_minutes": 25, "problem": "Congestion; accident blocking one lane.", "active": true, "managed": false},
        {"route_id": "east_access", "label": "Lorong 2 Toa Payoh – east access", "travel_time_minutes": 10, "problem": null, "active": true, "managed": true},
        {"route_id": "service_road", "label": "Service road behind community club", "travel_time_minutes": 5, "problem": null, "active": true, "managed": true}
      ]
    }'::jsonb, 1),
    (scenario_uuid, 'service_road_blocked', '{
      "routes": [
        {"route_id": "north_corridor", "label": "Bishan Street 13 – north to hospital zone", "travel_time_minutes": 12, "problem": null, "active": true, "managed": true},
        {"route_id": "east_access", "label": "Lorong 2 Toa Payoh – east access", "travel_time_minutes": 10, "problem": null, "active": true, "managed": true},
        {"route_id": "service_road", "label": "Service road behind community club", "travel_time_minutes": null, "problem": "Parked van blocking; no vehicle access.", "active": true, "managed": false}
      ]
    }'::jsonb, 2);

  GET DIAGNOSTICS seed_count = ROW_COUNT;
  RAISE NOTICE '064: scenario_environmental_seeds inserted: %', seed_count;
END $$;
