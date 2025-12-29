-- Diagnostic query to check what policies actually exist
-- Run this FIRST to see what's in the database

-- Check session_participants policies
SELECT 
  policyname,
  cmd as operation,
  qual as using_expression,
  with_check as with_check_expression
FROM pg_policies 
WHERE tablename = 'session_participants'
ORDER BY policyname;

-- Check if there are any views or functions that might cause recursion
SELECT 
  schemaname,
  viewname,
  definition
FROM pg_views
WHERE definition LIKE '%session_participants%'
  AND schemaname = 'public';

-- Check for any functions that query session_participants
SELECT 
  p.proname as function_name,
  pg_get_functiondef(p.oid) as function_definition
FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'public'
  AND pg_get_functiondef(p.oid) LIKE '%session_participants%';

