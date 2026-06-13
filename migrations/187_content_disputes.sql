-- Migration 187: Content dispute / fact-based takedown system
-- Players can challenge a news article or social post they believe spreads
-- misinformation by submitting counter-facts. An AI judge adjudicates against
-- the scenario fact sheet and retracts, corrects, or rejects the content.

BEGIN;

-- 1. Article moderation state
ALTER TABLE sim_news_articles ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'published';
DO $$ BEGIN
  ALTER TABLE sim_news_articles ADD CONSTRAINT sim_news_articles_status_check
    CHECK (status IN ('published', 'retracted', 'corrected'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
ALTER TABLE sim_news_articles ADD COLUMN IF NOT EXISTS correction_note TEXT;

-- 2. Optional removal reason on social posts (platform_removed already exists from 169)
ALTER TABLE social_posts ADD COLUMN IF NOT EXISTS removal_reason TEXT;

-- 3. Dispute requests
CREATE TABLE IF NOT EXISTS content_dispute_requests (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  requested_by UUID NOT NULL REFERENCES user_profiles(id),
  target_type TEXT NOT NULL CHECK (target_type IN ('article', 'post')),
  target_id UUID NOT NULL,
  claimed_falsehood TEXT NOT NULL,
  submitted_facts TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'upheld', 'corrected', 'rejected')),
  verdict_reason TEXT,
  ai_confidence NUMERIC,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_content_disputes_session_status
  ON content_dispute_requests(session_id, status);
CREATE INDEX IF NOT EXISTS idx_content_disputes_target
  ON content_dispute_requests(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_content_disputes_requested_by
  ON content_dispute_requests(session_id, requested_by);

COMMIT;
