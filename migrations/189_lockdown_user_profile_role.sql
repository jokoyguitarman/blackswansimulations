-- Migration 189: Lock down user_profiles.role against privilege escalation
--
-- Closes the privilege-escalation chain identified in the security audit:
--   Vector B  - handle_new_user() trusted the client-supplied raw_user_meta_data->>'role'.
--   Vector C  - the "Users can update their own profile" RLS policy let any user rewrite
--               their own role/agency (no column restriction, no WITH CHECK).
--
-- After this migration:
--   * New self-service sign-ups default to 'participant' (least privilege).
--   * Elevated in-session roles come ONLY from a server-side invitation row (never client input).
--   * 'trainer'/'admin' can never be granted by sign-up (invitations cannot carry those roles).
--   * Authenticated end-users can no longer change their own role/agency via the anon key.
--   * Trusted server (service-role) and operator (psql / Supabase dashboard) updates still work,
--     so existing trainers and manual provisioning are unaffected.

-- ---------------------------------------------------------------------------
-- 0. Ensure 'participant' is a permitted role value.
--    The original 001 CHECK omitted 'participant' even though the anonymous join
--    flow (migration 047) and the join route rely on it. Recreate the constraint
--    with the full, authoritative set so the trigger below is always valid.
-- ---------------------------------------------------------------------------
ALTER TABLE public.user_profiles DROP CONSTRAINT IF EXISTS user_profiles_role_check;
ALTER TABLE public.user_profiles ADD CONSTRAINT user_profiles_role_check CHECK (role IN (
  'participant',
  'defence_liaison',
  'police_commander',
  'public_information_officer',
  'health_director',
  'civil_government',
  'utility_manager',
  'intelligence_analyst',
  'ngo_liaison',
  'trainer',
  'admin'
));

-- ---------------------------------------------------------------------------
-- 1. Vector B - handle_new_user() must NOT trust client metadata for role.
--    Derive any elevated (domain) role from the server-side session_invitations
--    table, matched on the new user's email. Default to 'participant' otherwise.
--    Invitations can only carry domain roles, so trainer/admin are never grantable here.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
DECLARE
  v_role TEXT;
  v_invitation_role TEXT;
BEGIN
  -- Look up a pending, non-expired invitation for this email. This is a trusted,
  -- server-side source (created by a trainer/admin), unlike raw_user_meta_data.
  IF NEW.email IS NOT NULL AND NEW.email <> '' THEN
    SELECT si.role INTO v_invitation_role
    FROM public.session_invitations si
    WHERE si.email = NEW.email
      AND si.status = 'pending'
      AND si.expires_at > NOW()
    ORDER BY si.invited_at DESC
    LIMIT 1;
  END IF;

  -- Map invitation (domain) roles to user_profiles role names.
  -- NOTE: invitations cannot carry 'trainer'/'admin'. 'legal_oversight' previously
  -- mapped to 'admin' (a privilege bug) and is now demoted to a domain role.
  v_role := CASE v_invitation_role
    WHEN 'defence' THEN 'defence_liaison'
    WHEN 'health' THEN 'health_director'
    WHEN 'civil' THEN 'civil_government'
    WHEN 'utilities' THEN 'utility_manager'
    WHEN 'intelligence' THEN 'intelligence_analyst'
    WHEN 'ngo' THEN 'ngo_liaison'
    WHEN 'public_information_officer' THEN 'public_information_officer'
    WHEN 'police_commander' THEN 'police_commander'
    WHEN 'legal_oversight' THEN 'defence_liaison'
    ELSE 'participant'
  END;

  INSERT INTO public.user_profiles (id, username, full_name, role, agency_name)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'username', NEW.email, 'anon_' || left(NEW.id::text, 8)),
    COALESCE(NEW.raw_user_meta_data->>'full_name', 'User'),
    v_role,
    COALESCE(NEW.raw_user_meta_data->>'agency_name', 'Unknown')
  );
  RETURN NEW;
EXCEPTION
  WHEN OTHERS THEN
    -- Never fail signup; the profile can be repaired later.
    RAISE WARNING 'Failed to create user profile for user %: %', NEW.id, SQLERRM;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ---------------------------------------------------------------------------
-- 2. Vector C - prevent authenticated end-users from changing their own
--    role/agency. The existing UPDATE policy (USING auth.uid() = id) stays so
--    users can still edit harmless fields (e.g. full_name), but a BEFORE UPDATE
--    trigger blocks privilege/agency changes unless the caller is already admin.
--
--    Trusted contexts (service-role key, psql, Supabase dashboard) have no
--    auth.uid(), so they bypass this guard - existing trainers and manual
--    operator provisioning continue to work.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.prevent_role_self_escalation()
RETURNS TRIGGER AS $$
BEGIN
  -- No authenticated end-user in context => trusted server/operator update.
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  IF (NEW.role IS DISTINCT FROM OLD.role)
     OR (NEW.agency_name IS DISTINCT FROM OLD.agency_name) THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.user_profiles
      WHERE id = auth.uid() AND role = 'admin'
    ) THEN
      RAISE EXCEPTION 'Not allowed to change role or agency';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_prevent_role_self_escalation ON public.user_profiles;
CREATE TRIGGER trg_prevent_role_self_escalation
  BEFORE UPDATE ON public.user_profiles
  FOR EACH ROW EXECUTE FUNCTION public.prevent_role_self_escalation();
