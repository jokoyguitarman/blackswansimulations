-- Check if the session_participants RLS policy has been fixed
-- This will show if migration 019 was run successfully

SELECT 
  policyname,
  cmd as operation,
  qual as using_expression
FROM pg_policies 
WHERE tablename = 'session_participants'
  AND policyname = 'Participants can view participants in their sessions';

-- If this returns a row, check the 'qual' column:
-- ❌ BAD: Contains "session_participants" (recursive) - migration 019 not run
-- ✅ GOOD: Only checks "user_id = auth.uid()" or "sessions.trainer_id" - migration 019 was run

