-- C2E Triage Updates: MCI standards, gate hints, hospital tiers, narrative injects
-- Run after 100. Idempotent where possible.

DO $$
DECLARE
  scenario_uuid UUID;
  inj_proactive UUID;
  inj_casualties_1 UUID;
  inj_casualties_2 UUID;
  inj_pressure UUID;
  current_standards TEXT;
  mci_triage_text TEXT := ' Triage (WHO MCI / START): Staff-to-critical 1:5; use START protocol (walking→Green, breathing/capillary refill/commands→Red/Yellow); triage zone capacity ~50; Red patients transport first; distribute to multiple hospitals (trauma center 30–40% red, community hospital for Yellow, polyclinic for Green); real-time hospital communication. Safety: triage site 100–200 m from blast; hot/warm/cold zone separation; bomb sweep before setup.';
BEGIN
  SELECT id INTO scenario_uuid
  FROM scenarios
  WHERE title = 'C2E Bombing at Community Event'
  LIMIT 1;

  IF scenario_uuid IS NULL THEN
    RAISE NOTICE '101: C2E Bombing scenario not found; skipping.';
    RETURN;
  END IF;

  -- ============================================
  -- 1. Expand triage gate content_hints (START, zones, ratios)
  -- ============================================
  UPDATE scenario_gates
  SET condition = jsonb_set(
    COALESCE(condition, '{}'::jsonb),
    '{content_hints}',
    '["triage", "casualty", "zone", "area", "route", "situation report", "sitrep", "corridor", "access", "evacuation", "ambulance", "hospital", "capacity", "start", "red", "yellow", "green", "immediate", "delayed", "priority", "staff", "ratio", "1:5"]'::jsonb
  )
  WHERE scenario_id = scenario_uuid AND gate_id = 'triage_situation_report';

  -- ============================================
  -- 2. Append MCI triage standards to sector_standards
  -- ============================================
  SELECT (insider_knowledge->>'sector_standards')::TEXT INTO current_standards
  FROM scenarios WHERE id = scenario_uuid;

  IF current_standards IS NULL THEN
    current_standards := '';
  END IF;

  IF current_standards NOT LIKE '%WHO MCI%' AND current_standards NOT LIKE '%START protocol%' THEN
    UPDATE scenarios
    SET insider_knowledge = jsonb_set(
      COALESCE(insider_knowledge, '{}'::jsonb),
      '{sector_standards}',
      to_jsonb((current_standards || mci_triage_text)::TEXT)
    )
    WHERE id = scenario_uuid;
    RAISE NOTICE '101: Appended MCI triage standards to sector_standards.';
  END IF;

  -- ============================================
  -- 3. Add hospital tiers to scenario_locations
  -- ============================================
  UPDATE scenario_locations
  SET conditions = COALESCE(conditions, '{}'::jsonb) || '{"hospital_tier": "major_trauma", "accepts_red": true, "accepts_yellow": true}'::jsonb
  WHERE scenario_id = scenario_uuid
    AND location_type = 'hospital'
    AND (label ILIKE '%Tan Tock Seng%' OR label ILIKE '%TTSH%');

  UPDATE scenario_locations
  SET conditions = COALESCE(conditions, '{}'::jsonb) || '{"hospital_tier": "community", "accepts_red": false, "accepts_yellow": true, "accepts_green": true}'::jsonb
  WHERE scenario_id = scenario_uuid
    AND location_type = 'hospital'
    AND (label ILIKE '%Bishan Community%' OR label ILIKE '%BCH%');

  UPDATE scenario_locations
  SET conditions = COALESCE(conditions, '{}'::jsonb) || '{"hospital_tier": "minor_clinic", "accepts_red": false, "accepts_yellow": false, "accepts_green": true}'::jsonb
  WHERE scenario_id = scenario_uuid
    AND location_type = 'hospital'
    AND (label ILIKE '%Toa Payoh Polyclinic%' OR label ILIKE '%TPP%');

  -- ============================================
  -- 4. Update triage vague inject content
  -- ============================================
  UPDATE scenario_injects
  SET content = 'The triage decision submitted does not contain enough specific detail. Please specify: casualty zones (Red/Yellow/Green), protocol (e.g. START), staff-to-patient ratio, and transport priorities.'
  WHERE scenario_id = scenario_uuid
    AND title = 'Triage report too vague – specify casualty zones and routes';

  -- ============================================
  -- 5. Proactive coordination centre request inject (T+7)
  -- ============================================
  SELECT id INTO inj_proactive FROM scenario_injects
  WHERE scenario_id = scenario_uuid AND title = 'Coordination centre requests triage situation report' LIMIT 1;

  IF inj_proactive IS NULL THEN
    INSERT INTO scenario_injects (
      scenario_id, trigger_time_minutes, type, title, content, severity,
      inject_scope, target_teams, requires_response, requires_coordination
    ) VALUES (
      scenario_uuid, 7, 'field_update',
      'Coordination centre requests triage situation report',
      'The coordination centre needs your triage situation report. Include: protocol (e.g. START), casualty zones (Red/Yellow/Green), staff allocation, and transport priorities. This will help align medical response with evacuation.',
      'medium',
      'team_specific', ARRAY['triage'], true, true
    );
    RAISE NOTICE '101: Added proactive coordination centre request inject (T+7).';
  END IF;

  -- ============================================
  -- 6. Narrative patient injects (Tier 2)
  -- ============================================
  SELECT id INTO inj_casualties_1 FROM scenario_injects
  WHERE scenario_id = scenario_uuid AND title = 'Casualties arriving at collection point' LIMIT 1;

  IF inj_casualties_1 IS NULL THEN
    INSERT INTO scenario_injects (
      scenario_id, trigger_time_minutes, type, title, content, severity,
      inject_scope, target_teams, requires_response, requires_coordination
    ) VALUES (
      scenario_uuid, 8, 'field_update',
      'Casualties arriving at collection point',
      'Volunteers are bringing casualties to the collection point. Multiple people with visible injuries. One person is being carried—breathing appears laboured. Others are walking with assistance. Smoke is still affecting visibility. Prioritise using standard protocol and direct flow to appropriate zones.',
      'high',
      'team_specific', ARRAY['triage'], true, true
    );
    RAISE NOTICE '101: Added narrative inject: Casualties arriving at collection point (T+8).';
  END IF;

  SELECT id INTO inj_casualties_2 FROM scenario_injects
  WHERE scenario_id = scenario_uuid AND title = 'Additional casualties—one critical' LIMIT 1;

  IF inj_casualties_2 IS NULL THEN
    INSERT INTO scenario_injects (
      scenario_id, trigger_time_minutes, type, title, content, severity,
      inject_scope, target_teams, requires_response, requires_coordination
    ) VALUES (
      scenario_uuid, 11, 'field_update',
      'Additional casualties—one critical',
      'A volunteer reports: "We found someone near the blast—unconscious, not responding. Breathing is very fast." Another casualty is sitting against the wall, conscious, with a leg wound. More walking wounded are arriving.',
      'high',
      'team_specific', ARRAY['triage'], true, true
    );
    RAISE NOTICE '101: Added narrative inject: Additional casualties—one critical (T+11).';
  END IF;

  SELECT id INTO inj_pressure FROM scenario_injects
  WHERE scenario_id = scenario_uuid AND title = 'Triage area under pressure' LIMIT 1;

  IF inj_pressure IS NULL THEN
    INSERT INTO scenario_injects (
      scenario_id, trigger_time_minutes, type, title, content, severity,
      inject_scope, target_teams, requires_response, requires_coordination
    ) VALUES (
      scenario_uuid, 14, 'field_update',
      'Triage area under pressure',
      'The triage area is filling up. Volunteers report bandages and gauze running low. Several patients are waiting. One family is asking when their relative will be transported.',
      'medium',
      'team_specific', ARRAY['triage'], true, false
    );
    RAISE NOTICE '101: Added narrative inject: Triage area under pressure (T+14).';
  END IF;

  RAISE NOTICE '101: C2E triage updates complete.';
END $$;
