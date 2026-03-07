-- C2E Bombing: add scenario_locations for evacuation holding zones (where to disperse evacuees after exit).
-- Run after 064 (and 066 if used). Idempotent: inserts only if no evacuation_holding rows exist for the scenario.

DO $$
DECLARE
  scenario_uuid UUID;
  inserted INT;
BEGIN
  SELECT id INTO scenario_uuid
  FROM scenarios
  WHERE title = 'C2E Bombing at Community Event'
  LIMIT 1;

  IF scenario_uuid IS NULL THEN
    RAISE NOTICE '086: C2E Bombing scenario not found; skipping.';
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM scenario_locations WHERE scenario_id = scenario_uuid AND location_type = 'evacuation_holding' LIMIT 1) THEN
    RAISE NOTICE '086: evacuation_holding locations already present for C2E; skipping.';
    RETURN;
  END IF;

  INSERT INTO scenario_locations (scenario_id, location_type, label, coordinates, conditions, display_order)
  SELECT scenario_uuid, 'evacuation_holding', t.label, t.coordinates::jsonb, t.conditions::jsonb, t.display_order
  FROM (VALUES
    (
      'Assembly North',
      '{"lat": 1.3498, "lng": 103.8519}',
      '{"capacity": 200, "suitability": "high", "nearest_exit": "North exit", "has_cover": false, "distance_from_cordon_m": 50}',
      15
    ),
    (
      'Holding East',
      '{"lat": 1.3489, "lng": 103.8528}',
      '{"capacity": 150, "suitability": "high", "nearest_exit": "East exit", "has_cover": true, "distance_from_cordon_m": 45}',
      16
    ),
    (
      'Staging South',
      '{"lat": 1.3480, "lng": 103.8519}',
      '{"capacity": 180, "suitability": "medium", "nearest_exit": "South exit", "has_cover": false, "hazards": "Partial shade only; ensure water available."}',
      17
    ),
    (
      'Community club side – staging',
      '{"lat": 1.3490, "lng": 103.8510}',
      '{"capacity": 120, "suitability": "high", "nearest_exit": "Community club", "has_cover": true, "distance_from_cordon_m": 40}',
      18
    ),
    (
      'West open area',
      '{"lat": 1.3489, "lng": 103.8510}',
      '{"capacity": 100, "suitability": "medium", "nearest_exit": "West exit", "has_cover": false, "hazards": "West exit often congested; use for overflow only."}',
      19
    )
  ) AS t(label, coordinates, conditions, display_order);

  GET DIAGNOSTICS inserted = ROW_COUNT;
  RAISE NOTICE '086: inserted % evacuation_holding scenario_locations for C2E.', inserted;
END $$;
