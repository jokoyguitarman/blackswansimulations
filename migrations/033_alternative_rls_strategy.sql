-- Alternative RLS Strategy: Use SECURITY DEFINER function to break recursion
-- This approach uses a function that bypasses RLS to check participation,
-- breaking the circular dependency between chat_messages and session_participants policies

-- ============================================================================
-- PART 1: Create SECURITY DEFINER function to check session participation
-- ============================================================================

-- Drop existing function if it exists (in case it has different signature)
DROP FUNCTION IF EXISTS is_user_session_participant(UUID, UUID);

-- Create function that bypasses RLS to check if user is a session participant
-- SECURITY DEFINER means this function runs with the privileges of the function owner (postgres)
-- This allows it to query session_participants without triggering RLS recursion
-- Note: No default parameter to avoid function signature issues
CREATE OR REPLACE FUNCTION is_user_session_participant(
  p_session_id UUID,
  p_user_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
BEGIN
  -- Direct query without RLS - no recursion possible because SECURITY DEFINER bypasses RLS
  -- Check if user is a participant
  IF EXISTS (
    SELECT 1 
    FROM session_participants
    WHERE session_id = p_session_id
    AND user_id = p_user_id
  ) THEN
    RETURN TRUE;
  END IF;
  
  -- Check if user is the trainer
  IF EXISTS (
    SELECT 1 
    FROM sessions
    WHERE id = p_session_id
    AND trainer_id = p_user_id
  ) THEN
    RETURN TRUE;
  END IF;
  
  RETURN FALSE;
END;
$$;

-- Grant execute permission to authenticated users (only one signature now)
GRANT EXECUTE ON FUNCTION is_user_session_participant(UUID, UUID) TO authenticated;

-- ============================================================================
-- PART 2: Fix session_participants policies (ensure they're non-recursive)
-- ============================================================================

-- Drop all existing policies on session_participants
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
    END LOOP;
END $$;

-- Disable and re-enable RLS to clear cached plans
ALTER TABLE session_participants DISABLE ROW LEVEL SECURITY;
ALTER TABLE session_participants ENABLE ROW LEVEL SECURITY;

-- Create non-recursive SELECT policy
CREATE POLICY "Participants can view participants in their sessions"
  ON session_participants FOR SELECT
  USING (
    -- Direct check: user is a participant themselves (no recursion)
    user_id = auth.uid()
    OR
    -- Check sessions table ONLY (never query session_participants)
    EXISTS (
      SELECT 1 
      FROM sessions s
      WHERE s.id = session_participants.session_id
      AND s.trainer_id = auth.uid()
    )
  );

-- Create management policy for trainers
CREATE POLICY "Trainers can manage participants"
  ON session_participants FOR ALL
  USING (
    EXISTS (
      SELECT 1 
      FROM sessions s
      WHERE s.id = session_participants.session_id
      AND s.trainer_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 
      FROM sessions s
      WHERE s.id = session_participants.session_id
      AND s.trainer_id = auth.uid()
    )
  );

-- ============================================================================
-- PART 3: Update chat_messages policy to use the SECURITY DEFINER function
-- ============================================================================

-- Drop existing chat_messages SELECT policy
DROP POLICY IF EXISTS "Session participants can view messages" ON chat_messages;

-- Disable and re-enable RLS to clear cached plans
ALTER TABLE chat_messages DISABLE ROW LEVEL SECURITY;
ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;

-- Create new policy using the SECURITY DEFINER function
-- This breaks the recursion because the function bypasses RLS
CREATE POLICY "Session participants can view messages"
  ON chat_messages FOR SELECT
  USING (
    -- Use the SECURITY DEFINER function instead of directly querying session_participants
    -- This function bypasses RLS, so no recursion is possible
    is_user_session_participant(session_id, auth.uid())
  );

-- ============================================================================
-- PART 4: Verify the fix
-- ============================================================================

-- Analyze tables to rebuild statistics
ANALYZE session_participants;
ANALYZE chat_messages;
ANALYZE sessions;

-- Test the function (should return true/false without recursion error)
-- SELECT is_user_session_participant('YOUR_SESSION_ID', auth.uid());

-- Test SELECT on chat_messages (should work without recursion error)
-- SELECT id, content FROM chat_messages WHERE session_id = 'YOUR_SESSION_ID' LIMIT 1;

