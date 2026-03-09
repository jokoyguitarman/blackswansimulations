-- C2E: Add hospital areas to scenario_environmental_seeds so hospitals appear in DM interface.
-- Hospitals are used for triage team to DM and ask about capacity.
-- Run after 064, 072. Idempotent: merges areas into seed_data.

DO $$
DECLARE
  scenario_uuid UUID;
  hospital_areas JSONB;
BEGIN
  SELECT id INTO scenario_uuid
  FROM scenarios
  WHERE title = 'C2E Bombing at Community Event'
  LIMIT 1;

  IF scenario_uuid IS NULL THEN
    RAISE NOTICE '093: C2E Bombing scenario not found; skipping.';
    RETURN;
  END IF;

  -- Build areas array from scenario_locations (hospital type)
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'area_id', id,
      'label', label,
      'type', 'hospital'
    ) ORDER BY display_order NULLS LAST
  ), '[]'::jsonb)
  INTO hospital_areas
  FROM scenario_locations
  WHERE scenario_id = scenario_uuid AND location_type = 'hospital';

  IF hospital_areas IS NULL OR hospital_areas = '[]'::jsonb THEN
    RAISE NOTICE '093: No hospital locations found for C2E; skipping.';
    RETURN;
  END IF;

  -- Merge areas into each environmental seed variant
  UPDATE scenario_environmental_seeds
  SET seed_data = COALESCE(seed_data, '{}'::jsonb) || jsonb_build_object('areas', hospital_areas)
  WHERE scenario_id = scenario_uuid;

  RAISE NOTICE '093: C2E environmental seeds updated with % hospital areas.', jsonb_array_length(hospital_areas);
END $$;
