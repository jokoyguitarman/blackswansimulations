-- Migration 194: Fixed teams for the social media crisis module
-- (a) Charter/expected-actions/scoring-rubric columns on scenario_teams so the four
--     built-in teams (Communications, Procurement, Sales, Legal) carry their
--     hardcoded-but-editable charters per scenario.
-- (b) team_at_action on player_actions: stamps the author's team at write time so
--     mid-session reassignment never retroactively shifts team scores.
-- (c) recipient_user_ids on sim_emails: per-recipient delivery for team-scoped
--     inject emails (NULL = visible to all participants, legacy behaviour).
-- (d) team_score_snapshots: periodic composite-score snapshots for trajectory charts.
BEGIN;

ALTER TABLE scenario_teams ADD COLUMN IF NOT EXISTS charter JSONB;
ALTER TABLE scenario_teams ADD COLUMN IF NOT EXISTS expected_actions JSONB;
ALTER TABLE scenario_teams ADD COLUMN IF NOT EXISTS scoring_rubric TEXT;

ALTER TABLE player_actions ADD COLUMN IF NOT EXISTS team_at_action TEXT;

ALTER TABLE sim_emails ADD COLUMN IF NOT EXISTS recipient_user_ids UUID[];
ALTER TABLE sim_emails ADD COLUMN IF NOT EXISTS target_teams TEXT[];

CREATE TABLE IF NOT EXISTS team_score_snapshots (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  team_name TEXT NOT NULL,
  composite_score NUMERIC,
  content_quality NUMERIC,
  task_completion NUMERIC,
  role_fit NUMERIC,
  tasks_done INTEGER DEFAULT 0,
  tasks_total INTEGER DEFAULT 0,
  member_count INTEGER DEFAULT 0,
  recorded_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_team_score_snapshots_session
  ON team_score_snapshots(session_id, team_name, recorded_at);

CREATE INDEX IF NOT EXISTS idx_player_actions_team
  ON player_actions(session_id, team_at_action);

COMMIT;
