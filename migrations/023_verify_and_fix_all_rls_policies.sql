-- Comprehensive fix for RLS recursion in session_participants
-- This drops ALL policies and recreates them properly

-- First, check what policies exist (for debugging)
-- SELECT policyname, cmd, qual FROM pg_policies WHERE tablename = 'session_participants';

-- Drop ALL existing policies on session_participants
DROP POLICY IF EXISTS "Participants can view participants in their sessions" ON session_participants;
DROP POLICY IF EXISTS "Trainers can manage participants" ON session_participants;

-- Also drop any other policies that might exist (in case they were created with different names)
DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN (SELECT policyname FROM pg_policies WHERE tablename = 'session_participants') LOOP
        EXECUTE format('DROP POLICY IF EXISTS %I ON session_participants', r.policyname);
    END LOOP;
END $$;

-- Recreate the SELECT policy WITHOUT any recursion
-- This policy allows users to see session_participants if:
-- 1. They are a participant themselves (direct check, no recursion)
-- 2. They are the trainer of the session (check sessions table, NOT session_participants)
CREATE POLICY "Participants can view participants in their sessions"
  ON session_participants FOR SELECT
  USING (
    -- Direct check: user is a participant themselves
    -- This is safe because it's a direct column comparison, no subquery needed
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

-- Recreate the management policy for trainers
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

-- Verify the fix worked
-- Run this after the migration to verify:
-- SELECT policyname, qual FROM pg_policies WHERE tablename = 'session_participants';
-- The qual column should NOT contain "session_participants" in a subquery

