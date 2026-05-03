-- Migration 168: Per-player likes and flags for social posts
-- Replaces the shared is_flagged_by_player boolean with per-player tracking

CREATE TABLE IF NOT EXISTS social_post_likes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  post_id UUID NOT NULL REFERENCES social_posts(id) ON DELETE CASCADE,
  player_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(post_id, player_id)
);

CREATE TABLE IF NOT EXISTS social_post_flags (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  post_id UUID NOT NULL REFERENCES social_posts(id) ON DELETE CASCADE,
  player_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(post_id, player_id)
);

CREATE INDEX IF NOT EXISTS idx_social_post_likes_post ON social_post_likes(post_id);
CREATE INDEX IF NOT EXISTS idx_social_post_likes_player ON social_post_likes(player_id);
CREATE INDEX IF NOT EXISTS idx_social_post_flags_post ON social_post_flags(post_id);
CREATE INDEX IF NOT EXISTS idx_social_post_flags_player ON social_post_flags(player_id);

ALTER TABLE social_post_likes ENABLE ROW LEVEL SECURITY;
ALTER TABLE social_post_flags ENABLE ROW LEVEL SECURITY;
