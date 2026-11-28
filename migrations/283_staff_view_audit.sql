-- Migration 283: staff view audit.
-- NOT APPLIED. Applying this to the shared Supabase project needs the user's explicit approval.
-- Idempotent: safe to run twice.
-- Rollback (branch or local database only, never the shared project):
--   DROP TABLE IF EXISTS staff_view_audit;
--
-- One row per (session, staff, subject, mode). A null subject (spectator, no
-- view-as player) is stored as the nil uuid in the unique index so those rows
-- cannot multiply. `mode` includes `sandbox` so WP9 does not alter this check.
-- Service role only: RLS on, no policies, revoked from anon and authenticated.

BEGIN;

CREATE TABLE IF NOT EXISTS staff_view_audit (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id       UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  staff_user_id    UUID NOT NULL,
  subject_user_id  UUID,
  mode             TEXT NOT NULL CHECK (mode IN ('spectator', 'view_as', 'sandbox')),
  first_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  request_count    INTEGER NOT NULL DEFAULT 1 CHECK (request_count >= 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS staff_view_audit_subject_key
  ON staff_view_audit (
    session_id,
    staff_user_id,
    COALESCE(subject_user_id, '00000000-0000-0000-0000-000000000000'::uuid),
    mode
  );

ALTER TABLE staff_view_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE staff_view_audit FROM anon, authenticated;

COMMIT;
