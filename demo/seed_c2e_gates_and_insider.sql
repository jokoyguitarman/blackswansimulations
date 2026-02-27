-- C2E Bombing – Gates, punishment/success/vague injects, minimal brief, insider knowledge
-- Run AFTER demo/seed_c2e_scenario.sql and migrations 025 (decision-based injects), 055, 056, 057.
-- Idempotent: updates scenario and injects by title/scenario; skips gate/inject inserts if already present.

DO $$
DECLARE
  scenario_uuid UUID;
  inj_evac_punish UUID;
  inj_evac_success UUID;
  inj_evac_vague UUID;
  inj_triage_punish UUID;
  inj_triage_success UUID;
  inj_triage_vague UUID;
  inj_media_punish UUID;
  inj_media_success UUID;
  inj_media_vague UUID;
  gate_evac_id UUID;
  gate_triage_id UUID;
  gate_media_id UUID;
  has_vague_column BOOLEAN;
BEGIN
  SELECT id INTO scenario_uuid
  FROM scenarios
  WHERE title = 'C2E Bombing at Community Event'
  LIMIT 1;

  IF scenario_uuid IS NULL THEN
    RAISE EXCEPTION 'C2E Bombing scenario not found. Run demo/seed_c2e_scenario.sql first.';
  END IF;

  -- ============================================
  -- Update scenario: minimal brief, task wording, insider_knowledge
  -- ============================================
  UPDATE scenarios
  SET
    briefing = 'You are the Community Emergency and Engagement (C2E) Committee responding to an incident at a community event. Coordinate with your team; details will emerge via updates and cross-team communication. Do not assume you have full situational awareness from this brief.',
    role_specific_briefs = jsonb_build_object(
      'evacuation', 'Your deliverable: produce an evacuation plan that cites exits, ground zero, and flow. Gather details from injects and other teams before submitting.',
      'triage', 'Your deliverable: produce a triage situation report (casualty zones, routes). Base it on injects and cross-team information.',
      'media', 'Your deliverable: issue a first public statement based on verified facts. Coordinate with Evac and Triage before going public.'
    ),
    insider_knowledge = jsonb_build_object(
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
        jsonb_build_object('topic', 'event', 'summary', 'Community event at neighbourhood hard court, ~1000 participants.', 'detail', 'Large grassroots community event at a neighbourhood hard court. Central seating area near the detonation point.')
      )
    )
  WHERE id = scenario_uuid;

  -- ============================================
  -- Insert gate-only injects (no trigger_time_minutes; scheduler never fires by time)
  -- ============================================

  -- Evac: punishment, success, vague
  SELECT id INTO inj_evac_punish FROM scenario_injects
  WHERE scenario_id = scenario_uuid AND title = 'Coordination failure – no evacuation situation report received' LIMIT 1;
  IF inj_evac_punish IS NULL THEN
    INSERT INTO scenario_injects (
      scenario_id, trigger_time_minutes, type, title, content, severity,
      affected_roles, inject_scope, target_teams, requires_response, requires_coordination
    ) VALUES (
      scenario_uuid, NULL, 'field_update',
      'Coordination failure – no evacuation situation report received',
      'No evacuation situation report has been received from the Evacuation Team by the expected time. Coordination is impaired. Who is in charge of evacuation? Confusion at the evacuation points is increasing.',
      'critical',
      '[]'::jsonb, 'universal', NULL, true, true
    )
    RETURNING id INTO inj_evac_punish;
  END IF;

  SELECT id INTO inj_evac_success FROM scenario_injects
  WHERE scenario_id = scenario_uuid AND title = 'Evacuation plan received' LIMIT 1;
  IF inj_evac_success IS NULL THEN
    INSERT INTO scenario_injects (
      scenario_id, trigger_time_minutes, type, title, content, severity,
      affected_roles, inject_scope, target_teams, requires_response, requires_coordination
    ) VALUES (
      scenario_uuid, NULL, 'field_update',
      'Evacuation plan received',
      'The Evacuation Team has submitted a situation report. Coordination centre acknowledges the plan. Proceed with Phase 1 updates.',
      'medium',
      '[]'::jsonb, 'universal', NULL, false, false
    )
    RETURNING id INTO inj_evac_success;
  END IF;

  SELECT id INTO inj_evac_vague FROM scenario_injects
  WHERE scenario_id = scenario_uuid AND title = 'Evacuation plan too vague – specify exits and ground zero' LIMIT 1;
  IF inj_evac_vague IS NULL THEN
    INSERT INTO scenario_injects (
      scenario_id, trigger_time_minutes, type, title, content, severity,
      affected_roles, inject_scope, target_teams, requires_response, requires_coordination
    ) VALUES (
      scenario_uuid, NULL, 'field_update',
      'Evacuation plan too vague – specify exits and ground zero',
      'The evacuation decision submitted does not contain enough specific detail. Please specify exits, ground zero location, and flow so coordination can proceed.',
      'high',
      '[]'::jsonb, 'team_specific', ARRAY['evacuation'], true, false
    )
    RETURNING id INTO inj_evac_vague;
  END IF;

  -- Triage: punishment, success, vague
  SELECT id INTO inj_triage_punish FROM scenario_injects
  WHERE scenario_id = scenario_uuid AND title = 'No triage situation report received' LIMIT 1;
  IF inj_triage_punish IS NULL THEN
    INSERT INTO scenario_injects (
      scenario_id, trigger_time_minutes, type, title, content, severity,
      affected_roles, inject_scope, target_teams, requires_response, requires_coordination
    ) VALUES (
      scenario_uuid, NULL, 'field_update',
      'No triage situation report received',
      'No triage situation report has been received from the Triage Team. Medical coordination is unclear. Casualty zones and routes are not formally reported.',
      'critical',
      '[]'::jsonb, 'universal', NULL, true, true
    )
    RETURNING id INTO inj_triage_punish;
  END IF;

  SELECT id INTO inj_triage_success FROM scenario_injects
  WHERE scenario_id = scenario_uuid AND title = 'Triage situation report received' LIMIT 1;
  IF inj_triage_success IS NULL THEN
    INSERT INTO scenario_injects (
      scenario_id, trigger_time_minutes, type, title, content, severity,
      affected_roles, inject_scope, target_teams, requires_response, requires_coordination
    ) VALUES (
      scenario_uuid, NULL, 'field_update',
      'Triage situation report received',
      'The Triage Team has submitted a situation report. Coordination centre acknowledges. Medical response can be aligned with evacuation.',
      'medium',
      '[]'::jsonb, 'universal', NULL, false, false
    )
    RETURNING id INTO inj_triage_success;
  END IF;

  SELECT id INTO inj_triage_vague FROM scenario_injects
  WHERE scenario_id = scenario_uuid AND title = 'Triage report too vague – specify casualty zones and routes' LIMIT 1;
  IF inj_triage_vague IS NULL THEN
    INSERT INTO scenario_injects (
      scenario_id, trigger_time_minutes, type, title, content, severity,
      affected_roles, inject_scope, target_teams, requires_response, requires_coordination
    ) VALUES (
      scenario_uuid, NULL, 'field_update',
      'Triage report too vague – specify casualty zones and routes',
      'The triage decision submitted does not contain enough specific detail. Please specify casualty zones and routes so coordination can proceed.',
      'high',
      '[]'::jsonb, 'team_specific', ARRAY['triage'], true, false
    )
    RETURNING id INTO inj_triage_vague;
  END IF;

  -- Media: punishment, success, vague
  SELECT id INTO inj_media_punish FROM scenario_injects
  WHERE scenario_id = scenario_uuid AND title = 'No first public statement received' LIMIT 1;
  IF inj_media_punish IS NULL THEN
    INSERT INTO scenario_injects (
      scenario_id, trigger_time_minutes, type, title, content, severity,
      affected_roles, inject_scope, target_teams, requires_response, requires_coordination
    ) VALUES (
      scenario_uuid, NULL, 'media_report',
      'No first public statement received',
      'No first public statement has been issued by the Media Team. The information vacuum is being filled by speculation and misinformation. Journalists are demanding an official response.',
      'critical',
      '[]'::jsonb, 'universal', NULL, true, true
    )
    RETURNING id INTO inj_media_punish;
  END IF;

  SELECT id INTO inj_media_success FROM scenario_injects
  WHERE scenario_id = scenario_uuid AND title = 'First public statement received' LIMIT 1;
  IF inj_media_success IS NULL THEN
    INSERT INTO scenario_injects (
      scenario_id, trigger_time_minutes, type, title, content, severity,
      affected_roles, inject_scope, target_teams, requires_response, requires_coordination
    ) VALUES (
      scenario_uuid, NULL, 'media_report',
      'First public statement received',
      'The Media Team has issued a first public statement. Coordination centre acknowledges. Narrative can be aligned with operations.',
      'medium',
      '[]'::jsonb, 'universal', NULL, false, false
    )
    RETURNING id INTO inj_media_success;
  END IF;

  SELECT id INTO inj_media_vague FROM scenario_injects
  WHERE scenario_id = scenario_uuid AND title = 'Statement too vague – cite verified facts' LIMIT 1;
  IF inj_media_vague IS NULL THEN
    INSERT INTO scenario_injects (
      scenario_id, trigger_time_minutes, type, title, content, severity,
      affected_roles, inject_scope, target_teams, requires_response, requires_coordination
    ) VALUES (
      scenario_uuid, NULL, 'media_report',
      'Statement too vague – cite verified facts',
      'The public statement submitted does not cite verified facts or address misinformation clearly. Please issue a statement that references what is confirmed and what is not.',
      'high',
      '[]'::jsonb, 'team_specific', ARRAY['media'], true, false
    )
    RETURNING id INTO inj_media_vague;
  END IF;

  -- Check if migration 056 (if_vague_decision_inject_id, objective_id) is applied
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'scenario_gates' AND column_name = 'if_vague_decision_inject_id'
  ) INTO has_vague_column;

  -- ============================================
  -- Insert scenario_gates (upsert by scenario_id + gate_id)
  -- ============================================
  IF has_vague_column THEN
    INSERT INTO scenario_gates (
      scenario_id, gate_id, gate_order, check_at_minutes, condition,
      if_not_met_inject_ids, if_met_inject_id, if_vague_decision_inject_id, objective_id
    ) VALUES
      (
        scenario_uuid, 'evac_situation_report', 1, 8,
        '{"team": "evacuation", "decision_types": ["emergency_declaration", "operational_plan"], "content_hints": ["exit", "ground zero", "situation", "evacuation plan", "flow"], "min_hints": 2}'::jsonb,
        ARRAY[inj_evac_punish], inj_evac_success, inj_evac_vague, 'evacuation'
      ),
      (
        scenario_uuid, 'triage_situation_report', 2, 10,
        '{"team": "triage", "decision_types": ["operational_plan", "resource_allocation"], "content_hints": ["triage", "casualty", "zone", "route", "situation report"], "min_hints": 2}'::jsonb,
        ARRAY[inj_triage_punish], inj_triage_success, inj_triage_vague, 'triage'
      ),
      (
        scenario_uuid, 'media_first_statement', 3, 12,
        '{"team": "media", "decision_types": ["public_statement"], "content_hints": ["statement", "public", "verified", "facts", "misinformation"], "min_hints": 1}'::jsonb,
        ARRAY[inj_media_punish], inj_media_success, inj_media_vague, 'media'
      )
    ON CONFLICT (scenario_id, gate_id) DO UPDATE SET
      condition = EXCLUDED.condition,
      check_at_minutes = EXCLUDED.check_at_minutes,
      if_not_met_inject_ids = EXCLUDED.if_not_met_inject_ids,
      if_met_inject_id = EXCLUDED.if_met_inject_id,
      if_vague_decision_inject_id = EXCLUDED.if_vague_decision_inject_id,
      objective_id = EXCLUDED.objective_id;
  ELSE
    INSERT INTO scenario_gates (
      scenario_id, gate_id, gate_order, check_at_minutes, condition,
      if_not_met_inject_ids, if_met_inject_id
    ) VALUES
      (
        scenario_uuid, 'evac_situation_report', 1, 8,
        '{"team": "evacuation", "decision_types": ["emergency_declaration", "operational_plan"], "content_hints": ["exit", "ground zero", "situation", "evacuation plan", "flow"], "min_hints": 2}'::jsonb,
        ARRAY[inj_evac_punish], inj_evac_success
      ),
      (
        scenario_uuid, 'triage_situation_report', 2, 10,
        '{"team": "triage", "decision_types": ["operational_plan", "resource_allocation"], "content_hints": ["triage", "casualty", "zone", "route", "situation report"], "min_hints": 2}'::jsonb,
        ARRAY[inj_triage_punish], inj_triage_success
      ),
      (
        scenario_uuid, 'media_first_statement', 3, 12,
        '{"team": "media", "decision_types": ["public_statement"], "content_hints": ["statement", "public", "verified", "facts", "misinformation"], "min_hints": 1}'::jsonb,
        ARRAY[inj_media_punish], inj_media_success
      )
    ON CONFLICT (scenario_id, gate_id) DO UPDATE SET
      condition = EXCLUDED.condition,
      check_at_minutes = EXCLUDED.check_at_minutes,
      if_not_met_inject_ids = EXCLUDED.if_not_met_inject_ids,
      if_met_inject_id = EXCLUDED.if_met_inject_id;
  END IF;

  SELECT id INTO gate_evac_id FROM scenario_gates WHERE scenario_id = scenario_uuid AND gate_id = 'evac_situation_report' LIMIT 1;
  SELECT id INTO gate_triage_id FROM scenario_gates WHERE scenario_id = scenario_uuid AND gate_id = 'triage_situation_report' LIMIT 1;
  SELECT id INTO gate_media_id FROM scenario_gates WHERE scenario_id = scenario_uuid AND gate_id = 'media_first_statement' LIMIT 1;

  -- ============================================
  -- Set required_gate_id on Phase 1+ time-based injects
  -- ============================================
  -- T+10: Emergency Services Delay, Viral Video – require evac gate
  UPDATE scenario_injects
  SET required_gate_id = gate_evac_id
  WHERE scenario_id = scenario_uuid AND trigger_time_minutes = 10;

  -- T+11: Request to Segregate, Amplified Online Claims – require evac gate
  UPDATE scenario_injects
  SET required_gate_id = gate_evac_id
  WHERE scenario_id = scenario_uuid AND trigger_time_minutes = 11;

  -- T+12: Journalist Arrives, On-Site Filming – require evac; Press Demand – require media gate
  UPDATE scenario_injects
  SET required_gate_id = gate_evac_id
  WHERE scenario_id = scenario_uuid AND trigger_time_minutes = 12 AND title != 'Press Demand for Confirmation';

  UPDATE scenario_injects
  SET required_gate_id = gate_media_id
  WHERE scenario_id = scenario_uuid AND title = 'Press Demand for Confirmation';

  -- T+14: Suspicious Individual – require evac gate
  UPDATE scenario_injects
  SET required_gate_id = gate_evac_id
  WHERE scenario_id = scenario_uuid AND trigger_time_minutes = 14;

  -- T+15: Crowd Tension Escalation, Accusations from a Patient – require evac gate
  UPDATE scenario_injects
  SET required_gate_id = gate_evac_id
  WHERE scenario_id = scenario_uuid AND trigger_time_minutes = 15;

  RAISE NOTICE 'C2E gates and insider seed completed. Scenario: %, gates: evac_situation_report, triage_situation_report, media_first_statement', scenario_uuid;
END $$;
