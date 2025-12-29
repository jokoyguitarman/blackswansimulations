-- Simplified diagnostic query to verify current RLS policies
-- This avoids the array_agg error by using simpler queries

-- Step 1: Check session_participants policies (simple version)
SELECT 
  policyname,
  cmd as operation
FROM pg_policies 
WHERE tablename = 'session_participants'
ORDER BY policyname;

-- Step 2: Check chat_messages policies
SELECT 
  policyname,
  cmd as operation
FROM pg_policies 
WHERE tablename = 'chat_messages'
ORDER BY policyname;

-- Step 3: Check if is_session_participant function exists and is used
SELECT 
  p.proname as function_name,
  pg_get_function_identity_arguments(p.oid) as arguments
FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'public'
  AND p.proname LIKE '%session_participant%';

-- Step 4: Check for any views that might cause recursion
SELECT 
  schemaname,
  viewname
FROM pg_views
WHERE schemaname = 'public'
  AND definition LIKE '%session_participants%';

-- Step 5: Test if SELECT works (this will show the recursion error if it exists)
-- Uncomment and run with your session_id to test:
-- SELECT id, content FROM chat_messages WHERE session_id = 'YOUR_SESSION_ID' LIMIT 1;

