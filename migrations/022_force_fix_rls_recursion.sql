-- Force fix RLS recursion in session_participants
-- This is a more aggressive fix that ensures the policy is completely replaced

-- Drop ALL policies on session_participants that might have recursion
DROP POLICY IF EXISTS "Participants can view participants in their sessions" ON session_participants;
DROP POLICY IF EXISTS "Trainers can manage participants" ON session_participants;

-- Recreate the SELECT policy WITHOUT recursion
CREATE POLICY "Participants can view participants in their sessions"
  ON session_participants FOR SELECT
  USING (
    -- Direct check: user is a participant themselves (NO recursion)
    user_id = auth.uid()
    OR
    -- Or they are the trainer of the session (check sessions table, NOT session_participants)
    EXISTS (
      SELECT 1 FROM sessions
      WHERE id = session_participants.session_id
      AND trainer_id = auth.uid()
    )
  );

-- Recreate the management policy for trainers
CREATE POLICY "Trainers can manage participants"
  ON session_participants FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM sessions
      WHERE id = session_participants.session_id
      AND trainer_id = auth.uid()
    )
  );

-- Verify the policy is correct (should NOT contain "session_participants" in the USING clause)
-- Run this after the migration to verify:
-- SELECT policyname, qual FROM pg_policies WHERE tablename = 'session_participants';

