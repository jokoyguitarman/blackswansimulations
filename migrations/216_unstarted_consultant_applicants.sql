-- Migration 216: List consultant applicants who signed up but have not started
--
-- Someone who applies as a consultant first creates an ordinary participant account from the
-- "Apply as a consultant" form, which marks their user metadata with applying_as_consultant. The
-- application itself (a trainer_agreements row) only exists once they save their details at /apply.
-- Until then admins could not see them anywhere: they are not trainers, and the Consultant
-- applications panel only lists rows that exist. This function lists those accounts for it.
--
-- SECURITY: the flag is user metadata, which the account owner can edit, so it is only a hint for
-- listing people and grants nothing. The function reads auth.users, so it is server-only: revoked
-- from every public role and executable by service_role alone, the same pattern as consume_credit
-- (migration 193) so it cannot be called through Supabase's public RPC surface.

CREATE OR REPLACE FUNCTION public.unstarted_consultant_applicants(p_days INT DEFAULT 60)
RETURNS TABLE (
  user_id UUID,
  full_name TEXT,
  email TEXT,
  organisation TEXT,
  signed_up_at TIMESTAMPTZ,
  email_confirmed BOOLEAN,
  last_sign_in_at TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT
    u.id,
    p.full_name::text,
    u.email::text,
    p.agency_name::text,
    u.created_at,
    (u.email_confirmed_at IS NOT NULL),
    u.last_sign_in_at
  FROM auth.users u
  JOIN public.user_profiles p ON p.id = u.id
  WHERE p.role = 'participant'
    AND coalesce(p.is_bot, false) = false
    AND coalesce(u.is_anonymous, false) = false
    AND (u.raw_user_meta_data ->> 'applying_as_consultant') = 'true'
    AND u.created_at > now() - make_interval(days => p_days)
    AND NOT EXISTS (SELECT 1 FROM public.trainer_agreements ta WHERE ta.user_id = u.id)
  ORDER BY u.created_at DESC
  LIMIT 50;
$$;

REVOKE EXECUTE ON FUNCTION public.unstarted_consultant_applicants(INT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.unstarted_consultant_applicants(INT) FROM anon;
REVOKE EXECUTE ON FUNCTION public.unstarted_consultant_applicants(INT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.unstarted_consultant_applicants(INT) TO service_role;

COMMENT ON FUNCTION public.unstarted_consultant_applicants(INT) IS
  'Participants who signed up through the consultant application form in the last p_days days and have no trainer_agreements row yet. Server-only.';
