-- Migration 281: peace period clock on sessions, and a stable ref for peace-feed posts.
-- NOT APPLIED. Applying this to the shared Supabase project needs the user's explicit approval.
-- Idempotent: safe to run twice.
-- Rollback (branch or local database only, never the shared project):
--   DROP INDEX IF EXISTS social_posts_peace_ref_uq;
--   ALTER TABLE social_posts DROP COLUMN IF EXISTS peace_ref;
--   ALTER TABLE sessions DROP COLUMN IF EXISTS peace_seconds;
--   ALTER TABLE sessions DROP COLUMN IF EXISTS opened_at;
BEGIN;

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS opened_at timestamptz;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS peace_seconds integer CHECK (peace_seconds IS NULL OR peace_seconds BETWEEN 0 AND 3600);
ALTER TABLE social_posts ADD COLUMN IF NOT EXISTS peace_ref text;
CREATE UNIQUE INDEX IF NOT EXISTS social_posts_peace_ref_uq ON social_posts (session_id, peace_ref) WHERE peace_ref IS NOT NULL;

-- Backfill: opened_at = start_time for started sessions (no peace in history).
UPDATE sessions SET opened_at = start_time WHERE opened_at IS NULL AND start_time IS NOT NULL;

COMMIT;
