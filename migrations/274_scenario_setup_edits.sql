-- Migration 274: scenario setup-edit allowance.
-- NOT APPLIED. Applying this to the shared Supabase project needs the user's explicit approval.
-- Idempotent: safe to run twice.
-- Does not reference objects from migrations 268–273.
-- Rollback (branch or local database only, never the shared project):
--   DROP FUNCTION IF EXISTS public.open_scenario_setup_edit(UUID, UUID, BOOLEAN, INT);
--   DROP FUNCTION IF EXISTS public.count_scenario_setup_edit(UUID, BOOLEAN, INT);
--   DROP TABLE IF EXISTS public.scenario_setup_edits;
--   ALTER TABLE public.scenarios DROP CONSTRAINT IF EXISTS scenarios_setup_edits_used_check;
--   ALTER TABLE public.scenarios DROP COLUMN IF EXISTS setup_edits_used;
BEGIN;

-- scenarios, user_profiles, warroom_wizard_drafts (160) and warroom_builds (267)
-- are the foreign keys. Fail here with a readable error instead of a raw
-- "relation does not exist" mid-statement.
DO $$
BEGIN
  IF to_regclass('public.scenarios') IS NULL THEN
    RAISE EXCEPTION 'Apply the scenarios migration before 274_scenario_setup_edits.sql';
  END IF;
  IF to_regclass('public.user_profiles') IS NULL THEN
    RAISE EXCEPTION 'Apply the user_profiles migration before 274_scenario_setup_edits.sql';
  END IF;
  IF to_regclass('public.warroom_wizard_drafts') IS NULL THEN
    RAISE EXCEPTION 'Apply migrations/160_warroom_wizard_drafts.sql before 274_scenario_setup_edits.sql';
  END IF;
  IF to_regclass('public.warroom_builds') IS NULL THEN
    RAISE EXCEPTION 'Apply migrations/267_warroom_durable_builds.sql before 274_scenario_setup_edits.sql';
  END IF;
  IF to_regprocedure('public.update_updated_at_column()') IS NULL THEN
    RAISE EXCEPTION 'Apply migrations/001_initial_schema.sql before 274_scenario_setup_edits.sql';
  END IF;
END $$;

ALTER TABLE public.scenarios
  ADD COLUMN IF NOT EXISTS setup_edits_used INT NOT NULL DEFAULT 0;

ALTER TABLE public.scenarios DROP CONSTRAINT IF EXISTS scenarios_setup_edits_used_check;
ALTER TABLE public.scenarios
  ADD CONSTRAINT scenarios_setup_edits_used_check CHECK (setup_edits_used >= 0);

CREATE TABLE IF NOT EXISTS public.scenario_setup_edits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scenario_id UUID NOT NULL REFERENCES public.scenarios(id) ON DELETE CASCADE,
  opened_by UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  opened_by_admin BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'applying', 'applied', 'abandoned', 'failed')),
  draft_id UUID REFERENCES public.warroom_wizard_drafts(id) ON DELETE SET NULL,
  build_id UUID REFERENCES public.warroom_builds(id) ON DELETE SET NULL,
  -- Empty object until a later change stores the reconstructed setup snapshot.
  -- baseline_hash is SHA-256 of the canonical JSON "{}".
  baseline JSONB NOT NULL,
  baseline_hash TEXT NOT NULL,
  edit_number INT,
  counted BOOLEAN NOT NULL DEFAULT false,
  apply_heartbeat_at TIMESTAMPTZ,
  applied_summary JSONB,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_at TIMESTAMPTZ
);

-- One edit in flight per scenario. Applied, abandoned and failed rows do not block.
CREATE UNIQUE INDEX IF NOT EXISTS uq_scenario_setup_edits_one_inflight
  ON public.scenario_setup_edits (scenario_id)
  WHERE status IN ('open', 'applying');

CREATE INDEX IF NOT EXISTS idx_scenario_setup_edits_scenario_created
  ON public.scenario_setup_edits (scenario_id, created_at DESC);

DROP TRIGGER IF EXISTS trg_scenario_setup_edits_updated_at ON public.scenario_setup_edits;
CREATE TRIGGER trg_scenario_setup_edits_updated_at
BEFORE UPDATE ON public.scenario_setup_edits
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Open (or resume) one edit. Does not change scenarios.setup_edits_used.
-- out_outcome: opened | existing | busy | limit_reached | not_found.
CREATE OR REPLACE FUNCTION public.open_scenario_setup_edit(
  p_scenario_id UUID,
  p_user_id UUID,
  p_is_admin BOOLEAN,
  p_limit INT
) RETURNS TABLE (out_edit_id UUID, out_outcome TEXT)
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_used INT;
  v_id UUID;
  v_status TEXT;
  v_opened_by UUID;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('scenario_setup_edit:' || p_scenario_id::text));

  SELECT setup_edits_used INTO v_used
    FROM public.scenarios
   WHERE id = p_scenario_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT NULL::UUID, 'not_found'::TEXT;
    RETURN;
  END IF;

  SELECT id, status, opened_by INTO v_id, v_status, v_opened_by
    FROM public.scenario_setup_edits
   WHERE scenario_id = p_scenario_id
     AND status IN ('open', 'applying')
   ORDER BY created_at
   LIMIT 1;
  IF FOUND THEN
    -- Resume only a still-open edit. An apply in progress stays busy.
    IF v_status = 'open' AND v_opened_by IS NOT DISTINCT FROM p_user_id THEN
      RETURN QUERY SELECT v_id, 'existing'::TEXT;
      RETURN;
    END IF;
    RETURN QUERY SELECT v_id, 'busy'::TEXT;
    RETURN;
  END IF;

  IF NOT COALESCE(p_is_admin, false)
     AND v_used >= GREATEST(COALESCE(p_limit, 0), 0) THEN
    RETURN QUERY SELECT NULL::UUID, 'limit_reached'::TEXT;
    RETURN;
  END IF;

  INSERT INTO public.scenario_setup_edits (
    scenario_id, opened_by, opened_by_admin, status, baseline, baseline_hash, counted
  ) VALUES (
    p_scenario_id,
    p_user_id,
    COALESCE(p_is_admin, false),
    'open',
    '{}'::jsonb,
    '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
    false
  )
  RETURNING id INTO v_id;

  RETURN QUERY SELECT v_id, 'opened'::TEXT;
EXCEPTION
  WHEN unique_violation THEN
    SELECT id, status, opened_by INTO v_id, v_status, v_opened_by
      FROM public.scenario_setup_edits
     WHERE scenario_id = p_scenario_id
       AND status IN ('open', 'applying')
     ORDER BY created_at
     LIMIT 1;
    IF NOT FOUND THEN
      RETURN QUERY SELECT NULL::UUID, 'busy'::TEXT;
      RETURN;
    END IF;
    IF v_status = 'open' AND v_opened_by IS NOT DISTINCT FROM p_user_id THEN
      RETURN QUERY SELECT v_id, 'existing'::TEXT;
      RETURN;
    END IF;
    RETURN QUERY SELECT v_id, 'busy'::TEXT;
END;
$$;

-- Called from the apply transaction. This is the only writer of setup_edits_used.
-- Returns counted | uncounted | limit_reached | already_counted | not_found.
CREATE OR REPLACE FUNCTION public.count_scenario_setup_edit(
  p_edit_id UUID,
  p_is_admin BOOLEAN,
  p_limit INT
) RETURNS TEXT
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_scenario_id UUID;
  v_used INT;
  v_counted BOOLEAN;
BEGIN
  SELECT scenario_id INTO v_scenario_id
    FROM public.scenario_setup_edits
   WHERE id = p_edit_id;
  IF NOT FOUND THEN
    RETURN 'not_found';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('scenario_setup_edit:' || v_scenario_id::text));

  SELECT setup_edits_used INTO v_used
    FROM public.scenarios
   WHERE id = v_scenario_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'not_found';
  END IF;

  SELECT counted INTO v_counted
    FROM public.scenario_setup_edits
   WHERE id = p_edit_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'not_found';
  END IF;

  IF v_counted THEN
    RETURN 'already_counted';
  END IF;

  IF COALESCE(p_is_admin, false) THEN
    UPDATE public.scenario_setup_edits
       SET counted = false,
           edit_number = NULL
     WHERE id = p_edit_id;
    RETURN 'uncounted';
  END IF;

  IF v_used >= GREATEST(COALESCE(p_limit, 0), 0) THEN
    RETURN 'limit_reached';
  END IF;

  UPDATE public.scenarios
     SET setup_edits_used = setup_edits_used + 1
   WHERE id = v_scenario_id
   RETURNING setup_edits_used INTO v_used;

  UPDATE public.scenario_setup_edits
     SET counted = true,
         edit_number = v_used
   WHERE id = p_edit_id;

  RETURN 'counted';
END;
$$;

ALTER TABLE public.scenario_setup_edits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.scenario_setup_edits FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION
  public.open_scenario_setup_edit(UUID, UUID, BOOLEAN, INT),
  public.count_scenario_setup_edit(UUID, BOOLEAN, INT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.open_scenario_setup_edit(UUID, UUID, BOOLEAN, INT),
  public.count_scenario_setup_edit(UUID, BOOLEAN, INT)
  TO service_role;

COMMIT;
