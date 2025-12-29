-- Fix infinite recursion in session_participants RLS policy
-- The policy was checking session_participants within its own policy, causing recursion

-- Drop the problematic policy
DROP POLICY IF EXISTS "Participants can view participants in their sessions" ON session_participants;

-- Create a fixed policy that avoids recursion
-- Users can view session_participants if:
-- 1. They are the trainer of the session, OR
-- 2. They are a participant themselves (check directly without recursion)
CREATE POLICY "Participants can view participants in their sessions"
  ON session_participants FOR SELECT
  USING (
    -- Direct check: user is a participant themselves
    user_id = auth.uid()
    OR
    -- Or they are the trainer of the session (check sessions table, not session_participants)
    EXISTS (
      SELECT 1 FROM sessions
      WHERE id = session_participants.session_id
      AND trainer_id = auth.uid()
    )
  );

