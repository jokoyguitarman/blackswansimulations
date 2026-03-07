-- C2E Play Ready: geography, map URLs, and insider_knowledge for "C2E Bombing at Community Event"
-- Run after 057 (vicinity/insider columns exist). Idempotent: only fills nulls for map/geography; sets insider_knowledge.

DO $$
DECLARE
  scenario_uuid UUID;
  rows_updated INT;
BEGIN
  SELECT id INTO scenario_uuid
  FROM scenarios
  WHERE title = 'C2E Bombing at Community Event'
  LIMIT 1;

  IF scenario_uuid IS NULL THEN
    RAISE NOTICE '059: C2E Bombing scenario not found; skipping play-ready update. Run demo/seed_c2e_scenario.sql if needed.';
    RETURN;
  END IF;

  UPDATE scenarios
  SET
    center_lat = COALESCE(center_lat, 1.3489),
    center_lng = COALESCE(center_lng, 103.8519),
    vicinity_radius_meters = COALESCE(vicinity_radius_meters, 2000),
    vicinity_map_url = COALESCE(vicinity_map_url, 'https://placehold.co/600x400/1a1a2e/eee?text=Vicinity+Map'),
    layout_image_url = COALESCE(layout_image_url, 'https://placehold.co/600x400/1a1a2e/eee?text=Layout'),
    insider_knowledge = COALESCE(insider_knowledge, '{}'::jsonb) || jsonb_build_object(
      'layout_ground_truth', jsonb_build_object(
        'evacuee_count', 1000,
        'exits', jsonb_build_array(
          jsonb_build_object('id', 'N', 'label', 'North exit', 'flow_per_min', 200, 'status', 'open'),
          jsonb_build_object('id', 'S', 'label', 'South exit', 'flow_per_min', 200, 'status', 'open'),
          jsonb_build_object('id', 'B', 'label', 'Exit B', 'flow_per_min', 80, 'status', 'congested')
        ),
        'zones', jsonb_build_array(
          jsonb_build_object('id', 'gz', 'label', 'Ground zero', 'capacity', 0, 'type', 'cordon'),
          jsonb_build_object('id', 'triage_a', 'label', 'Triage zone A', 'capacity', 50, 'type', 'medical')
        )
      ),
      'custom_facts', jsonb_build_array(
        jsonb_build_object(
          'topic', 'event',
          'summary', 'Community event at neighbourhood hard court, ~1000 participants.',
          'detail', 'Large grassroots community event at a neighbourhood hard court. Central seating area near the detonation point.'
        )
      )
    )
  WHERE id = scenario_uuid;

  GET DIAGNOSTICS rows_updated = ROW_COUNT;
  RAISE NOTICE '059: C2E Play Ready applied: scenario % (rows updated: %)', scenario_uuid, rows_updated;
END $$;
