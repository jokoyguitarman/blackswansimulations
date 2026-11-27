-- Migration 267: durable War Room scenario builds.
-- A build runs on the server, persists each stage's output, and survives client disconnects
-- and instance restarts (lease + claim). Spec: durable-scenario-builds-spec.md.
-- Tables are reached only through the service-role client; anon/authenticated get nothing.
-- Rollback, on a branch or local database only, never on the shared project:
--   DROP FUNCTION IF EXISTS public.start_warroom_build, public.claim_warroom_build,
--     public.renew_warroom_build_lease, public.complete_warroom_build_stage;
--   DROP TABLE IF EXISTS public.warroom_build_log, public.warroom_build_outputs, public.warroom_builds;
BEGIN;

CREATE TABLE IF NOT EXISTS public.warroom_builds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id UUID NOT NULL REFERENCES public.warroom_wizard_drafts(id) ON DELETE CASCADE,
  created_by UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
  pool TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','running','paused','succeeded','failed','cancelled')),
  current_stage TEXT
    CHECK (current_stage IN ('characters','storyline','convergence','pages')),
  stage_states JSONB NOT NULL,
  request JSONB NOT NULL,
  request_hash TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  error TEXT,
  error_code TEXT,
  cancel_requested_at TIMESTAMPTZ,
  cancel_reason TEXT CHECK (cancel_reason IN ('user','replaced','unwatched')),
  lease_owner TEXT,
  lease_token UUID,
  lease_expires_at TIMESTAMPTZ,
  interruptions INT NOT NULL DEFAULT 0,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  log_count INT NOT NULL DEFAULT 0,
  compile_status TEXT CHECK (compile_status IN ('running','succeeded','failed')),
  compile_heartbeat_at TIMESTAMPTZ,
  credit_ledger_id UUID,
  credit_invoice_id UUID,
  scenario_id UUID REFERENCES public.scenarios(id) ON DELETE SET NULL,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT warroom_builds_idempotency UNIQUE (draft_id, idempotency_key)
);

-- One active build per draft. A build whose cancel was requested no longer blocks a new one.
CREATE UNIQUE INDEX IF NOT EXISTS uq_warroom_builds_one_active_per_draft
  ON public.warroom_builds (draft_id)
  WHERE status IN ('queued','running') AND cancel_requested_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_warroom_builds_claim
  ON public.warroom_builds (pool, created_at)
  WHERE status IN ('queued','running');

CREATE INDEX IF NOT EXISTS idx_warroom_builds_draft_created
  ON public.warroom_builds (draft_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_warroom_builds_user_active
  ON public.warroom_builds (created_by)
  WHERE status IN ('queued','running');

CREATE TABLE IF NOT EXISTS public.warroom_build_outputs (
  build_id UUID NOT NULL REFERENCES public.warroom_builds(id) ON DELETE CASCADE,
  stage TEXT NOT NULL CHECK (stage IN ('characters','storyline','convergence','pages')),
  output JSONB NOT NULL,
  attempt INT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (build_id, stage)
);

CREATE TABLE IF NOT EXISTS public.warroom_build_log (
  seq BIGSERIAL PRIMARY KEY,
  build_id UUID NOT NULL REFERENCES public.warroom_builds(id) ON DELETE CASCADE,
  stage TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('progress','stage','warning','error','system')),
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_warroom_build_log_build_seq
  ON public.warroom_build_log (build_id, seq);

DROP TRIGGER IF EXISTS trg_warroom_builds_updated_at ON public.warroom_builds;
CREATE TRIGGER trg_warroom_builds_updated_at
BEFORE UPDATE ON public.warroom_builds
FOR EACH ROW EXECUTE PROCEDURE set_warroom_wizard_drafts_updated_at();

-- Start (or replay / attach to) a build atomically, serialised per draft.
CREATE OR REPLACE FUNCTION public.start_warroom_build(
  p_draft_id UUID, p_user_id UUID, p_pool TEXT, p_request JSONB, p_request_hash TEXT,
  p_idempotency_key TEXT, p_replace_active BOOLEAN
) RETURNS TABLE (out_build_id UUID, out_outcome TEXT)
LANGUAGE plpgsql AS $$
DECLARE
  v_row public.warroom_builds%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('warroom_build:' || p_draft_id::text));

  SELECT * INTO v_row FROM public.warroom_builds
   WHERE draft_id = p_draft_id AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    RETURN QUERY SELECT v_row.id, 'replayed'::text; RETURN;
  END IF;

  SELECT * INTO v_row FROM public.warroom_builds
   WHERE draft_id = p_draft_id AND status IN ('queued','running') AND cancel_requested_at IS NULL
   LIMIT 1;
  IF FOUND THEN
    IF v_row.request_hash = p_request_hash THEN
      RETURN QUERY SELECT v_row.id, 'attached'::text; RETURN;
    END IF;
    IF NOT p_replace_active THEN
      RETURN QUERY SELECT v_row.id, 'conflict'::text; RETURN;
    END IF;
    UPDATE public.warroom_builds
       SET cancel_requested_at = now(),
           cancel_reason = 'replaced',
           status = CASE WHEN status = 'queued' THEN 'cancelled' ELSE status END,
           finished_at = CASE WHEN status = 'queued' THEN now() ELSE finished_at END
     WHERE id = v_row.id;
  END IF;

  RETURN QUERY
  INSERT INTO public.warroom_builds
    (draft_id, created_by, pool, request, request_hash, idempotency_key, current_stage, stage_states)
  VALUES
    (p_draft_id, p_user_id, p_pool, p_request, p_request_hash, p_idempotency_key, 'characters',
     '{"characters":{"status":"pending","attempts":0},
       "storyline":{"status":"pending","attempts":0},
       "convergence":{"status":"pending","attempts":0},
       "pages":{"status":"pending","attempts":0}}'::jsonb)
  RETURNING id, 'created'::text;
END $$;

-- Claim one runnable build in a pool: queued, or running with an expired lease (orphaned).
-- Also finalises builds whose cancel was requested and whose owner is gone.
CREATE OR REPLACE FUNCTION public.claim_warroom_build(
  p_pool TEXT, p_instance TEXT, p_lease_seconds INT
) RETURNS SETOF public.warroom_builds
LANGUAGE plpgsql AS $$
DECLARE
  v_id UUID;
BEGIN
  UPDATE public.warroom_builds
     SET status = 'cancelled', finished_at = now(),
         lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL
   WHERE pool = p_pool
     AND cancel_requested_at IS NOT NULL
     AND (status = 'queued' OR (status = 'running' AND lease_expires_at < now()));

  SELECT id INTO v_id FROM public.warroom_builds
   WHERE pool = p_pool
     AND cancel_requested_at IS NULL
     AND (status = 'queued' OR (status = 'running' AND lease_expires_at < now()))
   ORDER BY created_at
   FOR UPDATE SKIP LOCKED
   LIMIT 1;
  IF v_id IS NULL THEN RETURN; END IF;

  RETURN QUERY
  UPDATE public.warroom_builds b
     SET interruptions = b.interruptions + CASE WHEN b.status = 'running' THEN 1 ELSE 0 END,
         status = 'running',
         lease_owner = p_instance,
         lease_token = gen_random_uuid(),
         lease_expires_at = now() + make_interval(secs => p_lease_seconds),
         started_at = COALESCE(b.started_at, now())
   WHERE b.id = v_id
  RETURNING b.*;
END $$;

-- Renew a lease. 'ok' | 'cancel_requested' | 'lost' (row gone, token changed, or not running).
CREATE OR REPLACE FUNCTION public.renew_warroom_build_lease(
  p_build_id UUID, p_lease_token UUID, p_lease_seconds INT
) RETURNS TEXT
LANGUAGE plpgsql AS $$
DECLARE
  v_cancel TIMESTAMPTZ;
BEGIN
  UPDATE public.warroom_builds
     SET lease_expires_at = now() + make_interval(secs => p_lease_seconds)
   WHERE id = p_build_id AND lease_token = p_lease_token AND status = 'running'
  RETURNING cancel_requested_at INTO v_cancel;
  IF NOT FOUND THEN RETURN 'lost'; END IF;
  IF v_cancel IS NOT NULL THEN RETURN 'cancel_requested'; END IF;
  RETURN 'ok';
END $$;

-- Persist a finished stage and advance, only while holding the lease. p_final_status: NULL or 'succeeded'.
CREATE OR REPLACE FUNCTION public.complete_warroom_build_stage(
  p_build_id UUID, p_lease_token UUID, p_stage TEXT, p_attempt INT, p_output JSONB,
  p_stage_states JSONB, p_next_stage TEXT, p_final_status TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM public.warroom_builds
   WHERE id = p_build_id AND lease_token = p_lease_token AND status = 'running'
   FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;

  INSERT INTO public.warroom_build_outputs (build_id, stage, output, attempt)
  VALUES (p_build_id, p_stage, p_output, p_attempt)
  ON CONFLICT (build_id, stage)
  DO UPDATE SET output = EXCLUDED.output, attempt = EXCLUDED.attempt, created_at = now();

  UPDATE public.warroom_builds
     SET stage_states = p_stage_states,
         current_stage = p_next_stage,
         status = COALESCE(p_final_status, status),
         finished_at = CASE WHEN p_final_status IS NULL THEN finished_at ELSE now() END,
         lease_owner = CASE WHEN p_final_status IS NULL THEN lease_owner ELSE NULL END,
         lease_token = CASE WHEN p_final_status IS NULL THEN lease_token ELSE NULL END,
         lease_expires_at = CASE WHEN p_final_status IS NULL THEN lease_expires_at ELSE NULL END
   WHERE id = p_build_id;
  RETURN true;
END $$;

ALTER TABLE public.warroom_builds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.warroom_build_outputs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.warroom_build_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.warroom_builds, public.warroom_build_outputs, public.warroom_build_log
  FROM anon, authenticated;
REVOKE ALL ON SEQUENCE public.warroom_build_log_seq_seq FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION
  public.start_warroom_build(UUID, UUID, TEXT, JSONB, TEXT, TEXT, BOOLEAN),
  public.claim_warroom_build(TEXT, TEXT, INT),
  public.renew_warroom_build_lease(UUID, UUID, INT),
  public.complete_warroom_build_stage(UUID, UUID, TEXT, INT, JSONB, JSONB, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.start_warroom_build(UUID, UUID, TEXT, JSONB, TEXT, TEXT, BOOLEAN),
  public.claim_warroom_build(TEXT, TEXT, INT),
  public.renew_warroom_build_lease(UUID, UUID, INT),
  public.complete_warroom_build_stage(UUID, UUID, TEXT, INT, JSONB, JSONB, TEXT, TEXT)
  TO service_role;

COMMIT;
