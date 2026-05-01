-- Migration 165: Social Media Crisis Simulation Platform tables

BEGIN;

-- 1. Add 'social_media_crisis' to the scenarios category CHECK constraint
ALTER TABLE scenarios DROP CONSTRAINT IF EXISTS scenarios_category_check;
ALTER TABLE scenarios ADD CONSTRAINT scenarios_category_check CHECK (category IN (
  'cyber',
  'infrastructure',
  'civil_unrest',
  'natural_disaster',
  'health_emergency',
  'terrorism',
  'custom',
  'social_media_crisis'
));

-- 2. Add delivery_config JSONB column to scenario_injects
ALTER TABLE scenario_injects ADD COLUMN IF NOT EXISTS delivery_config JSONB DEFAULT NULL;

-- 3. Add sim_mode column to sessions
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS sim_mode TEXT DEFAULT NULL;

-- 4. Create social_posts table
CREATE TABLE IF NOT EXISTS social_posts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  inject_id UUID REFERENCES scenario_injects(id),
  platform TEXT NOT NULL DEFAULT 'x_twitter' CHECK (platform IN ('x_twitter', 'facebook', 'instagram', 'tiktok', 'reddit', 'forum')),
  author_handle TEXT NOT NULL,
  author_display_name TEXT NOT NULL,
  author_avatar_seed TEXT,
  author_type TEXT NOT NULL DEFAULT 'npc_public' CHECK (author_type IN ('npc_public', 'npc_media', 'npc_politician', 'npc_influencer', 'player', 'official_account')),
  content TEXT NOT NULL,
  media_urls JSONB DEFAULT '[]',
  hashtags TEXT[] DEFAULT '{}',
  reply_to_post_id UUID REFERENCES social_posts(id),
  is_repost BOOLEAN DEFAULT false,
  original_post_id UUID REFERENCES social_posts(id),
  like_count INTEGER DEFAULT 0,
  repost_count INTEGER DEFAULT 0,
  reply_count INTEGER DEFAULT 0,
  view_count INTEGER DEFAULT 0,
  sentiment TEXT CHECK (sentiment IN ('positive', 'neutral', 'negative', 'hateful', 'inflammatory', 'supportive')),
  content_flags JSONB DEFAULT '{}',
  virality_score NUMERIC DEFAULT 0,
  is_flagged_by_player BOOLEAN DEFAULT false,
  player_response_id UUID,
  requires_response BOOLEAN DEFAULT false,
  response_deadline_minutes INTEGER,
  responded_at TIMESTAMPTZ,
  sop_compliance_score JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 5. Create sim_emails table
CREATE TABLE IF NOT EXISTS sim_emails (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  inject_id UUID REFERENCES scenario_injects(id),
  direction TEXT NOT NULL DEFAULT 'inbound' CHECK (direction IN ('inbound', 'outbound')),
  from_address TEXT NOT NULL,
  from_name TEXT NOT NULL,
  to_addresses TEXT[] NOT NULL DEFAULT '{}',
  cc_addresses TEXT[] DEFAULT '{}',
  subject TEXT NOT NULL,
  body_html TEXT NOT NULL,
  body_text TEXT NOT NULL,
  priority TEXT DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  attachments JSONB DEFAULT '[]',
  is_read BOOLEAN DEFAULT false,
  replied_to_id UUID REFERENCES sim_emails(id),
  thread_id UUID,
  sent_by_player_id UUID REFERENCES user_profiles(id),
  sop_compliance_score JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 6. Create sim_news_articles table
CREATE TABLE IF NOT EXISTS sim_news_articles (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  inject_id UUID REFERENCES scenario_injects(id),
  outlet_name TEXT NOT NULL,
  outlet_logo_seed TEXT,
  headline TEXT NOT NULL,
  subheadline TEXT,
  body TEXT NOT NULL,
  category TEXT DEFAULT 'breaking',
  is_factual BOOLEAN DEFAULT true,
  source_url TEXT,
  published_at TIMESTAMPTZ DEFAULT NOW()
);

-- 7. Create sop_definitions table
CREATE TABLE IF NOT EXISTS sop_definitions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  scenario_id UUID NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
  sop_name TEXT NOT NULL,
  description TEXT,
  steps JSONB NOT NULL DEFAULT '[]',
  response_time_limit_minutes INTEGER,
  escalation_rules JSONB,
  approval_chain JSONB,
  content_guidelines JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 8. Create player_actions table
CREATE TABLE IF NOT EXISTS player_actions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  player_id UUID NOT NULL REFERENCES user_profiles(id),
  action_type TEXT NOT NULL CHECK (action_type IN (
    'post_created', 'reply_posted', 'post_liked', 'post_reposted',
    'post_flagged', 'post_reported', 'dm_sent', 'email_sent',
    'email_read', 'call_answered', 'call_declined', 'news_read',
    'fact_checked', 'draft_created', 'draft_submitted_for_approval',
    'draft_approved', 'draft_published', 'escalated', 'chat_message_sent'
  )),
  target_id UUID,
  content TEXT,
  metadata JSONB DEFAULT '{}',
  sop_step_matched TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 9. Indexes for social_posts
CREATE INDEX IF NOT EXISTS idx_social_posts_session_id ON social_posts(session_id);
CREATE INDEX IF NOT EXISTS idx_social_posts_created_at ON social_posts(created_at);
CREATE INDEX IF NOT EXISTS idx_social_posts_inject_id ON social_posts(inject_id);
CREATE INDEX IF NOT EXISTS idx_social_posts_platform ON social_posts(platform);
CREATE INDEX IF NOT EXISTS idx_social_posts_author_type ON social_posts(author_type);
CREATE INDEX IF NOT EXISTS idx_social_posts_reply_to ON social_posts(reply_to_post_id);
CREATE INDEX IF NOT EXISTS idx_social_posts_requires_response ON social_posts(session_id, requires_response) WHERE requires_response = true;
CREATE INDEX IF NOT EXISTS idx_social_posts_virality ON social_posts(session_id, virality_score DESC);

-- Indexes for sim_emails
CREATE INDEX IF NOT EXISTS idx_sim_emails_session_id ON sim_emails(session_id);
CREATE INDEX IF NOT EXISTS idx_sim_emails_created_at ON sim_emails(created_at);
CREATE INDEX IF NOT EXISTS idx_sim_emails_inject_id ON sim_emails(inject_id);
CREATE INDEX IF NOT EXISTS idx_sim_emails_thread_id ON sim_emails(thread_id);
CREATE INDEX IF NOT EXISTS idx_sim_emails_direction ON sim_emails(session_id, direction);
CREATE INDEX IF NOT EXISTS idx_sim_emails_is_read ON sim_emails(session_id, is_read) WHERE is_read = false;

-- Indexes for sim_news_articles
CREATE INDEX IF NOT EXISTS idx_sim_news_articles_session_id ON sim_news_articles(session_id);
CREATE INDEX IF NOT EXISTS idx_sim_news_articles_published_at ON sim_news_articles(published_at);
CREATE INDEX IF NOT EXISTS idx_sim_news_articles_inject_id ON sim_news_articles(inject_id);

-- Indexes for sop_definitions
CREATE INDEX IF NOT EXISTS idx_sop_definitions_scenario_id ON sop_definitions(scenario_id);

-- Indexes for player_actions
CREATE INDEX IF NOT EXISTS idx_player_actions_session_id ON player_actions(session_id);
CREATE INDEX IF NOT EXISTS idx_player_actions_created_at ON player_actions(created_at);
CREATE INDEX IF NOT EXISTS idx_player_actions_player_id ON player_actions(player_id);
CREATE INDEX IF NOT EXISTS idx_player_actions_action_type ON player_actions(session_id, action_type);

COMMIT;
