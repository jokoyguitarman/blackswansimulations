-- Fix handle_new_user() to assign 'participant' role to anonymous sign-ups
-- CRITICAL: Without this fix, anonymous users get 'trainer' role by default

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
DECLARE
  v_role TEXT;
  v_invitation_role TEXT;
  v_provider TEXT;
BEGIN
  -- Detect anonymous sign-ups and assign safe default role
  v_provider := COALESCE(NEW.raw_app_meta_data->>'provider', '');

  IF v_provider = 'anonymous' THEN
    -- Anonymous users (join link flow) get participant role
    INSERT INTO public.user_profiles (id, username, full_name, role, agency_name)
    VALUES (
      NEW.id,
      COALESCE(NEW.email, 'anon_' || left(NEW.id::text, 8)),
      'User',
      'participant',
      'Unknown'
    );
    RETURN NEW;
  END IF;

  -- Normal sign-up flow: get role from metadata
  v_invitation_role := COALESCE(NEW.raw_user_meta_data->>'role', 'trainer');
  
  -- Map invitation roles to user_profiles roles
  CASE v_invitation_role
    WHEN 'defence' THEN v_role := 'defence_liaison';
    WHEN 'health' THEN v_role := 'health_director';
    WHEN 'civil' THEN v_role := 'civil_government';
    WHEN 'utilities' THEN v_role := 'utility_manager';
    WHEN 'intelligence' THEN v_role := 'intelligence_analyst';
    WHEN 'ngo' THEN v_role := 'ngo_liaison';
    WHEN 'public_information_officer' THEN v_role := 'public_information_officer';
    WHEN 'police_commander' THEN v_role := 'police_commander';
    WHEN 'legal_oversight' THEN v_role := 'admin';
    ELSE v_role := v_invitation_role;
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
    RAISE WARNING 'Failed to create user profile for user %: %', NEW.id, SQLERRM;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
