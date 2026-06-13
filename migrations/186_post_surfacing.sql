-- Migration 186: Echo-chamber post surfacing
-- When a player engages (react/flag/comment/repost) a targeted post (target_player_ids
-- or target_demographics), it is promoted to session-wide visibility so the whole team
-- can rally and fact-check together. Original targeting is preserved for after-action review.
BEGIN;
ALTER TABLE social_posts ADD COLUMN IF NOT EXISTS is_surfaced_to_session BOOLEAN DEFAULT FALSE;
ALTER TABLE social_posts ADD COLUMN IF NOT EXISTS surfaced_by UUID;
ALTER TABLE social_posts ADD COLUMN IF NOT EXISTS surfaced_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_social_posts_surfaced ON social_posts(session_id) WHERE is_surfaced_to_session = TRUE;
COMMIT;
