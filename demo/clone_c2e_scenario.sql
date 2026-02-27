-- Clone C2E Bombing Scenario - SQL Script
-- Run this in your Supabase SQL Editor to create a copy of the C2E Bombing scenario
-- Clones scenario, injects (with gate refs remapped), teams, objectives, and scenario_gates.
-- Requires migrations 055, 056, 057 for scenario_gates, required_gate_id/required_gate_not_met_id, and scenario geography/insider columns.

DO $$
DECLARE
  original_scenario_id UUID;
  new_scenario_id UUID;
  trainer_user_id UUID;
  inject_count INTEGER;
  team_count INTEGER;
  objective_count INTEGER;
  gate_count INTEGER;
  r RECORD;
  g RECORD;
  new_inject_id UUID;
  new_gate_id UUID;
  old_id_ref UUID;
BEGIN
  SELECT id INTO original_scenario_id
  FROM scenarios
  WHERE title = 'C2E Bombing at Community Event'
  LIMIT 1;

  IF original_scenario_id IS NULL THEN
    RAISE EXCEPTION 'C2E Bombing scenario not found. Please ensure the scenario exists.';
  END IF;

  SELECT id INTO trainer_user_id
  FROM user_profiles
  WHERE role IN ('trainer', 'admin')
  LIMIT 1;

  IF trainer_user_id IS NULL THEN
    RAISE EXCEPTION 'No trainer or admin user found. Please create a user with trainer or admin role first.';
  END IF;

  -- ============================================
  -- STEP 1: Clone the scenario (include geography and insider)
  -- ============================================
  INSERT INTO scenarios (
    id, title, description, category, difficulty, duration_minutes,
    objectives, initial_state, briefing, role_specific_briefs,
    created_by, is_active,
    center_lat, center_lng, vicinity_radius_meters, vicinity_map_url, layout_image_url, insider_knowledge
  )
  SELECT
    gen_random_uuid(),
    title || ' (Copy)',
    description, category, difficulty, duration_minutes,
    objectives, initial_state, briefing, role_specific_briefs,
    trainer_user_id,
    false,
    center_lat, center_lng, vicinity_radius_meters, vicinity_map_url, layout_image_url, insider_knowledge
  FROM scenarios
  WHERE id = original_scenario_id
  RETURNING id INTO new_scenario_id;

  RAISE NOTICE 'Created new scenario: %', new_scenario_id;

  -- ============================================
  -- STEP 2: Clone teams
  -- ============================================
  INSERT INTO scenario_teams (
    scenario_id, team_name, team_description, required_roles, min_participants, max_participants
  )
  SELECT new_scenario_id, team_name, team_description, required_roles, min_participants, max_participants
  FROM scenario_teams
  WHERE scenario_id = original_scenario_id;
  GET DIAGNOSTICS team_count = ROW_COUNT;

  -- ============================================
  -- STEP 3: Clone objectives
  -- ============================================
  INSERT INTO scenario_objectives (
    scenario_id, objective_id, objective_name, description, success_criteria, weight
  )
  SELECT new_scenario_id, objective_id, objective_name, description, success_criteria, weight
  FROM scenario_objectives
  WHERE scenario_id = original_scenario_id;
  GET DIAGNOSTICS objective_count = ROW_COUNT;

  -- ============================================
  -- STEP 4: Clone injects and build old_id -> new_id mapping (required for gates)
  -- ============================================
  CREATE TEMP TABLE IF NOT EXISTS inject_map (
    old_id UUID PRIMARY KEY,
    new_id UUID NOT NULL,
    old_required_gate_id UUID,
    old_required_gate_not_met_id UUID
  );

  FOR r IN
    SELECT id, trigger_time_minutes, trigger_condition, type, title, content, severity,
           affected_roles, inject_scope, target_teams, requires_response, requires_coordination,
           ai_generated, required_gate_id, required_gate_not_met_id
  FROM scenario_injects
  WHERE scenario_id = original_scenario_id
  LOOP
    INSERT INTO scenario_injects (
      scenario_id, trigger_time_minutes, trigger_condition, type, title, content, severity,
      affected_roles, inject_scope, target_teams, requires_response, requires_coordination,
      ai_generated, required_gate_id, required_gate_not_met_id
    )
    VALUES (
      new_scenario_id, r.trigger_time_minutes, r.trigger_condition, r.type, r.title, r.content, r.severity,
      r.affected_roles, r.inject_scope, r.target_teams, r.requires_response, r.requires_coordination,
      COALESCE(r.ai_generated, false),
      NULL, NULL
    )
    RETURNING id INTO new_inject_id;
    INSERT INTO inject_map (old_id, new_id, old_required_gate_id, old_required_gate_not_met_id)
    VALUES (r.id, new_inject_id, r.required_gate_id, r.required_gate_not_met_id)
    ON CONFLICT (old_id) DO NOTHING;
  END LOOP;
  SELECT COUNT(*) INTO inject_count FROM scenario_injects WHERE scenario_id = new_scenario_id;

  -- ============================================
  -- STEP 5: Clone scenario_gates with remapped inject IDs
  -- ============================================
  CREATE TEMP TABLE IF NOT EXISTS gate_map (old_id UUID PRIMARY KEY, new_id UUID NOT NULL);

  FOR g IN
    SELECT id, gate_id, gate_order, check_at_minutes, condition,
           if_not_met_inject_ids, if_met_inject_id, if_vague_decision_inject_id, objective_id
    FROM scenario_gates
    WHERE scenario_id = original_scenario_id
  LOOP
    INSERT INTO scenario_gates (
      scenario_id, gate_id, gate_order, check_at_minutes, condition,
      if_not_met_inject_ids, if_met_inject_id, if_vague_decision_inject_id, objective_id
    )
    VALUES (
      new_scenario_id,
      g.gate_id,
      g.gate_order,
      g.check_at_minutes,
      g.condition,
      (SELECT array_agg(im.new_id) FROM inject_map im WHERE im.old_id = ANY(COALESCE(g.if_not_met_inject_ids, ARRAY[]::uuid[]))),
      (SELECT im.new_id FROM inject_map im WHERE im.old_id = g.if_met_inject_id LIMIT 1),
      (SELECT im.new_id FROM inject_map im WHERE im.old_id = g.if_vague_decision_inject_id LIMIT 1),
      g.objective_id
    )
    RETURNING id INTO new_gate_id;
    INSERT INTO gate_map (old_id, new_id) VALUES (g.id, new_gate_id) ON CONFLICT (old_id) DO NOTHING;
  END LOOP;
  SELECT COUNT(*) INTO gate_count FROM scenario_gates WHERE scenario_id = new_scenario_id;

  -- ============================================
  -- STEP 6: Set required_gate_id and required_gate_not_met_id on cloned injects
  -- ============================================
  UPDATE scenario_injects si
  SET
    required_gate_id = gm_req.new_id,
    required_gate_not_met_id = gm_notmet.new_id
  FROM inject_map im
  LEFT JOIN gate_map gm_req ON gm_req.old_id = im.old_required_gate_id
  LEFT JOIN gate_map gm_notmet ON gm_notmet.old_id = im.old_required_gate_not_met_id
  WHERE si.id = im.new_id
    AND si.scenario_id = new_scenario_id
    AND (im.old_required_gate_id IS NOT NULL OR im.old_required_gate_not_met_id IS NOT NULL);

  DROP TABLE IF EXISTS inject_map;
  DROP TABLE IF EXISTS gate_map;

  RAISE NOTICE 'Cloning complete. Scenario: %; injects: %; teams: %; objectives: %; gates: %',
    new_scenario_id, inject_count, team_count, objective_count, gate_count;
END $$;

-- Display the cloned scenario
SELECT 
  'Cloned Scenario' as status,
  id,
  title,
  created_at
FROM scenarios
WHERE title = 'C2E Bombing at Community Event (Copy)'
ORDER BY created_at DESC
LIMIT 1;

-- Display summary
SELECT 
  'Summary' as info,
  (SELECT COUNT(*) FROM scenario_injects si 
   JOIN scenarios s ON s.id = si.scenario_id 
   WHERE s.title = 'C2E Bombing at Community Event (Copy)') as inject_count,
  (SELECT COUNT(*) FROM scenario_teams st 
   JOIN scenarios s ON s.id = st.scenario_id 
   WHERE s.title = 'C2E Bombing at Community Event (Copy)') as team_count,
  (SELECT COUNT(*) FROM scenario_objectives so 
   JOIN scenarios s ON s.id = so.scenario_id 
   WHERE s.title = 'C2E Bombing at Community Event (Copy)') as objective_count,
  (SELECT COUNT(*) FROM scenario_gates sg 
   JOIN scenarios s ON s.id = sg.scenario_id 
   WHERE s.title = 'C2E Bombing at Community Event (Copy)') as gate_count;

