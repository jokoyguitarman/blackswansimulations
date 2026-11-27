-- Migration 269: simulated NPC phone calls (OpenAI Realtime voice) and their transcripts.
-- NOT APPLIED. Applying this to the shared Supabase project needs the user's explicit approval.
-- Idempotent: safe to run twice.
-- Rollback (branch or local database only, never the shared project):
--   DROP TABLE IF EXISTS sim_call_recents_views;
--   DROP TABLE IF EXISTS sim_call_turns;
--   DROP TABLE IF EXISTS sim_calls;
--   ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
--   (re-add the 172 notification type CHECK without 'missed_call')
--
-- The spec numbered this 270. 269 is the next free number after 268 on master.
-- uq_sim_calls_inject_first is per (session, inject, team), not per inject alone:
-- a multi-team call is one group per team, and a single (session, inject) unique
-- index cannot store that. The team key is recipient_teams[1] until WP12 adds line_team.
BEGIN;

CREATE TABLE IF NOT EXISTS sim_calls (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id         UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  inject_id          UUID REFERENCES scenario_injects(id) ON DELETE SET NULL,
  parent_call_id     UUID REFERENCES sim_calls(id) ON DELETE SET NULL,
  direction          TEXT NOT NULL DEFAULT 'inbound' CHECK (direction IN ('inbound','callback')),
  stakeholder_id     TEXT,
  caller_name        TEXT NOT NULL,
  caller_number      TEXT,
  voice              TEXT NOT NULL,
  script             JSONB NOT NULL DEFAULT '{}'::jsonb,
  recipient_user_ids UUID[],
  recipient_teams    TEXT[] NOT NULL DEFAULT '{}',
  status             TEXT NOT NULL DEFAULT 'ringing' CHECK (status IN
                       ('scheduled','ringing','connecting','active','ended','declined','missed','failed','cancelled')),
  mode               TEXT CHECK (mode IN ('voice','text')),
  -- Redial: attempts of one call share call_group_id (= id of attempt 1).
  call_group_id      UUID NOT NULL,
  attempt_no         INTEGER NOT NULL DEFAULT 1,
  max_attempts       INTEGER NOT NULL DEFAULT 1,
  scheduled_for      TIMESTAMPTZ,
  declined_user_ids  UUID[] NOT NULL DEFAULT '{}',
  -- Mood ladder (WP11): rung and wait profile used to build this call's script.
  mood_rung          TEXT,
  wait_profile       JSONB,
  ring_started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ring_deadline_at   TIMESTAMPTZ NOT NULL,
  answered_by        UUID REFERENCES user_profiles(id) ON DELETE SET NULL,
  answered_at        TIMESTAMPTZ,
  declined_by        UUID REFERENCES user_profiles(id) ON DELETE SET NULL,
  ended_at           TIMESTAMPTZ,
  end_reason         TEXT,
  max_seconds        INTEGER NOT NULL DEFAULT 300,
  openai_call_id     TEXT,
  transcript_source  TEXT CHECK (transcript_source IN ('sideband','client','text')),
  beats_done         TEXT[] NOT NULL DEFAULT '{}',
  duration_seconds   INTEGER,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sim_calls_session ON sim_calls (session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_sim_calls_open ON sim_calls (session_id) WHERE status IN ('scheduled','ringing','connecting','active');
CREATE UNIQUE INDEX IF NOT EXISTS uq_sim_calls_attempt ON sim_calls (session_id, call_group_id, attempt_no);
-- One inbound attempt 1 per inject per team line (empty string = session-wide).
CREATE UNIQUE INDEX IF NOT EXISTS uq_sim_calls_inject_first
  ON sim_calls (session_id, inject_id, (COALESCE(recipient_teams[1], '')))
  WHERE direction = 'inbound' AND attempt_no = 1 AND inject_id IS NOT NULL;

-- Per-user "last looked at Recents" cursor for the missed-call badge.
CREATE TABLE IF NOT EXISTS sim_call_recents_views (
  session_id     UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id        UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
  last_viewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (session_id, user_id)
);
ALTER TABLE sim_call_recents_views ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE sim_call_recents_views FROM anon, authenticated;

CREATE TABLE IF NOT EXISTS sim_call_turns (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  call_id    UUID NOT NULL REFERENCES sim_calls(id) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  speaker    TEXT NOT NULL CHECK (speaker IN ('npc','player','system')),
  user_id    UUID REFERENCES user_profiles(id) ON DELETE SET NULL,
  text       TEXT NOT NULL,
  source     TEXT NOT NULL CHECK (source IN ('sideband','client','text')),
  at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (call_id, seq)
);
ALTER TABLE sim_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE sim_call_turns ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE sim_calls, sim_call_turns FROM anon, authenticated;

-- Missed-call notifications. Full list from migration 172, plus missed_call.
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check CHECK (type IN (
  'decision_approval_required', 'decision_approved', 'decision_rejected', 'decision_executed',
  'inject_published', 'incident_reported', 'incident_assigned', 'incident_updated',
  'chat_message', 'resource_request', 'resource_approved', 'resource_rejected', 'system_alert',
  'social_reply', 'social_like', 'social_mention', 'social_repost',
  'missed_call'
));

COMMIT;
