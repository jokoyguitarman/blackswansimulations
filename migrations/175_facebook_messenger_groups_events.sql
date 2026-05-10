-- Migration 175: Fakebook Messenger, Groups, and Events tables

BEGIN;

-- 1. Direct Messages
CREATE TABLE IF NOT EXISTS sim_direct_messages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  thread_id UUID NOT NULL,
  sender_handle TEXT NOT NULL,
  sender_display_name TEXT NOT NULL,
  sender_type TEXT NOT NULL DEFAULT 'npc_public' CHECK (sender_type IN ('npc_public', 'npc_media', 'npc_politician', 'npc_influencer', 'player', 'official_account')),
  recipient_handle TEXT NOT NULL,
  recipient_user_id UUID REFERENCES user_profiles(id) ON DELETE SET NULL,
  content TEXT NOT NULL,
  media_urls JSONB DEFAULT '[]',
  is_read BOOLEAN DEFAULT false,
  platform TEXT NOT NULL DEFAULT 'facebook' CHECK (platform IN ('facebook', 'x_twitter')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sim_dms_session ON sim_direct_messages(session_id);
CREATE INDEX IF NOT EXISTS idx_sim_dms_thread ON sim_direct_messages(thread_id);
CREATE INDEX IF NOT EXISTS idx_sim_dms_recipient ON sim_direct_messages(recipient_user_id, is_read);
CREATE INDEX IF NOT EXISTS idx_sim_dms_platform ON sim_direct_messages(session_id, platform);

-- 2. Groups
CREATE TABLE IF NOT EXISTS sim_groups (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  cover_image_url TEXT,
  group_type TEXT NOT NULL DEFAULT 'community' CHECK (group_type IN ('community', 'religious', 'neighborhood', 'activism', 'official')),
  member_count INTEGER DEFAULT 0,
  is_private BOOLEAN DEFAULT false,
  admin_handles TEXT[] DEFAULT '{}',
  platform TEXT NOT NULL DEFAULT 'facebook' CHECK (platform IN ('facebook', 'x_twitter')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sim_groups_session ON sim_groups(session_id);
CREATE INDEX IF NOT EXISTS idx_sim_groups_platform ON sim_groups(session_id, platform);

-- 3. Group Posts
CREATE TABLE IF NOT EXISTS sim_group_posts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  group_id UUID NOT NULL REFERENCES sim_groups(id) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  author_handle TEXT NOT NULL,
  author_display_name TEXT NOT NULL,
  author_type TEXT NOT NULL DEFAULT 'npc_public' CHECK (author_type IN ('npc_public', 'npc_media', 'npc_politician', 'npc_influencer', 'player', 'official_account')),
  content TEXT NOT NULL,
  media_urls JSONB DEFAULT '[]',
  like_count INTEGER DEFAULT 0,
  reply_count INTEGER DEFAULT 0,
  reply_to_post_id UUID REFERENCES sim_group_posts(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sim_group_posts_group ON sim_group_posts(group_id);
CREATE INDEX IF NOT EXISTS idx_sim_group_posts_session ON sim_group_posts(session_id);
CREATE INDEX IF NOT EXISTS idx_sim_group_posts_reply ON sim_group_posts(reply_to_post_id);

-- 4. Events
CREATE TABLE IF NOT EXISTS sim_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  cover_image_url TEXT,
  event_type TEXT NOT NULL DEFAULT 'community_meeting' CHECK (event_type IN ('protest', 'vigil', 'community_meeting', 'safety_patrol', 'solidarity')),
  location TEXT,
  event_date TEXT,
  organizer_handle TEXT NOT NULL,
  organizer_display_name TEXT NOT NULL,
  organizer_type TEXT NOT NULL DEFAULT 'npc_public',
  interested_count INTEGER DEFAULT 0,
  going_count INTEGER DEFAULT 0,
  platform TEXT NOT NULL DEFAULT 'facebook' CHECK (platform IN ('facebook', 'x_twitter')),
  discussion_post_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sim_events_session ON sim_events(session_id);
CREATE INDEX IF NOT EXISTS idx_sim_events_platform ON sim_events(session_id, platform);
CREATE INDEX IF NOT EXISTS idx_sim_events_type ON sim_events(session_id, event_type);

-- 5. Event Responses
CREATE TABLE IF NOT EXISTS sim_event_responses (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  event_id UUID NOT NULL REFERENCES sim_events(id) ON DELETE CASCADE,
  user_id UUID REFERENCES user_profiles(id) ON DELETE SET NULL,
  handle TEXT,
  response TEXT NOT NULL CHECK (response IN ('going', 'interested', 'not_going')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(event_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_sim_event_responses_event ON sim_event_responses(event_id);

-- 6. Event Discussion Posts (reuse sim_group_posts pattern but for events)
CREATE TABLE IF NOT EXISTS sim_event_discussions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  event_id UUID NOT NULL REFERENCES sim_events(id) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  author_handle TEXT NOT NULL,
  author_display_name TEXT NOT NULL,
  author_type TEXT NOT NULL DEFAULT 'npc_public',
  content TEXT NOT NULL,
  like_count INTEGER DEFAULT 0,
  reply_to_id UUID REFERENCES sim_event_discussions(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sim_event_discussions_event ON sim_event_discussions(event_id);
CREATE INDEX IF NOT EXISTS idx_sim_event_discussions_session ON sim_event_discussions(session_id);

-- 7. Add new player action types
ALTER TABLE player_actions DROP CONSTRAINT IF EXISTS player_actions_action_type_check;
ALTER TABLE player_actions ADD CONSTRAINT player_actions_action_type_check CHECK (action_type IN (
  'post_created', 'reply_posted', 'post_liked', 'post_reposted',
  'post_flagged', 'post_reported', 'dm_sent', 'dm_read', 'email_sent',
  'email_read', 'call_answered', 'call_declined', 'news_read',
  'fact_checked', 'draft_created', 'draft_submitted_for_approval',
  'draft_approved', 'draft_published', 'escalated', 'chat_message_sent',
  'content_graded', 'misinfo_flagged',
  'group_post_created', 'group_joined', 'event_created', 'event_responded', 'event_discussed'
));

COMMIT;
