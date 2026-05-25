-- Migration 179: Allow separate reactions per identity (personal vs page)
BEGIN;

ALTER TABLE social_post_likes ADD COLUMN IF NOT EXISTS reacted_as TEXT NOT NULL DEFAULT 'personal';

ALTER TABLE social_post_likes DROP CONSTRAINT IF EXISTS social_post_likes_post_id_player_id_key;
ALTER TABLE social_post_likes ADD CONSTRAINT social_post_likes_post_player_identity_key UNIQUE (post_id, player_id, reacted_as);

COMMIT;
