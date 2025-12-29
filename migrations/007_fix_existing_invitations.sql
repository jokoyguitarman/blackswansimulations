-- Fix Existing Invitations
-- Run this to manually process invitations for users who already signed up
-- This handles cases where the trigger didn't run or the timing constraint prevented adding participants

-- Function to process accepted invitations for a specific user
CREATE OR REPLACE FUNCTION process_accepted_invitations_for_user(p_user_id UUID)
RETURNS TABLE(session_id UUID, role TEXT, added BOOLEAN) AS $$
DECLARE
  v_user_email TEXT;
BEGIN
  -- Get user email from auth.users
  SELECT email INTO v_user_email
  FROM auth.users
  WHERE id = p_user_id;

  IF v_user_email IS NULL THEN
    RAISE EXCEPTION 'User not found or email not available';
  END IF;

  -- Process all accepted invitations for this email
  RETURN QUERY
  WITH processed AS (
    INSERT INTO session_participants (session_id, user_id, role)
    SELECT 
      si.session_id,
      p_user_id,
      si.role
    FROM session_invitations si
    WHERE 
      si.email = v_user_email
      AND si.status = 'accepted'
      AND si.expires_at > NOW()
      AND NOT EXISTS (
        SELECT 1 FROM session_participants sp
        WHERE sp.session_id = si.session_id
        AND sp.user_id = p_user_id
      )
    ON CONFLICT (session_id, user_id) DO NOTHING
    RETURNING session_participants.session_id, session_participants.role, true as added
  )
  SELECT p.session_id, p.role, p.added FROM processed;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Example usage (uncomment and replace with actual user_id):
-- SELECT * FROM process_accepted_invitations_for_user('USER_ID_HERE');

