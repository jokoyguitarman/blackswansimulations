-- Diagnostic query to check current session_participants policies
-- Run this FIRST to see what policies exist and if they have recursion

-- Check all policies on session_participants
SELECT 
  policyname,
  cmd as operation,
  qual as using_expression,
  with_check as with_check_expression
FROM pg_policies 
WHERE tablename = 'session_participants'
ORDER BY policyname;

-- Look for these patterns in the 'qual' or 'with_check' columns that indicate recursion:
-- 1. Contains "session_participants" in a subquery (BAD - causes recursion)
-- 2. Contains "id IN (SELECT session_id FROM session_participants" (BAD - causes recursion)
-- 
-- GOOD patterns (no recursion):
-- - "user_id = auth.uid()" (direct check)
-- - "EXISTS (SELECT 1 FROM sessions WHERE ...)" (checks sessions table, not session_participants)

