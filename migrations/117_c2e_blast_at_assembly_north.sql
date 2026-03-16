-- Second device detonation at Assembly North — the biggest evacuation holding area.
-- The first bomb (stage/sound system) stays untouched.
-- When the second device detonates:
--   1. Assembly North becomes a blast zone (unusable)
--   2. A second blast_site pin appears on the map
--   3. The existing detonation injects get updated content referencing Assembly North
--   4. state_effect on the detonation injects updates current_state (casualties, route disruption)
--   5. ~5 post-detonation injects fire to extend gameplay
--   6. New overflow locations become available (car park, void deck, school, bus interchange)

DO $$
DECLARE
  scenario_uuid UUID;
  inj_populated_id UUID;
  inj_cleared_id UUID;
BEGIN
  SELECT id INTO scenario_uuid
  FROM scenarios
  WHERE title = 'C2E Bombing at Community Event'
  LIMIT 1;

  IF scenario_uuid IS NULL THEN
    RAISE NOTICE '117: C2E scenario not found; skipping.';
    RETURN;
  END IF;

  -- =========================================================================
  -- 1. Update existing second-device detonation inject content to reference
  --    Assembly North specifically.
  -- =========================================================================

  UPDATE scenario_injects
  SET content = 'A SECOND EXPLOSION at Assembly North — the main evacuation holding area near the North exit. The suicide attacker detonated a person-borne device among the gathered evacuees. Assembly North is destroyed. Debris and casualties across the holding area. The North exit approach is partially blocked by wreckage. Evacuees are fleeing in all directions. Additional casualties and serious injuries are reported. Panic has intensified across all zones. Emergency services are still en route.',
      state_effect = jsonb_build_object(
        'evacuation_state', jsonb_build_object(
          'exits_congested', jsonb_build_array('North exit'),
          'assembly_north_destroyed', true
        ),
        'triage_state', jsonb_build_object(
          'casualties', 25,
          'surge_active', true,
          'patients_waiting', 15
        ),
        'media_state', jsonb_build_object(
          'sentiment_nudge', -2
        )
      )
  WHERE scenario_id = scenario_uuid
    AND title = 'Second device detonates (area populated)';

  UPDATE scenario_injects
  SET content = 'A SECOND EXPLOSION at Assembly North. The suicide attacker detonated a person-borne device at the holding area — but the area had already been cordoned and cleared. There are no additional casualties from this blast. However, the explosion has destroyed the Assembly North shelters and seating, partially blocked the North exit approach with debris, and caused further panic among evacuees at other holding areas. Assembly North is now completely unusable.',
      state_effect = jsonb_build_object(
        'evacuation_state', jsonb_build_object(
          'exits_congested', jsonb_build_array('North exit'),
          'assembly_north_destroyed', true
        ),
        'media_state', jsonb_build_object(
          'sentiment_nudge', -1
        )
      )
  WHERE scenario_id = scenario_uuid
    AND title = 'Second device detonates (area cleared)';

  -- Capture IDs for the detonation injects (needed for conditions on follow-up injects)
  SELECT id INTO inj_populated_id FROM scenario_injects
  WHERE scenario_id = scenario_uuid AND title = 'Second device detonates (area populated)' LIMIT 1;

  SELECT id INTO inj_cleared_id FROM scenario_injects
  WHERE scenario_id = scenario_uuid AND title = 'Second device detonates (area cleared)' LIMIT 1;

  -- =========================================================================
  -- 2. Add a second blast_site pin on the map at Assembly North's location.
  --    This only shows after the second detonation (but since scenario_locations
  --    are static, we add it now with a label that makes its purpose clear).
  -- =========================================================================

  INSERT INTO scenario_locations (scenario_id, location_type, label, coordinates, conditions, display_order)
  SELECT scenario_uuid, 'blast_site', 'Second blast (Assembly North)',
    '{"lat": 1.3498, "lng": 103.8519}'::jsonb,
    '{"cordon_rule": "No entry; second device detonation site. Assembly North destroyed.", "pin_category": "incident_site", "blast_zone": true, "visible_after_state_key": "evacuation_state.assembly_north_destroyed"}'::jsonb,
    1
  WHERE NOT EXISTS (
    SELECT 1 FROM scenario_locations
    WHERE scenario_id = scenario_uuid AND label = 'Second blast (Assembly North)'
  );

  -- =========================================================================
  -- 3. Mark Assembly North as destroyed in its conditions (capacity 0).
  --    Note: state_effect on the detonation inject handles runtime state;
  --    this updates the static pin so the insider/AI knows it's gone.
  -- =========================================================================

  -- Add a custom fact about the second blast site for the insider
  UPDATE scenarios
  SET insider_knowledge = (
    SELECT jsonb_set(
      insider_knowledge,
      '{custom_facts}',
      insider_knowledge->'custom_facts' || jsonb_build_array(
        jsonb_build_object(
          'topic', 'second_blast_site',
          'summary', 'Second device detonated at Assembly North — the largest evacuation holding area.',
          'detail', 'A person-borne device (suicide attacker) detonated at Assembly North, the largest evacuation holding area (formerly capacity 200) near the North exit. Assembly North is destroyed and unusable. The North exit approach is partially blocked by debris. Evacuees must be redirected to alternative holding areas: Holding East, Staging South, or the new overflow locations (multi-storey car park rooftop, void deck, school compound, bus interchange). Second blast cordon extends 20 m from Assembly North.'
        )
      )
    )
  )
  WHERE id = scenario_uuid;

  -- =========================================================================
  -- 4. Post-second-blast injects (~5) — fire after either detonation outcome.
  --    These use eligible_after_minutes and conditions_to_appear to trigger
  --    after the second device has detonated (either outcome).
  -- =========================================================================

  -- 4a. Triage surge from second blast (targets triage team)
  INSERT INTO scenario_injects (
    scenario_id, trigger_time_minutes, type, title, content, severity,
    affected_roles, inject_scope, target_teams, requires_response, requires_coordination,
    eligible_after_minutes
  )
  SELECT scenario_uuid, NULL, 'field_update',
    'Mass casualty surge from second blast',
    'The second explosion at Assembly North has produced a wave of new casualties. Walking wounded are streaming toward your triage area. At least 15 additional patients with blast injuries — burns, shrapnel wounds, concussive trauma — need immediate assessment. Your triage site is at risk of being overwhelmed. You need to expand capacity or establish a secondary triage point at one of the overflow areas.',
    'critical',
    '[]'::jsonb, 'team_specific', ARRAY['triage'], true, true,
    22
  WHERE NOT EXISTS (
    SELECT 1 FROM scenario_injects
    WHERE scenario_id = scenario_uuid AND title = 'Mass casualty surge from second blast'
  );

  -- 4b. North exit partially blocked (targets evacuation team)
  INSERT INTO scenario_injects (
    scenario_id, trigger_time_minutes, type, title, content, severity,
    affected_roles, inject_scope, target_teams, requires_response, requires_coordination,
    eligible_after_minutes
  )
  SELECT scenario_uuid, NULL, 'field_update',
    'North exit approach blocked by debris',
    'The second explosion at Assembly North has scattered debris across the North exit approach road. Carpark bay A is obstructed. Ambulances and vehicles can no longer use the North exit route without clearance. Evacuees attempting to leave via the North exit are being turned back. You need to redirect evacuee flow to East exit or South exit, and identify alternate vehicle access for emergency services.',
    'high',
    '[]'::jsonb, 'team_specific', ARRAY['evacuation'], true, true,
    22
  WHERE NOT EXISTS (
    SELECT 1 FROM scenario_injects
    WHERE scenario_id = scenario_uuid AND title = 'North exit approach blocked by debris'
  );

  -- 4c. Stampede at remaining holding areas (universal)
  INSERT INTO scenario_injects (
    scenario_id, trigger_time_minutes, type, title, content, severity,
    affected_roles, inject_scope, target_teams, requires_response, requires_coordination,
    eligible_after_minutes
  )
  SELECT scenario_uuid, NULL, 'field_update',
    'Stampede risk at remaining holding areas',
    'Evacuees who were at Assembly North have fled to Holding East and Staging South. Both areas are now dangerously overcrowded — capacity is being exceeded. Volunteers report pushing, shouting, and several people have fallen. A stampede is imminent unless crowd control is established. The overflow locations (multi-storey car park rooftop, void deck at Block 123, Bishan Park School compound) may need to be activated.',
    'critical',
    '[]'::jsonb, 'universal', NULL, true, true,
    23
  WHERE NOT EXISTS (
    SELECT 1 FROM scenario_injects
    WHERE scenario_id = scenario_uuid AND title = 'Stampede risk at remaining holding areas'
  );

  -- 4d. Emergency services rerouted (universal)
  INSERT INTO scenario_injects (
    scenario_id, trigger_time_minutes, type, title, content, severity,
    affected_roles, inject_scope, target_teams, requires_response, requires_coordination,
    eligible_after_minutes
  )
  SELECT scenario_uuid, NULL, 'field_update',
    'Emergency services forced to reroute',
    'Ambulances and SCDF assets that were approaching via Bishan Street 13 (north corridor) can no longer reach the North exit due to debris. They are requesting alternate access instructions. The East exit via the community club driveway can take one vehicle at a time. The South exit has no vehicle access. Coordinate with emergency services to establish a new casualty evacuation point — the bus interchange east of the site may be usable.',
    'high',
    '[]'::jsonb, 'universal', NULL, true, true,
    24
  WHERE NOT EXISTS (
    SELECT 1 FROM scenario_injects
    WHERE scenario_id = scenario_uuid AND title = 'Emergency services forced to reroute'
  );

  -- 4e. Media firestorm — second bomb confirmed (targets media team)
  INSERT INTO scenario_injects (
    scenario_id, trigger_time_minutes, type, title, content, severity,
    affected_roles, inject_scope, target_teams, requires_response, requires_coordination,
    eligible_after_minutes
  )
  SELECT scenario_uuid, NULL, 'media_report',
    'Second bomb confirmed — media firestorm',
    'News of the second explosion is spreading uncontrollably. Multiple live streams show the destroyed Assembly North area. Headlines read: "SECOND BOMB AT COMMUNITY EVENT — MASS CASUALTIES FEARED". Social media is in uproar. Journalists on site are demanding an immediate statement. International wire services are picking up the story. The earlier misinformation about Malay involvement is being amplified alongside the new attack. You must issue a public statement addressing the second blast, casualty status, and counter the escalating misinformation — immediately.',
    'critical',
    '[]'::jsonb, 'team_specific', ARRAY['media'], true, true,
    23
  WHERE NOT EXISTS (
    SELECT 1 FROM scenario_injects
    WHERE scenario_id = scenario_uuid AND title = 'Second bomb confirmed — media firestorm'
  );

  -- =========================================================================
  -- 5. New overflow scenario_locations — hidden until the second blast.
  --    visible_after_state_key keeps them off the map until assembly_north_destroyed.
  -- =========================================================================

  -- 5a. Multi-storey car park rooftop (north-west, vehicle accessible)
  INSERT INTO scenario_locations (scenario_id, location_type, label, coordinates, conditions, display_order)
  SELECT scenario_uuid, 'evacuation_holding', 'Multi-storey car park rooftop',
    '{"lat": 1.3503, "lng": 103.8512}'::jsonb,
    '{"capacity": 250, "suitability": "medium", "nearest_exit": "North exit", "has_cover": false, "water": false, "power": false, "vehicle_access": true, "distance_from_blast_m": 120, "hazards": "Open rooftop; no shade or shelter. Wind exposure. Access via car park ramp only — may cause bottleneck. No water or power on site.", "notes": "Large open area suitable for overflow if ground-level areas are compromised.", "visible_after_state_key": "evacuation_state.assembly_north_destroyed"}'::jsonb,
    40
  WHERE NOT EXISTS (
    SELECT 1 FROM scenario_locations
    WHERE scenario_id = scenario_uuid AND label = 'Multi-storey car park rooftop'
  );

  -- 5b. Void deck Block 123 (south-east, sheltered, small)
  INSERT INTO scenario_locations (scenario_id, location_type, label, coordinates, conditions, display_order)
  SELECT scenario_uuid, 'evacuation_holding', 'Void deck Block 123',
    '{"lat": 1.3476, "lng": 103.8526}'::jsonb,
    '{"capacity": 80, "suitability": "medium", "nearest_exit": "South exit", "has_cover": true, "water": true, "power": true, "vehicle_access": false, "distance_from_blast_m": 150, "hazards": "Confined space; narrow access. Residents may object to use. Limited ventilation.", "notes": "Sheltered ground-floor area under HDB block. Water and power available from building utilities. No vehicle access — pedestrian only.", "visible_after_state_key": "evacuation_state.assembly_north_destroyed"}'::jsonb,
    41
  WHERE NOT EXISTS (
    SELECT 1 FROM scenario_locations
    WHERE scenario_id = scenario_uuid AND label = 'Void deck Block 123'
  );

  -- 5c. Bishan Park School compound (south, large, far)
  INSERT INTO scenario_locations (scenario_id, location_type, label, coordinates, conditions, display_order)
  SELECT scenario_uuid, 'evacuation_holding', 'School compound (Bishan Park)',
    '{"lat": 1.3468, "lng": 103.8519}'::jsonb,
    '{"capacity": 400, "suitability": "high", "nearest_exit": "South exit", "has_cover": true, "water": true, "power": true, "vehicle_access": true, "distance_from_blast_m": 250, "hazards": "Far from incident site (250 m). Need to coordinate with school authorities for access. Assembly hall can serve as indoor shelter.", "notes": "Large indoor and outdoor space. Full utilities. Vehicle access via school gate on south road. Best option for extended holding if situation persists.", "visible_after_state_key": "evacuation_state.assembly_north_destroyed"}'::jsonb,
    42
  WHERE NOT EXISTS (
    SELECT 1 FROM scenario_locations
    WHERE scenario_id = scenario_uuid AND label = 'School compound (Bishan Park)'
  );

  -- 5d. Bus interchange (east, vehicle accessible, exposed)
  INSERT INTO scenario_locations (scenario_id, location_type, label, coordinates, conditions, display_order)
  SELECT scenario_uuid, 'evacuation_holding', 'Bus interchange (east)',
    '{"lat": 1.3489, "lng": 103.8538}'::jsonb,
    '{"capacity": 300, "suitability": "medium", "nearest_exit": "East exit", "has_cover": true, "water": false, "power": true, "vehicle_access": true, "distance_from_blast_m": 180, "hazards": "Active bus routes may need to be suspended. Public present — crowd management required. No dedicated water supply.", "notes": "Covered bus bays provide shelter. Vehicle access excellent — multiple bays for ambulance staging. Power from interchange grid. Can serve as alternate casualty evacuation point for ambulances if North exit is blocked.", "visible_after_state_key": "evacuation_state.assembly_north_destroyed"}'::jsonb,
    43
  WHERE NOT EXISTS (
    SELECT 1 FROM scenario_locations
    WHERE scenario_id = scenario_uuid AND label = 'Bus interchange (east)'
  );

  -- Patch existing rows that were inserted without the visibility condition
  UPDATE scenario_locations
  SET conditions = conditions || '{"visible_after_state_key": "evacuation_state.assembly_north_destroyed"}'::jsonb
  WHERE scenario_id = scenario_uuid
    AND label IN ('Multi-storey car park rooftop', 'Void deck Block 123', 'School compound (Bishan Park)', 'Bus interchange (east)', 'Second blast (Assembly North)')
    AND NOT (conditions ? 'visible_after_state_key');

  RAISE NOTICE '117: Second device at Assembly North — updated detonation injects, added blast pin, 5 post-blast injects, 4 overflow locations (all hidden until blast).';
END $$;
