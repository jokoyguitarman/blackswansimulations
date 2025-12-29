-- Aggressive fix for RLS recursion - completely rebuilds session_participants policies
-- This ensures the old recursive policy is completely gone

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
-- This policy allows users to see session_participants if:
-- 1. They are a participant themselves (direct check, no subquery needed)
-- 2. They are the trainer of the session (check sessions table, NOT session_participants)
CREATE POLICY "Participants can view participants in their sessions"
  ON session_participants FOR SELECT
  USING (
    -- Direct check: user is a participant themselves
    -- This is safe because it's a direct column comparison
    user_id = auth.uid()
    OR
    -- Check if user is trainer via sessions table (NOT session_participants)
    -- This avoids recursion by checking sessions, not session_participants
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

-- Step 6: Also refresh chat_messages RLS to ensure it picks up the fixed session_participants policy
ALTER TABLE chat_messages DISABLE ROW LEVEL SECURITY;
ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;

-- Step 7: Verify the fix worked
-- Run this query to verify policies are correct:
-- SELECT policyname, qual FROM pg_policies WHERE tablename = 'session_participants';
-- The qual column should NOT contain "session_participants" in a subquery

-- Step 8: Test that SELECT works (run this as a session participant):
-- SELECT id, content FROM chat_messages WHERE session_id = 'YOUR_SESSION_ID' LIMIT 1;
-- Should work without recursion error

