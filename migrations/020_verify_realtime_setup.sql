-- Diagnostic queries to verify Realtime is enabled
-- Run these in Supabase SQL Editor to check if Realtime is properly configured

-- 1. Check if chat_messages is in the Realtime publication
SELECT 
  schemaname,
  tablename
FROM pg_publication_tables 
WHERE pubname = 'supabase_realtime' 
  AND tablename = 'chat_messages';

-- Expected: Should return 1 row if Realtime is enabled

-- 2. Check all tables in Realtime publication
SELECT 
  schemaname,
  tablename
FROM pg_publication_tables 
WHERE pubname = 'supabase_realtime'
ORDER BY tablename;

-- 3. Verify RLS is enabled on chat_messages
SELECT 
  tablename,
  rowsecurity as rls_enabled
FROM pg_tables 
WHERE schemaname = 'public' 
  AND tablename = 'chat_messages';

-- Expected: rls_enabled should be 't' (true)

-- 4. Check if the problematic session_participants policy exists
SELECT 
  schemaname,
  tablename,
  policyname,
  permissive,
  roles,
  cmd,
  qual,
  with_check
FROM pg_policies 
WHERE tablename = 'session_participants'
  AND policyname = 'Participants can view participants in their sessions';

-- If this query returns a row, check the 'qual' column for recursive queries
-- The old policy had: id IN (SELECT session_id FROM session_participants WHERE user_id = auth.uid())
-- This causes infinite recursion

