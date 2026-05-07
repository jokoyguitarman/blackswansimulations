-- Migration 169: Social crisis engagement engine
-- Adds algorithm-driven engagement simulation, post format system,
-- player demographics for echo chamber, and engagement logging for AAR.

BEGIN;

-- 1. Add post_format to social_posts (player-declared content strategy)
ALTER TABLE social_posts ADD COLUMN IF NOT EXISTS post_format TEXT DEFAULT 'text';
DO $$ BEGIN
  ALTER TABLE social_posts ADD CONSTRAINT social_posts_post_format_check
    CHECK (post_format IN ('text', 'official_statement', 'infographic', 'humor_meme', 'video_concept', 'personal_story'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 2. Add algorithm engine columns to social_posts
ALTER TABLE social_posts ADD COLUMN IF NOT EXISTS impression_pool INTEGER DEFAULT 0;
ALTER TABLE social_posts ADD COLUMN IF NOT EXISTS engagement_rate NUMERIC DEFAULT 0;
ALTER TABLE social_posts ADD COLUMN IF NOT EXISTS target_demographics JSONB DEFAULT NULL;
ALTER TABLE social_posts ADD COLUMN IF NOT EXISTS platform_removed BOOLEAN DEFAULT false;

-- 3. Add demographics to session_participants
ALTER TABLE session_participants ADD COLUMN IF NOT EXISTS demographics JSONB DEFAULT NULL;

-- 4. Create post_engagement_log for AAR trajectory reconstruction
CREATE TABLE IF NOT EXISTS post_engagement_log (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  post_id UUID NOT NULL REFERENCES social_posts(id) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  tick_number INTEGER NOT NULL,
  impressions_added INTEGER DEFAULT 0,
  npc_likes_added INTEGER DEFAULT 0,
  npc_reposts_added INTEGER DEFAULT 0,
  player_likes_added INTEGER DEFAULT 0,
  player_reposts_added INTEGER DEFAULT 0,
  engagement_rate NUMERIC DEFAULT 0,
  algorithm_action TEXT CHECK (algorithm_action IN ('expand', 'sustain', 'contract', 'suppress', 'removed')),
  impression_pool_after INTEGER DEFAULT 0,
  virality_score_after NUMERIC DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_post_engagement_log_post ON post_engagement_log(post_id);
CREATE INDEX IF NOT EXISTS idx_post_engagement_log_session ON post_engagement_log(session_id);
CREATE INDEX IF NOT EXISTS idx_post_engagement_log_tick ON post_engagement_log(session_id, tick_number);

-- 5. Index for algorithm-sorted feed queries
CREATE INDEX IF NOT EXISTS idx_social_posts_algorithm_sort ON social_posts(session_id, virality_score DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_social_posts_platform ON social_posts(session_id, platform);
CREATE INDEX IF NOT EXISTS idx_social_posts_not_removed ON social_posts(session_id, platform_removed) WHERE platform_removed = false;

-- 6. RLS for post_engagement_log (read-only for authenticated users)
ALTER TABLE post_engagement_log ENABLE ROW LEVEL SECURITY;

COMMIT;
