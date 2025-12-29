-- Unified Simulation Environment - Initial Database Schema
-- Run this in your Supabase SQL Editor

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- User Profiles (extends Supabase Auth)
CREATE TABLE IF NOT EXISTS user_profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  username TEXT UNIQUE NOT NULL,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN (
    'defence_liaison',
    'police_commander',
    'public_information_officer',
    'health_director',
    'civil_government',
    'utility_manager',
    'intelligence_analyst',
    'ngo_liaison',
    'trainer',
    'admin'
  )),
  agency_name TEXT NOT NULL,
  avatar_url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Scenarios
CREATE TABLE IF NOT EXISTS scenarios (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN (
    'cyber',
    'infrastructure',
    'civil_unrest',
    'natural_disaster',
    'health_emergency',
    'terrorism',
    'custom'
  )),
  difficulty TEXT NOT NULL CHECK (difficulty IN (
    'beginner',
    'intermediate',
    'advanced',
    'expert'
  )),
  duration_minutes INTEGER NOT NULL DEFAULT 60,
  objectives JSONB DEFAULT '[]'::jsonb,
  initial_state JSONB DEFAULT '{}'::jsonb,
  created_by UUID NOT NULL REFERENCES user_profiles(id),
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Scenario Injects (Event Injections)
CREATE TABLE IF NOT EXISTS scenario_injects (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  scenario_id UUID NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
  trigger_time_minutes INTEGER NOT NULL,
  trigger_condition TEXT,
  type TEXT NOT NULL CHECK (type IN (
    'media_report',
    'field_update',
    'citizen_call',
    'intel_brief',
    'resource_shortage',
    'weather_change',
    'political_pressure'
  )),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  affected_roles JSONB DEFAULT '[]'::jsonb,
  severity TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  requires_response BOOLEAN DEFAULT false,
  ai_generated BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Simulation Sessions
CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  scenario_id UUID NOT NULL REFERENCES scenarios(id),
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN (
    'scheduled',
    'in_progress',
    'paused',
    'completed',
    'cancelled'
  )),
  trainer_id UUID NOT NULL REFERENCES user_profiles(id),
  start_time TIMESTAMPTZ,
  end_time TIMESTAMPTZ,
  current_state JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Session Participants
CREATE TABLE IF NOT EXISTS session_participants (
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES user_profiles(id),
  role TEXT NOT NULL,
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (session_id, user_id)
);

-- Incidents
CREATE TABLE IF NOT EXISTS incidents (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  location_lat DECIMAL(10, 8),
  location_lng DECIMAL(11, 8),
  type TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  status TEXT NOT NULL DEFAULT 'reported' CHECK (status IN (
    'reported',
    'acknowledged',
    'responding',
    'resolved'
  )),
  reported_by UUID NOT NULL REFERENCES user_profiles(id),
  assigned_agencies JSONB DEFAULT '[]'::jsonb,
  reported_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Decisions
CREATE TABLE IF NOT EXISTS decisions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN (
    'public_statement',
    'resource_allocation',
    'emergency_declaration',
    'policy_change',
    'coordination_order'
  )),
  proposed_by UUID NOT NULL REFERENCES user_profiles(id),
  status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN (
    'proposed',
    'under_review',
    'approved',
    'rejected',
    'executed'
  )),
  consequences JSONB,
  executed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Decision Approval Steps
CREATE TABLE IF NOT EXISTS decision_steps (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  decision_id UUID NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  user_id UUID REFERENCES user_profiles(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  comment TEXT,
  timestamp TIMESTAMPTZ,
  required BOOLEAN DEFAULT true,
  step_order INTEGER NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Agency Resources
CREATE TABLE IF NOT EXISTS agency_resources (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  agency_id TEXT NOT NULL,
  personnel INTEGER DEFAULT 0,
  equipment JSONB DEFAULT '{}'::jsonb,
  budget DECIMAL(12, 2) DEFAULT 0,
  available BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(session_id, agency_id)
);

-- Resource Allocations
CREATE TABLE IF NOT EXISTS resource_allocations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  resource_id UUID NOT NULL REFERENCES agency_resources(id) ON DELETE CASCADE,
  agency_id TEXT NOT NULL,
  type TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  allocated_by UUID NOT NULL REFERENCES user_profiles(id),
  allocated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Resource Requests (Negotiations)
CREATE TABLE IF NOT EXISTS resource_requests (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  from_agency TEXT NOT NULL,
  to_agency TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending',
    'countered',
    'accepted',
    'rejected'
  )),
  counter_offer JSONB,
  created_by UUID NOT NULL REFERENCES user_profiles(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Chat Channels
CREATE TABLE IF NOT EXISTS chat_channels (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('public', 'inter_agency', 'private', 'command')),
  members JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Chat Messages
CREATE TABLE IF NOT EXISTS chat_messages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  channel_id UUID NOT NULL REFERENCES chat_channels(id) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  sender_id UUID NOT NULL REFERENCES user_profiles(id),
  content TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'text' CHECK (type IN ('text', 'system', 'sitrep', 'alert')),
  reply_to UUID REFERENCES chat_messages(id),
  attachments JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Media Posts (Simulated Social Media/News)
CREATE TABLE IF NOT EXISTS media_posts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('twitter', 'news', 'facebook', 'citizen_report')),
  author TEXT NOT NULL,
  content TEXT NOT NULL,
  sentiment TEXT NOT NULL CHECK (sentiment IN ('positive', 'neutral', 'negative')),
  reach INTEGER DEFAULT 0,
  engagement INTEGER DEFAULT 0,
  is_misinformation BOOLEAN DEFAULT false,
  ai_generated BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Sentiment Snapshots
CREATE TABLE IF NOT EXISTS sentiment_snapshots (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  sentiment_score INTEGER NOT NULL CHECK (sentiment_score >= 0 AND sentiment_score <= 100),
  media_attention INTEGER NOT NULL CHECK (media_attention >= 0 AND media_attention <= 100),
  political_pressure INTEGER NOT NULL CHECK (political_pressure >= 0 AND political_pressure <= 100),
  recorded_at TIMESTAMPTZ DEFAULT NOW()
);

-- Session Events (Event Sourcing for AAR)
CREATE TABLE IF NOT EXISTS session_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'decision',
    'inject',
    'communication',
    'resource_change',
    'status_update',
    'incident',
    'media_post'
  )),
  description TEXT NOT NULL,
  actor_id UUID REFERENCES user_profiles(id),
  actor_role TEXT,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- After-Action Review Reports
CREATE TABLE IF NOT EXISTS aar_reports (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  generated_by UUID NOT NULL REFERENCES user_profiles(id),
  summary TEXT NOT NULL,
  key_metrics JSONB DEFAULT '{}'::jsonb,
  recommendations JSONB DEFAULT '[]'::jsonb,
  ai_insights JSONB DEFAULT '[]'::jsonb,
  generated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Participant Performance Scores
CREATE TABLE IF NOT EXISTS participant_scores (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  aar_report_id UUID NOT NULL REFERENCES aar_reports(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES user_profiles(id),
  role TEXT NOT NULL,
  decisions_proposed INTEGER DEFAULT 0,
  communications_sent INTEGER DEFAULT 0,
  avg_response_time_minutes DECIMAL(10, 2),
  coordination_score INTEGER CHECK (coordination_score >= 0 AND coordination_score <= 100),
  leadership_score INTEGER CHECK (leadership_score >= 0 AND leadership_score <= 100),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_scenarios_created_by ON scenarios(created_by);
CREATE INDEX IF NOT EXISTS idx_scenarios_active ON scenarios(is_active);
CREATE INDEX IF NOT EXISTS idx_injects_scenario ON scenario_injects(scenario_id);
CREATE INDEX IF NOT EXISTS idx_sessions_scenario ON sessions(scenario_id);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_session_participants_session ON session_participants(session_id);
CREATE INDEX IF NOT EXISTS idx_incidents_session ON incidents(session_id);
CREATE INDEX IF NOT EXISTS idx_decisions_session ON decisions(session_id);
CREATE INDEX IF NOT EXISTS idx_decisions_status ON decisions(status);
CREATE INDEX IF NOT EXISTS idx_decision_steps_decision ON decision_steps(decision_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_channel ON chat_messages(channel_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id);
CREATE INDEX IF NOT EXISTS idx_session_events_session ON session_events(session_id);
CREATE INDEX IF NOT EXISTS idx_session_events_type ON session_events(event_type);
CREATE INDEX IF NOT EXISTS idx_media_posts_session ON media_posts(session_id);
CREATE INDEX IF NOT EXISTS idx_sentiment_snapshots_session ON sentiment_snapshots(session_id);

-- Updated_at triggers
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_user_profiles_updated_at BEFORE UPDATE ON user_profiles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_scenarios_updated_at BEFORE UPDATE ON scenarios
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_sessions_updated_at BEFORE UPDATE ON sessions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_incidents_updated_at BEFORE UPDATE ON incidents
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_decisions_updated_at BEFORE UPDATE ON decisions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_resource_requests_updated_at BEFORE UPDATE ON resource_requests
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_agency_resources_updated_at BEFORE UPDATE ON agency_resources
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

