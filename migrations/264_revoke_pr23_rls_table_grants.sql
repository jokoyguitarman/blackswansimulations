-- Migration 264: revoke anon and authenticated on the twelve PR #23 tables that
-- enabled row security and never revoked table privileges.
--
-- 221, 222, 223, 239, 240 and 242 turn RLS on and leave Supabase's default
-- grants in place. RLS returns no rows and refuses inserts, but TRUNCATE is
-- not subject to RLS, so those roles can still empty the tables.
-- doctrine_force_ceilings is already revoked in 222 and is not listed here.
--
-- service_role is not revoked. The server reaches Supabase through the
-- service-role client. No server or frontend query reads these tables as
-- anon or authenticated, and none of them has a policy that would return a
-- row to those roles, so SELECT is revoked as well.
--
-- Idempotent: REVOKE is safe to run again.
--
-- Rollback, on a branch or a local database only, never on the shared project:
--   GRANT ALL ON TABLE public.team_archetypes, public.team_archetype_aliases,
--     public.doctrines, public.doctrine_versions, public.doctrine_source_documents,
--     public.doctrine_usage, public.doctrine_reports, public.doctrine_events,
--     public.fieldops_explosive_materials, public.fieldops_injury_thresholds,
--     public.fieldops_physics_reviews, public.fieldops_physics_library_changes
--     TO anon, authenticated;
BEGIN;

DO $$
DECLARE
  name text;
BEGIN
  FOREACH name IN ARRAY ARRAY[
    'team_archetypes',
    'team_archetype_aliases',
    'doctrines',
    'doctrine_versions',
    'doctrine_source_documents',
    'doctrine_usage',
    'doctrine_reports',
    'doctrine_events',
    'fieldops_explosive_materials',
    'fieldops_injury_thresholds',
    'fieldops_physics_reviews',
    'fieldops_physics_library_changes'
  ]
  LOOP
    IF to_regclass('public.' || name) IS NULL THEN
      RAISE EXCEPTION
        'Apply migrations 221, 222, 223, 239, 240 and 242 before 264_revoke_pr23_rls_table_grants.sql. Missing public.%',
        name;
    END IF;
    EXECUTE format(
      'REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated',
      name
    );
  END LOOP;
END $$;

COMMIT;
