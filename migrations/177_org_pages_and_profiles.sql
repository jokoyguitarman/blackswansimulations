-- Migration 177: Org Pages and Personal Profiles
-- Adds sim_org_pages table for company/brand page accounts,
-- posted_by tracking for org page posts, and branded history flag.

BEGIN;

-- Org pages table (1 per platform per session)
CREATE TABLE IF NOT EXISTS sim_org_pages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  platform TEXT NOT NULL DEFAULT 'facebook' CHECK (platform IN ('facebook', 'x_twitter')),
  page_name TEXT NOT NULL,
  page_handle TEXT NOT NULL,
  page_bio TEXT,
  page_avatar_seed TEXT,
  follower_count INTEGER DEFAULT 10000,
  verified BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(session_id, platform)
);

-- Track which real player posted from the org page
ALTER TABLE social_posts ADD COLUMN IF NOT EXISTS posted_by_user_id UUID REFERENCES user_profiles(id) ON DELETE SET NULL;
ALTER TABLE social_posts ADD COLUMN IF NOT EXISTS posted_by_display_name TEXT;

-- Flag for pre-generated branded history posts
ALTER TABLE social_posts ADD COLUMN IF NOT EXISTS is_branded_history BOOLEAN DEFAULT false;

COMMIT;
