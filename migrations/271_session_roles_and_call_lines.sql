-- Migration 271: player roles, team call lines and line holders (call takers).
-- NOT APPLIED. Applying this to the shared Supabase project needs the user's explicit approval.
-- Idempotent: safe to run twice.
-- Rollback (branch or local database only, never the shared project):
--   DROP TABLE IF EXISTS session_role_assignments;
--   DROP TABLE IF EXISTS session_call_takers;
--   DROP TABLE IF EXISTS session_call_lines;
--   ALTER TABLE sim_calls DROP COLUMN IF EXISTS line_team, DROP COLUMN IF EXISTS target_mode,
--     DROP COLUMN IF EXISTS target_role_id, DROP COLUMN IF EXISTS rung_user_ids, DROP COLUMN IF EXISTS missed_reason;
--   ALTER TABLE inject_deliveries DROP COLUMN IF EXISTS line_team, DROP COLUMN IF EXISTS target_role_id,
--     DROP COLUMN IF EXISTS fallback_reason;
--   ALTER TABLE sessions DROP COLUMN IF EXISTS call_policy, DROP COLUMN IF EXISTS start_override;
-- Spec placeholder number was 274. 271 is the next free number on master (270 is the DM inject id).
BEGIN;

-- Player ↔ scenario role. One player may hold several roles; a role may have up to max_per_session players.
CREATE TABLE IF NOT EXISTS session_role_assignments (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id   UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role_id      TEXT NOT NULL,
  user_id      UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
  source       TEXT NOT NULL CHECK (source IN ('trainer_lobby','lobby_autofill','trainer_console')),
  assigned_by  UUID REFERENCES user_profiles(id) ON DELETE SET NULL,
  active       BOOLEAN NOT NULL DEFAULT TRUE,
  assigned_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at     TIMESTAMPTZ,
  end_reason   TEXT CHECK (end_reason IN ('trainer_removed','left_team','left_session','session_ended'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_role_assign_active
  ON session_role_assignments (session_id, role_id, user_id) WHERE active;
CREATE INDEX IF NOT EXISTS idx_role_assign_session ON session_role_assignments (session_id) WHERE active;

-- One row per team line; version supports optimistic concurrency for auto-assignment.
CREATE TABLE IF NOT EXISTS session_call_lines (
  session_id       UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  team_name        VARCHAR(100) NOT NULL,
  version          INTEGER NOT NULL DEFAULT 0,
  unattended_since TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (session_id, team_name)
);

CREATE TABLE IF NOT EXISTS session_call_takers (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id   UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  team_name    VARCHAR(100) NOT NULL,
  user_id      UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
  source       TEXT NOT NULL CHECK (source IN ('trainer_lobby','lobby_autofill','auto_reassign','trainer_console')),
  assigned_by  UUID REFERENCES user_profiles(id) ON DELETE SET NULL,
  active       BOOLEAN NOT NULL DEFAULT TRUE,
  assigned_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at     TIMESTAMPTZ,
  end_reason   TEXT CHECK (end_reason IN ('trainer_removed','offline_reassigned','left_team','session_ended')),
  FOREIGN KEY (session_id, team_name) REFERENCES session_call_lines(session_id, team_name) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_call_taker_active
  ON session_call_takers (session_id, team_name, user_id) WHERE active;
CREATE INDEX IF NOT EXISTS idx_call_takers_session ON session_call_takers (session_id) WHERE active;

ALTER TABLE sim_calls ADD COLUMN IF NOT EXISTS line_team TEXT;
ALTER TABLE sim_calls ADD COLUMN IF NOT EXISTS target_mode TEXT NOT NULL DEFAULT 'line'
  CHECK (target_mode IN ('line','role','player','ring_all'));
ALTER TABLE sim_calls ADD COLUMN IF NOT EXISTS target_role_id TEXT;
ALTER TABLE sim_calls ADD COLUMN IF NOT EXISTS rung_user_ids UUID[] NOT NULL DEFAULT '{}';
ALTER TABLE sim_calls ADD COLUMN IF NOT EXISTS missed_reason TEXT
  CHECK (missed_reason IN ('no_answer','declined','line_busy','line_unattended','role_busy','role_offline'));
CREATE INDEX IF NOT EXISTS idx_sim_calls_line ON sim_calls (session_id, line_team);
CREATE INDEX IF NOT EXISTS idx_sim_calls_role ON sim_calls (session_id, target_role_id) WHERE target_role_id IS NOT NULL;

ALTER TABLE inject_deliveries ADD COLUMN IF NOT EXISTS line_team TEXT;
ALTER TABLE inject_deliveries ADD COLUMN IF NOT EXISTS target_role_id TEXT;
ALTER TABLE inject_deliveries ADD COLUMN IF NOT EXISTS fallback_reason TEXT
  CHECK (fallback_reason IN ('role_unassigned','role_vacated','role_offline_fallback','role_fallback_after_minutes','trainer_reroute','unknown_role'));

-- Per-session call policy (NULL = code defaults) and the start-override record.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS call_policy JSONB;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS start_override JSONB;

ALTER TABLE session_role_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_call_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_call_takers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE session_role_assignments, session_call_lines, session_call_takers FROM anon, authenticated;
COMMIT;
