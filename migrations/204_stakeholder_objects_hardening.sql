-- Migration 204: hardening for objects introduced by 198 and 202, per Supabase security advisor.
-- Idempotent.
--
-- (a) can_user_access_channel is SECURITY DEFINER and was executable by PUBLIC (and therefore
--     `anon`) through /rest/v1/rpc. Only `authenticated` needs it — RLS policies on
--     chat_messages evaluate it as the querying role.
-- (b) social_posts_inherit_country had a role-mutable search_path; pin it.

REVOKE EXECUTE ON FUNCTION can_user_access_channel(UUID, UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION can_user_access_channel(UUID, UUID) FROM anon;
GRANT  EXECUTE ON FUNCTION can_user_access_channel(UUID, UUID) TO authenticated;
GRANT  EXECUTE ON FUNCTION can_user_access_channel(UUID, UUID) TO service_role;

ALTER FUNCTION social_posts_inherit_country() SET search_path = public;
