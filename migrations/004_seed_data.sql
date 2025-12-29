-- Seed Data for Testing
-- Run this AFTER migrations 001-003
-- ⚠️ Only use in development/testing environments

-- Note: This assumes you have at least one user created via Supabase Auth
-- Replace the UUIDs below with actual user IDs from your auth.users table

-- Example: Get your user ID first
-- SELECT id, email FROM auth.users LIMIT 1;

-- Then update the INSERT statements below with your actual user ID

-- Example seed scenario (uncomment and update user_id after running migrations)
/*
INSERT INTO scenarios (
  id,
  title,
  description,
  category,
  difficulty,
  duration_minutes,
  objectives,
  initial_state,
  created_by,
  is_active
) VALUES (
  '00000000-0000-0000-0000-000000000001',
  'Urban Infrastructure Failure',
  'A major power outage affects downtown district during peak hours. Multiple agencies must coordinate response.',
  'infrastructure',
  'intermediate',
  90,
  '["Coordinate emergency response", "Manage public communication", "Restore critical services"]'::jsonb,
  '{
    "publicSentiment": 50,
    "mediaAttention": 30,
    "weatherCondition": "clear",
    "politicalPressure": 20
  }'::jsonb,
  'YOUR_USER_ID_HERE'::uuid,  -- Replace with actual user ID
  true
);

-- Example inject for the scenario
INSERT INTO scenario_injects (
  scenario_id,
  trigger_time_minutes,
  type,
  title,
  content,
  affected_roles,
  severity,
  requires_response
) VALUES (
  '00000000-0000-0000-0000-000000000001',
  5,
  'media_report',
  'Breaking: Power Outage Reported',
  'Local news reports widespread power outage affecting downtown district. Traffic lights are down, businesses closed.',
  '["public_information_officer", "police_commander", "utility_manager"]'::jsonb,
  'high',
  true
);
*/

-- Helper query to check your setup
-- Run this to see all tables and their row counts
/*
SELECT 
  schemaname,
  tablename,
  (SELECT COUNT(*) FROM information_schema.columns 
   WHERE table_schema = schemaname AND table_name = tablename) as column_count
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY tablename;
*/

