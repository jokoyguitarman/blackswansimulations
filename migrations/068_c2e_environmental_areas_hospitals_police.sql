-- C2E Bombing: add environmental_state.areas (hospitals, police) to existing scenario_environmental_seeds.
-- Run after 064. Updates seed_data to include areas so facility-capacity gate can constrain decisions.
-- See docs/SESSION_STATE_SHAPE.md and server/services/environmentalPrerequisiteService.ts.

DO $$
DECLARE
  scenario_uuid UUID;
BEGIN
  SELECT id INTO scenario_uuid
  FROM scenarios
  WHERE title = 'C2E Bombing at Community Event'
  LIMIT 1;

  IF scenario_uuid IS NULL THEN
    RAISE NOTICE '068: C2E Bombing scenario not found; skipping.';
    RETURN;
  END IF;

  -- all_clear: all facilities not at capacity
  UPDATE scenario_environmental_seeds
  SET seed_data = seed_data || '{
    "areas": [
      {"area_id": "ttsh", "label": "Tan Tock Seng Hospital", "type": "hospital", "at_capacity": false, "aliases": ["TTSH", "Tan Tock Seng"]},
      {"area_id": "bch", "label": "Bishan Community Hospital", "type": "hospital", "at_capacity": false, "aliases": ["BCH", "Bishan Community"]},
      {"area_id": "tpp", "label": "Toa Payoh Polyclinic", "type": "hospital", "at_capacity": false, "aliases": ["TPP", "Toa Payoh Polyclinic"]},
      {"area_id": "bishan_north_npc", "label": "Bishan North NPC", "type": "police", "at_capacity": false, "aliases": ["BNNPC", "Bishan North"]},
      {"area_id": "toa_payoh_east_npc", "label": "Toa Payoh East NPC", "type": "police", "at_capacity": false, "aliases": ["TPENPC", "Toa Payoh East"]},
      {"area_id": "amk_division_hq", "label": "Ang Mo Kio Division HQ", "type": "police", "at_capacity": false, "aliases": ["AMKDHQ", "Ang Mo Kio Division"]},
      {"area_id": "bishan_fire", "label": "Bishan Fire Station (SCDF)", "type": "fire_station", "at_capacity": false, "aliases": ["Bishan Fire", "SCDF Bishan"]}
    ]
  }'::jsonb
  WHERE scenario_id = scenario_uuid AND variant_label = 'all_clear';

  -- north_congested: TTSH at capacity; Bishan Fire Station stretched
  UPDATE scenario_environmental_seeds
  SET seed_data = seed_data || '{
    "areas": [
      {"area_id": "ttsh", "label": "Tan Tock Seng Hospital", "type": "hospital", "at_capacity": true, "problem": "At full capacity; divert to BCH or TPP.", "active": true, "managed": false, "aliases": ["TTSH", "Tan Tock Seng"]},
      {"area_id": "bch", "label": "Bishan Community Hospital", "type": "hospital", "at_capacity": false, "aliases": ["BCH", "Bishan Community"]},
      {"area_id": "tpp", "label": "Toa Payoh Polyclinic", "type": "hospital", "at_capacity": false, "aliases": ["TPP", "Toa Payoh Polyclinic"]},
      {"area_id": "bishan_north_npc", "label": "Bishan North NPC", "type": "police", "at_capacity": false, "aliases": ["BNNPC", "Bishan North"]},
      {"area_id": "toa_payoh_east_npc", "label": "Toa Payoh East NPC", "type": "police", "at_capacity": false, "aliases": ["TPENPC", "Toa Payoh East"]},
      {"area_id": "amk_division_hq", "label": "Ang Mo Kio Division HQ", "type": "police", "at_capacity": false, "aliases": ["AMKDHQ", "Ang Mo Kio Division"]},
      {"area_id": "bishan_fire", "label": "Bishan Fire Station (SCDF)", "type": "fire_station", "at_capacity": true, "problem": "All appliances committed; no additional fire/rescue units available.", "active": true, "managed": false, "aliases": ["Bishan Fire", "SCDF Bishan"]}
    ]
  }'::jsonb
  WHERE scenario_id = scenario_uuid AND variant_label = 'north_congested';

  -- service_road_blocked: Bishan Community Hospital and Bishan NPC at capacity
  UPDATE scenario_environmental_seeds
  SET seed_data = seed_data || '{
    "areas": [
      {"area_id": "ttsh", "label": "Tan Tock Seng Hospital", "type": "hospital", "at_capacity": false, "aliases": ["TTSH", "Tan Tock Seng"]},
      {"area_id": "bch", "label": "Bishan Community Hospital", "type": "hospital", "at_capacity": true, "problem": "At full capacity; no additional beds.", "active": true, "managed": false, "aliases": ["BCH", "Bishan Community"]},
      {"area_id": "tpp", "label": "Toa Payoh Polyclinic", "type": "hospital", "at_capacity": false, "aliases": ["TPP", "Toa Payoh Polyclinic"]},
      {"area_id": "bishan_north_npc", "label": "Bishan North NPC", "type": "police", "at_capacity": true, "problem": "Fully committed; no additional units available.", "active": true, "managed": false, "aliases": ["BNNPC", "Bishan North"]},
      {"area_id": "toa_payoh_east_npc", "label": "Toa Payoh East NPC", "type": "police", "at_capacity": false, "aliases": ["TPENPC", "Toa Payoh East"]},
      {"area_id": "amk_division_hq", "label": "Ang Mo Kio Division HQ", "type": "police", "at_capacity": false, "aliases": ["AMKDHQ", "Ang Mo Kio Division"]},
      {"area_id": "bishan_fire", "label": "Bishan Fire Station (SCDF)", "type": "fire_station", "at_capacity": false, "aliases": ["Bishan Fire", "SCDF Bishan"]}
    ]
  }'::jsonb
  WHERE scenario_id = scenario_uuid AND variant_label = 'service_road_blocked';

  RAISE NOTICE '068: scenario_environmental_seeds areas updated for C2E (all_clear, north_congested, service_road_blocked).';
END $$;
