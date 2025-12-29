-- Session Invitations - Allow inviting users by email before they register
-- Run this in your Supabase SQL Editor

-- Session Invitations Table
CREATE TABLE IF NOT EXISTS session_invitations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN (
    'defence',
    'health',
    'civil',
    'utilities',
    'intelligence',
    'ngo',
    'public_information_officer',
    'police_commander',
    'legal_oversight'
  )),
  invitation_token TEXT NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(32), 'hex'),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'expired', 'cancelled')),
  invited_by UUID NOT NULL REFERENCES user_profiles(id),
  invited_at TIMESTAMPTZ DEFAULT NOW(),
  accepted_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '30 days'),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(session_id, email) -- One invitation per email per session
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_session_invitations_email ON session_invitations(email);
CREATE INDEX IF NOT EXISTS idx_session_invitations_token ON session_invitations(invitation_token);
CREATE INDEX IF NOT EXISTS idx_session_invitations_session_id ON session_invitations(session_id);
CREATE INDEX IF NOT EXISTS idx_session_invitations_status ON session_invitations(status);

-- RLS Policies for session_invitations
ALTER TABLE session_invitations ENABLE ROW LEVEL SECURITY;

-- Drop policies if they exist (for idempotent migrations)
DROP POLICY IF EXISTS "Trainers can view invitations for their sessions" ON session_invitations;
DROP POLICY IF EXISTS "Trainers can create invitations for their sessions" ON session_invitations;
DROP POLICY IF EXISTS "Trainers can update invitations for their sessions" ON session_invitations;
DROP POLICY IF EXISTS "Anyone can view invitation by token" ON session_invitations;

-- Trainers can view invitations for their sessions
CREATE POLICY "Trainers can view invitations for their sessions"
  ON session_invitations
  FOR SELECT
  USING (
    EXISTS (
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

-- Trainers can create invitations for their sessions
CREATE POLICY "Trainers can create invitations for their sessions"
  ON session_invitations
  FOR INSERT
  WITH CHECK (
    EXISTS (
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

-- Trainers can update invitations for their sessions
CREATE POLICY "Trainers can update invitations for their sessions"
  ON session_invitations
  FOR UPDATE
  USING (
    EXISTS (
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

-- Anyone can view their own invitation by token (for signup flow)
CREATE POLICY "Anyone can view invitation by token"
  ON session_invitations
  FOR SELECT
  USING (true); -- Token provides security, not RLS

-- Function to auto-accept invitation when user signs up
-- This runs after user_profiles is created (which happens after auth.users)
CREATE OR REPLACE FUNCTION accept_session_invitation_on_signup()
RETURNS TRIGGER AS $$
DECLARE
  v_user_email TEXT;
BEGIN
  -- Try to get email from auth.users (wrap in exception handler)
  BEGIN
    SELECT email INTO v_user_email
    FROM auth.users
    WHERE id = NEW.id;
  EXCEPTION
    WHEN OTHERS THEN
      -- If we can't access auth.users, try to get email from raw_user_meta_data
      -- This is a fallback - the email should be in auth.users but sometimes
      -- there are permission issues with SECURITY DEFINER functions
      v_user_email := NULL;
  END;

  -- If we still don't have email, return early (don't fail signup)
  IF v_user_email IS NULL OR v_user_email = '' THEN
    RETURN NEW;
  END IF;

  -- Check if there are pending invitations for this email
  -- Wrap in exception handler so signup doesn't fail if invitation processing fails
  BEGIN
    UPDATE session_invitations
    SET 
      status = 'accepted',
      accepted_at = NOW(),
      updated_at = NOW()
    WHERE 
      email = v_user_email
      AND status = 'pending'
      AND expires_at > NOW();

    -- Auto-add user to sessions they were invited to
    -- Process all accepted invitations for this email (not just recent ones)
    INSERT INTO session_participants (session_id, user_id, role)
    SELECT 
      si.session_id,
      NEW.id,
      si.role
    FROM session_invitations si
    WHERE 
      si.email = v_user_email
      AND si.status = 'accepted'
      AND si.expires_at > NOW() -- Only process non-expired invitations
      AND NOT EXISTS (
        SELECT 1 FROM session_participants sp
        WHERE sp.session_id = si.session_id
        AND sp.user_id = NEW.id
      ) -- Avoid duplicates
    ON CONFLICT (session_id, user_id) DO NOTHING;
  EXCEPTION
    WHEN OTHERS THEN
      -- Log the error but don't fail the signup
      -- The invitation can be processed later via a separate endpoint if needed
      RAISE WARNING 'Failed to process invitation for user %: %', NEW.id, SQLERRM;
  END;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger to auto-accept invitations when user profile is created
-- Drop trigger if it exists (for idempotent migrations)
DROP TRIGGER IF EXISTS trigger_accept_invitations_on_signup ON user_profiles;

CREATE TRIGGER trigger_accept_invitations_on_signup
  AFTER INSERT ON user_profiles
  FOR EACH ROW
  EXECUTE FUNCTION accept_session_invitation_on_signup();

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_session_invitations_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Drop trigger if it exists (for idempotent migrations)
DROP TRIGGER IF EXISTS trigger_update_session_invitations_updated_at ON session_invitations;

CREATE TRIGGER trigger_update_session_invitations_updated_at
  BEFORE UPDATE ON session_invitations
  FOR EACH ROW
  EXECUTE FUNCTION update_session_invitations_updated_at();

