-- Migration 224: indexes for the admin queue and library look-ups (WS1, section 6.7).
-- Rollback: DROP INDEX IF EXISTS for each index below.
BEGIN;

CREATE INDEX IF NOT EXISTS idx_doctrine_versions_review_queue
  ON public.doctrine_versions (created_at)
  WHERE review_status = 'unverified';

CREATE INDEX IF NOT EXISTS idx_doctrine_versions_flagged
  ON public.doctrine_versions (created_at)
  WHERE review_status = 'unverified' AND cardinality(screen_flags) > 0;

CREATE INDEX IF NOT EXISTS idx_doctrine_reports_open
  ON public.doctrine_reports (created_at)
  WHERE status = 'open';

CREATE INDEX IF NOT EXISTS idx_doctrines_library_active
  ON public.doctrines (archetype_key, latest_verified_version)
  WHERE visibility = 'library' AND retired_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_doctrines_owner
  ON public.doctrines (owner_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_doctrines_scope_draft
  ON public.doctrines (scope_draft_id)
  WHERE scope_draft_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_doctrines_applies_to
  ON public.doctrines USING gin (applies_to);

COMMIT;
