-- Migration 268: per-inject delivery and response ledger.
-- NOT APPLIED. Applying this to the shared Supabase project needs the user's explicit approval.
-- Idempotent: safe to run twice.
-- Rollback (branch or local database only, never the shared project):
--   DROP TABLE IF EXISTS inject_responses;
--   DROP TABLE IF EXISTS inject_deliveries;
--   ALTER TABLE chat_messages DROP COLUMN IF EXISTS inject_id;
--   (and re-add the 203 player_actions action CHECK)
BEGIN;

CREATE TABLE IF NOT EXISTS inject_deliveries (
  id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id              UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  inject_id               UUID NOT NULL REFERENCES scenario_injects(id) ON DELETE CASCADE,
  inject_key              TEXT NOT NULL,
  channel                 TEXT NOT NULL CHECK (channel IN
                            ('email','chat','npc_dm','messenger_dm','call','social','news')),
  ref_table               TEXT NOT NULL CHECK (ref_table IN
                            ('sim_emails','chat_messages','sim_direct_messages','sim_calls','social_posts','sim_news_articles')),
  ref_id                  UUID NOT NULL,
  chat_channel_id         UUID,
  thread_id               UUID,
  recipient_user_ids      UUID[],
  recipient_teams         TEXT[] NOT NULL DEFAULT '{}',
  stakeholder_id          TEXT,
  sender_name             TEXT,
  requires_response       BOOLEAN NOT NULL DEFAULT FALSE,
  response_window_minutes INTEGER,
  delivered_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivered_minute        INTEGER NOT NULL,
  first_opened_at         TIMESTAMPTZ,
  first_opened_by         UUID REFERENCES user_profiles(id) ON DELETE SET NULL,
  first_response_at       TIMESTAMPTZ,
  first_response_minute   INTEGER,
  first_response_by       UUID REFERENCES user_profiles(id) ON DELETE SET NULL,
  first_response_team     TEXT,
  response_count          INTEGER NOT NULL DEFAULT 0,
  call_state              TEXT CHECK (call_state IN ('ringing','answered','declined','missed','ended','failed')),
  -- Calls (WP5): every ring is its own delivery; attempts of one call share call_group_id.
  call_group_id           UUID,
  attempt_no              INTEGER NOT NULL DEFAULT 1,
  -- Escalation chains (WP10): follow-up deliveries point at the root delivery of their chain.
  chain_root_delivery_id  UUID REFERENCES inject_deliveries(id) ON DELETE CASCADE,
  chain_root_key          TEXT,
  chain_step              INTEGER,
  urgency                 TEXT CHECK (urgency IN ('reminder','follow_up','urgent','final','escalated')),
  -- Mood ladder (WP11): the stakeholder's rung when this was delivered.
  mood_rung               TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (ref_table, ref_id)
);
CREATE INDEX IF NOT EXISTS idx_inj_deliv_chain ON inject_deliveries (chain_root_delivery_id)
  WHERE chain_root_delivery_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_inj_deliv_call_group ON inject_deliveries (call_group_id)
  WHERE call_group_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_inj_deliv_session ON inject_deliveries (session_id, delivered_at);
CREATE INDEX IF NOT EXISTS idx_inj_deliv_key ON inject_deliveries (session_id, inject_key);
CREATE INDEX IF NOT EXISTS idx_inj_deliv_chat ON inject_deliveries (chat_channel_id, delivered_at)
  WHERE channel IN ('chat','npc_dm');
CREATE INDEX IF NOT EXISTS idx_inj_deliv_thread ON inject_deliveries (thread_id) WHERE thread_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS inject_responses (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id        UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  delivery_id       UUID NOT NULL REFERENCES inject_deliveries(id) ON DELETE CASCADE,
  inject_id         UUID NOT NULL,
  inject_key        TEXT NOT NULL,
  channel           TEXT NOT NULL,
  ref_table         TEXT NOT NULL,
  ref_id            UUID NOT NULL,
  user_id           UUID REFERENCES user_profiles(id) ON DELETE SET NULL,
  team_name         TEXT,
  is_bot            BOOLEAN NOT NULL DEFAULT FALSE,
  attribution       TEXT NOT NULL CHECK (attribution IN
                      ('email_reply','email_forward','chat_reply_to','chat_heuristic','dm_thread',
                       'call_answered','call_transcript','call_returned','social_reply')),
  content_excerpt   TEXT,
  responded_at      TIMESTAMPTZ NOT NULL,
  response_minute   INTEGER NOT NULL,
  judgement         JSONB,
  judgement_status  TEXT NOT NULL DEFAULT 'pending'
                      CHECK (judgement_status IN ('pending','queued','done','skipped','failed','budget_denied')),
  judged_at         TIMESTAMPTZ,
  judge_model       TEXT,
  meta              JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Mood ladder (WP11): how long the player took and the rung the stakeholder was on when it arrived.
  wait_minutes      INTEGER,
  mood_rung         TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (delivery_id, ref_table, ref_id)
);
CREATE INDEX IF NOT EXISTS idx_inj_resp_session ON inject_responses (session_id, responded_at);
CREATE INDEX IF NOT EXISTS idx_inj_resp_pending ON inject_responses (session_id) WHERE judgement_status IN ('pending','queued');

ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS inject_id UUID REFERENCES scenario_injects(id) ON DELETE SET NULL;

ALTER TABLE player_actions DROP CONSTRAINT IF EXISTS player_actions_action_type_check;
ALTER TABLE player_actions ADD CONSTRAINT player_actions_action_type_check CHECK (action_type IN (
  'post_created','reply_posted','post_liked','post_reposted',
  'post_flagged','post_reported','dm_sent','dm_read','email_sent',
  'email_read','call_answered','call_declined','news_read',
  'fact_checked','draft_created','draft_submitted_for_approval',
  'draft_approved','draft_published','escalated','chat_message_sent',
  'content_graded','misinfo_flagged',
  'group_post_created','group_joined','event_created','event_responded','event_discussed',
  'dispute_filed','dispute_upheld','dispute_rejected',
  'intel_shared','decision_recorded',
  'call_missed','call_ended','call_returned'
));

ALTER TABLE inject_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE inject_responses ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE inject_deliveries, inject_responses FROM anon, authenticated;
COMMIT;
