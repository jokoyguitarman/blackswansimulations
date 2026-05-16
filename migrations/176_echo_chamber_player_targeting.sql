-- Migration 176: Echo chamber per-player post targeting
-- Adds target_player_ids column to social_posts for per-player feed bubbles

BEGIN;

ALTER TABLE social_posts ADD COLUMN IF NOT EXISTS target_player_ids UUID[] DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_social_posts_target_player_ids
  ON social_posts USING GIN (target_player_ids);

COMMIT;
