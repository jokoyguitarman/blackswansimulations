-- Migration 171: Add reaction types to social_post_likes for Facebook-style reactions

ALTER TABLE social_post_likes ADD COLUMN IF NOT EXISTS reaction_type TEXT DEFAULT 'like';

DO $$ BEGIN
  ALTER TABLE social_post_likes ADD CONSTRAINT social_post_likes_reaction_type_check
    CHECK (reaction_type IN ('like', 'love', 'haha', 'wow', 'angry', 'sad'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_social_post_likes_reaction ON social_post_likes(post_id, reaction_type);
