-- Scenario State History
-- Tracks state snapshots for replay and AAR
-- Run this in your Supabase SQL Editor

-- Create scenario_state_history table
CREATE TABLE IF NOT EXISTS scenario_state_history (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  state_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  triggered_by_decision_id UUID REFERENCES decisions(id),
  triggered_by_inject_id UUID, -- Will add FK constraint when injects table exists
  created_at TIMESTAMPTZ DEFAULT NOW(),
  notes TEXT
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_state_history_session_id 
  ON scenario_state_history(session_id);
CREATE INDEX IF NOT EXISTS idx_state_history_created_at 
  ON scenario_state_history(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_state_history_decision_id 
  ON scenario_state_history(triggered_by_decision_id) 
  WHERE triggered_by_decision_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_state_history_inject_id 
  ON scenario_state_history(triggered_by_inject_id) 
  WHERE triggered_by_inject_id IS NOT NULL;

-- RLS Policies
ALTER TABLE scenario_state_history ENABLE ROW LEVEL SECURITY;

-- Drop policies if they exist (for idempotent migrations)
DROP POLICY IF EXISTS "Session participants can view state history" ON scenario_state_history;
DROP POLICY IF EXISTS "Trainers can view state history for their sessions" ON scenario_state_history;

-- Session participants can view state history for their sessions
CREATE POLICY "Session participants can view state history"
  ON scenario_state_history
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM sessions s
      WHERE s.id = scenario_state_history.session_id
      AND (
        s.trainer_id = auth.uid()
        OR EXISTS (
          SELECT 1 FROM session_participants sp
          WHERE sp.session_id = s.id
          AND sp.user_id = auth.uid()
        )
      )
    )
  );

-- Trainers can view state history for their sessions
CREATE POLICY "Trainers can view state history for their sessions"
  ON scenario_state_history
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM sessions s
      WHERE s.id = scenario_state_history.session_id
      AND s.trainer_id = auth.uid()
    )
  );

-- Add comment
COMMENT ON TABLE scenario_state_history IS 'Tracks state snapshots for scenario replay and AAR analysis';

