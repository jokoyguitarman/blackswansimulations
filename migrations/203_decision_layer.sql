-- Migration 203: decision layer — executives as players (contract §7A, runtime plan §5).
-- Idempotent.
BEGIN;

-- 1. player_actions vocabulary: list from 196 + decision_recorded ----------------------------
ALTER TABLE player_actions DROP CONSTRAINT IF EXISTS player_actions_action_type_check;
ALTER TABLE player_actions ADD CONSTRAINT player_actions_action_type_check CHECK (action_type IN (
  'post_created', 'reply_posted', 'post_liked', 'post_reposted',
  'post_flagged', 'post_reported', 'dm_sent', 'dm_read', 'email_sent',
  'email_read', 'call_answered', 'call_declined', 'news_read',
  'fact_checked', 'draft_created', 'draft_submitted_for_approval',
  'draft_approved', 'draft_published', 'escalated', 'chat_message_sent',
  'content_graded', 'misinfo_flagged',
  'group_post_created', 'group_joined', 'event_created', 'event_responded', 'event_discussed',
  'dispute_filed', 'dispute_upheld', 'dispute_rejected',
  'intel_shared',
  'decision_recorded'
));

-- 2. Recorded executive decisions -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS session_decisions (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id         UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  org_key            TEXT NOT NULL,
  decision_key       TEXT NOT NULL,
  title              TEXT NOT NULL,
  recorded_by        UUID NOT NULL REFERENCES user_profiles(id),
  team_name          TEXT NOT NULL,
  scope              TEXT,
  rationale          TEXT,
  effective_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  recorded_at_minute INTEGER NOT NULL,
  recorded_by_trainer BOOLEAN NOT NULL DEFAULT FALSE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (session_id, org_key, decision_key)
);
CREATE INDEX IF NOT EXISTS idx_session_decisions_session ON session_decisions (session_id, created_at);
ALTER TABLE session_decisions ENABLE ROW LEVEL SECURITY;

-- 3. Which latent grievance a stakeholder is currently on (null row / null key = base) ---------
CREATE TABLE IF NOT EXISTS stakeholder_state (
  session_id          UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  stakeholder_id      TEXT NOT NULL,
  active_decision_key TEXT,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (session_id, stakeholder_id)
);
ALTER TABLE stakeholder_state ENABLE ROW LEVEL SECURITY;

-- 4. SOP obligations created by a decision ---------------------------------------------------
CREATE TABLE IF NOT EXISTS decision_obligations (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id      UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  decision_id     UUID NOT NULL REFERENCES session_decisions(id) ON DELETE CASCADE,
  stakeholder_id  TEXT NOT NULL,
  by_function     TEXT NOT NULL,
  description     TEXT NOT NULL,
  due_at_minute   INTEGER NOT NULL,
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'met', 'lapsed')),
  met_by_user_id  UUID REFERENCES user_profiles(id) ON DELETE SET NULL,
  met_at          TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (decision_id, stakeholder_id, by_function)
);
CREATE INDEX IF NOT EXISTS idx_decision_obligations_open
  ON decision_obligations (session_id, status) WHERE status = 'open';
ALTER TABLE decision_obligations ENABLE ROW LEVEL SECURITY;

-- 5. session_events: list from 201 + decision_recorded / obligation_met / obligation_lapsed ------
ALTER TABLE session_events DROP CONSTRAINT IF EXISTS session_events_event_type_check;
ALTER TABLE session_events ADD CONSTRAINT session_events_event_type_check CHECK (event_type IN (
  'decision', 'decision_executed', 'inject', 'inject_cancelled', 'ai_step_start', 'ai_step_end',
  'communication', 'resource_change', 'status_update', 'incident', 'media_post', 'message',
  'bomb_squad_sweep', 'patient_queue_processed', 'hazard_queue_processed',
  'quality_failure_inject_fired', 'zone_skip_violation', 'friction_inject_fired',
  'state_effect_managed', 'direction_intent',
  'trainer_alert', 'consequence_inject', 'antagonist_post', 'antagonist_reply',
  'extremist_post', 'extremist_reply', 'director_action', 'evaluator_result',
  'inject_modified', 'inject_delayed', 'stakeholder_verdict',
  'decision_recorded', 'obligation_met', 'obligation_lapsed'
));

COMMIT;
