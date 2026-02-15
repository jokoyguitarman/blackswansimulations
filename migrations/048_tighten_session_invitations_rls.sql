-- Tighten session_invitations RLS: remove the overly permissive "Anyone can view" policy
-- The old policy used USING (true) which let any authenticated user read ALL invitations.
-- Since the invitation lookup is done server-side via supabaseAdmin (service role),
-- we don't need a public SELECT policy at all.

DROP POLICY IF EXISTS "Anyone can view invitation by token" ON session_invitations;

-- Replace with a scoped policy: users can only see invitations for their own email
CREATE POLICY "Users can view their own invitations"
  ON session_invitations
  FOR SELECT
  USING (
    email = (SELECT email FROM auth.users WHERE id = auth.uid())
    OR EXISTS (
      SELECT 1 FROM sessions
      WHERE sessions.id = session_invitations.session_id
      AND sessions.trainer_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
      AND user_profiles.role = 'admin'
    )
  );
