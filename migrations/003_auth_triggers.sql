-- Auth Triggers and Helper Functions
-- Automatically creates user profiles when users sign up

-- Function to create user profile on signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
DECLARE
  v_role TEXT;
  v_invitation_role TEXT;
BEGIN
  -- Get role from metadata
  v_invitation_role := COALESCE(NEW.raw_user_meta_data->>'role', 'trainer');
  
  -- Map invitation roles to user_profiles roles
  -- Invitation roles are shorter (e.g., 'defence'), user_profiles uses longer names (e.g., 'defence_liaison')
  CASE v_invitation_role
    WHEN 'defence' THEN v_role := 'defence_liaison';
    WHEN 'health' THEN v_role := 'health_director';
    WHEN 'civil' THEN v_role := 'civil_government';
    WHEN 'utilities' THEN v_role := 'utility_manager';
    WHEN 'intelligence' THEN v_role := 'intelligence_analyst';
    WHEN 'ngo' THEN v_role := 'ngo_liaison';
    WHEN 'public_information_officer' THEN v_role := 'public_information_officer';
    WHEN 'police_commander' THEN v_role := 'police_commander';
    WHEN 'legal_oversight' THEN v_role := 'admin'; -- Map legal_oversight to admin
    ELSE v_role := v_invitation_role; -- Use as-is if it's already a valid user_profiles role (e.g., 'trainer', 'admin')
  END CASE;

  INSERT INTO public.user_profiles (id, username, full_name, role, agency_name)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'username', NEW.email),
    COALESCE(NEW.raw_user_meta_data->>'full_name', 'User'),
    v_role,
    COALESCE(NEW.raw_user_meta_data->>'agency_name', 'Unknown')
  );
  RETURN NEW;
EXCEPTION
  WHEN OTHERS THEN
    -- Log error but don't fail signup - user can update profile later
    RAISE WARNING 'Failed to create user profile for user %: %', NEW.id, SQLERRM;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger to call function on new user creation
-- Drop trigger if it exists (for idempotent migrations)
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Function to log session events (for event sourcing)
CREATE OR REPLACE FUNCTION log_session_event(
  p_session_id UUID,
  p_event_type TEXT,
  p_description TEXT,
  p_actor_id UUID DEFAULT NULL,
  p_actor_role TEXT DEFAULT NULL,
  p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS UUID AS $$
DECLARE
  v_event_id UUID;
BEGIN
  INSERT INTO session_events (
    session_id,
    event_type,
    description,
    actor_id,
    actor_role,
    metadata
  )
  VALUES (
    p_session_id,
    p_event_type,
    p_description,
    p_actor_id,
    p_actor_role,
    p_metadata
  )
  RETURNING id INTO v_event_id;
  
  RETURN v_event_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to update sentiment snapshot
CREATE OR REPLACE FUNCTION update_sentiment_snapshot(
  p_session_id UUID,
  p_sentiment_score INTEGER,
  p_media_attention INTEGER,
  p_political_pressure INTEGER
)
RETURNS UUID AS $$
DECLARE
  v_snapshot_id UUID;
BEGIN
  INSERT INTO sentiment_snapshots (
    session_id,
    sentiment_score,
    media_attention,
    political_pressure
  )
  VALUES (
    p_session_id,
    p_sentiment_score,
    p_media_attention,
    p_political_pressure
  )
  RETURNING id INTO v_snapshot_id;
  
  RETURN v_snapshot_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to check if user is session participant
CREATE OR REPLACE FUNCTION is_session_participant(
  p_session_id UUID,
  p_user_id UUID
)
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM session_participants
    WHERE session_id = p_session_id
    AND user_id = p_user_id
  )
  OR EXISTS (
    SELECT 1 FROM sessions
    WHERE id = p_session_id
    AND trainer_id = p_user_id
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

