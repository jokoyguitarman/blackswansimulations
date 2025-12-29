-- Reset C2E Session - Create a Fresh Session
-- Run this in your Supabase SQL Editor to create a new C2E session
--
-- This script will:
-- 1. Find the C2E Bombing scenario
-- 2. Find a trainer/admin user (or use the trainer from an existing C2E session)
-- 3. Create a new session with the scenario's initial state
-- 4. Create default channels for the session
-- 5. Optionally mark old C2E sessions as 'cancelled' (see comments below)

DO $$
DECLARE
  scenario_uuid UUID;
  trainer_user_id UUID;
  new_session_id UUID;
  scenario_initial_state JSONB;
BEGIN
  -- ============================================
  -- STEP 1: Find the C2E Bombing scenario
  -- ============================================
  
  SELECT id, initial_state INTO scenario_uuid, scenario_initial_state
  FROM scenarios
  WHERE title = 'C2E Bombing at Community Event'
  LIMIT 1;

  IF scenario_uuid IS NULL THEN
    RAISE EXCEPTION 'C2E Bombing scenario not found. Please run demo/seed_c2e_scenario.sql first.';
  END IF;

  RAISE NOTICE 'Found C2E scenario: %', scenario_uuid;

  -- ============================================
  -- STEP 2: Find a trainer user
  -- Priority: Use trainer from existing C2E session, otherwise use any trainer/admin
  -- ============================================
  
  -- First, try to get trainer from an existing C2E session
  SELECT DISTINCT s.trainer_id INTO trainer_user_id
  FROM sessions s
  WHERE s.scenario_id = scenario_uuid
    AND s.trainer_id IS NOT NULL
  LIMIT 1;

  -- If no existing session, get any trainer/admin user
  IF trainer_user_id IS NULL THEN
    SELECT id INTO trainer_user_id
    FROM user_profiles
    WHERE role IN ('trainer', 'admin')
    LIMIT 1;
  END IF;

  IF trainer_user_id IS NULL THEN
    RAISE EXCEPTION 'No trainer or admin user found. Please create a user with trainer or admin role first.';
  END IF;

  RAISE NOTICE 'Using trainer: %', trainer_user_id;

  -- ============================================
  -- STEP 3: Create a new session
  -- ============================================
  
  INSERT INTO sessions (
    scenario_id,
    trainer_id,
    status,
    current_state,
    scheduled_start_time
  ) VALUES (
    scenario_uuid,
    trainer_user_id,
    'scheduled',
    COALESCE(scenario_initial_state, '{}'::jsonb),
    NULL  -- Set this if you want to schedule a specific start time
  ) RETURNING id INTO new_session_id;

  RAISE NOTICE 'Created new session: %', new_session_id;

  -- ============================================
  -- STEP 4: Create default channels for the session
  -- ============================================
  
  -- Command Channel
  INSERT INTO chat_channels (session_id, name, type, role_filter, created_by)
  VALUES (new_session_id, 'Command Channel', 'command', NULL, trainer_user_id);

  -- Public Channel
  INSERT INTO chat_channels (session_id, name, type, role_filter, created_by)
  VALUES (new_session_id, 'Public Channel', 'public', NULL, trainer_user_id);

  -- Trainer Channel
  INSERT INTO chat_channels (session_id, name, type, role_filter, created_by)
  VALUES (new_session_id, 'Trainer Channel', 'trainer', NULL, trainer_user_id);

  RAISE NOTICE 'Created default channels for session';

  -- ============================================
  -- STEP 5: Optionally mark old sessions as cancelled
  -- Uncomment the block below if you want to cancel old C2E sessions
  -- ============================================
  
  /*
  UPDATE sessions
  SET status = 'cancelled',
      updated_at = NOW()
  WHERE scenario_id = scenario_uuid
    AND id != new_session_id
    AND status IN ('scheduled', 'in_progress', 'paused');
  
  RAISE NOTICE 'Marked old C2E sessions as cancelled';
  */

  -- ============================================
  -- Display summary
  -- ============================================
  
  RAISE NOTICE '============================================';
  RAISE NOTICE 'New C2E session created successfully!';
  RAISE NOTICE 'Session ID: %', new_session_id;
  RAISE NOTICE 'Status: scheduled';
  RAISE NOTICE '';
  RAISE NOTICE 'Next steps:';
  RAISE NOTICE '1. Go to the Sessions page in the app';
  RAISE NOTICE '2. Find your new session';
  RAISE NOTICE '3. Invite participants and assign roles';
  RAISE NOTICE '4. Start the session when ready!';
  RAISE NOTICE '============================================';

END $$;

-- Display the new session details
SELECT 
  'New Session Created' as status,
  s.id as session_id,
  s.status,
  s.created_at,
  sc.title as scenario_title,
  up.full_name as trainer_name
FROM sessions s
JOIN scenarios sc ON sc.id = s.scenario_id
JOIN user_profiles up ON up.id = s.trainer_id
WHERE sc.title = 'C2E Bombing at Community Event'
ORDER BY s.created_at DESC
LIMIT 1;

