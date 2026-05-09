-- Add user_id column to social_posts for tracking which player created a post
ALTER TABLE social_posts ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES user_profiles(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_social_posts_user_id ON social_posts(user_id);
