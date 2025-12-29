-- Clone C2E Bombing Scenario - SQL Script
-- Run this in your Supabase SQL Editor to create a copy of the C2E Bombing scenario
-- This will clone the scenario, all injects, and all teams

DO $$
DECLARE
  original_scenario_id UUID;
  new_scenario_id UUID;
  trainer_user_id UUID;
  inject_count INTEGER;
  team_count INTEGER;
  objective_count INTEGER;
BEGIN
  -- ============================================
  -- STEP 1: Find the original C2E Bombing scenario
  -- ============================================
  
  SELECT id INTO original_scenario_id
  FROM scenarios
  WHERE title = 'C2E Bombing at Community Event'
  LIMIT 1;
  
  IF original_scenario_id IS NULL THEN
    RAISE EXCEPTION 'C2E Bombing scenario not found. Please ensure the scenario exists.';
  END IF;
  
  RAISE NOTICE 'Found original scenario: %', original_scenario_id;
  
  -- ============================================
  -- STEP 2: Get a trainer/admin user ID
  -- ============================================
  
  SELECT id INTO trainer_user_id
  FROM user_profiles
  WHERE role IN ('trainer', 'admin')
  LIMIT 1;
  
  IF trainer_user_id IS NULL THEN
    RAISE EXCEPTION 'No trainer or admin user found. Please create a user with trainer or admin role first.';
  END IF;
  
  RAISE NOTICE 'Using trainer user: %', trainer_user_id;
  
  -- ============================================
  -- STEP 3: Clone the scenario
  -- ============================================
  
  INSERT INTO scenarios (
    id,
    title,
    description,
    category,
    difficulty,
    duration_minutes,
    objectives,
    initial_state,
    briefing,
    role_specific_briefs,
    created_by,
    is_active
  )
  SELECT
    gen_random_uuid(),
    title || ' (Copy)',
    description,
    category,
    difficulty,
    duration_minutes,
    objectives,
    initial_state,
    briefing,
    role_specific_briefs,
    trainer_user_id,
    false  -- Cloned scenarios start as inactive
  FROM scenarios
  WHERE id = original_scenario_id
  RETURNING id INTO new_scenario_id;
  
  RAISE NOTICE 'Created new scenario: %', new_scenario_id;
  
  -- ============================================
  -- STEP 4: Clone all injects
  -- ============================================
  
  INSERT INTO scenario_injects (
    scenario_id,
    trigger_time_minutes,
    trigger_condition,
    type,
    title,
    content,
    severity,
    affected_roles,
    inject_scope,
    target_teams,
    requires_response,
    requires_coordination,
    ai_generated
  )
  SELECT
    new_scenario_id,
    trigger_time_minutes,
    trigger_condition,
    type,
    title,
    content,
    severity,
    affected_roles,
    inject_scope,
    target_teams,
    requires_response,
    requires_coordination,
    ai_generated
  FROM scenario_injects
  WHERE scenario_id = original_scenario_id;
  
  GET DIAGNOSTICS inject_count = ROW_COUNT;
  RAISE NOTICE 'Cloned % inject(s)', inject_count;
  
  -- ============================================
  -- STEP 5: Clone all teams
  -- ============================================
  
  INSERT INTO scenario_teams (
    scenario_id,
    team_name,
    team_description,
    required_roles,
    min_participants,
    max_participants
  )
  SELECT
    new_scenario_id,
    team_name,
    team_description,
    required_roles,
    min_participants,
    max_participants
  FROM scenario_teams
  WHERE scenario_id = original_scenario_id;
  
  GET DIAGNOSTICS team_count = ROW_COUNT;
  RAISE NOTICE 'Cloned % team(s)', team_count;
  
  -- ============================================
  -- STEP 6: Clone objectives (if they exist)
  -- ============================================
  
  INSERT INTO scenario_objectives (
    scenario_id,
    objective_id,
    objective_name,
    description,
    success_criteria,
    weight
  )
  SELECT
    new_scenario_id,
    objective_id,
    objective_name,
    description,
    success_criteria,
    weight
  FROM scenario_objectives
  WHERE scenario_id = original_scenario_id;
  
  GET DIAGNOSTICS objective_count = ROW_COUNT;
  RAISE NOTICE 'Cloned % objective(s)', objective_count;
  
  RAISE NOTICE 'Cloning complete!';
  RAISE NOTICE 'New scenario ID: %', new_scenario_id;
  RAISE NOTICE 'Injects cloned: %', inject_count;
  RAISE NOTICE 'Teams cloned: %', team_count;
  RAISE NOTICE 'Objectives cloned: %', objective_count;
  
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
   WHERE s.title = 'C2E Bombing at Community Event (Copy)') as objective_count;

