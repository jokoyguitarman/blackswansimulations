-- C2E: neutral map labels for candidate areas (Vacant lot A–E) and set location_type to 'area'
-- so players discover suitability via Insider. Cordon remains in DB but is hidden by frontend/PNG.
-- Idempotent: run after 064. Targets scenario by same title as 064.

DO $$
DECLARE
  scenario_uuid UUID;
BEGIN
  SELECT id INTO scenario_uuid
  FROM scenarios
  WHERE title = 'C2E Bombing at Community Event'
  LIMIT 1;

  IF scenario_uuid IS NULL THEN
    RAISE NOTICE '066: C2E scenario not found; skipping.';
    RETURN;
  END IF;

  -- Update candidate area rows to neutral labels and type 'area' (by display_order from 064)
  UPDATE scenario_locations
  SET label = 'Vacant lot A', location_type = 'area'
  WHERE scenario_id = scenario_uuid AND display_order = 20;

  UPDATE scenario_locations
  SET label = 'Vacant lot B', location_type = 'area'
  WHERE scenario_id = scenario_uuid AND display_order = 21;

  UPDATE scenario_locations
  SET label = 'Vacant lot C', location_type = 'area'
  WHERE scenario_id = scenario_uuid AND display_order = 22;

  UPDATE scenario_locations
  SET label = 'Vacant lot D', location_type = 'area'
  WHERE scenario_id = scenario_uuid AND display_order = 23;

  UPDATE scenario_locations
  SET label = 'Vacant lot E', location_type = 'area'
  WHERE scenario_id = scenario_uuid AND display_order = 24;

  RAISE NOTICE '066: C2E scenario_locations updated to neutral area labels (Vacant lot A–E).';
END $$;
