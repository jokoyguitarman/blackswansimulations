-- Migration 280: per-session team dependency states.
-- NOT APPLIED. Applying this to the shared Supabase project needs the user's explicit approval.
-- Idempotent: safe to run twice.
-- Rollback (branch or local database only, never the shared project): DROP TABLE IF EXISTS session_dependency_states;
-- The spec numbered this 278. 278 is inject_triggers (WP4) and 279 is reserved for the director migration.
BEGIN;
CREATE TABLE IF NOT EXISTS session_dependency_states (
  session_id         UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  dep_id             TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','met','broken','recovered','waived')),
  upstream_team      TEXT,                 -- resolved name at first transition (history is never rewritten)
  downstream_teams   TEXT[] NOT NULL DEFAULT '{}',
  broken_minute      INTEGER,
  met_minute         INTEGER,
  recovered_minute   INTEGER,
  hold_until_minute  INTEGER,
  evidence           JSONB NOT NULL DEFAULT '[]'::jsonb,   -- [{ key, detail, minute }]
  waived_by          UUID REFERENCES user_profiles(id) ON DELETE SET NULL,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (session_id, dep_id)
);
ALTER TABLE session_dependency_states ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE session_dependency_states FROM anon, authenticated;
COMMIT;
