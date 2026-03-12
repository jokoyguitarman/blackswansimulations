-- Jurong Point Bombing: seed scenario_locations (map pins), scenario_environmental_seeds, and insider_knowledge.
-- Run after demo/seed_jurong_point_scenario.sql. Idempotent: finds scenario by title.
-- Jurong Point: 1 Jurong West Central 2, 9 floors, lat 1.34 lng 103.706

DO $$
DECLARE
  scenario_uuid UUID;
  loc_count INT;
  seed_count INT;
  fire_stations JSONB;
  hospitals JSONB;
  police JSONB;
BEGIN
  SELECT id INTO scenario_uuid
  FROM scenarios
  WHERE title = 'Bombing at Jurong Point Mall'
  LIMIT 1;

  IF scenario_uuid IS NULL THEN
    RAISE NOTICE '106: Jurong Point scenario not found; skipping. Run demo/seed_jurong_point_scenario.sql first.';
    RETURN;
  END IF;

  -- ============================================
  -- PART 1: scenario_locations (map pins)
  -- Center: Jurong Point Mall, lat 1.34, lng 103.706
  -- ============================================
  DELETE FROM scenario_locations WHERE scenario_id = scenario_uuid;

  INSERT INTO scenario_locations (scenario_id, location_type, label, coordinates, conditions, display_order)
  VALUES
    -- Blast & cordon at Level 2 atrium
    (scenario_uuid, 'blast_site', 'Ground zero (Level 2 atrium)', '{"lat": 1.34, "lng": 103.706}'::jsonb, '{"cordon_rule": "No entry except authorised response; casualty pickup at edge only.", "floor": 2}'::jsonb, 0),
    (scenario_uuid, 'cordon', 'Inner cordon perimeter (Level 2)', '{"lat": 1.34, "lng": 103.706}'::jsonb, '{"floor": 2}'::jsonb, 1),
    -- Exits (stairwells, mall exits)
    (scenario_uuid, 'exit', 'Stairwell A (North)', '{"lat": 1.3405, "lng": 103.706}'::jsonb, '{"flow_per_min": 80, "status": "open", "floor": "all", "type": "stairwell"}'::jsonb, 10),
    (scenario_uuid, 'exit', 'Stairwell B (South)', '{"lat": 1.3395, "lng": 103.706}'::jsonb, '{"flow_per_min": 60, "status": "congested", "floor": "all", "type": "stairwell"}'::jsonb, 11),
    (scenario_uuid, 'exit', 'Main entrance (Boon Lay link)', '{"lat": 1.34, "lng": 103.7045}'::jsonb, '{"flow_per_min": 120, "status": "open", "floor": 1}'::jsonb, 12),
    (scenario_uuid, 'exit', 'East exit (JP2 wing)', '{"lat": 1.34, "lng": 103.708}'::jsonb, '{"flow_per_min": 90, "status": "open", "floor": 1}'::jsonb, 13),
    (scenario_uuid, 'exit', 'Bus interchange link', '{"lat": 1.3398, "lng": 103.7055}'::jsonb, '{"flow_per_min": 100, "status": "open", "floor": 1}'::jsonb, 14),
    -- Triage site candidates (outside mall, safe zones)
    (scenario_uuid, 'triage_site', 'Area A (North plaza)', '{"lat": 1.341, "lng": 103.706}'::jsonb, '{"suitability": "high", "capacity_lying": 60, "notes": "Open area; upwind of blast"}'::jsonb, 20),
    (scenario_uuid, 'triage_site', 'Area B (East plaza)', '{"lat": 1.34, "lng": 103.7085}'::jsonb, '{"suitability": "high", "capacity_lying": 45}'::jsonb, 21),
    (scenario_uuid, 'triage_site', 'Area C (Boon Lay concourse)', '{"lat": 1.3395, "lng": 103.7045}'::jsonb, '{"suitability": "medium", "capacity_lying": 80, "hazards": "High foot traffic from MRT"}'::jsonb, 22),
    (scenario_uuid, 'triage_site', 'Area D (South)', '{"lat": 1.339, "lng": 103.706}'::jsonb, '{"suitability": "low", "unsuitable": true, "capacity_lying": 50, "hazards": "Downwind of smoke"}'::jsonb, 23),
    -- Establishments and response organisations
    (scenario_uuid, 'fire_station', 'Jurong Fire Station (SCDF)', '{"lat": 1.3479, "lng": 103.7053}'::jsonb, '{}'::jsonb, 30),
    (scenario_uuid, 'hospital', 'Ng Teng Fong General Hospital', '{"lat": 1.335, "lng": 103.744}'::jsonb, '{}'::jsonb, 31),
    (scenario_uuid, 'hospital', 'Jurong Community Hospital', '{"lat": 1.334, "lng": 103.742}'::jsonb, '{}'::jsonb, 32),
    (scenario_uuid, 'police_station', 'Jurong East NPC', '{"lat": 1.34, "lng": 103.737}'::jsonb, '{}'::jsonb, 33),
    (scenario_uuid, 'cctv', 'CCTV (Boon Lay MRT area)', '{"lat": 1.3395, "lng": 103.705}'::jsonb, '{}'::jsonb, 34),
    (scenario_uuid, 'cctv', 'CCTV (mall atrium)', '{"lat": 1.34, "lng": 103.706}'::jsonb, '{}'::jsonb, 35),
    (scenario_uuid, 'evacuation_holding', 'Boon Lay Bus Interchange concourse', '{"lat": 1.3392, "lng": 103.7052}'::jsonb, '{"capacity": 500, "notes": "Evacuation assembly point"}'::jsonb, 40),
    (scenario_uuid, 'evacuation_holding', 'Open space north of mall', '{"lat": 1.3415, "lng": 103.706}'::jsonb, '{"capacity": 500, "notes": "Evacuation assembly point"}'::jsonb, 41);

  GET DIAGNOSTICS loc_count = ROW_COUNT;
  RAISE NOTICE '106: scenario_locations inserted: %', loc_count;

  -- ============================================
  -- PART 2: scenario_environmental_seeds (env state variants)
  -- ============================================
  DELETE FROM scenario_environmental_seeds WHERE scenario_id = scenario_uuid;

  INSERT INTO scenario_environmental_seeds (scenario_id, variant_label, seed_data, display_order)
  VALUES
    (scenario_uuid, 'all_clear', '{
      "routes": [
        {"route_id": "jurong_west_st", "label": "Jurong West Street 26 – to Jurong Fire Station", "travel_time_minutes": 5, "problem": null, "active": true, "managed": true},
        {"route_id": "boon_lay_access", "label": "Boon Lay Way – ambulance access", "travel_time_minutes": 8, "problem": null, "active": true, "managed": true},
        {"route_id": "jurong_east_21", "label": "Jurong East Street 21 – to Ng Teng Fong Hospital", "travel_time_minutes": 12, "problem": null, "active": true, "managed": true}
      ],
      "areas": [
        {"area_id": "ntfgh", "label": "Ng Teng Fong General Hospital", "type": "hospital", "at_capacity": false, "aliases": ["NTFGH", "Ng Teng Fong"]},
        {"area_id": "jch", "label": "Jurong Community Hospital", "type": "hospital", "at_capacity": false, "aliases": ["JCH", "Jurong Community"]},
        {"area_id": "jurong_east_npc", "label": "Jurong East NPC", "type": "police", "at_capacity": false, "aliases": ["Jurong East NPC"]},
        {"area_id": "jurong_fire", "label": "Jurong Fire Station (SCDF)", "type": "fire_station", "at_capacity": false, "aliases": ["Jurong Fire", "SCDF Jurong"]}
      ]
    }'::jsonb, 0),
    (scenario_uuid, 'boon_lay_congested', '{
      "routes": [
        {"route_id": "jurong_west_st", "label": "Jurong West Street 26 – to Jurong Fire Station", "travel_time_minutes": 5, "problem": null, "active": true, "managed": true},
        {"route_id": "boon_lay_access", "label": "Boon Lay Way – ambulance access", "travel_time_minutes": 20, "problem": "Congestion near MRT; accident blocking lane.", "active": true, "managed": false},
        {"route_id": "jurong_east_21", "label": "Jurong East Street 21 – to Ng Teng Fong Hospital", "travel_time_minutes": 12, "problem": null, "active": true, "managed": true}
      ],
      "areas": [
        {"area_id": "ntfgh", "label": "Ng Teng Fong General Hospital", "type": "hospital", "at_capacity": false, "aliases": ["NTFGH", "Ng Teng Fong"]},
        {"area_id": "jch", "label": "Jurong Community Hospital", "type": "hospital", "at_capacity": false, "aliases": ["JCH", "Jurong Community"]},
        {"area_id": "jurong_east_npc", "label": "Jurong East NPC", "type": "police", "at_capacity": false, "aliases": ["Jurong East NPC"]},
        {"area_id": "jurong_fire", "label": "Jurong Fire Station (SCDF)", "type": "fire_station", "at_capacity": true, "problem": "All appliances committed; no additional fire/rescue units available.", "active": true, "managed": false, "aliases": ["Jurong Fire", "SCDF Jurong"]}
      ]
    }'::jsonb, 1),
    (scenario_uuid, 'hospital_at_capacity', '{
      "routes": [
        {"route_id": "jurong_west_st", "label": "Jurong West Street 26 – to Jurong Fire Station", "travel_time_minutes": 5, "problem": null, "active": true, "managed": true},
        {"route_id": "boon_lay_access", "label": "Boon Lay Way – ambulance access", "travel_time_minutes": 8, "problem": null, "active": true, "managed": true},
        {"route_id": "jurong_east_21", "label": "Jurong East Street 21 – to Ng Teng Fong Hospital", "travel_time_minutes": 12, "problem": null, "active": true, "managed": true}
      ],
      "areas": [
        {"area_id": "ntfgh", "label": "Ng Teng Fong General Hospital", "type": "hospital", "at_capacity": true, "problem": "At full capacity; divert to JCH or other hospitals.", "active": true, "managed": false, "aliases": ["NTFGH", "Ng Teng Fong"]},
        {"area_id": "jch", "label": "Jurong Community Hospital", "type": "hospital", "at_capacity": false, "aliases": ["JCH", "Jurong Community"]},
        {"area_id": "jurong_east_npc", "label": "Jurong East NPC", "type": "police", "at_capacity": false, "aliases": ["Jurong East NPC"]},
        {"area_id": "jurong_fire", "label": "Jurong Fire Station (SCDF)", "type": "fire_station", "at_capacity": false, "aliases": ["Jurong Fire", "SCDF Jurong"]}
      ]
    }'::jsonb, 2);

  GET DIAGNOSTICS seed_count = ROW_COUNT;
  RAISE NOTICE '106: scenario_environmental_seeds inserted: %', seed_count;

  -- ============================================
  -- PART 3: insider_knowledge (osm_vicinity for Insider Q&A)
  -- ============================================
  fire_stations := jsonb_build_array(
    jsonb_build_object('name', 'Jurong Fire Station (SCDF)', 'lat', 1.3479, 'lng', 103.7053, 'address', '22 Jurong West Street 26')
  );
  hospitals := jsonb_build_array(
    jsonb_build_object('name', 'Ng Teng Fong General Hospital', 'lat', 1.335, 'lng', 103.744, 'address', '1 Jurong East Street 21'),
    jsonb_build_object('name', 'Jurong Community Hospital', 'lat', 1.334, 'lng', 103.742, 'address', 'Jurong East')
  );
  police := jsonb_build_array(
    jsonb_build_object('name', 'Jurong East NPC', 'lat', 1.34, 'lng', 103.737, 'address', '92 Boon Lay Way')
  );

  UPDATE scenarios
  SET
    center_lat = COALESCE(center_lat, 1.34),
    center_lng = COALESCE(center_lng, 103.706),
    vicinity_radius_meters = COALESCE(vicinity_radius_meters, 3000),
    insider_knowledge = COALESCE(insider_knowledge, '{}'::jsonb) || jsonb_build_object(
      'osm_vicinity', jsonb_build_object(
        'fire_stations', fire_stations,
        'hospitals', hospitals,
        'police', police
      ),
      'layout_ground_truth', jsonb_build_object(
        'evacuee_count', 1500,
        'floors', 9,
        'blast_floor', 2,
        'exits', jsonb_build_array(
          jsonb_build_object('id', 'A', 'label', 'Stairwell A (North)', 'flow_per_min', 80, 'status', 'open'),
          jsonb_build_object('id', 'B', 'label', 'Stairwell B (South)', 'flow_per_min', 60, 'status', 'congested'),
          jsonb_build_object('id', 'main', 'label', 'Main entrance', 'flow_per_min', 120, 'status', 'open')
        ),
        'zones', jsonb_build_array(
          jsonb_build_object('id', 'gz', 'label', 'Ground zero (Level 2 atrium)', 'capacity', 0, 'type', 'cordon'),
          jsonb_build_object('id', 'triage_a', 'label', 'Triage zone A (North plaza)', 'capacity', 60, 'type', 'medical')
        )
      ),
      'custom_facts', jsonb_build_array(
        jsonb_build_object(
          'topic', 'event',
          'summary', 'Community event at Jurong Point Mall, ~1500 participants across 9 floors.',
          'detail', 'Bombing at central atrium on Level 2. Smoke spread via atrium. Vertical evacuation required.'
        )
      )
    )
  WHERE id = scenario_uuid;

  RAISE NOTICE '106: Jurong Point scenario_locations, environmental_seeds, and insider_knowledge applied.';
END $$;
