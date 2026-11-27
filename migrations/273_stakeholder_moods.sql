-- Migration 273: stakeholder mood ladder state.
-- NOT APPLIED. Applying this to the shared Supabase project needs the user's explicit approval.
-- Idempotent: safe to run twice.
-- Rollback (branch or local database only, never the shared project): DROP TABLE IF EXISTS stakeholder_moods;
BEGIN;

CREATE TABLE IF NOT EXISTS stakeholder_moods (
  session_id             UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  stakeholder_id         TEXT NOT NULL,
  scope_team             TEXT NOT NULL DEFAULT '',
  rung_id                TEXT NOT NULL,
  episode_anchor_minute  INTEGER,
  entered_minute         INTEGER NOT NULL,
  profile                JSONB NOT NULL,
  history                JSONB NOT NULL DEFAULT '[]'::jsonb,
  consequences_fired     TEXT[] NOT NULL DEFAULT '{}',
  locks                  JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (session_id, stakeholder_id, scope_team)
);

ALTER TABLE stakeholder_moods ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE stakeholder_moods FROM anon, authenticated;

COMMIT;
