-- Migration 275: template versioning for scenario teams and injects.
-- NOT APPLIED. Applying this to the shared Supabase project needs the user's explicit approval.
-- Idempotent: safe to run twice.
-- Does not reference migrations 268–273. retired_by_edit references scenario_setup_edits
-- only when that table already exists (migration 274). Otherwise the column is added with no foreign key.
-- Rollback (branch or local database only, never the shared project):
--   DROP VIEW IF EXISTS public.scenario_team_names;
--   DROP INDEX IF EXISTS public.idx_scenario_injects_active_templates;
--   DROP INDEX IF EXISTS public.idx_scenario_teams_scenario_uid;
--   DROP INDEX IF EXISTS public.uq_scenario_teams_active_name;
--   ALTER TABLE public.scenario_teams DROP CONSTRAINT IF EXISTS scenario_teams_retired_by_edit_fkey;
--   ALTER TABLE public.scenario_injects DROP CONSTRAINT IF EXISTS scenario_injects_retired_by_edit_fkey;
--   ALTER TABLE public.scenario_teams DROP CONSTRAINT IF EXISTS scenario_teams_retire_reason_check;
--   ALTER TABLE public.scenario_injects DROP CONSTRAINT IF EXISTS scenario_injects_retire_reason_check;
--   ALTER TABLE public.scenario_teams
--     DROP COLUMN IF EXISTS superseded_by,
--     DROP COLUMN IF EXISTS retire_reason,
--     DROP COLUMN IF EXISTS retired_by_edit,
--     DROP COLUMN IF EXISTS retired_at,
--     DROP COLUMN IF EXISTS valid_from,
--     DROP COLUMN IF EXISTS team_uid;
--   ALTER TABLE public.scenario_injects
--     DROP COLUMN IF EXISTS superseded_by,
--     DROP COLUMN IF EXISTS retire_reason,
--     DROP COLUMN IF EXISTS retired_by_edit,
--     DROP COLUMN IF EXISTS retired_at,
--     DROP COLUMN IF EXISTS valid_from;
--   ALTER TABLE public.scenario_objectives DROP COLUMN IF EXISTS retired_at;
--   ALTER TABLE public.scenario_teams
--     ADD CONSTRAINT scenario_teams_scenario_id_team_name_key UNIQUE (scenario_id, team_name);
BEGIN;

ALTER TABLE public.scenario_teams ADD COLUMN IF NOT EXISTS team_uid UUID;
UPDATE public.scenario_teams SET team_uid = id WHERE team_uid IS NULL;
ALTER TABLE public.scenario_teams ALTER COLUMN team_uid SET DEFAULT gen_random_uuid();
ALTER TABLE public.scenario_teams ALTER COLUMN team_uid SET NOT NULL;

ALTER TABLE public.scenario_teams ADD COLUMN IF NOT EXISTS valid_from TIMESTAMPTZ;
UPDATE public.scenario_teams AS t
SET valid_from = s.created_at
FROM public.scenarios AS s
WHERE t.scenario_id = s.id
  AND t.valid_from IS NULL
  AND s.created_at IS NOT NULL;
UPDATE public.scenario_teams SET valid_from = NOW() WHERE valid_from IS NULL;
ALTER TABLE public.scenario_teams ALTER COLUMN valid_from SET DEFAULT NOW();
ALTER TABLE public.scenario_teams ALTER COLUMN valid_from SET NOT NULL;

ALTER TABLE public.scenario_teams ADD COLUMN IF NOT EXISTS retired_at TIMESTAMPTZ;
ALTER TABLE public.scenario_teams ADD COLUMN IF NOT EXISTS retired_by_edit UUID;
ALTER TABLE public.scenario_teams ADD COLUMN IF NOT EXISTS retire_reason TEXT;
ALTER TABLE public.scenario_teams ADD COLUMN IF NOT EXISTS superseded_by UUID;

ALTER TABLE public.scenario_teams DROP CONSTRAINT IF EXISTS scenario_teams_retire_reason_check;
ALTER TABLE public.scenario_teams
  ADD CONSTRAINT scenario_teams_retire_reason_check
  CHECK (retire_reason IN ('removed', 'renamed', 'revised'));

ALTER TABLE public.scenario_injects ADD COLUMN IF NOT EXISTS valid_from TIMESTAMPTZ;
UPDATE public.scenario_injects AS i
SET valid_from = COALESCE(i.created_at, s.created_at, NOW())
FROM public.scenarios AS s
WHERE i.scenario_id = s.id
  AND i.valid_from IS NULL;
UPDATE public.scenario_injects SET valid_from = NOW() WHERE valid_from IS NULL;
ALTER TABLE public.scenario_injects ALTER COLUMN valid_from SET DEFAULT NOW();
ALTER TABLE public.scenario_injects ALTER COLUMN valid_from SET NOT NULL;

ALTER TABLE public.scenario_injects ADD COLUMN IF NOT EXISTS retired_at TIMESTAMPTZ;
ALTER TABLE public.scenario_injects ADD COLUMN IF NOT EXISTS retired_by_edit UUID;
ALTER TABLE public.scenario_injects ADD COLUMN IF NOT EXISTS retire_reason TEXT;
ALTER TABLE public.scenario_injects ADD COLUMN IF NOT EXISTS superseded_by UUID;

ALTER TABLE public.scenario_injects DROP CONSTRAINT IF EXISTS scenario_injects_retire_reason_check;
ALTER TABLE public.scenario_injects
  ADD CONSTRAINT scenario_injects_retire_reason_check
  CHECK (retire_reason IN ('removed', 'renamed', 'revised'));

ALTER TABLE public.scenario_objectives ADD COLUMN IF NOT EXISTS retired_at TIMESTAMPTZ;

-- Replace UNIQUE(scenario_id, team_name) with a partial unique index so a retired
-- name can coexist with its successor. The constraint name is whatever Postgres
-- assigned (migration 011 does not name it).
DO $$
DECLARE
  constraint_name text;
BEGIN
  SELECT c.conname INTO constraint_name
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public'
    AND t.relname = 'scenario_teams'
    AND c.contype = 'u'
    AND (
      SELECT array_agg(a.attname::text ORDER BY cols.ord)
      FROM unnest(c.conkey) WITH ORDINALITY AS cols(attnum, ord)
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = cols.attnum
    ) = ARRAY['scenario_id', 'team_name']::text[];
  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.scenario_teams DROP CONSTRAINT %I', constraint_name);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_scenario_teams_active_name
  ON public.scenario_teams (scenario_id, team_name)
  WHERE retired_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_scenario_teams_scenario_uid
  ON public.scenario_teams (scenario_id, team_uid);

CREATE INDEX IF NOT EXISTS idx_scenario_injects_active_templates
  ON public.scenario_injects (scenario_id)
  WHERE session_id IS NULL AND retired_at IS NULL;

DO $$
BEGIN
  IF to_regclass('public.scenario_setup_edits') IS NULL THEN
    RAISE NOTICE '275: scenario_setup_edits is absent; retired_by_edit has no foreign key until migration 274 is applied';
    RETURN;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'scenario_teams_retired_by_edit_fkey'
  ) THEN
    ALTER TABLE public.scenario_teams
      ADD CONSTRAINT scenario_teams_retired_by_edit_fkey
      FOREIGN KEY (retired_by_edit) REFERENCES public.scenario_setup_edits(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'scenario_injects_retired_by_edit_fkey'
  ) THEN
    ALTER TABLE public.scenario_injects
      ADD CONSTRAINT scenario_injects_retired_by_edit_fkey
      FOREIGN KEY (retired_by_edit) REFERENCES public.scenario_setup_edits(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE OR REPLACE VIEW public.scenario_team_names AS
SELECT scenario_id, team_uid, team_name, valid_from, retired_at
FROM public.scenario_teams;

REVOKE ALL ON TABLE public.scenario_team_names FROM anon, authenticated;

COMMIT;
