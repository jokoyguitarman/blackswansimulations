-- Migration 270: inject id on simulated direct messages.
-- NOT APPLIED. Applying this to the shared Supabase project needs the user's explicit approval.
-- Idempotent: safe to run twice.
-- Rollback (branch or local database only, never the shared project):
--   DROP INDEX IF EXISTS idx_sim_dms_inject;
--   ALTER TABLE sim_direct_messages DROP COLUMN IF EXISTS inject_id;
BEGIN;

ALTER TABLE sim_direct_messages
  ADD COLUMN IF NOT EXISTS inject_id UUID REFERENCES scenario_injects(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_sim_dms_inject ON sim_direct_messages (inject_id)
  WHERE inject_id IS NOT NULL;

COMMIT;
