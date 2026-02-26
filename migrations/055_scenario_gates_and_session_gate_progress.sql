-- Base gates: scenario_gates, session_gate_progress, required_gate_id on scenario_injects
-- Required for anti-gaming plan (Migration D builds on this). Revert with 055_down.

-- scenario_gates: defines gates per scenario (condition, check time, punishment/success injects)
CREATE TABLE IF NOT EXISTS scenario_gates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scenario_id UUID NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
  gate_id TEXT NOT NULL,
  gate_order INT NOT NULL DEFAULT 1,
  check_at_minutes INT NOT NULL,
  condition JSONB NOT NULL DEFAULT '{}'::jsonb,
  if_not_met_inject_ids UUID[] DEFAULT '{}',
  if_met_inject_id UUID REFERENCES scenario_injects(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(scenario_id, gate_id)
);

CREATE INDEX IF NOT EXISTS idx_scenario_gates_scenario ON scenario_gates(scenario_id);

-- session_gate_progress: per-session gate status (pending | met | not_met)
CREATE TABLE IF NOT EXISTS session_gate_progress (
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  gate_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'met', 'not_met')),
  met_at TIMESTAMPTZ,
  satisfying_decision_id UUID REFERENCES decisions(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (session_id, gate_id)
);

CREATE INDEX IF NOT EXISTS idx_session_gate_progress_session ON session_gate_progress(session_id);
CREATE INDEX IF NOT EXISTS idx_session_gate_progress_status ON session_gate_progress(status);

-- scenario_injects: only publish when this gate is met (good branch)
ALTER TABLE scenario_injects
  ADD COLUMN IF NOT EXISTS required_gate_id UUID REFERENCES scenario_gates(id) ON DELETE SET NULL;

COMMENT ON COLUMN scenario_injects.required_gate_id IS 'Publish this inject at trigger_time only when this gate is met for the session.';
