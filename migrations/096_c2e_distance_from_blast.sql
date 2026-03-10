-- C2E: Add distance_from_blast_m to triage and evacuation holding locations.
-- Run after 064, 066, 086. Idempotent: merges distance into conditions.
-- Blast site: 1.3489, 103.8519 (Bishan East Community Park).

DO $$
DECLARE
  scenario_uuid UUID;
  blast_lat CONSTANT float := 1.3489;
  blast_lng CONSTANT float := 103.8519;
  earth_radius_m CONSTANT float := 6371000;
  loc RECORD;
  loc_lat float;
  loc_lng float;
  dlat float;
  dlon float;
  a float;
  c float;
  dist_m float;
  updated_count int := 0;
BEGIN
  SELECT id INTO scenario_uuid
  FROM scenarios
  WHERE title = 'C2E Bombing at Community Event'
  LIMIT 1;

  IF scenario_uuid IS NULL THEN
    RAISE NOTICE '096: C2E Bombing scenario not found; skipping.';
    RETURN;
  END IF;

  FOR loc IN
    SELECT id, coordinates, conditions
    FROM scenario_locations
    WHERE scenario_id = scenario_uuid
      AND (
        location_type IN ('area', 'triage_site')
        OR location_type = 'evacuation_holding'
      )
  LOOP
    loc_lat := (loc.coordinates->>'lat')::float;
    loc_lng := (loc.coordinates->>'lng')::float;

    IF loc_lat IS NULL OR loc_lng IS NULL THEN
      CONTINUE;
    END IF;

    -- Haversine formula (metres)
    dlat := radians(loc_lat - blast_lat);
    dlon := radians(loc_lng - blast_lng);
    a := sin(dlat/2) * sin(dlat/2)
       + cos(radians(blast_lat)) * cos(radians(loc_lat))
       * sin(dlon/2) * sin(dlon/2);
    c := 2 * atan2(sqrt(a), sqrt(1 - a));
    dist_m := round(earth_radius_m * c);

    UPDATE scenario_locations
    SET conditions = COALESCE(conditions, '{}'::jsonb) || jsonb_build_object('distance_from_blast_m', dist_m::int)
    WHERE id = loc.id;

    updated_count := updated_count + 1;
  END LOOP;

  RAISE NOTICE '096: Added distance_from_blast_m to % triage/evac locations.', updated_count;
END $$;
