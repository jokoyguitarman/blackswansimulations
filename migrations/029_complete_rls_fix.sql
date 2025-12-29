-- Complete RLS fix - fixes both session_participants AND ensures chat_messages policy is correct
-- This migration should be run if migration 028 didn't fully resolve the recursion issue

-- ============================================================================
-- PART 1: Fix session_participants policies (same as migration 028)
-- ============================================================================

-- Step 1: Drop ALL policies on session_participants (including any duplicates)
DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN (
        SELECT policyname 
        FROM pg_policies 
        WHERE tablename = 'session_participants'
    ) LOOP
        EXECUTE format('DROP POLICY IF EXISTS %I ON session_participants', r.policyname);
        RAISE NOTICE 'Dropped policy: %', r.policyname;
    END LOOP;
END $$;

-- Step 2: Disable RLS to clear all cached execution plans
ALTER TABLE session_participants DISABLE ROW LEVEL SECURITY;

-- Step 3: Re-enable RLS (forces PostgreSQL to rebuild everything)
ALTER TABLE session_participants ENABLE ROW LEVEL SECURITY;

-- Step 4: Create the SELECT policy WITHOUT any recursion
CREATE POLICY "Participants can view participants in their sessions"
  ON session_participants FOR SELECT
  USING (
    -- Direct check: user is a participant themselves (NO recursion)
    user_id = auth.uid()
    OR
    -- Check if user is trainer via sessions table (NOT session_participants)
    EXISTS (
      SELECT 1 
      FROM sessions
      WHERE sessions.id = session_participants.session_id
      AND sessions.trainer_id = auth.uid()
    )
  );

-- Step 5: Create the management policy for trainers
CREATE POLICY "Trainers can manage participants"
  ON session_participants FOR ALL
  USING (
    EXISTS (
      SELECT 1 
      FROM sessions
      WHERE sessions.id = session_participants.session_id
      AND sessions.trainer_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 
      FROM sessions
      WHERE sessions.id = session_participants.session_id
      AND sessions.trainer_id = auth.uid()
    )
  );

-- ============================================================================
-- PART 2: Refresh chat_messages policies to ensure they pick up the fixed session_participants
-- ============================================================================

-- Step 6: Drop and recreate chat_messages SELECT policy to ensure it uses the fixed session_participants
DROP POLICY IF EXISTS "Session participants can view messages" ON chat_messages;

-- Step 7: Disable RLS on chat_messages to clear cached execution plans
ALTER TABLE chat_messages DISABLE ROW LEVEL SECURITY;

-- Step 8: Re-enable RLS (forces PostgreSQL to rebuild execution plans)
ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;

-- Step 9: Recreate the chat_messages SELECT policy
-- This policy checks session_participants, which now has a non-recursive policy
CREATE POLICY "Session participants can view messages"
  ON chat_messages FOR SELECT
  USING (
    -- Check if user is a participant (uses the fixed session_participants policy)
    EXISTS (
      SELECT 1 FROM session_participants
      WHERE session_id = chat_messages.session_id
      AND user_id = auth.uid()
    )
    OR
    -- Check if user is the trainer
    EXISTS (
      SELECT 1 FROM sessions
      WHERE id = chat_messages.session_id
      AND trainer_id = auth.uid()
    )
  );

-- ============================================================================
-- PART 3: Verification
-- ============================================================================

-- Step 10: Verify policies are correct
-- Run these queries to verify:
-- 
-- Check session_participants policies:
-- SELECT policyname, qual FROM pg_policies WHERE tablename = 'session_participants';
-- The qual column should NOT contain "session_participants" in a subquery
--
-- Check chat_messages policies:
-- SELECT policyname, qual FROM pg_policies WHERE tablename = 'chat_messages';
--
-- Test SELECT (run as a session participant):
-- SELECT id, content FROM chat_messages WHERE session_id = 'YOUR_SESSION_ID' LIMIT 1;
-- Should work without recursion error

