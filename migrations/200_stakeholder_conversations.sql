-- Migration 200: cross-channel conversation log per stakeholder per session.
-- Runtime plan §3.4. Idempotent.
--
-- One log per (session, stakeholder) regardless of channel — the shared memory that makes a
-- common stakeholder the same person whether PNP emails her or NBI chats with her.

CREATE TABLE IF NOT EXISTS stakeholder_conversations (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id     UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  stakeholder_id TEXT NOT NULL,
  channel        TEXT NOT NULL CHECK (channel IN ('email', 'teamchat', 'messenger', 'phone')),
  direction      TEXT NOT NULL CHECK (direction IN ('player', 'npc')),
  user_id        UUID REFERENCES user_profiles(id) ON DELETE SET NULL,
  team_name      TEXT,
  function_key   TEXT,
  org_key        TEXT,
  content        TEXT NOT NULL,
  ref_table      TEXT,
  ref_id         UUID,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stk_conv_lookup
  ON stakeholder_conversations (session_id, stakeholder_id, created_at);
CREATE INDEX IF NOT EXISTS idx_stk_conv_player
  ON stakeholder_conversations (session_id, user_id) WHERE direction = 'player';

ALTER TABLE stakeholder_conversations ENABLE ROW LEVEL SECURITY;
-- Service-role only: the log is read by the engine and the trainer views, never directly by clients.
